//! WebView2's own browser shortcuts, switched off in the app's windows — **Windows only**
//! (a Windows mechanism beside nothing, because WKWebView on macOS and
//! WebKitGTK on Linux have no browser accelerators to begin with).
//!
//! **Why.** WebView2 is Edge, and by default it answers Edge's keys inside the IDE window:
//! `Ctrl+R` / `F5` **reload the whole app** (every unsaved editor buffer, the layout, the
//! in-memory stores — gone, with no prompt), `Ctrl+P` opens the print dialog over the IDE,
//! `Ctrl+F` / `F3` open Edge's find bar on top of the IDE's own find, `Ctrl+Shift+I` / `F12`
//! reach DevTools where those are enabled (and `F12` is the IDE's Go-to-definition). macOS
//! has none of this: a WKWebView has no browser shortcuts.
//!
//! **The setting.** `ICoreWebView2Settings3::AreBrowserAcceleratorKeysEnabled = false`. Per
//! Microsoft's documentation it turns off exactly the keys that reach *browser features*
//! (find, print, reload, zoom, DevTools, back/forward/search) and leaves editing and movement
//! keys (`Ctrl+C/V/X/A/Z`, Home/End, PgUp/PgDn) alone. It does **not** stop the key reaching
//! the page: `keydown` still fires, so every IDE shortcut (`Ctrl+F`, `Ctrl+S`,
//! `Ctrl+Shift+F/O`, `Ctrl+W`, `F12`, `F3`, a terminal's `Ctrl+C/V`) is handled by the IDE
//! exactly as before — only Edge's own action behind the key is gone. Zoom is already off:
//! Tauri's `zoomHotkeysEnabled` defaults to `false` (`IsZoomControlEnabled`), which also
//! keeps `Ctrl+wheel` for the preview's own zoom.
//!
//! **Where.** Tauri 2.11 exposes no builder option for it (wry has
//! `with_browser_accelerator_keys`, but `tauri-runtime-wry` never passes it through), so it
//! is set on the live controller from a plugin's `on_webview_ready` — which runs for the main
//! window AND every tear-off window (`tearoff.rs`), and any window added later, with no call
//! site to forget.

/// Whether this build switches WebView2's browser accelerator keys off. Windows only; a
/// constant so the policy is asserted by a test on every OS.
pub const DISABLES_BROWSER_ACCELERATORS: bool = cfg!(windows);

/// The plugin that applies the setting to every webview as it is created.
pub fn plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("webview-keys")
        .on_webview_ready(|webview| {
            if DISABLES_BROWSER_ACCELERATORS {
                apply(&webview);
            }
        })
        .build()
}

#[cfg(windows)]
fn apply<R: tauri::Runtime>(webview: &tauri::Webview<R>) {
    let label = webview.label().to_string();
    let scheduled = webview.with_webview(move |platform| {
        if let Err(e) = disable_browser_accelerators(&platform.controller()) {
            // Loud, because the symptom — Ctrl+R reloading the IDE — looks like a crash.
            eprintln!("webview-keys: could not disable browser shortcuts in {label}: {e}");
        }
    });
    if let Err(e) = scheduled {
        eprintln!("webview-keys: {e}");
    }
}

#[cfg(not(windows))]
fn apply<R: tauri::Runtime>(_webview: &tauri::Webview<R>) {}

/// The COM call itself (main thread, inside `with_webview`).
#[cfg(windows)]
fn disable_browser_accelerators(
    controller: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller,
) -> windows_core::Result<()> {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
    use windows_core::Interface as _;
    // SAFETY: `controller` is the live WebView2 controller Tauri hands to `with_webview`, on
    // the main (UI) thread it belongs to; these are plain COM property calls on it.
    unsafe {
        let settings = controller.CoreWebView2()?.Settings()?;
        settings
            .cast::<ICoreWebView2Settings3>()?
            .SetAreBrowserAcceleratorKeysEnabled(false)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The policy: Windows switches the browser shortcuts off; macOS/Linux have none to switch.
    #[test]
    fn browser_shortcuts_are_disabled_on_windows_only() {
        assert_eq!(DISABLES_BROWSER_ACCELERATORS, cfg!(windows));
    }

    /// The plugin is what reaches every window (main + tear-offs). A refactor that drops the
    /// registration compiles everywhere and silently brings Ctrl+R-reloads-the-IDE back, so the
    /// registration is checked in the source (the shape of the no-window guard).
    #[test]
    fn the_app_registers_the_plugin_for_every_webview() {
        let lib = include_str!("lib.rs");
        assert!(
            lib.contains(".plugin(webview_keys::plugin())"),
            "lib.rs must register webview_keys::plugin() on the app builder"
        );
    }
}
