/**
 * Structural contract check for the Agent Village's `list_external_agents` reply
 * (`villageTypes.ts` `ExternalAgentsReport` / `ExternalAgentWire`) — the TS half of
 * `src-tauri/tests/contract_goldens/village.rs`, which WROTE `goldens/external-agents.json`
 * from the real `external_agents::scan_external` over the checked-in transcript fixture.
 *
 * Both directions, the `wireShape.test.ts` way: the SHAPE tables are typed
 * `Record<keyof T, Json>` (a TS field without a row, or a row without a TS field, is a
 * compile error), and every golden object must carry EXACTLY those keys with those JSON
 * types (a Rust-only field, a TS-only field or a changed type is red). Every `activity`
 * must be a spelling the TS union names. Expectations are written by hand.
 */

import { describe, expect, it } from "vitest";

import type { ExternalAgentsReport, ExternalAgentWire } from "../../features/village/villageTypes";
import golden from "./goldens/external-agents.json";

type Json = "number" | "string" | "boolean|null" | "string|null" | "array";

const REPORT: Record<keyof ExternalAgentsReport, Json> = {
  agents: "array",
  scannedAtMs: "number",
};

const AGENT: Record<keyof ExternalAgentWire, Json> = {
  key: "string",
  parentKey: "string|null",
  title: "string",
  folder: "string",
  activity: "string",
  tool: "string|null",
  lastActivityMs: "number",
  alive: "boolean|null",
  host: "string|null",
  language: "string|null",
};

/** Exhaustive: a union member missing here is a compile error. */
const ACTIVITIES: Record<ExternalAgentWire["activity"], true> = {
  running: true,
  waiting: true,
  idle: true,
  done: true,
  error: true,
};

function jsonType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function checkShape(what: string, obj: Record<string, unknown>, shape: Record<string, Json>) {
  expect(Object.keys(obj).sort(), `${what}: keys`).toEqual(Object.keys(shape).sort());
  for (const [key, want] of Object.entries(shape)) {
    expect(want.split("|"), `${what}.${key}`).toContain(jsonType(obj[key]));
  }
}

const scenarios = golden as unknown as Record<string, ExternalAgentsReport>;

describe("external-agents golden ↔ villageTypes", () => {
  it("covers the scenarios Rust writes", () => {
    expect(Object.keys(scenarios).sort()).toEqual(["dead-hidden", "macos-linux", "no-sessions", "windows"]);
  });

  it("every report and every agent has exactly the TS keys and JSON types", () => {
    let agents = 0;
    for (const [name, report] of Object.entries(scenarios)) {
      checkShape(name, report as unknown as Record<string, unknown>, REPORT);
      for (const a of report.agents) {
        agents += 1;
        checkShape(`${name}/${a.key}`, a as unknown as Record<string, unknown>, AGENT);
        expect(ACTIVITIES[a.activity], `${name}/${a.key}.activity = ${a.activity}`).toBe(true);
      }
    }
    expect(agents).toBeGreaterThan(0);
  });

  it("exercises every activity, per-session liveness, hosts and a nested sub-agent", () => {
    const linux = scenarios["macos-linux"].agents;
    expect(new Set(linux.map((a) => a.activity))).toEqual(
      new Set(["running", "waiting", "idle", "done", "error"]),
    );
    // Unclaimed sessions are never sent, so a process table only ever says `true`…
    expect(new Set(linux.map((a) => a.alive))).toEqual(new Set([true]));
    // …and dropping them is visible: with one live claude, one session comes back.
    expect(scenarios["dead-hidden"].agents.map((a) => [a.title, a.alive])).toEqual([["calm-idle-heron", true]]);
    expect(scenarios.windows.agents.every((a) => a.alive === null && a.host === null)).toBe(true);
    expect(scenarios.windows.agents).toHaveLength(linux.length);
    expect(new Set(linux.map((a) => a.host))).toEqual(new Set([null, "iTerm2", "Terminal"]));
    const keys = new Set(linux.map((a) => a.key));
    const children = linux.filter((a) => a.parentKey !== null);
    expect(children.every((a) => keys.has(a.parentKey as string))).toBe(true);
    // A sub-agent whose parent is itself a sub-agent (spawnDepth 2).
    const byKey = new Map(linux.map((a) => [a.key, a]));
    expect(children.some((a) => byKey.get(a.parentKey as string)?.parentKey !== null)).toBe(true);
    // The City's neon sign: alpha's sub-agent Read `a.rs`, so the whole alpha session — root and
    // every sub-agent — says "rust"; the sessions whose tools named no source file say nothing.
    expect(new Map(linux.map((a) => [a.folder, a.language]))).toEqual(
      new Map([
        ["alpha", "rust"],
        ["gamma", null],
        ["zeta", null],
        ["beta", null],
      ]),
    );
    expect(linux.filter((a) => a.folder === "alpha").every((a) => a.language === "rust")).toBe(true);
  });

  it("carries basenames and no session ids", () => {
    for (const report of Object.values(scenarios)) {
      for (const a of report.agents) {
        expect(a.folder).not.toContain("/");
        expect(a.host ?? "").not.toContain("/");
        // A language id, never the file that voted for it.
        expect(a.language ?? "").toMatch(/^[a-z-]*$/);
        expect(a.key).not.toMatch(/-[0-9a-f]{4}-/);
      }
    }
  });
});
