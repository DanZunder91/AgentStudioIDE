/** Only IPC is mocked, so this owns the seam: select a root agent, the card reads THAT agent, the
 * bar draws it. Real layout is context.browser.test.tsx's job. */

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useAppStore } from "../../app/store";
import { asAgentId, type AgentNode, type AgentStatus } from "../../app/types";
import { resetFleetStore, wireAgent } from "../../test/fleet-harness";
import { installTauriMock, type TauriMock } from "../../test/tauri-mock";
import {
  CONTEXT_CAVEAT,
  ContextCard,
  NO_SELECTION_NOTE,
  SUB_AGENT_NOTE,
} from "./ContextBar";
import { resetContextStore, useContextStore } from "./contextStore";
import type { ContextUsage } from "./contextTypes";

const NOW = 1_785_200_000_000;

/** The reference reading: 290.7k of 1m. */
const READING: ContextUsage = {
  model: "claude-opus-5-5",
  usedTokens: 290_700,
  windowTokens: 1_000_000,
  usedPercent: 29,
  categories: [
    { key: "system-prompt", label: "System prompt", tokens: 2_300, percent: 0.2 },
    { key: "system-tools", label: "System tools", tokens: 20_400, percent: 2 },
    { key: "mcp-server-instructions", label: "MCP server instructions", tokens: 717, percent: 0.1 },
    { key: "memory-files", label: "Memory files", tokens: 4_800, percent: 0.5 },
    { key: "skills", label: "Skills", tokens: 4_600, percent: 0.5 },
    { key: "messages", label: "Messages", tokens: 257_900, percent: 25.8 },
    { key: "free-space", label: "Free space", tokens: 676_300, percent: 67.6 },
    { key: "autocompact-buffer", label: "Autocompact buffer", tokens: 33_000, percent: 3.3 },
  ],
  measuredAtMs: NOW - 3 * 60_000,
};

/** Put an agent in the store as the client holds it (wire shape + client fields). */
function seedAgent(partial: Omit<Partial<AgentNode>, "id"> & { id: string }): void {
  const id = asAgentId(partial.id);
  const node: AgentNode = {
    ...wireAgent({ ...partial, id }),
    childIds: [],
    sessionId: null,
    expanded: false,
    unread: 0,
    ...partial,
    id,
  };
  act(() => {
    useAppStore.setState((s) => {
      s.agents[id] = node;
      if (node.parentId === null && !s.rootAgentIds.includes(id)) s.rootAgentIds.push(id);
    });
  });
}

function select(id: string | null): void {
  act(() => {
    useAppStore.setState((s) => {
      s.selection.selectedAgentId = id === null ? null : asAgentId(id);
    });
  });
}

function setStatus(id: string, status: AgentStatus): void {
  act(() => {
    useAppStore.setState((s) => {
      s.agents[asAgentId(id)].status = status;
    });
  });
}

/** sessionId: null is what the store really holds; the card must measure by agent id anyway. */
function selectRoot(id = "root-a", status: AgentStatus = "idle"): void {
  seedAgent({ id, status });
  select(id);
}

let ipc: TauriMock;

beforeEach(() => {
  resetFleetStore();
  resetContextStore();
  ipc = installTauriMock();
});
afterEach(() => {
  cleanup();
  ipc.reset();
});

describe("what the selection lets the card measure", () => {
  it("no agent selected → a calm prompt, and no CLI is spawned", () => {
    render(<ContextCard nowMs={NOW} />);
    expect(screen.getByTestId("context-note")).toHaveTextContent(NO_SELECTION_NOTE);
    expect(screen.queryByTestId("context-refresh")).toBeNull();
    expect(ipc.calls("context_usage")).toHaveLength(0);
  });

  it("a sub-agent → 'shown for root agents', and no CLI is spawned", () => {
    seedAgent({ id: "root-a" });
    seedAgent({ id: "sub-1", parentId: asAgentId("root-a"), kind: "subagent" });
    select("sub-1");
    render(<ContextCard nowMs={NOW} />);
    expect(screen.getByTestId("context-note")).toHaveTextContent(SUB_AGENT_NOTE);
    expect(ipc.calls("context_usage")).toHaveLength(0);
  });

  it("a root agent is measured by its agent id even though the store holds no session id for it", () => {
    // The regression this pins: the first build gated on `AgentNode.sessionId`, which
    // is null for every agent, so the card never asked for anything in the real app.
    ipc.handle("context_usage", () => new Promise(() => {}));
    seedAgent({ id: "root-a", sessionId: null });
    select("root-a");
    render(<ContextCard nowMs={NOW} />);
    expect(screen.queryByTestId("context-note")).toBeNull();
    expect(ipc.lastCall("context_usage")).toEqual({ agentId: "root-a" });
  });

  it("a selection pointing at an agent that no longer exists reads as 'nothing selected'", () => {
    select("ghost");
    render(<ContextCard nowMs={NOW} />);
    expect(screen.getByTestId("context-note")).toHaveTextContent(NO_SELECTION_NOTE);
  });
});

describe("a reading", () => {
  async function renderReading(): Promise<void> {
    ipc.handle("context_usage", () => READING);
    selectRoot();
    render(<ContextCard nowMs={NOW} />);
    await screen.findByTestId("context-bar");
  }

  it("asks for the SELECTED root by agent id, and shows 'Measuring…' until it lands", async () => {
    let resolve!: (v: ContextUsage) => void;
    ipc.handle("context_usage", () => new Promise<ContextUsage>((r) => (resolve = r)));
    selectRoot("root-a");
    render(<ContextCard nowMs={NOW} />);

    expect(ipc.lastCall("context_usage")).toEqual({ agentId: "root-a" });
    expect(screen.getByTestId("context-loading")).toHaveTextContent("Measuring context…");
    expect(screen.getByTestId("context-refresh")).toBeDisabled();
    expect(screen.getByTestId("context-refresh")).toHaveAttribute("aria-busy", "true");
    // Nothing invented while we wait: no summary, no chip, no caveat.
    expect(screen.queryByTestId("context-summary")).toBeNull();
    expect(screen.queryByTestId("context-caveat")).toBeNull();

    await act(async () => resolve(READING));
    expect(screen.getByTestId("context-bar")).toBeInTheDocument();
    expect(screen.getByTestId("context-refresh")).toBeEnabled();
  });

  it("header: '◆ context', used of window · compacts at, and a green chip under 50%", async () => {
    await renderReading();
    const card = screen.getByTestId("context-card");
    expect(within(card).getByText("context")).toBeInTheDocument();
    expect(screen.getByTestId("context-summary")).toHaveTextContent("290.7k of 1m · compacts at 967k");
    const chip = screen.getByTestId("context-chip");
    expect(chip).toHaveTextContent("29%");
    expect(chip).toHaveAttribute("data-tone", "ok");
    expect(chip).toHaveAttribute("aria-label", "Context window 29% full");
  });

  it.each([
    [55, "warn"],
    [92.4, "danger"],
  ] as const)("the chip at %d%% is %s", async (usedPercent, tone) => {
    ipc.handle("context_usage", () => ({ ...READING, usedPercent }));
    selectRoot();
    render(<ContextCard nowMs={NOW} />);
    expect(await screen.findByTestId("context-chip")).toHaveAttribute("data-tone", tone);
  });

  it("bar: one segment per category, in printed order, widths ∝ tokens / window", async () => {
    await renderReading();
    const segs = screen.getAllByTestId("context-seg");
    expect(segs.map((s) => s.dataset.key)).toEqual([
      "system-prompt",
      "system-tools",
      "mcp-server-instructions",
      "memory-files",
      "skills",
      "messages",
      "free-space",
      "autocompact-buffer",
    ]);
    const widths = segs.map((s) => parseFloat(s.style.width));
    [0.23, 2.04, 0.0717, 0.48, 0.46, 25.79, 67.63, 3.3].forEach((w, i) => expect(widths[i]).toBeCloseTo(w, 6));
    // Proportional in the strict sense: messages is exactly 257.9 / 20.4 × system tools.
    expect(widths[5] / widths[1]).toBeCloseTo(257_900 / 20_400, 9);
  });

  it("bar: free space is the bare track, the buffer is hatched, and the marker sits at window − buffer", async () => {
    await renderReading();
    const [free, buffer] = ["free-space", "autocompact-buffer"].map(
      (k) => screen.getAllByTestId("context-seg").find((s) => s.dataset.key === k)!,
    );
    expect(free).toHaveClass("context-bar__seg--free");
    expect(free.style.getPropertyValue("--seg-colour")).toBe("");
    expect(buffer).toHaveClass("context-bar__seg--buffer");
    expect(buffer.style.getPropertyValue("--seg-colour")).toBe("var(--context-autocompact-buffer)");
    expect(parseFloat(screen.getByTestId("context-marker").style.left)).toBeCloseTo(96.7017, 6);

    const messages = screen.getAllByTestId("context-seg").find((s) => s.dataset.key === "messages")!;
    expect(messages.style.getPropertyValue("--seg-colour")).toBe("var(--context-messages)");
    expect(messages).toHaveAttribute("title", "Messages: 257.9k");
    expect(screen.getByTestId("context-bar")).toHaveAttribute(
      "aria-label",
      "Context window: 290.7k of 1m · compacts at 967k",
    );
  });

  it("bar: no buffer row → no marker", async () => {
    ipc.handle("context_usage", () => ({
      ...READING,
      categories: READING.categories.filter((c) => c.key !== "autocompact-buffer"),
    }));
    selectRoot();
    render(<ContextCard nowMs={NOW} />);
    await screen.findByTestId("context-bar");
    expect(screen.queryByTestId("context-marker")).toBeNull();
    expect(screen.getByTestId("context-summary")).toHaveTextContent(/^290\.7k of 1m$/);
  });

  it("legend: swatch · label · tokens · dimmed percent — and free space shows tokens only", async () => {
    await renderReading();
    const items = screen.getAllByTestId("context-legend-item");
    expect(items.map((li) => li.textContent)).toEqual([
      "System prompt2.3k0.2%",
      "System tools20.4k2%",
      "MCP server instructions7170.1%",
      "Memory files4.8k0.5%",
      "Skills4.6k0.5%",
      "Messages257.9k25.8%",
      "Free space676.3k",
      "Autocompact buffer33k3.3%",
    ]);
    const skills = items[4];
    expect(skills.querySelector(".context-legend__pct")).toHaveTextContent("0.5%");
    expect(
      (skills.querySelector(".context-legend__swatch") as HTMLElement).style.getPropertyValue("--seg-colour"),
    ).toBe("var(--context-skills)");
    expect(items[6].querySelector(".context-legend__swatch")).toHaveClass("context-legend__swatch--free");
    expect(items[7].querySelector(".context-legend__swatch")).toHaveClass("context-legend__swatch--buffer");
  });

  it("an unknown category still renders — with a deterministic fallback colour", async () => {
    ipc.handle("context_usage", () => ({
      ...READING,
      categories: [{ key: "plugins", label: "Plugins", tokens: 1_000, percent: 0.1 }, ...READING.categories],
    }));
    selectRoot();
    render(<ContextCard nowMs={NOW} />);
    await screen.findByTestId("context-bar");
    const seg = screen.getAllByTestId("context-seg")[0];
    expect(seg.dataset.key).toBe("plugins");
    expect(seg.style.getPropertyValue("--seg-colour")).toBe("var(--context-extra-5)");
    expect(screen.getAllByTestId("context-legend-item")[0]).toHaveTextContent("Plugins1k0.1%");
  });

  it("footer: model, 'measured <relative>', and the estimate caveat", async () => {
    await renderReading();
    expect(screen.getByTestId("context-model")).toHaveTextContent("claude-opus-5-5");
    expect(screen.getByTestId("context-measured")).toHaveTextContent("measured 3 min ago");
    expect(screen.getByTestId("context-caveat")).toHaveTextContent(CONTEXT_CAVEAT);
    expect(CONTEXT_CAVEAT).toBe("Estimated by the claude CLI for this session (same as /context)");
  });

  it("the relative time follows the host's clock prop", async () => {
    ipc.handle("context_usage", () => READING);
    selectRoot();
    const { rerender } = render(<ContextCard nowMs={NOW} />);
    await screen.findByTestId("context-measured");
    rerender(<ContextCard nowMs={NOW + 2 * 3_600_000} />);
    expect(screen.getByTestId("context-measured")).toHaveTextContent("measured 2 h ago");
  });
});

describe("Bar | Grid", () => {
  it("Grid draws the 20×10 cell grid: 200 cells, coloured by category, free outlined, buffer crossed", async () => {
    ipc.handle("context_usage", () => READING);
    selectRoot();
    render(<ContextCard nowMs={NOW} />);
    await screen.findByTestId("context-bar");
    expect(screen.getByTestId("context-view-bar")).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByTestId("context-view-grid"));
    expect(screen.queryByTestId("context-bar")).toBeNull();
    expect(screen.getByTestId("context-view-grid")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("context-view-bar")).toHaveAttribute("aria-pressed", "false");

    const grid = screen.getByTestId("context-grid");
    expect(grid.style.getPropertyValue("--grid-columns")).toBe("20");
    const cells = screen.getAllByTestId("context-cell");
    expect(cells).toHaveLength(200);
    const count = (k: string) => cells.filter((c) => c.dataset.key === k).length;
    expect(count("messages")).toBe(52);
    expect(count("system-tools")).toBe(4);
    expect(count("mcp-server-instructions")).toBe(1);
    expect(count("free-space")).toBe(133);
    expect(count("autocompact-buffer")).toBe(7);

    const free = cells.find((c) => c.dataset.key === "free-space")!;
    expect(free).toHaveClass("context-grid__cell--free");
    expect(free.style.getPropertyValue("--seg-colour")).toBe("");
    expect(cells[199]).toHaveClass("context-grid__cell--buffer");
    expect(cells[0].style.getPropertyValue("--seg-colour")).toBe("var(--context-system-prompt)");
    // The legend stays under the grid too.
    expect(screen.getAllByTestId("context-legend-item")).toHaveLength(8);

    fireEvent.click(screen.getByTestId("context-view-bar"));
    expect(screen.getByTestId("context-bar")).toBeInTheDocument();
  });

  it("the choice survives the card unmounting (a hidden tab must not snap back to Bar)", async () => {
    ipc.handle("context_usage", () => READING);
    selectRoot();
    const first = render(<ContextCard nowMs={NOW} />);
    await screen.findByTestId("context-bar");
    fireEvent.click(screen.getByTestId("context-view-grid"));
    first.unmount();

    render(<ContextCard nowMs={NOW} />);
    expect(screen.getByTestId("context-grid")).toBeInTheDocument();
    expect(useContextStore.getState().view).toBe("grid");
  });
});

describe("errors", () => {
  it.each([
    ["no-session: no conversation", "This agent hasn't had a conversation yet — its context appears after the first prompt.", true],
    ["cli-missing", "Couldn't find the claude CLI — install it, or make sure it is on the PATH this app sees, then retry.", false],
    ["bad-session: not a live root agent", "This agent isn't a live root session the app can read — its context can't be measured.", false],
    ["cli-failed: exit 2", "The claude CLI ran but exited with an error — retry, or run /context in the agent's terminal to see what it reports.", false],
    ["timeout", "The claude CLI did not answer in time — retry in a moment.", false],
    ["parse: no table", "The claude CLI answered, but not with a table this card can read — its wording has probably changed, so retrying will not help.", false],
    ["something brand new", "The context read failed for an unrecognized reason — retrying may help.", false],
  ])("%j renders its plain-language sentence (calm: %s)", async (raw, sentence, calm) => {
    ipc.handle("context_usage", () => Promise.reject(raw));
    selectRoot();
    render(<ContextCard nowMs={NOW} />);
    const err = await screen.findByTestId("context-error");
    expect(err).toHaveTextContent(sentence);
    expect(err).toHaveAttribute("role", "status");
    expect(err.classList.contains("context-card__note--error")).toBe(!calm);
    // The raw detail never reaches the screen.
    expect(screen.getByTestId("context-card").textContent).not.toContain("not a live root agent");
    // ↻ is still there to retry with; the caveat is not (there are no numbers to qualify).
    expect(screen.getByTestId("context-refresh")).toBeEnabled();
    expect(screen.queryByTestId("context-caveat")).toBeNull();
  });

  it("a failed refresh over a good reading keeps the reading, dimmed, and says why", async () => {
    let fail = false;
    ipc.handle("context_usage", () => (fail ? Promise.reject("timeout") : READING));
    selectRoot();
    render(<ContextCard nowMs={NOW} />);
    await screen.findByTestId("context-bar");

    fail = true;
    await act(async () => {
      fireEvent.click(screen.getByTestId("context-refresh"));
    });
    const stale = await screen.findByTestId("context-stale");
    expect(stale).toHaveTextContent(
      "Last refresh failed — showing the last good reading. The claude CLI did not answer in time — retry in a moment.",
    );
    expect(screen.getByTestId("context-card")).toHaveClass("context-card--stale");
    expect(screen.getByTestId("context-bar")).toBeInTheDocument();
    expect(screen.getByTestId("context-summary")).toHaveTextContent("290.7k of 1m");
  });
});

describe("when the card re-reads", () => {
  it("↻ re-reads the selected session", async () => {
    ipc.handle("context_usage", () => READING);
    selectRoot();
    render(<ContextCard nowMs={NOW} />);
    await screen.findByTestId("context-bar");
    expect(ipc.calls("context_usage")).toHaveLength(1);

    await act(async () => {
      fireEvent.click(screen.getByTestId("context-refresh"));
    });
    expect(ipc.calls("context_usage")).toHaveLength(2);
    expect(ipc.lastCall("context_usage")).toEqual({ agentId: "root-a" });
  });

  it("selection change reads the new agent; switching back shows the first reading at once", async () => {
    ipc.handle("context_usage", (args) =>
      args.agentId === "root-a" ? READING : { ...READING, usedTokens: 900_000, usedPercent: 90, model: "claude-b" },
    );
    seedAgent({ id: "root-b" });
    selectRoot();
    render(<ContextCard nowMs={NOW} />);
    expect(await screen.findByTestId("context-summary")).toHaveTextContent("290.7k of 1m");

    select("root-b");
    expect(await screen.findByText("claude-b")).toBeInTheDocument();
    expect(ipc.lastCall("context_usage")).toEqual({ agentId: "root-b" });
    expect(screen.getByTestId("context-chip")).toHaveAttribute("data-tone", "danger");

    // Back to A: its reading is on screen synchronously (cached), while a fresh read runs.
    select("root-a");
    expect(screen.getByTestId("context-model")).toHaveTextContent("claude-opus-5-5");
    expect(ipc.calls("context_usage")).toHaveLength(3);
  });

  it("the agent's turn ending (status → idle) re-reads; other status changes do not", async () => {
    ipc.handle("context_usage", () => READING);
    selectRoot("root-a", "running");
    render(<ContextCard nowMs={NOW} />);
    await screen.findByTestId("context-bar");
    expect(ipc.calls("context_usage")).toHaveLength(1);

    setStatus("root-a", "waiting_input");
    expect(ipc.calls("context_usage")).toHaveLength(1);

    await act(async () => setStatus("root-a", "idle"));
    expect(ipc.calls("context_usage")).toHaveLength(2);

    // Still idle on an unrelated re-render: not an edge, no read.
    act(() => {
      useAppStore.setState((s) => {
        s.agents[asAgentId("root-a")].lastActivityAt = 99;
      });
    });
    expect(ipc.calls("context_usage")).toHaveLength(2);
  });

  it("never polls: no timer re-reads while nothing changes", async () => {
    ipc.handle("context_usage", () => READING);
    selectRoot();
    render(<ContextCard nowMs={NOW} />);
    await screen.findByTestId("context-bar");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(ipc.calls("context_usage")).toHaveLength(1);
  });
});
