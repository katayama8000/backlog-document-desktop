//! The browser half of OAuth sign-in: the app's OAuth settings, and a one-shot HTTP
//! listener on the loopback redirect URI that receives the authorization code.

use std::io;
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;

use backlog_api::oauth::OAuthApp;
use tauri::Url;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio::task::JoinSet;

const DEFAULT_REDIRECT_URI: &str = "http://127.0.0.1:53682/callback";

/// How long to wait for the user to finish in the browser.
pub const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(300);

/// The OAuth application this build was made with (see `build.rs`), if any.
pub fn app() -> Option<OAuthApp> {
    Some(OAuthApp {
        client_id: option_env!("BACKLOG_OAUTH_CLIENT_ID")?.to_owned(),
        client_secret: option_env!("BACKLOG_OAUTH_CLIENT_SECRET")?.to_owned(),
        redirect_uri: option_env!("BACKLOG_OAUTH_REDIRECT_URI")
            .unwrap_or(DEFAULT_REDIRECT_URI)
            .to_owned(),
    })
}

/// Where the browser comes back to.
#[derive(Debug, PartialEq, Eq)]
pub struct Redirect {
    pub port: u16,
    pub path: String,
    /// `localhost` may resolve to `::1`, so listen there too.
    pub localhost: bool,
}

/// Only `http://127.0.0.1:<port>/...` and `http://localhost:<port>/...` can be received
/// by the app.
pub fn loopback(redirect_uri: &str) -> Result<Redirect, String> {
    let invalid = || format!("the redirect URI {redirect_uri} is not http://127.0.0.1:<port>/...");
    let url = Url::parse(redirect_uri).map_err(|_| invalid())?;
    let localhost = match url.host_str() {
        Some("127.0.0.1") => false,
        Some("localhost") => true,
        _ => return Err(invalid()),
    };
    if url.scheme() != "http" {
        return Err(invalid());
    }
    let port = url.port().ok_or_else(invalid)?;
    Ok(Redirect {
        port,
        path: url.path().to_owned(),
        localhost,
    })
}

/// Listens on `127.0.0.1`, and on `::1` too for `localhost` when the system has IPv6.
pub async fn bind(redirect: &Redirect) -> io::Result<Vec<TcpListener>> {
    let mut listeners = vec![bind_retrying((Ipv4Addr::LOCALHOST, redirect.port).into()).await?];
    if redirect.localhost
        && let Ok(v6) = bind_retrying((Ipv6Addr::LOCALHOST, redirect.port).into()).await
    {
        listeners.push(v6);
    }
    Ok(listeners)
}

/// A sign-in that was just cancelled may still hold the port for a moment, so retry briefly.
async fn bind_retrying(address: SocketAddr) -> io::Result<TcpListener> {
    let mut attempts = 0;
    loop {
        match TcpListener::bind(address).await {
            Err(e) if e.kind() == io::ErrorKind::AddrInUse && attempts < 10 => {
                attempts += 1;
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            result => return result,
        }
    }
}

/// What the browser brought back.
#[derive(Debug, PartialEq, Eq)]
pub enum Callback {
    Code(String),
    /// The user declined, or Backlog reported an error.
    Denied(String),
}

/// Answers requests until one arrives on `path` with the expected `state`. Each
/// connection is served on its own, so a browser's idle spare connection does not hold
/// up the redirect. Dropping the future stops the listeners.
pub async fn wait_for_code(
    listeners: Vec<TcpListener>,
    path: String,
    state: String,
) -> io::Result<Callback> {
    let (found, mut first) = mpsc::channel::<io::Result<Callback>>(1);
    let mut accepting = JoinSet::new();
    for listener in listeners {
        let (found, path, state) = (found.clone(), path.clone(), state.clone());
        accepting.spawn(async move {
            loop {
                let stream = match listener.accept().await {
                    Ok((stream, _)) => stream,
                    Err(e) => {
                        let _ = found.send(Err(e)).await;
                        return;
                    }
                };
                let (found, path, state) = (found.clone(), path.clone(), state.clone());
                tokio::spawn(async move {
                    if let Some(callback) = serve(stream, &path, &state).await {
                        let _ = found.send(Ok(callback)).await;
                    }
                });
            }
        });
    }
    drop(found);
    first
        .recv()
        .await
        .unwrap_or_else(|| Err(io::Error::other("stopped listening")))
}

/// Answers one connection; returns the callback when it is the redirect.
async fn serve(mut stream: TcpStream, path: &str, state: &str) -> Option<Callback> {
    let target = read_request_target(&mut stream).await?;
    match parse_callback(&target, path, state) {
        Some(callback) => {
            let page = match &callback {
                Callback::Code(_) => PAGE_SIGNED_IN,
                Callback::Denied(_) => PAGE_NOT_SIGNED_IN,
            };
            respond(&mut stream, "200 OK", page).await;
            Some(callback)
        }
        None => {
            respond(&mut stream, "404 Not Found", PAGE_NOT_FOUND).await;
            None
        }
    }
}

/// The request target (`/callback?code=...`) from the request line. Reads the whole
/// head first: closing with unread bytes can reset the connection before the page shows.
async fn read_request_target(stream: &mut TcpStream) -> Option<String> {
    let mut buffer = vec![0u8; 8192];
    let mut read = 0;
    while !buffer[..read].windows(4).any(|w| w == b"\r\n\r\n") && read < buffer.len() {
        let n = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut buffer[read..]))
            .await
            .ok()?
            .ok()?;
        if n == 0 {
            return None;
        }
        read += n;
    }
    let head = String::from_utf8_lossy(&buffer[..read]);
    let mut parts = head.lines().next()?.split(' ');
    match (parts.next(), parts.next()) {
        (Some("GET"), Some(target)) => Some(target.to_owned()),
        _ => None,
    }
}

/// `None` for requests that are not the redirect (wrong path or `state`): keep waiting.
pub fn parse_callback(target: &str, path: &str, state: &str) -> Option<Callback> {
    let url = Url::parse("http://127.0.0.1").ok()?.join(target).ok()?;
    if url.path() != path {
        return None;
    }
    let param = |name: &str| {
        url.query_pairs()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.into_owned())
    };
    if param("state").as_deref() != Some(state) {
        return None;
    }
    if let Some(code) = param("code").filter(|code| !code.is_empty()) {
        return Some(Callback::Code(code));
    }
    let error = param("error").unwrap_or_else(|| "no authorization code".to_owned());
    Some(Callback::Denied(error))
}

async fn respond(stream: &mut TcpStream, status: &str, body: &str) {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    // The browser may already be gone; the result does not change the sign-in.
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
}

const PAGE_SIGNED_IN: &str = "<!doctype html><meta charset=utf-8><title>Signed in</title>\
<p style=\"font:16px system-ui;margin:3em\">Signed in to Backlog Document Desktop. You can close this tab.</p>";
const PAGE_NOT_SIGNED_IN: &str = "<!doctype html><meta charset=utf-8><title>Not signed in</title>\
<p style=\"font:16px system-ui;margin:3em\">Backlog Document Desktop was not given access. You can close this tab.</p>";
const PAGE_NOT_FOUND: &str = "<!doctype html><meta charset=utf-8><title>Not found</title>";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_loopback_redirect_uris_only() {
        assert_eq!(
            loopback("http://127.0.0.1:53682/callback"),
            Ok(Redirect {
                port: 53682,
                path: "/callback".to_owned(),
                localhost: false,
            })
        );
        assert_eq!(
            loopback("http://localhost:8080/oauth/done"),
            Ok(Redirect {
                port: 8080,
                path: "/oauth/done".to_owned(),
                localhost: true,
            })
        );
        assert!(loopback("https://127.0.0.1:53682/callback").is_err());
        assert!(loopback("http://example.com:53682/callback").is_err());
        assert!(loopback("http://127.0.0.1/callback").is_err());
        assert!(loopback("backlog-document-desktop://callback").is_err());
    }

    #[test]
    fn takes_the_code_from_the_redirect() {
        assert_eq!(
            parse_callback("/callback?code=abc&state=s1", "/callback", "s1"),
            Some(Callback::Code("abc".to_owned()))
        );
    }

    #[test]
    fn reports_a_declined_request() {
        assert_eq!(
            parse_callback("/callback?error=access_denied&state=s1", "/callback", "s1"),
            Some(Callback::Denied("access_denied".to_owned()))
        );
    }

    #[test]
    fn ignores_other_requests() {
        // A different page, e.g. the browser asking for a favicon.
        assert_eq!(parse_callback("/favicon.ico", "/callback", "s1"), None);
        // A redirect for another attempt, or a forged one.
        assert_eq!(
            parse_callback("/callback?code=abc&state=other", "/callback", "s1"),
            None
        );
        assert_eq!(
            parse_callback("/callback?code=abc", "/callback", "s1"),
            None
        );
    }

    #[test]
    fn answers_the_browser_and_returns_the_code() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(answers_the_browser());
    }

    async fn answers_the_browser() {
        let redirect = Redirect {
            port: 0,
            path: "/callback".to_owned(),
            localhost: false,
        };
        let listeners = bind(&redirect).await.unwrap();
        let port = listeners[0].local_addr().unwrap().port();
        let waiting = tokio::spawn(wait_for_code(
            listeners,
            "/callback".to_owned(),
            "s1".to_owned(),
        ));

        // A browser's spare connection that never sends a request.
        let _idle = TcpStream::connect(("127.0.0.1", port)).await.unwrap();

        let get = |target: &'static str| async move {
            let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
            // The head arrives in two parts.
            let line = format!("GET {target} HTTP/1.1\r\n");
            stream.write_all(line.as_bytes()).await.unwrap();
            tokio::time::sleep(Duration::from_millis(20)).await;
            stream.write_all(b"Host: 127.0.0.1\r\n\r\n").await.unwrap();
            let mut response = String::new();
            stream.read_to_string(&mut response).await.unwrap();
            response
        };
        assert!(get("/favicon.ico").await.starts_with("HTTP/1.1 404"));
        let page = tokio::time::timeout(Duration::from_secs(2), get("/callback?code=xyz&state=s1"))
            .await
            .expect("the idle connection must not hold up the redirect");
        assert!(page.starts_with("HTTP/1.1 200"));
        assert!(page.contains("Signed in"));
        assert_eq!(
            waiting.await.unwrap().unwrap(),
            Callback::Code("xyz".to_owned())
        );
    }
}
