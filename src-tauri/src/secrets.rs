//! API keys live in the OS keychain, never in the SQLite cache.

use backlog_api::SpaceUrl;

const SERVICE: &str = "backlog-document-desktop";

fn entry(space_url: &SpaceUrl) -> keyring::Result<keyring::Entry> {
    keyring::Entry::new(SERVICE, space_url.as_str())
}

pub fn api_key(space_url: &SpaceUrl) -> keyring::Result<Option<String>> {
    match entry(space_url)?.get_password() {
        Ok(key) => Ok(Some(key)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e),
    }
}

pub fn set_api_key(space_url: &SpaceUrl, api_key: &str) -> keyring::Result<()> {
    entry(space_url)?.set_password(api_key)
}
