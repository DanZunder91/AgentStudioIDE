/**
 * SaveRequestShortcut — Cmd/Ctrl+S saves the focused pane's active API request into
 * Collections. Renders nothing; an effect host mounted once in <App/>.
 *
 * ONE platform path (unlike Cmd+W): Save is NOT a native-menu accelerator
 * (`src-tauri/src/menu.rs` binds only Cmd+W), so Cmd/Ctrl+S reaches the webview on
 * every platform and a single keydown listener suffices.
 *
 * Routing by active-tab kind lives in the store (`saveActiveApiRequest`): it returns
 * true when the active tab is an API request (saved, or the name dialog opened) and
 * false otherwise. A focused CODE EDITOR handles its own Cmd/Ctrl+S (CodeMirror's
 * `Mod-s` keymap) and preventDefaults it *before* this window-level listener sees the
 * event, so the `defaultPrevented` guard cleanly yields to file-save. Otherwise we
 * always preventDefault to suppress the browser's "save page" dialog.
 */

import { useEffect } from "react";

import { useAppStore } from "../../app/store";

export function SaveRequestShortcut(): null {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // A focused editor already handled + preventDefaulted its file-save; don't
      // steal it for the API path.
      if (e.defaultPrevented) return;
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        !e.altKey &&
        e.key.toLowerCase() === "s"
      ) {
        // Suppress the browser save-page dialog regardless; the store decides
        // whether there is an API request to save.
        e.preventDefault();
        useAppStore.getState().apiActions.saveActiveApiRequest();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return null;
}
