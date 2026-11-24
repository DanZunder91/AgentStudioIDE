/**
 * ShortcutsPanel + ShortcutsButton — the keyboard-shortcuts reference overlay.
 *
 * Open state is the store's `shortcutsOpen`, so the button and the Cmd/Ctrl+/
 * hotkey drive the same overlay; both are exercised here, plus the close paths
 * (Esc, the close button, the backdrop) and that an inside click does NOT close.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAppStore } from "../../app/store";
import { resetStore } from "../../test/store-harness";
import { ShortcutsButton, ShortcutsPanel } from "./ShortcutsPanel";

const panel = () => screen.queryByTestId("shortcuts-panel");
const both = () => (
  <>
    <ShortcutsButton />
    <ShortcutsPanel />
  </>
);

beforeEach(() => resetStore());
afterEach(cleanup);

describe("ShortcutsPanel", () => {
  it("is closed by default", () => {
    render(<ShortcutsPanel />);
    expect(panel()).toBeNull();
  });

  it("opens on Cmd+/ and closes on a second press (toggle)", () => {
    render(<ShortcutsPanel />);
    fireEvent.keyDown(window, { key: "/", metaKey: true });
    expect(panel()).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "/", metaKey: true });
    expect(panel()).toBeNull();
  });

  it("opens on Ctrl+/ too (the non-mac modifier)", () => {
    render(<ShortcutsPanel />);
    fireEvent.keyDown(window, { key: "/", ctrlKey: true });
    expect(panel()).toBeInTheDocument();
  });

  it("opens from the titlebar button", () => {
    render(both());
    fireEvent.click(screen.getByLabelText("Keyboard shortcuts"));
    expect(panel()).toBeInTheDocument();
  });

  it("the button's tooltip names this platform's chord — Ctrl+/ off macOS, ⌘/ on it", () => {
    const ua = vi.spyOn(window.navigator, "userAgent", "get");
    try {
      ua.mockReturnValue("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
      const { unmount } = render(<ShortcutsButton />);
      expect(screen.getByLabelText("Keyboard shortcuts")).toHaveAttribute("title", "Keyboard shortcuts (Ctrl+/)");
      unmount();
      ua.mockReturnValue("Mozilla/5.0 (Macintosh; Intel Mac OS X)");
      render(<ShortcutsButton />);
      expect(screen.getByLabelText("Keyboard shortcuts")).toHaveAttribute("title", "Keyboard shortcuts (⌘/)");
    } finally {
      ua.mockRestore();
    }
  });

  it("renders the grouped shortcuts with key chips", () => {
    render(<ShortcutsPanel />);
    fireEvent.keyDown(window, { key: "/", metaKey: true });
    expect(screen.getByText("Code intelligence")).toBeInTheDocument();
    expect(screen.getByText(/Find in files/)).toBeInTheDocument();
    expect(screen.getAllByText("F12").length).toBeGreaterThan(0); // key chips
    // ⌘S is ONE keystroke over three surfaces (file save, the API client's
    // `saveActiveApiRequest`, and a DB console's query), so the row no
    // longer claims to be about files. It used to read "Save the current file", which was
    // already incomplete before the console existed. Both halves are asserted: the general
    // row here, and the console-specific semantics under "Database console".
    expect(
      screen.getByText(
        "Save whatever has focus — the current file, the active API request, or a database console's query",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Save the query — updates the saved query you opened, or asks for a name to create one",
      ),
    ).toBeInTheDocument();
    // Two ⌘S rows, in two groups, deliberately — not one row silently overloaded.
    expect(screen.getAllByText("S")).toHaveLength(2);
  });

  it("closes on Escape, the close button, and the backdrop", () => {
    render(<ShortcutsPanel />);
    const open = () => fireEvent.keyDown(window, { key: "/", metaKey: true });

    open();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(panel()).toBeNull();

    open();
    fireEvent.click(screen.getByLabelText("Close shortcuts"));
    expect(panel()).toBeNull();

    open();
    fireEvent.click(screen.getByTestId("shortcuts-backdrop"));
    expect(panel()).toBeNull();
  });

  it("does not close on a click inside the card", () => {
    render(<ShortcutsPanel />);
    fireEvent.keyDown(window, { key: "/", metaKey: true });
    fireEvent.click(screen.getByTestId("shortcuts-panel"));
    expect(panel()).toBeInTheDocument();
  });

  it("ignores Escape when already closed (no throw, stays closed)", () => {
    render(<ShortcutsPanel />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(panel()).toBeNull();
    expect(useAppStore.getState().shortcutsOpen).toBe(false);
  });
});
