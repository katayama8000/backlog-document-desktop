/// OAuth application settings baked into the binary. Taken from the environment,
/// or from the repository's `.env`. A build without the client ID and secret
/// offers API-key sign-in only.
const OAUTH_VARS: [&str; 3] = [
    "BACKLOG_OAUTH_CLIENT_ID",
    "BACKLOG_OAUTH_CLIENT_SECRET",
    "BACKLOG_OAUTH_REDIRECT_URI",
];

fn main() {
    let dotenv = concat!(env!("CARGO_MANIFEST_DIR"), "/../.env");
    // Cargo reruns the script on every build for a missing file, so watch `.env`
    // only when it exists. After creating it, `touch src-tauri/build.rs`.
    if std::path::Path::new(dotenv).exists() {
        println!("cargo:rerun-if-changed={dotenv}");
    }
    let file = std::fs::read_to_string(dotenv).unwrap_or_default();
    for name in OAUTH_VARS {
        println!("cargo:rerun-if-env-changed={name}");
        let value = std::env::var(name)
            .ok()
            .or_else(|| dotenv_value(&file, name))
            .map(|v| v.trim().to_owned())
            .filter(|v| !v.is_empty());
        if let Some(value) = value {
            println!("cargo:rustc-env={name}={value}");
        }
    }
    tauri_build::build()
}

/// `NAME=value` from `.env` text (same rules as `secrets::dotenv_value`).
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
