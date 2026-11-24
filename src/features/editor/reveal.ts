/**
 * revealInEditor — open (or focus) a file and put the cursor at a location.
 *
 * The reusable "reveal a location" seam. Go-to-definition reveals an LSP result
 * this way (via the Workspace), and the Find-in-Files panel opens a match through
 * this same helper — one place that knows how to open a tab + position + scroll.
 *
 * `line`/`col` are **1-based** (grep / ripgrep / editor gutter convention); `col`
 * defaults to the start of the line. Out-of-range values are clamped, never throw.
 */

import { TAB_ELSEWHERE, useAppStore } from "../../app/store";
import { whenViewReady } from "./EditorRegistry";
import { hasTextSource } from "./previewKinds";

export async function revealInEditor(path: string, line: number, col = 1): Promise<void> {
  // Held by another OS window (tab tear-off): that window was brought forward instead, and
  // building a buffer here to put a cursor in would make this window a second copy of it.
  if (useAppStore.getState().layoutActions.openEditorTab(path) === TAB_ELSEWHERE) return;
  // A raster image has no buffer to put a cursor in, and `whenViewReady`
  // would poll for a full 5 seconds before resolving null. Quick-open searches
  // FILENAMES, so a `.png` hit here is an everyday case, not an edge one.
  if (!hasTextSource(path)) return;
  const view = await whenViewReady(path);
  if (!view) return;

  const doc = view.state.doc;
  const lineNo = Math.min(Math.max(1, Math.trunc(line)), doc.lines);
  const lineObj = doc.line(lineNo);
  const anchor = Math.min(lineObj.from + Math.max(0, Math.trunc(col) - 1), lineObj.to);

  view.dispatch({ selection: { anchor }, scrollIntoView: true, userEvent: "select.reveal" });
  view.focus();
}
