/**
 * undoHistory — the undo stack's carry-over across a tab CLOSE (undo must keep
 * working even after the file was saved or closed).
 *
 * `EditorRegistry.dispose()` destroys the `EditorView`, and CodeMirror's history
 * lives *inside* that view's state — so without this module, closing a tab throws
 * the user's undo stack away. Undo-after-SAVE needs nothing (save only writes to
 * disk and moves `entry.baseline`; it never touches `state.doc`), but
 * undo-after-CLOSE needs the history to outlive the view. That is all this is: a
 * small parking lot keyed by path, written on dispose and read once on the next
 * `createView`.
 *
 * ── Why in-memory, and only for this session ─────────────────────────────────
 * State living only in the JS heap is state you have decided to lose — and that
 * is the right call here, deliberately. An undo stack
 * is transient by nature (IntelliJ and VS Code both drop it on restart), and a
 * stack recorded three days ago, replayed onto a file that agents have rewritten
 * since, is a corruption risk dressed as a feature. Session-scoped is the whole
 * ask; nothing here reaches the disk.
 *
 * ── The doc-identity guard is the load-bearing part ──────────────────────────
 * A CodeMirror history event is a list of document POSITIONS. Replaying it against
 * a buffer whose text has moved underneath — an agent wrote the file, git switched
 * branches, another tool reformatted it — does not fail loudly; it silently splices
 * text at the wrong offsets. So `takeUndo` hands the snapshot back only when the
 * text just read from disk is byte-for-byte what was in the buffer at dispose
 * time. A file that changed while closed loses its undo stack. That is the correct
 * track: a lost stack is an inconvenience, a corrupted buffer is data loss.
 */

/** One parked history: the CM6 state JSON plus the doc it is valid against. */
export interface UndoSnapshot {
  /** The buffer text at dispose time — the identity the restore is gated on. */
  doc: string;
  /** `EditorState.toJSON({ history: historyField })`, opaque to this module. */
  json: unknown;
}

/**
 * How many closed files keep their stack. A user cycling through files should
 * find undo intact on the ones they were actually working in; past a couple of
 * dozen this is just memory held for a buffer nobody is coming back to.
 */
const MAX_PATHS = 24;

/**
 * Skip anything past this — the same threshold `EditorRegistry` uses to open a
 * file read-only. A file we refuse to let the user edit has no undo stack worth
 * parking, and a multi-megabyte string per closed tab is exactly the leak this
 * cache must not become.
 */
const TOO_BIG = 2_000_000;

/**
 * Insertion order IS the recency order: `rememberUndo` deletes before it sets, so
 * the oldest *remembered* entry is always `keys().next()`. A module singleton, like
 * the registry it serves — `clearUndoCache()` is how tests reset it.
 */
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

/**
 * Consume `path`'s parked history. Returns the state JSON **only** when `doc` —
 * the text just read from disk — is identical to the text at dispose time.
 *
 * Consumed either way, on purpose: a snapshot that did not match is a snapshot
 * that is already wrong, and leaving it parked would hand it to some later reopen
 * that happens to line up by coincidence. One dispose, one restore.
 */
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
