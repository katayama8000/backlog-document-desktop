//! OAuth 2.0 authorization code flow (with PKCE) against a Backlog space.
//!
//! The app opens [`authorize_url`] in the browser, receives `code` on its redirect URI,
//! and trades it for tokens with [`exchange_code`]. Access tokens expire after an hour;
//! [`Client`](crate::Client) refreshes them with [`refresh`] before they run out.

use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::ApiErrorBody;
use crate::{ApiErrorItem, Error, SpaceUrl};

/// Refresh this many seconds before the access token expires, so a request
/// started just before expiry does not fail.
const REFRESH_MARGIN_SECS: u64 = 60;

/// The OAuth application registered in Backlog Developer settings.
#[derive(Debug, Clone)]
pub struct OAuthApp {
    pub client_id: String,
    pub client_secret: String,
    /// Must match the redirect URI registered for the application exactly.
    pub redirect_uri: String,
}

/// Tokens for one space. Stored in the keychain as JSON.
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TokenSet {
    pub access_token: String,
    pub refresh_token: String,
    /// Unix time, seconds.
    pub expires_at: u64,
}

impl std::fmt::Debug for TokenSet {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TokenSet")
            .field("expires_at", &self.expires_at)
            .finish_non_exhaustive()
    }
}

impl TokenSet {
    /// True when the access token is expired or about to expire at `now` (Unix seconds).
    pub fn needs_refresh(&self, now: u64) -> bool {
        now + REFRESH_MARGIN_SECS >= self.expires_at
    }
}

/// A PKCE verifier and the `state` value for one sign-in attempt.
pub struct Attempt {
    pub state: String,
    pub code_verifier: String,
}

impl Attempt {
    pub fn new() -> Self {
        Self {
            state: random_token(),
            code_verifier: random_token(),
        }
    }

    fn code_challenge(&self) -> String {
        URL_SAFE_NO_PAD.encode(Sha256::digest(self.code_verifier.as_bytes()))
    }
}

impl Default for Attempt {
    fn default() -> Self {
        Self::new()
    }
}

/// 32 random bytes, base64url: 43 characters, valid as a PKCE verifier.
fn random_token() -> String {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("the OS random number generator failed");
    URL_SAFE_NO_PAD.encode(bytes)
}

/// The page where the user allows the application to access the space.
pub fn authorize_url(space_url: &SpaceUrl, app: &OAuthApp, attempt: &Attempt) -> String {
    let mut url = url::Url::parse(&format!("{space_url}/OAuth2AccessRequest.action"))
        .expect("space URLs are valid URLs");
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", &app.client_id)
        .append_pair("redirect_uri", &app.redirect_uri)
        .append_pair("state", &attempt.state)
        .append_pair("code_challenge", &attempt.code_challenge())
        .append_pair("code_challenge_method", "S256");
    url.into()
}

/// Trades the `code` from the redirect for tokens.
pub async fn exchange_code(
    space_url: &SpaceUrl,
    app: &OAuthApp,
    code: &str,
    attempt: &Attempt,
) -> Result<TokenSet, Error> {
    let form = [
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", app.redirect_uri.as_str()),
        ("client_id", app.client_id.as_str()),
        ("client_secret", app.client_secret.as_str()),
        ("code_verifier", attempt.code_verifier.as_str()),
    ];
    request_tokens(&crate::client::http_client(), space_url, &form, None).await
}

/// Gets a new access token. Keeps `refresh_token` unless Backlog returns a new one.
pub(crate) async fn refresh(
    http: &reqwest::Client,
    space_url: &SpaceUrl,
    app: &OAuthApp,
    refresh_token: &str,
) -> Result<TokenSet, Error> {
    let form = [
        ("grant_type", "refresh_token"),
        ("client_id", app.client_id.as_str()),
        ("client_secret", app.client_secret.as_str()),
        ("refresh_token", refresh_token),
    ];
    request_tokens(http, space_url, &form, Some(refresh_token)).await
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: u64,
}

/// An error from the token endpoint, in the OAuth format.
#[derive(Deserialize)]
struct OAuthErrorBody {
    error: String,
    error_description: Option<String>,
}

async fn request_tokens(
    http: &reqwest::Client,
    space_url: &SpaceUrl,
    form: &[(&str, &str)],
    previous_refresh_token: Option<&str>,
) -> Result<TokenSet, Error> {
    let response = http
        .post(token_url(space_url))
        .form(form)
        .send()
        .await
        .map_err(Error::Network)?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(token_error(status.as_u16(), &body));
    }
    let body: TokenResponse = response.json().await.map_err(Error::Decode)?;
    let refresh_token = body
        .refresh_token
        .or_else(|| previous_refresh_token.map(str::to_owned))
        .ok_or_else(|| api_error(502, "Backlog returned no refresh token".to_owned()))?;
    Ok(TokenSet {
        access_token: body.access_token,
        refresh_token,
        expires_at: now() + body.expires_in,
    })
}

/// A rejected grant or client becomes `401`, so the app asks the user to sign in again.
/// Anything else (a wrong redirect URI, a rate limit, a server error) keeps its status.
fn token_error(status: u16, body: &str) -> Error {
    if let Ok(oauth) = serde_json::from_str::<OAuthErrorBody>(body) {
        let rejected = matches!(
            oauth.error.as_str(),
            "invalid_grant" | "invalid_client" | "unauthorized_client"
        );
        let status = if rejected && status < 500 {
            401
        } else {
            status
        };
        let message = match oauth.error_description.filter(|d| !d.is_empty()) {
            Some(description) => format!("sign-in failed: {} ({description})", oauth.error),
            None => format!("sign-in failed: {}", oauth.error),
        };
        return api_error(status, message);
    }
    match serde_json::from_str::<ApiErrorBody>(body) {
        Ok(body) => Error::Api {
            status,
            errors: body.errors,
        },
        Err(_) => api_error(status, "sign-in failed".to_owned()),
    }
}

fn api_error(status: u16, message: String) -> Error {
    Error::Api {
        status,
        errors: vec![ApiErrorItem {
            message,
            code: 0,
            more_info: String::new(),
        }],
    }
}

fn token_url(space_url: &SpaceUrl) -> String {
    format!("{space_url}/api/v2/oauth2/token")
}

pub(crate) fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app() -> OAuthApp {
        OAuthApp {
            client_id: "client id".to_string(),
            client_secret: "secret".to_string(),
            redirect_uri: "http://127.0.0.1:53682/callback".to_string(),
        }
    }

    #[test]
    fn authorize_url_carries_the_attempt() {
        let space = SpaceUrl::parse("example.backlog.com").unwrap();
        let attempt = Attempt {
            state: "s".to_string(),
            // Challenge checked with: printf %s <verifier> | openssl dgst -sha256 -binary | base64url
            code_verifier: "dBjftJeZ4CVP-mJ0mOGhh9y9HiwKXzkT6VjGXrbNGJk".to_string(),
        };
        let url = url::Url::parse(&authorize_url(&space, &app(), &attempt)).unwrap();
        assert_eq!(url.host_str(), Some("example.backlog.com"));
        assert_eq!(url.path(), "/OAuth2AccessRequest.action");
        let query: Vec<(String, String)> = url.query_pairs().into_owned().collect();
        let expected = [
            ("response_type", "code"),
            ("client_id", "client id"),
            ("redirect_uri", "http://127.0.0.1:53682/callback"),
            ("state", "s"),
            (
                "code_challenge",
                "ySnTdW6I7tdI5V9QjJTCA9L3UTVOUsrBZ_llKTtfF9k",
            ),
            ("code_challenge_method", "S256"),
        ]
        .map(|(k, v)| (k.to_string(), v.to_string()));
        assert_eq!(query, expected);
    }

    #[test]
    fn attempts_are_random_and_url_safe() {
        let a = Attempt::new();
        let b = Attempt::new();
        assert_ne!(a.state, b.state);
        assert_eq!(a.code_verifier.len(), 43);
        assert!(
            a.code_verifier
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        );
    }

    #[test]
    fn refreshes_shortly_before_expiry() {
        let tokens = TokenSet {
            access_token: "a".to_string(),
            refresh_token: "r".to_string(),
            expires_at: 1_000,
        };
        assert!(!tokens.needs_refresh(900));
        assert!(tokens.needs_refresh(940));
        assert!(tokens.needs_refresh(2_000));
    }

    #[test]
    fn rejected_grants_ask_to_sign_in_again() {
        let e = token_error(
            400,
            r#"{"error":"invalid_grant","error_description":"expired"}"#,
        );
        assert!(e.is_unauthorized());
        assert_eq!(
            e.to_string(),
            "Backlog API error (HTTP 401): sign-in failed: invalid_grant (expired)"
        );
    }

    #[test]
    fn other_token_errors_keep_their_status_and_reason() {
        let e = token_error(
            400,
            r#"{"error":"invalid_request","error_description":"redirect_uri mismatch"}"#,
        );
        assert_eq!(e.status(), Some(400));
        assert!(e.to_string().contains("redirect_uri mismatch"));
        assert_eq!(
            token_error(
                429,
                r#"{"errors":[{"message":"Too Many Requests","code":0}]}"#
            )
            .status(),
            Some(429)
        );
        assert_eq!(token_error(503, "<html>").status(), Some(503));
    }

    #[test]
    fn debug_output_hides_the_tokens() {
        let tokens = TokenSet {
            access_token: "secret-access".to_string(),
            refresh_token: "secret-refresh".to_string(),
            expires_at: 1,
        };
        let printed = format!("{tokens:?}");
        assert!(!printed.contains("secret"));
    }
}
