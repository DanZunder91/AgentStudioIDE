/** Expected orders and values are written by hand, never derived from the function under test. */

import { describe, expect, it, vi } from "vitest";

import {
  NO_BYTES_TITLE,
  NO_RATE_TITLE,
  rateNaTitle,
  appItems,
  bytesCell,
  defaultDir,
  isListener,
  modeLabel,
  NO_RDNS_TITLE,
  rateCell,
  remoteCell,
  remoteTitle,
  shownApps,
  sortApps,
  summarizeShown,
  type MachineSort,
} from "./machineFormat";
import type { MachineApp, MachineConn, MachineSample } from "./networkTypes";

function conn(o: Partial<MachineConn> = {}): MachineConn {
  return {
    proto: "tcp4",
    local: "10.0.0.5:50000",
    remote: "1.2.3.4:443",
    remoteHost: null,
    state: "Established",
    bytesIn: 10,
    bytesOut: 5,
    rateIn: 1,
    rateOut: 1,
    ...o,
  };
}
function app(name: string, pid: number, o: Partial<MachineApp> = {}): MachineApp {
  return {
    key: `${name}:${pid}`,
    name,
    pid,
    user: "self",
    bytesIn: 0,
    bytesOut: 0,
    rateIn: 0,
    rateOut: 0,
    connections: [conn()],
    ...o,
  };
}
const sample = (...apps: MachineApp[]): MachineSample => ({ tsMs: 1, apps });
const ALL = { selection: null, filter: "", hideListeners: false };
const names = (rows: { app: MachineApp }[]) => rows.map((r) => r.app.key);

describe("isListener", () => {
  it.each([
    [conn({ remote: null, state: "Listen" }), true],
    [conn({ remote: null, state: "", proto: "udp4" }), true],
    [conn({ state: "LISTEN" }), true],
    [conn({ state: "Established" }), false],
    [conn({ state: "", proto: "udp6" }), false],
  ])("%# → %s", (c, want) => {
    expect(isListener(c)).toBe(want);
  });
});

describe("shownApps", () => {
  const listenerOnly = app("sshd", 7, { connections: [conn({ remote: null, state: "Listen" })] });
  const mixed = app("Safari", 10, {
    connections: [conn({ remote: null, state: "Listen" }), conn({ remote: "5.6.7.8:443", remoteHost: "apple.com" })],
  });
  const socketless = app("kernel_task", 0, { connections: [] });
  const s = sample(listenerOnly, mixed, socketless);

  it("null sample → nothing", () => {
    expect(shownApps(null, ALL)).toEqual([]);
  });

  it("Hide listeners drops listener sockets, and apps that had ONLY listeners — but not socketless apps", () => {
    const on = shownApps(s, { ...ALL, hideListeners: true });
    expect(names(on)).toEqual(["Safari:10", "kernel_task:0"]);
    expect(on[0].conns).toHaveLength(1);
    expect(on[0].conns[0].remote).toBe("5.6.7.8:443");
    const off = shownApps(s, ALL);
    expect(names(off)).toEqual(["sshd:7", "Safari:10", "kernel_task:0"]);
    expect(off[1].conns).toHaveLength(2);
  });

  it("selection: null is all, a list is a pick by NAME, [] is none", () => {
    const two = sample(app("Safari", 1), app("Safari", 2), app("Docker", 3));
    expect(names(shownApps(two, { ...ALL, selection: ["Safari"] }))).toEqual(["Safari:1", "Safari:2"]);
    expect(names(shownApps(two, { ...ALL, selection: [] }))).toEqual([]);
    expect(names(shownApps(two, ALL))).toEqual(["Safari:1", "Safari:2", "Docker:3"]);
  });

  it("filter by app name or pid keeps every socket; by socket keeps only matches", () => {
    const a = app("Slack", 42, {
      connections: [conn({ remote: "9.9.9.9:443", remoteHost: "slack.com" }), conn({ remote: "8.8.8.8:53" })],
    });
    const b = app("curl", 99, { connections: [conn({ local: "10.0.0.5:61000", remote: "7.7.7.7:80" })] });
    const s2 = sample(a, b);
    expect(shownApps(s2, { ...ALL, filter: "  SLACK " })[0].conns).toHaveLength(2);
    expect(names(shownApps(s2, { ...ALL, filter: "99" }))).toEqual(["curl:99"]);
    const byHost = shownApps(s2, { ...ALL, filter: "slack.com" });
    expect(names(byHost)).toEqual(["Slack:42"]);
    expect(byHost[0].conns.map((c) => c.remote)).toEqual(["9.9.9.9:443"]);
    expect(names(shownApps(s2, { ...ALL, filter: "61000" }))).toEqual(["curl:99"]);
    expect(names(shownApps(s2, { ...ALL, filter: "nowhere" }))).toEqual([]);
  });

  it("a listener's null remote does not match a filter by itself", () => {
    const l = app("x", 1, { connections: [conn({ remote: null, remoteHost: null, state: "Listen", local: "*:22" })] });
    expect(names(shownApps(sample(l), { ...ALL, filter: "listen" }))).toEqual(["x:1"]);
    expect(names(shownApps(sample(l), { ...ALL, filter: "null" }))).toEqual([]);
  });
});

describe("sortApps", () => {
  const rows = shownApps(
    sample(
      app("beta", 2, { rateIn: 300, rateOut: 1, bytesIn: 10, bytesOut: null, connections: [conn()] }),
      app("Alpha", 1, { rateIn: 50, rateOut: 900, bytesIn: 5000, bytesOut: 7, connections: [conn(), conn(), conn()] }),
      app("gamma", 3, { rateIn: null, rateOut: 20, bytesIn: null, bytesOut: 70, connections: [conn(), conn()] }),
      app("delta", 4, { rateIn: 300, rateOut: 5, bytesIn: 1, bytesOut: 3, connections: [conn()] }),
    ),
    ALL,
  );
  const order = (sort: MachineSort) => names(sortApps(rows, sort));

  it.each<[MachineSort, string[]]>([
    [{ key: "rateIn", dir: "desc" }, ["beta:2", "delta:4", "Alpha:1", "gamma:3"]],
    [{ key: "rateIn", dir: "asc" }, ["Alpha:1", "beta:2", "delta:4", "gamma:3"]],
    [{ key: "rateOut", dir: "desc" }, ["Alpha:1", "gamma:3", "delta:4", "beta:2"]],
    [{ key: "bytesIn", dir: "desc" }, ["Alpha:1", "beta:2", "delta:4", "gamma:3"]],
    [{ key: "bytesOut", dir: "desc" }, ["gamma:3", "Alpha:1", "delta:4", "beta:2"]],
    [{ key: "bytesOut", dir: "asc" }, ["delta:4", "Alpha:1", "gamma:3", "beta:2"]],
    [{ key: "conns", dir: "desc" }, ["Alpha:1", "gamma:3", "beta:2", "delta:4"]],
    [{ key: "name", dir: "asc" }, ["Alpha:1", "beta:2", "delta:4", "gamma:3"]],
    [{ key: "name", dir: "desc" }, ["gamma:3", "delta:4", "beta:2", "Alpha:1"]],
  ])("%j", (sort, want) => {
    expect(order(sort)).toEqual(want);
  });

  it("nulls tie by name, and same names tie by pid", () => {
    const r = shownApps(
      sample(app("z", 1, { rateIn: null }), app("a", 9, { rateIn: null }), app("a", 3, { rateIn: null })),
      ALL,
    );
    expect(names(sortApps(r, { key: "rateIn", dir: "desc" }))).toEqual(["a:3", "a:9", "z:1"]);
  });

  it("does not mutate its input", () => {
    const before = names(rows);
    sortApps(rows, { key: "name", dir: "desc" });
    expect(names(rows)).toEqual(before);
  });

  it("defaultDir: numbers biggest-first, names A→Z", () => {
    expect(defaultDir("name")).toBe("asc");
    expect(defaultDir("rateOut")).toBe("desc");
  });
});

describe("summarizeShown", () => {
  it("sums shown sockets and known rates; a rate is null only when none is known", () => {
    const rows = shownApps(
      sample(
        app("a", 1, { rateIn: 100, rateOut: null, connections: [conn(), conn()] }),
        app("b", 2, { rateIn: 23, rateOut: null }),
      ),
      ALL,
    );
    expect(summarizeShown(rows)).toEqual({ apps: 2, conns: 3, rateIn: 123, rateOut: null });
    expect(summarizeShown([])).toEqual({ apps: 0, conns: 0, rateIn: null, rateOut: null });
  });
});

describe("appItems", () => {
  it("one row per name (pids merged), sorted case-insensitively, count = sockets", () => {
    expect(
      appItems(
        sample(
          app("zoom", 1),
          app("Chrome", 2, { connections: [conn(), conn()] }),
          app("Chrome", 3, { connections: [conn()] }),
          app("bash", 4, { connections: [] }),
        ),
      ),
    ).toEqual([
      { id: "bash", label: "bash", count: 0 },
      { id: "Chrome", label: "Chrome", count: 3 },
      { id: "zoom", label: "zoom", count: 1 },
    ]);
    expect(appItems(null)).toEqual([]);
  });
});

describe("cells", () => {
  it.each([
    [null, "—", "—"],
    [0, "0B", "0B/s"],
    [512.4, "512B", "512B/s"],
    [2048, "2.0KB", "2.0KB/s"],
    [5 * 1024 * 1024, "5.0MB", "5.0MB/s"],
  ])("%s → %s / %s", (n, bytes, rate) => {
    expect(bytesCell(n)).toBe(bytes);
    expect(rateCell(n)).toBe(rate);
  });

  it("remote: host (ip:port) when resolved, the bare peer otherwise, — for none", () => {
    expect(remoteCell(conn({ remote: "1.2.3.4:443", remoteHost: "example.com" }))).toBe("example.com (1.2.3.4:443)");
    expect(remoteCell(conn({ remote: "1.2.3.4:443", remoteHost: null }))).toBe("1.2.3.4:443");
    expect(remoteCell(conn({ remote: null }))).toBe("—");
  });

  it("remote's hover: the full text when resolved; for a bare address, WHY it is bare (CDN edges rarely have a PTR)", () => {
    expect(NO_RDNS_TITLE).toBe("no reverse DNS record — CDN addresses rarely have one");
    expect(remoteTitle(conn({ remote: "1.2.3.4:443", remoteHost: "example.com" }))).toBe("example.com (1.2.3.4:443)");
    expect(remoteTitle(conn({ remote: "1.2.3.4:443", remoteHost: null }))).toBe(
      "1.2.3.4:443 — no reverse DNS record — CDN addresses rarely have one",
    );
    expect(remoteTitle(conn({ remote: "1.2.3.4:443", remoteHost: "" }))).toBe(
      "1.2.3.4:443 — no reverse DNS record — CDN addresses rarely have one",
    );
    expect(remoteTitle(conn({ remote: null }))).toBe("—");
  });

  it("mode label names the Mac only for the nettop backend", () => {
    expect(modeLabel("macos-nettop")).toBe("Whole Mac");
    expect(modeLabel("linux-proc")).toBe("Whole computer");
    expect(modeLabel("windows-iphlpapi")).toBe("Whole computer");
    // jsdom is not macOS: with no status, the platform says "computer".
    expect(modeLabel(null)).toBe("Whole computer");
    expect(modeLabel(undefined)).toBe("Whole computer");
  });

  it("with no status yet, the platform decides — Whole Mac only on macOS", () => {
    const ua = vi.spyOn(window.navigator, "userAgent", "get");
    try {
      ua.mockReturnValue("Mozilla/5.0 (Macintosh; Intel Mac OS X)");
      expect(modeLabel(null)).toBe("Whole Mac");
      // A loaded status still wins over the platform.
      expect(modeLabel("linux-proc")).toBe("Whole computer");
      ua.mockReturnValue("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
      expect(modeLabel(undefined)).toBe("Whole computer");
    } finally {
      ua.mockRestore();
    }
  });
});

describe("rateNaTitle — why a rate cell reads `—`", () => {
  it("unknown bytes → the backend is blind; known bytes → no rate YET (first sample, unmatched socket)", () => {
    expect(rateNaTitle(null)).toBe(NO_BYTES_TITLE);
    expect(rateNaTitle(0)).toBe(NO_RATE_TITLE);
    expect(rateNaTitle(1_572_881)).toBe(NO_RATE_TITLE);
    expect(NO_RATE_TITLE).toBe("No rate yet: a rate needs two samples (about a second) of this socket or process.");
  });
});
