/**
 * networkApps — which flows are an app's (pid first, executable name only for a pid no listed
 * app owns), the picker predicate, the per-row capture state, and the words. Expectations are
 * hand-written.
 */

import { describe, expect, it } from "vitest";

import type { DevApp } from "../procs/procsTypes";
import {
  appFlowCount,
  appPredicate,
  captureState,
  flowInApp,
  ignoresIdeCa,
  listedPids,
  notCapturedText,
  pickOf,
  receivingText,
  RUST_GO_CAVEAT,
  whereText,
} from "./networkApps";
import type { FlowSummary } from "./networkTypes";

const base: DevApp = {
  key: "pid:10",
  pid: 10,
  runtime: "rust",
  name: "gazelle",
  exe: "/w/gazelle/target/debug/gazelle",
  argv: ["target/debug/gazelle"],
  cwd: "/w/gazelle",
  startedMs: 1,
  ports: [],
  console: "ide-terminal",
  logFiles: [],
  containerId: null,
  origin: "ide",
  terminalId: "T1",
  agentId: null,
  launchedBy: "zsh",
  captured: true,
};
const GAZELLE = base;
const WEB: DevApp = { ...base, key: "pid:20", pid: 20, runtime: "node", name: "web", exe: "/usr/bin/node", argv: ["node"] };
const API: DevApp = { ...WEB, key: "pid:21", pid: 21, name: "api" };
const PG: DevApp = { ...base, key: "docker:c", pid: null, runtime: "docker", name: "pg", exe: null, argv: [], origin: "external", captured: null };

const f = (pid: number | null, name = "gazelle"): Pick<FlowSummary, "client"> => ({
  client: pid === null ? null : { pid, name, path: null },
});

describe("pickOf / listedPids", () => {
  it("a pick is the key, pid, display name and client name", () => {
    expect(pickOf(GAZELLE)).toEqual({ key: "pid:10", pid: 10, name: "gazelle", process: "gazelle" });
    expect(pickOf(PG)).toEqual({ key: "docker:c", pid: null, name: "pg", process: null });
  });
  it("the listed pids skip containers", () => {
    expect([...listedPids([GAZELLE, WEB, PG])].sort()).toEqual([10, 20]);
  });
});

describe("flowInApp", () => {
  const owned = listedPids([GAZELLE, WEB, API]);
  it("its own pid matches, whatever the client name", () => {
    expect(flowInApp(f(10, "renamed"), pickOf(GAZELLE), owned)).toBe(true);
  });
  it("a pid another listed app owns never matches by name (two node apps stay apart)", () => {
    expect(flowInApp(f(21, "node"), pickOf(WEB), owned)).toBe(false);
  });
  it("an unowned pid falls back to the executable name (the app exited or restarted)", () => {
    expect(flowInApp(f(999, "gazelle"), pickOf(GAZELLE), owned)).toBe(true);
    expect(flowInApp(f(999, "curl"), pickOf(GAZELLE), owned)).toBe(false);
  });
  it("an unresolved client never matches; a pick with no process name only matches by pid", () => {
    expect(flowInApp(f(null), pickOf(GAZELLE), owned)).toBe(false);
    expect(flowInApp(f(999, "pg"), pickOf(PG), owned)).toBe(false);
  });
});

describe("appPredicate / appFlowCount", () => {
  it("All apps is no predicate at all", () => {
    expect(appPredicate(null, [GAZELLE])).toBeNull();
  });
  it("several picks OR together", () => {
    const ok = appPredicate([pickOf(GAZELLE), pickOf(API)], [GAZELLE, WEB, API]) as (x: FlowSummary) => boolean;
    expect(ok(f(10) as FlowSummary)).toBe(true);
    expect(ok(f(21, "node") as FlowSummary)).toBe(true);
    expect(ok(f(20, "node") as FlowSummary)).toBe(false);
  });
  it("counts an app's flows by the same rule", () => {
    expect(appFlowCount([f(10), f(999), f(20, "node"), f(null)], GAZELLE, [GAZELLE, WEB])).toBe(2);
  });
});

describe("captureState", () => {
  const cases: [string, Pick<DevApp, "origin" | "captured">, number, string][] = [
    ["Rust verified the env", { origin: "ide", captured: true }, 0, "captured"],
    ["flows arrived — proof, whatever the env said", { origin: "ide", captured: false }, 3, "captured"],
    ["stripped, nothing arrived", { origin: "ide", captured: false }, 0, "uncaptured"],
    ["env hidden", { origin: "ide", captured: null }, 0, "unknown"],
    ["external, nothing arrived", { origin: "external", captured: null }, 0, "external"],
    ["external, pointed at the proxy by hand", { origin: "external", captured: null }, 1, "captured"],
  ];
  for (const [what, app, n, want] of cases) {
    it(what, () => expect(captureState(app, n)).toBe(want));
  }
});

describe("the words", () => {
  it("say why, how many, and where", () => {
    expect(notCapturedText("gazelle")).toBe(
      "gazelle was started without the IDE's proxy — its launcher removed the proxy variables, so its HTTP calls can't reach Network.",
    );
    expect(receivingText("gazelle", 3)).toBe("✓ Receiving gazelle's requests — 3 so far");
    expect(receivingText("gazelle", 0)).toBe("✓ Captured — no requests from gazelle yet");
    expect(whereText("claude · gazelle", "gazelle")).toBe("They appear under IDE traffic, Source claude · gazelle, Process gazelle.");
    expect(whereText("zsh", null)).toBe("They appear under IDE traffic, Source zsh, Process unknown.");
    expect(RUST_GO_CAVEAT).toBe(
      "Most Rust and Go apps use a built-in certificate list and ignore the IDE's CA — their HTTPS shows as host, timing and size, not contents.",
    );
  });
  it("the caveat is for Rust and Go only", () => {
    expect(["rust", "go", "node", "jvm", "python", "docker", "shell"].map((r) => ignoresIdeCa(r as DevApp["runtime"]))).toEqual([
      true,
      true,
      false,
      false,
      false,
      false,
      false,
    ]);
  });
});
