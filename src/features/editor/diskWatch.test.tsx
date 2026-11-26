/** Only the IPC is mocked: the property is that a disk change reaches the real buffer, and a
 * stubbed registry would only assert its own stub. */

import { render, screen, waitFor } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { EditorView } from "@codemirror/view";

import { useAppStore } from "../../app/store";
import type { TabId } from "../../app/types";
import { installTauriMock, type TauriMock } from "../../test/tauri-mock";
import { resetStore } from "../../test/store-harness";
import { CodeEditor } from "./CodeEditor";
import { disposeAll, getView } from "./EditorRegistry";
import { stubGeometry } from "./find/cmTestKit";
import { checkOpenFilesOnce, sameStamp, stopDiskWatch } from "./diskWatch";

const PATH = "/w/notes.md";
const state = () => useAppStore.getState();
const docOf = (v: EditorView) => v.state.doc.toString();
const status = (p = PATH) => state().editors[p]?.status;
const stale = (p = PATH) => state().editors[p]?.staleOnDisk ?? false;

describe("sameStamp", () => {
  it("is false whenever either side is unknown — 'cannot tell' is not 'unchanged'", () => {
    // The distinction that stops a file briefly unreadable mid-write from being
    // announced as a conflict.
    expect(sameStamp(null, { mtimeMs: 1, size: 2 })).toBe(false);
    expect(sameStamp({ mtimeMs: 1, size: 2 }, null)).toBe(false);
    expect(sameStamp(null, null)).toBe(false);
  });

  it("compares BOTH mtime and size", () => {
    expect(sameStamp({ mtimeMs: 1, size: 2 }, { mtimeMs: 1, size: 2 })).toBe(true);
    expect(sameStamp({ mtimeMs: 1, size: 2 }, { mtimeMs: 9, size: 2 })).toBe(false);
    // Size is why a same-second double write is still seen: several filesystems
    // stamp mtime with 1-second granularity.
    expect(sameStamp({ mtimeMs: 1, size: 2 }, { mtimeMs: 1, size: 3 })).toBe(false);
  });
});

describe("diskWatch — an agent edits an open file", () => {
  let ipc: TauriMock;
  let disk: Record<string, string>;
  let stamps: Record<string, { mtimeMs: number; size: number } | null>;
  /** How many times the file has been read — the work, not just the outcome. */
  let reads: number;

  beforeAll(() => stubGeometry());

  beforeEach(() => {
    disposeAll();
    resetStore();
    disk = { [PATH]: "# original\n" };
    stamps = { [PATH]: { mtimeMs: 1_000, size: disk[PATH].length } };
    reads = 0;
    ipc = installTauriMock();
    ipc.handle("read_file", (args) => {
      reads += 1;
      return disk[args.path as string] ?? "";
    });
    ipc.handle("write_file", (args) => {
      const p = args.path as string;
      disk[p] = args.content as string;
      stamps[p] = { mtimeMs: (stamps[p]?.mtimeMs ?? 0) + 500, size: disk[p].length };
      return null;
    });
    ipc.handle("file_stamps", (args) =>
      (args.paths as string[]).map((p) => stamps[p] ?? null),
    );
  });
  afterEach(() => {
    stopDiskWatch();
    ipc.reset();
    disposeAll();
  });

  /** Open the tab, mount the editor, wait for the first read. */
  const open = async (path = PATH) => {
    let tabId!: TabId;
    act(() => {
      tabId = state().layoutActions.openEditorTab(path);
    });
    render(<CodeEditor path={path} />);
    await waitFor(() => expect(status(path)).toBe("ready"));
    // Let the initial stamp land, so the first check compares like with like.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    return { tabId, view: getView(path) as EditorView };
  };

  /** What an agent does: rewrite the file and move its stamp. */
  const agentWrites = (text: string, path = PATH) => {
    disk[path] = text;
    stamps[path] = { mtimeMs: 9_999, size: text.length };
  };

  it("refreshes a CLEAN buffer without being asked — the common case", async () => {
    const { view } = await open();
    expect(docOf(view)).toBe("# original\n");

    agentWrites("# rewritten by an agent\n");
    await act(async () => {
      await checkOpenFilesOnce();
      await Promise.resolve();
    });

    expect(docOf(view)).toBe("# rewritten by an agent\n");
    // Nothing to warn about: the user had no work to lose.
    expect(stale()).toBe(false);
  });

  it("does NOT touch a DIRTY buffer — it flags it instead", async () => {
    const { view } = await open();
    act(() => {
      view.dispatch({ changes: { from: view.state.doc.length, insert: "my unsaved edit" } });
    });
    const mine = docOf(view);

    agentWrites("# rewritten by an agent\n");
    await act(async () => {
      await checkOpenFilesOnce();
      await Promise.resolve();
    });

    // Two-sided: the work survives AND the user is told.
    expect(docOf(view)).toBe(mine);
    expect(stale()).toBe(true);
  });

  it("does nothing at all when the file has not changed", async () => {
    const { view } = await open();
    await act(async () => {
      await checkOpenFilesOnce();
      await Promise.resolve();
    });
    expect(docOf(view)).toBe("# original\n");
    expect(stale()).toBe(false);
  });

  it("does not report OUR OWN save as someone else's change", async () => {
    const { view } = await open();
    act(() => {
      view.dispatch({ changes: { from: view.state.doc.length, insert: "mine" } });
    });
    const { save } = await import("./EditorRegistry");
    await act(async () => {
      await save(PATH);
      await Promise.resolve();
    });

    await act(async () => {
      await checkOpenFilesOnce();
      await Promise.resolve();
    });

    // The save moved the mtime; re-stamping on write is what stops that from
    // reading as a conflict with ourselves.
    expect(stale()).toBe(false);
    expect(docOf(view)).toContain("mine");
  });

  it("treats an unstampable file as no news, not as a change", async () => {
    const { view } = await open();
    const before = reads;
    stamps[PATH] = null; // mid-write, or briefly gone
    await act(async () => {
      await checkOpenFilesOnce();
      await Promise.resolve();
    });
    expect(docOf(view)).toBe("# original\n");
    expect(stale()).toBe(false);
    // Asserting the WORK, not just the outcome: treating "cannot tell" as
    // "changed" would re-read the file and land on the same text, so the visible
    // result would be identical and the bug invisible. It must not read at all.
    expect(reads).toBe(before);
  });

  it("only fires ONCE for one change, even if the user leaves it flagged", async () => {
    const { view } = await open();
    act(() => {
      view.dispatch({ changes: { from: view.state.doc.length, insert: "mine" } });
    });
    agentWrites("# agent\n");

    await act(async () => {
      await checkOpenFilesOnce();
      await Promise.resolve();
    });
    expect(stale()).toBe(true);

    // Clear it as the user might by looking away, then tick again with the file
    // unchanged since: the stamp was recorded, so nothing re-fires.
    act(() => state().editorActions.setEditorStale(PATH, false));
    await act(async () => {
      await checkOpenFilesOnce();
      await Promise.resolve();
    });
    expect(stale()).toBe(false);
  });

  it("Reload discards the unsaved edits and takes what is on disk", async () => {
    const { view } = await open();
    act(() => {
      view.dispatch({ changes: { from: view.state.doc.length, insert: "mine" } });
    });
    agentWrites("# agent wins\n");
    await act(async () => {
      await checkOpenFilesOnce();
      await Promise.resolve();
    });
    expect(stale()).toBe(true);

    // The button exists only because the buffer was dirty — this is the user
    // choosing to lose their edits, which is the only way they ever go.
    const reload = screen.getByTestId("editor-reload");
    await act(async () => {
      reload.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(docOf(view)).toBe("# agent wins\n");
    expect(stale()).toBe(false);
  });

  it("manual Reload: a clean buffer reloads in one click", async () => {
    const { view } = await open();
    // Changed on disk, but the watcher hasn't ticked yet — the user asks first.
    agentWrites("# fresh from disk\n");
    const btn = screen.getByTestId("editor-reload-manual");
    expect(btn).toHaveAttribute("aria-label", "Reload from disk");
    await act(async () => {
      btn.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(docOf(view)).toBe("# fresh from disk\n");
  });

  it("manual Reload on a DIRTY buffer arms first, then discards on the second click", async () => {
    const { view } = await open();
    act(() => {
      view.dispatch({ changes: { from: view.state.doc.length, insert: "mine" } });
    });
    const mine = docOf(view);
    agentWrites("# disk\n");
    const btn = () => screen.getByTestId("editor-reload-manual");

    // First click only arms — the edits survive.
    await act(async () => {
      btn().click();
      await Promise.resolve();
    });
    expect(btn()).toHaveTextContent("Discard edits?");
    expect(docOf(view)).toBe(mine);

    // Leaving disarms it.
    act(() => {
      btn().dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
    });
    expect(btn()).not.toHaveTextContent("Discard edits?");

    // Arm + confirm → disk wins, the tab is clean, the button disarms.
    await act(async () => {
      btn().click();
      await Promise.resolve();
    });
    await act(async () => {
      btn().click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(docOf(view)).toBe("# disk\n");
    expect(btn()).not.toHaveTextContent("Discard edits?");
  });

  it("an armed Reload disarms itself when the buffer becomes clean (e.g. saved)", async () => {
    const { view } = await open();
    act(() => {
      view.dispatch({ changes: { from: view.state.doc.length, insert: "x" } });
    });
    const btn = () => screen.getByTestId("editor-reload-manual");
    act(() => btn().click());
    expect(btn()).toHaveTextContent("Discard edits?");
    const { save } = await import("./EditorRegistry");
    await act(async () => {
      await save(PATH);
      await Promise.resolve();
    });
    expect(btn()).not.toHaveTextContent("Discard edits?");
  });

  it("the manual Reload hides while the 'Changed on disk' prompt carries its own", async () => {
    const { view } = await open();
    act(() => {
      view.dispatch({ changes: { from: view.state.doc.length, insert: "mine" } });
    });
    agentWrites("# agent\n");
    await act(async () => {
      await checkOpenFilesOnce();
      await Promise.resolve();
    });
    expect(screen.getByTestId("editor-reload")).toBeInTheDocument();
    expect(screen.queryByTestId("editor-reload-manual")).toBeNull();
  });

  it("is a no-op with no editors open", async () => {
    disposeAll();
    await expect(checkOpenFilesOnce()).resolves.toBeUndefined();
  });
});
