//! Windows only: turns off WebView2's browser accelerators (`Ctrl+R`/`F5` reload the whole
//! app, losing unsaved buffers; print, find, DevTools); `keydown` still reaches the page.
//! Tauri has no option for it, so a plugin's `on_webview_ready` sets it for every window.

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
