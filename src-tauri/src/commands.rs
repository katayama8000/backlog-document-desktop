//! Tauri commands called from the frontend.

use std::future::Future;

use backlog_api::{Client, DocumentSummary, DocumentTree, Project, SpaceUrl, User};
use serde::Serialize;
use serde::de::DeserializeOwned;
use tauri::State;
use ts_rs::TS;

use crate::error::{CommandError, ErrorKind};
use crate::secrets;
use crate::state::AppState;
use crate::store::{PROJECT_KEY, SPACE_URL, Store, StoredDocument, Version, VersionReason};
use crate::sync::{self, MergeProposal, PublishOutcome, PullOutcome};

type CommandResult<T> = Result<T, CommandError>;

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Settings {
    pub space_url: Option<String>,
    pub has_api_key: bool,
    pub project_key: Option<String>,
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
    /// How many earlier bodies are kept (see `list_versions`).
    pub version_count: u32,
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
}

impl DocumentView {
    fn new(d: StoredDocument, version_count: u32) -> Self {
        let state = if d.local_plain.is_some() {
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
            version_count,
            state,
        }
    }
}

/// Builds the view of a stored document.
pub(crate) fn document_view(store: &Store, id: &str) -> CommandResult<DocumentView> {
    let doc = store.document(id)?.ok_or_else(CommandError::not_stored)?;
    Ok(DocumentView::new(doc, store.version_count(id)?))
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PublishResult {
    pub outcome: PublishOutcome,
    /// The document after publishing. Show its local edits, or its base when there are none.
    pub document: DocumentView,
    /// The places to decide, when the outcome is `needsMerge`.
    pub merge: Option<MergeProposal>,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PullResult {
    pub outcome: PullOutcome,
    /// The document afterwards. Show its local edits, or its base when there are none.
    pub document: DocumentView,
    /// The places to decide, when the outcome is `needsMerge`.
    pub merge: Option<MergeProposal>,
}

/// Loads saved settings and prepares the API client when possible.
#[tauri::command]
pub fn load_settings(state: State<'_, AppState>) -> CommandResult<Settings> {
    let space_url = state
        .store
        .setting(SPACE_URL)?
        .or_else(|| secrets::dev_credentials().map(|(url, _)| url.as_str().to_owned()));
    let project_key = state.store.setting(PROJECT_KEY)?;
    let mut has_api_key = false;
    if let Some(url) = space_url.as_deref().map(SpaceUrl::parse).transpose()?
        && let Some(key) = secrets::api_key(&url)?
    {
        state.set_client(Client::new(url, key));
        has_api_key = true;
    }
    Ok(Settings {
        space_url,
        has_api_key,
        project_key,
    })
}

/// Verifies the connection with `GET /users/myself`, then saves the settings.
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
    let client = Client::new(url.clone(), api_key);
    let user = client.myself().await?;

    if state.store.setting(SPACE_URL)?.as_deref() != Some(url.as_str()) {
        state.store.clear_space_data()?;
    }
    secrets::set_api_key(&url, api_key)?;
    state.store.set_setting(SPACE_URL, url.as_str())?;
    state.set_client(client);
    Ok(user)
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
        data: DocumentView::new(stored, state.store.version_count(&document_id)?),
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

/// The project's `count` most recently updated documents, newest first, straight from Backlog
/// (never cached). Polled to notice changes made on Backlog.
#[tauri::command]
pub async fn recent_documents(
    state: State<'_, AppState>,
    project_id: i64,
    count: u8,
) -> CommandResult<Vec<DocumentSummary>> {
    let client = state.client()?;
    Ok(client.recent_documents(project_id, count).await?)
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

/// Drops the local edits, keeping them as a version. Fetch the document again to show the
/// current body.
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
    let (outcome, merge) = sync::publish(&client, &state.store, &document_id).await?;
    Ok(PublishResult {
        outcome,
        document: document_view(&state.store, &document_id)?,
        merge,
    })
}

/// "Bring in Backlog's changes" (design §6.6).
#[tauri::command]
pub async fn pull_document(
    state: State<'_, AppState>,
    document_id: String,
) -> CommandResult<PullResult> {
    let client = state.client()?;
    let (outcome, merge) = sync::pull(&client, &state.store, &document_id).await?;
    Ok(PullResult {
        outcome,
        document: document_view(&state.store, &document_id)?,
        merge,
    })
}

/// Applies a merge the user decided: `markdown` becomes the local edits on top of Backlog's
/// body from the proposal. The edits it replaces are kept as a version.
#[tauri::command]
pub fn apply_merge(
    state: State<'_, AppState>,
    document_id: String,
    markdown: String,
    remote_plain: String,
    remote_updated: String,
) -> CommandResult<DocumentView> {
    if state.store.document(&document_id)?.is_none() {
        return Err(CommandError::not_stored());
    }
    state.store.rebase(
        &document_id,
        &remote_plain,
        &remote_updated,
        &markdown,
        VersionReason::BeforeMerge,
    )?;
    document_view(&state.store, &document_id)
}

/// Earlier bodies of a document, newest first.
#[tauri::command]
pub fn list_versions(
    state: State<'_, AppState>,
    document_id: String,
) -> CommandResult<Vec<Version>> {
    Ok(state.store.versions(&document_id)?)
}

/// Makes a kept version the local edits; the edits it replaces are kept as a version.
#[tauri::command]
pub fn restore_version(
    state: State<'_, AppState>,
    document_id: String,
    version_id: i64,
) -> CommandResult<DocumentView> {
    if !state.store.restore_version(&document_id, version_id)? {
        return Err(CommandError::new(
            ErrorKind::InvalidInput,
            "no such version",
        ));
    }
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
