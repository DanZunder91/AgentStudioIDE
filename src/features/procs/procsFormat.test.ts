import { describe, expect, it } from "vitest";

import {
  APPS_TITLE,
  basename,
  commandLine,
  devAppForSource,
  formatUptime,
  originTag,
  portsLabel,
  processNameOf,
  groupByRuntime,
  RUNTIME_ORDER,
  RUNTIME_SECTION_LABELS,
  streamId,
  uncapturedApps,
  uncapturedText,
} from "./procsFormat";
import { PROCS_POLL_MS, RUNTIME_LABELS, type DevApp } from "./procsTypes";

const app = (name: string, key = name): DevApp => ({
  key,
  pid: 1,
  runtime: "node",
  name,
  exe: null,
  argv: [],
  cwd: null,
  startedMs: null,
  ports: [],
  console: "none",
  logFiles: [],
  containerId: null,
  origin: "external",
  terminalId: null,
  agentId: null,
  launchedBy: null,
  captured: null,
});

describe("constants (values pinned as literals)", () => {
  it("labels every runtime as the spec names it and polls every 3 s", () => {
    expect(RUNTIME_LABELS).toEqual({ jvm: "JVM", node: "Node", rust: "Rust", python: "Python", go: "Go", docker: "Docker", shell: "Shell" });
    expect(PROCS_POLL_MS).toBe(3000);
  });
});

describe("basename", () => {
  it("takes the last segment of either separator, and keeps a path that ends in one", () => {
    expect(basename("/Users/me/app/logs/server.log")).toBe("server.log");
    expect(basename("C:\\logs\\a.out")).toBe("a.out");
    expect(basename("plain.log")).toBe("plain.log");
    expect(basename("/var/log/")).toBe("/var/log/");
  });
});

describe("commandLine", () => {
  it("joins argv verbatim, quoting only arguments with whitespace", () => {
    expect(commandLine(["java", "-jar", "my app.jar", "--password=•••"])).toBe('java -jar "my app.jar" --password=•••');
    expect(commandLine([])).toBe("");
  });

  it("adds nothing Rust did not send — a masked flag stays masked", () => {
    const line = commandLine(["node", "server.js", "--token=•••"]);
    expect(line).toContain("--token=•••");
    expect(line).toBe("node server.js --token=•••");
  });
});

describe("formatUptime", () => {
  it("picks the unit at each boundary (both sides)", () => {
    expect(formatUptime(-5_000)).toBe("0s");
    expect(formatUptime(59_999)).toBe("59s");
    expect(formatUptime(60_000)).toBe("1m");
    expect(formatUptime(59 * 60_000 + 59_000)).toBe("59m");
    expect(formatUptime(3_600_000)).toBe("1h 0m");
    expect(formatUptime(3 * 3_600_000 + 12 * 60_000)).toBe("3h 12m");
    expect(formatUptime(24 * 3_600_000 - 1)).toBe("23h 59m");
    expect(formatUptime(2 * 86_400_000 + 4 * 3_600_000)).toBe("2d 4h");
  });
});

describe("portsLabel", () => {
  it("shows up to two ports, then a count", () => {
    expect(portsLabel([])).toBe("");
    expect(portsLabel([3000])).toBe(":3000");
    expect(portsLabel([3000, 5173])).toBe(":3000 :5173");
    expect(portsLabel([3000, 5173, 9229])).toBe(":3000 :5173 +1");
    expect(portsLabel([1, 2, 3], 1)).toBe(":1 +2");
  });
});

describe("streamId", () => {
  it("distinguishes a file from docker and one app from another", () => {
    expect(streamId("a", "/x.log")).toBe("a\u0000/x.log");
    expect(streamId("a", null)).toBe("a\u0000docker");
    expect(streamId("a", "/x.log")).not.toBe(streamId("b", "/x.log"));
  });
});

describe("devAppForSource", () => {
  const apps = [app("web"), app("web-admin"), app("api"), app("api · v2")];

  it("matches on `<name> · `, never on a bare prefix", () => {
    expect(devAppForSource("web · server.log", apps)?.key).toBe("web");
    expect(devAppForSource("web-admin · server.log", apps)?.key).toBe("web-admin");
    expect(devAppForSource("webx · server.log", apps)).toBeNull();
    expect(devAppForSource("web", apps)).toBeNull();
  });

  it("prefers the longest matching name", () => {
    expect(devAppForSource("api · v2 · docker", apps)?.key).toBe("api · v2");
    expect(devAppForSource("api · docker", apps)?.key).toBe("api");
    // Order-independent: the longer name listed FIRST still wins over the shorter one after it.
    expect(devAppForSource("api · v2 · docker", [app("api · v2"), app("api")])?.key).toBe("api · v2");
  });

  it("is null when no app is listed", () => {
    expect(devAppForSource("web · x.log", [])).toBeNull();
  });
});

describe("Apps-group helpers", () => {
  it("APPS_TITLE is the group's name", () => {
    expect(APPS_TITLE).toBe("Apps");
  });

  it("RUNTIME_ORDER / RUNTIME_SECTION_LABELS: the chosen order and headings, pinned as literals", () => {
    expect(RUNTIME_ORDER).toEqual(["rust", "jvm", "node", "python", "go", "docker", "shell"]);
    expect(RUNTIME_SECTION_LABELS).toEqual({
      rust: "Rust · Cargo",
      jvm: "JVM",
      node: "Node · JS",
      python: "Python",
      go: "Go",
      docker: "Docker",
      shell: "Shell",
    });
  });

  it("groupByRuntime: every runtime, in order, empty ones included; in a section live → ide → external, else the order given", () => {
    const r = (name: string, runtime: DevApp["runtime"], origin: DevApp["origin"] = "external"): DevApp => ({ ...app(name), runtime, origin });
    const legacy = { ...r("legacy", "go") } as Partial<DevApp>;
    delete legacy.origin; // a build that predates `origin` — ranks as external
    const apps = [
      r("n-ext", "node"),
      r("g-ide", "go", "ide"),
      r("n-ide", "node", "ide"),
      legacy as DevApp,
      r("n-live", "node"),
      r("rs", "rust"),
      r("n-ext2", "node"),
      r("g-live", "go"),
    ];
    const live = new Set(["n-live", "g-live"]);
    const got = groupByRuntime(apps, (a) => live.has(a.name)).map((g) => `${g.runtime}: ${g.apps.map((a) => a.name).join(" ")}`);
    expect(got).toEqual([
      "rust: rs",
      "jvm: ",
      "node: n-live n-ide n-ext n-ext2",
      "python: ",
      "go: g-live g-ide legacy",
      "docker: ",
      "shell: ",
    ]);
    // Without a liveness test: ide → external only.
    expect(groupByRuntime(apps)[2].apps.map((a) => a.name)).toEqual(["n-ide", "n-ext", "n-live", "n-ext2"]);
    expect(groupByRuntime([]).map((g) => g.apps.length)).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  it("originTag: by <launchedBy>, by the IDE, external", () => {
    expect(originTag({ origin: "ide", launchedBy: "claude · gazelle" })).toBe("by claude · gazelle");
    expect(originTag({ origin: "ide", launchedBy: null })).toBe("by the IDE");
    expect(originTag({ origin: "external", launchedBy: "ignored" })).toBe("external");
  });

  it("processNameOf: netcap's client_name — exe basename without .exe, else argv[0], else null", () => {
    expect(processNameOf({ exe: "/work/gazelle/target/debug/gazelle", argv: ["x"] })).toBe("gazelle");
    expect(processNameOf({ exe: "C:\\w\\target\\debug\\gazelle.EXE", argv: [] })).toBe("gazelle");
    expect(processNameOf({ exe: null, argv: ["target/debug/api", "--port"] })).toBe("api");
    expect(processNameOf({ exe: null, argv: [] })).toBeNull();
    expect(processNameOf({ exe: "", argv: ["node"] })).toBeNull();
  });
});

describe("the capture guard's words and list", () => {
  it("names the app and the consequence", () => {
    expect(uncapturedText({ name: "gazelle" })).toBe("gazelle was started without the IDE's proxy — its HTTP calls can't show in Network.");
  });
  it("lists IDE apps Rust found uncaptured — never external, unknown or pid-less ones", () => {
    const APP = app("x");
    const ide = { ...APP, origin: "ide" as const, terminalId: "T" };
    const a = { ...ide, key: "a", captured: false };
    const apps = [a, { ...ide, key: "b", captured: true }, { ...ide, key: "c", captured: null }, { ...APP, key: "d", captured: false }, { ...ide, key: "e", pid: null, captured: false }];
    expect(uncapturedApps(apps).map((x) => x.key)).toEqual(["a"]);
  });
});
