/** No main-window chrome here: those components start app-wide pollers a second window must not. */

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const events = vi.hoisted(() => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock("@tauri-apps/api/event", () => events);

vi.mock("./features/terminal", () => ({ configureTerminal: vi.fn(), dispose: vi.fn() }));

import { resetFleetStore } from "./test/fleet-harness";
import { resetStore } from "./test/store-harness";
import TearoffApp from "./TearoffApp";

beforeEach(() => {
  resetStore();
  resetFleetStore();
  vi.clearAllMocks();
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "tearoff-2" } },
  };
});
afterEach(() => {
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe("TearoffApp", () => {
  it("is a pane tree and nothing of the main window's chrome", () => {
    const { container } = render(<TearoffApp />);
    expect(screen.getByTestId("tearoff-shell")).toBeInTheDocument();
    expect(screen.getByText("This pane is empty")).toBeInTheDocument();
    // No titlebar buttons, no rails, no view bar — and so none of what they poll.
    expect(container.querySelector(".titlebar")).toBeNull();
    expect(container.querySelector(".rail")).toBeNull();
    expect(screen.queryByRole("tablist", { name: "Views" })).toBeNull();
  });

  it("answers Cmd+W addressed to THIS window only", () => {
    render(<TearoffApp />);
    expect(events.listen).toHaveBeenCalledWith("menu://close-tab", expect.any(Function), {
      target: { kind: "WebviewWindow", label: "tearoff-2" },
    });
  });

  it("has quick-open, find in files and the shortcuts reference — Ctrl+Shift+O works here too", () => {
    // Review finding: only Cmd+W was mounted, so Ctrl+O / Ctrl+F did nothing
    // in a detached window. The overlays scope themselves from the focused tab — this
    // window's.
    render(<TearoffApp />);
    expect(screen.queryByTestId("find-files")).toBeNull();
    fireEvent.keyDown(window, { key: "O", ctrlKey: true, shiftKey: true });
    expect(screen.getByTestId("find-files")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.keyDown(window, { key: "/", ctrlKey: true });
    expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeInTheDocument();
  });
});
