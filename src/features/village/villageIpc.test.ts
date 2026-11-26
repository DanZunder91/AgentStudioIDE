/** serde ignores a misspelt key (a typo fails as silence): names and argument shapes are exact. */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installTauriMock, type TauriMock } from "../../test/tauri-mock";
import { externalErrorCode, focusExternalAgent, listExternalAgents, machineCapacity, villageWeather } from "./villageIpc";
import type { ExternalAgentsReport, MachineCapacityWire, WeatherWire } from "./villageTypes";

const REPORT: ExternalAgentsReport = {
  agents: [
    {
      key: "a1b2",
      parentKey: null,
      title: "claude",
      folder: "gazelle",
      activity: "running",
      tool: "Edit",
      lastActivityMs: 1_790_000_000_000,
      alive: true,
      host: "iTerm2",
      language: "rust",
    },
  ],
  scannedAtMs: 1_790_000_000_500,
};

describe("listExternalAgents", () => {
  let ipc: TauriMock;
  beforeEach(() => {
    ipc = installTauriMock();
  });
  afterEach(() => {
    ipc.reset();
  });

  it("invokes list_external_agents with { activeWithinMins: null } by default", async () => {
    ipc.handle("list_external_agents", () => REPORT);
    await expect(listExternalAgents()).resolves.toEqual(REPORT);
    // `null`, not a missing key: Rust's Option sees None either way, but the pinned
    // object is what catches a rename of the key.
    expect(ipc.lastCall("list_external_agents")).toStrictEqual({ activeWithinMins: null });
  });

  it("sends the window by its camelCase name when given", async () => {
    ipc.handle("list_external_agents", () => REPORT);
    await listExternalAgents(30);
    expect(ipc.lastCall("list_external_agents")).toStrictEqual({ activeWithinMins: 30 });
  });

  it("passes a rejection through untouched", async () => {
    ipc.handle("list_external_agents", () => {
      throw "io: permission denied";
    });
    await expect(listExternalAgents()).rejects.toBe("io: permission denied");
  });
});

describe("focusExternalAgent", () => {
  let ipc: TauriMock;
  beforeEach(() => {
    ipc = installTauriMock();
  });
  afterEach(() => {
    ipc.reset();
  });

  it("invokes focus_external_agent with exactly { key }", async () => {
    ipc.handle("focus_external_agent", () => null);
    await expect(focusExternalAgent("0123456789abcdef")).resolves.toBeNull();
    expect(ipc.lastCall("focus_external_agent")).toStrictEqual({ key: "0123456789abcdef" });
  });

  it("passes a coded rejection through for externalErrorCode", async () => {
    ipc.handle("focus_external_agent", () => {
      throw "no-host: no app is known for that agent";
    });
    const err: unknown = await focusExternalAgent("k").catch((e: unknown) => e);
    expect(externalErrorCode(err)).toBe("no-host");
  });
});

describe("villageWeather", () => {
  let ipc: TauriMock;
  beforeEach(() => {
    ipc = installTauriMock();
  });
  afterEach(() => {
    ipc.reset();
  });

  const WEATHER: WeatherWire = {
    kind: "rain",
    intensity: 0.6,
    temperatureC: 18,
    wind: -0.3,
    sunriseMs: 1_790_000_000_000,
    sunsetMs: 1_790_040_000_000,
    place: "Tokyo",
    fetchedAtMs: 1_790_020_000_000,
  };

  it("invokes village_weather with exactly { timeZone }", async () => {
    ipc.handle("village_weather", () => WEATHER);
    await expect(villageWeather("Asia/Tokyo")).resolves.toEqual(WEATHER);
    expect(ipc.lastCall("village_weather")).toStrictEqual({ timeZone: "Asia/Tokyo" });
  });

  it("passes a coded rejection through for externalErrorCode", async () => {
    ipc.handle("village_weather", () => {
      throw "offline: dns lookup failed";
    });
    const err: unknown = await villageWeather("UTC").catch((e: unknown) => e);
    expect(err).toBe("offline: dns lookup failed");
    expect(externalErrorCode(err)).toBe("offline");
  });
});

describe("externalErrorCode", () => {
  it("reads the code head of a string rejection, dropping the detail", () => {
    expect(externalErrorCode("io: /Users/x/.claude/projects unreadable")).toBe("io");
    expect(externalErrorCode("No_Home")).toBe("no_home");
  });

  it("duck-types an Error-like value's message", () => {
    expect(externalErrorCode(new Error("scan_failed: boom"))).toBe("scan_failed");
    expect(externalErrorCode({ message: "timeout" })).toBe("timeout");
  });

  it("is `unknown` for anything that is not a code", () => {
    expect(externalErrorCode("invalid args `activeWithinMins` for command")).toBe("unknown");
    expect(externalErrorCode("")).toBe("unknown");
    expect(externalErrorCode(42)).toBe("unknown");
    expect(externalErrorCode(null)).toBe("unknown");
    expect(externalErrorCode({ message: 7 })).toBe("unknown");
  });
});

describe("machineCapacity", () => {
  let ipc: TauriMock;
  beforeEach(() => {
    ipc = installTauriMock();
  });
  afterEach(() => {
    ipc.reset();
  });

  const SAMPLE: MachineCapacityWire = {
    logicalCpus: 8,
    totalMemBytes: 16,
    availableMemBytes: 8,
    agents: null,
    sampledAtMs: 1,
  };

  it("invokes machine_capacity with no arguments and returns the sample as is", async () => {
    ipc.handle("machine_capacity", () => SAMPLE);
    await expect(machineCapacity()).resolves.toEqual(SAMPLE);
    expect(ipc.calls("machine_capacity")).toHaveLength(1);
  });

  it("passes a rejection through, for the hook to code", async () => {
    ipc.handle("machine_capacity", () => {
      throw "unsupported: no process table";
    });
    const err: unknown = await machineCapacity().catch((e: unknown) => e);
    expect(externalErrorCode(err)).toBe("unsupported");
  });
});
