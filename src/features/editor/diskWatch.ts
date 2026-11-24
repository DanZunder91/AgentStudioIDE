/**
 * diskWatch — notice when an OPEN file changes on disk, and refresh it.
 *
 * The bug: after an agent modified an open .md file, the editor did not show
 * the change until the file was closed and opened again.
 *
 * 🔴 **This product exists to orchestrate agents that edit your files**, so a
 * file changing underneath an open editor is the NORMAL case here, not the edge
 * one. Until now nothing watched: there is no `notify` crate in the Rust tree and
 * no fs subscription in the frontend, so an open buffer showed whatever it read
 * the moment it was opened, forever.
 *
 * ## Why polling a stamp rather than a real watcher
 *
 * A `notify`-based watcher is push-based and more elegant, and it is a whole
 * subsystem: a new dependency through the audit gate, recursive watch lifecycles
 * tied to tab open/close, and a different set of platform quirks on each OS. What
 * is actually needed is far smaller — the set of watched paths is *the open
 * editors*, which is a handful, and one batched `stat` answers all of them. So
 * this polls `file_stamps` on a timer while the window is visible, and checks
 * immediately on focus, which is the moment the user is most likely to look.
 * Recorded as a deliberate track, not an oversight; a real watcher remains the
 * upgrade path if this ever costs too much.
 *
 * ## The rule that matters: never eat unsaved work
 *
 * A **clean** buffer is reloaded silently — that is the common case and the
 * whole point. A **dirty** one is never touched: it is flagged `staleOnDisk` and
 * the editor offers a Reload. Silently overwriting an unsaved edit would be a
 * far worse bug than the staleness it fixes.
 */

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

/**
 * Compare every open editor against disk, once.
 *
 * Exported so a test — and the focus handler — can drive a single pass without
 * waiting on a timer.
 */
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

/**
 * Start watching. Idempotent, and returns a stop function — the
 * `startGitPolling` contract, so a StrictMode double-mount cannot start two.
 */
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
