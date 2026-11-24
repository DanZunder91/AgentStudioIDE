/**
 * The IPC seam, pinned: exact command names, no args, the event name, and that the
 * handler receives the batch payload (not the Tauri event envelope). The Rust side
 * matches these strings — a rename here without one there is a silent dead view.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: tauri.listen }));

import {
  logstreamClear,
  logstreamSnapshot,
  onLogstreamLines,
  syslogApps,
  syslogSet,
  syslogStatus,
} from "./logstreamIpc";
import type { LogLine, RunningApp, SyslogFilter, SyslogStatus } from "./agentLogsTypes";

beforeEach(() => {
  tauri.invoke.mockReset();
  tauri.listen.mockReset();
});

describe("logstreamIpc", () => {
  it("snapshot invokes `logstream_snapshot` with no args and returns the lines", async () => {
    const lines = [{ id: 1 }] as LogLine[];
    tauri.invoke.mockResolvedValue(lines);
    await expect(logstreamSnapshot()).resolves.toBe(lines);
    expect(tauri.invoke).toHaveBeenCalledWith("logstream_snapshot");
    expect(tauri.invoke.mock.calls[0]).toHaveLength(1);
  });

  it("clear invokes `logstream_clear` with no args", async () => {
    tauri.invoke.mockResolvedValue(undefined);
    await logstreamClear();
    expect(tauri.invoke).toHaveBeenCalledWith("logstream_clear");
    expect(tauri.invoke.mock.calls[0]).toHaveLength(1);
  });

  it("rejections pass through (the store shows them)", async () => {
    tauri.invoke.mockRejectedValue("boom");
    await expect(logstreamSnapshot()).rejects.toBe("boom");
  });

  it("subscribes to `logstream://lines` and unwraps the payload", async () => {
    const un = vi.fn();
    tauri.listen.mockResolvedValue(un);
    const handler = vi.fn();
    await expect(onLogstreamLines(handler)).resolves.toBe(un);
    expect(tauri.listen).toHaveBeenCalledWith("logstream://lines", expect.any(Function));
    const batch = [{ id: 7 }] as LogLine[];
    (tauri.listen.mock.calls[0][1] as (e: { payload: LogLine[] }) => void)({ payload: batch });
    expect(handler).toHaveBeenCalledWith(batch);
  });

  it("syslog status invokes `syslog_status` with no args", async () => {
    const status = { available: true } as SyslogStatus;
    tauri.invoke.mockResolvedValue(status);
    await expect(syslogStatus()).resolves.toBe(status);
    expect(tauri.invoke).toHaveBeenCalledWith("syslog_status");
    expect(tauri.invoke.mock.calls[0]).toHaveLength(1);
  });

  it("syslog set invokes `syslog_set` with `{ filter }` — the whole filter, not a patch", async () => {
    const filter: SyslogFilter = {
      enabled: true,
      apps: ["Demo"],
      subsystem: "com.example.demo",
      minLevel: "info",
      simulator: false,
      simulatorApps: null,
    };
    const status = { running: true } as SyslogStatus;
    tauri.invoke.mockResolvedValue(status);
    await expect(syslogSet(filter)).resolves.toBe(status);
    expect(tauri.invoke).toHaveBeenCalledWith("syslog_set", {
      filter: {
        enabled: true,
        apps: ["Demo"],
        subsystem: "com.example.demo",
        minLevel: "info",
        simulator: false,
        simulatorApps: null,
      },
    });
    expect(Object.keys(tauri.invoke.mock.calls[0][1] as object)).toEqual(["filter"]);
  });

  it("syslog apps invokes `syslog_apps` with no args", async () => {
    const apps = [{ name: "Xcode" }] as RunningApp[];
    tauri.invoke.mockResolvedValue(apps);
    await expect(syslogApps()).resolves.toBe(apps);
    expect(tauri.invoke).toHaveBeenCalledWith("syslog_apps");
    expect(tauri.invoke.mock.calls[0]).toHaveLength(1);
  });

  it("syslog rejections pass through", async () => {
    tauri.invoke.mockRejectedValue("no log binary");
    await expect(syslogSet({} as SyslogFilter)).rejects.toBe("no log binary");
    await expect(syslogApps()).rejects.toBe("no log binary");
  });
});
