/** The registry's `save` is mocked (it owns CM6); the store wiring is real. */

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const registry = vi.hoisted(() => ({
  save: vi.fn().mockResolvedValue(true),
  // closeTab tears the CM6 buffer down through this (background tabs have no
  // mounted <CodeEditor> to do it on unmount).
  dispose: vi.fn(),
}));
vi.mock("./EditorRegistry", () => registry);

import { useAppStore } from "../../app/store";
import type { TabId } from "../../app/types";
import { resetFleetStore } from "../../test/fleet-harness";
import { resetStore } from "../../test/store-harness";
import { UnsavedChangesDialog } from "./UnsavedChangesDialog";

const state = () => useAppStore.getState();
const layout = () => useAppStore.getState().layoutActions;
const editors = () => useAppStore.getState().editorActions;

/** Open a dirty editor tab and request its close (→ pending confirm). */
const pendDirtyClose = (path: string): TabId => {
  let tabId!: TabId;
  act(() => {
    tabId = layout().openEditorTab(path);
    editors().initEditor(path);
    editors().setEditorDirty(path, true);
    editors().requestCloseTab(tabId);
  });
  return tabId;
};

beforeEach(() => {
  resetStore();
  resetFleetStore();
  registry.save.mockClear().mockResolvedValue(true);
});
afterEach(() => cleanup());

describe("UnsavedChangesDialog", () => {
  it("renders nothing when no dirty close is pending", () => {
    const { container } = render(<UnsavedChangesDialog />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing for a stale or non-editor pending close (defensive)", () => {
    // A terminal tab, and a vanished tab id — the dialog is inert for both.
    act(() => {
      const term = layout().openTerminalTab();
      useAppStore.setState((s) => {
        s.confirmCloseTab = term;
      });
    });
    const { container, rerender } = render(<UnsavedChangesDialog />);
    expect(container).toBeEmptyDOMElement();

    act(() => {
      useAppStore.setState((s) => {
        s.confirmCloseTab = "ghost" as TabId;
      });
    });
    rerender(<UnsavedChangesDialog />);
    expect(container).toBeEmptyDOMElement();
  });

  it("prompts with Save / Discard / Cancel, naming the file", () => {
    pendDirtyClose("/w/src/notes.md");
    render(<UnsavedChangesDialog />);

    expect(screen.getByRole("dialog", { name: "Unsaved changes" })).toBeInTheDocument();
    expect(screen.getByText(/notes\.md/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Discard" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("Cancel dismisses the confirm and keeps the tab open", async () => {
    const tabId = pendDirtyClose("/w/a.ts");
    render(<UnsavedChangesDialog />);

    await userEvent.setup().click(screen.getByRole("button", { name: "Cancel" }));
    expect(state().confirmCloseTab).toBeNull();
    expect(state().tabs[tabId]).toBeDefined();
  });

  it("Discard closes the tab, losing the edits", async () => {
    const tabId = pendDirtyClose("/w/a.ts");
    render(<UnsavedChangesDialog />);

    await userEvent.setup().click(screen.getByRole("button", { name: "Discard" }));
    expect(state().tabs[tabId]).toBeUndefined();
    expect(registry.save).not.toHaveBeenCalled();
  });

  it("Save persists first, then closes the tab", async () => {
    const tabId = pendDirtyClose("/w/a.ts");
    render(<UnsavedChangesDialog />);

    await userEvent.setup().click(screen.getByRole("button", { name: "Save" }));
    expect(registry.save).toHaveBeenCalledWith("/w/a.ts");
    await waitFor(() => expect(state().tabs[tabId]).toBeUndefined());
  });

  it("a FAILED save keeps the tab open (edits preserved), dialog dismissed", async () => {
    registry.save.mockResolvedValue(false);
    const tabId = pendDirtyClose("/w/a.ts");
    render(<UnsavedChangesDialog />);

    await userEvent.setup().click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(state().confirmCloseTab).toBeNull());
    expect(state().tabs[tabId]).toBeDefined(); // NOT closed — edits kept
  });
});
