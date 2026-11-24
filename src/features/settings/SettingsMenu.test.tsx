/**
 * SettingsMenu — the titlebar gear + its "Focus follows agent" switch.
 *
 * Covers: the popover open/close (trigger toggle, Esc, outside-click, and that an
 * inside click does NOT close), the switch reflecting store state + flipping it on
 * click, and the aria wiring (role="switch" + aria-checked, aria-expanded).
 *
 * The store's `setFocusFollowsAgent` persists via `layoutPrefsIpc`; it is mocked so
 * clicking the switch never reaches Tauri (no unhandled IPC in tests).
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const layoutPrefsIpc = vi.hoisted(() => ({
  loadLayoutPrefs: vi.fn().mockResolvedValue({
    folderOrder: [],
    collapsedFolders: [],
    collapsedRoots: [],
    focusFollowsAgent: false,
  }),
  saveLayoutPrefs: vi.fn().mockResolvedValue(undefined),
  EMPTY_LAYOUT_PREFS: {
    folderOrder: [],
    collapsedFolders: [],
    collapsedRoots: [],
    focusFollowsAgent: false,
  },
}));
vi.mock("../../app/layoutPrefsIpc", () => layoutPrefsIpc);

import { useAppStore } from "../../app/store";
import { resetStore } from "../../test/store-harness";
import { SettingsMenu } from "./SettingsMenu";

const popover = () => screen.queryByTestId("settings-popover");
const trigger = () => screen.getByLabelText("Settings");
const switchEl = () => screen.getByRole("switch");

beforeEach(() => {
  resetStore();
  useAppStore.setState((s) => {
    s.focusFollowsAgent = false;
  });
  layoutPrefsIpc.saveLayoutPrefs.mockClear();
});
afterEach(cleanup);

describe("SettingsMenu", () => {
  it("renders the gear closed by default", () => {
    render(<SettingsMenu />);
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    expect(popover()).toBeNull();
  });

  it("opens on click and closes on a second click (toggle)", () => {
    render(<SettingsMenu />);
    fireEvent.click(trigger());
    expect(popover()).toBeInTheDocument();
    expect(trigger()).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(trigger());
    expect(popover()).toBeNull();
  });

  it("closes on Escape", () => {
    render(<SettingsMenu />);
    fireEvent.click(trigger());
    fireEvent.keyDown(window, { key: "Escape" });
    expect(popover()).toBeNull();
  });

  it("ignores non-Escape keys while open", () => {
    render(<SettingsMenu />);
    fireEvent.click(trigger());
    fireEvent.keyDown(window, { key: "a" });
    expect(popover()).toBeInTheDocument(); // still open
  });

  it("closes on an outside click", () => {
    render(
      <div>
        <span data-testid="outside">elsewhere</span>
        <SettingsMenu />
      </div>,
    );
    fireEvent.click(trigger());
    expect(popover()).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByTestId("outside"));
    expect(popover()).toBeNull();
  });

  it("stays open on a click INSIDE the popover", () => {
    render(<SettingsMenu />);
    fireEvent.click(trigger());
    fireEvent.mouseDown(screen.getByText("Focus follows agent"));
    expect(popover()).toBeInTheDocument();
  });

  it("reflects the store's focusFollowsAgent (off → aria-checked=false)", () => {
    render(<SettingsMenu />);
    fireEvent.click(trigger());
    expect(switchEl()).toHaveAttribute("aria-checked", "false");
  });

  it("reflects the store's focusFollowsAgent (on → aria-checked=true)", () => {
    useAppStore.setState((s) => {
      s.focusFollowsAgent = true;
    });
    render(<SettingsMenu />);
    fireEvent.click(trigger());
    expect(switchEl()).toHaveAttribute("aria-checked", "true");
  });

  it("clicking the switch flips the store on, then off", () => {
    render(<SettingsMenu />);
    fireEvent.click(trigger());

    fireEvent.click(switchEl());
    expect(useAppStore.getState().focusFollowsAgent).toBe(true);
    expect(switchEl()).toHaveAttribute("aria-checked", "true");

    fireEvent.click(switchEl());
    expect(useAppStore.getState().focusFollowsAgent).toBe(false);
    expect(switchEl()).toHaveAttribute("aria-checked", "false");
  });

  it("shows the one-line helper description", () => {
    render(<SettingsMenu />);
    fireEvent.click(trigger());
    expect(
      screen.getByText(/collapses other folders and reveals its own/i),
    ).toBeInTheDocument();
  });

  /* ── config bundles: the only way to reach export/import ───────────────────── */

  it("🔴 opens the EXPORT dialog, which is the feature's only entry point", () => {
    // Without this the whole bundle feature — Rust core, store slice, both dialogs, all of it
    // tested — is unreachable from the UI. That is the shape of two earlier blank-screen bugs,
    // and the rule is explicit: built is not the bar, working is.
    render(<SettingsMenu />);
    fireEvent.click(trigger());
    fireEvent.click(screen.getByTestId("settings-export-config"));
    expect(useAppStore.getState().portabilityDialog).toBe("export");
  });

  it("opens the IMPORT dialog", () => {
    render(<SettingsMenu />);
    fireEvent.click(trigger());
    fireEvent.click(screen.getByTestId("settings-import-config"));
    expect(useAppStore.getState().portabilityDialog).toBe("import");
  });

  it("closes the popover when either opens, so a menu cannot sit behind a modal", () => {
    render(<SettingsMenu />);
    fireEvent.click(trigger());
    fireEvent.click(screen.getByTestId("settings-export-config"));
    // Two surfaces claiming focus is how a modal stops being modal.
    expect(screen.queryByTestId("settings-popover")).toBeNull();
  });

  it("describes what each one does, since one of them shares secrets", () => {
    render(<SettingsMenu />);
    fireEvent.click(trigger());
    expect(screen.getByText(/Share your database connections and API requests/i)).toBeInTheDocument();
    // The import hint promises a REVIEW before anything lands (import is inspect-then-apply)
    // — the menu should not imply a one-click import.
    expect(screen.getByText(/before anything is added/i)).toBeInTheDocument();
  });
});
