use std::time::Duration;

use reqwest::{Method, StatusCode};
use serde::de::DeserializeOwned;

use crate::error::ApiErrorBody;
use crate::{ContentUpdate, Document, DocumentTree, Error, Project, SpaceUrl, User};

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

/// Backlog API client authenticated with an API key.
#[derive(Clone)]
pub struct Client {
    http: reqwest::Client,
    space_url: SpaceUrl,
    api_key: String,
}

impl Client {
    pub fn new(space_url: SpaceUrl, api_key: impl Into<String>) -> Self {
        let http = reqwest::Client::builder()
            .timeout(TIMEOUT)
            .user_agent(concat!(
                "backlog-document-desktop/",
                env!("CARGO_PKG_VERSION")
            ))
            .build()
            .expect("failed to build HTTP client");
        Self {
            http,
            space_url,
            api_key: api_key.into(),
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

    /// `PATCH /api/v2/documents/:documentId/content` — replaces the whole body with `content`
    /// (Markdown). Backlog normalizes it, so fetch the document again for the stored body.
    pub async fn update_document_content(
        &self,
        document_id: &str,
        content: &str,
    ) -> Result<ContentUpdate, Error> {
        let response = send(self.content_update_request(document_id, content)).await?;
        response.json().await.map_err(Error::Decode)
    }

    fn content_update_request(&self, document_id: &str, content: &str) -> reqwest::RequestBuilder {
        let path = format!("/api/v2/documents/{document_id}/content");
        self.request(Method::PATCH, &path)
            .form(&[("content", content)])
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
        let response = send(self.request(Method::GET, path).query(query)).await?;
        response.json::<T>().await.map_err(Error::Decode)
    }

    async fn download(&self, path: &str) -> Result<FileContent, Error> {
        let response = send(self.request(Method::GET, path).timeout(DOWNLOAD_TIMEOUT)).await?;
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

    fn request(&self, method: Method, path: &str) -> reqwest::RequestBuilder {
        self.http
            .request(method, format!("{}{}", self.space_url, path))
            .query(&[("apiKey", self.api_key.as_str())])
    }
}

/// Sends the request and turns a non-success status into [`Error::Api`].
async fn send(request: reqwest::RequestBuilder) -> Result<reqwest::Response, Error> {
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
mod tests {
    use super::*;

    #[test]
    fn content_update_sends_the_body_as_a_form_field() {
        let client = Client::new(SpaceUrl::parse("example.backlog.com").unwrap(), "test-key");
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
