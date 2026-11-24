/**
 * SaveRequestShortcut — Cmd/Ctrl+S saves the focused pane's active API request
 * into Collections. `apiStoreIpc` is mocked (persist crosses Tauri). Under test: the
 * keydown routes by active-tab kind — a renamed tab saves straight to Collections, a
 * default-titled tab opens the name dialog, a non-API (or absent) tab is a no-op, and
 * an already-handled event (a focused editor's file-save) is skipped.
 */

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiStoreIpc = vi.hoisted(() => ({
  loadApiStore: vi.fn(),
  saveApiStore: vi.fn(),
}));
vi.mock("./apiStoreIpc", () => apiStoreIpc);

import { useAppStore } from "../../app/store";
import { resetStore } from "../../test/store-harness";
import { SaveRequestShortcut } from "./SaveRequestShortcut";

/** Dispatch a Cmd+S (or a variant) on window. */
function press(opts: Partial<KeyboardEventInit> = {}) {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "s",
        metaKey: true,
        bubbles: true,
        cancelable: true,
        ...opts,
      }),
    );
  });
}

/** Open a fresh API-request tab; return {tabId, requestId}. */
function openApiTab() {
  const tabId = useAppStore.getState().layoutActions.openApiRequestTab();
  const tab = useAppStore.getState().tabs[tabId];
  const requestId = tab.ref.kind === "api-request" ? tab.ref.requestId : "";
  return { tabId, requestId };
}

beforeEach(() => {
  resetStore();
  apiStoreIpc.loadApiStore.mockReset().mockResolvedValue({
    collections: [],
    environments: [],
    activeEnvironmentId: null,
  });
  apiStoreIpc.saveApiStore.mockReset().mockResolvedValue(undefined);
  render(<SaveRequestShortcut />);
});
afterEach(() => cleanup());

describe("SaveRequestShortcut", () => {
  it("opens the name dialog when the active API tab still has the default title", () => {
    const { tabId, requestId } = openApiTab();
    press();
    expect(useAppStore.getState().saveRequestPrompt).toEqual({ requestId, tabId });
    // Nothing saved yet — the dialog will collect the name.
    expect(useAppStore.getState().apiCollections).toEqual([]);
  });

  it("saves straight to Collections (no dialog) when the tab was renamed", () => {
    const { tabId, requestId } = openApiTab();
    act(() => {
      useAppStore.getState().apiActions.patchApiRequest(requestId, {
        url: "https://api.test/x",
      });
      useAppStore.getState().layoutActions.renameTab(tabId, "My saved call");
    });
    press();
    expect(useAppStore.getState().saveRequestPrompt).toBeNull();
    const saved = useAppStore.getState().apiCollections;
    expect(saved).toHaveLength(1);
    expect(saved[0].name).toBe("My saved call");
    expect(saved[0].url).toBe("https://api.test/x");
  });

  it("is a no-op when the active tab is not an API request", () => {
    useAppStore.getState().layoutActions.openEditorTab("/tmp/file.ts");
    press();
    expect(useAppStore.getState().saveRequestPrompt).toBeNull();
    expect(useAppStore.getState().apiCollections).toEqual([]);
  });

  it("is a no-op when there is no active tab", () => {
    press();
    expect(useAppStore.getState().saveRequestPrompt).toBeNull();
  });

  it("ignores an already-handled event (a focused editor's file-save)", () => {
    openApiTab();
    // A capture-phase listener preventDefaults first, so the shortcut's bubble
    // listener sees defaultPrevented and yields (the editor's Mod-s path).
    const swallow = (e: KeyboardEvent) => e.preventDefault();
    window.addEventListener("keydown", swallow, { capture: true });
    press();
    window.removeEventListener("keydown", swallow, { capture: true });
    expect(useAppStore.getState().saveRequestPrompt).toBeNull();
  });

  it("answers Ctrl+S as well — the Windows and Linux chord", () => {
    const { tabId, requestId } = openApiTab();
    press({ metaKey: false, ctrlKey: true });
    expect(useAppStore.getState().saveRequestPrompt).toEqual({ requestId, tabId });
  });

  it("ignores Cmd+Shift+S and a bare 's'", () => {
    openApiTab();
    press({ shiftKey: true });
    press({ metaKey: false });
    expect(useAppStore.getState().saveRequestPrompt).toBeNull();
  });
});
