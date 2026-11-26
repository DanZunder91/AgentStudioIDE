/** Undo across save and close with the real registry, store and `EditorView` (only IPC mocked).
 * Real keydown events: CM6's keymap must see the key, not WebKit's native undo. Covers save, the
 * `savedAt` blame reconfigure, and the dispose→reopen history carry. */

import { render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { isolateHistory, undoDepth } from "@codemirror/commands";
import { StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { useAppStore } from "../../app/store";
import type { TabId } from "../../app/types";
import { installTauriMock, type TauriMock } from "../../test/tauri-mock";
import { resetStore } from "../../test/store-harness";
import { CodeEditor } from "./CodeEditor";
import { dispose, disposeAll, getView, save } from "./EditorRegistry";
import { stubGeometry } from "./find/cmTestKit";
import { undoCacheSize } from "./undoHistory";

const PATH = "/w/notes.txt"; // .txt → plaintext → no Shiki timer in the way
const ORIGINAL = "hello\n";

/** The `Mod-` modifier, computed as CM6 does (`/Mac/.test(navigator.platform)`). */
const MAC = /Mac/.test(navigator.platform);
const UNDO_MODS = MAC ? { meta: true } : { ctrl: true };

const status = (path = PATH) => useAppStore.getState().editors[path]?.status;
const tabDirty = (path = PATH) =>
  Object.values(useAppStore.getState().tabs).some(
    (t) => t.ref.kind === "editor" && t.ref.path === path && Boolean(t.dirty),
  );
const docOf = (view: EditorView) => view.state.doc.toString();

/** Dispatch a keydown exactly as the browser would (bubbling + cancelable). */
function press(
  target: EventTarget,
  key: string,
  mods: { ctrl?: boolean; shift?: boolean; meta?: boolean },
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    ctrlKey: !!mods.ctrl,
    shiftKey: !!mods.shift,
    metaKey: !!mods.meta,
    bubbles: true,
    cancelable: true,
  });
  act(() => void target.dispatchEvent(event));
  return event;
}

/** The real Cmd/Ctrl+Z, through the real keymap. Returns the event (for preventDefault). */
const pressUndo = (view: EditorView) => press(view.contentDOM, "z", UNDO_MODS);

/** The redo chord: `Mod-y`, overridden to `Mod-Shift-z` on macOS. */
const pressRedo = (view: EditorView) =>
  MAC
    ? press(view.contentDOM, "z", { meta: true, shift: true })
    : press(view.contentDOM, "y", { ctrl: true });

/** One separately undoable edit: `isolateHistory` stops CM6's 500 ms grouping from merging them. */
const edit = (view: EditorView, insert: string) =>
  act(() =>
    view.dispatch({
      changes: { from: view.state.doc.length, insert },
      userEvent: "input.type",
      annotations: isolateHistory.of("full"),
    }),
  );

/** Counts reconfigure transactions (what `blameCompartment.reconfigure()` dispatches); zeroed
 * after the listener's own reconfigure lands. */
function watchReconfigures(view: EditorView): { count: number } {
  const seen = { count: 0 };
  act(() =>
    view.dispatch({
      effects: StateEffect.appendConfig.of(
        EditorView.updateListener.of((u) => {
          if (u.transactions.some((tr) => tr.reconfigured)) seen.count += 1;
        }),
      ),
    }),
  );
  seen.count = 0;
  return seen;
}

describe("undo across save and close", () => {
  let ipc: TauriMock;
  /** The mocked filesystem — `write_file` updates it, so a reopen re-reads it. */
  let disk: Record<string, string>;

  beforeAll(() => stubGeometry());

  beforeEach(() => {
    disposeAll(); // module singletons: the registry AND the undo cache
    resetStore();
    disk = { [PATH]: ORIGINAL };
    ipc = installTauriMock();
    ipc.handle("read_file", (args) => disk[args.path as string] ?? "");
    ipc.handle("write_file", (args) => {
      disk[args.path as string] = args.content as string;
      return null;
    });
  });
  afterEach(() => {
    ipc.reset();
    disposeAll();
  });

  /** Open the tab, mount the editor, and wait for the disk read to land. */
  const openAndLoad = async (path = PATH) => {
    let tabId!: TabId;
    act(() => {
      tabId = useAppStore.getState().layoutActions.openEditorTab(path);
    });
    const rendered = render(<CodeEditor path={path} />);
    await waitFor(() => expect(status(path)).toBe("ready"));
    return { tabId, rendered, view: getView(path) as EditorView };
  };

  const saveNow = async (path = PATH) => {
    await act(async () => {
      await save(path);
    });
  };

  // ── The headline: undo AFTER a save ────────────────────────────────────────
  it("Cmd/Ctrl+Z after a save restores the pre-edit text, and the buffer goes dirty again", async () => {
    const { view } = await openAndLoad();

    edit(view, "EDIT");
    expect(tabDirty()).toBe(true);
    await saveNow();
    expect(disk[PATH]).toBe("hello\nEDIT"); // it really reached "disk"
    expect(tabDirty()).toBe(false);

    // Two-sided: the doc BEFORE the undo is the edited text…
    expect(docOf(view)).toBe("hello\nEDIT");
    const event = pressUndo(view);
    // …and AFTER it is the original. A one-sided "it's the original now" would
    // pass against a buffer that had never been edited at all.
    expect(docOf(view)).toBe(ORIGINAL);

    // The key was CONSUMED by CodeMirror. This is the actual defect: without a
    // CM6 binding the keystroke escapes to WebKit's own shallow undo stack
    // (the contenteditable eats the native Edit-menu equivalent).
    expect(event.defaultPrevented).toBe(true);

    // Undoing past the save leaves the buffer differing from what is on disk —
    // so the dirty dot comes back, which is what the user would expect to see.
    await waitFor(() => expect(tabDirty()).toBe(true));
  });

  it("save() does not touch the document — the history is intact across it", async () => {
    const { view } = await openAndLoad();
    edit(view, "one ");
    edit(view, "two ");
    expect(undoDepth(view.state)).toBe(2);

    await saveNow();

    expect(undoDepth(view.state)).toBe(2); // depth unchanged by the write
    expect(docOf(view)).toBe("hello\none two ");
  });

  // ── The two-step-undo regression guard ─────────────────────────────────────
  it("gives back ALL 20 separately-grouped edits after a save — not just two", async () => {
    const { view } = await openAndLoad();

    for (let i = 0; i < 20; i++) edit(view, `e${i} `);
    const edited = docOf(view);
    expect(edited).not.toBe(ORIGINAL);
    expect(undoDepth(view.state)).toBe(20);

    await saveNow();
    expect(undoDepth(view.state)).toBe(20); // the save cost us nothing

    // 19 presses must NOT be enough — that pins the exact count rather than
    // "more than one", which is what the broken build already managed.
    for (let i = 0; i < 19; i++) pressUndo(view);
    expect(docOf(view)).not.toBe(ORIGINAL);

    pressUndo(view); // the 20th
    expect(docOf(view)).toBe(ORIGINAL);
    expect(undoDepth(view.state)).toBe(0);
  });

  it("redo re-applies what undo took back", async () => {
    const { view } = await openAndLoad();
    edit(view, "EDIT");
    await saveNow();

    pressUndo(view);
    expect(docOf(view)).toBe(ORIGINAL);

    const event = pressRedo(view);

    expect(docOf(view)).toBe("hello\nEDIT");
    expect(event.defaultPrevented).toBe(true);
  });

  // ── The OTHER delivery path for the same keystroke ─────────────────────────
  describe("a native Edit-menu undo (beforeinput)", () => {
    /** WebKit's Edit-menu Undo on a focused contenteditable, which no CM6 keymap sees; left alone,
     * WebKit mutates the DOM and CodeMirror reads it back as typing. */
    const nativeInput = (view: EditorView, inputType: string) => {
      const event = new InputEvent("beforeinput", {
        inputType,
        bubbles: true,
        cancelable: true,
      });
      act(() => void view.contentDOM.dispatchEvent(event));
      return event;
    };

    it("maps historyUndo onto CodeMirror's own undo, and blocks WebKit's", async () => {
      const { view } = await openAndLoad();
      edit(view, "EDIT");
      await saveNow();
      expect(docOf(view)).toBe("hello\nEDIT");

      const event = nativeInput(view, "historyUndo");

      expect(docOf(view)).toBe(ORIGINAL);
      // preventDefault is the half that matters: without it CodeMirror would undo
      // AND WebKit would undo, on the same keystroke.
      expect(event.defaultPrevented).toBe(true);
    });

    it("maps historyRedo onto CodeMirror's own redo", async () => {
      const { view } = await openAndLoad();
      edit(view, "EDIT");
      nativeInput(view, "historyUndo");
      expect(docOf(view)).toBe(ORIGINAL);

      const event = nativeInput(view, "historyRedo");

      expect(docOf(view)).toBe("hello\nEDIT");
      expect(event.defaultPrevented).toBe(true);
    });

    it("leaves every other inputType alone (the handler is not a catch-all)", async () => {
      const { view } = await openAndLoad();
      edit(view, "EDIT");
      const depth = undoDepth(view.state);

      const event = nativeInput(view, "insertText");

      // Two-sided: a handler that returned true for everything
      // would pass the two tests above and silently break ordinary typing, so
      // the untouched case is asserted explicitly.
      expect(event.defaultPrevented).toBe(false);
      expect(docOf(view)).toBe("hello\nEDIT");
      expect(undoDepth(view.state)).toBe(depth);
    });
  });

  // ── The seam the mocked-registry suite cannot see ────────────
  it("survives the blame RECONFIGURE that every save triggers in <CodeEditor>", async () => {
    // The `savedAt` blame effect reconfigures `blameCompartment` on every save; a history inside
    // that compartment would be wiped there.
    const { view, rendered } = await openAndLoad();
    edit(view, "EDIT");
    const reconfigures = watchReconfigures(view);
    expect(undoDepth(view.state)).toBe(1);

    // Save through the REAL header button — the user's path, and the only one
    // that runs React's effect.
    await userEvent.setup().click(await rendered.findByRole("button", { name: "Save" }));
    await waitFor(() => expect(reconfigures.count).toBeGreaterThan(0));

    expect(undoDepth(view.state)).toBe(1); // the reconfigure did NOT wipe it
    expect(docOf(view)).toBe("hello\nEDIT");
    pressUndo(view);
    expect(docOf(view)).toBe(ORIGINAL);
  });

  // ── Undo across a CLOSE ────────────────────────────────────────────────────
  it("carries the undo stack across close → reopen when the file is unchanged on disk", async () => {
    const { rendered, view } = await openAndLoad();
    edit(view, "one ");
    edit(view, "two ");
    await saveNow(); // disk now holds the edited text

    rendered.unmount(); // switch away — the tab still exists, view preserved
    act(() => dispose(PATH)); // …now CLOSE it (dispose, not disposeAll)
    expect(getView(PATH)).toBeNull();
    expect(undoCacheSize()).toBe(1); // the stack was parked, not destroyed

    const reopened = await openAndLoad();
    expect(docOf(reopened.view)).toBe("hello\none two "); // re-read from disk
    expect(undoCacheSize()).toBe(0); // …and the snapshot consumed
    expect(undoDepth(reopened.view.state)).toBe(2);

    pressUndo(reopened.view);
    expect(docOf(reopened.view)).toBe("hello\none ");
    pressUndo(reopened.view);
    expect(docOf(reopened.view)).toBe(ORIGINAL);
  });

  it("DROPS the stack when the file changed on disk while it was closed", async () => {
    const { rendered, view } = await openAndLoad();
    edit(view, "mine ");
    await saveNow();

    rendered.unmount();
    act(() => dispose(PATH));
    expect(undoCacheSize()).toBe(1);

    // An agent (or git, or another editor) rewrites the file while it is closed.
    // Replaying position-based history events onto this text would splice at the
    // wrong offsets, so the stack must be discarded — silently and completely.
    disk[PATH] = "rewritten by an agent\n";
    const reopened = await openAndLoad();

    expect(docOf(reopened.view)).toBe("rewritten by an agent\n");
    expect(undoDepth(reopened.view.state)).toBe(0);
    expect(undoCacheSize()).toBe(0); // consumed even though it was rejected

    pressUndo(reopened.view);
    expect(docOf(reopened.view)).toBe("rewritten by an agent\n"); // NOT corrupted
  });

  it("a second reopen after a restore starts clean (the snapshot is consumed once)", async () => {
    const first = await openAndLoad();
    edit(first.view, "EDIT");
    await saveNow();
    first.rendered.unmount();
    act(() => dispose(PATH));

    const second = await openAndLoad(); // consumes the snapshot
    expect(undoDepth(second.view.state)).toBe(1);
    second.rendered.unmount();
    // Close again WITHOUT editing: nothing new to park beyond the restored stack.
    act(() => dispose(PATH));
    act(() => dispose(PATH)); // idempotent: no entry, nothing parked

    const third = await openAndLoad();
    expect(undoDepth(third.view.state)).toBe(1); // the carried stack, once
    expect(undoCacheSize()).toBe(0);
  });

  it("parks a stack for an editable file and NOTHING for a gate-forced read-only one", async () => {
    // A 10 000-char line trips `HUGE_LINE`, so the file opens read-only while
    // staying far under the 2 MB size gate — the read-only branch on its own.
    const RO = "/w/minified.txt";
    disk[RO] = "x".repeat(10_001) + "\n";

    const editable = await openAndLoad();
    edit(editable.view, "EDIT");
    editable.rendered.unmount();
    act(() => dispose(PATH));
    expect(undoCacheSize()).toBe(1); // editable → parked

    const readOnly = await openAndLoad(RO);
    expect(useAppStore.getState().editors[RO].editable).toBe(false);
    readOnly.rendered.unmount();
    act(() => dispose(RO));
    expect(undoCacheSize()).toBe(1); // still just the editable one — nothing added
  });
});
