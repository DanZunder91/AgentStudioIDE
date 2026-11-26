/** Refreshes open files changed on disk by polling `file_stamps` while visible and on focus (a
 * deliberate choice over a `notify` watcher). Clean buffers reload silently; a dirty one is never
 * touched, only flagged `staleOnDisk` so the editor offers Reload. */

import { useAppStore } from "../../app/store";
import { fileStamps, type FileStamp } from "../workspace/workspaceIpc";
import { openEditorPaths, reloadFromDisk, stampOf, rememberStamp } from "./EditorRegistry";

/** How often to look while the window is visible. */
export const WATCH_INTERVAL_MS = 2_000;

/** Two stamps describe the same bytes? `null` on either side means "cannot tell". */
export function sameStamp(a: FileStamp | null, b: FileStamp | null): boolean {
  if (a === null || b === null) return false;
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

let timer: ReturnType<typeof setInterval> | null = null;
let listening = false;
/** Re-entrancy guard: a slow tick must not overlap the next one. */
let checking = false;

/** One pass over every open editor; exported for tests and the focus handler. */
export async function checkOpenFilesOnce(): Promise<void> {
  if (checking) return;
  const paths = openEditorPaths();
  if (paths.length === 0) return;
  checking = true;
  try {
    const stamps = await fileStamps(paths);
    const editors = useAppStore.getState().editors;
    const setStale = useAppStore.getState().editorActions.setEditorStale;

    paths.forEach((path, i) => {
      const now = stamps[i];
      const known = stampOf(path);
      // `null` is "cannot tell", never "changed": a file briefly unreadable
      // mid-write must not be reported as a conflict.
      if (now === null || known === null || sameStamp(known, now)) return;

      // Record the new stamp FIRST, so a file that keeps changing does not
      // re-fire this branch every tick while the user decides what to do.
      rememberStamp(path, now);

      const dirty = isDirty(path);
      if (!dirty) {
        // Clean: just show the truth. `reloadFromDisk` applies it as an ordinary
        // edit, so Cmd+Z still steps back to what was on screen.
        reloadFromDisk(path);
        return;
      }
      if (editors[path]) setStale(path, true);
    });
  } finally {
    checking = false;
  }
}

/** Does this path have unsaved edits? Read from the tab, where dirty lives. */
function isDirty(path: string): boolean {
  return Object.values(useAppStore.getState().tabs).some(
    (t) => t.ref.kind === "editor" && t.ref.path === path && Boolean(t.dirty),
  );
}

/** Check now if the window is visible — the focus/visibility handler. */
function checkIfVisible(): void {
  if (document.visibilityState === "visible") void checkOpenFilesOnce();
}

/** Idempotent and returns a stop function, so a StrictMode double-mount cannot start two. */
export function startDiskWatch(): () => void {
  if (timer === null) {
    timer = setInterval(checkIfVisible, WATCH_INTERVAL_MS);
  }
  if (!listening) {
    listening = true;
    // Focus and visibility both, because they are different events: alt-tabbing
    // back fires focus, and switching desktops or un-hiding fires visibility.
    window.addEventListener("focus", checkIfVisible);
    document.addEventListener("visibilitychange", checkIfVisible);
  }
  return stopDiskWatch;
}

/** Stop watching. Idempotent; safe to call when never started. */
export function stopDiskWatch(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  if (listening) {
    listening = false;
    window.removeEventListener("focus", checkIfVisible);
    document.removeEventListener("visibilitychange", checkIfVisible);
  }
}
