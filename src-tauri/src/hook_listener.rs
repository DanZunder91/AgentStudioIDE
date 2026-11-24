//! The ad-hoc-detection hook listener — a single localhost endpoint.
//!
//! A runtime's `SessionStart`/`SessionEnd` hook POSTs its payload here; we bind it
//! to the terminal the session runs in. **This is a security boundary:** any local
//! process can connect to a localhost port, so every request must present the
//! per-launch secret token or it is dropped. Without that, any program on the
//! machine could forge phantom agents into the rail.
//!
//! # Why hand-rolled instead of `hyper`/`axum`
//!
//! One POST shape, on `127.0.0.1`, from a hook we wrote. What matters is tight
//! control over the things that make a listener safe — a body-size cap, a read
//! timeout (so a stuck connection can't pin a task), and a constant-time token
//! compare. That is more auditable as ~120 lines of `tokio` than as a general HTTP
//! server wired through service traits, and it adds no new crate (just tokio's
//! `net` feature). The token check, not the parser, is the boundary; the parser is
//! deliberately minimal and refuses anything it doesn't recognise.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use rand::RngCore;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use crate::agent::hook::{HEADER_TERMINAL, HEADER_TOKEN};

/// The request line + headers. Ours are a `curl` POST with two custom headers, so
/// anything this big is not one of our hooks and is refused.
const MAX_HEAD: usize = 64 * 1024;

/// The body is the runtime's hook payload, and it is NOT small: `UserPromptSubmit`
/// carries the user's whole prompt. A pasted query result or log is routinely past
/// 64 KiB — a realistic prompt can be 100 KB or more; a 64 KiB cap answered
/// 400, the hook's `curl … || true` swallowed it, and the agent was drawn idle for
/// its entire turn. The token is checked on the headers BEFORE any body byte is
/// read, so this cap only bounds an authenticated peer; it sits above any prompt a
/// model can take (a 1M-token context is ~4 MB of text).
const MAX_BODY: usize = 16 * 1024 * 1024;

/// A whole request must arrive within this window. Bounds a slow/stuck peer to one
/// short-lived task rather than a permanent leak.
const READ_TIMEOUT: Duration = Duration::from_secs(5);
/// How long an agent-control request may take once read (`crate::agent_ctl`): a database
/// connection test is the slow case, and the engines cap their own timeouts below this.
const CTL_TIMEOUT: Duration = Duration::from_secs(120);

/// What an agent-control handler returns: the HTTP status and a JSON body.
pub type CtlFuture = Pin<Box<dyn Future<Output = (u16, Vec<u8>)> + Send>>;
/// The handler for `POST /ctl` (`crate::agent_ctl::CTL_PATH`), given the terminal id and body.
pub type CtlHandler = dyn Fn(String, Vec<u8>) -> CtlFuture + Send + Sync;

/// What the supervisor needs to inject into every PTY so a hook can phone home.
/// Per app instance (ephemeral port + fresh token), so two running apps never
/// cross-bind (FM-2).
#[derive(Debug, Clone)]
pub struct HookConfig {
    /// e.g. `http://127.0.0.1:54321`. Injected as `AGENTSTUDIO_HOOK_URL`.
    pub base_url: String,
    /// Per-launch secret. Injected as `AGENTSTUDIO_HOOK_TOKEN`; required on every POST.
    pub token: String,
}

/// A bound-but-not-yet-serving listener. Split from [`HookConfig`] so the port and
/// token exist *before* the supervisor spawns (it needs them for env injection),
/// while the accept loop starts only once there is something to deliver to.
pub struct HookListener {
    std_listener: std::net::TcpListener,
    token: String,
}

impl HookListener {
    /// Bind `127.0.0.1:0` and mint the token — both synchronously, so the caller
    /// has a concrete URL + token to inject into PTYs immediately.
    pub fn bind() -> std::io::Result<(HookListener, HookConfig)> {
        // std bind is synchronous and hands back the concrete port at once; we
        // convert to a tokio listener in `serve`.
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0))?;
        listener.set_nonblocking(true)?;
        let port = listener.local_addr()?.port();
        let token = generate_token();
        let config = HookConfig {
            base_url: format!("http://127.0.0.1:{port}"),
            token: token.clone(),
        };
        Ok((
            HookListener {
                std_listener: listener,
                token,
            },
            config,
        ))
    }

    /// Start accepting. `on_hook(terminal_id, body)` is invoked for every request
    /// that **passed the token check** — its argument is the raw payload, which the
    /// supervisor hands to an adapter to parse (keeping payload schema out of here).
    ///
    /// The callback is intentionally not the supervisor: the listener knows nothing
    /// about agents, which makes it trivially testable and reusable.
    pub fn serve<F>(self, on_hook: F)
    where
        F: Fn(String, Vec<u8>) + Send + Sync + 'static,
    {
        self.serve_with_ctl(on_hook, None);
    }

    /// [`Self::serve`], plus the agent-control route: a `POST` to
    /// [`crate::agent_ctl::CTL_PATH`] goes to `on_ctl`, which answers with a status and a body.
    /// Same token check, same caps; only the time allowed to *answer* is longer
    /// ([`CTL_TIMEOUT`]). Without a handler that route answers 404 and every other path is a
    /// hook, exactly as before.
    pub fn serve_with_ctl<F>(self, on_hook: F, on_ctl: Option<Arc<CtlHandler>>)
    where
        F: Fn(String, Vec<u8>) + Send + Sync + 'static,
    {
        let token = Arc::new(self.token);
        let on_hook = Arc::new(on_hook);
        tauri::async_runtime::spawn(async move {
            let listener = match tokio::net::TcpListener::from_std(self.std_listener) {
                Ok(l) => l,
                Err(e) => {
                    eprintln!("hook listener: failed to enter async mode: {e}");
                    return;
                }
            };
            loop {
                match listener.accept().await {
                    Ok((stream, _peer)) => {
                        let token = token.clone();
                        let on_hook = on_hook.clone();
                        let on_ctl = on_ctl.clone();
                        // One task per connection, each strictly time- and
                        // size-bounded, so a misbehaving peer can't wedge the loop.
                        tauri::async_runtime::spawn(async move {
                            handle_connection(stream, &token, on_hook.as_ref(), on_ctl).await;
                        });
                    }
                    // Transient accept errors (fd pressure, peer reset) must not
                    // kill the listener.
                    Err(_) => tokio::time::sleep(Duration::from_millis(10)).await,
                }
            }
        });
    }
}

/// A 256-bit random token, hex — CSPRNG (`rand`/`getrandom`), not time-derived, so
/// it is not guessable from launch time.
fn generate_token() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Constant-time byte equality. The length is allowed to leak (the token length is
/// fixed and public); the *contents* must not, so a forger can't tune a guess by
/// timing. Cheap, and the right habit for a token check.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Read the request within [`READ_TIMEOUT`], then route it: [`crate::agent_ctl::CTL_PATH`] to the
/// control handler (answered with its body, within [`CTL_TIMEOUT`]), anything else to the hook
/// callback.
async fn handle_connection<F>(
    mut stream: TcpStream,
    expected_token: &str,
    on_hook: &F,
    on_ctl: Option<Arc<CtlHandler>>,
) where
    F: Fn(String, Vec<u8>),
{
    let read = tokio::time::timeout(READ_TIMEOUT, read_request(&mut stream, expected_token)).await;
    let Ok(Some((head, terminal_id, body))) = read else {
        return;
    };
    if head.path != crate::agent_ctl::CTL_PATH {
        on_hook(terminal_id, body);
        let _ = respond(&mut stream, 204, "").await;
        return;
    }
    let Some(on_ctl) = on_ctl else {
        let _ = respond(&mut stream, 404, "no control handler").await;
        return;
    };
    match tokio::time::timeout(CTL_TIMEOUT, on_ctl(terminal_id, body)).await {
        Ok((status, reply)) => {
            let _ = respond_json(&mut stream, status, &reply).await;
        }
        Err(_) => {
            let _ = respond(&mut stream, 504, "timed out").await;
        }
    }
}

/// Read the head, check the token, read the body. `None` once a refusal has been answered.
async fn read_request(
    stream: &mut TcpStream,
    expected_token: &str,
) -> Option<(RequestHead, String, Vec<u8>)> {
    let Some(mut head) = read_head(stream).await else {
        // Malformed / oversized / truncated — refuse without a callback.
        let _ = respond(stream, 400, "bad request").await;
        return None;
    };

    // The security boundary, decided on the HEADERS: a peer without the token never
    // gets a single body byte read, so the body cap below only ever bounds our own
    // hooks. A missing or wrong token is indistinguishable from an attacker, so it is
    // dropped exactly like one.
    let token_ok = head
        .token
        .as_deref()
        .map(|t| constant_time_eq(t.as_bytes(), expected_token.as_bytes()))
        .unwrap_or(false);
    if !token_ok {
        let _ = respond(stream, 403, "forbidden").await;
        return None;
    }

    // A valid token but no terminal id is a malformed hook, not an attacker — still
    // nothing to bind, so drop it.
    let Some(terminal_id) = head.terminal_id.clone() else {
        let _ = respond(stream, 400, "missing terminal").await;
        return None;
    };

    if head.content_length > MAX_BODY {
        // One of OUR hooks that we cannot take. The hook's `curl … || true` throws
        // this answer away, so say it here: a refusal nobody sees is an agent whose
        // status silently never moves.
        eprintln!(
            "hook listener: refused a {}-byte hook payload (cap {MAX_BODY})",
            head.content_length
        );
        let _ = respond(stream, 400, "payload too large").await;
        return None;
    }
    let prefix = std::mem::take(&mut head.body_prefix);
    let Some(body) = read_body(stream, prefix, head.content_length).await else {
        let _ = respond(stream, 400, "bad request").await;
        return None;
    };
    Some((head, terminal_id, body))
}

/// The request line + headers we care about.
struct RequestHead {
    /// The request path (`/` for a hook, [`crate::agent_ctl::CTL_PATH`] for agent control).
    path: String,
    token: Option<String>,
    terminal_id: Option<String>,
    content_length: usize,
    /// Body bytes that arrived in the same reads as the headers.
    body_prefix: Vec<u8>,
}

/// Minimal HTTP/1.1 head reader: accumulate until the header terminator and parse
/// the headers we need. Reads no further than the reads that found the terminator.
/// Returns `None` on anything malformed or over [`MAX_HEAD`] — we never guess.
async fn read_head(stream: &mut TcpStream) -> Option<RequestHead> {
    let mut buf = Vec::with_capacity(4096);
    let header_end = loop {
        if let Some(pos) = find_subslice(&buf, b"\r\n\r\n") {
            break pos;
        }
        if buf.len() > MAX_HEAD {
            return None; // headers alone blew the cap
        }
        let mut chunk = [0u8; 4096];
        let n = stream.read(&mut chunk).await.ok()?;
        if n == 0 {
            return None; // peer closed before we had full headers
        }
        buf.extend_from_slice(&chunk[..n]);
    };

    let head = std::str::from_utf8(&buf[..header_end]).ok()?;
    let mut lines = head.split("\r\n");

    // Request line must be a POST. We serve exactly one verb.
    let request_line = lines.next()?;
    let path = request_line
        .strip_prefix("POST ")?
        .split(' ')
        .next()?
        .to_string();

    let (mut token, mut terminal_id, mut content_length) = (None, None, 0usize);
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim();
        // Header names are case-insensitive.
        if name.eq_ignore_ascii_case(HEADER_TOKEN) {
            token = Some(value.to_string());
        } else if name.eq_ignore_ascii_case(HEADER_TERMINAL) {
            terminal_id = Some(value.to_string());
        } else if name.eq_ignore_ascii_case("content-length") {
            content_length = value.parse().ok()?;
        }
    }

    Some(RequestHead {
        path,
        token,
        terminal_id,
        content_length,
        body_prefix: buf[header_end + 4..].to_vec(),
    })
}

/// The body: `prefix` (what trailed the headers) plus the rest, up to exactly
/// `content_length` bytes. The caller has already capped `content_length`.
async fn read_body(
    stream: &mut TcpStream,
    mut body: Vec<u8>,
    content_length: usize,
) -> Option<Vec<u8>> {
    let mut chunk = vec![0u8; 64 * 1024];
    while body.len() < content_length {
        let n = stream.read(&mut chunk).await.ok()?;
        if n == 0 {
            break; // peer closed early; deliver what we have
        }
        body.extend_from_slice(&chunk[..n]);
    }
    body.truncate(content_length);
    Some(body)
}

async fn respond(stream: &mut TcpStream, status: u16, reason: &str) -> std::io::Result<()> {
    let response =
        format!("HTTP/1.1 {status} {reason}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    stream.write_all(response.as_bytes()).await?;
    stream.flush().await
}

/// A JSON reply, for the control route.
async fn respond_json(stream: &mut TcpStream, status: u16, body: &[u8]) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        422 => "Unprocessable Entity",
        _ => "Error",
    };
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes()).await?;
    stream.write_all(body).await?;
    stream.flush().await
}

/// First index of `needle` in `haystack`.
fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_unique_and_long() {
        let a = generate_token();
        let b = generate_token();
        assert_ne!(a, b, "two launches must not mint the same token");
        assert_eq!(a.len(), 64, "256 bits => 64 hex chars");
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn constant_time_eq_matches_only_identical_bytes() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"ab"));
        assert!(!constant_time_eq(b"", b"x"));
        assert!(constant_time_eq(b"", b""));
    }

    #[test]
    fn find_subslice_finds_the_header_terminator() {
        assert_eq!(find_subslice(b"ab\r\n\r\ncd", b"\r\n\r\n"), Some(2));
        assert_eq!(find_subslice(b"no terminator", b"\r\n\r\n"), None);
        assert_eq!(find_subslice(b"", b"\r\n\r\n"), None);
    }
}
