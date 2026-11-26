/** Cmd/Ctrl+S is no native-menu accelerator (menu.rs binds only Cmd+W), so one keydown listener
 * covers every platform. A focused code editor preventDefaults its own Mod-s first, so the
 * defaultPrevented guard yields to file-save; otherwise preventDefault blocks "save page". */

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
