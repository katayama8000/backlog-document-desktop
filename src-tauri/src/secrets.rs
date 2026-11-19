//! API keys live in the OS keychain, never in the SQLite cache.
//!
//! Debug builds can take the key from `BACKLOG_SPACE_URL` / `BACKLOG_API_KEY`
//! instead (the environment, or the repository's `.env`). macOS asks for the
//! login password whenever a rebuilt binary reads the keychain, which happens
//! on every `pnpm tauri dev` rebuild. Release builds always use the keychain.

use backlog_api::SpaceUrl;

const SERVICE: &str = "backlog-document-desktop";

fn entry(space_url: &SpaceUrl) -> keyring::Result<keyring::Entry> {
    keyring::Entry::new(SERVICE, space_url.as_str())
}

pub fn api_key(space_url: &SpaceUrl) -> keyring::Result<Option<String>> {
    if let Some((url, key)) = dev_credentials()
        && &url == space_url
    {
        return Ok(Some(key));
    }
    match entry(space_url)?.get_password() {
        Ok(key) => Ok(Some(key)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e),
    }
}

pub fn set_api_key(space_url: &SpaceUrl, api_key: &str) -> keyring::Result<()> {
    if dev_credentials().is_some_and(|(url, _)| &url == space_url) {
        return Ok(());
    }
    entry(space_url)?.set_password(api_key)
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
    use super::dotenv_value;

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
