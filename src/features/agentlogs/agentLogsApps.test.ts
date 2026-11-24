/**
 * Logs × dev apps: where an `app` source goes in the sidebar, what an app's click solos,
 * and the selection rule — the pure half by hand, then the store subscription
 * over the REAL agent-logs and procs stores.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetProcsStore, selectDevApp, useProcsStore, type ActiveStream } from "../procs/procsStore";
import type { DevApp } from "../procs/procsTypes";
import { selectAppInLogs, watchAppSelection } from "./agentLogsAppSelection";
import {
  agentIdsBySource,
  allAppSources,
  appCountLabel,
  appForService,
  appSoloSources,
  appsOfAgent,
  consolePaths,
  isAppSource,
  isExactPick,
  launcherLabelOf,
  pickKeepsApp,
  placeAppSources,
  serviceSourcesOf,
  streamLabel,
} from "./agentLogsApps";
import type { LogLine } from "./agentLogsTypes";
import type { RunningSource } from "./agentLogsRunning";
import { resetAgentLogsForTests, useAgentLogsStore } from "./agentLogsStore";

const app = (name: string, key = `${name}:1`): DevApp => ({
  key,
  pid: 1,
  runtime: "node",
  name,
  exe: null,
  argv: [],
  cwd: null,
  startedMs: null,
  ports: [],
  console: "terminal",
  logFiles: [],
  containerId: null,
  origin: "external",
  terminalId: null,
  agentId: null,
  launchedBy: null,
  captured: null,
});
const src = (source: string, p: Partial<RunningSource> = {}): RunningSource => ({
  source,
  kind: "app",
  running: true,
  lines: 1,
  errors: 0,
  firstMs: 0,
  sinceMs: 0,
  stoppedMs: null,
  reason: null,
  lastId: 1,
  command: null,
  ...p,
});
const stream = (appKey: string, source: string): ActiveStream => ({ id: `${appKey}|${source}`, appKey, path: "/x", key: "k", source });

const WEB = app("web");
const API = app("api");
const API_V2 = app("api · v2", "api2:1");
const APPS = [WEB, API, API_V2];

describe("placeAppSources", () => {
  it("puts each `app` source under the app it is named after (longest name wins), keeps order, and leaves the rest unclaimed", () => {
    const sources = [
      src("web · server.log"),
      src("zsh · repo", { kind: "terminal" }),
      src("api · v2 · out.log"),
      src("web · docker"),
      src("gone · app.log"),
      src("api · a.log"),
    ];
    const { byApp, unclaimed } = placeAppSources(sources, APPS);
    expect(byApp.get("web:1")?.map((s) => s.source)).toEqual(["web · server.log", "web · docker"]);
    expect(byApp.get("api:1")?.map((s) => s.source)).toEqual(["api · a.log"]);
    expect(byApp.get("api2:1")?.map((s) => s.source)).toEqual(["api · v2 · out.log"]);
    // A terminal is never placed; an app source no app claims is an orphan row.
    expect(unclaimed.map((s) => s.source)).toEqual(["gone · app.log"]);
  });

  it("with no apps listed (loading, or none running) every `app` source is unclaimed", () => {
    expect(placeAppSources([src("web · a.log")], []).unclaimed.map((s) => s.source)).toEqual(["web · a.log"]);
  });
});

describe("streamLabel", () => {
  it.each([
    ["web · server.log", "server.log"],
    ["web · docker", "docker"],
    ["web · ", "web · "], // never an empty label
    ["other · x.log", "other · x.log"],
  ])("%s → %s", (source, want) => expect(streamLabel(source, WEB)).toBe(want));
});

describe("isAppSource / pickKeepsApp", () => {
  const streams = [stream("web:1", "renamed · picked.log")];

  it("a tail started for the app (whatever its label) or a source named after it", () => {
    expect(isAppSource("renamed · picked.log", WEB, streams, APPS)).toBe(true);
    expect(isAppSource("web · a.log", WEB, streams, APPS)).toBe(true);
    expect(isAppSource("api · a.log", WEB, streams, APPS)).toBe(false);
    expect(isAppSource("renamed · picked.log", API, streams, APPS)).toBe(false);
  });

  it("keeps the app only while every picked source is its own; All (null) never keeps it; the empty pick does", () => {
    expect(pickKeepsApp(["web · a.log", "renamed · picked.log"], WEB, streams, APPS)).toBe(true);
    expect(pickKeepsApp([], WEB, streams, APPS)).toBe(true);
    expect(pickKeepsApp(["web · a.log", "zsh · repo"], WEB, streams, APPS)).toBe(false);
    expect(pickKeepsApp(null, WEB, streams, APPS)).toBe(false);
  });
});

describe("appSoloSources", () => {
  it("the tails started here first, then the app's RUNNING ring sources — no duplicates, no stopped ones, no other app's", () => {
    const streams = [stream("web:1", "web · a.log"), stream("api:1", "api · x.log")];
    const running = [
      src("web · a.log"),
      src("web · b.log"),
      src("web · old.log", { running: false }),
      src("web · zsh", { kind: "terminal" }),
      src("api · y.log"),
    ];
    expect(appSoloSources(WEB, streams, running, APPS)).toEqual(["web · a.log", "web · b.log"]);
  });

  it("is empty when the app streams nothing", () => {
    expect(appSoloSources(WEB, [], [src("api · y.log")], APPS)).toEqual([]);
  });
});

/* ── the subscription, over the real stores ── */

describe("watchAppSelection", () => {
  let stop: () => void;
  const logs = () => useAgentLogsStore.getState();
  const selected = () => useProcsStore.getState().selectedKey;

  beforeEach(() => {
    resetAgentLogsForTests();
    useProcsStore.setState({ list: { available: true, reason: null, apps: APPS }, streams: [stream("web:1", "web · a.log")] });
    stop = watchAppSelection();
  });
  afterEach(() => {
    stop();
    resetAgentLogsForTests();
    resetProcsStore();
  });

  it("a pick of the app's own streams (or its empty pick) keeps it; any other source, or All, deselects it", () => {
    selectDevApp("web:1");
    logs().soloSources(["web · a.log"]);
    expect(selected()).toBe("web:1");
    logs().soloSources([]);
    expect(selected()).toBe("web:1");
    logs().toggleOnlySource("zsh · repo");
    expect(selected()).toBeNull();

    selectDevApp("web:1");
    logs().soloSources(["web · a.log"]);
    logs().setSourcePick([], null);
    expect(selected()).toBeNull();
  });

  it("an error badge of another source deselects; one of the app's own keeps it", () => {
    selectDevApp("web:1");
    logs().requestErrorJump("web · a.log", "first");
    expect(selected()).toBe("web:1");
    logs().requestErrorJump("zsh · repo", "first");
    expect(selected()).toBeNull();
  });

  it("only a change of the PICK is judged — a level chip or the text box keep the app", () => {
    selectDevApp("web:1");
    logs().soloSources([]);
    logs().toggleLevel("debug");
    logs().setQuery("boom");
    expect(selected()).toBe("web:1");
  });

  it("nothing to do without a selection; a selected app that is no longer listed is let go on the next pick", () => {
    logs().toggleOnlySource("zsh · repo");
    expect(selected()).toBeNull();
    selectDevApp("gone:9");
    logs().soloSources([]);
    expect(selected()).toBeNull();
    // No list at all (the poll failed from the start): nothing to keep it by.
    useProcsStore.setState({ list: null });
    selectDevApp("web:1");
    logs().soloSources([]);
    expect(selected()).toBeNull();
  });

  it("the selected app exiting while its empty pick is on screen: deselected, and back to All", () => {
    selectDevApp("web:1");
    logs().soloSources([]);
    useProcsStore.setState({ list: { available: true, reason: null, apps: [API] } });
    expect(selected()).toBeNull();
    expect(logs().filter.onlySources).toBeNull();
  });

  it("the selected app exiting while its streams are soloed: deselected, the streams stay picked (they outlive it)", () => {
    selectDevApp("web:1");
    logs().soloSources(["web · a.log"]);
    useProcsStore.setState({ list: { available: true, reason: null, apps: [API] } });
    expect(selected()).toBeNull();
    expect(logs().filter.onlySources).toEqual(["web · a.log"]);
  });

  it("a new poll that still lists the app, a failed poll, or no selection change nothing", () => {
    selectDevApp("web:1");
    logs().soloSources([]);
    useProcsStore.setState({ list: { available: true, reason: null, apps: [...APPS] } });
    expect(selected()).toBe("web:1");
    useProcsStore.setState({ listError: "boom" }); // same list object
    useProcsStore.setState({ list: null });
    expect(selected()).toBe("web:1");
    selectDevApp(null);
    useProcsStore.setState({ list: { available: true, reason: null, apps: [] } });
    expect(logs().filter.onlySources).toEqual([]);
  });

  it("unsubscribes", () => {
    stop();
    selectDevApp("web:1");
    logs().setSourcePick([], null);
    expect(selected()).toBe("web:1");
    stop = () => {};
  });
});

/* ── the Service that tails an app's console (by exact path) ── */

const OUT = "/tmp/claude-501/p/s/tasks/bz9.output";
const GEN: DevApp = {
  ...app("gazelle", "gazelle:77"),
  runtime: "rust",
  origin: "ide",
  logFiles: [
    { path: OUT, kind: "stdout" },
    { path: "/w/gazelle/err.txt", kind: "stderr" },
    { path: "/w/gazelle/audit.log", kind: "log" },
  ],
};
/** `servicePaths` shape: path → the source tailing it. */
const PATHS = new Map([
  [OUT, "python3 · bg"],
  ["/w/gazelle/err.txt", "python3 · bg"],
  ["/w/gazelle/audit.log", "auditor · bg"],
  ["/other.out", "other · bg"],
]);

describe("consolePaths / appForService / serviceSourcesOf", () => {
  it("the console is stdout + stderr, never an opened `log` file", () => {
    expect(consolePaths(GEN)).toEqual([OUT, "/w/gazelle/err.txt"]);
  });

  it("a Service belongs to the app whose console file it tails — by path; the service's name is irrelevant", () => {
    expect(appForService("python3 · bg", [WEB, GEN], PATHS)?.key).toBe("gazelle:77");
    // It tails a file gazelle has open, but not gazelle's console.
    expect(appForService("auditor · bg", [WEB, GEN], PATHS)).toBeNull();
    // It tails a file no app has.
    expect(appForService("other · bg", [WEB, GEN], PATHS)).toBeNull();
    // It tails nothing known.
    expect(appForService("gazelle · bg", [WEB, GEN], PATHS)).toBeNull();
    // Two apps name the file: the first listed wins.
    const twin = { ...GEN, key: "twin:1", name: "twin" };
    expect(appForService("python3 · bg", [twin, GEN], PATHS)?.key).toBe("twin:1");
  });

  it("serviceSourcesOf lists each tailing service once, in the console's path order", () => {
    expect(serviceSourcesOf(GEN, PATHS)).toEqual(["python3 · bg"]);
    expect(serviceSourcesOf(GEN, new Map([["/w/gazelle/err.txt", "b · bg"], [OUT, "a · bg"]]))).toEqual(["a · bg", "b · bg"]);
    expect(serviceSourcesOf(WEB, PATHS)).toEqual([]);
  });
});

describe("placeAppSources with services", () => {
  it("names the owner of a Service tailing an app's console (it stays out of byApp), and collects live apps", () => {
    const sources = [
      src("python3 · bg", { kind: "task" }),
      src("other · bg", { kind: "task" }),
      src("web · server.log"),
      src("api · old.log", { running: false }),
      src("zsh · repo", { kind: "terminal" }),
    ];
    const p = placeAppSources(sources, [WEB, API, GEN], PATHS);
    expect([...p.serviceOwners].map(([s2, a]) => `${s2} → ${a.key}`)).toEqual(["python3 · bg → gazelle:77"]);
    expect([...p.byApp.keys()]).toEqual(["web:1", "api:1"]);
    expect([...p.liveKeys]).toEqual(["gazelle:77", "web:1"]);
    expect(p.unclaimed).toEqual([]);
  });

  it("a stopped Service still has its owner, but does not make it live", () => {
    const p = placeAppSources([src("python3 · bg", { kind: "task", running: false })], [GEN], PATHS);
    expect(p.serviceOwners.get("python3 · bg")?.key).toBe("gazelle:77");
    expect([...p.liveKeys]).toEqual([]);
  });
});

describe("the app's streams include its console's Service", () => {
  it("isAppSource / pickKeepsApp accept it only with the paths given", () => {
    expect(isAppSource("python3 · bg", GEN, [], [GEN], PATHS)).toBe(true);
    expect(isAppSource("python3 · bg", GEN, [], [GEN])).toBe(false);
    expect(pickKeepsApp(["python3 · bg"], GEN, [], [GEN], PATHS)).toBe(true);
    expect(pickKeepsApp(["python3 · bg"], GEN, [], [GEN])).toBe(false);
  });

  it("appSoloSources: the Service first (running or not), then tails started here, then running ring sources — no duplicates", () => {
    const gStream = stream("gazelle:77", "gazelle · extra.log");
    const got = appSoloSources(
      GEN,
      [gStream, stream("gazelle:77", "python3 · bg")],
      [src("gazelle · ring.log"), src("python3 · bg", { kind: "task", running: false })],
      [GEN],
      PATHS,
    );
    expect(got).toEqual(["python3 · bg", "gazelle · extra.log", "gazelle · ring.log"]);
  });
});

describe("All apps", () => {
  it("allAppSources: each app's solo in list order, then the orphans; no duplicates", () => {
    const got = allAppSources(
      [WEB, GEN],
      [stream("web:1", "web · a.log")],
      [src("web · a.log"), src("web · b.log")],
      PATHS,
      [src("gone · x.log"), src("web · a.log")],
    );
    expect(got).toEqual(["web · a.log", "web · b.log", "python3 · bg", "gone · x.log"]);
    expect(allAppSources([], [], [], new Map(), [])).toEqual([]);
  });

  it("isExactPick: the same set in any order — never All, never an empty target", () => {
    expect(isExactPick(["b", "a"], ["a", "b"])).toBe(true);
    expect(isExactPick(["a"], ["a", "b"])).toBe(false);
    expect(isExactPick(["a", "c"], ["a", "b"])).toBe(false);
    expect(isExactPick(null, ["a"])).toBe(false);
    expect(isExactPick([], [])).toBe(false);
  });
});

describe("an agent's apps", () => {
  const line = (source: string, agentId: string | null): Pick<LogLine, "source" | "agentId"> => ({ source, agentId });

  it("agentIdsBySource: the first agent id each label carries; labels without one are absent", () => {
    const m = agentIdsBySource([line("claude · g", null), line("claude · g", "a-1"), line("claude · g", "a-9"), line("zsh · w", null)]);
    expect([...m]).toEqual([["claude · g", "a-1"]]);
  });

  it("appsOfAgent: only IDE apps bound to that agent, in order; none for no agent", () => {
    const mine = { ...GEN, agentId: "a-1" };
    const other = { ...GEN, key: "o:1", agentId: "a-2" };
    const external = { ...WEB, agentId: "a-1" };
    const second = { ...GEN, key: "s:1", name: "second", agentId: "a-1" };
    expect(appsOfAgent("a-1", [mine, other, external, second]).map((a) => a.key)).toEqual(["gazelle:77", "s:1"]);
    expect(appsOfAgent(null, [mine])).toEqual([]);
    expect(appsOfAgent(undefined, [mine])).toEqual([]);
  });

  it("appCountLabel", () => {
    expect(appCountLabel(1)).toBe("1 app");
    expect(appCountLabel(2)).toBe("2 apps");
  });
});

describe("selectAppInLogs", () => {
  afterEach(() => {
    resetAgentLogsForTests();
    resetProcsStore();
  });

  it("selects the app, then solos its streams — the console's Service included, from the ring's paths", () => {
    useProcsStore.setState({ list: { available: true, reason: null, apps: [GEN] } });
    const svc: LogLine = {
      id: 1, tsMs: 1, terminalId: null, agentId: null, source: "python3 · bg", kind: "task", level: "info",
      text: "up", detail: `python3 x\n${OUT}`, toolUseId: null,
    };
    useAgentLogsStore.setState({ lines: [svc] });
    selectAppInLogs(GEN);
    expect(useProcsStore.getState().selectedKey).toBe("gazelle:77");
    expect(useAgentLogsStore.getState().filter.onlySources).toEqual(["python3 · bg"]);
  });

  it("with no list yet (a click racing the first poll) it still selects and solos what it knows", () => {
    selectAppInLogs(GEN);
    expect(useProcsStore.getState().selectedKey).toBe("gazelle:77");
    expect(useAgentLogsStore.getState().filter.onlySources).toEqual([]);
  });

  it("watchAppSelection keeps the app when its console's Service is picked", () => {
    const stop = watchAppSelection();
    useProcsStore.setState({ list: { available: true, reason: null, apps: [GEN] } });
    useAgentLogsStore.setState({
      lines: [{ id: 1, tsMs: 1, terminalId: null, agentId: null, source: "python3 · bg", kind: "task", level: "info", text: "up", detail: `x\n${OUT}`, toolUseId: null }],
    });
    selectDevApp("gazelle:77");
    useAgentLogsStore.getState().soloSource("python3 · bg");
    expect(useProcsStore.getState().selectedKey).toBe("gazelle:77");
    useAgentLogsStore.getState().soloSource("zsh · repo");
    expect(useProcsStore.getState().selectedKey).toBeNull();
    stop();
  });
});

describe("launcherLabelOf — the tag names the launcher the way the sidebar does", () => {
  const L = (o: Partial<{ agentId: string | null; terminalId: string | null; source: string; kind: string }>) =>
    ({ agentId: null, terminalId: null, source: "", kind: "output", ...o }) as never;
  const lines = [
    L({ terminalId: "t1", source: "bash · workspace", kind: "system" }),
    L({ terminalId: "t1", agentId: "a1", source: "claude · gazelle", kind: "tool" }),
    L({ terminalId: "t1", agentId: "a1", source: "gazelle · bg", kind: "task" }),
    L({ terminalId: "t2", source: "zsh · web", kind: "output" }),
  ];
  it.each([
    [{ origin: "ide", agentId: "a1", terminalId: "t1" }, "claude · gazelle"],
    [{ origin: "ide", agentId: null, terminalId: "t1" }, "bash · workspace"],
    [{ origin: "ide", agentId: null, terminalId: "t2" }, "zsh · web"],
    [{ origin: "ide", agentId: "gone", terminalId: "t9" }, null],
    [{ origin: "ide", agentId: null, terminalId: null }, null],
    [{ origin: "external", agentId: "a1", terminalId: "t1" }, null],
  ] as const)("%j → %s", (app, want) => {
    expect(launcherLabelOf(app as never, lines)).toBe(want);
  });

  it("a renamed launcher terminal is named by its live title (`by gazelle`), an agent by its source", () => {
    const renamed = new Map([["bash · workspace", "gazelle"]]);
    expect(launcherLabelOf({ origin: "ide", agentId: null, terminalId: "t1" }, lines, renamed)).toBe("gazelle");
    expect(launcherLabelOf({ origin: "ide", agentId: null, terminalId: "t2" }, lines, renamed)).toBe("zsh · web");
    expect(launcherLabelOf({ origin: "ide", agentId: "a1", terminalId: "t1" }, lines, renamed)).toBe("claude · gazelle");
  });
});
