/**
 * ClaudeMcpItem — "Add Agent Studio to Claude Code" in the Settings menu.
 *
 * Covers what the user sees and what a click runs, for every state Claude Code can be in: asked on
 * mount (disabled, with the reason, until it answers), add → "Remove", remove → "Add", another
 * copy of the app → re-point, no Claude Code → disabled with the reason, a failure → the reason
 * and the add again; and that an answer arriving after the menu closed goes nowhere.
 *
 * The IPC module is mocked: these tests are about which action a click runs and what the item
 * says, which a store-level or Rust test cannot see.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ClaudeMcpReport } from "./claudeMcpIpc";

const ipc = vi.hoisted(() => ({
  claudeMcpStatus: vi.fn(),
  claudeMcpInstall: vi.fn(),
  claudeMcpUninstall: vi.fn(),
}));
vi.mock("./claudeMcpIpc", () => ipc);

import { ClaudeMcpItem } from "./ClaudeMcpItem";

const ADD = "Add Agent Studio to Claude Code";
const REMOVE = "Remove Agent Studio from Claude Code";

function report(over: Partial<ClaudeMcpReport>): ClaudeMcpReport {
  return {
    ok: true,
    state: "notInstalled",
    message: "a sentence from Rust",
    configured: null,
    scope: null,
    exe: "/Applications/Agent Studio.app/Contents/MacOS/agent-studio",
    ...over,
  };
}

/** A promise the test settles when it chooses. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const item = () => screen.getByTestId("settings-claude-mcp");
const hint = () => screen.getByTestId("settings-claude-mcp-hint");

/** Render with Claude Code answering `status`, and wait until the item shows it. */
async function renderAnswered(status: ClaudeMcpReport): Promise<void> {
  ipc.claudeMcpStatus.mockResolvedValue(status);
  render(<ClaudeMcpItem />);
  await screen.findByText((_, el) => el?.getAttribute("data-state") === status.state);
}

beforeEach(() => {
  ipc.claudeMcpStatus.mockReset();
  ipc.claudeMcpInstall.mockReset();
  ipc.claudeMcpUninstall.mockReset();
});
afterEach(cleanup);

describe("ClaudeMcpItem", () => {
  it("asks Claude Code when it mounts, and says so until it answers", async () => {
    const status = deferred<ClaudeMcpReport>();
    ipc.claudeMcpStatus.mockReturnValue(status.promise);
    render(<ClaudeMcpItem />);

    expect(ipc.claudeMcpStatus).toHaveBeenCalledTimes(1);
    expect(item()).toBeDisabled();
    expect(item()).toHaveAttribute("aria-busy", "true");
    expect(item()).toHaveAttribute("data-state", "checking");
    expect(item()).toHaveTextContent(ADD);
    expect(hint()).toHaveTextContent("Checking Claude Code…");

    await act(async () => status.resolve(report({ state: "notInstalled" })));
    expect(item()).toBeEnabled();
    expect(item()).toHaveAttribute("aria-busy", "false");
    expect(item()).toHaveAttribute("data-state", "notInstalled");
    expect(hint()).toHaveTextContent(/database and API tools/);
    expect(hint()).toHaveTextContent(/claude mcp add/);
    expect(ipc.claudeMcpInstall).not.toHaveBeenCalled();
  });

  it("adds on click, shows the work while Claude Code runs, then offers to remove it", async () => {
    await renderAnswered(report({ state: "notInstalled" }));
    const done = deferred<ClaudeMcpReport>();
    ipc.claudeMcpInstall.mockReturnValue(done.promise);

    fireEvent.click(item());
    expect(ipc.claudeMcpInstall).toHaveBeenCalledTimes(1);
    expect(item()).toBeDisabled();
    expect(item()).toHaveTextContent("Adding Agent Studio to Claude Code…");
    expect(hint()).toHaveTextContent("Running claude mcp add…");

    await act(async () => done.resolve(report({ state: "installed" })));
    expect(item()).toHaveTextContent(REMOVE);
    expect(hint()).toHaveTextContent(/^Added:/);
    expect(ipc.claudeMcpUninstall).not.toHaveBeenCalled();
  });

  it("removes on click when it is added", async () => {
    await renderAnswered(report({ state: "installed" }));
    expect(item()).toHaveTextContent(REMOVE);
    const done = deferred<ClaudeMcpReport>();
    ipc.claudeMcpUninstall.mockReturnValue(done.promise);

    fireEvent.click(item());
    expect(ipc.claudeMcpUninstall).toHaveBeenCalledTimes(1);
    expect(item()).toHaveTextContent("Removing Agent Studio from Claude Code…");
    expect(hint()).toHaveTextContent("Running claude mcp remove…");

    await act(async () => done.resolve(report({ state: "notInstalled" })));
    expect(item()).toHaveTextContent(ADD);
    expect(ipc.claudeMcpInstall).not.toHaveBeenCalled();
  });

  it("names another copy of the app Claude Code runs, and points it here on click", async () => {
    await renderAnswered(report({ state: "different", configured: "/Volumes/Old/agent-studio" }));
    expect(item()).toHaveTextContent("Point Claude Code at this Agent Studio");
    expect(hint()).toHaveTextContent("/Volumes/Old/agent-studio");
    ipc.claudeMcpInstall.mockReturnValue(new Promise(() => {}));
    fireEvent.click(item());
    expect(ipc.claudeMcpInstall).toHaveBeenCalledTimes(1);
  });

  it("says 'unknown' rather than nothing when the other copy has no path", async () => {
    await renderAnswered(report({ state: "different", configured: null }));
    expect(hint()).toHaveTextContent(/another copy: unknown$/);
  });

  it("without Claude Code it is disabled, and its line says why", async () => {
    const message = "Claude Code was not found: install Claude Code, or set AGENTSTUDIO_CLAUDE_BIN.";
    await renderAnswered(report({ ok: false, state: "claudeMissing", message }));
    expect(item()).toBeDisabled();
    expect(item()).toHaveTextContent(ADD);
    expect(hint()).toHaveTextContent(message);
    expect(hint()).toHaveClass("settings-menu__hint--problem");
    fireEvent.click(item());
    expect(ipc.claudeMcpInstall).not.toHaveBeenCalled();
  });

  it("a failure shows Claude Code's reason and offers the add again", async () => {
    await renderAnswered(report({ ok: false, state: "failed", message: "boom: the config is locked" }));
    expect(item()).toBeEnabled();
    expect(hint()).toHaveTextContent("boom: the config is locked");
    expect(hint()).toHaveClass("settings-menu__hint--problem");
    ipc.claudeMcpInstall.mockReturnValue(new Promise(() => {}));
    fireEvent.click(item());
    expect(ipc.claudeMcpInstall).toHaveBeenCalledTimes(1);
  });

  it("a normal state is not styled as a problem", async () => {
    await renderAnswered(report({ state: "installed" }));
    expect(hint()).not.toHaveClass("settings-menu__hint--problem");
  });

  it("an answer that arrives after the menu closed goes nowhere", async () => {
    const status = deferred<ClaudeMcpReport>();
    ipc.claudeMcpStatus.mockReturnValue(status.promise);
    const first = render(<ClaudeMcpItem />);
    first.unmount();
    await act(async () => status.resolve(report({ state: "installed" })));

    // A click's answer, too.
    await renderAnswered(report({ state: "notInstalled" }));
    const done = deferred<ClaudeMcpReport>();
    ipc.claudeMcpInstall.mockReturnValue(done.promise);
    fireEvent.click(item());
    cleanup();
    await act(async () => done.resolve(report({ state: "installed" })));
    expect(screen.queryByTestId("settings-claude-mcp")).toBeNull();
  });
});
