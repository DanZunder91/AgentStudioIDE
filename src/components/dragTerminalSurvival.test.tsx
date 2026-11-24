/**
 * Dragging a terminal tab to an edge must not cost you the terminal.
 *
 * This is the one regression that would be both most likely and most visible:
 * a tab moving between panes is re-parented in the React tree, so its
 * `<TerminalView>` genuinely unmounts and remounts. Everything downstream of
 * that is what keeps the session alive — `useTerminal` DETACHES on unmount
 * (never disposes), the registry parks the DOM in an offscreen holder, and the
 * next mount re-ATTACHES the very same xterm instance and PTY.
 *
 * So this file deliberately mocks NOTHING below the IPC boundary: real
 * `<Pane>` → real `<TerminalView>` → real `useTerminal` → real
 * `TerminalRegistry` → real xterm. Only Rust is faked (there is no PTY in a
 * Vitest run), via the shared Tauri mock — which lets us push real bytes down
 * the real hot-plane Channel and then assert the scrollback survived the drag.
 *
 * The rest of the suite mocks `features/terminal` at the module boundary, which
 * is right for unit-testing the store/pane in isolation — but it means no other
 * test can see this failure mode at all: with the registry mocked, "did the
 * emulator survive?" is a question about the mock.
 */

import { act, cleanup, createEvent, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useAppStore } from "../app/store";
import type { LeafNode, TabId, TerminalId } from "../app/types";
import { getTerminal, disposeAll } from "../features/terminal";
import { installTauriMock, type ChannelDriver, type TauriMock } from "../test/tauri-mock";
import { resetStore } from "../test/store-harness";
import { PaneTreeRoot } from "./PaneTree";
import { TABBAR_CLASS, TAB_DND_MIME } from "./TabBar";

let ipc: TauriMock;
/**
 * One driver per TerminalId. A single shared driver would silently re-point at
 * whichever terminal opened last — and the split legitimately opens a second
 * one (the tab left behind gets a pane of its own) — so bytes "sent to the
 * dragged terminal" would land in the wrong emulator and the test would lie.
 */
const ptys = new Map<string, ChannelDriver>();
const ptyOf = (id: TerminalId): ChannelDriver => {
  const driver = ptys.get(id);
  if (!driver) throw new Error(`no PTY channel captured for ${id}`);
  return driver;
};

const store = () => useAppStore.getState();
const actions = () => useAppStore.getState().layoutActions;
const leaves = (): LeafNode[] => {
  const walk = (n: ReturnType<typeof store>["layout"]): LeafNode[] =>
    n.type === "leaf" ? [n] : n.children.flatMap(walk);
  return walk(store().layout);
};
const terminalIdOf = (tabId: TabId): TerminalId => {
  const ref = store().tabs[tabId].ref;
  if (ref.kind !== "terminal" && ref.kind !== "agent-terminal")
    throw new Error("not a terminal tab");
  return ref.terminalId;
};

/** Let the registry's `await openTerminal(...)` settle, then xterm's writes. */
async function settle() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** Read the emulator's buffer back as text — the actual scrollback. */
function scrollbackOf(terminalId: TerminalId): string {
  const term = getTerminal(terminalId);
  if (!term) return "";
  const out: string[] = [];
  for (let i = 0; i < term.buffer.active.length; i++) {
    out.push(term.buffer.active.getLine(i)?.translateToString(true) ?? "");
  }
  return out.join("\n");
}

const BODY_RECT = { left: 0, top: 34, width: 400, height: 300 };

/** Lay the tab strip out (jsdom measures 0×0) — see Pane.test.tsx. */
function stubTabRects(container: HTMLElement, width = 100) {
  [...container.querySelectorAll<HTMLElement>(".pane-tab")].forEach((tab, i) => {
    tab.getBoundingClientRect = () =>
      ({
        left: i * width,
        top: 0,
        width,
        height: 34,
        right: (i + 1) * width,
        bottom: 34,
        x: i * width,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
  });
}

function stubBodyRects(container: HTMLElement) {
  for (const body of container.querySelectorAll(".pane__body")) {
    (body as HTMLElement).getBoundingClientRect = () =>
      ({
        ...BODY_RECT,
        right: BODY_RECT.left + BODY_RECT.width,
        bottom: BODY_RECT.top + BODY_RECT.height,
        x: BODY_RECT.left,
        y: BODY_RECT.top,
        toJSON: () => ({}),
      }) as DOMRect;
  }
}

/** See Pane.test.tsx: jsdom has no DragEvent, so coords must be defined on. */
function dropAt(el: HTMLElement, [clientX, clientY]: readonly [number, number], tabId: string) {
  const data = new Map([[TAB_DND_MIME, tabId]]);
  const dataTransfer = {
    types: [...data.keys()],
    getData: (t: string) => data.get(t) ?? "",
    dropEffect: "",
    effectAllowed: "",
  };
  const event = createEvent.drop(el, { dataTransfer });
  Object.defineProperty(event, "clientX", { value: clientX });
  Object.defineProperty(event, "clientY", { value: clientY });
  fireEvent(el, event);
}

beforeEach(() => {
  resetStore();
  ptys.clear();
  ipc = installTauriMock();
  ipc.handle("terminal_open", (args) => {
    ptys.set(args.terminalId as string, ipc.channel().capture(args.onOutput));
    return {
      id: args.terminalId,
      kind: "terminal",
      title: "sh",
      cwd: "/w/gazelle",
      cols: 80,
      rows: 24,
      status: "live",
    };
  });
  ipc.handle("terminal_write", () => null);
  ipc.handle("terminal_resize", () => null);
  ipc.handle("terminal_close", () => null);
});

afterEach(() => {
  cleanup();
  disposeAll();
  ipc.reset();
});

describe("dragging a terminal tab to an edge — the emulator survives", () => {
  it("keeps the SAME xterm instance, its PTY and its scrollback", async () => {
    // Two tabs in one pane: dragging one to an edge is the case under test.
    const stay = actions().openTerminalTab({ cwd: "/w/gazelle" });
    const drag = actions().openTerminalTab({ cwd: "/w/api" });
    const dragTerm = terminalIdOf(drag);

    const { container } = render(<PaneTreeRoot />);
    await settle();

    // The dragged tab is the active one, so its terminal is mounted and live.
    const instanceBefore = getTerminal(dragTerm);
    expect(instanceBefore).toBeDefined();

    // Real bytes down the real hot plane — this is the scrollback we must keep.
    ptyOf(dragTerm).send(new TextEncoder().encode("precious-scrollback-42\r\n"));
    await settle();
    expect(scrollbackOf(dragTerm)).toContain("precious-scrollback-42");

    // Scoped to THIS terminal on purpose. A global count would be wrong: the
    // split gives `stay` a pane of its own, where it becomes active and boots
    // its PTY for the first time — a legitimate second `terminal_open`.
    const opensOf = (id: TerminalId) =>
      ipc.calls("terminal_open").filter((c) => c.args.terminalId === id);
    expect(opensOf(dragTerm)).toHaveLength(1);

    // ── the drag: drop the tab on the pane's bottom edge ──
    stubBodyRects(container);
    const pane = container.querySelector(".pane") as HTMLElement;
    await act(async () => {
      dropAt(pane, [200, 324], drag);
    });
    await settle();

    // The layout really did split — otherwise this test proves nothing.
    expect(leaves()).toHaveLength(2);
    expect(store().layout.type).toBe("split");
    expect(leaves().map((l) => l.tabIds)).toEqual([[stay], [drag]]);

    // 1. The very same emulator object — not a lookalike rebuilt from scratch.
    expect(getTerminal(dragTerm)).toBe(instanceBefore);

    // 2. Its scrollback is untouched. This is what the user actually sees.
    expect(scrollbackOf(dragTerm)).toContain("precious-scrollback-42");

    // 3. No second PTY was spawned for it, and the old one was never killed.
    expect(opensOf(dragTerm)).toHaveLength(1);
    expect(ipc.calls("terminal_close")).toHaveLength(0);

    // 4. It is still wired to the hot plane: bytes sent AFTER the move land.
    ptyOf(dragTerm).send(new TextEncoder().encode("still-connected\r\n"));
    await settle();
    expect(scrollbackOf(dragTerm)).toContain("still-connected");
  });

  it("re-attaches the emulator's DOM into the pane it was dropped into", async () => {
    actions().openTerminalTab({ cwd: "/w/gazelle" });
    const drag = actions().openTerminalTab({ cwd: "/w/api" });
    const dragTerm = terminalIdOf(drag);

    const { container } = render(<PaneTreeRoot />);
    await settle();

    stubBodyRects(container);
    await act(async () => {
      dropAt(container.querySelector(".pane") as HTMLElement, [390, 184], drag);
    });
    await settle();

    // The xterm container lives under a real, on-screen pane host — not parked
    // in the registry's offscreen detached holder, which is where a move that
    // forgot to re-attach would strand it.
    const host = container.querySelector(
      `[data-terminal-id="${dragTerm}"]`,
    ) as HTMLElement;
    expect(host).toBeTruthy();
    expect(host.querySelector(".xterm")).toBeTruthy();
    expect(container.contains(host)).toBe(true);
  });

  it("reordering within the strip never touches the emulator", async () => {
    // Reorder is a pure tabIds permutation — the pane tree does not change at
    // all, so the terminal should not even unmount. Strongest form of the
    // guarantee: same instance, same PTY, same scrollback, no new open.
    const a = actions().openTerminalTab({ cwd: "/w/gazelle" });
    const b = actions().openTerminalTab({ cwd: "/w/api" }); // active
    const bTerm = terminalIdOf(b);

    const { container } = render(<PaneTreeRoot />);
    await settle();

    const instanceBefore = getTerminal(bTerm);
    ptyOf(bTerm).send(new TextEncoder().encode("survives-reorder\r\n"));
    await settle();
    expect(scrollbackOf(bTerm)).toContain("survives-reorder");

    // Drag `b` to the front of its own strip.
    stubTabRects(container);
    const strip = container.querySelector(`.${TABBAR_CLASS}`) as HTMLElement;
    await act(async () => {
      dropAt(strip, [5, 10], b);
    });
    await settle();

    // It really did reorder, and it really did NOT restructure the layout.
    expect(leaves()).toHaveLength(1);
    expect(store().layout.type).toBe("leaf");
    expect(leaves()[0].tabIds).toEqual([b, a]);

    expect(getTerminal(bTerm)).toBe(instanceBefore);
    expect(scrollbackOf(bTerm)).toContain("survives-reorder");
    expect(
      ipc.calls("terminal_open").filter((c) => c.args.terminalId === bTerm),
    ).toHaveLength(1);
    expect(ipc.calls("terminal_close")).toHaveLength(0);

    // Still live on the hot plane after the reorder.
    ptyOf(bTerm).send(new TextEncoder().encode("still-here\r\n"));
    await settle();
    expect(scrollbackOf(bTerm)).toContain("still-here");
  });

  it("closing the moved tab afterwards still tears its PTY down exactly once", async () => {
    // The move must not orphan the terminal's lifetime: after landing in a new
    // pane, closing it must still reach the same PTY.
    actions().openTerminalTab({ cwd: "/w/gazelle" });
    const drag = actions().openTerminalTab({ cwd: "/w/api" });
    const dragTerm = terminalIdOf(drag);

    const { container } = render(<PaneTreeRoot />);
    await settle();
    stubBodyRects(container);
    await act(async () => {
      dropAt(container.querySelector(".pane") as HTMLElement, [200, 324], drag);
    });
    await settle();

    await act(async () => {
      actions().closeTab(drag);
    });
    await settle();

    expect(ipc.calls("terminal_close")).toHaveLength(1);
    expect(ipc.lastCall("terminal_close")).toMatchObject({ terminalId: dragTerm });
    expect(getTerminal(dragTerm)).toBeUndefined();
  });
});

describe("promoting an ad-hoc agent's tab — the emulator survives", () => {
  const fleet = () => useAppStore.getState().agentActions;

  it("keeps the SAME xterm instance, its PTY and its scrollback across promotion", async () => {
    // The user types `claude` in a plain shell; agent_started promotes the
    // tab in place. Promotion rewrites tab METADATA only — the terminalId is
    // unchanged, so `<TerminalView key={terminalId}>` must not remount and the
    // session must survive intact. Same guarantee as the drag, different trigger.
    const tabId = actions().openTerminalTab({ cwd: "/w/scratch" });
    const termId = terminalIdOf(tabId);

    render(<PaneTreeRoot />);
    await settle();

    const instanceBefore = getTerminal(termId);
    expect(instanceBefore).toBeDefined();
    expect(store().tabs[tabId].kind).toBe("terminal"); // born plain

    // Real bytes down the real hot plane — the scrollback we must keep.
    ptyOf(termId).send(new TextEncoder().encode("typed-claude-here\r\n"));
    await settle();
    expect(scrollbackOf(termId)).toContain("typed-claude-here");

    const opensBefore = ipc.calls("terminal_open").length;

    // Rust detects the agent and emits agent_started; the id EQUALS the terminal.
    await act(async () => {
      fleet().applyAgentEvent({
        t: "agent_started",
        agentId: termId as unknown as never,
        parentId: null,
        title: "Pull latest changes",
        cwd: "/w/scratch",
        branch: "trunk",
        runtime: "claude-code",
      });
    });
    await settle();

    // The tab really did promote — otherwise this proves nothing.
    expect(store().tabs[tabId].kind).toBe("agent-terminal");
    expect(store().tabs[tabId].ref).toMatchObject({ kind: "agent-terminal", agentId: termId });

    // 1. The very same emulator object — no remount.
    expect(getTerminal(termId)).toBe(instanceBefore);
    // 2. Scrollback untouched.
    expect(scrollbackOf(termId)).toContain("typed-claude-here");
    // 3. No second PTY spawned, old one never killed.
    expect(ipc.calls("terminal_open")).toHaveLength(opensBefore);
    expect(ipc.calls("terminal_close")).toHaveLength(0);

    // 4. Still wired to the hot plane: bytes AFTER promotion land.
    ptyOf(termId).send(new TextEncoder().encode("still-connected-as-agent\r\n"));
    await settle();
    expect(scrollbackOf(termId)).toContain("still-connected-as-agent");
  });

  it("closing the promoted tab tears the PTY down AND removes the agent", async () => {
    // End-to-end proof of the fix through the real registry: the tab
    // now carries the agentId, so one close does both.
    const tabId = actions().openTerminalTab({ cwd: "/w/scratch" });
    const termId = terminalIdOf(tabId);

    render(<PaneTreeRoot />);
    await settle();

    await act(async () => {
      fleet().applyAgentEvent({
        t: "agent_started",
        agentId: termId as unknown as never,
        parentId: null,
        title: "adhoc",
        cwd: "/w/scratch",
        branch: "trunk",
        runtime: "claude-code",
      });
    });
    await settle();
    expect(store().agents[termId as unknown as never]).toBeDefined();

    await act(async () => {
      actions().closeTab(tabId);
    });
    await settle();

    expect(ipc.calls("terminal_close")).toHaveLength(1);
    expect(ipc.lastCall("terminal_close")).toMatchObject({ terminalId: termId });
    expect(getTerminal(termId)).toBeUndefined();
    // The agent is gone from the rail — the bug is fixed at the real seam.
    expect(store().agents[termId as unknown as never]).toBeUndefined();
  });
});
