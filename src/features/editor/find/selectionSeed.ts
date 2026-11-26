/** What Cmd/Ctrl+F seeds, shared by every find bar: non-empty, single-line (else the query is left
 * untouched), at most `SEED_MAX`, never trimmed. Read the DOM selection synchronously in the key
 * handler: the surfaces defer focusing their input, and focusing collapses the selection. */

/** `@codemirror/search`'s own cap on a selection-derived query. */
export const SEED_MAX = 200;

/** `null` means leave the query alone; accepts null/undefined so callers need no guard. */
export function seedFromSelectionText(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (raw.length > SEED_MAX) return null;
  // A line break anywhere means the selection spans lines. `\r` is here because
  // a paste-driven selection can carry CRLF; a real browser, xterm and CM6 all
  // join with `\n`.
  if (/[\r\n]/.test(raw)) return null;
  return raw;
}

/** Seeds only when the selection lies inside `container`, so one surface never seeds another's
 * bar (side-by-side compare bodies) and the Markdown preview's window-level fallback can work. */
export function domSelectionSeed(container: HTMLElement): string | null {
  // `null` where the document has no view (a detached document); jsdom and every
  // real WebView hand back a Selection.
  const selection = window.getSelection();
  if (selection === null || selection.rangeCount === 0) return null;
  // `contains` is true for the container itself, so a select-all inside it —
  // whose common ancestor IS the container — still counts as ours.
  if (!container.contains(selection.getRangeAt(0).commonAncestorContainer)) return null;
  return seedFromSelectionText(selection.toString());
}
