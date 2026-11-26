/** A torn-off editor must carry its buffer: re-reading the file in the new window drops unsaved
 * edits (docs/design/tab-tearoff.md §3). Real registry, store, view and JSON hand-off; only IPC
 * is mocked, and the source buffer is gone before the destination's is built. */

import { render, waitFor } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { isolateHistory } from "@codemirror/commands";
import type { EditorView } from "@codemirror/view";

import { useAppStore } from "../../app/store";
import type { EditorBuffer, TornTab } from "../../app/tearoff/contract";
import { adoptTornTabs, describeTab, releaseTab } from "../../app/tearoff/handoff";
import type { TabId } from "../../app/types";
import { resetStore } from "../../test/store-harness";
import { installTauriMock, type TauriMock } from "../../test/tauri-mock";
import { CodeEditor } from "./CodeEditor";
import {
  applyCarriedText,
  disposeAll,
  exportEditor,
  getView,
  onEditorEdit,
  seedEditor,
} from "./EditorRegistry";
import { stubGeometry } from "./find/cmTestKit";
import { undoCacheSize } from "./undoHistory";

const PATH = "/w/notes.txt"; // plaintext → no Shiki timer in the way
const ON_DISK = "hello\n";
const MAC = /Mac/.test(navigator.platform);

const tabDirty = (path = PATH) =>
  Object.values(useAppStore.getState().tabs).some(
    (t) => t.ref.kind === "editor" && t.ref.path === path && Boolean(t.dirty),
  );
const docOf = (view: EditorView) => view.state.doc.toString();

function pressUndo(view: EditorView): void {
  const event = new KeyboardEvent("keydown", {
    key: "z",
    ctrlKey: !MAC,
    metaKey: MAC,
    bubbles: true,
    cancelable: true,
  });
  act(() => void view.contentDOM.dispatchEvent(event));
}

/** One separately-undoable edit. */
const edit = (view: EditorView, insert: string) =>
  act(() =>
    view.dispatch({
      changes: { from: view.state.doc.length, insert },
      userEvent: "input.type",
      annotations: isolateHistory.of("full"),
    }),
  );

function asWindow(label: string): void {
  (window as unknown as { __TAURI_INTERNALS__: { metadata?: unknown } }).__TAURI_INTERNALS__.metadata = {
    currentWindow: { label },
  };
}

describe("an editor crossing windows", () => {
  let ipc: TauriMock;
  let disk: Record<string, string>;

  beforeAll(() => stubGeometry());

  beforeEach(() => {
    disposeAll();
    resetStore();
    disk = { [PATH]: ON_DISK };
    ipc = installTauriMock();
    ipc
      .handle("read_file", (args) => disk[args.path as string] ?? "")
      .handle("write_file", (args) => {
        disk[args.path as string] = args.content as string;
        return null;
      })
      .handle("file_stamps", (args) => (args.paths as string[]).map(() => ({ mtimeMs: 7, size: 6 })))
      .handle("layout_prefs_save", () => null);
  });
  afterEach(() => {
    ipc.reset();
    disposeAll();
  });

  const openAndLoad = async (path = PATH) => {
    let tabId!: TabId;
    act(() => {
      tabId = useAppStore.getState().layoutActions.openEditorTab(path);
    });
    const view = render(<CodeEditor path={path} />);
    await waitFor(() => expect(useAppStore.getState().editors[path]?.status).toBe("ready"));
    return { tabId, view: getView(path) as EditorView, unmount: view.unmount };
  };

  it("arrives with its unsaved text, dirty flag, baseline AND undo stack — without reading the file", async () => {
    const { tabId, view, unmount } = await openAndLoad();
    edit(view, "A");
    edit(view, "B");
    expect(tabDirty()).toBe(true);

    const torn = describeTab(tabId) as Extract<TornTab, { kind: "editor" }>;
    expect(torn.buffer).toMatchObject({ text: "hello\nAB", baseline: ON_DISK, stale: false });
    expect(JSON.parse(torn.buffer?.state as string).doc).toBe("hello\nAB");

    // Leave: this window's buffer goes — and its undo stack is NOT parked here, because it
    // is travelling with the tab (a parked copy would be a second, stale history).
    const parked = undoCacheSize();
    act(() => releaseTab(tabId, torn));
    unmount();
    expect(getView(PATH)).toBeNull();
    expect(useAppStore.getState().editors[PATH]).toBeUndefined();
    expect(undoCacheSize()).toBe(parked);

    // Arrive, from exactly what crosses the IPC boundary.
    const reads = ipc.calls("read_file").length;
    const wire = JSON.parse(JSON.stringify(torn)) as TornTab;
    act(() => void adoptTornTabs([wire]));
    render(<CodeEditor path={PATH} />);
    const arrived = getView(PATH) as EditorView;
    expect(docOf(arrived)).toBe("hello\nAB");
    expect(tabDirty()).toBe(true);
    expect(ipc.calls("read_file"), "the file was not re-read").toHaveLength(reads);

    // The undo stack came too: two steps back is the file as it is on disk — and clean.
    pressUndo(arrived);
    expect(docOf(arrived)).toBe("hello\nA");
    pressUndo(arrived);
    expect(docOf(arrived)).toBe(ON_DISK);
    expect(tabDirty()).toBe(false);
  });

  it("a buffer that was still loading arrives as nothing — the receiver reads the file", async () => {
    let release!: (text: string) => void;
    ipc.handle("read_file", () => new Promise<string>((r) => (release = r)));
    let tabId!: TabId;
    act(() => {
      tabId = useAppStore.getState().layoutActions.openEditorTab(PATH);
    });
    render(<CodeEditor path={PATH} />);
    expect(exportEditor(PATH, { history: true })).toBeNull();
    expect(describeTab(tabId)).toMatchObject({ kind: "editor", buffer: null });
    release(ON_DISK);
  });

  it("drops a carried undo stack that does not describe the text — never splices at wrong offsets", () => {
    const buffer: EditorBuffer = {
      text: "fresh text",
      baseline: "fresh",
      state: JSON.stringify({ doc: "some OTHER text", selection: { ranges: [{ anchor: 0, head: 0 }], main: 0 } }),
      stamp: { mtimeMs: 1, size: 5 },
      stale: false,
    };
    seedEditor(PATH, buffer);
    const view = getView(PATH) as EditorView;
    expect(docOf(view)).toBe("fresh text");
    pressUndo(view);
    expect(docOf(view), "no history to undo into").toBe("fresh text");
  });

  it("opens the text even when the carried state will not load at all", () => {
    seedEditor(PATH, { text: "kept", baseline: "kept", state: "{not json", stamp: null, stale: false });
    expect(docOf(getView(PATH) as EditorView)).toBe("kept");
    // A state that parses and matches the text but is not a CodeMirror state is dropped too.
    seedEditor(PATH, { text: "kept", baseline: "kept", state: '{"doc":"kept","history":42}', stamp: null, stale: false });
    expect(docOf(getView(PATH) as EditorView)).toBe("kept");
  });

  it("keeps the stale flag, and takes a disk stamp when none came with the buffer", async () => {
    seedEditor(PATH, { text: "x", baseline: "x", state: null, stamp: null, stale: true });
    expect(useAppStore.getState().editors[PATH]?.staleOnDisk).toBe(true);
    await waitFor(() => expect(ipc.calls("file_stamps")).toHaveLength(1));
    // With a carried stamp, the watcher compares against it — no fresh stamp is taken.
    disposeAll();
    seedEditor(PATH, { text: "x", baseline: "x", state: null, stamp: { mtimeMs: 3, size: 1 }, stale: false });
    expect(exportEditor(PATH, { history: false })?.stamp).toEqual({ mtimeMs: 3, size: 1 });
    expect(ipc.calls("file_stamps")).toHaveLength(1);
  });

  it("exports text only (no undo stack) for the periodic holdings report", async () => {
    const { view } = await openAndLoad();
    edit(view, "Z");
    expect(exportEditor(PATH, { history: false })).toMatchObject({ text: "hello\nZ", state: null });
  });

  /** An editor arriving from another window with unsaved edits, exactly as it crosses. */
  const arriving = (text: string): TornTab =>
    JSON.parse(
      JSON.stringify({
        kind: "editor",
        path: PATH,
        title: "notes.txt",
        customTitle: null,
        buffer: { text, baseline: ON_DISK, state: null, stamp: null, stale: false },
      }),
    ) as TornTab;

  it("arriving where the file is already open (clean): the carried edits are shown, not dropped", async () => {
    // The review's repro: the file was re-opened here (read from disk) while a detached
    // window held it with unsaved edits; that window then closed and handed everything back.
    const { tabId, view } = await openAndLoad();
    let ids!: TabId[];
    act(() => void (ids = adoptTornTabs([arriving("hello\nfrom the other window")])));
    expect(ids, "still one tab for the path").toEqual([tabId]);
    await waitFor(() => expect(docOf(view)).toBe("hello\nfrom the other window"));
    expect(tabDirty()).toBe(true);
    // What was here is one undo away — and it was the file as saved, so: clean again.
    pressUndo(view);
    expect(docOf(view)).toBe(ON_DISK);
    expect(tabDirty()).toBe(false);
  });

  it("arriving where the file has OTHER unsaved edits: the arriving copy shows, undo has this one", async () => {
    const { view } = await openAndLoad();
    edit(view, "local");
    act(() => void adoptTornTabs([arriving("hello\nremote")]));
    await waitFor(() => expect(docOf(view)).toBe("hello\nremote"));
    pressUndo(view);
    expect(docOf(view), "neither copy of unsaved text is lost").toBe("hello\nlocal");
    expect(tabDirty()).toBe(true);
  });

  it("applyCarriedText loads a buffer that was never shown, and is a no-op for the same text", async () => {
    act(() => void useAppStore.getState().layoutActions.openEditorTab(PATH));
    // No <CodeEditor> mounted: no buffer yet. It is loaded, then given the text.
    await expect(applyCarriedText(PATH, "hello\ncarried")).resolves.toBe(true);
    expect(docOf(getView(PATH) as EditorView)).toBe("hello\ncarried");
    await expect(applyCarriedText(PATH, "hello\ncarried")).resolves.toBe(false);
  });

  it("tells a listener about every edit, until it unsubscribes", async () => {
    const { view } = await openAndLoad();
    const seen: string[] = [];
    const off = onEditorEdit((path) => seen.push(path));
    edit(view, "1");
    off();
    edit(view, "2");
    expect(seen).toEqual([PATH]);
  });
});

describe("code intelligence stays with the main window", () => {
  // Every window is its own realm: an LSP client in a detached one would start a SECOND
  // language server for a root the main window may already be indexing.
  let ipc: TauriMock;
  beforeAll(() => stubGeometry());
  beforeEach(() => {
    disposeAll();
    resetStore();
    ipc = installTauriMock();
    ipc.handle("read_file", () => "fn main() {}\n").handle("file_stamps", () => [null]);
    // `lsp_project_root` is deliberately NOT handled: the main window's call rejects, and the
    // registry's own fallback then finds no root — so the call itself is the observable.
  });
  afterEach(() => {
    ipc.reset();
    disposeAll();
  });

  const open = async () => {
    act(() => void useAppStore.getState().layoutActions.openEditorTab("/w/main.rs"));
    render(<CodeEditor path="/w/main.rs" />);
    await waitFor(() => expect(useAppStore.getState().editors["/w/main.rs"]?.status).toBe("ready"));
    await act(async () => {
      await Promise.resolve();
    });
  };

  it("the main window asks for a Rust file's project root", async () => {
    await open();
    expect(ipc.calls("lsp_project_root")).toHaveLength(1);
  });

  it("a detached window never starts a client for it", async () => {
    asWindow("tearoff-1");
    await open();
    expect(ipc.calls("lsp_project_root")).toHaveLength(0);
  });
});
