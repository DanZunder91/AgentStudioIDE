/**
 * One row per call (networkFilter.tableFlows / neutralizedBypassOf) and the fit-to-width
 * columns (networkColumns.fitColumns) — each shimmed `curl --noproxy` used to show twice, and
 * at the 1280 px window only Time / Proto / Method / Host were on screen. The real-pixel half is
 * networkColumns.browser.test.tsx.
 */

import { describe, expect, it } from "vitest";

import type { ColumnLayout } from "../../components/columns";
import { fitColumns, IDE_COLUMNS, tableMinWidth } from "./networkColumns";
import {
  bypassPairing,
  capturedAnywayOf,
  capturedAnywayText,
  isNeutralizedBypass,
  PAIR_SKEW_MS,
  PAIR_WINDOW_MS,
  shimmedAsk,
  tableFlows,
} from "./networkFilter";
import type { FlowSummary } from "./networkTypes";

const T0 = 1_790_589_660_000;
function flow(id: number, o: Partial<FlowSummary> = {}): FlowSummary {
  return {
    id, startedMs: T0, proto: "http", method: "GET", host: "127.0.0.1", port: 3000, path: "/health",
    status: 200, grpcStatus: null, contentType: null, reqBytes: 0, resBytes: 2, durationMs: 3,
    state: "done", error: null, terminalId: "t1", httpVersion: "HTTP/1.1", wsMessages: null, client: null, note: null, ...o,
  };
}
const shim = (id: number, o: Partial<FlowSummary> = {}, neutralized = true): FlowSummary =>
  flow(id, {
    proto: "bypass", status: null,
    bypass: { command: "curl -s --noproxy '*' http://127.0.0.1:3000/health", reasons: ["--noproxy"], neutralized },
    ...o,
  });

const py = (id: number, o: Partial<FlowSummary> = {}): FlowSummary =>
  flow(id, {
    proto: "bypass", status: null,
    bypass: { command: "NO_PROXY='*' python3 -c '…'", reasons: ["NO_PROXY=*"], neutralized: false, agentId: "a1" },
    ...o,
  });
const PY3 = { pid: 9, name: "python3", path: null };

describe("one row per call — bypasses captured anyway", () => {
  it("drops neutralised bypasses even unpaired; keeps a lone genuinely uncaptured bypass; same array when nothing drops", () => {
    const plain = [flow(1, { path: "/x" }), shim(2, {}, false)];
    expect(tableFlows(plain)).toBe(plain);
    expect(tableFlows([flow(1, { path: "/x" }), shim(2), py(3)]).map((f) => f.id)).toEqual([1, 3]);
    expect(isNeutralizedBypass(flow(1, { bypass: { command: "x", neutralized: true } }))).toBe(false);
    expect(isNeutralizedBypass(shim(1, { bypass: { command: "x" } }))).toBe(false);
  });

  it("the python false alarm: a NON-neutralised bypass whose request IS captured is hidden, and its row says why", () => {
    // `NO_PROXY='*' python3` still uses the proxy (the PTY's lowercase no_proxy wins in urllib).
    const b = py(1, { startedMs: T0 });
    const c = flow(2, { startedMs: T0 + 300, client: PY3 });
    const ring = [b, c];
    expect(tableFlows(ring).map((f) => f.id)).toEqual([2]);
    const anyway = capturedAnywayOf(c, ring)!;
    expect([anyway.bypass.id, anyway.how]).toEqual([1, "proxy"]);
    expect(capturedAnywayText(c, anyway)).toBe("The agent asked for NO_PROXY=* but python3 still used the IDE proxy.");
    expect(capturedAnywayText(flow(3), anyway)).toBe("The agent asked for NO_PROXY=* but it still used the IDE proxy.");
    expect(capturedAnywayText(c, { bypass: shim(4), how: "shim" })).toBe(
      "The agent asked for --noproxy; the IDE's curl shim captured it anyway.",
    );
    expect(capturedAnywayOf(b, ring)).toBeNull();
  });

  it("matches by the agent's terminal id too, and never pairs across host, port, path or terminal", () => {
    const b = py(1, { terminalId: "root", startedMs: T0 });
    expect(tableFlows([b, flow(2, { terminalId: "a1", startedMs: T0 + 10 })]).map((f) => f.id)).toEqual([2]);
    for (const o of [{ host: "h" }, { port: 1 }, { path: "/p" }, { terminalId: "other" }, { terminalId: null }, { proto: "tunnel" as const }]) {
      expect(tableFlows([py(1), flow(2, o)]).map((f) => f.id), JSON.stringify(o)).toEqual([1, 2]);
    }
    // A bypass with no agent and no terminal pairs with nothing.
    expect(tableFlows([py(1, { terminalId: null, bypass: { command: "x" } }), flow(2)]).map((f) => f.id)).toEqual([1, 2]);
  });

  it("the time window: from skew before to PAIR_WINDOW_MS after the bypass", () => {
    const at = (dt: number) => tableFlows([py(1, { startedMs: T0 }), flow(2, { startedMs: T0 + dt })]).length;
    expect(at(-PAIR_SKEW_MS)).toBe(1);
    expect(at(PAIR_WINDOW_MS)).toBe(1);
    expect(at(-PAIR_SKEW_MS - 1)).toBe(2);
    expect(at(PAIR_WINDOW_MS + 1)).toBe(2);
  });

  it("one-to-one, earliest unclaimed first: curl's row is not re-claimed by a later python call; a second python stays a row", () => {
    const curlB = shim(1, { startedMs: T0 });
    const curlC = flow(2, { startedMs: T0 + 100, client: { pid: 1, name: "curl", path: null } });
    const pyB = py(3, { startedMs: T0 + 600 });
    const pyC = flow(4, { startedMs: T0 + 700, client: PY3 });
    const direct = py(5, { startedMs: T0 + 1200 }); // really bypassed: no request of its own
    const ring = [pyC, direct, curlC, pyB, curlB]; // ring order does not matter
    expect(tableFlows(ring).map((f) => f.id)).toEqual([4, 5, 2]);
    expect(capturedAnywayOf(curlC, ring)).toMatchObject({ how: "shim", bypass: { id: 1 } });
    expect(capturedAnywayOf(pyC, ring)).toMatchObject({ how: "proxy", bypass: { id: 3 } });
    // The earliest of two candidates wins.
    const two = [py(1), flow(3, { startedMs: T0 + 500 }), flow(2, { startedMs: T0 + 50 })];
    expect(capturedAnywayOf(two[2], two)?.bypass.id).toBe(1);
    expect(capturedAnywayOf(two[1], two)).toBeNull();
    // …whichever order the ring holds them in.
    const later = [py(1), flow(2, { startedMs: T0 + 50 }), flow(3, { startedMs: T0 + 500 })];
    expect(capturedAnywayOf(later[1], later)?.bypass.id).toBe(1);
  });

  it("is computed once per ring array", () => {
    const ring = [py(1), flow(2)];
    expect(bypassPairing(ring)).toBe(bypassPairing(ring));
  });

  it("says what was asked for", () => {
    expect(shimmedAsk(shim(1))).toBe("--noproxy");
    expect(shimmedAsk({ bypass: { command: "x", reasons: ["--noproxy", "-x ''"] } })).toBe("--noproxy and -x ''");
    expect(shimmedAsk({ bypass: null })).toBe("a proxy bypass");
  });
});

const NONE: ColumnLayout = { widths: {}, hidden: [] };
const ids = (fit: { cols: { id: string }[] }) => fit.cols.map((c) => c.id);
const CORE = ["time", "proto", "method", "host", "path", "status", "source"];

describe("fitColumns — the important columns fit, the rest give way", () => {
  it("unmeasured (0) or wide enough: the plain layout, nothing auto-hidden", () => {
    for (const w of [0, 2000]) {
      const fit = fitColumns(IDE_COLUMNS, NONE, w);
      expect(ids(fit)).toEqual(IDE_COLUMNS.map((c) => c.id));
      expect(fit.autoHidden).toEqual([]);
      expect(fit.cols.find((c) => c.id === "host")?.px).toBe(220);
    }
  });

  it("a little too narrow: Host gives up the difference, nothing is hidden", () => {
    const full = tableMinWidth(fitColumns(IDE_COLUMNS, NONE, 0).cols);
    const fit = fitColumns(IDE_COLUMNS, NONE, full - 50);
    expect(fit.autoHidden).toEqual([]);
    expect(fit.tight).toBe(false);
    expect(fit.cols.find((c) => c.id === "host")?.px).toBe(170);
    expect(tableMinWidth(fit.cols)).toBe(full - 50);
  });

  it("the 1700 px window (860 px table): Process, Size, Duration go, Host re-grows into what they freed", () => {
    const fit = fitColumns(IDE_COLUMNS, NONE, 860);
    expect(fit.autoHidden).toEqual(["process", "size", "dur"]);
    expect(ids(fit)).toEqual(["time", "proto", "method", "host", "path", "status", "type", "source"]);
    expect(tableMinWidth(fit.cols)).toBeLessThanOrEqual(860);
    expect(fit.cols.find((c) => c.id === "host")!.px).toBeGreaterThan(64);
  });

  it("the 1280 px window (~438 px table): every low-priority column goes and the core squeezes to fit", () => {
    const fit = fitColumns(IDE_COLUMNS, NONE, 438);
    expect(fit.autoHidden).toEqual(["process", "size", "dur", "type"]);
    expect(ids(fit)).toEqual(CORE);
    expect(fit.tight).toBe(true);
    expect(tableMinWidth(fit.cols)).toBeLessThanOrEqual(438);
    // …with room to spare for a vertical scrollbar: 400 px still fits.
    expect(tableMinWidth(fitColumns(IDE_COLUMNS, NONE, 400).cols)).toBeLessThanOrEqual(400);
    for (const c of fit.cols) {
      const w = c.flex ? (c.minWidth as number) : c.px;
      expect(w, c.id).toBeGreaterThanOrEqual((c.compactWidth as number) - 1);
    }
  });

  it("a column the user ticked on is never auto-hidden; one they hid stays hidden", () => {
    const fit = fitColumns(IDE_COLUMNS, { widths: {}, hidden: ["source"], shown: ["process"] }, 860);
    expect(ids(fit)).toContain("process");
    expect(ids(fit)).not.toContain("source");
    expect(fit.autoHidden).not.toContain("process");
  });

  it("too narrow even squeezed (the user sized columns): nothing is squeezed, the table scrolls", () => {
    const widths = Object.fromEntries(IDE_COLUMNS.filter((c) => !c.flex).map((c) => [c.id, 400]));
    const fit = fitColumns(IDE_COLUMNS, { widths, hidden: [] }, 438);
    expect(fit.cols.find((c) => c.id === "path")?.minWidth).toBe(160);
    expect(fit.tight).toBe(false);
    expect(fit.cols.find((c) => c.id === "host")?.px).toBe(400);
    expect(tableMinWidth(fit.cols)).toBeGreaterThan(438);
  });

  it("a column with no compact width keeps its width when squeezed; a user-sized Host is not shrunk first", () => {
    const fit = fitColumns(IDE_COLUMNS, { widths: { host: 90 }, hidden: [], shown: ["type"] }, 620);
    expect(fit.cols.find((c) => c.id === "host")?.px).toBe(90);
    expect(fit.cols.find((c) => c.id === "type")?.px).toBe(150);
    expect(tableMinWidth(fit.cols)).toBeLessThanOrEqual(620);
  });

  it("defs without compact widths or a flex floor: Host keeps its width, Path's floor is the global minimum", () => {
    const defs = [
      { id: "time", label: "Time", width: 100 },
      { id: "host", label: "Host", width: 200 },
      { id: "path", label: "Path", width: 300, flex: true },
    ] as const;
    const fit = fitColumns(defs as never, NONE, 200);
    expect(fit.cols.map((c) => c.px)).toEqual([100, 200, 300]);
    expect(fit.tight).toBe(false);
    expect(tableMinWidth(fit.cols)).toBe(340);
  });
});
