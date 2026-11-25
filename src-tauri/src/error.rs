use serde::Serialize;
use ts_rs::TS;

/// Error returned to the frontend from Tauri commands.
#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CommandError {
    pub kind: ErrorKind,
    pub message: String,
}

#[derive(Debug, Clone, Copy, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ErrorKind {
    /// Space URL or credentials are not configured yet.
    NotConfigured,
    /// The input (e.g. space URL) is invalid.
    InvalidInput,
    /// The API key or OAuth tokens were rejected.
    Unauthorized,
    /// The server could not be reached and nothing is cached.
    Offline,
    /// Any other error response from the Backlog API.
    Api,
    /// The user stopped the operation (e.g. closed sign-in).
    Cancelled,
    /// Local failures (database, keychain, ...).
    Internal,
}

impl CommandError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    pub fn not_configured() -> Self {
        Self::new(ErrorKind::NotConfigured, "connection settings are missing")
    }

    pub fn not_stored() -> Self {
        Self::new(
            ErrorKind::InvalidInput,
            "the document is not stored locally",
        )
    }
}

impl From<backlog_api::Error> for CommandError {
    fn from(e: backlog_api::Error) -> Self {
        let kind = match &e {
            backlog_api::Error::InvalidSpaceUrl(_) => ErrorKind::InvalidInput,
            e if e.is_offline() => ErrorKind::Offline,
            e if e.is_unauthorized() => ErrorKind::Unauthorized,
            _ => ErrorKind::Api,
        };
        Self::new(kind, e.to_string())
    }
}

impl From<rusqlite::Error> for CommandError {
    fn from(e: rusqlite::Error) -> Self {
        Self::new(ErrorKind::Internal, format!("database error: {e}"))
    }
}

impl From<serde_json::Error> for CommandError {
    fn from(e: serde_json::Error) -> Self {
        Self::new(ErrorKind::Internal, format!("cache decode error: {e}"))
    }
}

impl From<keyring::Error> for CommandError {
    fn from(e: keyring::Error) -> Self {
        Self::new(ErrorKind::Internal, format!("keychain error: {e}"))
    }
}

impl From<crate::store::CacheError> for CommandError {
    fn from(e: crate::store::CacheError) -> Self {
        match e {
            crate::store::CacheError::Db(e) => e.into(),
            crate::store::CacheError::Json(e) => e.into(),
        }
    }
}
