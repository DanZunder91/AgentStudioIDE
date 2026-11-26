//! macOS app menu: Cmd+W is "Close Tab" ([`CLOSE_TAB_EVENT`]), since the native accelerator
//! fires before the webview; other OSes keep the default. Best-effort: failure keeps the default.
//! Sent to the FOCUSED window only; pages listen on their own label (`docs/design/tab-tearoff.md`).

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
