/** Load-bearing: an outside rewrite (e.g. a confirmed Git revert) is dispatched into CM6 history,
 * so Cmd/Ctrl+Z takes the user's work back. Real registry, store and `EditorView`; only IPC is
 * mocked. */

import { render, waitFor } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { isolateHistory, undoDepth } from "@codemirror/commands";
import type { EditorView } from "@codemirror/view";

import { useAppStore } from "../../app/store";
import type { TabId } from "../../app/types";
import { installTauriMock, type TauriMock } from "../../test/tauri-mock";
import { resetStore } from "../../test/store-harness";
import { CodeEditor } from "./CodeEditor";
import { disposeAll, getView, reloadFromDisk, save } from "./EditorRegistry";
import { stubGeometry } from "./find/cmTestKit";

const PATH = "/w/notes.txt"; // .txt → plaintext → no Shiki timer in the way
const COMMITTED = "hello\n";

const MAC = /Mac/.test(navigator.platform);
const UNDO_MODS = MAC ? { meta: true } : { ctrl: true };

const status = (path = PATH) => useAppStore.getState().editors[path]?.status;
const tabDirty = (path = PATH) =>
  Object.values(useAppStore.getState().tabs).some(
    (t) => t.ref.kind === "editor" && t.ref.path === path && Boolean(t.dirty),
  );
const docOf = (view: EditorView) => view.state.doc.toString();

/** The real Cmd/Ctrl+Z, through the real keymap. */
function pressUndo(view: EditorView): void {
  const event = new KeyboardEvent("keydown", {
    key: "z",
    ctrlKey: Boolean((UNDO_MODS as { ctrl?: boolean }).ctrl),
    metaKey: Boolean((UNDO_MODS as { meta?: boolean }).meta),
    bubbles: true,
    cancelable: true,
  });
  act(() => void view.contentDOM.dispatchEvent(event));
}

/** One separately-undoable edit (CM6 would otherwise coalesce inside 500 ms). */
const edit = (view: EditorView, insert: string) =>
  act(() =>
    view.dispatch({
      changes: { from: view.state.doc.length, insert },
      userEvent: "input.type",
      annotations: isolateHistory.of("full"),
    }),
  );

describe("reloadFromDisk", () => {
  let ipc: TauriMock;
  /** The mocked filesystem. A "git revert" is a write to this map. */
  let disk: Record<string, string>;
  /** Set to make the next `read_file` reject, for the failure path. */
  let readFails: boolean;

  beforeAll(() => stubGeometry());

  beforeEach(() => {
    disposeAll();
    resetStore();
    disk = { [PATH]: COMMITTED };
    readFails = false;
    ipc = installTauriMock();
    ipc.handle("read_file", (args) => {
      if (readFails) throw new Error("path does not exist");
      return disk[args.path as string] ?? "";
    });
    ipc.handle("write_file", (args) => {
      disk[args.path as string] = args.content as string;
      return null;
    });
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
    render(<CodeEditor path={path} />);
    await waitFor(() => expect(status(path)).toBe("ready"));
    return { tabId, view: getView(path) as EditorView };
  };

  /** Let the in-flight `read_file` promise resolve and its `.then` run. */
  const settle = async () => {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  it("pulls an outside rewrite into the buffer and leaves the tab CLEAN", async () => {
    const { view } = await openAndLoad();
    edit(view, "my work");
    // The save moves `entry.baseline` off the committed text, so a late baseline update would show
    // as a falsely dirty tab.
    await act(async () => {
      await save(PATH);
    });
    expect(disk[PATH]).toBe("hello\nmy work");
    expect(tabDirty()).toBe(false);

    // A "git revert": the committed content goes back on disk behind our back.
    disk[PATH] = COMMITTED;
    reloadFromDisk(PATH);
    await settle();

    // Two-sided: the buffer really changed, AND the tab is clean —
    // the reverted content IS what is on disk, so a dirty dot here would be a lie.
    expect(docOf(view)).toBe(COMMITTED);
    expect(tabDirty()).toBe(false);
  });

  it("makes the revert UNDOABLE — Cmd/Ctrl+Z gives the discarded work back", async () => {
    const { view } = await openAndLoad();
    edit(view, "my unsaved work");
    const edited = docOf(view);

    disk[PATH] = COMMITTED;
    reloadFromDisk(PATH);
    await settle();
    expect(docOf(view)).toBe(COMMITTED); // the revert landed…

    pressUndo(view);
    expect(docOf(view)).toBe(edited); // …and one Ctrl+Z takes it back
    // Back to unsaved work, so the tab must say so — otherwise the user would
    // close the tab believing the recovered text was already on disk.
    expect(tabDirty()).toBe(true);
  });

  it("is a NO-OP when the buffer already matches disk — no bogus undo step", async () => {
    const { view } = await openAndLoad();
    const before = undoDepth(view.state);

    // Reverting a file with no working-tree changes: git rewrites nothing.
    reloadFromDisk(PATH);
    await settle();

    expect(docOf(view)).toBe(COMMITTED);
    expect(undoDepth(view.state)).toBe(before);
    expect(tabDirty()).toBe(false);
  });

  it("leaves the buffer untouched when the read FAILS", async () => {
    const { view } = await openAndLoad();
    edit(view, "my unsaved work");
    const edited = docOf(view);

    readFails = true;
    reloadFromDisk(PATH);
    await settle();

    // A stale-but-real buffer beats a blanked one.
    expect(docOf(view)).toBe(edited);
    expect(tabDirty()).toBe(true);
  });

  it("does nothing for a path with no open editor, and does not throw", async () => {
    await openAndLoad();
    expect(() => reloadFromDisk("/w/never-opened.txt")).not.toThrow();
    await settle();
  });

  it("drops the reload when the tab is disposed while the read is in flight", async () => {
    const { view } = await openAndLoad();
    edit(view, "my unsaved work");

    const doomed = docOf(view);
    disk[PATH] = COMMITTED;
    reloadFromDisk(PATH);
    disposeAll(); // the tab closes before `read_file` resolves
    await settle();

    expect(getView(PATH)).toBeNull();
    // CM6 ignores a dispatch on a destroyed view silently, so assert content: the entry-identity
    // guard must stop the late resolve from rewriting a doc nobody owns.
    expect(docOf(view)).toBe(doomed);
  });
});
