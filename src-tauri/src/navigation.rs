//! Keeps the webview on the app's own pages. A navigation anywhere else, from a
//! link, the context menu's "Open Link" or a script, is cancelled, and an
//! http(s) or mailto URL opens in the default browser or mail app instead.

use tauri::plugin::{Builder, TauriPlugin};
use tauri::utils::config::Config;
use tauri::{Runtime, Url};
use tauri_plugin_opener::OpenerExt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NavigationAction {
    /// One of the app's own pages: the webview loads it.
    Allow,
    /// Cancelled, and opened in the default browser or mail app.
    OpenExternally,
    /// Cancelled.
    Block,
}

/// What a navigation to `url` does, given the origins the app's pages load from.
///
/// Anything else is blocked, `about:blank` and `data:` included: the hook
/// cannot tell a frame from the window, the app has no frames, and the window
/// on such a page has no way back to the app.
pub fn navigation_action(url: &Url, app_origins: &[Url]) -> NavigationAction {
    if app_origins.iter().any(|origin| same_origin(url, origin)) {
        NavigationAction::Allow
    } else if matches!(url.scheme(), "http" | "https" | "mailto") {
        NavigationAction::OpenExternally
    } else {
        NavigationAction::Block
    }
}

/// [`Url::origin`] is opaque, so never equal, for custom schemes such as `tauri:`.
fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme()
        && a.host() == b.host()
        && a.port_or_known_default() == b.port_or_known_default()
}

/// Tauri's protocol for the bundled frontend, and the dev server in development.
fn app_origins(config: &Config) -> Vec<Url> {
    // On Windows and Android custom protocols are served as http(s)://{scheme}.localhost.
    let bundled: &[&str] = if cfg!(any(windows, target_os = "android")) {
        &["http://tauri.localhost", "https://tauri.localhost"]
    } else {
        &["tauri://localhost"]
    };
    bundled
        .iter()
        .map(|origin| Url::parse(origin).expect("a valid URL"))
        .chain(config.build.dev_url.clone().filter(|_| tauri::is_dev()))
        .collect()
}

/// A plugin whose navigation hook applies [`navigation_action`] to every webview.
pub fn guard<R: Runtime>(config: &Config) -> TauriPlugin<R> {
    let app_origins = app_origins(config);
    Builder::new("navigation-guard")
        .on_navigation(move |webview, url| {
            let action = navigation_action(url, &app_origins);
            if action == NavigationAction::OpenExternally
                && let Err(e) = webview.opener().open_url(url.as_str(), None::<&str>)
            {
                eprintln!("failed to open {url}: {e}");
            }
            action == NavigationAction::Allow
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;
    use NavigationAction::*;

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    fn action(s: &str, origins: &[&str]) -> NavigationAction {
        let origins: Vec<Url> = origins.iter().map(|o| url(o)).collect();
        navigation_action(&url(s), &origins)
    }

    const DEV: &[&str] = &["tauri://localhost", "http://localhost:1420"];

    #[test]
    fn allows_the_dev_server() {
        for s in [
            "http://localhost:1420",
            "http://localhost:1420/",
            "http://localhost:1420/index.html?x=1#top",
        ] {
            assert_eq!(action(s, DEV), Allow, "{s}");
        }
    }

    #[test]
    fn allows_the_bundled_frontend() {
        assert_eq!(action("tauri://localhost/index.html", DEV), Allow);
        let windows = &["http://tauri.localhost", "https://tauri.localhost"];
        assert_eq!(action("http://tauri.localhost/index.html", windows), Allow);
        assert_eq!(action("https://tauri.localhost/", windows), Allow);
    }

    #[test]
    fn opens_web_and_mail_links_externally() {
        for s in [
            "https://example.com/a?b#c",
            "http://example.com/",
            "mailto:someone@example.com",
            // Same host as the dev server, another origin.
            "http://localhost:1421/",
            "https://localhost:1420/",
            "http://127.0.0.1:1420/",
        ] {
            assert_eq!(action(s, DEV), OpenExternally, "{s}");
        }
    }

    #[test]
    fn the_dev_server_is_external_without_it() {
        assert_eq!(
            action("http://localhost:1420/", &["tauri://localhost"]),
            OpenExternally
        );
    }

    #[test]
    fn blocks_everything_else() {
        for s in [
            // Files for <img>, never a page to show in place of the viewer.
            "backlog-asset://localhost/attachment/abc/1",
            "javascript:alert(1)",
            "file:///etc/passwd",
            "about:blank",
            "about:srcdoc",
            "data:text/html,<p>hi</p>",
            "blob:tauri://localhost/0b5b4f1e",
            "tel:+81000000000",
            "tauri://example.com/",
        ] {
            assert_eq!(action(s, DEV), Block, "{s}");
        }
    }

    #[test]
    fn the_configured_dev_server_is_an_app_origin_in_development() {
        let mut config = Config::default();
        config.build.dev_url = Some(url("http://localhost:1420"));
        let origins = app_origins(&config);
        assert_eq!(
            navigation_action(&url("http://localhost:1420/"), &origins),
            Allow
        );
        let bundled = if cfg!(windows) {
            "http://tauri.localhost/"
        } else {
            "tauri://localhost/"
        };
        assert_eq!(navigation_action(&url(bundled), &origins), Allow);
    }
}
