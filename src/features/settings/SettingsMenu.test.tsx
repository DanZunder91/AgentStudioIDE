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

// "Add Agent Studio to Claude Code" asks Claude Code for its status when the popover opens. Left
// pending here so no test in this file reaches Tauri; ClaudeMcpItem.test.tsx covers the answers.
const claudeMcpIpc = vi.hoisted(() => ({
  claudeMcpStatus: vi.fn(),
  claudeMcpInstall: vi.fn(),
  claudeMcpUninstall: vi.fn(),
}));
vi.mock("./claudeMcpIpc", () => claudeMcpIpc);

import { useAppStore } from "../../app/store";
import { resetStore } from "../../test/store-harness";
import { forgetClaudeMcpRuns } from "./claudeMcpRuns";
import { SettingsMenu } from "./SettingsMenu";

const popover = () => screen.queryByTestId("settings-popover");
const trigger = () => screen.getByLabelText("Settings");
const switchEl = () => screen.getByRole("switch");

beforeEach(() => {
  resetStore();
  useAppStore.setState((s) => {
    s.focusFollowsAgent = false;
    s.railGroupStyle = "card";
  });
  layoutPrefsIpc.saveLayoutPrefs.mockClear();
  forgetClaudeMcpRuns();
  claudeMcpIpc.claudeMcpStatus.mockReset().mockReturnValue(new Promise(() => {}));
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

  /* ── Agent Studio's tools in Claude Code ──────────────────────────────────── */

  it("holds 'Add Agent Studio to Claude Code', the UI way to `agent-studio mcp install`", () => {
    render(<SettingsMenu />);
    fireEvent.click(trigger());
    const item = screen.getByTestId("settings-claude-mcp");
    expect(item).toHaveAttribute("role", "menuitem");
    expect(item).toHaveTextContent("Add Agent Studio to Claude Code");
    expect(item).toHaveTextContent("Checking Claude Code…");
  });

  it("asks Claude Code when the menu opens and never before; a reopen while it answers asks nothing new", () => {
    render(<SettingsMenu />);
    // A closed menu runs nothing: the vendor CLI runs on the user's action only.
    expect(claudeMcpIpc.claudeMcpStatus).not.toHaveBeenCalled();
    fireEvent.click(trigger());
    expect(claudeMcpIpc.claudeMcpStatus).toHaveBeenCalledTimes(1);
    // Closed and opened again while `claude mcp get` is still running: it waits for that one.
    fireEvent.click(trigger());
    fireEvent.click(trigger());
    expect(screen.getByTestId("settings-claude-mcp")).toHaveTextContent("Checking Claude Code…");
    expect(claudeMcpIpc.claudeMcpStatus).toHaveBeenCalledTimes(1);
    expect(claudeMcpIpc.claudeMcpInstall).not.toHaveBeenCalled();
    expect(claudeMcpIpc.claudeMcpUninstall).not.toHaveBeenCalled();
  });
});

describe("SettingsMenu — Interface page", () => {
  const openInterface = () => {
    fireEvent.click(trigger());
    fireEvent.click(screen.getByTestId("settings-interface"));
  };
  const choice = (style: string) => screen.getByTestId(`rail-group-style-${style}`);
  const lastSaved = () => {
    const calls = layoutPrefsIpc.saveLayoutPrefs.mock.calls;
    expect(calls.length, "saveLayoutPrefs should have run").toBeGreaterThan(0);
    return calls[calls.length - 1][0] as { railGroupStyle?: string };
  };

  it("the first page names the current project style beside the Interface item", () => {
    useAppStore.setState((s) => {
      s.railGroupStyle = "well";
    });
    render(<SettingsMenu />);
    fireEvent.click(trigger());
    expect(screen.getByTestId("settings-interface")).toHaveTextContent("Project groups: Inset well");
  });

  it("opens the Interface page in place of the first page", () => {
    render(<SettingsMenu />);
    openInterface();
    expect(screen.getByRole("menu", { name: "Interface settings" })).toBeInTheDocument();
    // The first page's controls are gone: one page at a time.
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByTestId("settings-export-config")).toBeNull();
  });

  it("lists the four project styles, Framed card marked as the default", () => {
    render(<SettingsMenu />);
    openInterface();
    const radios = screen.getAllByRole("menuitemradio");
    expect(radios.map((r) => r.getAttribute("data-testid"))).toEqual([
      "rail-group-style-card",
      "rail-group-style-well",
      "rail-group-style-divider",
      "rail-group-style-pinned",
    ]);
    expect(choice("card")).toHaveTextContent("Framed card · default");
    expect(choice("well")).not.toHaveTextContent("default");
  });

  it("checks exactly the store's style", () => {
    useAppStore.setState((s) => {
      s.railGroupStyle = "divider";
    });
    render(<SettingsMenu />);
    openInterface();
    expect(choice("divider")).toHaveAttribute("aria-checked", "true");
    for (const other of ["card", "well", "pinned"]) {
      expect(choice(other)).toHaveAttribute("aria-checked", "false");
    }
  });

  it("🔴 choosing a style sets it in the store and persists it", () => {
    render(<SettingsMenu />);
    openInterface();

    fireEvent.click(choice("pinned"));

    expect(useAppStore.getState().railGroupStyle).toBe("pinned");
    expect(lastSaved().railGroupStyle).toBe("pinned");
    expect(choice("pinned")).toHaveAttribute("aria-checked", "true");
    expect(choice("card")).toHaveAttribute("aria-checked", "false");
    // The page stays open, so the choice can be compared against the rail.
    expect(screen.getByRole("menu", { name: "Interface settings" })).toBeInTheDocument();
  });

  it("Back returns to the first page and puts focus back on the Interface item", () => {
    render(<SettingsMenu />);
    openInterface();
    expect(screen.getByTestId("settings-back")).toHaveFocus();

    fireEvent.click(screen.getByTestId("settings-back"));

    expect(screen.getByRole("menu", { name: "Settings menu" })).toBeInTheDocument();
    expect(screen.getByTestId("settings-interface")).toHaveFocus();
  });

  it("reopening the menu starts on the first page", () => {
    render(<SettingsMenu />);
    openInterface();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(popover()).toBeNull();

    fireEvent.click(trigger());
    expect(screen.getByRole("menu", { name: "Settings menu" })).toBeInTheDocument();
  });

  it("a click inside the Interface page does not close the menu", () => {
    render(<SettingsMenu />);
    openInterface();
    fireEvent.mouseDown(choice("well"));
    expect(popover()).not.toBeNull();
  });
});
