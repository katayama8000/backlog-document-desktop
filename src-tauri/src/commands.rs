//! Tauri commands called from the frontend.

use std::future::Future;

use backlog_api::{Client, DocumentTree, Project, SpaceUrl, User};
use serde::Serialize;
use serde::de::DeserializeOwned;
use tauri::State;
use ts_rs::TS;

use crate::error::{CommandError, ErrorKind};
use crate::secrets;
use crate::state::AppState;
use crate::store::{PROJECT_KEY, SPACE_URL, StoredDocument};

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
    /// Normalized Pandoc Markdown returned by Backlog.
    pub plain: Option<String>,
    /// ISO 8601
    pub updated: Option<String>,
}

impl From<StoredDocument> for DocumentView {
    fn from(d: StoredDocument) -> Self {
        Self {
            id: d.id,
            project_id: d.project_id,
            title: d.title,
            plain: d.base_plain,
            updated: d.base_updated,
        }
    }
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
    match client.document(&document_id).await {
        Ok(doc) => {
            let stored = state.store.put_document(&doc)?;
            Ok(Fetched {
                fetched_at: stored.fetched_at.clone(),
                data: stored.into(),
                from_cache: false,
            })
        }
        Err(e) if e.is_offline() => match state.store.document(&document_id)? {
            Some(stored) => Ok(Fetched {
                fetched_at: stored.fetched_at.clone(),
                data: stored.into(),
                from_cache: true,
            }),
            None => Err(e.into()),
        },
        Err(e) => Err(e.into()),
    }
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
