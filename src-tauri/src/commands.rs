//! Tauri commands called from the frontend.

use std::future::Future;

use backlog_api::oauth::{self as backlog_oauth, Attempt, OAuthApp, TokenSet};
use backlog_api::{Auth, Client, DocumentTree, OAuthSession, Project, SpaceUrl, User};
use serde::Serialize;
use serde::de::DeserializeOwned;
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;
use ts_rs::TS;

use crate::error::{CommandError, ErrorKind};
use crate::oauth::{self, Callback};
use crate::secrets::{self, Credential};
use crate::state::AppState;
use crate::store::{ConflictCopy, PROJECT_KEY, SPACE_URL, Store, StoredDocument};
use crate::sync::{self, PublishOutcome};

type CommandResult<T> = Result<T, CommandError>;

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Settings {
    pub space_url: Option<String>,
    /// Credentials for the space are stored, so the app can connect without asking.
    pub signed_in: bool,
    pub project_key: Option<String>,
    /// This build can sign in with OAuth (it was built with an OAuth application).
    pub oauth_available: bool,
}

/// Data that is either fresh from the API or read from the local cache.
#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Fetched<T> {
    pub data: T,
    /// True when the server was unreachable and the cache was used.
    pub from_cache: bool,
    /// ISO 8601
    pub fetched_at: String,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DocumentView {
    pub id: String,
    pub project_id: i64,
    pub title: String,
    /// Normalized Pandoc Markdown returned by Backlog: the base that local edits start from.
    pub plain: Option<String>,
    /// ISO 8601
    pub updated: Option<String>,
    /// Local edits not yet published.
    pub local_plain: Option<String>,
    /// Backlog could not regenerate the Markdown after the last publish, so `plain` may be
    /// stale. Editing stays off until a fetch returns a different body.
    pub read_only: bool,
    /// Unresolved conflict copies, oldest first.
    pub conflicts: Vec<ConflictCopy>,
    pub state: SyncState,
}

/// Derived from the stored data, never stored itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum SyncState {
    /// No local edits and no unresolved conflict copy.
    Synced,
    /// Local edits not yet published.
    Edited,
    /// A conflict copy is unresolved. There may be local edits too.
    Conflict,
}

impl DocumentView {
    fn new(d: StoredDocument, conflicts: Vec<ConflictCopy>) -> Self {
        let state = if !conflicts.is_empty() {
            SyncState::Conflict
        } else if d.local_plain.is_some() {
            SyncState::Edited
        } else {
            SyncState::Synced
        };
        Self {
            id: d.id,
            project_id: d.project_id,
            title: d.title,
            plain: d.base_plain,
            updated: d.base_updated,
            local_plain: d.local_plain,
            read_only: d.read_only,
            conflicts,
            state,
        }
    }
}

/// Builds the view of a stored document.
pub(crate) fn document_view(store: &Store, id: &str) -> CommandResult<DocumentView> {
    let doc = store.document(id)?.ok_or_else(CommandError::not_stored)?;
    Ok(DocumentView::new(doc, store.conflict_copies(id)?))
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PublishResult {
    pub outcome: PublishOutcome,
    /// The document after publishing. Show its local edits, or its base when there are none.
    pub document: DocumentView,
}

/// Loads saved settings and prepares the API client when possible.
#[tauri::command]
pub fn load_settings(state: State<'_, AppState>) -> CommandResult<Settings> {
    let space_url = state
        .store
        .setting(SPACE_URL)?
        .or_else(|| secrets::dev_credentials().map(|(url, _)| url.as_str().to_owned()));
    let project_key = state.store.setting(PROJECT_KEY)?;
    let oauth_app = oauth::app();
    let mut signed_in = false;
    if let Some(url) = space_url.as_deref().map(SpaceUrl::parse).transpose()? {
        // Keep a client already signed in to this space: rebuilding it from the keychain
        // would start a second OAuth session next to the one requests are using.
        signed_in = state.client_for(&url).is_some();
        if !signed_in {
            let client = match secrets::credential(&url)? {
                Some(Credential::ApiKey(key)) => Some(Client::new(url, Auth::ApiKey(key))),
                // Tokens can only be refreshed by a build with the same OAuth application.
                Some(Credential::OAuth(tokens)) => {
                    oauth_app.clone().map(|app| oauth_client(url, app, tokens))
                }
                None => None,
            };
            if let Some(client) = client {
                state.set_client(client);
                signed_in = true;
            }
        }
    }
    Ok(Settings {
        space_url,
        signed_in,
        project_key,
        oauth_available: oauth_app.is_some(),
    })
}

/// Verifies the API key with `GET /users/myself`, then saves the settings.
#[tauri::command]
pub async fn connect(
    state: State<'_, AppState>,
    space_url: String,
    api_key: String,
) -> CommandResult<User> {
    let url = SpaceUrl::parse(&space_url)?;
    let api_key = api_key.trim();
    if api_key.is_empty() {
        return Err(CommandError::new(
            ErrorKind::InvalidInput,
            "enter an API key",
        ));
    }
    let client = Client::new(url.clone(), Auth::ApiKey(api_key.to_owned()));
    let user = client.myself().await?;
    save_sign_in(
        &state,
        &url,
        &Credential::ApiKey(api_key.to_owned()),
        client,
    )?;
    Ok(user)
}

/// Signs in with OAuth: opens Backlog's consent page in the browser, waits for the
/// redirect to the loopback address, and trades the code for tokens.
#[tauri::command]
pub async fn sign_in_with_oauth(
    app: AppHandle,
    state: State<'_, AppState>,
    space_url: String,
) -> CommandResult<User> {
    let url = SpaceUrl::parse(&space_url)?;
    let oauth_app = oauth::app().ok_or_else(|| {
        CommandError::new(
            ErrorKind::InvalidInput,
            "this build cannot sign in with Backlog; use an API key",
        )
    })?;
    let redirect = oauth::loopback(&oauth_app.redirect_uri)
        .map_err(|message| CommandError::new(ErrorKind::Internal, message))?;

    // Only one sign-in at a time: a new one replaces one still in progress.
    let id = state.start_sign_in();
    let listeners = oauth::bind(&redirect).await.map_err(|e| {
        CommandError::new(
            ErrorKind::Internal,
            format!(
                "cannot receive the sign-in on 127.0.0.1:{}: {e}",
                redirect.port
            ),
        )
    })?;
    let attempt = Attempt::new();
    let waiting = tokio::spawn(tokio::time::timeout(
        oauth::SIGN_IN_TIMEOUT,
        oauth::wait_for_code(listeners, redirect.path, attempt.state.clone()),
    ));
    state.wait_for_browser(id, waiting.abort_handle());

    let authorize_url = backlog_oauth::authorize_url(&url, &oauth_app, &attempt);
    if let Err(e) = app.opener().open_url(authorize_url, None::<&str>) {
        waiting.abort();
        return Err(CommandError::new(
            ErrorKind::Internal,
            format!("cannot open the browser: {e}"),
        ));
    }

    let code = match waiting.await {
        Ok(Ok(Ok(Callback::Code(code)))) => code,
        Ok(Ok(Ok(Callback::Denied(reason)))) => {
            return Err(CommandError::new(
                ErrorKind::Unauthorized,
                format!("Backlog did not give access ({reason})"),
            ));
        }
        Ok(Ok(Err(e))) => {
            return Err(CommandError::new(
                ErrorKind::Internal,
                format!("sign-in failed: {e}"),
            ));
        }
        Ok(Err(_elapsed)) => {
            return Err(CommandError::new(
                ErrorKind::Cancelled,
                "sign-in timed out; try again",
            ));
        }
        Err(e) if e.is_cancelled() => return Err(cancelled()),
        Err(e) => {
            return Err(CommandError::new(
                ErrorKind::Internal,
                format!("sign-in stopped unexpectedly: {e}"),
            ));
        }
    };

    let tokens = backlog_oauth::exchange_code(&url, &oauth_app, &code, &attempt).await?;
    let client = oauth_client(url.clone(), oauth_app, tokens.clone());
    let user = client.myself().await?;
    if !state.finish_sign_in(id) {
        client.retire();
        return Err(cancelled());
    }
    save_sign_in(&state, &url, &Credential::OAuth(tokens), client)?;
    Ok(user)
}

fn cancelled() -> CommandError {
    CommandError::new(ErrorKind::Cancelled, "sign-in cancelled")
}

/// Cancels the OAuth sign-in in progress; `sign_in_with_oauth` then fails as cancelled.
#[tauri::command]
pub fn cancel_sign_in(state: State<'_, AppState>) {
    state.cancel_sign_in();
}

/// A client that stores refreshed tokens in the keychain.
fn oauth_client(url: SpaceUrl, app: OAuthApp, tokens: TokenSet) -> Client {
    let space = url.clone();
    let session = OAuthSession::new(app, tokens, move |tokens| {
        let (space, credential) = (space.clone(), Credential::OAuth(tokens.clone()));
        // The keychain blocks, and may show a password prompt.
        tauri::async_runtime::spawn_blocking(move || {
            if let Err(e) = secrets::set_credential(&space, &credential) {
                // The tokens still work until the app quits; the next launch asks to sign in.
                eprintln!("could not store refreshed OAuth tokens: {e}");
            }
        });
    });
    Client::new(url, Auth::OAuth(session))
}

/// Saves a verified sign-in. Switching to another space clears the cache.
fn save_sign_in(
    state: &AppState,
    url: &SpaceUrl,
    credential: &Credential,
    client: Client,
) -> CommandResult<()> {
    if state.store.setting(SPACE_URL)?.as_deref() != Some(url.as_str()) {
        state.store.clear_space_data()?;
    }
    secrets::set_credential(url, credential)?;
    state.store.set_setting(SPACE_URL, url.as_str())?;
    state.set_client(client);
    Ok(())
}

#[tauri::command]
pub async fn list_projects(state: State<'_, AppState>) -> CommandResult<Fetched<Vec<Project>>> {
    let client = state.client()?;
    fetch_or_cache(&state, "projects", client.projects()).await
}

#[tauri::command]
pub fn select_project(state: State<'_, AppState>, project_key: String) -> CommandResult<()> {
    state.store.set_setting(PROJECT_KEY, &project_key)?;
    Ok(())
}

#[tauri::command]
pub async fn get_tree(
    state: State<'_, AppState>,
    project_key: String,
) -> CommandResult<Fetched<DocumentTree>> {
    let client = state.client()?;
    let key = format!("tree:{project_key}");
    fetch_or_cache(&state, &key, client.document_tree(&project_key)).await
}

#[tauri::command]
pub async fn get_document(
    state: State<'_, AppState>,
    document_id: String,
) -> CommandResult<Fetched<DocumentView>> {
    let client = state.client()?;
    let (stored, from_cache) = match client.document(&document_id).await {
        Ok(doc) => (state.store.put_document(&doc)?, false),
        Err(e) if e.is_offline() => match state.store.document(&document_id)? {
            Some(stored) => (stored, true),
            None => return Err(e.into()),
        },
        Err(e) => return Err(e.into()),
    };
    Ok(Fetched {
        fetched_at: stored.fetched_at.clone(),
        data: DocumentView::new(stored, state.store.conflict_copies(&document_id)?),
        from_cache,
    })
}

/// Creates an empty document on Backlog and stores it, so it opens like any fetched one.
/// Needs Backlog: there are no offline drafts (design §2).
#[tauri::command]
pub async fn create_document(
    state: State<'_, AppState>,
    project_id: i64,
    title: String,
    parent_id: Option<String>,
) -> CommandResult<DocumentView> {
    let title = title.trim();
    if title.is_empty() {
        return Err(CommandError::new(ErrorKind::InvalidInput, "enter a title"));
    }
    let client = state.client()?;
    let doc = client
        .create_document(project_id, title, parent_id.as_deref())
        .await?;
    state.store.put_document(&doc)?;
    document_view(&state.store, &doc.id)
}

/// Keeps the editor's Markdown as the document's local edits.
#[tauri::command]
pub fn save_local(
    state: State<'_, AppState>,
    document_id: String,
    markdown: String,
) -> CommandResult<DocumentView> {
    if !state.store.save_local(&document_id, &markdown)? {
        return Err(CommandError::not_stored());
    }
    document_view(&state.store, &document_id)
}

/// Drops the local edits. Fetch the document again to show the current body.
#[tauri::command]
pub fn discard_local(state: State<'_, AppState>, document_id: String) -> CommandResult<()> {
    state.store.discard_local(&document_id)?;
    Ok(())
}

/// "Publish to Backlog" (design §6.3).
#[tauri::command]
pub async fn publish_document(
    state: State<'_, AppState>,
    document_id: String,
) -> CommandResult<PublishResult> {
    let client = state.client()?;
    let outcome = sync::publish(&client, &state.store, &document_id).await?;
    Ok(PublishResult {
        outcome,
        document: document_view(&state.store, &document_id)?,
    })
}

/// Marks a conflict copy as dealt with.
#[tauri::command]
pub fn resolve_conflict(
    state: State<'_, AppState>,
    document_id: String,
    copy_id: i64,
) -> CommandResult<DocumentView> {
    state.store.resolve_conflict(&document_id, copy_id)?;
    document_view(&state.store, &document_id)
}

/// Fetches from the API and caches the result; falls back to the cache when offline.
async fn fetch_or_cache<T, F>(state: &AppState, key: &str, request: F) -> CommandResult<Fetched<T>>
where
    T: Serialize + DeserializeOwned,
    F: Future<Output = Result<T, backlog_api::Error>>,
{
    match request.await {
        Ok(data) => {
            let fetched_at = state.store.put_cache(key, &data)?;
            Ok(Fetched {
                data,
                from_cache: false,
                fetched_at,
            })
        }
        Err(e) if e.is_offline() => match state.store.cache::<T>(key)? {
            Some((data, fetched_at)) => Ok(Fetched {
                data,
                from_cache: true,
                fetched_at,
            }),
            None => Err(e.into()),
        },
        Err(e) => Err(e.into()),
    }
}
