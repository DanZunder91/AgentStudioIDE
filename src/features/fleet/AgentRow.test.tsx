/** The row in isolation: the vanished-record guard and keyboard alternates are unreachable from
 * the rail-level suites. */

import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const terminal = vi.hoisted(() => ({ configureTerminal: vi.fn(), dispose: vi.fn() }));
vi.mock("../terminal", () => terminal);

// The store fires the pin/unpin persist EFFECTS through this IPC.
// Mock it so the spies prove a toggle issues the right invoke without touching
// Tauri; the pin wrappers default to resolving, like the rest.
const fleetIpc = vi.hoisted(() => ({
  pinAgent: vi.fn().mockResolvedValue(undefined),
  unpinAgent: vi.fn().mockResolvedValue(undefined),
  pinnedAgents: vi.fn().mockResolvedValue([]),
}));
vi.mock("./fleetIpc", () => fleetIpc);

// "↻ Resume" is its own hook (useResumeAgent.test.tsx); here only the
// row's half — when it shows and what it calls — is asserted.
const resume = vi.hoisted(() => vi.fn().mockResolvedValue(null));
vi.mock("./useResumeAgent", () => ({ useResumeAgent: () => resume }));

// The home folder for the subtitle's `~` (lib/homeDir). Unknown by default — the path
// is then shown as it is — and set per test where the `~` is the point.
const tauriPath = vi.hoisted(() => ({
  homeDir: vi.fn<() => Promise<string>>(() => Promise.reject(new Error("no Tauri here"))),
}));
vi.mock("@tauri-apps/api/path", () => tauriPath);

import { useAppStore } from "../../app/store";
import type { AgentEvent, AgentId } from "../../app/types";
import { fireDragLeave, makeDataTransfer } from "../../test/dnd";
import { resetFleetStore, wireAgent } from "../../test/fleet-harness";
import { resetStore } from "../../test/store-harness";
import { resetHomeDirForTests } from "../../lib/homeDir";
import { AGENT_DND_MIME, AgentRow, agentCwdType, agentIdType } from "./AgentRow";

/** The folder-header drag MIME — an agent row must ignore it (distinct MIMEs). */
const FOLDER_DND_MIME = "application/x-agentstudio-folder";

const state = () => useAppStore.getState();
const fleet = () => useAppStore.getState().agentActions;
const id = (s: string) => s as AgentId;

const started = (agentId: string, over: Partial<{ title: string; branch: string; cwd: string }> = {}): AgentEvent => ({
  t: "agent_started",
  agentId: id(agentId),
  parentId: null,
  title: over.title ?? agentId,
  cwd: over.cwd ?? "/w/gazelle",
  branch: over.branch ?? "trunk",
  runtime: "claude-code",
});

/** Render one row the way `<AgentTree>` does. */
function renderRow(
  agentId: string,
  props: Partial<{
    depth: number;
    hasChildren: boolean;
    expanded: boolean;
    attention: boolean;
    rollupRunning: number;
    rollupDone: number;
    rollupError: number;
  }> = {},
) {
  return render(
    <AgentRow
      agentId={id(agentId)}
      depth={props.depth ?? 0}
      hasChildren={props.hasChildren ?? false}
      expanded={props.expanded ?? true}
      attention={props.attention ?? false}
      rollupRunning={props.rollupRunning ?? 0}
      rollupDone={props.rollupDone ?? 0}
      rollupError={props.rollupError ?? 0}
    />,
  );
}

const row = () => screen.getByRole("treeitem");

beforeEach(() => {
  resetStore();
  resetFleetStore();
  fleetIpc.pinAgent.mockClear();
  fleetIpc.unpinAgent.mockClear();
  fleetIpc.pinnedAgents.mockClear();
  resetHomeDirForTests();
  tauriPath.homeDir.mockImplementation(() => Promise.reject(new Error("no Tauri here")));
});

/** The subtitle's text, whole: branch, separator and path are separate spans. */
const meta = () => row().querySelector(".fleet-row__meta");

describe("AgentRow — content", () => {
  it("renders title, status and branch • cwd", () => {
    fleet().applyAgentEvent(started("a1", { title: "Pull latest changes" }));
    // A root is born idle; a submitted turn drives it to running (what the pill shows).
    fleet().applyAgentEvent({ t: "status", agentId: id("a1"), status: "running" });
    renderRow("a1");

    expect(screen.getByText("Pull latest changes")).toBeInTheDocument();
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(meta()).toHaveTextContent(/^trunk • \/w\/gazelle$/);
    expect(meta()).toHaveAttribute("title", "trunk • /w/gazelle");
  });

  it("falls back to the bare cwd when there is no branch", () => {
    // `createAgent` opens an agent with branch "" until Rust reports one — the
    // row must not render a dangling "• ".
    fleet().applyAgentEvent(started("a1", { branch: "" }));
    renderRow("a1");

    expect(meta()).toHaveTextContent(/^\/w\/gazelle$/);
    expect(meta()).toHaveAttribute("title", "/w/gazelle");
    expect(screen.queryByText(/•/)).not.toBeInTheDocument();
  });

  it("keeps the branch in its own box, so only the PATH is clipped (never the branch)", () => {
    fleet().applyAgentEvent(
      started("a1", { branch: "feat/windows-native", cwd: "C:\\Users\\sam\\projects\\Agent Studio" }),
    );
    renderRow("a1");

    expect(meta()!.querySelector(".fleet-row__branch")).toHaveTextContent(/^feat\/windows-native$/);
    // The path is the clipped part, and it is an isolated LTR run inside the RTL clip box,
    // so `C:\…` is not reordered by the box's direction.
    const bdi = meta()!.querySelector(".fleet-row__cwd > bdi");
    expect(bdi).toHaveAttribute("dir", "ltr");
    expect(bdi).toHaveTextContent(/^C:\\Users\\sam\\projects\\Agent Studio$/);
  });

  it("shows the home folder as ~ once it is known (macOS / Linux)", async () => {
    tauriPath.homeDir.mockResolvedValue("/Users/sam");
    fleet().applyAgentEvent(started("a1", { cwd: "/Users/sam/projects/gazelle" }));
    renderRow("a1");

    expect(await screen.findByText("~/projects/gazelle")).toBeInTheDocument();
    // The hover still names the real folder.
    expect(meta()).toHaveAttribute("title", "trunk • /Users/sam/projects/gazelle");
  });

  it("shows the home folder as ~ on Windows, whatever the case Rust spelled it in", async () => {
    tauriPath.homeDir.mockResolvedValue("C:\\Users\\sam");
    fleet().applyAgentEvent(started("a1", { cwd: "c:\\users\\Sam\\projects\\Agent Studio" }));
    renderRow("a1");

    expect(await screen.findByText("~\\projects\\Agent Studio")).toBeInTheDocument();
  });

  it("greys out a finished agent — for inspection, not attention", () => {
    fleet().applyAgentEvent(started("a1"));
    fleet().applyAgentEvent({ t: "exited", agentId: id("a1"), code: 0 });
    renderRow("a1");

    expect(row()).toHaveClass("fleet-row--finished");
  });

  it("greys out an errored agent too", () => {
    fleet().applyAgentEvent(started("a1"));
    fleet().applyAgentEvent({ t: "exited", agentId: id("a1"), code: 143 });
    renderRow("a1");

    expect(row()).toHaveClass("fleet-row--finished");
    expect(screen.getByText("Error")).toBeInTheDocument();
  });

  it("indents by depth and reports its aria level", () => {
    fleet().applyAgentEvent(started("a1"));
    renderRow("a1", { depth: 3 });

    expect(row()).toHaveAttribute("aria-level", "4");
    expect(row()).toHaveClass("fleet-row--child");
    expect(parseInt(row().style.paddingLeft, 10)).toBeGreaterThan(10);
  });

  it("shows a bubbled unread badge", () => {
    fleet().applyAgentEvent(started("a1"));
    fleet().applyAgentEvent({ t: "status", agentId: id("a1"), status: "waiting_input" });
    renderRow("a1");

    expect(screen.getByLabelText("1 unread")).toHaveTextContent("1");
  });

  it("shows no badge at zero", () => {
    fleet().applyAgentEvent(started("a1"));
    renderRow("a1");
    expect(screen.queryByLabelText(/unread/)).not.toBeInTheDocument();
  });
});

describe("AgentRow — a record that vanishes underneath it", () => {
  it("renders nothing for an agent with no record", () => {
    // The record can vanish between the parent's flatten and this render; null beats a throw.
    const { container } = renderRow("ghost");
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing once its agent is removed while mounted", () => {
    fleet().applyAgentEvent(started("a1"));
    const { container } = renderRow("a1");
    expect(screen.getByText("a1")).toBeInTheDocument();

    // The store drops it out from under the mounted row.
    act(() => fleet().removeAgent(id("a1")));

    expect(container).toBeEmptyDOMElement();
  });
});

describe("AgentRow — selection", () => {
  it("click selects", async () => {
    const user = userEvent.setup();
    fleet().applyAgentEvent(started("a1"));
    renderRow("a1");

    await user.click(row());

    expect(state().selection.selectedAgentId).toBe(id("a1"));
  });

  it("marks itself selected", () => {
    fleet().applyAgentEvent(started("a1"));
    fleet().selectAgent(id("a1"));
    renderRow("a1");

    expect(row()).toHaveAttribute("aria-selected", "true");
    expect(row()).toHaveClass("fleet-row--selected");
    // The selected row is the one in the tab order.
    expect(row()).toHaveAttribute("tabindex", "0");
  });

  it("an unselected row is out of the tab order", () => {
    fleet().applyAgentEvent(started("a1"));
    renderRow("a1");
    expect(row()).toHaveAttribute("tabindex", "-1");
  });

  it.each([
    ["Enter", "{Enter}"],
    ["Space", " "],
  ])("%s selects it", async (_name, keys) => {
    // Both, because a treeitem is not a button: the browser gives it no default
    // activation, so every key that should work has to be wired by hand.
    const user = userEvent.setup();
    fleet().applyAgentEvent(started("a1"));
    renderRow("a1");

    row().focus();
    await user.keyboard(keys);

    expect(state().selection.selectedAgentId).toBe(id("a1"));
  });

  it("Space does not also scroll the rail", () => {
    fleet().applyAgentEvent(started("a1"));
    renderRow("a1");

    const event = createKeyDown(" ");
    fireEvent(row(), event);

    expect(event.defaultPrevented).toBe(true);
  });

  it("ignores other keys", async () => {
    const user = userEvent.setup();
    fleet().applyAgentEvent(started("a1"));
    renderRow("a1");

    row().focus();
    await user.keyboard("{Escape}a{ArrowDown}");

    expect(state().selection.selectedAgentId).toBeNull();
  });
});

describe("AgentRow — disclosure", () => {
  it("has no caret when there is nothing to disclose", () => {
    fleet().applyAgentEvent(started("a1"));
    renderRow("a1", { hasChildren: false });

    // No disclosure caret — but the dismiss ✕ is always present, so scope to it.
    expect(screen.queryByRole("button", { name: /Collapse|Expand/ })).not.toBeInTheDocument();
    expect(row()).not.toHaveAttribute("aria-expanded");
  });

  it("carets both ways, and labels itself for what it will do", () => {
    fleet().applyAgentEvent(started("a1"));
    const { rerender } = renderRow("a1", { hasChildren: true, expanded: true });
    expect(screen.getByRole("button", { name: "Collapse a1" })).toBeInTheDocument();
    expect(row()).toHaveAttribute("aria-expanded", "true");

    rerender(
      <AgentRow
        agentId={id("a1")}
        depth={0}
        hasChildren
        expanded={false}
        attention={false}
        rollupRunning={0}
        rollupDone={0}
        rollupError={0}
      />,
    );
    expect(screen.getByRole("button", { name: "Expand a1" })).toBeInTheDocument();
    expect(row()).toHaveAttribute("aria-expanded", "false");
  });

  it("the caret toggles without selecting — disclosure is not selection", async () => {
    const user = userEvent.setup();
    fleet().applyAgentEvent(started("a1")); // store default: collapsed
    renderRow("a1", { hasChildren: true, expanded: false });

    await user.click(screen.getByRole("button", { name: "Expand a1" }));

    expect(state().agents[id("a1")].expanded).toBe(true); // toggled open
    // stopPropagation: clicking the caret must not steal the selection.
    expect(state().selection.selectedAgentId).toBeNull();
  });
});

describe("AgentRow — dismiss ✕", () => {
  it("carries a labelled, reachable close button", () => {
    fleet().applyAgentEvent(started("a1", { title: "Pull latest changes" }));
    renderRow("a1");

    const close = screen.getByRole("button", { name: "Close agent Pull latest changes" });
    expect(close).toBeInTheDocument();
    // In the DOM regardless of hover — the CSS only fades it, never removes it,
    // so keyboard and assistive tech can always find it.
    expect(close).toBeVisible();
  });

  it("dismisses the agent when clicked", async () => {
    const user = userEvent.setup();
    fleet().applyAgentEvent(started("a1"));
    renderRow("a1");

    await user.click(screen.getByRole("button", { name: "Close agent a1" }));

    expect(state().agents[id("a1")]).toBeUndefined();
    expect(state().dismissedAgentIds).toContain(id("a1"));
  });

  it("dismisses WITHOUT firing the row's select — stopPropagation", async () => {
    // The ✕ must not select (a bubbled select would no-op, so count invocations). Injected via
    // setState: Immer autofreezes the actions object, so vi.spyOn cannot redefine it.
    fleet().applyAgentEvent(started("a1"));
    const realSelect = useAppStore.getState().agentActions.selectAgent;
    let selectCalls = 0;
    useAppStore.setState((s) => {
      s.agentActions = {
        ...s.agentActions,
        selectAgent: (agentId) => {
          selectCalls += 1;
          realSelect(agentId);
        },
      };
    });
    const user = userEvent.setup();
    renderRow("a1");

    await user.click(screen.getByRole("button", { name: "Close agent a1" }));

    expect(state().agents[id("a1")]).toBeUndefined(); // dismissed
    expect(selectCalls).toBe(0); // but the row's select never fired
  });

  it("is keyboard-activatable", async () => {
    const user = userEvent.setup();
    fleet().applyAgentEvent(started("a1"));
    renderRow("a1");

    screen.getByRole("button", { name: "Close agent a1" }).focus();
    await user.keyboard("{Enter}");

    expect(state().agents[id("a1")]).toBeUndefined();
  });

  it("stays a NATURAL exit's greyed node until the ✕ is pressed", () => {
    // Ties the two rules together: a natural exit greys the row (it stays for
    // inspection); the ✕ is what actually removes it.
    fleet().applyAgentEvent(started("a1"));
    fleet().applyAgentEvent({ t: "exited", agentId: id("a1"), code: 0 });
    renderRow("a1");

    expect(row()).toHaveClass("fleet-row--finished");
    expect(state().agents[id("a1")]).toBeDefined(); // still there
    expect(screen.getByRole("button", { name: "Close agent a1" })).toBeInTheDocument();
  });
});

describe("AgentRow — rename", () => {
  const spawn = (parent: string, child: string): AgentEvent => ({
    t: "subagent_spawned",
    parentId: id(parent),
    childAgentId: id(child),
    title: child,
    cwd: "/w/gazelle",
    branch: "trunk",
    runtime: "claude-code",
  });

  const titleInput = () => screen.getByRole("textbox", { name: /Rename agent/ });

  it("double-clicking the title opens an input prefilled with the name", async () => {
    const user = userEvent.setup();
    act(() => fleet().applyAgentEvent(started("a1", { title: "Pull latest changes" })));
    renderRow("a1");

    await user.dblClick(screen.getByText("Pull latest changes"));

    expect(titleInput()).toHaveValue("Pull latest changes");
  });

  it("Enter saves the custom name and renders it", async () => {
    const user = userEvent.setup();
    act(() => fleet().applyAgentEvent(started("a1", { title: "orig" })));
    renderRow("a1");

    await user.dblClick(screen.getByText("orig"));
    await user.clear(titleInput());
    await user.type(titleInput(), "Renamed{Enter}");

    expect(state().agents[id("a1")].customTitle).toBe("Renamed");
    expect(screen.getByText("Renamed")).toBeInTheDocument();
  });

  it("blur saves", async () => {
    const user = userEvent.setup();
    act(() => fleet().applyAgentEvent(started("a1", { title: "orig" })));
    renderRow("a1");

    await user.dblClick(screen.getByText("orig"));
    await user.clear(titleInput());
    await user.type(titleInput(), "ViaBlur");
    fireEvent.blur(titleInput());

    expect(state().agents[id("a1")].customTitle).toBe("ViaBlur");
  });

  it("Esc cancels without saving, keeping the derived title", async () => {
    const user = userEvent.setup();
    act(() => fleet().applyAgentEvent(started("a1", { title: "orig" })));
    renderRow("a1");

    await user.dblClick(screen.getByText("orig"));
    await user.clear(titleInput());
    await user.type(titleInput(), "discard{Escape}");

    expect(state().agents[id("a1")].customTitle ?? null).toBeNull();
    expect(screen.getByText("orig")).toBeInTheDocument();
  });

  it("saving an empty string clears the custom name (reverts to derived)", async () => {
    const user = userEvent.setup();
    act(() => fleet().applyAgentEvent(started("a1", { title: "orig" })));
    act(() => fleet().renameAgent(id("a1"), "Custom"));
    renderRow("a1");

    await user.dblClick(screen.getByText("Custom"));
    await user.clear(titleInput());
    await user.type(titleInput(), "{Enter}");

    expect(state().agents[id("a1")].customTitle).toBeNull();
    expect(screen.getByText("orig")).toBeInTheDocument();
  });

  it("renames a SUBAGENT row, and saving does not dismiss it", async () => {
    const user = userEvent.setup();
    act(() => {
      fleet().applyAgentEvent(started("root"));
      fleet().applyAgentEvent(spawn("root", "kid"));
    });
    renderRow("kid", { depth: 1 });

    await user.dblClick(screen.getByText("kid"));
    await user.clear(titleInput());
    await user.type(titleInput(), "Explorer{Enter}");

    expect(state().agents[id("kid")].customTitle).toBe("Explorer");
    expect(state().agents[id("kid")]).toBeDefined(); // not dismissed
    expect(screen.getByText("Explorer")).toBeInTheDocument();
  });

  it("interacting with the rename input does not select the row (stopPropagation)", async () => {
    const user = userEvent.setup();
    act(() => fleet().applyAgentEvent(started("a1", { title: "orig" })));
    renderRow("a1");

    await user.dblClick(screen.getByText("orig"));
    // Isolate the input from the entry gesture: clear any selection the
    // double-click set, then confirm clicking IN the input does not re-select.
    act(() =>
      useAppStore.setState((s) => {
        s.selection.selectedAgentId = null;
      }),
    );

    await user.click(titleInput());

    expect(state().selection.selectedAgentId).toBeNull();
  });
});

describe("AgentRow — pin 📌", () => {
  const spawn = (parent: string, child: string): AgentEvent => ({
    t: "subagent_spawned",
    parentId: id(parent),
    childAgentId: id(child),
    title: child,
    cwd: "/w/gazelle",
    branch: "trunk",
    runtime: "claude-code",
  });

  it("shows the pin button on a root agent, in the DOM and reachable", () => {
    fleet().applyAgentEvent(started("root"));
    renderRow("root", { depth: 0 });

    const pin = screen.getByRole("button", { name: "Pin root" });
    expect(pin).toBeInTheDocument();
    // Never display:none — the CSS only fades it, so keyboard/AT always reach it.
    expect(pin).toBeVisible();
    expect(pin).toHaveAttribute("aria-pressed", "false");
    // Every open agent comes back after a restart now (open_agents.rs), so the pin's
    // tooltip says what it ADDS — not "restore on restart", which is no longer a pin's.
    expect(pin).toHaveAttribute("title", "Pin agent (it comes back on restart even after it ends)");
  });

  it("hides the pin button on a sub-agent row (root-only affordance)", () => {
    fleet().applyAgentEvent(started("root"));
    fleet().applyAgentEvent(spawn("root", "kid"));
    renderRow("kid", { depth: 1 });

    expect(screen.queryByRole("button", { name: /pin/i })).toBeNull();
  });

  it("hides the pin on an orphan surfaced at depth 0 that is NOT an orchestrator", () => {
    // An orphaned sub-agent (parent not yet arrived) is surfaced at depth 0 by
    // `linkAgent`; gating on kind (not depth alone) keeps the pin off it.
    fleet().applyAgentEvent(spawn("missing-parent", "orphan"));
    renderRow("orphan", { depth: 0 });

    expect(screen.queryByRole("button", { name: /pin/i })).toBeNull();
  });

  it("pins the agent and persists via pin_agent, flipping the label to Unpin", async () => {
    const user = userEvent.setup();
    fleet().applyAgentEvent(started("root"));
    renderRow("root");

    await user.click(screen.getByRole("button", { name: "Pin root" }));

    expect(state().agents[id("root")].pinned).toBe(true);
    expect(fleetIpc.pinAgent).toHaveBeenCalledWith(id("root"));
    const pin = screen.getByRole("button", { name: "Unpin root" });
    expect(pin).toHaveAttribute("aria-pressed", "true");
    expect(pin).toHaveClass("fleet-row__pin--active");
  });

  it("unpins and drops the registry entry", async () => {
    const user = userEvent.setup();
    fleet().applyAgentEvent(started("root"));
    fleet().pinAgent(id("root"));
    fleetIpc.pinAgent.mockClear();
    renderRow("root");

    await user.click(screen.getByRole("button", { name: "Unpin root" }));

    expect(state().agents[id("root")].pinned).toBe(false);
    expect(fleetIpc.unpinAgent).toHaveBeenCalledWith(id("root"));
  });

  it("pinning does NOT select the row — stopPropagation", async () => {
    fleet().applyAgentEvent(started("root"));
    const realSelect = useAppStore.getState().agentActions.selectAgent;
    let selectCalls = 0;
    useAppStore.setState((s) => {
      s.agentActions = {
        ...s.agentActions,
        selectAgent: (agentId) => {
          selectCalls += 1;
          realSelect(agentId);
        },
      };
    });
    const user = userEvent.setup();
    renderRow("root");

    await user.click(screen.getByRole("button", { name: "Pin root" }));

    expect(state().agents[id("root")].pinned).toBe(true);
    expect(selectCalls).toBe(0);
  });

  it("is keyboard-activatable", async () => {
    const user = userEvent.setup();
    fleet().applyAgentEvent(started("root"));
    renderRow("root");

    screen.getByRole("button", { name: "Pin root" }).focus();
    await user.keyboard("{Enter}");

    expect(state().agents[id("root")].pinned).toBe(true);
  });
});

describe("AgentRow — 'Resumed after restart' marker (agents survive a restart)", () => {
  const restore = (agentId: string, outcome: "resumed" | "fresh" | "dormant", wasWorking: boolean | null) =>
    fleet().applyRestoredAgents([{ agentId: id(agentId), outcome, wasWorking }]);

  it("says in words, on the row, that the quit interrupted it — and the whole sentence on hover", () => {
    fleet().applyAgentEvent(started("root"));
    restore("root", "resumed", true);
    renderRow("root");

    const marker = screen.getByText("Resumed · was working");
    expect(marker).toHaveAttribute(
      "title",
      "Resumed after restart — same conversation. Agent Studio was closed while it was working — tell it to continue.",
    );
    // In the status line, beside the pill — not hidden behind hover.
    expect(marker).toHaveClass("fleet-row__restored");
    expect(marker.parentElement).toHaveClass("fleet-row__status");
  });

  it("a dormant row explains itself with the reason Rust gave", () => {
    fleet().applyFleetSnapshot([
      wireAgent({
        id: id("gone"),
        status: "error",
        cwd: "/w/gone",
        error: "not reopened after the restart: its folder no longer exists: /w/gone",
      }),
    ]);
    restore("gone", "dormant", null);
    renderRow("gone");

    expect(screen.getByText("Not reopened")).toHaveAttribute(
      "title",
      "Not reopened after the restart: its folder no longer exists: /w/gone. Close it and it will not come back next time.",
    );
  });

  it("comes off the row at the agent's next turn", () => {
    fleet().applyAgentEvent(started("root"));
    restore("root", "resumed", false);
    renderRow("root");
    expect(screen.getByText("Resumed")).toBeInTheDocument();

    act(() => fleet().applyAgentEvent({ t: "status", agentId: id("root"), status: "running" }));
    expect(document.querySelector(".fleet-row__restored")).toBeNull();
  });

  it("is absent on an agent that was not restored", () => {
    fleet().applyAgentEvent(started("root"));
    renderRow("root");
    expect(document.querySelector(".fleet-row__restored")).toBeNull();
  });
});

describe("AgentRow — drag-to-reorder (root rows only)", () => {
  const spawn = (parent: string, child: string): AgentEvent => ({
    t: "subagent_spawned",
    parentId: id(parent),
    childAgentId: id(child),
    title: child,
    cwd: "/w/gazelle",
    branch: "trunk",
    runtime: "claude-code",
  });

  /** A root-agent drag already in flight from `agentId`, in folder `cwd`. */
  const dragRoot = (agentId: string, cwd = "/w/gazelle") =>
    makeDataTransfer({
      [AGENT_DND_MIME]: agentId,
      [agentCwdType(cwd)]: "",
      [agentIdType(agentId)]: "",
    });

  it("a root row is draggable and carries its id + folder + self markers", () => {
    fleet().applyAgentEvent(started("a1"));
    renderRow("a1", { depth: 0 });
    expect(row()).toHaveAttribute("draggable", "true");

    // A capture object (not makeDataTransfer): `types` is snapshotted at creation,
    // so setData made during dragStart would not show up on a pre-built one.
    const data = new Map<string, string>();
    const dataTransfer = { setData: (t: string, v: string) => data.set(t, v), effectAllowed: "" };
    fireEvent.dragStart(row(), { dataTransfer });

    expect(data.get(AGENT_DND_MIME)).toBe("a1");
    expect(data.has(agentCwdType("/w/gazelle"))).toBe(true);
    expect(data.has(agentIdType("a1"))).toBe(true);
    expect(dataTransfer.effectAllowed).toBe("move");
    expect(row()).toHaveClass("fleet-row--dragging");

    fireEvent.dragEnd(row());
    expect(row()).not.toHaveClass("fleet-row--dragging");
  });

  it("a sub-agent row is NOT draggable and is not a drop target", () => {
    fleet().applyAgentEvent(started("root"));
    fleet().applyAgentEvent(spawn("root", "kid"));
    renderRow("kid", { depth: 1 });
    expect(row()).toHaveAttribute("draggable", "false");

    // Even when drag events are fired at it directly, the isRoot guards no-op.
    const data = new Map<string, string>();
    fireEvent.dragStart(row(), {
      dataTransfer: { setData: (t: string, v: string) => data.set(t, v), effectAllowed: "" },
    });
    expect(data.size).toBe(0);
    expect(row()).not.toHaveClass("fleet-row--dragging");

    const dt = dragRoot("root");
    fireEvent.dragOver(row(), { dataTransfer: dt });
    expect(dt.dropEffect).toBe("");
    expect(row()).not.toHaveClass("fleet-row--drop-target");

    fireEvent.drop(row(), { dataTransfer: dt });
    expect(state().rootAgentIds).toEqual([id("root")]);
  });

  it("accepts a SAME-folder root drag — dropEffect move + a drop cue", () => {
    fleet().applyAgentEvent(started("a1"));
    fleet().applyAgentEvent(started("a2"));
    renderRow("a1");

    const dt = dragRoot("a2"); // a2 in the same folder as a1
    fireEvent.dragOver(row(), { dataTransfer: dt });

    expect(dt.dropEffect).toBe("move");
    expect(row()).toHaveClass("fleet-row--drop-target");
  });

  it("rejects a DIFFERENT-folder root drag — no preventDefault, no cue", () => {
    fleet().applyAgentEvent(started("a1", { cwd: "/w/gazelle" }));
    renderRow("a1");

    const dt = dragRoot("a2", "/w/other"); // a2 lives in another folder
    fireEvent.dragOver(row(), { dataTransfer: dt });

    expect(dt.dropEffect).toBe("");
    expect(row()).not.toHaveClass("fleet-row--drop-target");
  });

  it("shows NO cue when a root is dragged over itself", () => {
    fleet().applyAgentEvent(started("a1"));
    renderRow("a1");

    const dt = dragRoot("a1"); // the id marker matches this row → self
    fireEvent.dragOver(row(), { dataTransfer: dt });

    expect(dt.dropEffect).toBe("");
    expect(row()).not.toHaveClass("fleet-row--drop-target");
  });

  it("ignores a non-agent drag (a folder header)", () => {
    fleet().applyAgentEvent(started("a1"));
    renderRow("a1");

    const dt = makeDataTransfer({ [FOLDER_DND_MIME]: "/w/gazelle" });
    fireEvent.dragOver(row(), { dataTransfer: dt });

    expect(dt.dropEffect).toBe("");
    expect(row()).not.toHaveClass("fleet-row--drop-target");
  });

  it("dropping root X onto root Y moves X immediately before Y", () => {
    fleet().applyAgentEvent(started("a1"));
    fleet().applyAgentEvent(started("a2"));
    expect(state().rootAgentIds).toEqual([id("a1"), id("a2")]);
    renderRow("a1"); // drop target = a1

    const dt = dragRoot("a2");
    fireEvent.drop(row(), { dataTransfer: dt });

    expect(state().rootAgentIds).toEqual([id("a2"), id("a1")]);
    expect(row()).not.toHaveClass("fleet-row--drop-target");
  });

  it("a cross-folder drop reorders nothing", () => {
    fleet().applyAgentEvent(started("a1", { cwd: "/w/gazelle" }));
    fleet().applyAgentEvent(started("a2", { cwd: "/w/other" }));
    renderRow("a1");

    const dt = dragRoot("a2", "/w/other");
    fireEvent.drop(row(), { dataTransfer: dt });

    // a1's folder marker (gazelle) is absent from the drag → rejected on drop.
    expect(state().rootAgentIds).toEqual([id("a1"), id("a2")]);
  });

  it("a self-drop reorders nothing", () => {
    fleet().applyAgentEvent(started("a1"));
    fleet().applyAgentEvent(started("a2"));
    renderRow("a1");

    const dt = dragRoot("a1");
    fireEvent.drop(row(), { dataTransfer: dt });

    expect(state().rootAgentIds).toEqual([id("a1"), id("a2")]);
  });

  it("a drop with an empty payload reorders nothing", () => {
    fleet().applyAgentEvent(started("a1"));
    fleet().applyAgentEvent(started("a2"));
    renderRow("a1");

    const dt = makeDataTransfer({ [AGENT_DND_MIME]: "", [agentCwdType("/w/gazelle")]: "" });
    fireEvent.drop(row(), { dataTransfer: dt });

    expect(state().rootAgentIds).toEqual([id("a1"), id("a2")]);
  });

  it("ignores a drop that is not an agent drag", () => {
    fleet().applyAgentEvent(started("a1"));
    fleet().applyAgentEvent(started("a2"));
    renderRow("a1");

    const dt = makeDataTransfer({ [FOLDER_DND_MIME]: "/w/gazelle" });
    fireEvent.drop(row(), { dataTransfer: dt });

    expect(state().rootAgentIds).toEqual([id("a1"), id("a2")]);
  });

  it("clears the drop cue on drag leave", () => {
    fleet().applyAgentEvent(started("a1"));
    fleet().applyAgentEvent(started("a2"));
    renderRow("a1");

    const dt = dragRoot("a2");
    fireEvent.dragOver(row(), { dataTransfer: dt });
    expect(row()).toHaveClass("fleet-row--drop-target");

    fireDragLeave(row(), null);
    expect(row()).not.toHaveClass("fleet-row--drop-target");
  });

  it("keeps the drop cue when the pointer moves to a child, not out of the row", () => {
    fleet().applyAgentEvent(started("a1"));
    fleet().applyAgentEvent(started("a2"));
    renderRow("a1");

    const dt = dragRoot("a2");
    fireEvent.dragOver(row(), { dataTransfer: dt });
    expect(row()).toHaveClass("fleet-row--drop-target");

    // relatedTarget still inside the row (the close ✕) → not a real leave.
    fireDragLeave(row(), screen.getByRole("button", { name: "Close agent a1" }));
    expect(row()).toHaveClass("fleet-row--drop-target");
  });

  it("freezes dragging while the row is in inline rename", async () => {
    const user = userEvent.setup();
    act(() => fleet().applyAgentEvent(started("a1", { title: "orig" })));
    renderRow("a1");
    expect(row()).toHaveAttribute("draggable", "true");

    await user.dblClick(screen.getByText("orig"));

    // Rename mode drops draggable so the text drag-select still works (like TabBar).
    expect(row()).toHaveAttribute("draggable", "false");
  });
});

describe("AgentRow — right-click → Recover session…", () => {
  const spawn = (parent: string, child: string, cwd = "/w/gazelle"): AgentEvent => ({
    t: "subagent_spawned",
    parentId: id(parent),
    childAgentId: id(child),
    title: child,
    cwd,
    branch: "trunk",
    runtime: "claude-code",
  });

  /** Every session-picker tab currently open, by its cwd. */
  const pickerCwds = () =>
    Object.values(state().tabs)
      .filter((t) => t.ref.kind === "session-picker")
      .map((t) => (t.ref.kind === "session-picker" ? t.ref.cwd : ""));

  it("right-click opens a context menu carrying 'Recover session…'", () => {
    fleet().applyAgentEvent(started("a1", { title: "Pull latest changes" }));
    renderRow("a1");

    fireEvent.contextMenu(row(), { clientX: 40, clientY: 60 });

    expect(
      screen.getByRole("menu", { name: "Actions for agent Pull latest changes" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Recover session…" }),
    ).toBeInTheDocument();
  });

  it("suppresses the OS/webview menu (preventDefault)", () => {
    fleet().applyAgentEvent(started("a1"));
    renderRow("a1");

    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    fireEvent(row(), event);

    expect(event.defaultPrevented).toBe(true);
  });

  it("selecting the item opens the session picker for the agent's folder and closes the menu", async () => {
    const user = userEvent.setup();
    fleet().applyAgentEvent(started("a1", { cwd: "/w/gazelle" }));
    renderRow("a1");

    fireEvent.contextMenu(row());
    await user.click(screen.getByRole("menuitem", { name: "Recover session…" }));

    expect(pickerCwds()).toEqual(["/w/gazelle"]);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("a SUB-AGENT row opens the picker for its ROOT agent's cwd — the root-cwd rule", async () => {
    // The child event carries its own cwd; the picker must ignore it and use
    // the root's folder — a sub-agent has no folder of its own.
    const user = userEvent.setup();
    fleet().applyAgentEvent(started("root", { cwd: "/w/root-folder" }));
    fleet().applyAgentEvent(spawn("root", "kid", "/w/child-scratch"));
    renderRow("kid", { depth: 1 });

    fireEvent.contextMenu(row());
    await user.click(screen.getByRole("menuitem", { name: "Recover session…" }));

    expect(pickerCwds()).toEqual(["/w/root-folder"]);
  });

  it("Escape closes the menu without opening anything", async () => {
    const user = userEvent.setup();
    fleet().applyAgentEvent(started("a1"));
    renderRow("a1");

    fireEvent.contextMenu(row());
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(pickerCwds()).toEqual([]);
  });
});

/* Helpers ------------------------------------------------------------------ */

/** A keydown we can inspect for preventDefault — fireEvent's return value only
 *  reports it indirectly, and `user.keyboard` gives us no event handle at all. */
function createKeyDown(key: string): KeyboardEvent {
  return new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
}

describe("AgentRow — ↻ Resume on a finished root", () => {
  const exited = (agentId: string, code: number): AgentEvent => ({ t: "exited", agentId: id(agentId), code });

  it("a root whose claude died offers Resume, and it resumes that agent in its folder", async () => {
    fleet().applyAgentEvent(started("a1", { title: "deploy", cwd: "/w/gazelle" }));
    fleet().applyAgentEvent(exited("a1", 137));
    renderRow("a1");
    await userEvent.click(screen.getByRole("button", { name: "Resume conversation deploy" }));
    expect(resume).toHaveBeenCalledWith("a1", "/w/gazelle");
    expect(state().selection.selectedAgentId).not.toBe("a1"); // resuming is not selecting
  });

  it("a live root has no Resume button and no Resume menu item", () => {
    fleet().applyAgentEvent(started("a2", { title: "live" }));
    renderRow("a2");
    expect(screen.queryByRole("button", { name: /Resume conversation/ })).toBeNull();
    fireEvent.contextMenu(row(), { clientX: 1, clientY: 1 });
    expect(screen.queryByRole("menuitem", { name: "Resume conversation" })).toBeNull();
  });

  it("the right-click menu of a finished root leads with Resume conversation", async () => {
    resume.mockClear();
    fleet().applyAgentEvent(started("a3", { title: "done-one", cwd: "/w/x" }));
    fleet().applyAgentEvent(exited("a3", 0));
    renderRow("a3");
    fireEvent.contextMenu(row(), { clientX: 1, clientY: 1 });
    const items = screen.getAllByRole("menuitem").map((m) => m.textContent);
    expect(items[0]).toBe("Resume conversation");
    await userEvent.click(screen.getByRole("menuitem", { name: "Resume conversation" }));
    expect(resume).toHaveBeenCalledWith("a3", "/w/x");
  });
});

