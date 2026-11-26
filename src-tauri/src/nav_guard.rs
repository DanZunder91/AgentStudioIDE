//! The app window may only show the app: wry allows any navigation, and a page on a registered
//! scheme gets `invoke()`. Allowed: the app origin, the preview scheme (iframe; wry can't tell
//! frames apart), `about:blank`/`srcdoc`. External links go to the OS browser via `url_open`.

use tauri::Url;

/// Whether the main webview may navigate to `url`. `dev` admits the Vite dev server.
pub fn nav_allowed(url: &Url, dev: bool) -> bool {
    let host = url.host_str().unwrap_or("");
    match url.scheme() {
        "tauri" => host == "localhost",
        s if s == crate::html_preview::SCHEME => true,
        "about" => matches!(url.path(), "blank" | "srcdoc"),
        "http" | "https" => {
            host == "tauri.localhost"
                || host == "preview.localhost"
                || (dev && matches!(host, "localhost" | "127.0.0.1") && url.port() == Some(1420))
        }
        _ => false,
    }
}

/// The plugin that installs [`nav_allowed`] on every webview.
pub fn plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("nav-guard")
        .on_navigation(|_webview, url| {
            let ok = nav_allowed(url, cfg!(dev));
            if !ok {
                eprintln!("nav-guard: refused navigation to {}", url.scheme());
            }
            ok
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(u: &str, dev: bool) -> bool {
        nav_allowed(&Url::parse(u).unwrap(), dev)
    }

    #[test]
    fn the_app_origin_is_allowed_on_every_platform() {
        assert!(ok("tauri://localhost/", false));
        assert!(ok("tauri://localhost/index.html", false));
        assert!(ok("http://tauri.localhost/", false));
        assert!(ok("https://tauri.localhost/", false));
    }

    #[test]
    fn the_preview_iframe_scheme_is_allowed() {
        assert!(ok("preview://localhost/Users/me/repo/index.html", false));
        assert!(ok("http://preview.localhost/C:/repo/index.html", false));
        assert!(ok("about:blank", false));
        assert!(ok("about:srcdoc", false));
    }

    #[test]
    fn remote_and_local_file_pages_are_refused() {
        assert!(!ok("https://evil.example/phish", false));
        assert!(!ok("http://evil.example/", false));
        assert!(!ok("file:///etc/passwd", false));
        assert!(!ok("data:text/html,<script>1</script>", false));
        assert!(!ok("javascript:alert(1)", false));
        assert!(!ok("tauri://evil.example/", false));
        assert!(!ok("about:config", false));
        // A look-alike host is not the app.
        assert!(!ok("https://tauri.localhost.evil.example/", false));
    }

    #[test]
    fn the_dev_server_is_allowed_only_in_dev_and_only_on_its_port() {
        assert!(ok("http://localhost:1420/", true));
        assert!(ok("http://127.0.0.1:1420/", true));
        assert!(!ok("http://localhost:1420/", false));
        assert!(!ok("http://localhost:8080/", true));
    }
}
