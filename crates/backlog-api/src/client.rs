use std::future::Future;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use reqwest::{Method, StatusCode};
use serde::de::DeserializeOwned;

use crate::error::ApiErrorBody;
use crate::oauth::{self, OAuthApp, TokenSet};
use crate::{
    ContentUpdate, Document, DocumentSummary, DocumentTree, Error, Project, SpaceUrl, User,
};

const TIMEOUT: Duration = Duration::from_secs(15);
/// Files can be much larger than JSON responses.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(120);

/// The body of a file download, with the type the server reported.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileContent {
    /// `application/octet-stream` when the server sent no `Content-Type`.
    pub content_type: String,
    pub bytes: Vec<u8>,
}

/// How requests are authenticated.
#[derive(Clone)]
pub enum Auth {
    /// Sent as the `apiKey` query parameter.
    ApiKey(String),
    /// Sent as a Bearer token, refreshed before it expires.
    OAuth(Arc<OAuthSession>),
}

/// OAuth tokens shared by every clone of a [`Client`], so only one request refreshes them.
pub struct OAuthSession {
    app: OAuthApp,
    tokens: tokio::sync::Mutex<TokenSet>,
    /// Called with the new tokens after each refresh, to store them. Runs after the
    /// tokens are unlocked, so a slow store does not hold up other requests.
    on_refresh: Box<dyn Fn(&TokenSet) + Send + Sync>,
    /// Set when the app signs in again or switches credentials. A retired session
    /// still serves requests already under way, but no longer stores its tokens.
    retired: AtomicBool,
}

impl OAuthSession {
    pub fn new(
        app: OAuthApp,
        tokens: TokenSet,
        on_refresh: impl Fn(&TokenSet) + Send + Sync + 'static,
    ) -> Arc<Self> {
        Arc::new(Self {
            app,
            tokens: tokio::sync::Mutex::new(tokens),
            on_refresh: Box::new(on_refresh),
            retired: AtomicBool::new(false),
        })
    }

    /// Stops storing refreshed tokens: other credentials have replaced this session.
    pub fn retire(&self) {
        self.retired.store(true, Ordering::SeqCst);
    }

    /// A usable access token. Refreshes it when it is about to expire, or when the server
    /// rejected `rejected` and no other request has refreshed it since.
    async fn access_token(
        &self,
        http: &reqwest::Client,
        space_url: &SpaceUrl,
        rejected: Option<&str>,
    ) -> Result<String, Error> {
        self.fresh_token(rejected, oauth::now(), |refresh_token| async move {
            oauth::refresh(http, space_url, &self.app, &refresh_token).await
        })
        .await
    }

    /// [`Self::access_token`] with the clock and the token request passed in.
    async fn fresh_token<F, R>(
        &self,
        rejected: Option<&str>,
        now: u64,
        refresh: R,
    ) -> Result<String, Error>
    where
        R: FnOnce(String) -> F,
        F: Future<Output = Result<TokenSet, Error>>,
    {
        let mut tokens = self.tokens.lock().await;
        let stale = match rejected {
            Some(rejected) => tokens.access_token == rejected,
            None => tokens.needs_refresh(now),
        };
        if !stale {
            return Ok(tokens.access_token.clone());
        }
        *tokens = refresh(tokens.refresh_token.clone()).await?;
        let refreshed = tokens.clone();
        drop(tokens);
        if !self.retired.load(Ordering::SeqCst) {
            (self.on_refresh)(&refreshed);
        }
        Ok(refreshed.access_token)
    }
}

/// Backlog API client for one space.
#[derive(Clone)]
pub struct Client {
    http: reqwest::Client,
    space_url: SpaceUrl,
    auth: Auth,
}

pub(crate) fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(TIMEOUT)
        .user_agent(concat!(
            "backlog-document-desktop/",
            env!("CARGO_PKG_VERSION")
        ))
        .build()
        .expect("failed to build HTTP client")
}

impl Client {
    pub fn new(space_url: SpaceUrl, auth: Auth) -> Self {
        Self {
            http: http_client(),
            space_url,
            auth,
        }
    }

    /// Retires the client's OAuth session, if it has one (see [`OAuthSession::retire`]).
    pub fn retire(&self) {
        if let Auth::OAuth(session) = &self.auth {
            session.retire();
        }
    }

    pub fn space_url(&self) -> &SpaceUrl {
        &self.space_url
    }

    /// `GET /api/v2/users/myself` — used to verify the connection settings.
    pub async fn myself(&self) -> Result<User, Error> {
        self.get("/api/v2/users/myself", &[]).await
    }

    /// `GET /api/v2/projects` (joined, not archived).
    pub async fn projects(&self) -> Result<Vec<Project>, Error> {
        self.get("/api/v2/projects", &[("archived", "false")]).await
    }

    /// `GET /api/v2/documents/tree`
    pub async fn document_tree(&self, project_id_or_key: &str) -> Result<DocumentTree, Error> {
        self.get(
            "/api/v2/documents/tree",
            &[("projectIdOrKey", project_id_or_key)],
        )
        .await
    }

    /// `GET /api/v2/documents/:documentId`
    pub async fn document(&self, document_id: &str) -> Result<Document, Error> {
        let path = format!("/api/v2/documents/{document_id}");
        self.get(&path, &[]).await
    }

    /// `GET /api/v2/documents` — the `count` most recently updated documents of a project,
    /// newest first. Used to notice changes made on Backlog.
    pub async fn recent_documents(
        &self,
        project_id: i64,
        count: u8,
    ) -> Result<Vec<DocumentSummary>, Error> {
        let response = self
            .send(self.recent_documents_request(project_id, count))
            .await?;
        response.json().await.map_err(Error::Decode)
    }

    fn recent_documents_request(&self, project_id: i64, count: u8) -> reqwest::RequestBuilder {
        self.request(Method::GET, "/api/v2/documents").query(&[
            ("projectId[]", project_id.to_string()),
            ("sort", "updated".to_string()),
            ("order", "desc".to_string()),
            ("offset", "0".to_string()),
            ("count", count.clamp(1, 100).to_string()),
        ])
    }

    /// `PATCH /api/v2/documents/:documentId/content` — replaces the whole body with `content`
    /// (Markdown). Backlog normalizes it, so fetch the document again for the stored body.
    pub async fn update_document_content(
        &self,
        document_id: &str,
        content: &str,
    ) -> Result<ContentUpdate, Error> {
        let response = self
            .send(self.content_update_request(document_id, content))
            .await?;
        response.json().await.map_err(Error::Decode)
    }

    fn content_update_request(&self, document_id: &str, content: &str) -> reqwest::RequestBuilder {
        let path = format!("/api/v2/documents/{document_id}/content");
        self.request(Method::PATCH, &path)
            .form(&[("content", content)])
    }

    /// `POST /api/v2/documents` — creates an empty document titled `title`, as the last child
    /// of `parent_id`, or at the end of the top level when `parent_id` is `None`.
    pub async fn create_document(
        &self,
        project_id: i64,
        title: &str,
        parent_id: Option<&str>,
    ) -> Result<Document, Error> {
        let response = self
            .send(self.create_document_request(project_id, title, parent_id))
            .await?;
        response.json().await.map_err(Error::Decode)
    }

    fn create_document_request(
        &self,
        project_id: i64,
        title: &str,
        parent_id: Option<&str>,
    ) -> reqwest::RequestBuilder {
        let project_id = project_id.to_string();
        let mut form = vec![
            ("projectId", project_id.as_str()),
            ("title", title),
            ("addLast", "true"),
        ];
        if let Some(parent_id) = parent_id {
            form.push(("parentId", parent_id));
        }
        self.request(Method::POST, "/api/v2/documents").form(&form)
    }

    /// `GET /api/v2/documents/:documentId/attachments/:attachmentId` — the file itself.
    pub async fn document_attachment(
        &self,
        document_id: &str,
        attachment_id: u64,
    ) -> Result<FileContent, Error> {
        let path = format!("/api/v2/documents/{document_id}/attachments/{attachment_id}");
        self.download(&path).await
    }

    /// `GET /api/v2/projects/:projectIdOrKey/files/:sharedFileId` — the file itself.
    pub async fn shared_file(
        &self,
        project_id_or_key: &str,
        shared_file_id: u64,
    ) -> Result<FileContent, Error> {
        let path = format!("/api/v2/projects/{project_id_or_key}/files/{shared_file_id}");
        self.download(&path).await
    }

    async fn get<T: DeserializeOwned>(
        &self,
        path: &str,
        query: &[(&str, &str)],
    ) -> Result<T, Error> {
        let response = self
            .send(self.request(Method::GET, path).query(query))
            .await?;
        response.json::<T>().await.map_err(Error::Decode)
    }

    async fn download(&self, path: &str) -> Result<FileContent, Error> {
        let response = self
            .send(self.request(Method::GET, path).timeout(DOWNLOAD_TIMEOUT))
            .await?;
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("application/octet-stream")
            .to_string();
        let bytes = response.bytes().await.map_err(Error::Network)?.to_vec();
        Ok(FileContent {
            content_type,
            bytes,
        })
    }

    /// The request without credentials; [`Client::send`] adds them.
    fn request(&self, method: Method, path: &str) -> reqwest::RequestBuilder {
        self.http
            .request(method, format!("{}{}", self.space_url, path))
    }

    /// Adds the credentials and sends the request. With OAuth, a `401` refreshes the token
    /// and sends the request once more.
    async fn send(&self, request: reqwest::RequestBuilder) -> Result<reqwest::Response, Error> {
        let session = match &self.auth {
            Auth::ApiKey(key) => return check(request.query(&[("apiKey", key)])).await,
            Auth::OAuth(session) => session,
        };
        let retry = request.try_clone();
        let token = session
            .access_token(&self.http, &self.space_url, None)
            .await?;
        match (check(request.bearer_auth(&token)).await, retry) {
            (Err(e), Some(retry)) if e.is_unauthorized() => {
                let token = session
                    .access_token(&self.http, &self.space_url, Some(&token))
                    .await?;
                check(retry.bearer_auth(token)).await
            }
            (result, _) => result,
        }
    }
}

/// Sends the request and turns a non-success status into [`Error::Api`].
async fn check(request: reqwest::RequestBuilder) -> Result<reqwest::Response, Error> {
    let response = request.send().await.map_err(Error::Network)?;
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }
    let errors = match response.json::<ApiErrorBody>().await {
        Ok(body) => body.errors,
        Err(_) => Vec::new(),
    };
    Err(Error::Api {
        status: status.as_u16(),
        errors,
    })
}

impl Error {
    /// True for authentication failures (wrong or revoked API key).
    pub fn is_unauthorized(&self) -> bool {
        self.status() == Some(StatusCode::UNAUTHORIZED.as_u16())
    }
}

#[cfg(test)]
mod session_tests {
    use std::sync::Mutex;
    use std::sync::atomic::AtomicUsize;

    use super::*;

    const NOW: u64 = 1_000_000;

    fn tokens(access: &str, expires_at: u64) -> TokenSet {
        TokenSet {
            access_token: access.to_owned(),
            refresh_token: format!("refresh-for-{access}"),
            expires_at,
        }
    }

    /// A session whose stored tokens are recorded in `stored`.
    fn session(initial: TokenSet) -> (Arc<OAuthSession>, Arc<Mutex<Vec<String>>>) {
        let stored = Arc::new(Mutex::new(Vec::new()));
        let record = stored.clone();
        let app = OAuthApp {
            client_id: "id".to_owned(),
            client_secret: "secret".to_owned(),
            redirect_uri: "http://127.0.0.1:53682/callback".to_owned(),
        };
        let session = OAuthSession::new(app, initial, move |t| {
            record.lock().unwrap().push(t.access_token.clone());
        });
        (session, stored)
    }

    /// A token request that returns `access` and counts its calls.
    fn backlog_returns(
        access: &'static str,
        calls: &Arc<AtomicUsize>,
    ) -> impl FnOnce(String) -> std::future::Ready<Result<TokenSet, Error>> {
        let calls = calls.clone();
        move |refresh_token| {
            calls.fetch_add(1, Ordering::SeqCst);
            assert!(refresh_token.starts_with("refresh-for-"));
            std::future::ready(Ok(tokens(access, NOW + 3600)))
        }
    }

    fn run<T>(future: impl Future<Output = T>) -> T {
        tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap()
            .block_on(future)
    }

    #[test]
    fn uses_a_fresh_token_without_asking_backlog() {
        let (session, stored) = session(tokens("a1", NOW + 3600));
        let calls = Arc::new(AtomicUsize::new(0));
        let token = run(session.fresh_token(None, NOW, backlog_returns("a2", &calls)));
        assert_eq!(token.unwrap(), "a1");
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert!(stored.lock().unwrap().is_empty());
    }

    #[test]
    fn refreshes_before_expiry_and_stores_the_new_tokens() {
        let (session, stored) = session(tokens("a1", NOW + 30));
        let calls = Arc::new(AtomicUsize::new(0));
        let token = run(session.fresh_token(None, NOW, backlog_returns("a2", &calls)));
        assert_eq!(token.unwrap(), "a2");
        assert_eq!(*stored.lock().unwrap(), ["a2"]);

        // The new token is good for an hour: no second refresh.
        let token = run(session.fresh_token(None, NOW, backlog_returns("a3", &calls)));
        assert_eq!(token.unwrap(), "a2");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_rejected_token_is_refreshed_once() {
        let (session, _) = session(tokens("a1", NOW + 3600));
        let calls = Arc::new(AtomicUsize::new(0));
        // Two requests sent with a1 both got 401. The first refreshes; the second
        // finds a1 already replaced and uses a2.
        let first = run(session.fresh_token(Some("a1"), NOW, backlog_returns("a2", &calls)));
        let second = run(session.fresh_token(Some("a1"), NOW, backlog_returns("a3", &calls)));
        assert_eq!(first.unwrap(), "a2");
        assert_eq!(second.unwrap(), "a2");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn concurrent_requests_share_one_refresh() {
        let (session, stored) = session(tokens("a1", NOW));
        let calls = Arc::new(AtomicUsize::new(0));
        let tokens_seen = run(async {
            let mut tasks = Vec::new();
            for _ in 0..5 {
                let (session, calls) = (session.clone(), calls.clone());
                tasks.push(tokio::spawn(async move {
                    session
                        .fresh_token(None, NOW, |_| async move {
                            calls.fetch_add(1, Ordering::SeqCst);
                            // Let the other requests reach the lock meanwhile.
                            tokio::task::yield_now().await;
                            Ok(tokens("a2", NOW + 3600))
                        })
                        .await
                        .unwrap()
                }));
            }
            let mut seen = Vec::new();
            for task in tasks {
                seen.push(task.await.unwrap());
            }
            seen
        });
        assert_eq!(tokens_seen, ["a2"; 5]);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(*stored.lock().unwrap(), ["a2"]);
    }

    #[test]
    fn a_retired_session_keeps_working_but_stores_nothing() {
        let (session, stored) = session(tokens("a1", NOW));
        session.retire();
        let calls = Arc::new(AtomicUsize::new(0));
        let token = run(session.fresh_token(None, NOW, backlog_returns("a2", &calls)));
        assert_eq!(token.unwrap(), "a2");
        assert!(stored.lock().unwrap().is_empty());
    }

    #[test]
    fn a_failed_refresh_keeps_the_old_tokens() {
        let (session, stored) = session(tokens("a1", NOW));
        let failed = run(session.fresh_token(None, NOW, |_| async {
            Err(Error::Api {
                status: 401,
                errors: Vec::new(),
            })
        }));
        assert!(failed.unwrap_err().is_unauthorized());
        assert!(stored.lock().unwrap().is_empty());
        // The next request tries again with the same refresh token.
        let calls = Arc::new(AtomicUsize::new(0));
        let token = run(session.fresh_token(None, NOW, backlog_returns("a2", &calls)));
        assert_eq!(token.unwrap(), "a2");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn client() -> Client {
        Client::new(
            SpaceUrl::parse("example.backlog.com").unwrap(),
            Auth::ApiKey("test-key".to_string()),
        )
    }

    fn form_fields(request: &reqwest::Request) -> Vec<(String, String)> {
        let body = request.body().and_then(|b| b.as_bytes()).unwrap();
        url::form_urlencoded::parse(body).into_owned().collect()
    }

    fn pairs(fields: &[(&str, &str)]) -> Vec<(String, String)> {
        fields
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn recent_documents_asks_for_the_newest_first() {
        let client = client();
        let request = client.recent_documents_request(42, 5).build().unwrap();
        assert_eq!(request.method(), Method::GET);
        assert_eq!(request.url().path(), "/api/v2/documents");
        let query: Vec<(String, String)> = request
            .url()
            .query_pairs()
            .into_owned()
            .filter(|(k, _)| k != "apiKey")
            .collect();
        assert_eq!(
            query,
            pairs(&[
                ("projectId[]", "42"),
                ("sort", "updated"),
                ("order", "desc"),
                ("offset", "0"),
                ("count", "5"),
            ])
        );
    }

    #[test]
    fn create_document_adds_a_child_at_the_end() {
        let client = client();
        let request = client
            .create_document_request(42, "Notes & ideas", Some("parent1"))
            .build()
            .unwrap();
        assert_eq!(request.method(), Method::POST);
        assert_eq!(request.url().path(), "/api/v2/documents");
        assert_eq!(
            form_fields(&request),
            pairs(&[
                ("projectId", "42"),
                ("title", "Notes & ideas"),
                ("addLast", "true"),
                ("parentId", "parent1"),
            ])
        );
    }

    #[test]
    fn create_document_without_a_parent_goes_to_the_top_level() {
        let client = client();
        let request = client
            .create_document_request(42, "Top", None)
            .build()
            .unwrap();
        assert_eq!(
            form_fields(&request),
            pairs(&[("projectId", "42"), ("title", "Top"), ("addLast", "true")])
        );
    }

    #[test]
    fn content_update_sends_the_body_as_a_form_field() {
        let client = client();
        let request = client
            .content_update_request("abc", "# T\n\na & b=c")
            .build()
            .unwrap();
        assert_eq!(request.method(), Method::PATCH);
        assert_eq!(request.url().path(), "/api/v2/documents/abc/content");
        assert_eq!(
            request.headers()[reqwest::header::CONTENT_TYPE],
            "application/x-www-form-urlencoded"
        );
        let body = request.body().and_then(|b| b.as_bytes()).unwrap();
        let fields: Vec<(String, String)> =
            url::form_urlencoded::parse(body).into_owned().collect();
        assert_eq!(
            fields,
            [("content".to_string(), "# T\n\na & b=c".to_string())]
        );
    }
}
