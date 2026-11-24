/**
 * Editor buffer lifecycle across the CLOSE paths — the eternal-"Loading…" bug.
 *
 * The registry preserves a buffer while its tab exists (tab switch = unmount +
 * detach, entry kept). But only a MOUNTED <CodeEditor> can dispose on unmount —
 * and a background tab (not its pane's active tab) has no mounted component. So
 * closing one used to delete the `editors` store slice while the registry entry
 * survived; reopening the path then early-returned in `ensureEditor`, never ran
 * initEditor/readFile, and the editor showed "Loading…" until app restart (seen
 * on a package.json).
 *
 * Pinned here, through the real store + real EditorRegistry (CM6 constructs
 * fine under jsdom; only the Tauri IPC boundary is mocked):
 *   1. close a background tab → reopen: loads fresh, never stuck.
 *   2. closePane over a background editor tab → reopen: re-reads from disk
 *      (no stale-buffer resurrection).
 *   3. the `ensureEditor` self-heal backstop for any orphan a future close
 *      path might produce.
 *   4. the preserve contract is untouched: tab switch keeps the buffer and
 *      does NOT re-read the file.
 */

import { render, waitFor } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useAppStore } from "../../app/store";
import type { TabId } from "../../app/types";
import { installTauriMock, type TauriMock } from "../../test/tauri-mock";
import { resetStore } from "../../test/store-harness";
import { CodeEditor } from "./CodeEditor";
import { currentText, disposeAll, ensureEditor, getView } from "./EditorRegistry";

const PATH = "/w/project/package.json";

const status = () => useAppStore.getState().editors[PATH]?.status;

describe("editor buffer lifecycle on close", () => {
  let ipc: TauriMock;

  beforeEach(() => {
    disposeAll(); // the registry is a module singleton — clear it between tests
    resetStore();
    ipc = installTauriMock();
  });
  afterEach(() => {
    ipc.reset();
    disposeAll();
  });

  /** Open the tab, mount the editor, and wait for the load to land. */
  const openAndLoad = async () => {
    let tabId!: TabId;
    act(() => {
      tabId = useAppStore.getState().layoutActions.openEditorTab(PATH);
    });
    const view = render(<CodeEditor path={PATH} />);
    await waitFor(() => expect(status()).toBe("ready"));
    return { tabId, view };
  };

  it("closing a BACKGROUND tab disposes the buffer; reopening loads fresh, not eternal Loading…", async () => {
    ipc.handle("read_file", () => '{"name":"string-utils"}');
    const { tabId, view } = await openAndLoad();

    // Switch away: unmount while the tab still exists — the entry is preserved.
    view.unmount();
    expect(getView(PATH)).not.toBeNull();

    // Close the background tab. No component is mounted, so no detach fires —
    // the store's close path must dispose the registry entry itself.
    act(() => {
      useAppStore.getState().layoutActions.closeTab(tabId);
    });
    expect(getView(PATH)).toBeNull();
    expect(useAppStore.getState().editors[PATH]).toBeUndefined();

    // Reopen: a fresh load, reaching ready — the bug left this at "loading".
    act(() => {
      useAppStore.getState().layoutActions.openEditorTab(PATH);
    });
    const reopened = render(<CodeEditor path={PATH} />);
    await waitFor(() => expect(status()).toBe("ready"));
    expect(reopened.queryByText("Loading…")).toBeNull();
  });

  it("closePane disposes its editor buffers; reopening re-reads the file from disk", async () => {
    let content = '{"v":1}';
    ipc.handle("read_file", () => content);
    const { view } = await openAndLoad();

    // Background the tab (unmount, entry preserved), then close the whole pane.
    view.unmount();
    act(() => {
      useAppStore.getState().layoutActions.closePane(useAppStore.getState().focusedPaneId);
    });
    expect(getView(PATH)).toBeNull();
    expect(useAppStore.getState().editors[PATH]).toBeUndefined();

    // The file changes on disk while closed; reopening must show the NEW text,
    // not resurrect the dead pane's buffer.
    content = '{"v":2}';
    act(() => {
      useAppStore.getState().layoutActions.openEditorTab(PATH);
    });
    render(<CodeEditor path={PATH} />);
    await waitFor(() => expect(status()).toBe("ready"));
    expect(currentText(PATH)).toBe('{"v":2}');
  });

  it("ensureEditor self-heals an orphaned entry (entry alive, slice gone)", async () => {
    let content = "old";
    ipc.handle("read_file", () => content);
    const { view } = await openAndLoad();
    view.unmount();

    // Manufacture the orphan directly — the backstop contract must hold even if
    // a future close path forgets to dispose: slice deleted, entry surviving.
    act(() => {
      useAppStore.getState().editorActions.disposeEditor(PATH);
    });
    expect(getView(PATH)).not.toBeNull();

    content = "new";
    act(() => {
      ensureEditor(PATH);
    });
    await waitFor(() => expect(status()).toBe("ready"));
    expect(currentText(PATH)).toBe("new");
  });

  /**
   * A RASTER image tab has a store slice and NO registry entry — `read_file`
   * rejects a PNG as "binary file", so `CodeEditor` deliberately never calls
   * `ensureEditor` for one. `dispose` used to early-return on a missing entry
   * *before* dropping the slice, which leaked `editors[path]` on every close; a
   * reopen then inherited the previous tab's zoom instead of starting at 100%.
   */
  it("closing an IMAGE tab's PANE drops its store slice, though it never had a buffer", async () => {
    const IMG = "/w/project/logo.png";
    act(() => {
      useAppStore.getState().layoutActions.openEditorTab(IMG);
    });
    const view = render(<CodeEditor path={IMG} />);
    await waitFor(() => expect(useAppStore.getState().editors[IMG]?.status).toBe("ready"));

    // No buffer was ever created, and no file was ever read.
    expect(getView(IMG)).toBeNull();
    expect(ipc.calls("read_file")).toHaveLength(0);

    // Zoom it, then close the whole PANE from the background. `closePane` is the
    // path that matters: `closeTab` also deletes `editors[path]` inline, so it
    // would mask the leak, while `closePane` (store.ts:7042) relies entirely on
    // `disposeEditorBuffer` → `EditorRegistry.dispose` to do it.
    act(() => {
      useAppStore.getState().editorActions.setPreviewZoom(IMG, 2);
    });
    view.unmount();
    act(() => {
      useAppStore.getState().layoutActions.closePane(useAppStore.getState().focusedPaneId);
    });
    expect(useAppStore.getState().editors[IMG]).toBeUndefined();

    // Reopening starts clean rather than inheriting the old zoom.
    act(() => {
      useAppStore.getState().layoutActions.openEditorTab(IMG);
    });
    render(<CodeEditor path={IMG} />);
    await waitFor(() => expect(useAppStore.getState().editors[IMG]?.status).toBe("ready"));
    expect(useAppStore.getState().editors[IMG].previewZoom).toBe(1);
  });

  it("tab switch still PRESERVES the buffer: no dispose, no second read", async () => {
    ipc.handle("read_file", () => "keep me");
    const { view } = await openAndLoad();

    // Unmount (switch away) and remount (switch back): same entry, one read.
    view.unmount();
    render(<CodeEditor path={PATH} />);
    await waitFor(() => expect(status()).toBe("ready"));
    expect(currentText(PATH)).toBe("keep me");
    expect(ipc.calls("read_file")).toHaveLength(1);
  });
});
