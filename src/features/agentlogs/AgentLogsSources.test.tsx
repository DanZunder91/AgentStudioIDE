/** The Sources control over the real store; only the Tauri seam is mocked, so `syslog_set`
 * assertions are about the exact command and argument shape Rust receives. */

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => {
  const state = {
    status: null as unknown,
    statusError: null as unknown,
    apps: [] as unknown[],
    appsError: null as unknown,
    set: null as null | ((filter: unknown) => Promise<unknown>),
  };
  const invoke = vi.fn((cmd: string, args?: { filter: unknown }) => {
    if (cmd === "syslog_status") {
      return state.statusError === null ? Promise.resolve(state.status) : Promise.reject(state.statusError);
    }
    if (cmd === "syslog_apps") {
      return state.appsError === null ? Promise.resolve(state.apps) : Promise.reject(state.appsError);
    }
    if (cmd === "syslog_set") return (state.set as (f: unknown) => Promise<unknown>)(args?.filter);
    return Promise.resolve(undefined);
  });
  return { state, invoke };
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import { AgentLogsSources } from "./AgentLogsSources";
import { resetAgentLogsForTests, useAgentLogsStore } from "./agentLogsStore";
import type { RunningApp, SyslogFilter, SyslogStatus } from "./agentLogsTypes";

const FILTER = (p: Partial<SyslogFilter> = {}): SyslogFilter => ({
  enabled: false,
  apps: null,
  subsystem: null,
  minLevel: "default",
  simulator: false,
  simulatorApps: null,
  ...p,
});
const STATUS = (p: Partial<SyslogStatus> = {}): SyslogStatus => ({
  available: true,
  backend: "macos-unified-log",
  reason: null,
  running: false,
  filter: FILTER(),
  simulator: { available: false, reason: null, running: false },
  linesPerSec: 0,
  droppedPerSec: 0,
  ...p,
});
const APPS: RunningApp[] = [
  { name: "launchd", pids: [1], path: "/sbin/launchd", isApp: false },
  { name: "Demo", pids: [5, 6], path: "/Applications/Demo.app", isApp: true },
];

const settle = () =>
  act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
const sets = () =>
  tauri.invoke.mock.calls.filter((c) => c[0] === "syslog_set").map((c) => (c[1] as { filter: SyslogFilter }).filter);
const appCalls = () => tauri.invoke.mock.calls.filter((c) => c[0] === "syslog_apps").length;
const btn = (name: string | RegExp) => screen.getByRole("button", { name });
const box = (name: string) => screen.getByRole("checkbox", { name });

/** Load a status, render, and open the popover. */
async function open(status: SyslogStatus | null = STATUS()) {
  tauri.state.status = status;
  if (status !== null) await act(() => useAgentLogsStore.getState().refreshSyslogStatus());
  render(<AgentLogsSources />);
  fireEvent.click(btn("Log sources"));
  await settle();
}

beforeEach(() => {
  resetAgentLogsForTests();
  tauri.state.status = STATUS();
  tauri.state.statusError = null;
  tauri.state.apps = APPS;
  tauri.state.appsError = null;
  // Rust answers with the filter it applied.
  tauri.state.set = (filter) =>
    Promise.resolve(STATUS({ filter: filter as SyslogFilter, running: (filter as SyslogFilter).enabled }));
  tauri.invoke.mockClear();
});
afterEach(() => resetAgentLogsForTests());

describe("the popover", () => {
  it("opens and closes from the trigger, on Escape, and on an outside click (not an inside one)", async () => {
    await open();
    const trigger = btn("Log sources");
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const dialog = screen.getByRole("dialog", { name: "Log sources" });
    fireEvent.mouseDown(within(dialog).getByText("IDE terminals & agents"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Enter" });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(trigger);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(trigger);
    fireEvent.click(trigger);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("the IDE switch is client-side: it flips the store filter and never calls Rust", async () => {
    await open();
    fireEvent.click(box("IDE terminals & agents"));
    expect(useAgentLogsStore.getState().filter.ide).toBe(false);
    expect(box("IDE terminals & agents")).not.toBeChecked();
    expect(sets()).toEqual([]);
  });

  it("says it is checking before the first status lands", async () => {
    await open(null);
    expect(screen.getByText("Checking system apps logs…")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "System apps" })).toBeNull();
  });
});

describe("availability", () => {
  it("an unavailable backend shows its reason IN PLACE of the controls (no dead toggle)", async () => {
    await open(STATUS({ available: false, backend: null, reason: "Windows: system logs are not supported yet" }));
    expect(screen.getByTestId("syslog-unavailable")).toHaveTextContent(
      "System apps — Windows: system logs are not supported yet",
    );
    expect(screen.queryByRole("checkbox", { name: "System apps" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "Mac apps" })).toBeNull();
  });

  it("an unavailable backend with no reason still says so", async () => {
    await open(STATUS({ available: false, backend: "linux-journald", reason: null }));
    expect(screen.getByTestId("syslog-unavailable")).toHaveTextContent("System apps — not available on this system");
  });

  it("a partial reason is a subtle note beside working controls", async () => {
    await open(STATUS({ backend: "linux-journald", reason: "only your own journal — join systemd-journal for all" }));
    expect(screen.getByTestId("syslog-partial")).toHaveTextContent("only your own journal");
    expect(box("System apps")).toBeEnabled();
    expect(screen.queryByTestId("syslog-unavailable")).toBeNull();
  });

  it("no partial note when there is no reason", async () => {
    await open();
    expect(screen.queryByTestId("syslog-partial")).toBeNull();
  });

  it("macOS unified log: Mac apps + Subsystem", async () => {
    await open(STATUS({ filter: FILTER({ enabled: true, apps: ["x"] }) }));
    expect(box("Mac apps")).toBeChecked();
    expect(screen.getByRole("group", { name: "Mac apps" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Subsystem" })).toBeInTheDocument();
    expect(btn("Choose mac apps")).toBeInTheDocument();
  });

  it("journald: System apps + Systemd unit", async () => {
    await open(STATUS({ backend: "linux-journald", filter: FILTER({ enabled: true, apps: ["x"] }) }));
    expect(box("System apps")).toBeChecked();
    expect(screen.queryByRole("checkbox", { name: "Mac apps" })).toBeNull();
    expect(screen.getByRole("textbox", { name: "Systemd unit" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Subsystem" })).toBeNull();
  });

  it("Windows Event Log: System apps, a picker of Event Log sources, an Extra channel box, no volume notice", async () => {
    const PROVIDERS: RunningApp[] = [
      { name: "MsiInstaller", pids: [], path: null, isApp: true },
      { name: "Microsoft-Windows-WindowsUpdateClient", pids: [], path: null, isApp: false },
    ];
    tauri.state.apps = PROVIDERS;
    tauri.state.set = (filter) =>
      Promise.resolve(
        STATUS({ backend: "windows-eventlog", filter: filter as SyslogFilter, running: (filter as SyslogFilter).enabled }),
      );
    await open(STATUS({ backend: "windows-eventlog" }));
    fireEvent.click(box("System apps"));
    await settle();
    expect(sets()).toEqual([FILTER({ enabled: true })]);
    // The Event Log writes a few events a minute: the 150–500 lines/s warning would be false.
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "Mac apps" })).toBeNull();

    const picker = btn("Choose event log sources");
    expect(picker).toHaveTextContent("All Event Log sources ▾");
    expect(btn("Refresh the source list")).toHaveAttribute(
      "title",
      "Re-read the Event Log sources that wrote to Application and System recently",
    );
    fireEvent.click(picker);
    const rows = within(screen.getByRole("listbox")).getAllByRole("option");
    expect(rows.map((r) => r.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining("MsiInstaller"), expect.stringContaining("WindowsUpdateClient")]),
    );
    // A provider is not a process: no pid count on its row.
    expect(screen.getByRole("listbox").querySelector(".app-picker__count")).toBeNull();
    const msi = rows.find((r) => r.textContent?.includes("MsiInstaller")) as HTMLElement;
    fireEvent.click(within(msi).getByRole("button", { name: "Only" }));
    await settle();
    expect(sets()[1]).toEqual(FILTER({ enabled: true, apps: ["MsiInstaller"] }));

    const channel = screen.getByRole("textbox", { name: "Extra channel" });
    expect(channel).toHaveAttribute("placeholder", "Also read a channel, e.g. Microsoft-Windows-PowerShell/Operational");
    expect(screen.queryByRole("textbox", { name: "Systemd unit" })).toBeNull();
    fireEvent.change(channel, { target: { value: " Microsoft-Windows-PowerShell/Operational " } });
    fireEvent.keyDown(channel, { key: "Enter" });
    await settle();
    expect(sets()[2]).toEqual(
      FILTER({ enabled: true, apps: ["MsiInstaller"], subsystem: "Microsoft-Windows-PowerShell/Operational" }),
    );
  });
});

describe("system apps", () => {
  it("turning it on calls syslog_set with the exact whole filter, loads the app list, and warns once about All apps", async () => {
    await open();
    expect(screen.queryByRole("button", { name: "Choose mac apps" })).toBeNull(); // off: no picker
    fireEvent.click(box("Mac apps"));
    await settle();
    expect(sets()).toEqual([
      { enabled: true, apps: null, subsystem: null, minLevel: "default", simulator: false, simulatorApps: null },
    ]);
    expect(appCalls()).toBe(1);
    expect(box("Mac apps")).toBeChecked();
    const notice = screen.getByRole("status");
    expect(notice).toHaveTextContent("All apps is high volume — about 150–500 lines/s");
    expect(notice).toHaveTextContent("keeps the newest 20,000 lines");
    fireEvent.click(within(notice).getByRole("button", { name: "Got it" }));
    expect(screen.queryByRole("status")).toBeNull();

    // Off again: enabled false, nothing else changed; the controls go away.
    fireEvent.click(box("Mac apps"));
    await settle();
    expect(sets()[1]).toEqual(FILTER({ enabled: false }));
    expect(appCalls()).toBe(1); // turning OFF does not re-list
    expect(screen.queryByRole("button", { name: "Choose mac apps" })).toBeNull();
  });

  it("shows applying… while syslog_set is in flight", async () => {
    let resolve!: (s: unknown) => void;
    tauri.state.set = () => new Promise((r) => (resolve = r));
    await open();
    fireEvent.click(box("Mac apps"));
    await settle();
    expect(screen.getByText(/applying…/)).toBeInTheDocument();
    expect(box("Mac apps")).toBeChecked(); // the click reads as taken
    await act(async () => resolve(STATUS({ filter: FILTER({ enabled: true }) })));
    expect(screen.queryByText(/applying…/)).toBeNull();
  });

  it("the AppPicker lists syslog_apps (.app first, path sublabel, pid count); a pick → apps", async () => {
    await open(STATUS({ filter: FILTER({ enabled: true, apps: ["launchd"] }), running: true }));
    // Opening with the source on refreshed the list.
    expect(appCalls()).toBe(1);
    const picker = btn("Choose mac apps");
    expect(picker).toHaveTextContent("launchd");
    fireEvent.click(picker);
    const opts = within(screen.getByRole("listbox")).getAllByRole("option");
    expect(opts.map((o) => o.textContent)).toEqual([
      "All apps",
      "Demo/Applications/Demo.app2Only",
      "launchd/sbin/launchd1Only",
    ]);
    fireEvent.click(within(opts[1]).getByRole("button", { name: "Only" }));
    await settle();
    expect(sets()).toEqual([FILTER({ enabled: true, apps: ["Demo"] })]);
    expect(screen.queryByRole("status")).toBeNull(); // a pick is not high volume
  });

  it("choosing All sends apps: null and shows the volume warning", async () => {
    await open(STATUS({ filter: FILTER({ enabled: true, apps: ["launchd"] }) }));
    fireEvent.click(btn("Choose mac apps"));
    fireEvent.click(screen.getByRole("checkbox", { name: "All apps" }));
    await settle();
    expect(sets()).toEqual([FILTER({ enabled: true, apps: null })]);
    expect(screen.getByRole("status")).toHaveTextContent(/high volume/);
  });

  it("↻ re-reads the running apps; it is disabled while loading; a failure is shown", async () => {
    await open(STATUS({ filter: FILTER({ enabled: true, apps: ["x"] }) }));
    expect(appCalls()).toBe(1);
    let resolve!: (v: unknown) => void;
    tauri.invoke.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    fireEvent.click(btn("Refresh the app list"));
    expect(btn("Refresh the app list")).toBeDisabled();
    await act(async () => resolve(APPS));
    expect(btn("Refresh the app list")).toBeEnabled();
    tauri.state.appsError = "ps: permission denied";
    fireEvent.click(btn("Refresh the app list"));
    await settle();
    expect(screen.getByRole("alert")).toHaveTextContent("Could not list running apps: ps: permission denied");
  });

  it("opening the app picker re-reads the running apps", async () => {
    await open(STATUS({ filter: FILTER({ enabled: true, apps: ["x"] }) }));
    expect(appCalls()).toBe(1);
    fireEvent.click(btn("Choose mac apps"));
    await settle();
    expect(appCalls()).toBe(2);
  });

  it("opening with the source OFF does not list apps", async () => {
    await open();
    expect(appCalls()).toBe(0);
  });

  it("min level → syslog_set minLevel", async () => {
    await open(STATUS({ filter: FILTER({ enabled: true, apps: ["x"] }) }));
    const sel = screen.getByRole("combobox", { name: "Minimum level" });
    expect(sel).toHaveValue("default");
    expect(within(sel).getAllByRole("option").map((o) => (o as HTMLOptionElement).value)).toEqual([
      "debug",
      "info",
      "default",
      "error",
    ]);
    fireEvent.change(sel, { target: { value: "error" } });
    await settle();
    expect(sets()).toEqual([FILTER({ enabled: true, apps: ["x"], minLevel: "error" })]);
    expect(sel).toHaveValue("error");
  });

  it("subsystem applies on Enter (trimmed), not per keystroke; blur applies; unchanged is a no-op; blank → null", async () => {
    await open(STATUS({ filter: FILTER({ enabled: true, apps: ["x"] }) }));
    const sub = () => screen.getByRole("textbox", { name: "Subsystem" });
    fireEvent.change(sub(), { target: { value: "  com.example.demo " } });
    expect(sets()).toEqual([]);
    fireEvent.keyDown(sub(), { key: "a" });
    expect(sets()).toEqual([]);
    fireEvent.keyDown(sub(), { key: "Enter" });
    await settle();
    expect(sets()).toEqual([FILTER({ enabled: true, apps: ["x"], subsystem: "com.example.demo" })]);
    expect(sub()).toHaveValue("com.example.demo"); // re-keyed on the applied value
    fireEvent.blur(sub()); // unchanged
    expect(sets()).toHaveLength(1);
    fireEvent.change(sub(), { target: { value: "com.other" } });
    fireEvent.blur(sub());
    await settle();
    expect(sets()[1].subsystem).toBe("com.other");
    fireEvent.change(sub(), { target: { value: "   " } });
    fireEvent.keyDown(sub(), { key: "Enter" });
    await settle();
    expect(sets()[2].subsystem).toBeNull();
  });

  it("live lines/s, a dropped warning only when dropping, and Not running", async () => {
    await open(STATUS({ filter: FILTER({ enabled: true, apps: ["x"] }), running: true, linesPerSec: 41.6 }));
    expect(screen.getByText("42 lines/s")).toBeInTheDocument();
    expect(screen.queryByText(/dropping/)).toBeNull();
    expect(btn("Log sources")).toHaveTextContent("Sources · 42/s");
    expect(btn("Log sources")).toHaveAttribute("title", "Mac apps are streaming");
    await act(() => {
      tauri.state.status = STATUS({
        filter: FILTER({ enabled: true, apps: ["x"] }),
        running: true,
        linesPerSec: 500,
        droppedPerSec: 212.2,
      });
      return useAgentLogsStore.getState().refreshSyslogStatus();
    });
    expect(screen.getByText(/dropping 212 lines\/s — over the 500\/s cap/)).toBeInTheDocument();
    await act(() => {
      tauri.state.status = STATUS({ filter: FILTER({ enabled: true, apps: ["x"] }), running: false });
      return useAgentLogsStore.getState().refreshSyslogStatus();
    });
    expect(screen.getByText("Not running")).toBeInTheDocument();
    expect(btn("Log sources")).not.toHaveTextContent("/s");
  });

  it("the trigger shows no rate when the source is off", async () => {
    await open(STATUS({ running: true, linesPerSec: 9 }));
    expect(btn("Log sources")).not.toHaveTextContent("/s");
    expect(btn("Log sources")).toHaveAttribute("title", expect.stringMatching(/^Choose what this view streams/));
  });
});

describe("errors are surfaced, not swallowed", () => {
  it("a failed apply shows why in the popover and ⚠ on the trigger (title = the error)", async () => {
    tauri.state.set = () => Promise.reject("log: predicate is invalid");
    await open();
    fireEvent.click(box("Mac apps"));
    await settle();
    expect(screen.getByRole("alert")).toHaveTextContent("Could not apply the log sources: log: predicate is invalid");
    expect(box("Mac apps")).not.toBeChecked(); // back to what Rust has
    expect(btn("Log sources")).toHaveTextContent("⚠");
    expect(btn("Log sources")).toHaveAttribute("title", "Could not apply the log sources: log: predicate is invalid");
  });

  it("a failed status read with no status yet shows the error instead of 'Checking…'", async () => {
    tauri.state.statusError = "command syslog_status not found";
    await act(() => useAgentLogsStore.getState().refreshSyslogStatus());
    await open(null);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Could not read the system log status: command syslog_status not found",
    );
    expect(screen.queryByText(/Checking/)).toBeNull();
    expect(btn("Log sources")).toHaveTextContent("⚠");
  });

  it("no ⚠ when all is well", async () => {
    await open();
    expect(btn("Log sources")).not.toHaveTextContent("⚠");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("iOS Simulator", () => {
  it("is not rendered when no simulator is booted", async () => {
    await open();
    expect(screen.queryByRole("group", { name: "iOS Simulator" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "iOS Simulator" })).toBeNull();
  });

  it("when available: the toggle sends simulator, then a name box sends simulatorApps (blank = all)", async () => {
    const sim0 = { available: true, reason: null, running: false };
    tauri.state.set = (filter) => Promise.resolve(STATUS({ filter: filter as SyslogFilter, simulator: sim0 }));
    await open(STATUS({ simulator: sim0 }));
    const sim = box("iOS Simulator");
    expect(sim).not.toBeChecked();
    expect(screen.queryByRole("textbox", { name: "Simulator apps" })).toBeNull();
    fireEvent.click(sim);
    await settle();
    expect(sets()).toEqual([FILTER({ simulator: true })]);
    const names = screen.getByRole("textbox", { name: "Simulator apps" });
    expect(names).toHaveValue("");
    fireEvent.change(names, { target: { value: "MyApp, SpringBoard" } });
    fireEvent.keyDown(names, { key: "Enter" });
    await settle();
    expect(sets()[1]).toEqual(FILTER({ simulator: true, simulatorApps: ["MyApp", "SpringBoard"] }));
    expect(screen.getByRole("textbox", { name: "Simulator apps" })).toHaveValue("MyApp, SpringBoard");
    fireEvent.change(screen.getByRole("textbox", { name: "Simulator apps" }), { target: { value: "" } });
    fireEvent.blur(screen.getByRole("textbox", { name: "Simulator apps" }));
    await settle();
    expect(sets()[2].simulatorApps).toBeNull();
  });

  it("shows its reason and 'streaming' when running", async () => {
    await open(
      STATUS({
        filter: FILTER({ simulator: true }),
        simulator: { available: true, reason: "Example Phone · iOS 1.0", running: true },
      }),
    );
    const group = screen.getByRole("group", { name: "iOS Simulator" });
    expect(group).toHaveTextContent("Example Phone · iOS 1.0");
    expect(group).toHaveTextContent("streaming");
    expect(box("iOS Simulator")).toBeChecked(); // the note is not part of the toggle's name
  });

  it("no 'streaming' when not running", async () => {
    await open(STATUS({ simulator: { available: true, reason: null, running: false } }));
    expect(screen.getByRole("group", { name: "iOS Simulator" })).not.toHaveTextContent("streaming");
  });
});
