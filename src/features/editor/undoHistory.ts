/** Parks CM6 undo history by path across a tab close (dispose destroys the view; save needs
 * nothing). In memory, session-only. Restored only onto a byte-identical doc: history is
 * positions, and replaying onto moved text splices at the wrong offsets. */

/** One parked history: the CM6 state JSON plus the doc it is valid against. */
export interface UndoSnapshot {
  /** The buffer text at dispose time — the identity the restore is gated on. */
  doc: string;
  /** `EditorState.toJSON({ history: historyField })`, opaque to this module. */
  json: unknown;
}

/** Closed files that keep their stack; past a couple of dozen it is memory nobody returns to. */
const MAX_PATHS = 24;

/** `EditorRegistry`'s read-only threshold: no parked history for files we won't let you edit. */
const TOO_BIG = 2_000_000;

/** Insertion order is recency (`rememberUndo` deletes before it sets). `clearUndoCache()` resets
 * it for tests. */
const cache = new Map<string, UndoSnapshot>();

/** Park `path`'s history (called from `dispose`, before the view is destroyed). */
export function rememberUndo(path: string, json: unknown, doc: string): void {
  if (doc.length > TOO_BIG) return; // read-only gate: nothing to undo anyway
  cache.delete(path); // re-insert at the end, so re-remembering refreshes recency
  cache.set(path, { doc, json });
  while (cache.size > MAX_PATHS) {
    // Map iteration is insertion order, and `size > MAX_PATHS` guarantees there
    // is a first key — hence the cast rather than an `undefined` branch no test
    // could ever reach (an unfalsifiable guard is dead code).
    cache.delete(cache.keys().next().value as string);
  }
}

/** Consume `path`'s history: the state JSON only if `doc` equals the doc at dispose. Consumed
 * either way, so a mismatched snapshot cannot match a later reopen by coincidence. */
export function takeUndo(path: string, doc: string): unknown | null {
  const snapshot = cache.get(path);
  if (!snapshot) return null;
  cache.delete(path);
  return snapshot.doc === doc ? snapshot.json : null;
}

/** Drop every parked history (app-level reset; `disposeAll` calls this). */
export function clearUndoCache(): void {
  cache.clear();
}

/** How many histories are parked right now — the bounds' observable side. */
export function undoCacheSize(): number {
  return cache.size;
}
