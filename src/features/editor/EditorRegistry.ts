/** Non-React owner of every CM6 view; like TerminalRegistry, views outlive their components so a
 * tab switch keeps buffer, undo and scroll. Only a tab close disposes, parking undo in
 * `undoHistory.ts`. The store holds only lightweight flags, never the buffer. */

import { EditorState, StateEffect, type Extension } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { bracketMatching } from "@codemirror/language";
import {
  defaultKeymap,
  history,
  historyField,
  historyKeymap,
  redo,
  undo,
} from "@codemirror/commands";

import { useAppStore, workspaceRoots } from "../../app/store";
import type { EditorBuffer } from "../../app/tearoff/contract";
import { isMainWindow } from "../../app/tearoff/windowRole";
import { detectLanguage } from "../../lib/language";
import { relativeTo } from "../../lib/paths";
import { fileStamps, readFile, writeFile, type FileStamp } from "../workspace/workspaceIpc";
import { languageToShiki } from "./grammar";
import { applyShikiHighlight, shikiField } from "./highlight";
import { THEME_DARK } from "./shiki";
import { editorChromeTheme } from "./theme";
import { blameSupport } from "./blame/blameGutter";
import { bufferSearch } from "./find/bufferSearch";
import { ensureClient } from "./lsp/client";
import { definitionNavigation } from "./lsp/definition";
import { lspProjectRoot } from "./lsp/lspIpc";
import { hasLspServer } from "./lsp/languages";
import { uriFromPath } from "./lsp/uri";
import { clearUndoCache, rememberUndo, takeUndo } from "./undoHistory";
import "./editor.css";

/** Past this size, or with a pathological line, the file opens read-only (no edit). */
const TOO_BIG = 2_000_000;
const HUGE_LINE = /[^\n]{10000,}/;
/** Re-tokenize this long after the last keystroke, so typing stays responsive. */
const REHIGHLIGHT_MS = 50;

interface Entry {
  path: string;
  view: EditorView | null;
  host: HTMLElement | null;
  /** Last-saved (or last-loaded) text — the baseline the dirty flag compares to. */
  baseline: string;
  shikiId: string | null;
  editable: boolean;
  rehighlightTimer: ReturnType<typeof setTimeout> | null;
  /** Disk identity as of our last read/write; `diskWatch` compares it to tell an outside change
   * from our own. */
  stamp: FileStamp | null;
}

const entries = new Map<string, Entry>();
/** Notified on every buffer edit (see `onEditorEdit`). */
const editListeners = new Set<(path: string) => void>();
const editorActions = () => useAppStore.getState().editorActions;
/** Close the focused pane's active tab — the Cmd/Ctrl+W semantics (dirty-editor
 * confirm included). When CodeMirror has focus, its editor IS that active tab. */
const closeActiveTab = () => useAppStore.getState().layoutActions.closeActiveTab();

/** Read-only extensions for the gated (large / binary) files. */
const readOnly: Extension = [EditorState.readOnly.of(true), EditorView.editable.of(false)];

/** Ensure a view exists for `path`, loading its content once. Idempotent. */
export function ensureEditor(path: string): void {
  if (entries.has(path)) {
    // Entry + store slice: the normal preserved buffer (tab switch) — keep it.
    if (useAppStore.getState().editors[path]) return;
    // An orphan (entry, no slice) from a close while no <CodeEditor> was mounted: drop it and
    // load fresh, or it shows "Loading…" forever. A backstop; close paths dispose eagerly.
    dispose(path);
  }
  const entry: Entry = {
    path,
    view: null,
    host: null,
    baseline: "",
    shikiId: null,
    editable: false,
    rehighlightTimer: null,
    stamp: null,
  };
  entries.set(path, entry);
  editorActions().initEditor(path);
  readFile(path).then(
    (text) => {
      createView(entry, text);
      // Stamp what we just read, so the watcher's first tick compares against
      // the bytes actually on screen rather than reporting a phantom change.
      void refreshStamp(path);
    },
    () => editorActions().editorFailed(path),
  );
}

/** A buffer from another window (tear-off): the dirty baseline and the state JSON to resume
 * (`null` when there is none or it does not describe `text`). */
interface Seed {
  baseline: string;
  state: unknown | null;
}

function createView(entry: Entry, text: string, seed?: Seed): void {
  const big = text.length > TOO_BIG || HUGE_LINE.test(text);
  entry.baseline = seed ? seed.baseline : text;
  entry.editable = !big;
  const languageId = detectLanguage(entry.path, firstLine(text));
  entry.shikiId = big ? null : languageToShiki(languageId);

  const extensions: Extension[] = [
    editorChromeTheme, // caret/selection/gutter/active-line — see theme.ts
    // Git blame: the empty compartment the header toggle reconfigures.
    // BEFORE lineNumbers(), so the annotation column sits LEFT of the numbers.
    blameSupport,
    lineNumbers(),
    bracketMatching(),
    // CM history is required: without it Cmd/Ctrl+Z falls to WebKit's shallow native undo.
    // `minDepth: 500` so nearly all edits can be undone. In the BASE list, never a compartment: the
    // blame reconfigure on every save would drop it.
    history({ minDepth: 500 }),
    keymap.of([
      // Cmd/Ctrl+S saves; preventDefault stops the browser's own save dialog.
      { key: "Mod-s", preventDefault: true, run: () => (void save(entry.path), true) },
      // A focused contenteditable swallows the macOS menu's Cmd/Ctrl+W, so close the tab here;
      // preventDefault lets the non-mac window fallback skip it.
      { key: "Mod-w", preventDefault: true, run: () => (closeActiveTab(), true) },
      // Undo/redo here for the same reason: the Edit menu's Cmd+Z never reaches CM6. Do NOT edit
      // menu.rs instead (it gives plain <input>s undo). Before defaultKeymap so nothing shadows it.
      ...historyKeymap,
      ...defaultKeymap,
    ]),
    // If Cmd+Z comes as a native Edit-menu undo rather than a keydown, WebKit edits the DOM behind
    // CM6; map those input types onto the history commands. Not redundant with the keymap: it is a
    // different delivery path for the same keystroke.
    EditorView.domEventHandlers({
      beforeinput: (event, view) => {
        if (event.inputType === "historyUndo") {
          event.preventDefault();
          return undo(view);
        }
        if (event.inputType === "historyRedo") {
          event.preventDefault();
          return redo(view);
        }
        return false; // every other inputType is CodeMirror's business, untouched
      },
    }),
    // In-file find: the IntelliJ-style search bar. Self-contained —
    // brings its own Prec.highest Mod-f/Escape/F3 keymap (the
    // binding must live in a CM6 keymap so the contenteditable can't eat it).
    bufferSearch(),
    // Editable by default (like a normal IDE); only gated files open read-only.
    ...(entry.editable ? [] : [readOnly]),
    shikiField,
    EditorView.updateListener.of((u) => {
      if (u.docChanged) onDocChanged(entry, u.state.doc.toString());
    }),
  ];

  // Restore a parked undo stack only if the text is unchanged since close: history events are
  // positions (undoHistory.ts). A tear-off seed brings its own, already-checked stack.
  const restored = seed ? seed.state : entry.editable ? takeUndo(entry.path, text) : null;
  const state = restoredState(restored, extensions) ?? EditorState.create({ doc: text, extensions });
  const view = new EditorView({ state });
  entry.view = view;
  editorActions().editorReady(entry.path, entry.editable);
  if (entry.host) entry.host.appendChild(view.dom);
  if (entry.shikiId) void applyShikiHighlight(view, entry.shikiId, THEME_DARK);
  // Code intelligence (M5): attach the LSP client for supported languages.
  attachLsp(entry.path, view, languageId);
}

/** A JSON that won't load loses the undo stack, never the buffer: the text is always in hand. */
function restoredState(json: unknown | null, extensions: Extension[]): EditorState | null {
  if (!json) return null;
  try {
    return EditorState.fromJSON(json, { extensions }, { history: historyField });
  } catch {
    return null;
  }
}

function onDocChanged(entry: Entry, text: string): void {
  editorActions().setEditorDirty(entry.path, text !== entry.baseline);
  for (const listener of editListeners) listener(entry.path);
  if (!entry.shikiId) return;
  // Debounced re-tokenize so highlighting stays live while typing without
  // running Shiki on every keystroke.
  if (entry.rehighlightTimer) clearTimeout(entry.rehighlightTimer);
  entry.rehighlightTimer = setTimeout(() => {
    entry.rehighlightTimer = null;
    if (entry.view && entry.shikiId) void applyShikiHighlight(entry.view, entry.shikiId, THEME_DARK);
  }, REHIGHLIGHT_MS);
}

/** Render `path`'s view into `host` (creating it if the load already finished). */
export function attach(path: string, host: HTMLElement): void {
  const entry = entries.get(path);
  if (!entry) return;
  entry.host = host;
  if (entry.view && entry.view.dom.parentElement !== host) host.appendChild(entry.view.dom);
}

/** Move the view out of the tree but keep it alive — unless its tab is gone. */
export function detach(path: string): void {
  const entry = entries.get(path);
  if (!entry) return;
  entry.view?.dom.remove();
  entry.host = null;
  if (!hasEditorTab(path)) dispose(path);
}

/** Tear a view down for good (its tab closed). */
export function dispose(path: string): void {
  const entry = entries.get(path);
  if (!entry) {
    // Still drop the slice: a raster image tab has one but no `Entry`, and a leaked slice hands
    // a reopen the old zoom. `disposeEditor` is a plain delete.
    editorActions().disposeEditor(path);
    return;
  }
  if (entry.rehighlightTimer) clearTimeout(entry.rehighlightTimer);
  // Park the undo stack BEFORE destroy(), which takes the history with it. Not in `detach()`: a
  // detached view stays alive with its own history.
  if (entry.editable && entry.view) {
    rememberUndo(
      path,
      entry.view.state.toJSON({ history: historyField }),
      entry.view.state.doc.toString(),
    );
  }
  entry.view?.destroy();
  entries.delete(path);
  editorActions().disposeEditor(path);
}

/* Tab tear-off (docs/design/tab-tearoff.md §3): an editor moving windows carries its buffer,
 * since re-reading the file there would drop unsaved edits. `app/tearoff` drives these. */

/** `path`'s buffer for another window: text, baseline, stamp, stale flag, plus selection and
 * undo with `history`. `null` while loading: no edits to carry; the receiver reads the file. */
export function exportEditor(path: string, opts: { history: boolean }): EditorBuffer | null {
  const entry = entries.get(path);
  const view = entry?.view;
  if (!entry || !view) return null;
  return {
    text: view.state.doc.toString(),
    baseline: entry.baseline,
    state: opts.history ? JSON.stringify(view.state.toJSON({ history: historyField })) : null,
    stamp: entry.stamp,
    stale: useAppStore.getState().editors[path]?.staleOnDisk ?? false,
  };
}

/** Builds the editor from a carried buffer; call BEFORE the tab exists. Its undo stack is kept
 * only if it describes exactly `text` (positions); the caller sets the dirty flag after. */
export function seedEditor(path: string, buffer: EditorBuffer): void {
  if (entries.has(path)) abandon(path);
  const entry: Entry = {
    path,
    view: null,
    host: null,
    baseline: buffer.baseline,
    shikiId: null,
    editable: false,
    rehighlightTimer: null,
    stamp: buffer.stamp,
  };
  entries.set(path, entry);
  editorActions().initEditor(path);
  createView(entry, buffer.text, { baseline: buffer.baseline, state: carriedState(buffer) });
  if (buffer.stale) editorActions().setEditorStale(path, true);
  // No carried stamp means the watcher could never tell an external change from none
  // (`null` reads as "cannot tell") — take one now, as a fresh load would.
  if (!buffer.stamp) void refreshStamp(path);
}

/** The carried CodeMirror state, if it parses and describes exactly `buffer.text`. */
function carriedState(buffer: EditorBuffer): unknown | null {
  if (!buffer.state) return null;
  try {
    const json = JSON.parse(buffer.state) as { doc?: unknown };
    return json.doc === buffer.text ? json : null;
  } catch {
    return null;
  }
}

/** Disposes WITHOUT parking undo: the stack left with the tab, and parking would leave a stale
 * second copy for a later tab here. */
export function abandon(path: string): void {
  const entry = entries.get(path);
  if (entry) {
    if (entry.rehighlightTimer) clearTimeout(entry.rehighlightTimer);
    entry.view?.destroy();
    entries.delete(path);
  }
  editorActions().disposeEditor(path);
}

/** Applies carried text to the EXISTING buffer as a normal transaction, so the old text stays
 * one undo away. Baseline and stamp stay this window's. Waits for a loading buffer; resolves
 * whether the text changed. */
export async function applyCarriedText(path: string, text: string): Promise<boolean> {
  const view = await whenViewReady(path);
  // The tab may have closed (or closed and reopened) while the buffer loaded.
  if (!view || entries.get(path)?.view !== view) return false;
  if (view.state.doc.toString() === text) return false;
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
  return true;
}

/** Every edit to any buffer here; tear-off follows unsaved text with it. Returns unsubscribe. */
export function onEditorEdit(listener: (path: string) => void): () => void {
  editListeners.add(listener);
  return () => {
    editListeners.delete(listener);
  };
}

/** Persist the buffer. Resolves true on success; on failure keeps buffer+dirty. */
export async function save(path: string): Promise<boolean> {
  const entry = entries.get(path);
  if (!entry?.view) return false;
  const text = entry.view.state.doc.toString();
  try {
    await writeFile(path, text);
    entry.baseline = text;
    // Re-stamp after OUR write, or the watcher would see the mtime move and
    // announce that someone else changed the file we just saved.
    void refreshStamp(path);
    editorActions().editorSaved(path);
    return true;
  } catch (err) {
    editorActions().editorSaveFailed(path, err instanceof Error ? err.message : String(err));
    return false;
  }
}

/** Re-reads disk into the open buffer (e.g. after a Git revert) as a normal transaction, so
 * Cmd/Ctrl+Z restores the edits. No-op when equal; a failed read leaves the buffer as is. */
export function reloadFromDisk(path: string): void {
  const entry = entries.get(path);
  if (!entry?.view) return;
  void readFile(path).then(
    (text) => {
      const view = entry.view;
      // The tab may have closed while the read was in flight; `entries.get` also
      // catches a close-and-reopen, which produced a different Entry.
      if (!view || entries.get(path) !== entry) return;
      // Baseline BEFORE the dispatch: `onDocChanged` runs synchronously inside it
      // and compares against this field, so setting it after would flash the tab
      // dirty for a change the user did not make.
      entry.baseline = text;
      // Whatever we just read IS the file now, so the conflict (if any) is over.
      void refreshStamp(path);
      editorActions().setEditorStale(path, false);
      if (view.state.doc.toString() === text) {
        editorActions().setEditorDirty(path, false);
        return;
      }
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    },
    () => undefined,
  );
}

/** Every path with a live editor buffer — the set `diskWatch` polls. */
export function openEditorPaths(): string[] {
  return [...entries.keys()];
}

/** The stamp recorded for `path`, or null when we have never stamped it. */
export function stampOf(path: string): FileStamp | null {
  return entries.get(path)?.stamp ?? null;
}

/** Record a freshly-observed stamp for `path`. */
export function rememberStamp(path: string, stamp: FileStamp | null): void {
  const entry = entries.get(path);
  if (entry) entry.stamp = stamp;
}

/** Stamp `path` from disk and remember it. Best-effort; never throws. */
export async function refreshStamp(path: string): Promise<void> {
  const [stamp] = await fileStamps([path]);
  rememberStamp(path, stamp ?? null);
}

/** The live view for `path`, if one exists (for the LSP Workspace seam). */
export function getView(path: string): EditorView | null {
  return entries.get(path)?.view ?? null;
}

/** The live document (unsaved edits included), via the same `state.doc` as `save`; null while
 * loading. */
export function currentText(path: string): string | null {
  const view = entries.get(path)?.view;
  return view ? view.state.doc.toString() : null;
}

/** Ensures the editor and resolves its view once loaded (`Workspace.displayFile`); null after
 * `timeoutMs`. */
export function whenViewReady(path: string, timeoutMs = 5000): Promise<EditorView | null> {
  ensureEditor(path);
  const existing = getView(path);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve) => {
    const start = Date.now();
    const timer = setInterval(() => {
      const view = getView(path);
      if (view || Date.now() - start > timeoutMs) {
        clearInterval(timer);
        resolve(view);
      }
    }, 30);
  });
}

/** Rust's `lsp_project_root` first; if it fails (path raced out of scope), the file's containing
 * workspace root, then the primary root, so intelligence degrades rather than disappears. */
async function lspRootFor(languageId: string, path: string): Promise<string | null> {
  const s = useAppStore.getState();
  const containing = containingWorkspaceRoot(workspaceRoots(s), path);
  try {
    return await lspProjectRoot(languageId, path);
  } catch {
    return containing ?? s.workspaceRoot;
  }
}

/** Longest root prefixing `path` by segment; either separator, case-insensitive for Windows. */
export function containingWorkspaceRoot(roots: string[], path: string): string | null {
  let best: string | null = null;
  for (const root of roots) {
    if (relativeTo(root, path) !== null) {
      if (best === null || root.length > best.length) best = root;
    }
  }
  return best;
}

/** Attach the LSP client + code navigation to the editor, if the language has a server. */
function attachLsp(path: string, view: EditorView, languageId: string): void {
  if (!hasLspServer(languageId)) return; // no server for this language → intelligence off
  // Main window only (tear-off): each window is its own realm, so a client here would start a
  // second server for a root already indexed; see the tear-off ADR.
  if (!isMainWindow()) return;
  void lspRootFor(languageId, path).then((root) => {
    if (!root) return;
    return ensureClient(languageId, root).then((client) => {
      // The view may have been torn down while the server started.
      if (!client || getView(path) !== view) return;
      const uri = uriFromPath(path);
      view.dispatch({
        effects: StateEffect.appendConfig.of([
          client.plugin(uri, languageId),
          definitionNavigation(languageId),
        ]),
      });
    });
  });
}

/** Test isolation. Also clears the undo cache, so close→reopen tests must call `dispose(path)`. */
export function disposeAll(): void {
  for (const path of [...entries.keys()]) dispose(path);
  clearUndoCache();
}

function hasEditorTab(path: string): boolean {
  return Object.values(useAppStore.getState().tabs).some(
    (t) => t.ref.kind === "editor" && t.ref.path === path,
  );
}

function firstLine(text: string): string {
  const nl = text.indexOf("\n");
  return nl === -1 ? text : text.slice(0, nl);
}
