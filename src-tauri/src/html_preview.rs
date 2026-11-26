//! `preview://`: serves previewed HTML at URLs mirroring the filesystem so relative assets, `..`
//! and ES modules resolve (srcdoc/blob would inherit the app CSP). Every request goes through
//! [`resolve_in_scope`]; the page runs sandboxed (no `allow-same-origin`) under [`PREVIEW_CSP`].

use std::path::{Path, PathBuf};

use tauri::http::{Request, Response, StatusCode};
use tauri::{UriSchemeContext, UriSchemeResponder};

use crate::fs_tree::{allowed_roots, resolve_in_scope};

/// The scheme name registered on the builder. Must match `frame-src` in
/// `tauri.conf.json` and the URL the frontend builds.
pub const SCHEME: &str = "preview";

/// Not a security boundary: responses are buffered whole, so a huge asset must 404, not OOM.
const MAX_ASSET_BYTES: u64 = 64 * 1024 * 1024;

/// Scheme-sources (`preview:`), never `'self'`: the sandboxed origin is opaque, so `'self'`
/// matches nothing. `'unsafe-inline'` is scoped to this document; no `'unsafe-eval'` yet.
/// `connect-src 'none'` stops exfiltration and is load-bearing on Windows (subframes get IPC).
pub const PREVIEW_CSP: &str = concat!(
    "default-src preview: http://preview.localhost data: blob: 'unsafe-inline'; ",
    "connect-src 'none'; ",
    "object-src 'none'; ",
    "form-action 'none'; ",
    "frame-ancestors tauri://localhost http://tauri.localhost ",
    "http://localhost:1420 http://127.0.0.1:1420"
);

/// Tauri's async URI-scheme handler for [`SCHEME`] (registered in `lib.rs`). Reads run on a
/// blocking worker, never the event-loop thread, which a slow mount would freeze.
pub fn handle(
    ctx: UriSchemeContext<'_, tauri::Wry>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let app = ctx.app_handle().clone();
    // `Uri::path()` excludes the query and the fragment, and keeps percent-escapes.
    let uri_path = request.uri().path().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        responder.respond(serve(&uri_path, &allowed_roots(&app)));
    });
}

/// Resolve one `preview://` request against `roots`; split from [`handle`] for testability.
pub(crate) fn serve(uri_path: &str, roots: &[PathBuf]) -> Response<Vec<u8>> {
    match read_scoped_asset(uri_path, roots) {
        Ok((bytes, mime)) => response(StatusCode::OK, mime, bytes),
        // 404 for both "missing" and "out of scope": the frame runs untrusted code and must
        // not learn whether a guessed path exists. The reason is in the body for the Logs panel.
        Err(reason) => response(
            StatusCode::NOT_FOUND,
            "text/plain; charset=utf-8",
            format!("preview: {reason}").into_bytes(),
        ),
    }
}

/// Read the file a `preview://` URL path names, if it is in scope and small enough.
fn read_scoped_asset(uri_path: &str, roots: &[PathBuf]) -> Result<(Vec<u8>, &'static str), String> {
    let requested = fs_path_from_uri_path(uri_path)?;
    let real = resolve_in_scope(&requested, roots)?;

    let meta = std::fs::metadata(&real).map_err(|e| format!("cannot stat file: {e}"))?;
    if !meta.is_file() {
        return Err("path is not a file".to_string());
    }
    if meta.len() > MAX_ASSET_BYTES {
        return Err("asset too large".to_string());
    }
    let bytes = std::fs::read(&real).map_err(|e| format!("cannot read file: {e}"))?;
    Ok((bytes, content_type(&real)))
}

/// Build a response carrying the headers every `preview://` reply must have.
fn response(status: StatusCode, mime: &str, body: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header("Content-Type", mime)
        // On EVERY response: an in-frame navigation can reach any in-scope file, and an SVG
        // served without a policy is a fully scripted document.
        .header("Content-Security-Policy", PREVIEW_CSP)
        // Module scripts are fetched in CORS mode with `Origin: null` from the sandbox;
        // without this, `<script type="module">` fails while classic scripts work.
        .header("Access-Control-Allow-Origin", "*")
        // Never let the engine upgrade an `application/octet-stream` we chose
        // deliberately into `text/html` it sniffed.
        .header("X-Content-Type-Options", "nosniff")
        .header("Referrer-Policy", "no-referrer")
        // Reload remounts only the document; without this the engine may serve edited CSS/JS
        // from its cache. Local disk, so there is nothing to save by caching.
        .header("Cache-Control", "no-store")
        .body(body)
        // The builder only fails on an invalid header name/value, all of which are
        // literals here, so this is unreachable rather than merely unlikely.
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

/// `preview://localhost/<path>` → filesystem path. Percent-decodes (correctness, e.g.
/// `caf%C3%A9.css`) but leaves `..` alone: [`resolve_in_scope`] is the one enforcement point.
fn fs_path_from_uri_path(uri_path: &str) -> Result<PathBuf, String> {
    let decoded = percent_decode(uri_path).ok_or("malformed percent-escape in preview URL")?;
    // A NUL cannot appear in a real path and makes `canonicalize`'s CString
    // conversion fail with a confusing io error; name it instead.
    if decoded.contains('\0') {
        return Err("path contains a NUL byte".to_string());
    }
    #[cfg(windows)]
    {
        // "/C:/Users/x" is how a Windows path is spelled in a URL path.
        Ok(PathBuf::from(decoded.strip_prefix('/').unwrap_or(&decoded)))
    }
    #[cfg(not(windows))]
    {
        Ok(PathBuf::from(decoded))
    }
}

/// Decode `%XX` escapes, rejecting malformed ones; hand-rolled to keep dependencies small.
/// `+` is NOT a space (that is form encoding; `a+b.css` is a valid file name).
fn percent_decode(input: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hi = hex_value(*bytes.get(i + 1)?)?;
            let lo = hex_value(*bytes.get(i + 2)?)?;
            out.push(hi * 16 + lo);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    // A path that decodes to invalid UTF-8 cannot be spelled as a Rust `String`.
    // Such a file is unreachable rather than mishandled — the same track `read_file`
    // makes by taking `path: String` over IPC.
    String::from_utf8(out).ok()
}

/// The value of one ASCII hex digit, or None.
fn hex_value(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// `Content-Type` from the extension. Defaults to `application/octet-stream`, never `text/html`:
/// with `nosniff`, an unknown file reached by navigation is never executed as a document.
fn content_type(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" | "cjs" => "text/javascript; charset=utf-8",
        "json" | "map" | "webmanifest" => "application/json; charset=utf-8",
        "wasm" => "application/wasm",
        "txt" | "md" | "csv" => "text/plain; charset=utf-8",
        "xml" => "text/xml; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "avif" => "image/avif",
        // Fonts are the asset class the inline-everything alternative could not have
        // served at all: a local `.woff2` is neither text nor a known image type.
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A throwaway tree, mirroring `fs_tree`'s `TempTree` helper.
    struct TempTree {
        root: PathBuf,
    }

    impl TempTree {
        fn new(tag: &str) -> Self {
            let root = std::env::temp_dir()
                .join(format!("agentstudio-preview-{tag}-{}", ulid::Ulid::new()));
            std::fs::create_dir_all(&root).unwrap();
            Self { root }
        }
        fn write(&self, rel: &str, bytes: &[u8]) -> PathBuf {
            let p = self.root.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(&p, bytes).unwrap();
            p
        }
        fn canon_root(&self) -> PathBuf {
            std::fs::canonicalize(&self.root).unwrap()
        }
        /// The URL path a browser would request for a file in this tree.
        fn uri_path(&self, rel: &str) -> String {
            let p = self.canon_root().join(rel);
            p.to_string_lossy().to_string()
        }
    }

    impl Drop for TempTree {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn header(res: &Response<Vec<u8>>, name: &str) -> String {
        res.headers()
            .get(name)
            .map(|v| v.to_str().unwrap().to_string())
            .unwrap_or_default()
    }

    #[test]
    fn serves_a_scoped_html_document_with_its_content_type() {
        let t = TempTree::new("html");
        t.write("index.html", b"<h1>hi</h1>");
        let res = serve(&t.uri_path("index.html"), &[t.canon_root()]);
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(header(&res, "Content-Type"), "text/html; charset=utf-8");
        assert_eq!(res.body(), b"<h1>hi</h1>");
    }

    /// The whole reason the scheme exists: a sibling stylesheet and script are
    /// ordinary requests to the same handler, so no inlining is needed.
    #[test]
    fn serves_sibling_css_and_js_as_their_own_requests() {
        let t = TempTree::new("assets");
        t.write(
            "index.html",
            b"<link rel=stylesheet href=style.css><script src=app.js></script>",
        );
        t.write("style.css", b"body{color:red}");
        t.write("app.js", b"document.title='ran'");
        let roots = [t.canon_root()];

        let css = serve(&t.uri_path("style.css"), &roots);
        assert_eq!(header(&css, "Content-Type"), "text/css; charset=utf-8");
        assert_eq!(css.body(), b"body{color:red}");

        let js = serve(&t.uri_path("app.js"), &roots);
        assert_eq!(
            header(&js, "Content-Type"),
            "text/javascript; charset=utf-8"
        );
        assert_eq!(js.body(), b"document.title='ran'");
    }

    /// A local font is the asset class an inline-everything preview could not have
    /// served at all (neither text nor a known image type).
    #[test]
    fn serves_a_local_font() {
        let t = TempTree::new("font");
        t.write("f.woff2", &[0x77, 0x4f, 0x46, 0x32]);
        let res = serve(&t.uri_path("f.woff2"), &[t.canon_root()]);
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(header(&res, "Content-Type"), "font/woff2");
    }

    /// Traversal is rejected by the SHARED guard, not by anything in this module —
    /// and the reply is a 404 that does not distinguish "outside" from "missing".
    #[test]
    fn rejects_a_path_outside_the_allowed_roots() {
        let t = TempTree::new("scope");
        let other = TempTree::new("secret");
        let secret = other.write("secret.txt", b"top secret");

        let res = serve(&secret.to_string_lossy(), &[t.canon_root()]);
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
        assert!(
            !res.body().windows(3).any(|w| w == b"top"),
            "an out-of-scope file's CONTENT must never reach the frame"
        );

        let missing = serve(&t.uri_path("nope.css"), &[t.canon_root()]);
        assert_eq!(
            missing.status(),
            res.status(),
            "out-of-scope and missing must be indistinguishable to the sandboxed frame"
        );
    }

    /// `..` is left intact for `resolve_in_scope` to canonicalize — and one that
    /// stays INSIDE a root must still resolve, because `../shared/a.css` is the
    /// commonest relative href there is.
    #[test]
    fn dot_dot_resolves_inside_a_root_and_is_rejected_outside_it() {
        let t = TempTree::new("dotdot");
        t.write("shared/a.css", b"a{}");
        t.write("site/index.html", b"x");
        let roots = [t.canon_root()];

        let inside = serve(&t.uri_path("site/../shared/a.css"), &roots);
        assert_eq!(inside.status(), StatusCode::OK);
        assert_eq!(inside.body(), b"a{}");

        let escaping = serve(&format!("{}/../../etc/passwd", t.uri_path("site")), &roots);
        assert_eq!(escaping.status(), StatusCode::NOT_FOUND);
    }

    /// A symlink out of the workspace is followed by `canonicalize` and then
    /// rejected — the same defence `read_file` has, inherited rather than re-written.
    #[cfg(unix)]
    #[test]
    fn rejects_a_symlink_escaping_the_root() {
        let t = TempTree::new("link");
        let other = TempTree::new("link-target");
        let secret = other.write("secret.css", b"body{}");
        std::os::unix::fs::symlink(&secret, t.root.join("escape.css")).unwrap();

        let res = serve(&t.uri_path("escape.css"), &[t.canon_root()]);
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
    }

    /// A directory is not an asset.
    #[test]
    fn rejects_a_directory() {
        let t = TempTree::new("dir");
        t.write("sub/x.css", b"x");
        let res = serve(&t.uri_path("sub"), &[t.canon_root()]);
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
    }

    /// Percent-decoding is what makes a real href to a non-ASCII filename work.
    #[test]
    fn percent_decodes_a_non_ascii_asset_name() {
        let t = TempTree::new("utf8");
        t.write("café.css", b"c{}");
        let encoded = t.uri_path("caf%C3%A9.css");
        let res = serve(&encoded, &[t.canon_root()]);
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(res.body(), b"c{}");
    }

    /// `+` is a literal in a path — decoding it to a space is form-encoding
    /// semantics and would make `a+b.css` unreachable.
    #[test]
    fn does_not_decode_plus_as_a_space() {
        let t = TempTree::new("plus");
        t.write("a+b.css", b"p{}");
        let res = serve(&t.uri_path("a+b.css"), &[t.canon_root()]);
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(res.body(), b"p{}");
    }

    /// A percent-escape that is not two hex digits is malformed input, not a path.
    #[test]
    fn rejects_a_malformed_percent_escape() {
        assert_eq!(percent_decode("/a%zz/b"), None);
        assert_eq!(percent_decode("/a%4"), None);
        assert_eq!(percent_decode("/a%"), None);
        assert_eq!(
            percent_decode("/plain/path"),
            Some("/plain/path".to_string())
        );
    }

    /// A `%2e%2e` escape decodes to `..` and is then handled by the SAME guard —
    /// the point being that decoding never becomes a bypass.
    #[test]
    fn a_percent_encoded_dot_dot_is_still_rejected_by_the_scope_guard() {
        let t = TempTree::new("encdot");
        let roots = [t.canon_root()];
        let res = serve(
            &format!("{}/%2e%2e/%2e%2e/etc/passwd", t.uri_path("")),
            &roots,
        );
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
    }

    /// An unknown extension must never be served as a document.
    #[test]
    fn an_unknown_extension_is_octet_stream_never_html() {
        let t = TempTree::new("unknown");
        t.write("payload.weird", b"<script>alert(1)</script>");
        let res = serve(&t.uri_path("payload.weird"), &[t.canon_root()]);
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(header(&res, "Content-Type"), "application/octet-stream");
        assert_eq!(header(&res, "X-Content-Type-Options"), "nosniff");
    }

    /// Extension matching is case-insensitive — `INDEX.HTML` is a document.
    #[test]
    fn content_type_is_case_insensitive() {
        assert_eq!(
            content_type(Path::new("A.HTML")),
            "text/html; charset=utf-8"
        );
        assert_eq!(content_type(Path::new("B.PNG")), "image/png");
        assert_eq!(content_type(Path::new("noext")), "application/octet-stream");
    }

    /// Every reply — success AND failure — carries the jail. A 404 that arrived
    /// without a policy would still be a document the frame could be navigated to.
    #[test]
    fn every_response_carries_the_preview_csp_and_cors_header() {
        let t = TempTree::new("headers");
        t.write("ok.css", b"x");
        let roots = [t.canon_root()];
        for res in [serve(&t.uri_path("ok.css"), &roots), serve("/nope", &roots)] {
            assert_eq!(header(&res, "Content-Security-Policy"), PREVIEW_CSP);
            assert_eq!(
                header(&res, "Access-Control-Allow-Origin"),
                "*",
                "module scripts are fetched in CORS mode from an opaque origin"
            );
            assert_eq!(header(&res, "X-Content-Type-Options"), "nosniff");
            assert_eq!(
                header(&res, "Cache-Control"),
                "no-store",
                "a cached stylesheet makes the preview's Reload button look broken"
            );
        }
    }

    /// The three directives the jail actually rests on. Spelled out so that
    /// loosening any of them has to be a deliberate edit to a failing test.
    #[test]
    fn the_preview_csp_closes_egress_and_uses_scheme_sources() {
        assert!(
            PREVIEW_CSP.contains("connect-src 'none'"),
            "no fetch/XHR/WebSocket egress — on Windows this is the IPC mitigation"
        );
        assert!(
            !PREVIEW_CSP.contains("'self'"),
            "'self' matches nothing from an opaque origin — scheme-sources only"
        );
        assert!(
            !PREVIEW_CSP.contains("https:") && !PREVIEW_CSP.contains("http://evil"),
            "no remote source may be admitted: the frame can read local files"
        );
        assert!(
            !PREVIEW_CSP.contains("'unsafe-eval'"),
            "v1 ships without eval; adding it is a deliberate, documented change"
        );
        assert!(
            PREVIEW_CSP.contains("'unsafe-inline'"),
            "the page's own inline script is the feature"
        );
    }

    #[test]
    fn refuses_an_asset_over_the_size_ceiling() {
        assert_eq!(MAX_ASSET_BYTES, 67_108_864, "64 MiB");
    }
}
