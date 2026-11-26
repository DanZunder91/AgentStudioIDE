import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentEvent, AgentId } from "../../app/types";
import {
  filterEntries,
  formatEntry,
  formatTime,
  logAgentEvent,
  logError,
  logEvent,
  logInfo,
  logWarn,
  LOG_CAP,
  useLogStore,
  type LogEntry,
} from "./logStore";

const id = (s: string) => s as AgentId;
const state = () => useLogStore.getState();

/** Full reset — entries, filters, visibility, AND the monotonic id counter. */
function resetLogStore(): void {
  useLogStore.setState({
    entries: [],
    visible: false,
    levelFilter: "all",
    textFilter: "",
    nextId: 0,
  });
}

beforeEach(() => resetLogStore());

describe("append", () => {
  it("stamps a monotonic id + a ts and appends in order", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    state().append({ level: "info", source: "s", message: "first" });
    vi.spyOn(Date, "now").mockReturnValue(2_000);
    state().append({ level: "warn", source: "s", message: "second" });

    const { entries } = state();
    expect(entries.map((e) => e.message)).toEqual(["first", "second"]);
    expect(entries.map((e) => e.id)).toEqual([0, 1]);
    expect(entries.map((e) => e.ts)).toEqual([1_000, 2_000]);
    vi.restoreAllMocks();
  });

  it("carries an optional detail through", () => {
    state().append({ level: "error", source: "boom", message: "m", detail: "why" });
    expect(state().entries[0].detail).toBe("why");
  });

  it("ring-buffer cap drops the oldest past LOG_CAP", () => {
    for (let i = 0; i < LOG_CAP + 5; i++) {
      state().append({ level: "info", source: "s", message: `m${i}` });
    }
    const { entries } = state();
    expect(entries).toHaveLength(LOG_CAP);
    // The five oldest were dropped; the newest is retained.
    expect(entries[0].message).toBe("m5");
    expect(entries[entries.length - 1].message).toBe(`m${LOG_CAP + 4}`);
  });
});

describe("clear / show / hide / toggle / filters", () => {
  it("clear empties entries but the id counter keeps climbing", () => {
    state().append({ level: "info", source: "s", message: "a" });
    state().clear();
    expect(state().entries).toEqual([]);
    state().append({ level: "info", source: "s", message: "b" });
    // Monotonic across clears — the second-ever entry still gets id 1.
    expect(state().entries[0].id).toBe(1);
  });

  it("show / hide / toggle drive visibility", () => {
    expect(state().visible).toBe(false);
    state().show();
    expect(state().visible).toBe(true);
    state().hide();
    expect(state().visible).toBe(false);
    state().toggle();
    expect(state().visible).toBe(true);
    state().toggle();
    expect(state().visible).toBe(false);
  });

  it("setLevelFilter / setTextFilter update filter state", () => {
    state().setLevelFilter("warn");
    state().setTextFilter("boom");
    expect(state().levelFilter).toBe("warn");
    expect(state().textFilter).toBe("boom");
  });
});

describe("module-level helpers", () => {
  it("logInfo/logEvent/logWarn/logError append with the right level + source", () => {
    logInfo("i", "info-msg");
    logEvent("e", "event-msg");
    logWarn("w", "warn-msg", "wd");
    logError("x", "err-msg", "xd");

    const { entries } = state();
    expect(entries.map((e) => [e.level, e.source, e.message, e.detail])).toEqual([
      ["info", "i", "info-msg", undefined],
      ["event", "e", "event-msg", undefined],
      ["warn", "w", "warn-msg", "wd"],
      ["error", "x", "err-msg", "xd"],
    ]);
  });
});

describe("logAgentEvent", () => {
  const events: AgentEvent[] = [
    { t: "agent_started", agentId: id("a1"), parentId: null, title: "Root", cwd: "/w", branch: "main", runtime: "claude-code" },
    { t: "subagent_spawned", parentId: id("a1"), childAgentId: id("c1"), title: "Child", cwd: "/w", branch: "main", runtime: "claude-code" },
    { t: "status", agentId: id("a1"), status: "waiting_input" },
    { t: "exited", agentId: id("a1"), code: 0 },
    { t: "activity", agentId: id("a1"), at: 123 },
    { t: "title", agentId: id("a1"), title: "Renamed" },
  ];

  it("maps every AgentEvent variant to a log line", () => {
    for (const e of events) logAgentEvent(e);
    const { entries } = state();

    expect(entries.map((e) => `${e.level}:${e.message}`)).toEqual([
      "event:a1 started",
      "event:c1 spawned under a1",
      "event:a1 → waiting_input",
      "event:a1 exited",
      "info:a1 activity",
      "info:a1 title → Renamed",
    ]);
    // Every log line the bridge writes is sourced to "agent".
    expect(entries.every((e) => e.source === "agent")).toBe(true);
  });

  it("records the status transition so a 'waiting' pill is explainable", () => {
    logAgentEvent({ t: "status", agentId: id("z9"), status: "waiting_input" });
    expect(state().entries[0]).toMatchObject({ level: "event", source: "agent", message: "z9 → waiting_input" });
  });
});

describe("filterEntries", () => {
  const rows: LogEntry[] = [
    { id: 0, ts: 0, level: "info", source: "agent", message: "a1 started", detail: "cwd=/w" },
    { id: 1, ts: 0, level: "event", source: "agent", message: "a1 → running" },
    { id: 2, ts: 0, level: "error", source: "bridge", message: "snapshot failed", detail: "boom" },
  ];

  it("returns all with no narrowing", () => {
    expect(filterEntries(rows, "all", "")).toHaveLength(3);
  });

  it("narrows by level", () => {
    expect(filterEntries(rows, "error", "").map((e) => e.id)).toEqual([2]);
  });

  it("matches text against source, message, and detail (case-insensitive)", () => {
    expect(filterEntries(rows, "all", "RUNNING").map((e) => e.id)).toEqual([1]); // message
    expect(filterEntries(rows, "all", "bridge").map((e) => e.id)).toEqual([2]); // source
    expect(filterEntries(rows, "all", "boom").map((e) => e.id)).toEqual([2]); // detail
    expect(filterEntries(rows, "all", "nope")).toHaveLength(0);
  });

  it("treats a missing detail as empty (no throw)", () => {
    // Row id 1 has no detail — the text match must not blow up on undefined.
    expect(filterEntries(rows, "all", "a1 → running").map((e) => e.id)).toEqual([1]);
  });
});

describe("formatters", () => {
  it("formatTime zero-pads to HH:MM:SS.mmm (local time)", () => {
    const d = new Date(2021, 5, 15, 9, 8, 7, 6);
    expect(formatTime(d.getTime())).toBe("09:08:07.006");
  });

  it("formatEntry includes the detail when present, omits it otherwise", () => {
    const base = { id: 0, level: "event" as const, source: "agent" };
    const ts = new Date(2021, 5, 15, 1, 2, 3, 4).getTime();
    expect(formatEntry({ ...base, ts, message: "a1 → running" })).toBe(
      "01:02:03.004 [EVENT] agent a1 → running",
    );
    expect(formatEntry({ ...base, ts, message: "started", detail: "cwd=/w" })).toBe(
      "01:02:03.004 [EVENT] agent started — cwd=/w",
    );
  });
});
