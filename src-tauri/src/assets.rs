//! The `backlog-asset` URI scheme: files stored in Backlog, which need the API
//! key, served to the webview from the local cache or the API. The key never
//! reaches the webview.
//!
//! The viewer requests `backlog-asset://localhost/{path}` (on Windows
//! `http://backlog-asset.localhost/{path}`), where `{path}` is
//! `attachment/{documentId}/{attachmentId}` or `shared-file/{projectKey}/{fileId}`.

use backlog_api::{Client, FileContent};
use tauri::http::{Request, Response, StatusCode, header};
use tauri::{Manager, Runtime, UriSchemeContext, UriSchemeResponder};

use crate::state::AppState;

pub const SCHEME: &str = "backlog-asset";

/// A file the viewer may load. Built only by [`AssetRef::parse`], so its ids are valid.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AssetRef {
    /// A file attached to a document.
    Attachment {
        document_id: String,
        attachment_id: u64,
    },
    /// A file in a project's shared files.
    SharedFile { project_key: String, file_id: u64 },
}

impl AssetRef {
    /// Parses a request path such as `/attachment/{documentId}/{attachmentId}`.
    pub fn parse(path: &str) -> Option<Self> {
        let mut parts = path.strip_prefix('/')?.split('/');
        let (kind, owner, id) = (parts.next()?, parts.next()?, parts.next()?);
        if parts.next().is_some() {
            return None;
        }
        let id = parse_id(id)?;
        match kind {
            "attachment" if is_document_id(owner) => Some(Self::Attachment {
                document_id: owner.into(),
                attachment_id: id,
            }),
            "shared-file" if is_project_key(owner) => Some(Self::SharedFile {
                project_key: owner.into(),
                file_id: id,
            }),
            _ => None,
        }
    }

    /// The canonical path without its leading `/`; also the cache key.
    pub fn key(&self) -> String {
        match self {
            Self::Attachment {
                document_id,
                attachment_id,
            } => format!("attachment/{document_id}/{attachment_id}"),
            Self::SharedFile {
                project_key,
                file_id,
            } => format!("shared-file/{project_key}/{file_id}"),
        }
    }

    async fn fetch(&self, client: &Client) -> Result<FileContent, backlog_api::Error> {
        match self {
            Self::Attachment {
                document_id,
                attachment_id,
            } => {
                client
                    .document_attachment(document_id, *attachment_id)
                    .await
            }
            Self::SharedFile {
                project_key,
                file_id,
            } => client.shared_file(project_key, *file_id).await,
        }
    }
}

/// Digits only: `u64::from_str` also takes a leading `+`.
fn parse_id(s: &str) -> Option<u64> {
    if s.bytes().all(|b| b.is_ascii_digit()) {
        s.parse().ok()
    } else {
        None
    }
}

/// Such as `01a19b018a3c7423b551baec933aa7ad`.
fn is_document_id(s: &str) -> bool {
    is_word(s, |b| b.is_ascii_alphanumeric())
}

/// Such as `PRJ` or `PRJ_2`.
fn is_project_key(s: &str) -> bool {
    is_word(s, |b| {
        b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_'
    })
}

fn is_word(s: &str, allowed: impl Fn(u8) -> bool) -> bool {
    (1..=64).contains(&s.len()) && s.bytes().all(allowed)
}

/// Answers one webview request without blocking the webview on the network.
pub fn handle<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let app = ctx.app_handle().clone();
    let asset = AssetRef::parse(request.uri().path());
    tauri::async_runtime::spawn(async move {
        let result = match asset {
            Some(asset) => load(&app.state::<AppState>(), &asset).await,
            None => Err(StatusCode::BAD_REQUEST),
        };
        responder.respond(match result {
            Ok(file) => file_response(file),
            Err(status) => empty(status),
        });
    });
}

/// The cached copy when there is one, otherwise the file from the API, then cached.
/// An attachment's content never changes, so a cached copy is not revalidated.
async fn load(state: &AppState, asset: &AssetRef) -> Result<FileContent, StatusCode> {
    let key = asset.key();
    let internal = |_| StatusCode::INTERNAL_SERVER_ERROR;
    if let Some(file) = state.store.asset(&key).map_err(internal)? {
        return Ok(file);
    }
    let client = state.client().map_err(|_| StatusCode::BAD_GATEWAY)?;
    let file = asset.fetch(&client).await.map_err(|e| {
        e.status()
            .and_then(|s| StatusCode::from_u16(s).ok())
            .unwrap_or(StatusCode::BAD_GATEWAY)
    })?;
    state.store.put_asset(&key, &file).map_err(internal)?;
    Ok(file)
}

fn file_response(file: FileContent) -> Response<Vec<u8>> {
    Response::builder()
        .header(header::CONTENT_TYPE, file.content_type)
        .body(file.bytes)
        .unwrap_or_else(|_| empty(StatusCode::INTERNAL_SERVER_ERROR))
}

fn empty(status: StatusCode) -> Response<Vec<u8>> {
    let mut response = Response::new(Vec::new());
    *response.status_mut() = status;
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Store;

    #[test]
    fn parses_attachment_and_shared_file_paths() {
        assert_eq!(
            AssetRef::parse("/attachment/01a19b018a3c7423b551baec933aa7ad/217209"),
            Some(AssetRef::Attachment {
                document_id: "01a19b018a3c7423b551baec933aa7ad".into(),
                attachment_id: 217209,
            })
        );
        assert_eq!(
            AssetRef::parse("/shared-file/PRJ_2/56"),
            Some(AssetRef::SharedFile {
                project_key: "PRJ_2".into(),
                file_id: 56,
            })
        );
    }

    #[test]
    fn key_is_the_canonical_path() {
        for path in ["/attachment/abc123/1", "/shared-file/PRJ/56"] {
            assert_eq!(format!("/{}", AssetRef::parse(path).unwrap().key()), path);
        }
    }

    #[test]
    fn rejects_other_paths() {
        for path in [
            "",
            "/",
            "attachment/abc/1",
            "/attachment/abc",
            "/attachment/abc/1/",
            "/attachment/abc/1/2",
            "/attachment/abc/x1",
            "/attachment/abc/+1",
            "/attachment/abc/",
            "/attachment/abc/99999999999999999999",
            "/attachment//1",
            "/attachment/a.b/1",
            "/attachment/..%2Fusers/1",
            "/shared-file/prj/1",
            "/shared-file/PRJ-1/1",
            "/document/abc/1",
            &format!("/attachment/{}/1", "a".repeat(65)),
        ] {
            assert_eq!(AssetRef::parse(path), None, "path: {path}");
        }
    }

    fn png() -> FileContent {
        FileContent {
            content_type: "image/png".into(),
            bytes: vec![0x89, b'P', b'N', b'G'],
        }
    }

    /// No client is configured, so nothing can be fetched.
    fn offline_state() -> AppState {
        AppState::new(Store::open_in_memory().unwrap())
    }

    #[test]
    fn serves_a_cached_file_without_a_connection() {
        let asset = AssetRef::parse("/attachment/abc/1").unwrap();
        let state = offline_state();
        state.store.put_asset("attachment/abc/1", &png()).unwrap();
        let loaded = tauri::async_runtime::block_on(load(&state, &asset));
        assert_eq!(loaded, Ok(png()));
    }

    #[test]
    fn fails_when_not_cached_and_not_connected() {
        let asset = AssetRef::parse("/shared-file/PRJ/56").unwrap();
        let state = offline_state();
        state.store.put_asset("shared-file/PRJ/57", &png()).unwrap();
        let loaded = tauri::async_runtime::block_on(load(&state, &asset));
        assert_eq!(loaded, Err(StatusCode::BAD_GATEWAY));
    }
}
