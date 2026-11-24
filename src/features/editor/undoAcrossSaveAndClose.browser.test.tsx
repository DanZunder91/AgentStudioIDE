/**
 * Layer 5 (testing-strategy §1) — undo after a save and after a close, driven by
 * REAL keystrokes in REAL Chromium.
 *
 * This is the tier that would have caught the original bug. The file editor
 * shipped with no CodeMirror history at all, so Cmd/Ctrl+Z fell straight through
 * the `contenteditable` to WebKit's own native undo — shallow, and clobbered
 * whenever CM6 rewrote decorations (sometimes only two
 * undo steps were available). Under jsdom that difference is invisible: there is no native
 * undo stack there, so a keydown that CodeMirror ignores simply does nothing and
 * a test could only ever have asserted the absence of an effect. Here the key
 * goes through a real keymap on a real focused editable element.
 *
 * The jsdom sibling (`undoAcrossSaveAndClose.test.tsx`) owns the exhaustive
 * cases — depth counting, the cache bounds, the doc-identity guard. This file
 * owns the claim that the *keystroke* works.
 *
 * A green test count is not a green tier: this run must EXIT 0.
 */

import { render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { EditorView } from "@codemirror/view";

import { useAppStore } from "../../app/store";
import type { TabId } from "../../app/types";
import { installTauriMock, type TauriMock } from "../../test/tauri-mock";
import { resetStore } from "../../test/store-harness";
import { CodeEditor } from "./CodeEditor";
import { disposeAll, getView } from "./EditorRegistry";

/** "Mod" is Cmd on macOS, Ctrl elsewhere — match what CM6's keymap resolves to. */
const MAC = navigator.platform.toLowerCase().includes("mac");
const MOD = MAC ? "Meta" : "Control";

const PATH = "/w/notes.txt"; // .txt → plaintext → no Shiki re-highlight in the way
const ORIGINAL = "hello world\n";

/** CM6's `newGroupDelay` is 500 ms; wait past it to force a separate undo step. */
const NEW_GROUP_MS = 700;
const pause = () => new Promise((resolve) => setTimeout(resolve, NEW_GROUP_MS));

const docOf = (path = PATH) => (getView(path) as EditorView).state.doc.toString();
const tabDirty = (path = PATH) =>
  Object.values(useAppStore.getState().tabs).some(
    (t) => t.ref.kind === "editor" && t.ref.path === path && Boolean(t.dirty),
  );

describe("undo after save / after close (real CodeMirror 6, real keystrokes)", () => {
  let ipc: TauriMock;
  /** The mocked filesystem: `write_file` updates it, so a reopen re-reads it. */
  let disk: Record<string, string>;

  beforeEach(() => {
    disposeAll(); // the registry AND the undo cache are module singletons
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

  /** Open the tab and mount the editor; resolves once CM6 has the content. */
  const open = async (path = PATH) => {
    const tabId: TabId = useAppStore.getState().layoutActions.openEditorTab(path);
    const rendered = render(<CodeEditor path={path} />);
    await waitFor(() =>
      expect(rendered.container.querySelector(".cm-content")).toBeTruthy(),
    );
    const content = rendered.container.querySelector(".cm-content") as HTMLElement;
    return { tabId, rendered, content };
  };

  const user = () => userEvent.setup();
  const pressUndo = (u: ReturnType<typeof user>) => u.keyboard(`{${MOD}>}z{/${MOD}}`);
  /** `historyKeymap` binds Mod-y, overridden to Mod-Shift-z on macOS. */
  const pressRedo = (u: ReturnType<typeof user>) =>
    MAC ? u.keyboard("{Meta>}{Shift>}z{/Shift}{/Meta}") : u.keyboard("{Control>}y{/Control}");

  it("Cmd/Ctrl+Z after a Cmd/Ctrl+S restores the pre-edit text", async () => {
    const { content } = await open();
    const u = user();

    await u.click(content);
    await u.keyboard("EDIT ");
    await waitFor(() => expect(tabDirty()).toBe(true));
    await u.keyboard(`{${MOD}>}s{/${MOD}}`);
    await waitFor(() => expect(disk[PATH]).toBe("EDIT hello world\n"));
    await waitFor(() => expect(tabDirty()).toBe(false));

    // Two-sided: edited before the keystroke…
    expect(docOf()).toBe("EDIT hello world\n");

    await pressUndo(u);

    // …original after it. Read off the real CM6 document — the same `state.doc`
    // that `save()` writes, so the assertion cannot disagree with what would
    // reach disk. The rendered DOM is checked too: a real `.cm-line` re-rendered.
    expect(docOf()).toBe(ORIGINAL);
    expect(content.textContent).toBe("hello world");
    await waitFor(() => expect(tabDirty()).toBe(true)); // differs from disk again
  });

  it("gives back EVERY typing burst after a save — not just the last two", async () => {
    const { content } = await open();
    const u = user();
    await u.click(content);

    // Three bursts separated past `newGroupDelay`, so CM6 records three events.
    await u.keyboard("A");
    await pause();
    await u.keyboard("B");
    await pause();
    await u.keyboard("C");
    expect(docOf()).toBe("ABChello world\n");

    await u.keyboard(`{${MOD}>}s{/${MOD}}`);
    await waitFor(() => expect(disk[PATH]).toBe("ABChello world\n"));

    await pressUndo(u);
    expect(docOf()).toBe("ABhello world\n");
    await pressUndo(u);
    expect(docOf()).toBe("Ahello world\n");
    // Two presses were NOT enough — that is the whole two-step-undo report.
    expect(docOf()).not.toBe(ORIGINAL);

    await pressUndo(u);
    expect(docOf()).toBe(ORIGINAL);
  });

  it("redo re-applies the undone edit", async () => {
    const { content } = await open();
    const u = user();

    await u.click(content);
    await u.keyboard("EDIT ");
    await u.keyboard(`{${MOD}>}s{/${MOD}}`);
    await waitFor(() => expect(disk[PATH]).toBe("EDIT hello world\n"));

    await pressUndo(u);
    expect(docOf()).toBe(ORIGINAL);

    await pressRedo(u);

    expect(docOf()).toBe("EDIT hello world\n");
  });

  it("still undoes after the tab was CLOSED and the file reopened", async () => {
    const first = await open();
    const u = user();

    await u.click(first.content);
    await u.keyboard("EDIT ");
    await u.keyboard(`{${MOD}>}s{/${MOD}}`);
    await waitFor(() => expect(disk[PATH]).toBe("EDIT hello world\n"));

    // Close for real: unmount (the pane stops rendering it) and run the store's
    // own close path, which tears the CM6 buffer down through `disposeEditorBuffer`.
    first.rendered.unmount();
    useAppStore.getState().layoutActions.closeTab(first.tabId);
    expect(getView(PATH)).toBeNull();

    // Reopen from disk and press the same key. The undo stack was parked on
    // dispose and is handed back because the file is byte-for-byte unchanged.
    const again = await open();
    expect(docOf()).toBe("EDIT hello world\n");

    await user().click(again.content);
    await pressUndo(user());

    expect(docOf()).toBe(ORIGINAL);
    expect(again.content.textContent).toBe("hello world");
  });
});
