/**
 * The terminal-close confirmation, driven through the REAL store.
 *
 * Closing a terminal that is running claude must first ask for confirmation.
 *
 * # Why this suite exists beside `store.test.ts`
 *
 * There are FOUR gestures that can kill a running terminal, and they do not
 * share a code path — the tab ✕ and Cmd/Ctrl+W converge on `requestCloseTab`,
 * the pane ✕ goes through `requestClosePane`, the fleet rail's ✕ through
 * `requestDismissAgent`. Three of the four once bypassed the confirm entirely,
 * and "one of them still does" is exactly the bug a user would find and a
 * per-action unit test would not (two covered halves do not add up to a
 * working feature — test the seam). So every
 * path is exercised here, against the same store the app runs.
 *
 * # Every path is asserted TWO-SIDED
 *
 * The failure this feature must not have is **a dialog that appears and then the
 * terminal dies anyway**, and its mirror is **a gate that never lets go**. An
 * assertion on `pendingTerminalClose` alone is satisfied by the first of those:
 * a build that raises the dialog *and* disposes the PTY passes it. So each path
 * asserts both arms, and the busy arm always asserts the terminal was **not
 * disposed** — `dispose` is the call that reaches `terminal_close` in Rust, so
 * it is the observable that means "the session is gone", and it is mocked here
 * precisely so its call count is assertable.
 *
 * # 🔴 Closing is ASYNCHRONOUS now
 *
 * The gate awaits an IPC round trip before it either closes or holds. A
 * synchronous assertion right after a close gesture reads the state from before
 * the answer arrived — it would pass on the busy path for the wrong reason and
 * fail on the idle one. `settleGate()` below is the boundary every test crosses.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// `store.ts` calls `dispose(terminalId)` through the terminal barrel — the seam
// where a close becomes a dead PTY. Mocked so "was the terminal killed?" is a
// call count rather than a guess. Same three exports `store.test.ts` stubs.
// (A factory mock is a frozen copy of the module's surface — if the
// store starts importing a fourth name from this barrel, this list must grow
// with it, or the break surfaces as an Unhandled Error beside green tests.)
const terminal = vi.hoisted(() => ({
  configureTerminal: vi.fn(),
  dispose: vi.fn(),
  setDefaultTerminalCwd: vi.fn(),
}));
vi.mock("./index", () => terminal);

// The busy question itself. Mocked so a test can say "claude is running in this
// one" without a backend; its own wire behaviour is pinned in
// `terminalBusyIpc.test.ts`.
const busyIpc = vi.hoisted(() => ({ terminalsBusy: vi.fn() }));
vi.mock("./terminalBusyIpc", () => busyIpc);

// `<Pane>` mounts the real xterm host for its active tab; the two call-site
// tests at the bottom of this file need a pane whose active tab is a TERMINAL,
// which is precisely the tab that cannot be mounted under jsdom. Same stub
// `Pane.test.tsx` uses, for the same reason.
vi.mock("./TerminalView", () => ({ TerminalView: () => null }));

import { findNode, useAppStore } from "../../app/store";
import {
  asTerminalId,
  type AgentId,
  type LeafNode,
  type PaneId,
  type TabId,
  type TerminalId,
} from "../../app/types";
import { resetFleetStore } from "../../test/fleet-harness";
import { assertLiveStoreInvariants, resetStore } from "../../test/store-harness";
import { Pane } from "../../components/Pane";
import { AgentRow } from "../fleet/AgentRow";
import type { BusyTerminal } from "./terminalBusyIpc";

const state = () => useAppStore.getState();
const layout = () => state().layoutActions;
const editors = () => state().editorActions;
const fleet = () => state().agentActions;

/**
 * Let the gate's IPC round trip settle.
 *
 * A macrotask boundary drains the ENTIRE microtask queue, so this does not
 * depend on counting `await` hops inside `gateTerminalClose` — a refactor that
 * adds one more `await` cannot silently turn these tests into assertions about
 * the state before the answer arrived.
 */
const settleGate = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** The terminal behind a terminal/agent-terminal tab; throws for anything else. */
const terminalIdOf = (tabId: TabId): TerminalId => {
  const ref = state().tabs[tabId]?.ref;
  if (!ref || (ref.kind !== "terminal" && ref.kind !== "agent-terminal")) {
    throw new Error(`tab ${tabId} is not a terminal tab`);
  }
  return ref.terminalId;
};

/** What the backend reports for a terminal with a live claude session in it. */
const runningClaude = (id: TerminalId, label = "Fix the parser"): BusyTerminal => ({
  id,
  reason: "agent",
  label,
});

/** Split the focused pane and return both halves; the new one takes focus. */
const splitOff = (): { origin: PaneId; created: PaneId } => {
  const origin = state().focusedPaneId;
  const created = layout().splitPane(origin, "row");
  return { origin, created };
};

beforeEach(() => {
  resetStore();
  resetFleetStore();
  terminal.dispose.mockClear();
  terminal.configureTerminal.mockClear();
  busyIpc.terminalsBusy.mockReset();
  // Default: nothing is running. Every test about the busy side says so itself,
  // which keeps "this test is about the gate holding" visible at the test.
  busyIpc.terminalsBusy.mockResolvedValue([]);
});

/* ═══════════════════ path 1 — the tab ✕ / middle-click ═══════════════════ */

describe("the tab ✕ (requestCloseTab)", () => {
  it("BUSY: holds the close — the tab survives and the terminal is NOT disposed", async () => {
    const tabId = layout().openTerminalTab();
    const terminalId = terminalIdOf(tabId);
    busyIpc.terminalsBusy.mockResolvedValue([runningClaude(terminalId)]);

    editors().requestCloseTab(tabId);
    await settleGate();

    // It asked about exactly this terminal…
    expect(busyIpc.terminalsBusy).toHaveBeenCalledWith([terminalId]);
    // …held the gesture verbatim, so the confirm can replay it…
    expect(state().pendingTerminalClose).toEqual({
      scope: { kind: "tab", tabId },
      terminals: [runningClaude(terminalId)],
    });
    // …and changed NOTHING else. The tab is still there…
    expect(state().tabs[tabId]).toBeDefined();
    // …and this is the half a "prompt, then kill it anyway" build fails.
    expect(terminal.dispose).not.toHaveBeenCalled();
    assertLiveStoreInvariants();
  });

  it("a busy COMMAND is named by its tab's title (custom name first), never the shell program", async () => {
    // The backend labels a busy shell with its program — "powershell" on Windows, "zsh" on
    // macOS — which is not what the tab says (the dialog would read "powershell has a
    // command still running" over a tab with another name).
    const tabId = layout().openTerminalTab();
    const terminalId = terminalIdOf(tabId);
    const shown = state().tabs[tabId].title;
    expect(shown).not.toBe("powershell");
    busyIpc.terminalsBusy.mockResolvedValue([{ id: terminalId, reason: "command", label: "powershell" }]);

    editors().requestCloseTab(tabId);
    await settleGate();
    expect(state().pendingTerminalClose?.terminals).toEqual([
      { id: terminalId, reason: "command", label: shown },
    ]);

    // A renamed tab: its custom name wins.
    layout().cancelTerminalClose();
    useAppStore.setState((s) => {
      s.tabs[tabId].customTitle = "build server";
    });
    editors().requestCloseTab(tabId);
    await settleGate();
    expect(state().pendingTerminalClose?.terminals[0].label).toBe("build server");
    expect(terminal.dispose).not.toHaveBeenCalled();
  });

  it("a tab with no terminal behind it never consults the gate at all", async () => {
    // An editor tab has its own unsaved-changes confirm; routing it through the
    // terminal question would put an IPC hop on every file close and could show
    // the wrong dialog entirely (`confirmCloseTab` narrows on `kind === editor`).
    const tabId = layout().openEditorTab("/w/gazelle/README.md");

    editors().requestCloseTab(tabId);
    await settleGate();

    expect(busyIpc.terminalsBusy).not.toHaveBeenCalled();
    expect(state().tabs[tabId]).toBeUndefined();
    expect(state().pendingTerminalClose).toBeNull();
  });

  it("NOT busy: closes on the first click, with nothing left pending", async () => {
    const tabId = layout().openTerminalTab();
    const terminalId = terminalIdOf(tabId);

    editors().requestCloseTab(tabId);
    await settleGate();

    expect(state().tabs[tabId]).toBeUndefined();
    expect(terminal.dispose).toHaveBeenCalledWith(terminalId);
    // The mirror of the busy case: a gate that never lets go is the same bug wearing the
    // other face. An idle terminal must never raise the dialog.
    expect(state().pendingTerminalClose).toBeNull();
    assertLiveStoreInvariants();
  });
});

/* ═══════════════════════ path 2 — Cmd/Ctrl+W ═══════════════════════ */

describe("Cmd/Ctrl+W (closeActiveTab)", () => {
  it("BUSY: holds the close of the ACTIVE tab, and disposes nothing", async () => {
    const idle = layout().openTerminalTab();
    const active = layout().openTerminalTab(); // the later tab is the active one
    busyIpc.terminalsBusy.mockResolvedValue([runningClaude(terminalIdOf(active))]);

    layout().closeActiveTab();
    await settleGate();

    expect(state().pendingTerminalClose).toEqual({
      scope: { kind: "tab", tabId: active },
      terminals: [runningClaude(terminalIdOf(active))],
    });
    expect(state().tabs[active]).toBeDefined();
    // The neighbour was never in play — pinned so a future "close the pane
    // instead" refactor of this keybinding cannot go unnoticed.
    expect(state().tabs[idle]).toBeDefined();
    expect(terminal.dispose).not.toHaveBeenCalled();
    assertLiveStoreInvariants();
  });

  it("NOT busy: closes the active tab immediately", async () => {
    const idle = layout().openTerminalTab();
    const active = layout().openTerminalTab();
    const terminalId = terminalIdOf(active);

    layout().closeActiveTab();
    await settleGate();

    expect(state().tabs[active]).toBeUndefined();
    expect(state().tabs[idle]).toBeDefined();
    expect(terminal.dispose).toHaveBeenCalledWith(terminalId);
    expect(state().pendingTerminalClose).toBeNull();
    assertLiveStoreInvariants();
  });
});

/* ═════════════════════════ path 3 — the pane ✕ ═════════════════════════ */

describe("the pane ✕ (requestClosePane)", () => {
  it("BUSY: holds the close — the pane, its tab and its terminal all survive", async () => {
    // The sharpest version of the problem: one click, every terminal
    // in the pane, no undo.
    const { created } = splitOff();
    const tabId = layout().openTerminalTab({ paneId: created });
    const terminalId = terminalIdOf(tabId);
    busyIpc.terminalsBusy.mockResolvedValue([runningClaude(terminalId)]);

    layout().requestClosePane(created);
    await settleGate();

    expect(busyIpc.terminalsBusy).toHaveBeenCalledWith([terminalId]);
    expect(state().pendingTerminalClose).toEqual({
      scope: { kind: "pane", paneId: created },
      terminals: [runningClaude(terminalId)],
    });
    expect(findNode(state().layout, created)).not.toBeNull();
    expect(state().tabs[tabId]).toBeDefined();
    expect(terminal.dispose).not.toHaveBeenCalled();
    assertLiveStoreInvariants();
  });

  it("NOT busy: closes the pane immediately", async () => {
    const { created } = splitOff();
    const tabId = layout().openTerminalTab({ paneId: created });
    const terminalId = terminalIdOf(tabId);

    layout().requestClosePane(created);
    await settleGate();

    // The emptied leaf is pruned by canonicalize — the split collapses back.
    expect(findNode(state().layout, created)).toBeNull();
    expect(state().tabs[tabId]).toBeUndefined();
    expect(terminal.dispose).toHaveBeenCalledWith(terminalId);
    expect(state().pendingTerminalClose).toBeNull();
    assertLiveStoreInvariants();
  });

  it("a pane holding NO terminals closes with no round trip at all", async () => {
    // An editor tab has no PTY, so there is nothing to lose and nothing to ask
    // about. Asking anyway would put an IPC hop on a click whose only possible
    // answer is already known.
    const { created } = splitOff(); // the new leaf takes focus, so the editor lands here
    const tabId = layout().openEditorTab("/w/gazelle/README.md");
    expect(findNode(state().layout, created)?.type).toBe("leaf");

    layout().requestClosePane(created);
    await settleGate();

    expect(busyIpc.terminalsBusy).not.toHaveBeenCalled();
    expect(state().tabs[tabId]).toBeUndefined();
    expect(findNode(state().layout, created)).toBeNull();
    expect(state().pendingTerminalClose).toBeNull();
  });

  it("a paneId that no longer exists is a total no-op — no round trip, no crash", async () => {
    // A stale id is not hypothetical: canonicalize prunes an emptied leaf, so a
    // toolbar that re-fires (double click, a queued event) hands this a paneId
    // the tree no longer contains. It must fall through to `closePane`'s own
    // no-op rather than ask Rust about a pane that is already gone.
    const { origin, created } = splitOff();
    layout().closePane(created); // prunes the empty leaf; the split collapses
    expect(findNode(state().layout, created)).toBeNull();

    layout().requestClosePane(created);
    await settleGate();

    expect(busyIpc.terminalsBusy).not.toHaveBeenCalled();
    expect(state().pendingTerminalClose).toBeNull();
    expect(state().layout.id).toBe(origin);
    assertLiveStoreInvariants();
  });

  it("a SPLIT node's id is a no-op too — only leaves hold terminals", async () => {
    // The other half of the same guard. `findNode` happily returns a split, and
    // a split has no `tabIds`; reading them would throw on the path of a click.
    const { created } = splitOff();
    layout().openTerminalTab({ paneId: created });
    const splitId = state().layout.id;
    expect(state().layout.type).toBe("split");

    layout().requestClosePane(splitId);
    await settleGate();

    expect(busyIpc.terminalsBusy).not.toHaveBeenCalled();
    expect(state().pendingTerminalClose).toBeNull();
    expect(state().layout.id).toBe(splitId);
    expect(terminal.dispose).not.toHaveBeenCalled();
    assertLiveStoreInvariants();
  });

  it("gates when only SOME of the pane's terminals are busy — the idle sibling lives too", async () => {
    const { created } = splitOff();
    const idleTab = layout().openTerminalTab({ paneId: created });
    const busyTab = layout().openTerminalTab({ paneId: created });
    const idleTerm = terminalIdOf(idleTab);
    const busyTerm = terminalIdOf(busyTab);
    busyIpc.terminalsBusy.mockResolvedValue([runningClaude(busyTerm)]);

    layout().requestClosePane(created);
    await settleGate();

    // One batched question for the whole pane, not one per terminal.
    expect(busyIpc.terminalsBusy).toHaveBeenCalledTimes(1);
    expect(busyIpc.terminalsBusy).toHaveBeenCalledWith([idleTerm, busyTerm]);
    // The dialog names only what is actually running…
    expect(state().pendingTerminalClose?.terminals).toEqual([runningClaude(busyTerm)]);
    // …but the HOLD covers the whole gesture: the idle neighbour would have died
    // in the same click, so it must still be here.
    expect(state().tabs[idleTab]).toBeDefined();
    expect(state().tabs[busyTab]).toBeDefined();
    expect(terminal.dispose).not.toHaveBeenCalled();
  });
});

/* ═══════════════════ path 4 — the fleet rail's agent ✕ ═══════════════════ */

describe("the agent rail ✕ (requestDismissAgent)", () => {
  it("BUSY: holds the dismissal — the agent, its tab and its PTY all survive", async () => {
    const agentId = fleet().createAgent({ cwd: "/w/gazelle" });
    // An agent terminal's TerminalId IS its AgentId (store.ts `openTerminalTab`).
    const terminalId = asTerminalId(agentId);
    busyIpc.terminalsBusy.mockResolvedValue([runningClaude(terminalId)]);

    fleet().requestDismissAgent(agentId);
    await settleGate();

    expect(busyIpc.terminalsBusy).toHaveBeenCalledWith([terminalId]);
    expect(state().pendingTerminalClose).toEqual({
      scope: { kind: "agent", agentId },
      terminals: [runningClaude(terminalId)],
    });
    expect(state().agents[agentId]).toBeDefined();
    expect(state().rootAgentIds).toContain(agentId);
    expect(Object.values(state().tabs)).toHaveLength(1);
    expect(terminal.dispose).not.toHaveBeenCalled();
  });

  it("NOT busy: dismisses immediately — row, tab and PTY all gone", async () => {
    const agentId = fleet().createAgent({ cwd: "/w/gazelle" });

    fleet().requestDismissAgent(agentId);
    await settleGate();

    expect(state().agents[agentId]).toBeUndefined();
    expect(state().rootAgentIds).not.toContain(agentId);
    expect(Object.values(state().tabs)).toHaveLength(0);
    expect(terminal.dispose).toHaveBeenCalledWith(agentId);
    expect(state().pendingTerminalClose).toBeNull();
  });
});

/* ═════════════════════ the dialog's two answers ═════════════════════ */

describe("cancelTerminalClose", () => {
  it("leaves everything alive and clears the pending record", async () => {
    const tabId = layout().openTerminalTab();
    busyIpc.terminalsBusy.mockResolvedValue([runningClaude(terminalIdOf(tabId))]);
    editors().requestCloseTab(tabId);
    await settleGate();
    expect(state().pendingTerminalClose).not.toBeNull();

    layout().cancelTerminalClose();

    expect(state().pendingTerminalClose).toBeNull();
    expect(state().tabs[tabId]).toBeDefined();
    // "No" means no: the terminal is still running after the dialog closes.
    expect(terminal.dispose).not.toHaveBeenCalled();
    assertLiveStoreInvariants();
  });
});

describe("proceedTerminalClose — one arm per scope kind", () => {
  it("performs a held TAB close", async () => {
    const tabId = layout().openTerminalTab();
    const terminalId = terminalIdOf(tabId);
    busyIpc.terminalsBusy.mockResolvedValue([runningClaude(terminalId)]);
    editors().requestCloseTab(tabId);
    await settleGate();

    layout().proceedTerminalClose();

    expect(state().tabs[tabId]).toBeUndefined();
    expect(terminal.dispose).toHaveBeenCalledWith(terminalId);
    expect(state().pendingTerminalClose).toBeNull();
    // The replay uses the PRIMITIVE, so confirming does not ask again — a second
    // question here would be a loop the user could not escape.
    expect(busyIpc.terminalsBusy).toHaveBeenCalledTimes(1);
    assertLiveStoreInvariants();
  });

  it("performs a held PANE close — every terminal in it, idle ones included", async () => {
    const { created } = splitOff();
    const idleTab = layout().openTerminalTab({ paneId: created });
    const busyTab = layout().openTerminalTab({ paneId: created });
    const idleTerm = terminalIdOf(idleTab);
    const busyTerm = terminalIdOf(busyTab);
    busyIpc.terminalsBusy.mockResolvedValue([runningClaude(busyTerm)]);
    layout().requestClosePane(created);
    await settleGate();

    layout().proceedTerminalClose();

    expect(findNode(state().layout, created)).toBeNull();
    expect(state().tabs[idleTab]).toBeUndefined();
    expect(state().tabs[busyTab]).toBeUndefined();
    expect(terminal.dispose).toHaveBeenCalledWith(idleTerm);
    expect(terminal.dispose).toHaveBeenCalledWith(busyTerm);
    expect(state().pendingTerminalClose).toBeNull();
    expect(busyIpc.terminalsBusy).toHaveBeenCalledTimes(1);
    assertLiveStoreInvariants();
  });

  it("performs a held AGENT dismissal", async () => {
    const agentId = fleet().createAgent({ cwd: "/w/gazelle" });
    busyIpc.terminalsBusy.mockResolvedValue([runningClaude(asTerminalId(agentId))]);
    fleet().requestDismissAgent(agentId);
    await settleGate();

    layout().proceedTerminalClose();

    expect(state().agents[agentId]).toBeUndefined();
    expect(Object.values(state().tabs)).toHaveLength(0);
    expect(terminal.dispose).toHaveBeenCalledWith(agentId);
    expect(state().pendingTerminalClose).toBeNull();
    expect(busyIpc.terminalsBusy).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when nothing is pending", () => {
    // Reachable for real: the dialog unmounts on `cancel`, and a double-fire of
    // the confirm button would otherwise replay a gesture that no longer exists.
    const tabId = layout().openTerminalTab();

    layout().proceedTerminalClose();

    expect(state().tabs[tabId]).toBeDefined();
    expect(terminal.dispose).not.toHaveBeenCalled();
    expect(state().pendingTerminalClose).toBeNull();
  });
});

/* ═══════════ the two ✕ buttons that used to bypass the gate ═══════════ */

/**
 * The store half above is worth nothing if a button still calls the primitive.
 *
 * Two of the four gestures reached `closePane` / `dismissAgent` DIRECTLY, and
 * the component suites cannot see the difference: they only ever close idle
 * terminals, where the gated wrapper and the primitive are indistinguishable by
 * construction (ask which path the test actually exercised). So
 * these two drive the real buttons with something RUNNING behind them, which is
 * the only state in which the wiring is observable at all.
 *
 * Written with `createElement` rather than JSX because this suite is a `.ts`
 * file; the components are the real ones, unmocked.
 */
describe("the rendered ✕ buttons route through the gate", () => {
  it("the PANE toolbar's ✕ asks first (Pane.tsx)", async () => {
    const user = userEvent.setup();
    const { created } = splitOff();
    const tabId = layout().openTerminalTab({ paneId: created });
    const terminalId = terminalIdOf(tabId);
    busyIpc.terminalsBusy.mockResolvedValue([runningClaude(terminalId)]);
    const leaf = findNode(state().layout, created) as LeafNode;

    render(createElement(Pane, { node: leaf }));
    await user.click(screen.getByRole("button", { name: "Close pane" }));
    await settleGate();

    // With `closePane` at the call site this pane would already be gone.
    expect(state().pendingTerminalClose).toEqual({
      scope: { kind: "pane", paneId: created },
      terminals: [runningClaude(terminalId)],
    });
    expect(findNode(state().layout, created)).not.toBeNull();
    expect(state().tabs[tabId]).toBeDefined();
    expect(terminal.dispose).not.toHaveBeenCalled();
  });

  it("the fleet rail's agent ✕ asks first (AgentRow.tsx)", async () => {
    const user = userEvent.setup();
    const agentId = fleet().createAgent({ cwd: "/w/gazelle", title: "Fix the parser" });
    busyIpc.terminalsBusy.mockResolvedValue([runningClaude(asTerminalId(agentId))]);

    render(
      createElement(AgentRow, {
        agentId: agentId as AgentId,
        depth: 0,
        hasChildren: false,
        expanded: true,
        attention: false,
        rollupRunning: 0,
        rollupDone: 0,
        rollupError: 0,
      }),
    );
    await user.click(screen.getByRole("button", { name: "Close agent Fix the parser" }));
    await settleGate();

    // With `dismissAgent` at the call site the row would already be gone.
    expect(state().pendingTerminalClose).toEqual({
      scope: { kind: "agent", agentId },
      terminals: [runningClaude(asTerminalId(agentId))],
    });
    expect(state().agents[agentId]).toBeDefined();
    expect(Object.values(state().tabs)).toHaveLength(1);
    expect(terminal.dispose).not.toHaveBeenCalled();
  });
});
