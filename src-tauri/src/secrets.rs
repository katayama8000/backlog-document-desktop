//! Credentials live in the OS keychain, never in the SQLite cache: one item per
//! space, holding either an API key or OAuth tokens (as JSON). One item means one
//! keychain read at startup, and signing in one way replaces the other.
//!
//! Debug builds can take an API key from `BACKLOG_SPACE_URL` / `BACKLOG_API_KEY`
//! instead (the environment, or the repository's `.env`). macOS asks for the
//! login password whenever a rebuilt binary reads the keychain, which happens
//! on every `pnpm tauri dev` rebuild. Release builds always use the keychain.

use backlog_api::SpaceUrl;
use backlog_api::oauth::TokenSet;

const SERVICE: &str = "backlog-document-desktop";

pub enum Credential {
    ApiKey(String),
    OAuth(TokenSet),
}

fn entry(space_url: &SpaceUrl) -> keyring::Result<keyring::Entry> {
    keyring::Entry::new(SERVICE, space_url.as_str())
}

pub fn credential(space_url: &SpaceUrl) -> keyring::Result<Option<Credential>> {
    if let Some((url, key)) = dev_credentials()
        && &url == space_url
    {
        return Ok(Some(Credential::ApiKey(key)));
    }
    match entry(space_url)?.get_password() {
        Ok(secret) => Ok(Some(decode(secret))),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e),
    }
}

pub fn set_credential(space_url: &SpaceUrl, credential: &Credential) -> keyring::Result<()> {
    if dev_credentials().is_some_and(|(url, _)| &url == space_url) {
        return Ok(());
    }
    entry(space_url)?.set_password(&encode(credential))
}

/// API keys are stored as they are (as before OAuth), so a JSON object is OAuth tokens.
fn decode(secret: String) -> Credential {
    match serde_json::from_str::<TokenSet>(&secret) {
        Ok(tokens) => Credential::OAuth(tokens),
        Err(_) => Credential::ApiKey(secret),
    }
}

fn encode(credential: &Credential) -> String {
    match credential {
        Credential::ApiKey(key) => key.clone(),
        Credential::OAuth(tokens) => {
            serde_json::to_string(tokens).expect("tokens serialize to JSON")
        }
    }
}

/// The space and key from `BACKLOG_SPACE_URL` / `BACKLOG_API_KEY`, when both are set.
#[cfg(debug_assertions)]
pub fn dev_credentials() -> Option<(SpaceUrl, String)> {
    let file = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../.env"))
        .unwrap_or_default();
    let var = |name: &str| {
        std::env::var(name)
            .ok()
            .or_else(|| dotenv_value(&file, name))
            .map(|v| v.trim().to_owned())
            .filter(|v| !v.is_empty())
    };
    let url = SpaceUrl::parse(&var("BACKLOG_SPACE_URL")?).ok()?;
    Some((url, var("BACKLOG_API_KEY")?))
}

#[cfg(not(debug_assertions))]
pub fn dev_credentials() -> Option<(SpaceUrl, String)> {
    None
}

/// Reads `NAME=value` from `.env` text. Accepts `export`, quotes and `#` comment lines.
#[cfg(debug_assertions)]
fn dotenv_value(file: &str, name: &str) -> Option<String> {
    file.lines()
        .map(str::trim)
        .filter(|line| !line.starts_with('#'))
        .map(|line| line.strip_prefix("export ").unwrap_or(line))
        .filter_map(|line| line.split_once('='))
        .find(|(key, _)| key.trim() == name)
        .map(|(_, value)| {
            let value = value.trim();
            value
                .strip_prefix('"')
                .and_then(|v| v.strip_suffix('"'))
                .or_else(|| value.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')))
                .unwrap_or(value)
                .to_owned()
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_api_keys_and_tokens_apart() {
        let key = encode(&Credential::ApiKey("abcDEF123".to_owned()));
        assert_eq!(key, "abcDEF123");
        assert!(matches!(decode(key), Credential::ApiKey(k) if k == "abcDEF123"));

        let tokens = TokenSet {
            access_token: "a".to_owned(),
            refresh_token: "r".to_owned(),
            expires_at: 42,
        };
        let stored = encode(&Credential::OAuth(tokens.clone()));
        assert!(matches!(decode(stored), Credential::OAuth(t) if t == tokens));
    }

    #[test]
    fn reads_dotenv_values() {
        let file = "# comment\nBACKLOG_SPACE_URL=https://example.backlog.com\nexport BACKLOG_API_KEY=\"abc=def\"\nOTHER='x'\n";
        assert_eq!(
            dotenv_value(file, "BACKLOG_SPACE_URL").as_deref(),
            Some("https://example.backlog.com")
        );
        assert_eq!(
            dotenv_value(file, "BACKLOG_API_KEY").as_deref(),
            Some("abc=def")
        );
        assert_eq!(dotenv_value(file, "OTHER").as_deref(), Some("x"));
        assert_eq!(dotenv_value(file, "MISSING"), None);
        assert_eq!(dotenv_value("#BACKLOG_API_KEY=x", "BACKLOG_API_KEY"), None);
    }
}
