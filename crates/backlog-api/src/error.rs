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

    /// True when Backlog does not know the endpoint at all ("Undefined resource"), as opposed
    /// to an endpoint that exists but did not find the requested item ("No such document").
    pub fn is_undefined_resource(&self) -> bool {
        matches!(self, Error::Api { status: 404, errors }
            if errors.iter().any(|e| e.message.starts_with("Undefined resource")))
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

#[cfg(test)]
mod tests {
    use super::*;

    fn api(status: u16, message: &str) -> Error {
        Error::Api {
            status,
            errors: vec![ApiErrorItem {
                message: message.into(),
                code: 6,
                more_info: String::new(),
            }],
        }
    }

    #[test]
    fn undefined_resource_is_told_apart_from_a_missing_item() {
        assert!(
            api(404, "Undefined resource. /api/v2/documents/x/content").is_undefined_resource()
        );
        assert!(!api(404, "No such document. (documentId:x)").is_undefined_resource());
        assert!(!api(400, "Undefined resource.").is_undefined_resource());
    }
}
