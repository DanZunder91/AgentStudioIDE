/** A background tab has no mounted CodeEditor to dispose on unmount; closing one must not leave a
 * registry entry without its store slice, or a reopen sticks on "Loading…". */

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

  /** An image tab has a store slice but no registry entry (`read_file` rejects binaries). */
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

    // `closePane`, not `closeTab`: closeTab deletes `editors[path]` inline and would mask the leak,
    // while closePane relies on `EditorRegistry.dispose`.
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
