import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiStoreIpc = vi.hoisted(() => ({
  loadApiStore: vi.fn(),
  saveApiStore: vi.fn(),
}));
vi.mock("./apiStoreIpc", () => apiStoreIpc);

import { useAppStore } from "../../app/store";
import { resetStore } from "../../test/store-harness";
import { SaveRequestDialog } from "./SaveRequestDialog";

/** Open an API tab, mutate its url, and open the name prompt for it. */
function openPrompt() {
  const tabId = useAppStore.getState().layoutActions.openApiRequestTab();
  const tab = useAppStore.getState().tabs[tabId];
  const requestId = tab.ref.kind === "api-request" ? tab.ref.requestId : "";
  act(() => {
    useAppStore.getState().apiActions.patchApiRequest(requestId, {
      url: "https://api.test/x",
    });
    useAppStore.setState({ saveRequestPrompt: { requestId, tabId } });
  });
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
});
afterEach(() => cleanup());

describe("SaveRequestDialog", () => {
  it("renders nothing while no prompt is pending", () => {
    render(<SaveRequestDialog />);
    expect(screen.queryByTestId("save-request-dialog")).toBeNull();
  });

  it("saves under the typed name, retitles the tab, and closes", () => {
    const { tabId } = openPrompt();
    render(<SaveRequestDialog />);
    expect(screen.getByTestId("save-request-dialog")).toBeInTheDocument();

    fireEvent.change(screen.getByTestId("save-request-name"), {
      target: { value: "Create X" },
    });
    fireEvent.click(screen.getByTestId("save-request-confirm"));

    const s = useAppStore.getState();
    expect(s.saveRequestPrompt).toBeNull();
    expect(s.apiCollections).toHaveLength(1);
    expect(s.apiCollections[0].name).toBe("Create X");
    expect(s.apiCollections[0].url).toBe("https://api.test/x");
    // The tab now reads as its saved name.
    expect(s.tabs[tabId].customTitle).toBe("Create X");
  });

  it("disables Save on an empty name and does not save", () => {
    openPrompt();
    render(<SaveRequestDialog />);
    expect(screen.getByTestId("save-request-confirm")).toBeDisabled();
    // Whitespace-only stays disabled too.
    fireEvent.change(screen.getByTestId("save-request-name"), {
      target: { value: "   " },
    });
    expect(screen.getByTestId("save-request-confirm")).toBeDisabled();
    expect(useAppStore.getState().apiCollections).toEqual([]);
  });

  it("confirms with Enter and cancels with Escape", () => {
    openPrompt();
    const { rerender } = render(<SaveRequestDialog />);

    // Enter on a typed name saves.
    fireEvent.change(screen.getByTestId("save-request-name"), {
      target: { value: "Via Enter" },
    });
    fireEvent.keyDown(screen.getByTestId("save-request-name"), { key: "Enter" });
    expect(useAppStore.getState().apiCollections[0].name).toBe("Via Enter");
    expect(useAppStore.getState().saveRequestPrompt).toBeNull();

    // Re-open a prompt and cancel with Escape — nothing new saved.
    openPrompt();
    rerender(<SaveRequestDialog />);
    fireEvent.keyDown(screen.getByTestId("save-request-name"), { key: "Escape" });
    expect(useAppStore.getState().saveRequestPrompt).toBeNull();
    expect(useAppStore.getState().apiCollections).toHaveLength(1); // still just the first
  });

  it("Enter with an empty name does nothing (guarded); other keys are inert", () => {
    openPrompt();
    render(<SaveRequestDialog />);
    const input = screen.getByTestId("save-request-name");
    // Enter with no name → the confirm guard blocks it; dialog stays open.
    fireEvent.keyDown(input, { key: "Enter" });
    expect(useAppStore.getState().apiCollections).toEqual([]);
    expect(useAppStore.getState().saveRequestPrompt).not.toBeNull();
    // A normal keystroke is inert (neither Enter nor Escape).
    fireEvent.keyDown(input, { key: "a" });
    expect(useAppStore.getState().saveRequestPrompt).not.toBeNull();
  });

  it("closes without saving on Cancel", () => {
    openPrompt();
    render(<SaveRequestDialog />);
    fireEvent.click(screen.getByTestId("save-request-cancel"));
    expect(useAppStore.getState().saveRequestPrompt).toBeNull();
    expect(useAppStore.getState().apiCollections).toEqual([]);
  });
});
