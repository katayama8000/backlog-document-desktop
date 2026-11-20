use serde::{Deserialize, Serialize};

/// One entry of Backlog's `{"errors": [...]}` error body.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiErrorItem {
    pub message: String,
    pub code: i64,
    #[serde(default)]
    pub more_info: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ApiErrorBody {
    pub errors: Vec<ApiErrorItem>,
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("invalid Backlog space URL: {0}")]
    InvalidSpaceUrl(String),

    /// The request could not reach the server (DNS, connection, timeout, ...).
    #[error("network error: {0}")]
    Network(#[source] reqwest::Error),

    /// The server answered with a non-success status.
    #[error("Backlog API error (HTTP {status}): {}", summary(.errors))]
    Api {
        status: u16,
        errors: Vec<ApiErrorItem>,
    },

    /// The response body could not be decoded.
    #[error("unexpected response: {0}")]
    Decode(#[source] reqwest::Error),
}

impl Error {
    /// True when the server could not be reached, so cached data should be used.
    pub fn is_offline(&self) -> bool {
        matches!(self, Error::Network(_))
    }

    /// True for `429 Too Many Requests`: the user's per-minute rate limit was reached.
    pub fn is_rate_limited(&self) -> bool {
        self.status() == Some(429)
    }

    pub fn status(&self) -> Option<u16> {
        match self {
            Error::Api { status, .. } => Some(*status),
            _ => None,
        }
    }
}

fn summary(errors: &[ApiErrorItem]) -> String {
    match errors.first() {
        Some(e) => e.message.clone(),
        None => "no error details".to_string(),
    }
}
