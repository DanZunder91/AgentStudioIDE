/** Load-bearing: no rendered text, title or aria-label holds any sum of token classes, and the two
 * tier labels ("All devices · from your Claude account" / "This machine"). Both stores are mocked
 * at the module boundary; `usageFormat` is real, since its strings are the contract. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { useAppStore } from "../../app/store";
import { asAgentId } from "../../app/types";
import { resetFleetStore, wireAgent } from "../../test/fleet-harness";
import { installTauriMock, type TauriMock } from "../../test/tauri-mock";
import { resetContextStore } from "../context/contextStore";
import type { ContextUsage } from "../context/contextTypes";
import type { UsageSnapshot } from "../usage/usageTypes";
import type {
  HourBucket,
  MetricsReport,
  MetricsScopeKind,
  MetricsWindowKind,
  TurnRow,
} from "./metricsTypes";

const {
  mockEnsure,
  mockRefresh,
  mockSetWindow,
  mockSetScope,
  mockStartPolling,
  mockStopPolling,
  storeState,
  usageState,
} = vi.hoisted(() => ({
  mockEnsure: vi.fn<(cwd: string | null) => void>(),
  mockRefresh: vi.fn<() => Promise<void>>(),
  mockSetWindow: vi.fn<(w: string) => Promise<void>>(),
  mockSetScope: vi.fn<(s: string) => Promise<void>>(),
  mockStopPolling: vi.fn<() => void>(),
  mockStartPolling: vi.fn<() => () => void>(),
  storeState: {
    current: {} as Record<string, unknown>,
  },
  usageState: {
    current: {} as Record<string, unknown>,
  },
}));

vi.mock("./metricsStore", () => ({
  ensureMetrics: mockEnsure,
  // A `useSyncExternalStore`-free stand-in: the panel only ever reads via selectors,
  // so a plain selector-applier is a faithful and fully synchronous substitute.
  useMetricsStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector(storeState.current),
}));

// `features/usage` is consumed, never modified; its poller semantics live in `usageStore.test.ts`.
vi.mock("../usage/usageStore", () => ({
  startUsagePolling: mockStartPolling,
  useUsageStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector(usageState.current),
}));

// Imported AFTER the mocks so the panel picks them up.
const { MetricsPanel, barPath, niceMax } = await import("./MetricsPanel");

const HOUR = 3_600_000;
const FROM = new Date(2026, 6, 28, 12, 0, 0).getTime();

function hourly(counts: number[]): HourBucket[] {
  return counts.map((requests, i) => ({
    startMs: FROM + i * HOUR,
    requests,
    output: requests * 100,
  }));
}

function turn(patch: Partial<TurnRow> = {}): TurnRow {
  return {
    turnId: "turn-a",
    sessionId: "0000dddd-0000-4000-8000-0000000000e5",
    rootId: "local",
    projectLabel: "Agent Studio",
    label: "add a metrics tab",
    startedAtMs: new Date(2026, 6, 29, 10, 0, 0).getTime(),
    endedAtMs: new Date(2026, 6, 29, 10, 4, 30).getTime(),
    durationMs: 270_000,
    durationSource: "cli",
    requests: 44,
    tokens: { freshInput: 200, output: 60_000, cacheWrite: 12_000, cacheRead: 12_000_000 },
    toolCalls: 47,
    toolErrors: 2,
    filesChanged: 0,
    interrupted: false,
    humanPrompt: true,
    models: ["claude-opus-5"],
    ...patch,
  };
}

/** Realistic 24 h proportions (invented figures), so any leaked sum is big and distinctive. */
function report(patch: Partial<MetricsReport> = {}): MetricsReport {
  return {
    window: { kind: "last_24h", fromMs: FROM, toMs: FROM + 24 * HOUR },
    scope: { kind: "project", cwd: "/work/proj" },
    totals: {
      sessions: 3,
      turns: 11,
      humanTurns: 8,
      requests: 1_250,
      tokens: {
        freshInput: 12_345,
        output: 456_789,
        cacheWrite: 3_876_543,
        cacheRead: 201_234_567,
      },
      avgContextPerRequest: 145_000,
      highContextRequestShare: 0.55,
      toolCalls: 300,
      toolErrors: 9,
      filesChanged: 18,
      timeInTurnsMs: 4 * HOUR + 12 * 60_000,
      turnsWithDuration: 6,
    },
    perRoot: [
      {
        rootId: "local",
        label: "This machine",
        available: true,
        sessions: 3,
        turns: 11,
        requests: 1_250,
        tokens: {
          freshInput: 12_345,
          output: 456_789,
          cacheWrite: 3_876_543,
          cacheRead: 201_234_567,
        },
      },
    ],
    hourly: hourly([0, 3, 12, 0, 40, 7, 0, 0, 1, 90, 33, 5, 0, 0, 2, 8, 19, 0, 0, 4, 60, 12, 0, 1]),
    topTurns: [turn(), turn({ turnId: "turn-b", label: "fix the build", requests: 15 })],
    coverage: {
      rootsScanned: 1,
      rootsUnavailable: [],
      filesConsidered: 150,
      filesRead: 6,
      bytesRead: 8_000_000,
      scanMs: 100,
      filesTruncated: 0,
      linesUnparseable: 0,
      turnsWithoutCliDuration: 5,
      turnsWithoutPromptId: 0,
      scopeFellBackToAll: false,
      partial: false,
    },
    scannedAtMs: Date.now(),
    ...patch,
  };
}

function setStore(patch: {
  report?: MetricsReport | null;
  error?: string | null;
  loading?: boolean;
  window?: MetricsWindowKind;
  scope?: MetricsScopeKind;
  cwd?: string | null;
}): void {
  storeState.current = {
    report: patch.report ?? null,
    error: patch.error ?? null,
    loading: patch.loading ?? false,
    query: {
      window: patch.window ?? ("last_24h" as MetricsWindowKind),
      // Defaults to ALL, because that is what the store defaults to now (it is
      // about total usage on the machine, not about one project). A
      // harness that defaulted to `project` would quietly test the old product.
      scope: patch.scope ?? ("all" as MetricsScopeKind),
      cwd: patch.cwd ?? "/work/proj",
    },
    refresh: mockRefresh,
    setWindow: mockSetWindow,
    // Without this the panel reads `setScope` as undefined and clicking the toggle
    // throws — which no test caught, because no test clicked it.
    setScope: mockSetScope,
    setCwd: vi.fn(),
  };
}

beforeEach(() => {
  mockEnsure.mockReset();
  mockRefresh.mockReset().mockResolvedValue(undefined);
  mockSetWindow.mockReset().mockResolvedValue(undefined);
  setStore({});
  // Reset the consumed usage store per test, like the store under test.
  usageState.current = { snapshot: null, error: null, loading: false, refresh: vi.fn() };
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ── 🔴 the token-class trap, encoded as a gate ─────────────────────────────── */

describe("the four token classes", () => {
  it("renders four SEPARATE token tiles plus the derived average", async () => {
    setStore({ report: report() });
    render(<MetricsPanel cwd="/work/proj" />);

    const tiles = screen.getAllByTestId("metrics-token-tile");
    // Four measured classes, and structurally nowhere to put a fifth.
    expect(tiles).toHaveLength(4);
    const labels = tiles.map((t) => t.querySelector(".metrics__token-label")?.textContent);
    expect(labels).toEqual(["Fresh input", "Output", "Cache write", "Cache read"]);

    // Each shows its own compacted figure — 12.3k / 456.8k / 3.9M / 201.2M.
    const values = tiles.map((t) => t.querySelector(".metrics__token-value")?.textContent);
    expect(values).toEqual(["12.3k", "456.8k", "3.9M", "201.2M"]);

    // The derived tile is a separate element with a different class, so a reader can
    // tell "the API reported this" from "we computed this".
    const derived = screen.getByTestId("metrics-avg-context");
    expect(derived.className).toContain("metrics__token--derived");
    expect(derived.textContent).toContain("145.0k");
    expect(derived.textContent).toContain("55% at ≥150k");
  });

  it("🔴 no rendered element contains a summed token total — anywhere, including titles", () => {
    const r = report();
    setStore({ report: r });
    const { container } = render(<MetricsPanel cwd="/work/proj" />);

    const { freshInput, output, cacheWrite, cacheRead } = r.totals.tokens;
    // Every sum a "helpful" simplification would reach for: the grand total, and every
    // pair/triple that could stand in for one.
    const forbidden = new Map<string, number>([
      ["all four", freshInput + output + cacheWrite + cacheRead],
      ["input-ish", freshInput + cacheWrite + cacheRead + output],
      ["fresh + output", freshInput + output],
      ["cache pair", cacheWrite + cacheRead],
      ["output + cacheRead", output + cacheRead],
      ["fresh + cacheRead", freshInput + cacheRead],
      ["fresh + cacheWrite", freshInput + cacheWrite],
      ["output + cacheWrite", output + cacheWrite],
      ["all but fresh", output + cacheWrite + cacheRead],
      ["all but output", freshInput + cacheWrite + cacheRead],
    ]);

    // Every rendered string: text content AND the attributes that carry numbers into
    // tooltips and the a11y tree, where a total would be invisible to a screenshot.
    const haystacks: string[] = [container.textContent ?? ""];
    for (const el of container.querySelectorAll("*")) {
      for (const attr of ["title", "aria-label", "aria-valuetext", "data-total"]) {
        const value = el.getAttribute(attr);
        if (value !== null) haystacks.push(value);
      }
    }
    const haystack = haystacks.join(" | ");

    for (const [name, sum] of forbidden) {
      // Both spellings a formatter could produce.
      const exact = sum.toLocaleString("en-US");
      const plain = `${sum}`;
      expect(haystack, `a "${name}" total (${exact}) must never be rendered`).not.toContain(
        exact,
      );
      expect(haystack, `a "${name}" total (${plain}) must never be rendered`).not.toContain(
        plain,
      );
    }

    // Sanity: the sweep is looking at a surface that really does show the classes. A
    // passing sweep over an empty DOM would be a false green.
    expect(haystack).toContain("201.2M");
    expect(haystack).toContain("201,234,567");
  });

  it("prints the REASON the total is absent, so a user cannot read it as a bug", () => {
    setStore({ report: report() });
    render(<MetricsPanel cwd="/work/proj" />);

    const group = screen.getByTestId("metrics-tokens");
    expect(group.textContent).toContain("Tokens — four classes, never summed");
    expect(group.textContent).toContain("~0.1× the price of fresh input");
    expect(group.textContent).toContain("97.9%");
  });
});

/* ── visual hierarchy ───────────────────────────────────────────────────────── */

describe("visual hierarchy", () => {
  it("has exactly ONE hero, and it carries the leading figure", () => {
    setStore({ report: report() });
    render(<MetricsPanel cwd="/work/proj" />);

    // One hero element — six equally-weighted tiles is a table dump, not a dashboard.
    expect(screen.getAllByTestId("metrics-hero")).toHaveLength(1);
    expect(screen.getByTestId("metrics-hero-value").textContent).toBe("4h 12m");
    expect(screen.getByTestId("metrics-hero-sub").textContent).toBe(
      "8 human turns across 3 sessions · 3 system-initiated",
    );
    // The definition is on screen, not in a tooltip.
    expect(screen.getByTestId("metrics-hero").textContent).toContain("not wall clock");
    // …and it says how many of the turns were actually measured.
    expect(screen.getByTestId("metrics-hero").textContent).toContain("6 of 11 turns measured");
  });

  it("renders the KPI row subordinate to the hero, as six tiles", () => {
    setStore({ report: report() });
    render(<MetricsPanel cwd="/work/proj" />);

    const kpis = screen.getAllByTestId("metrics-kpi");
    expect(kpis).toHaveLength(6);
    expect(kpis.map((k) => k.querySelector(".metrics__kpi-label")?.textContent)).toEqual([
      "Sessions",
      "Turns",
      "Requests",
      "Tool calls",
      "Tool errors",
      "Files changed",
    ]);
    expect(within(kpis[2]).getByText("1,250")).toBeTruthy();
  });

  it("labels the numbers as THIS MACHINE's, and says sub-agents are not counted yet", () => {
    setStore({ report: report() });
    render(<MetricsPanel cwd="/work/proj" />);

    // A number may never be labelled "all my usage" unless it came from the
    // account. These came from local transcripts, and the header says so.
    const tier = screen.getByTestId("metrics-tier");
    expect(tier.textContent).toContain("This machine · derived from local transcripts");
    expect(tier.textContent).toContain("sub-agent (fan-out) transcripts are not counted yet");
  });
});

/* ── the chart ──────────────────────────────────────────────────────────────── */

describe("the requests-per-hour chart", () => {
  it("draws one column per bucket, scaled to a clean axis maximum", () => {
    setStore({ report: report() });
    const { container } = render(<MetricsPanel cwd="/work/proj" />);

    const svg = screen.getByTestId("metrics-chart-svg");
    // viewBox + preserveAspectRatio="none" is what makes it scale without a
    // ResizeObserver (jsdom has no layout engine, so this is the only tier that can
    // assert the attributes; the geometry itself is browser-tier work).
    expect(svg.getAttribute("viewBox")).toBe("0 0 720 132");
    expect(svg.getAttribute("preserveAspectRatio")).toBe("none");

    // 24 buckets, but only the non-zero ones get a bar — an empty hour must not draw
    // a 0-height sliver that reads as "a little bit of activity".
    const bars = container.querySelectorAll(".metrics__bar");
    const nonZero = report().hourly.filter((b) => b.requests > 0).length;
    expect(bars).toHaveLength(nonZero);

    // The axis top is a clean number above the peak (90 → 100), not 90.
    expect(svg.textContent).toContain("100");
    expect(svg.textContent).toContain("0");
    // No animation elements — data that slides in is data you cannot read.
    expect(container.querySelectorAll("animate, animateTransform")).toHaveLength(0);
  });

  it("gives every column a <title>, so no value is reachable only by hovering", () => {
    setStore({ report: report() });
    const { container } = render(<MetricsPanel cwd="/work/proj" />);

    const titles = [...container.querySelectorAll(".metrics__chart-svg title")];
    expect(titles).toHaveLength(24);
    expect(titles.some((t) => t.textContent?.includes("90 requests"))).toBe(true);
  });

  it("Copy summary writes the whole series as text (the chart's table twin)", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    setStore({ report: report() });
    render(<MetricsPanel cwd="/work/proj" />);

    await userEvent.click(screen.getByTestId("metrics-copy-summary"));

    expect(writeText).toHaveBeenCalledTimes(1);
    const text = writeText.mock.calls[0][0] as string;
    expect(text.split("\n")).toHaveLength(24);
    expect(text).toContain("90 requests");
  });

  it("is a no-op when there is no clipboard, and swallows a rejection", async () => {
    setStore({ report: report() });
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    render(<MetricsPanel cwd="/work/proj" />);
    // Must not throw out of the click.
    await userEvent.click(screen.getByTestId("metrics-copy-summary"));

    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await userEvent.click(screen.getByTestId("metrics-copy-summary"));
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  it("survives a report with no buckets at all — no ticks, no crash", () => {
    // Rust always emits ≥1 bucket, but a chart that throws on an empty series is a
    // chart that takes the whole tab down for a wire change it should have shrugged at.
    setStore({ report: report({ hourly: [] }) });
    const { container } = render(<MetricsPanel cwd="/work/proj" />);

    expect(container.querySelectorAll(".metrics__bar")).toHaveLength(0);
    expect(container.querySelectorAll(".metrics__chart-svg text")).toHaveLength(2);
    expect(screen.getByTestId("metrics-chart-svg")).toBeTruthy();
  });

  it("draws a flat, honest axis for a window with no activity in any hour", () => {
    setStore({
      report: report({
        hourly: hourly(new Array(24).fill(0)),
        totals: { ...report().totals, requests: 0, avgContextPerRequest: null, highContextRequestShare: null },
      }),
    });
    const { container } = render(<MetricsPanel cwd="/work/proj" />);

    expect(container.querySelectorAll(".metrics__bar")).toHaveLength(0);
    // An axis for an empty series must not claim a scale it does not have.
    const svg = screen.getByTestId("metrics-chart-svg");
    expect(svg.textContent).toContain("0");
    // …and the derived tile shows a dash, never 0.
    expect(screen.getByTestId("metrics-avg-context").textContent).toContain("—");
  });
});

/* ── the chart's two pure pieces ────────────────────────────────────────────── */

describe("niceMax", () => {
  it("rounds the axis top to a clean 1/2/5 x a power of ten", () => {
    // An axis topping out at 37 makes the reader do arithmetic; one at 50 does not.
    expect(niceMax(1)).toBe(1);
    expect(niceMax(2)).toBe(2);
    expect(niceMax(3)).toBe(5);
    expect(niceMax(7)).toBe(10);
    expect(niceMax(37)).toBe(50);
    expect(niceMax(40)).toBe(50);
    expect(niceMax(51)).toBe(100);
    expect(niceMax(90)).toBe(100);
    expect(niceMax(150)).toBe(200);
    expect(niceMax(1_250)).toBe(2_000);
  });

  it("is exact on the step boundaries — 10 must not become 20", () => {
    expect(niceMax(10)).toBe(10);
    expect(niceMax(20)).toBe(20);
    expect(niceMax(50)).toBe(50);
    expect(niceMax(100)).toBe(100);
  });

  it("claims NO scale for an empty or unreadable series", () => {
    expect(niceMax(0)).toBe(0);
    expect(niceMax(-5)).toBe(0);
    expect(niceMax(NaN)).toBe(0);
    expect(niceMax(Infinity)).toBe(0);
  });
});

describe("barPath", () => {
  it("draws a rounded top and a SQUARE baseline, so bars sit ON the axis", () => {
    const d = barPath(10, 20, 24, 80);
    // Starts at the bottom-left corner (square), curves only at the top.
    expect(d.startsWith("M10 100")).toBe(true);
    expect(d.endsWith("L34 100 Z")).toBe(true);
    // Exactly two curves — the two top corners, and no others.
    expect(d.match(/Q/g)).toHaveLength(2);
  });

  it("clamps the radius so a 1-unit column cannot invert into a lens", () => {
    // r = min(4, w/2, h): a naive r=4 on h=1 draws a shape that bulges downwards.
    const thin = barPath(0, 0, 2, 1);
    expect(thin).toContain("M0 1");
    expect(thin.match(/Q/g)).toHaveLength(2);
    // Every coordinate stays inside the box the caller asked for.
    const numbers = thin.match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];
    expect(Math.min(...numbers)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...numbers)).toBeLessThanOrEqual(2);
  });
});

/* ── the top-turns table ────────────────────────────────────────────────────── */

describe("the top-turns table", () => {
  it("lists turns with the cli/derived marker and expands one in place", async () => {
    setStore({ report: report() });
    render(<MetricsPanel cwd="/work/proj" />);

    const rows = screen.getAllByTestId("metrics-turn-row");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("add a metrics tab")).toBeTruthy();
    expect(within(rows[0]).getByText("cli")).toBeTruthy();
    expect(within(rows[0]).getByText("2 err")).toBeTruthy();

    // No detail until asked — the table is scannable first.
    expect(screen.queryByTestId("metrics-turn-detail")).toBeNull();
    await userEvent.click(within(rows[0]).getByTestId("metrics-turn-toggle"));

    const detail = screen.getByTestId("metrics-turn-detail");
    // The corrected per-turn footer: the classes kept apart.
    expect(screen.getByTestId("metrics-turn-footer").textContent).toBe(
      "4m 30s · ↑200 fresh · ↓60.0k out · ♻12.0M cached",
    );
    expect(detail.textContent).toContain("Agent Studio");
    expect(detail.textContent).toContain("claude-opus-5");
    expect(detail.textContent).toContain("Sub-agent (fan-out) cost for this turn is not attributed yet.");

    // Expanded in place, not a modal — nothing here claims a dialog role.
    expect(screen.queryByRole("dialog")).toBeNull();

    // Clicking again collapses it; at most one detail is ever open.
    await userEvent.click(within(rows[0]).getByTestId("metrics-turn-toggle"));
    expect(screen.queryByTestId("metrics-turn-detail")).toBeNull();
  });

  it("opens only ONE detail at a time", async () => {
    setStore({ report: report() });
    render(<MetricsPanel cwd="/work/proj" />);
    const rows = screen.getAllByTestId("metrics-turn-row");

    await userEvent.click(within(rows[0]).getByTestId("metrics-turn-toggle"));
    await userEvent.click(within(rows[1]).getByTestId("metrics-turn-toggle"));

    expect(screen.getAllByTestId("metrics-turn-detail")).toHaveLength(1);
  });

  it("🔴 shows a DASH for an interrupted turn's duration, never 0", async () => {
    setStore({
      report: report({
        topTurns: [
          turn({
            turnId: "turn-int",
            label: "run the long task",
            durationMs: null,
            durationSource: null,
            interrupted: true,
          }),
        ],
      }),
    });
    render(<MetricsPanel cwd="/work/proj" />);

    const row = screen.getByTestId("metrics-turn-row");
    expect(within(row).getByText("—")).toBeTruthy();
    expect(within(row).getByText("interrupted")).toBeTruthy();
    // No source to claim when there is no duration.
    expect(within(row).queryByText("cli")).toBeNull();
    expect(within(row).queryByText("derived")).toBeNull();

    await userEvent.click(within(row).getByTestId("metrics-turn-toggle"));
    expect(screen.getByTestId("metrics-turn-detail").textContent).toContain("unknown");
  });

  it("says 'top N of M' when the table is capped, so the list never implies completeness", () => {
    setStore({ report: report({ totals: { ...report().totals, turns: 137 } }) });
    render(<MetricsPanel cwd="/work/proj" />);

    expect(screen.getByTestId("metrics-turns").textContent).toContain("Top 2 of 137 turns");
  });

  it("reports the whole count plainly when nothing is capped", () => {
    setStore({ report: report({ totals: { ...report().totals, turns: 2 } }) });
    render(<MetricsPanel cwd="/work/proj" />);

    expect(screen.getByTestId("metrics-turns").textContent).toContain("2 turns");
    expect(screen.getByTestId("metrics-turns").textContent).toContain(
      "Ranked by context volume",
    );
  });

  it("shows no error marker for a turn that had no tool errors", () => {
    setStore({ report: report({ topTurns: [turn({ toolErrors: 0 })] }) });
    render(<MetricsPanel cwd="/work/proj" />);

    // A "0 err" chip would be noise on the overwhelming majority of rows.
    expect(screen.queryByText(/err$/)).toBeNull();
    expect(
      screen.getByTestId("metrics-turn-row").querySelector(".metrics__src--warn"),
    ).toBeNull();
  });

  it("flags a CLI-initiated turn rather than counting it as a prompt", () => {
    setStore({ report: report({ topTurns: [turn({ humanPrompt: false })] }) });
    render(<MetricsPanel cwd="/work/proj" />);

    expect(within(screen.getByTestId("metrics-turn-row")).getByText("system")).toBeTruthy();
  });

  it("identifies a turn with no label by its session HANDLE, never by inventing text", async () => {
    // In "all" scope a turn has no prompt text, so the session handle lives in the expanded detail;
    // a labelless turn shows a truncated session id, never a blank or a made-up title.
    setStore({ report: report({ topTurns: [turn({ label: null })] }) });
    render(<MetricsPanel cwd="/work/proj" />);

    await userEvent.click(screen.getByTestId("metrics-turn-toggle"));
    const detail = screen.getByTestId("metrics-turn-detail");
    expect(within(detail).getByText("0000dddd…")).toBeTruthy();
    // …and only the first 8 chars: a full session id is an identifier we have no reason
    // to put on screen.
    expect(detail.textContent).not.toContain("0000dddd-0000");
  });

  it("shows a dash for a turn with no models", async () => {
    setStore({ report: report({ topTurns: [turn({ models: [] })] }) });
    render(<MetricsPanel cwd="/work/proj" />);
    await userEvent.click(screen.getByTestId("metrics-turn-toggle"));

    const detail = screen.getByTestId("metrics-turn-detail");
    expect(within(detail).getByText("—")).toBeTruthy();
  });
});

/* ── the four states ────────────────────────────────────────────────────────── */

describe("states", () => {
  it("shows a composed placeholder before the first report", () => {
    setStore({ report: null, error: null });
    render(<MetricsPanel cwd="/work/proj" />);

    expect(screen.getByTestId("metrics-placeholder").textContent).toContain(
      "Reading your sessions…",
    );
    // No freshness marker and no coverage badge to lie about yet.
    expect(screen.queryByTestId("metrics-scanned")).toBeNull();
    expect(screen.queryByTestId("metrics-coverage-badge")).toBeNull();
  });

  it("shows ONE TRUE SENTENCE when the scan failed with no report in hand", () => {
    setStore({ report: null, error: "home-unresolved" });
    render(<MetricsPanel cwd="/work/proj" />);

    const err = screen.getByTestId("metrics-error");
    expect(err.getAttribute("role")).toBe("status");
    expect(err.textContent).toContain("Could not read your sessions");
    expect(err.textContent).toContain("home directory could not be resolved");
    // Never a placeholder zero.
    expect(screen.queryByTestId("metrics-hero")).toBeNull();
  });

  it("shows a composed empty state for a window with no sessions — normal, not broken", () => {
    setStore({ report: report({ totals: { ...report().totals, turns: 0 } }) });
    render(<MetricsPanel cwd="/work/proj" />);

    const empty = screen.getByTestId("metrics-empty");
    expect(empty.textContent).toContain(
      "No Claude sessions found for this project in the last 24 h.",
    );
    expect(empty.textContent).toContain("150 transcripts checked");
    // The dashboard's rows are absent rather than showing zeros everywhere.
    expect(screen.queryByTestId("metrics-hero")).toBeNull();
    expect(screen.queryByTestId("metrics-tokens")).toBeNull();
    // …but the header is still there, so the user can change the window or rescan.
    expect(screen.getByTestId("metrics-rescan")).toBeTruthy();
  });

  it("pluralizes the empty state's transcript count", () => {
    setStore({
      report: report({
        totals: { ...report().totals, turns: 0 },
        coverage: { ...report().coverage, filesConsidered: 1 },
      }),
    });
    render(<MetricsPanel cwd="/work/proj" />);

    expect(screen.getByTestId("metrics-empty").textContent).toContain("1 transcript checked");
    expect(screen.getByTestId("metrics-empty").textContent).not.toContain("1 transcripts");
  });

  it("🔴 a failed rescan over good data KEEPS the numbers and marks them stale", () => {
    setStore({ report: report(), error: "unknown" });
    render(<MetricsPanel cwd="/work/proj" />);

    // The numbers survive.
    expect(screen.getByTestId("metrics-hero-value").textContent).toBe("4h 12m");
    // …and they are visibly not live.
    const stale = screen.getByTestId("metrics-stale");
    expect(stale.getAttribute("aria-label")).toBe(
      "Last scan failed — showing the last good numbers",
    );
    expect(screen.getByTestId("metrics-panel").className).toContain("metrics--stale");
    // The freshness string is REPLACED, not shown alongside — a failed rescan must not
    // be able to pass old numbers off as live.
    expect(screen.queryByTestId("metrics-scanned")).toBeNull();
    // And nothing renders as `?? 0`.
    expect(screen.getByTestId("metrics-panel").textContent).not.toContain("?? 0");
  });

  it("shows the freshness string when the report IS live", () => {
    setStore({ report: report({ scannedAtMs: Date.now() }) });
    render(<MetricsPanel cwd="/work/proj" />);

    expect(screen.getByTestId("metrics-scanned").textContent).toBe("Scanned just now");
    expect(screen.queryByTestId("metrics-stale")).toBeNull();
  });
});

/* ── the honesty header ─────────────────────────────────────────────────────── */

describe("the honesty header", () => {
  it("drives the store from the window toggle, and marks the active one", async () => {
    setStore({ report: report(), window: "last_24h" });
    render(<MetricsPanel cwd="/work/proj" />);

    const day = screen.getByTestId("metrics-window-last_24h");
    const week = screen.getByTestId("metrics-window-last_7d");
    expect(day.getAttribute("aria-pressed")).toBe("true");
    expect(week.getAttribute("aria-pressed")).toBe("false");

    await userEvent.click(week);
    expect(mockSetWindow).toHaveBeenCalledWith("last_7d");
  });

  it("switches scope through the store and never renders a control that fails", async () => {
    const user = userEvent.setup();
    setStore({ report: report(), cwd: "/work/private-client" });
    render(<MetricsPanel cwd="/work/private-client" />);

    await user.click(screen.getByTestId("metrics-scope-project"));
    expect(mockSetScope).toHaveBeenCalledWith("project");

    await user.click(screen.getByTestId("metrics-scope-all"));
    expect(mockSetScope).toHaveBeenCalledWith("all");
  });

  it("disables the project scope when there is no project to narrow to", () => {
    // Nothing selected ⇒ no cwd ⇒ "This project" cannot answer. A control that errors
    // when clicked is worse than one that is visibly unavailable, which is exactly the
    // lesson of the no-selection bug.
    setStore({ report: report(), cwd: null });
    render(<MetricsPanel cwd={null} />);
    expect(screen.getByTestId("metrics-scope-project")).toBeDisabled();
    expect(screen.getByTestId("metrics-scope-all")).toBeEnabled();
  });

  it("says out loud when the report covers MORE than was asked for", () => {
    // The visible half of the fix. An earlier version errored here; now the panel shows
    // everything AND admits that it widened the question — because a report whose scope silently
    // differs from the request looks correct while being wrong.
    setStore({
      report: report({
        coverage: { ...report().coverage, scopeFellBackToAll: true },
      }),
      cwd: null,
    });
    render(<MetricsPanel cwd={null} />);

    const note = screen.getByTestId("metrics-fallback");
    expect(note.textContent).toContain("Showing every project on this machine");
    expect(note.textContent).toContain("no agent is selected");
  });

  it("shows an account-row ERROR without taking the machine numbers down with it", () => {
    // Two independent sources: the account row comes from the CLI, the block below it from
    // local transcripts. A failure in one must not blank the other — the same "stale but
    // true beats nothing" rule the usage strip follows.
    usageState.current = {
      snapshot: null,
      error: "not-signed-in",
      loading: false,
      refresh: vi.fn(),
    };
    setStore({ report: report(), cwd: "/work/proj" });
    render(<MetricsPanel cwd="/work/proj" />);

    expect(screen.getByTestId("metrics-account-error")).toBeInTheDocument();
    // …and the machine-scoped numbers are still on screen (this fixture's request count).
    expect(screen.getByTestId("metrics-panel").textContent).toContain("1,250");
    expect(screen.getByTestId("metrics-tier").textContent).toContain("This machine");
  });

  it("renders the ACCOUNT row from the usage store, labelled as all devices", () => {
    // The account row is cross-device (from the CLI); the block below is this machine only.
    const snapshot: UsageSnapshot = {
      windows: [
        { key: "five_hour", label: "Current session", usedPct: 41, resetsAtMs: 1_785_243_600_000 },
        { key: "seven_day", label: "All models", usedPct: 64, resetsAtMs: 1_785_600_000_000 },
      ],
      fetchedAtMs: 1_785_200_000_000,
    };
    usageState.current = { snapshot, error: null, loading: false, refresh: vi.fn() };
    setStore({ report: report(), cwd: "/work/proj" });
    render(<MetricsPanel cwd="/work/proj" />);

    const account = screen.getByTestId("metrics-account");
    expect(account.textContent).toContain("All devices · from your Claude account");
    expect(account.textContent).toContain("Current session");
    expect(account.textContent).toContain("All models");
    // …and the machine-scoped block is labelled distinctly, in the same render.
    expect(screen.getByTestId("metrics-tier").textContent).toContain(
      "This machine · derived from local transcripts",
    );
  });

  it("releases the shared usage poller on unmount", () => {
    // `features/usage`'s poller is reference-counted so two consumers share one process
    // spawn; that only holds if every consumer releases. This asserts the panel does —
    // the mock's stop function standing in for the real release.
    mockStartPolling.mockReturnValue(mockStopPolling);
    // Earlier renders' cleanup already released the poller; clear so this asserts this mount.
    mockStopPolling.mockClear();
    mockStartPolling.mockClear();
    setStore({ report: report(), cwd: "/work/proj" });
    const view = render(<MetricsPanel cwd="/work/proj" />);
    expect(mockStartPolling).toHaveBeenCalledTimes(1);
    expect(mockStopPolling).not.toHaveBeenCalled();
    view.unmount();
    expect(mockStopPolling).toHaveBeenCalledTimes(1);
  });

  it("labels the scope as this project, by BASENAME only", () => {
    setStore({ report: report() });
    render(<MetricsPanel cwd="/Users/someone/work/private-client" />);

    // The single scope CAPTION became a two-button toggle when "all" scope landed, so
    // the same claim now lives on the project button — basename only, never a path.
    const scope = screen.getByTestId("metrics-scope-project");
    expect(scope.textContent).toBe("This project · private-client");
    // No absolute path outside the workspace root reaches the DOM.
    expect(screen.getByTestId("metrics-panel").textContent).not.toContain(
      "/Users/someone/work",
    );
  });

  it("labels a Windows project by its basename too — never the whole C:\\ path", () => {
    setStore({ report: report() });
    render(<MetricsPanel cwd={"C:\\Users\\someone\\work\\private-client\\"} />);

    expect(screen.getByTestId("metrics-scope-project").textContent).toBe(
      "This project · private-client",
    );
    expect(screen.getByTestId("metrics-panel").textContent).not.toContain("C:\\Users");
  });

  it("handles a project path with no separator at all", () => {
    setStore({ report: report() });
    render(<MetricsPanel cwd="proj" />);

    expect(screen.getByTestId("metrics-scope-project").textContent).toBe(
      "This project · proj",
    );
  });

  it("renders the scope without a project when no folder is open", () => {
    setStore({ report: report(), cwd: null });
    render(<MetricsPanel cwd={null} />);

    // With no folder the button names no project — and is disabled, since it cannot
    // answer. Asserting both is what stops a control that fails when clicked.
    const project = screen.getByTestId("metrics-scope-project");
    expect(project.textContent).toBe("This project");
    expect(project).toBeDisabled();
  });

  it("Rescan calls the store and goes busy while a scan is in flight", async () => {
    setStore({ report: report() });
    render(<MetricsPanel cwd="/work/proj" />);
    await userEvent.click(screen.getByTestId("metrics-rescan"));
    expect(mockRefresh).toHaveBeenCalledTimes(1);

    setStore({ report: report(), loading: true });
    render(<MetricsPanel cwd="/work/proj" />);
    const busy = screen.getAllByTestId("metrics-rescan").at(-1);
    expect(busy?.getAttribute("aria-busy")).toBe("true");
    expect((busy as HTMLButtonElement).disabled).toBe(true);
  });

  it("says 'complete' and expands the full coverage block on demand", async () => {
    setStore({ report: report() });
    render(<MetricsPanel cwd="/work/proj" />);

    const badge = screen.getByTestId("metrics-coverage-badge");
    expect(badge.textContent).toBe("complete");
    expect(screen.queryByTestId("metrics-coverage")).toBeNull();

    await userEvent.click(badge);
    const block = screen.getByTestId("metrics-coverage");
    expect(block.textContent).toContain("6 read of 150 checked");
    expect(block.textContent).toContain("8,000,000");
    expect(block.textContent).toContain("100 ms");
    expect(block.textContent).toContain("This machine");

    await userEvent.click(badge);
    expect(screen.queryByTestId("metrics-coverage")).toBeNull();
  });

  it("says WHAT was partial, and marks the badge, when a ceiling was hit", () => {
    setStore({
      report: report({
        coverage: { ...report().coverage, partial: true, filesTruncated: 2 },
      }),
    });
    render(<MetricsPanel cwd="/work/proj" />);

    const badge = screen.getByTestId("metrics-coverage-badge");
    expect(badge.textContent).toBe("partial — 2 files truncated");
    expect(badge.className).toContain("metrics__badge--partial");
  });

  it("names an unavailable source in the coverage block rather than shrinking the total", async () => {
    setStore({
      report: report({
        coverage: {
          ...report().coverage,
          partial: true,
          rootsUnavailable: ["This machine"],
        },
        perRoot: [{ ...report().perRoot[0], available: false }],
      }),
    });
    render(<MetricsPanel cwd="/work/proj" />);

    await userEvent.click(screen.getByTestId("metrics-coverage-badge"));
    expect(screen.getByTestId("metrics-coverage").textContent).toContain(
      "This machine (unavailable)",
    );
  });
});

/* ── the mount effect ───────────────────────────────────────────────────────── */

describe("the mount effect", () => {
  it("asks the store to ensure numbers for this project, once", () => {
    setStore({ report: report() });
    render(<MetricsPanel cwd="/work/proj" />);

    expect(mockEnsure).toHaveBeenCalledTimes(1);
    expect(mockEnsure).toHaveBeenCalledWith("/work/proj");
  });

  it("re-ensures when the tab is re-pointed at a different project", () => {
    setStore({ report: report() });
    const view = render(<MetricsPanel cwd="/work/proj" />);
    view.rerender(<MetricsPanel cwd="/work/other" />);

    expect(mockEnsure).toHaveBeenLastCalledWith("/work/other");
    expect(mockEnsure).toHaveBeenCalledTimes(2);
  });

  it("advances its own display clock, so freshness cannot go stale on screen", async () => {
    // The panel's "now" is ticked state, never read in render; driven with fake timers.
    vi.useFakeTimers();
    const start = new Date(2026, 6, 29, 12, 0, 0).getTime();
    vi.setSystemTime(start);
    setStore({ report: report({ scannedAtMs: start }) });
    render(<MetricsPanel cwd="/work/proj" />);
    expect(screen.getByTestId("metrics-scanned").textContent).toBe("Scanned just now");

    // Two ticks of the 30 s display clock cross the one-minute boundary. No
    // `setSystemTime` here: advancing the fake clock advances `Date.now()` with it, so
    // setting it as well would double-count the elapsed time.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(screen.getByTestId("metrics-scanned").textContent).toBe("Scanned 1 min ago");
    vi.useRealTimers();
  });

  it("leaves nothing ticking after unmount", () => {
    const clearInterval = vi.spyOn(globalThis, "clearInterval");
    setStore({ report: report() });
    const view = render(<MetricsPanel cwd="/work/proj" />);
    view.unmount();

    expect(clearInterval).toHaveBeenCalled();
  });
});

/* ── the context-window card (features/context) ────────────────────────────── */

describe("the context-window card", () => {
  // The card reads the REAL app store (selection) and the real context store; only the
  // IPC edge is faked, so "select an agent → its context shows in the dashboard" is the
  // composed path, not two halves that each assume the other.
  let ipc: TauriMock;
  const READING: ContextUsage = {
    model: "claude-opus-5-5",
    usedTokens: 290_700,
    windowTokens: 1_000_000,
    usedPercent: 29,
    categories: [
      { key: "messages", label: "Messages", tokens: 290_700, percent: 29.1 },
      { key: "free-space", label: "Free space", tokens: 676_300, percent: 67.6 },
      { key: "autocompact-buffer", label: "Autocompact buffer", tokens: 33_000, percent: 3.3 },
    ],
    measuredAtMs: Date.now(),
  };

  function selectRootAgent(cwd: string): void {
    const id = asAgentId("root-a");
    act(() => {
      useAppStore.setState((s) => {
        s.agents[id] = {
          ...wireAgent({ id, cwd }),
          childIds: [],
          // What the store really holds: the card must not need a session id.
          sessionId: null,
          expanded: false,
          unread: 0,
        };
        s.rootAgentIds = [id];
        s.selection.selectedAgentId = id;
      });
    });
  }

  beforeEach(() => {
    resetFleetStore();
    resetContextStore();
    ipc = installTauriMock();
    ipc.handle("context_usage", () => READING);
  });
  afterEach(() => {
    ipc.reset();
  });

  it("sits between the account block and the dashboard body, above the hero", () => {
    setStore({ report: report() });
    render(<MetricsPanel cwd="/work/proj" />);
    const panel = screen.getByTestId("metrics-panel");
    const order = [...panel.querySelectorAll("[data-testid]")]
      .map((el) => el.getAttribute("data-testid"))
      .filter((id) => ["metrics-account", "context-card", "metrics-tier", "metrics-hero"].includes(id!));
    expect(order).toEqual(["metrics-account", "context-card", "metrics-tier", "metrics-hero"]);
  });

  it.each(["all", "project"] as const)("is shown in the %s scope", (scope) => {
    setStore({ report: report(), scope });
    render(<MetricsPanel cwd="/work/proj" />);
    expect(screen.getByTestId("context-card")).toBeInTheDocument();
  });

  it("is shown while the transcript scan is still loading, and when it failed", () => {
    setStore({ report: null });
    const first = render(<MetricsPanel cwd="/work/proj" />);
    expect(screen.getByTestId("context-card")).toBeInTheDocument();
    first.unmount();

    setStore({ report: null, error: "scan-failed" });
    render(<MetricsPanel cwd="/work/proj" />);
    expect(screen.getByTestId("metrics-error")).toBeInTheDocument();
    expect(screen.getByTestId("context-card")).toBeInTheDocument();
  });

  it("follows the SELECTED agent, not the cwd the tab was opened with", async () => {
    setStore({ report: report() });
    render(<MetricsPanel cwd={null} />);
    expect(screen.getByTestId("context-note")).toHaveTextContent("Select an agent to see its context window");

    selectRootAgent("/w/gazelle");
    expect(await screen.findByTestId("context-bar")).toBeInTheDocument();
    expect(ipc.lastCall("context_usage")).toEqual({ agentId: "root-a" });
    expect(screen.getByTestId("context-summary")).toHaveTextContent("290.7k of 1m · compacts at 967k");
    // The machine-wide dashboard is untouched by the selection.
    expect(mockEnsure).toHaveBeenLastCalledWith(null);
  });
});
