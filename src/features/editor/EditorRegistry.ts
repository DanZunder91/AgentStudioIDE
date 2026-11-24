/**
 * EditorRegistry — the non-React owner of every CodeMirror 6 view (M4).
 *
 * Mirrors the TerminalRegistry contract: instances OUTLIVE their React
 * components. `attach`/`detach` move a view's DOM in and out of the visible tree
 * but keep the editor — its buffer, undo history, selection, scroll, and edit
 * mode — alive, so switching tabs and back never drops a user's edits. Only a
 * tab CLOSE disposes (detected on detach: no editor tab left for the path) — and
 * even then the undo stack is parked in `undoHistory.ts` so reopening an
 * unchanged file picks it back up.
 *
 * It drives the reactive `editors` store slice (status / editable / editing /
 * saveError / savedAt) and the tab's dirty dot, but the heavy buffer never
 * enters React state — the store holds only lightweight flags.
 */

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
  /**
   * The file's on-disk identity as of the last read or write we did.
   *
   * `diskWatch` compares this against a fresh stamp to tell "an agent changed
   * this" from "we changed this ourselves". Kept beside the buffer, because the
   * buffer is what it describes.
   */
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
    // Entry WITHOUT its slice: an orphan. Some close path removed the tab and
    // its slice while no <CodeEditor> was mounted (a background tab has none),
    // so detach → dispose never ran. Left alone, this early-return would skip
    // initEditor/readFile and the editor would show "Loading…" forever; and
    // resurrecting the stale buffer would skip the disk read. Drop it, load
    // fresh. (closeTab/closePane now dispose eagerly — this is the backstop.)
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

/**
 * A buffer arriving from another window (tab tear-off): the baseline the dirty flag compares
 * against, and the state JSON (selection + undo stack) to resume — `null` when there is none
 * or it does not describe `text` (see `seedEditor`).
 */
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
    // Undo/redo (bug: undo stopped working after a save, and sometimes only two
    // undo steps were available). This editor shipped with NO CodeMirror
    // history at all, so Cmd/Ctrl+Z fell through the contenteditable to WebKit's
    // own native undo stack — which is shallow, and is truncated every time CM6
    // rewrites decorations (i.e. on every 50 ms Shiki re-highlight while typing).
    // Hence only two steps.
    //
    // `minDepth: 500` rather than the default 100: it must be possible to undo
    // nearly all, or all, of the edits made, and 500 events of text is cheap.
    //
    // It sits in the BASE list, never inside a compartment: `CodeEditor`'s blame
    // effect re-runs on every successful save and dispatches
    // `blameCompartment.reconfigure(...)`, which would drop a history living
    // inside it — the same bug rebuilt, and only after a save.
    history({ minDepth: 500 }),
    keymap.of([
      // Cmd/Ctrl+S saves; preventDefault stops the browser's own save dialog.
      { key: "Mod-s", preventDefault: true, run: () => (void save(entry.path), true) },
      // Cmd/Ctrl+W closes this file's tab. Needed because on macOS the native
      // menu accelerator that drives Cmd/Ctrl+W (menu://close-tab) never fires
      // while CodeMirror's contenteditable holds focus — the editable element
      // absorbs the key equivalent, so the menu item is silent and the tab
      // wouldn't close (the shortcut did not close an open file). Handling
      // it here closes the tab before the key escapes to WebKit; preventDefault
      // also lets the non-mac window fallback skip it (it ignores handled events).
      { key: "Mod-w", preventDefault: true, run: () => (closeActiveTab(), true) },
      // ...and the same reason puts undo/redo HERE rather than trusting the native
      // Edit menu (`src-tauri/src/menu.rs`, which binds Cmd+Z to `.undo()`).
      // The empirically-observed rule: a focused `contenteditable`
      // swallows the key equivalent, so the menu item stays silent and the key
      // reaches WebKit's own shallow undo instead. `historyKeymap` binds
      // Mod-z/Mod-y (mac: Mod-Shift-z) with preventDefault, so CM6 wins the key
      // before it can escape. Do NOT "fix" this by editing menu.rs — that Edit
      // menu is still what gives the app's plain <input>s their undo.
      // BEFORE defaultKeymap so nothing downstream can shadow it.
      ...historyKeymap,
      ...defaultKeymap,
    ]),
    // The other half of the same fix, for the path a keymap cannot see.
    //
    // If Cmd+Z ever arrives as a native EDIT-MENU undo rather than as a keydown
    // (menu.rs binds `.undo()`; whether the accelerator or the focused webview
    // wins on macOS is genuinely contested — menu.rs's own comment claims the
    // menu, the opposite has been observed for Cmd+W in this exact stack),
    // WebKit performs its own contenteditable undo and mutates the DOM behind
    // CodeMirror's back. CM6's DOM observer then reads the mangled DOM back in
    // as if the user had typed it — which is precisely the flaky
    // two-step undo. CM6 does NOT handle these input types itself (there is
    // no `historyUndo` anywhere in @codemirror/view), so map them onto the real
    // history commands here. Cheap, and it closes the hypothesis we cannot
    // settle with a test. Do NOT delete this as redundant with the keymap above:
    // the two cover different delivery paths for the same keystroke.
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

  // Reopening a file the user closed: pick the undo stack back up, but ONLY when
  // the text on disk is byte-for-byte what it was at close time (see
  // undoHistory.ts — history events are document POSITIONS, so replaying them
  // onto a file an agent rewrote would splice text at the wrong offsets). A
  // read-only entry never had an editable history to park. A buffer arriving from
  // another window brings its own stack instead (already checked against `text`).
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

/**
 * Rebuild a state (doc + selection + undo stack) from its JSON, or `null` to start fresh.
 * A JSON that will not load is a lost undo stack, never a buffer that fails to open — the
 * text itself is always in hand. (A parked stack is this realm's own and always loads; a
 * stack carried from another window is the one that could, in principle, not.)
 */
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
    // 🔴 Not a no-op, even with no buffer to tear down. A RASTER image tab
    // deliberately never calls `ensureEditor` — `read_file` rejects a PNG
    // as "binary file" — so it has a store slice and no `Entry`. Returning here
    // before the drop below leaked `editors[path]` on every close, and a reopen
    // would then inherit the previous tab's zoom. `disposeEditor` is a plain
    // `delete`, so calling it for a path that has no slice is free.
    editorActions().disposeEditor(path);
    return;
  }
  if (entry.rehighlightTimer) clearTimeout(entry.rehighlightTimer);
  // A close must not silently throw the undo stack away (undo must work even
  // after a save or a close). Park it BEFORE destroy() — the history lives inside the
  // view's state and goes with it. `detach()` deliberately does NOT do this: a
  // detached view stays alive and keeps its own history, so snapshotting there
  // would only park a stack that is still in use.
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

/* ──────────────── tab tear-off: a buffer leaves / arrives ────────────────
 * docs/design/tab-tearoff.md §3: every window is its own realm, so an editor moving to
 * another window has to carry its buffer — re-reading the file there would silently drop
 * the user's unsaved edits. These three are that crossing; `app/tearoff` drives them.
 */

/**
 * Describe `path`'s buffer for another window: its text, the baseline the dirty flag
 * compares against, the disk stamp, the stale flag and — with `history` — the selection and
 * undo stack as CodeMirror state JSON. `null` while the file is still loading (no view yet):
 * there are no edits to carry, and the receiver reads the file itself.
 */
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

/**
 * Build `path`'s editor from a buffer that arrived from another window, instead of reading
 * the file — the receiving half of `exportEditor`. Call BEFORE the tab exists, so the
 * `<CodeEditor>` that mounts for it finds a ready buffer (`ensureEditor` keeps an entry that
 * has its slice). Replaces any orphan buffer this window had for the path.
 *
 * The carried undo stack is used only if it describes exactly `text` — history events are
 * document positions (undoHistory.ts), so a stack replayed onto other text would splice at
 * the wrong offsets; one that does not match, or does not parse, is dropped and the buffer
 * starts with an empty history. The dirty flag needs the tab: the caller sets it after.
 */
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

/**
 * Tear this window's buffer for `path` down WITHOUT parking its undo stack — the stack went
 * with the tab to another window (`dispose` parks it for a reopen here, which would hand a
 * second, stale copy of the same history to a later tab in this window).
 */
export function abandon(path: string): void {
  const entry = entries.get(path);
  if (entry) {
    if (entry.rehighlightTimer) clearTimeout(entry.rehighlightTimer);
    entry.view?.destroy();
    entries.delete(path);
  }
  editorActions().disposeEditor(path);
}

/**
 * Show `text` in `path`'s EXISTING buffer — an editor tab arrived from another window for a
 * file this window already has open, and `app/tearoff/handoff.ts` decided its text wins.
 * Applied as an ordinary transaction, like `reloadFromDisk`: what the buffer held stays in
 * its undo history, one Cmd/Ctrl+Z away, so neither copy is thrown away. Baseline and stamp
 * stay this window's (its disk watcher is the current one here), and the dirty flag follows
 * from them through `onDocChanged`. Waits for a buffer still loading. Resolves whether the
 * text changed.
 */
export async function applyCarriedText(path: string, text: string): Promise<boolean> {
  const view = await whenViewReady(path);
  // The tab may have closed (or closed and reopened) while the buffer loaded.
  if (!view || entries.get(path)?.view !== view) return false;
  if (view.state.doc.toString() === text) return false;
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
  return true;
}

/**
 * Be told about every edit to any buffer in this window (tab tear-off's holdings report
 * follows unsaved text with it, so a crashed window loses at most the last debounce).
 * Returns the unsubscribe.
 */
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

/**
 * Re-read `path` from disk into its open buffer — for when something OUTSIDE the
 * editor rewrote the file. The first caller is a confirmed `Git ▸ Revert changes…`:
 * without this the tab would keep showing the content the user just threw away.
 *
 * Applied as a NORMAL CM6 transaction rather than a fresh state, deliberately: the
 * replacement lands in the undo history, so Cmd/Ctrl+Z takes the user's edits back
 * even after a revert discarded them on disk — the editor's undo stack outlives a
 * destructive git operation, which is the behaviour IntelliJ has and the reason a
 * rollback there is not terrifying.
 *
 * No-op when the buffer already matches disk (reverting a file with no working-tree
 * changes), so a refresh can never dirty a tab or push a bogus undo step. A read
 * failure leaves the buffer untouched: a stale-but-real buffer beats a blanked one.
 */
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

/**
 * The current buffer text for `path` — the live document, so it reflects unsaved
 * edits (the markdown/CSV rendered preview reads this when toggled on). Returns
 * null when no view exists yet (still loading), which the caller renders as a
 * loading state. Reads through the same `state.doc` the editor and `save` use, so
 * the preview can never disagree with what would be saved.
 */
export function currentText(path: string): string | null {
  const view = entries.get(path)?.view;
  return view ? view.state.doc.toString() : null;
}

/**
 * Ensure the editor for `path` exists and resolve its view once loaded — the
 * backing of `Workspace.displayFile` (cross-file go-to-definition). Resolves null
 * if the file never loads within `timeoutMs`.
 */
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

/**
 * The root the server for this FILE should index.
 * Rust asks `lsp_project_root` — the outermost `Cargo.toml` ancestor bounded
 * by the file's own workspace root, so a crate in a subfolder (`src-tauri/`,
 * `crates/api/`) and a cargo workspace both resolve correctly, and a file from
 * project B never gets a server rooted at project A. If the command fails
 * (path raced out of scope), fall back to the file's CONTAINING workspace
 * root, then to the old primary-root behavior, so intelligence degrades
 * rather than disappears.
 */
async function lspRootFor(languageId: string, path: string): Promise<string | null> {
  const s = useAppStore.getState();
  const containing = containingWorkspaceRoot(workspaceRoots(s), path);
  try {
    return await lspProjectRoot(languageId, path);
  } catch {
    return containing ?? s.workspaceRoot;
  }
}

/**
 * The longest workspace root that PREFIXES `path` (path-segment-wise), or null. Either
 * separator, and case-insensitive for Windows paths — this was `root + "/"`, which no
 * `C:\repo\src\x.rs` ever started with, so on Windows the fallback never found a root.
 */
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
  // Main window only (tab tear-off): every window is its own JS realm, so a client here would
  // start a SECOND server process for a root the main window may already be indexing — a
  // second rust-analyzer, at its full memory cost. A detached editor edits, saves and
  // highlights; go-to-definition stays with the main window until Rust shares one server
  // per (language, root) across windows (recorded in the tear-off ADR).
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

/**
 * Dispose every live view — for test isolation (this module is a singleton).
 *
 * The undo cache is a singleton too, and `dispose` fills it, so this clears it
 * afterwards: without that, a snapshot parked by one test would be handed to the
 * next test that happens to open the same path with the same text. A test that
 * means to exercise close→reopen must therefore call `dispose(path)`, not this.
 */
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
