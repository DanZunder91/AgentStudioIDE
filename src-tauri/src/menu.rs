//! Native macOS application menu.
//!
//! The default Tauri menu binds **Cmd+W** to "Close Window", which closes the app.
//! We want Cmd+W to close the active *tab* (terminal / editor) instead — like a
//! browser or VS Code. So on macOS we install a custom menu whose Window submenu
//! carries a **"Close Tab"** item on Cmd+W that emits [`CLOSE_TAB_EVENT`]; the
//! frontend listens for it and closes the focused pane's active tab. (The native
//! menu accelerator fires *before* the webview, so a JS keydown listener alone can
//! never intercept Cmd+W on macOS — the menu is the only reliable hook.)
//!
//! On non-macOS the default menu is left untouched: there is no native Cmd+W
//! accelerator to fight, so the webview receives Ctrl+W and the frontend handles it
//! with a keydown listener.
//!
//! **Best-effort:** any failure here logs and leaves the default menu in place — a
//! menu problem must never block app startup.
//!
//! **One window, not all of them** (tab tear-off, docs/design/tab-tearoff.md §4.4). The
//! macOS menu is app-wide and its event carries no window, so a plain `emit` reached every
//! window and one Cmd+W closed a tab in each. The event now goes to the FOCUSED window
//! only ([`close_tab_target`]) — and the page listens with its own label as the target,
//! because a JS listener left on the default `Any` target receives every `emit_to`
//! whatever its label says (tauri `event/listener.rs` `match_any_or_filter`).

/// The event emitted when the "Close Tab" menu item (Cmd+W) is triggered. The
/// frontend (`src/features/shortcuts/CloseTabShortcut.tsx`) listens for it.
pub const CLOSE_TAB_EVENT: &str = "menu://close-tab";

/// Which window a "Close Tab" belongs to: the focused one, else the main window (a menu
/// can be driven while no window of ours is key — the event must still land somewhere a
/// tab can close, never everywhere).
pub fn close_tab_target<'a>(windows: impl IntoIterator<Item = (&'a str, bool)>) -> String {
    windows
        .into_iter()
        .find(|(_, focused)| *focused)
        .map(|(label, _)| label.to_string())
        .unwrap_or_else(|| crate::tearoff::MAIN.to_string())
}

/// Menu item id for "Close Tab" — matched in the menu-event handler.
#[cfg(target_os = "macos")]
const CLOSE_TAB_ID: &str = "close_tab";

/// Install the custom app menu (macOS only). See the module docs.
#[cfg(target_os = "macos")]
pub fn install(app: &tauri::App) {
    use tauri::menu::{AboutMetadata, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
    use tauri::Emitter;

    let build = || -> tauri::Result<()> {
        // Cmd+W → "Close Tab" (emits CLOSE_TAB_EVENT) instead of the default
        // "Close Window". This is the whole point of the custom menu.
        let close_tab = MenuItemBuilder::with_id(CLOSE_TAB_ID, "Close Tab")
            .accelerator("CmdOrCtrl+W")
            .build(app)?;

        // App menu (About / Hide / Quit) so the standard macOS accelerators
        // (Cmd+H, Cmd+Q) keep working now that we own the menu.
        let app_menu = SubmenuBuilder::new(app, "Agent Studio")
            .about(Some(AboutMetadata::default()))
            .separator()
            .hide()
            .quit()
            .build()?;

        // Edit menu so text key-equivalents (Cmd+Z/X/C/V/A) keep working in the
        // editor and inputs.
        let edit_menu = SubmenuBuilder::new(app, "Edit")
            .undo()
            .redo()
            .separator()
            .cut()
            .copy()
            .paste()
            .select_all()
            .build()?;

        let window_menu = SubmenuBuilder::new(app, "Window")
            .minimize()
            .item(&close_tab)
            .build()?;

        let menu = MenuBuilder::new(app)
            .items(&[&app_menu, &edit_menu, &window_menu])
            .build()?;

        app.set_menu(menu)?;
        Ok(())
    };

    if let Err(e) = build() {
        eprintln!("custom menu install failed; keeping the default menu: {e}");
        return;
    }

    app.on_menu_event(|app_handle, event| {
        use tauri::Manager;
        if event.id().as_ref() == CLOSE_TAB_ID {
            let windows = app_handle.webview_windows();
            let target = close_tab_target(
                windows
                    .iter()
                    .map(|(label, w)| (label.as_str(), w.is_focused().unwrap_or(false))),
            );
            if let Err(e) = app_handle.emit_to(target.as_str(), CLOSE_TAB_EVENT, ()) {
                eprintln!("{CLOSE_TAB_EVENT} emit failed (webview gone?): {e}");
            }
        }
    });
}

/// No-op on non-macOS: the webview receives Ctrl+W and the frontend handles it.
#[cfg(not(target_os = "macos"))]
pub fn install(_app: &tauri::App) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn close_tab_goes_to_the_focused_window_only() {
        assert_eq!(
            close_tab_target([("main", false), ("tearoff-1", true)]),
            "tearoff-1"
        );
        assert_eq!(
            close_tab_target([("main", true), ("tearoff-1", false)]),
            "main"
        );
    }

    #[test]
    fn close_tab_falls_back_to_the_main_window_when_nothing_is_focused() {
        assert_eq!(
            close_tab_target([("tearoff-2", false), ("main", false)]),
            "main"
        );
        assert_eq!(close_tab_target([]), "main");
    }
}
