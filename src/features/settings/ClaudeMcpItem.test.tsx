/**
 * ClaudeMcpItem — "Add Agent Studio to Claude Code" in the Settings menu.
 *
 * Covers what the user sees and what a click runs, for every state Claude Code can be in: asked on
 * mount (disabled, with the reason, until it answers), add → "Remove", remove → "Add", another
 * copy of the app → re-point, an entry in a scope that wins → the reason, no Claude Code →
 * disabled with the reason, a failure → the reason and the same action again (a failed removal
 * offers the removal). And across opens of the menu: a recent answer is shown without asking
 * Claude Code again, a reopen joins the run still going, and an answer that arrived while the
 * menu was closed is shown on the next open.
 *
 * The IPC module is mocked (the runs module is real): these tests are about which action a click
 * runs and what the item says, which a store-level or Rust test cannot see.
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
import { forgetClaudeMcpRuns, FRESH_MS } from "./claudeMcpRuns";

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
  forgetClaudeMcpRuns();
  ipc.claudeMcpStatus.mockReset();
  ipc.claudeMcpInstall.mockReset();
  ipc.claudeMcpUninstall.mockReset();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

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

  it("a failed removal shows the reason and still offers the removal, not the add", async () => {
    await renderAnswered(report({ state: "installed" }));
    ipc.claudeMcpUninstall.mockResolvedValueOnce(
      report({ ok: false, state: "failed", message: "Claude Code did not remove it: locked" }),
    );
    await act(async () => fireEvent.click(item()));
    expect(item()).toHaveAttribute("data-state", "failed");
    expect(item()).toHaveTextContent(REMOVE);
    expect(hint()).toHaveTextContent("Claude Code did not remove it: locked");
    expect(hint()).toHaveClass("settings-menu__hint--problem");

    ipc.claudeMcpUninstall.mockReturnValue(new Promise(() => {}));
    fireEvent.click(item());
    expect(ipc.claudeMcpUninstall).toHaveBeenCalledTimes(2);
    expect(ipc.claudeMcpInstall).not.toHaveBeenCalled();
  });

  it("an entry in Claude Code's local config is named with how to remove it, and an add re-checks", async () => {
    const message = "Claude Code's `agent-studio` server comes from its Local config … `claude mcp remove agent-studio -s local` …";
    await renderAnswered(report({ state: "shadowed", scope: "Local config (private to you in this project)", message }));
    expect(item()).toBeEnabled();
    expect(item()).toHaveTextContent(ADD);
    expect(hint()).toHaveTextContent(message);
    expect(hint()).toHaveClass("settings-menu__hint--problem");
    ipc.claudeMcpInstall.mockReturnValue(new Promise(() => {}));
    fireEvent.click(item());
    expect(ipc.claudeMcpInstall).toHaveBeenCalledTimes(1);
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

  it("an answer that arrives after the menu closed is shown when it opens again, without asking again", async () => {
    const status = deferred<ClaudeMcpReport>();
    ipc.claudeMcpStatus.mockReturnValue(status.promise);
    render(<ClaudeMcpItem />).unmount();
    await act(async () => status.resolve(report({ state: "installed" })));

    render(<ClaudeMcpItem />);
    expect(item()).toHaveAttribute("data-state", "installed");
    expect(item()).toHaveTextContent(REMOVE);
    expect(ipc.claudeMcpStatus).toHaveBeenCalledTimes(1);
  });

  it("a recent answer is reused: opening the menu again does not start another claude mcp get", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    await renderAnswered(report({ state: "notInstalled" }));
    cleanup();

    now += FRESH_MS - 1;
    render(<ClaudeMcpItem />);
    expect(item()).toHaveAttribute("data-state", "notInstalled");
    expect(item()).toBeEnabled();
    expect(ipc.claudeMcpStatus).toHaveBeenCalledTimes(1);
    cleanup();

    // Past FRESH_MS it asks again.
    now += 1;
    ipc.claudeMcpStatus.mockResolvedValue(report({ state: "installed" }));
    render(<ClaudeMcpItem />);
    expect(item()).toHaveAttribute("data-state", "checking");
    await screen.findByText(REMOVE);
    expect(ipc.claudeMcpStatus).toHaveBeenCalledTimes(2);
  });

  it("a failed status is not kept: the next open asks again", async () => {
    await renderAnswered(report({ ok: false, state: "failed", message: "boom" }));
    cleanup();
    ipc.claudeMcpStatus.mockResolvedValue(report({ state: "notInstalled" }));
    render(<ClaudeMcpItem />);
    expect(item()).toHaveAttribute("data-state", "checking");
    await screen.findByText((_, el) => el?.getAttribute("data-state") === "notInstalled");
    expect(ipc.claudeMcpStatus).toHaveBeenCalledTimes(2);
  });

  it("reopened while an add is running, it shows the add and waits for it; nothing else runs", async () => {
    await renderAnswered(report({ state: "notInstalled" }));
    const done = deferred<ClaudeMcpReport>();
    ipc.claudeMcpInstall.mockReturnValue(done.promise);
    fireEvent.click(item());
    cleanup();

    render(<ClaudeMcpItem />);
    expect(item()).toBeDisabled();
    expect(item()).toHaveAttribute("data-state", "working");
    expect(item()).toHaveTextContent("Adding Agent Studio to Claude Code…");
    expect(ipc.claudeMcpStatus).toHaveBeenCalledTimes(1);

    // A failed add answered here is shown here, with the add to retry.
    await act(async () => done.resolve(report({ ok: false, state: "failed", message: "Claude Code did not add it: x" })));
    expect(item()).toHaveTextContent(ADD);
    expect(hint()).toHaveTextContent("Claude Code did not add it: x");
    expect(ipc.claudeMcpInstall).toHaveBeenCalledTimes(1);
    expect(ipc.claudeMcpStatus).toHaveBeenCalledTimes(1);
    expect(ipc.claudeMcpUninstall).not.toHaveBeenCalled();
  });

  it("reopened while the status is still being asked, it waits for that answer instead of asking again", async () => {
    const status = deferred<ClaudeMcpReport>();
    ipc.claudeMcpStatus.mockReturnValue(status.promise);
    render(<ClaudeMcpItem />).unmount();
    render(<ClaudeMcpItem />);
    expect(item()).toHaveAttribute("data-state", "checking");
    await act(async () => status.resolve(report({ state: "installed" })));
    expect(item()).toHaveAttribute("data-state", "installed");
    expect(ipc.claudeMcpStatus).toHaveBeenCalledTimes(1);
  });
});
