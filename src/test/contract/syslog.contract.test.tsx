/**
 * SEAM TEST — Agent Logs · system apps. Not a unit test.
 *
 * Everything fed in was produced by REAL Rust (`src-tauri/tests/contract_goldens/machine.rs`):
 * the `log stream --style ndjson` / `journalctl --output=json` fixtures through the production
 * parsers and a real `LogHub` (with its 500/s cap and drop line), `SyslogStatus` values built by
 * `syslog::status_of` over real backends and real supervised children, and `RunningApp[]` from
 * the real grouping. Only `invoke` / `listen` are mocked; `logstreamIpc` → `agentLogsStore` →
 * `AgentLogsPanel` / `AgentLogsSources` / `AppPicker` are the real ones.
 *
 * Expected strings are written by hand, never derived from the golden.
 */

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => {
  const state = {
    snapshot: [] as unknown[],
    status: null as unknown,
    apps: [] as unknown[],
    setAnswer: null as unknown,
    handler: null as null | ((e: { payload: unknown }) => void),
  };
  const invoke = vi.fn((cmd: string, _args?: Record<string, unknown>) => {
    if (cmd === "logstream_snapshot") return Promise.resolve(state.snapshot);
    if (cmd === "syslog_status") return Promise.resolve(state.status);
    if (cmd === "syslog_apps") return Promise.resolve(state.apps);
    if (cmd === "syslog_set") return Promise.resolve(state.setAnswer);
    return Promise.reject(new Error(`not part of this contract test: ${cmd}`));
  });
  const listen = vi.fn((name: string, cb: (e: { payload: unknown }) => void) => {
    if (name === "logstream://lines") state.handler = cb;
    return Promise.resolve(() => {});
  });
  return { state, invoke, listen };
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: tauri.listen }));
vi.mock("../../features/terminal", () => ({ configureTerminal: vi.fn(), dispose: vi.fn() }));

import { AgentLogsPanel } from "../../features/agentlogs/AgentLogsPanel";
import { resetAgentLogsForTests } from "../../features/agentlogs/agentLogsStore";
import type { SyslogFilter } from "../../features/agentlogs/agentLogsTypes";
import { resetStore } from "../store-harness";
import { SYSLOG_APPS, SYSLOG_LINES, SYSLOG_STATUS, type SyslogStatusState } from "./goldens";

const settle = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });

async function mount(state: SyslogStatusState, lines = SYSLOG_LINES): Promise<void> {
  tauri.state.snapshot = lines;
  tauri.state.status = SYSLOG_STATUS[state];
  tauri.state.apps = SYSLOG_APPS;
  render(<AgentLogsPanel />);
  await settle();
}

async function openSources(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole("button", { name: "Log sources" }));
  await settle();
  return screen.getByRole("dialog", { name: "Log sources" });
}

/** Every stream entry's id: machine lines are raw rows; the hub's own `system` line is a divider. */
const ids = () =>
  [...document.querySelectorAll<HTMLElement>('[data-testid="alog-row"], [data-testid="alog-divider"]')].map((r) => Number(r.dataset.id));
const rowById = (id: number) => document.querySelector(`[data-testid="alog-row"][data-id="${id}"]`) as HTMLElement;
const dividerById = (id: number) => document.querySelector(`[data-testid="alog-divider"][data-id="${id}"]`) as HTMLElement;
const textOf = (id: number) => (rowById(id).querySelector(".alog-text") as HTMLElement).textContent;
const badgeOf = (id: number) => (rowById(id).querySelector(".alog-badge") as HTMLElement).textContent;
const sourceEl = (id: number) => rowById(id).querySelector(".alog-src") as HTMLElement;
const subsystemOf = (id: number) => rowById(id).querySelector(".alog-hl--subsystem")?.textContent ?? null;
const sets = () =>
  tauri.invoke.mock.calls.filter((c) => c[0] === "syslog_set").map((c) => (c[1] as unknown as { filter: SyslogFilter }).filter);

beforeEach(() => {
  resetAgentLogsForTests();
  resetStore();
  tauri.state.handler = null;
  tauri.state.setAnswer = null;
  vi.clearAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
  resetAgentLogsForTests();
});

describe("machine rows: what the real parsers + hub produced, as the user sees it", () => {
  it("13 entries — 12 system-app lines as raw rows (no marker) and the hub's own rate-limit line at id 501 as a divider", async () => {
    await mount("macos-running-picked");
    expect(ids()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 501]);
    // [id, badge, source, rendered text, highlighted leading subsystem]
    const want: [number, string, string, string, string | null][] = [
      [1, "I", "ExampleApp", "[com.example.app:Network] request finished; calling completion handler", "[com.example.app:Network]"],
      [2, "I", "exampled", "idle tick: count=0", null], // no subsystem, no category: the bare message
      [3, "E", "ExampleApp", "[com.example.app] could not open the example database", "[com.example.app]"],
      [4, "E", "exampled", "[lifecycle] assertion failed: state == ready", "[lifecycle]"], // Fault → error
      [5, "D", "ExampleApp", "[com.example.app:UI] layout pass 1", "[com.example.app:UI]"], // multi-line: first line
      [6, "I", "Simulator · ExampleApp", "[com.example.app:Network] request finished; calling completion handler", "[com.example.app:Network]"],
      [7, "I", "example-daemon", "listening on port 8080", null], // journald PRIORITY 6
      [8, "E", "example-daemon", "connection refused", null], // 3
      [9, "W", "example-cron", "job took longer than expected", null], // 4, SYSLOG_IDENTIFIER as source
      [10, "D", "example-daemon", "bytes ✓", null], // 7, MESSAGE sent as a byte array
      [11, "E", "kernelish", "emergency", null], // 0
      [12, "I", "journal", "no priority, no comm", null],
    ];
    for (const [id, badge, source, text, sub] of want) {
      expect([badgeOf(id), sourceEl(id).textContent, textOf(id), subsystemOf(id)], `line ${id}`).toEqual([badge, source, text, sub]);
    }
    for (let id = 1; id <= 12; id++) expect(rowById(id).className, `line ${id}`).toContain("alog-row--kind-machine");
    // The hub's warning is a `system` line: a warn-coloured divider naming its source, not a log row.
    expect(rowById(501)).toBeNull();
    expect(dividerById(501).className).toContain("alog-divider--warn");
    expect(dividerById(501).querySelector(".alog-divider__src")).toHaveTextContent("logs");
    expect(dividerById(501)).toHaveTextContent("… 7 system-app lines dropped (rate limit)");
  });

  it("a machine source is plain text titled with its detail (image · pid · subsystem) — never a dead link", async () => {
    await mount("macos-running-picked");
    expect(within(rowById(1)).queryByRole("button")).toBeNull();
    expect(sourceEl(1)).toHaveAttribute(
      "title",
      "ExampleApp — /Applications/ExampleApp.app/Contents/MacOS/ExampleApp · pid 1234 · com.example.app:Network",
    );
    expect(sourceEl(8)).toHaveAttribute("title", "example-daemon — pid 4242");
    expect(sourceEl(9)).toHaveAttribute("title", "example-cron — an app on this computer");
  });

  it("clicking the multi-line line opens its detail with the whole message", async () => {
    await mount("macos-running-picked");
    fireEvent.click(rowById(5));
    const detail = screen.getByTestId("alog-detail");
    expect(within(detail).getByText("machine")).toBeInTheDocument();
    expect((detail.querySelector(".alog-detail__more") as HTMLElement).textContent).toBe(
      "/Applications/ExampleApp.app/Contents/MacOS/ExampleApp · pid 1234 · com.example.app:UI\nlayout pass 1\nlayout pass 2",
    );
    fireEvent.click(rowById(10));
    expect((screen.getByTestId("alog-detail").querySelector(".alog-detail__more") as HTMLElement).textContent).toBe(
      "pid 4242\nbytes ✓\nsecond line",
    );
  });

  it("the sidebar groups the streaming apps under a heading named from the backend: `Mac apps` on macOS", async () => {
    await mount("macos-running-picked");
    const group = screen.getByRole("group", { name: "Mac apps" });
    // Running sources in the order they were first seen — by the hub's timestamp: exampled's
    // first line (…653) precedes ExampleApp's (…659); three sources share …659 and keep id order.
    expect(within(group).getAllByTestId("alog-src-row").map((r) => r.dataset.source)).toEqual([
      "exampled",
      "ExampleApp",
      "Simulator · ExampleApp",
      "example-daemon",
      "example-cron",
      "kernelish",
      "journal",
    ]);
    // A row is that app's stream alone.
    fireEvent.click(within(group).getAllByRole("button")[0]);
    expect(ids()).toEqual([2, 4]);
  });

  it("…and `System apps` for journald", async () => {
    await mount("linux-partial");
    expect(screen.getByRole("group", { name: "System apps" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Mac apps" })).toBeNull();
  });

  it("IDE terminals & agents off keeps only the machine lines (the hub's drop line is an IDE line)", async () => {
    await mount("macos-running-picked");
    const pop = await openSources();
    fireEvent.click(within(pop).getByRole("checkbox", { name: "IDE terminals & agents" }));
    expect(ids()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it("level chips over machine levels: Error alone leaves the Error, the Fault, journald 3 and 0", async () => {
    await mount("macos-running-picked");
    for (const name of ["Warn", "Info", "Debug"]) fireEvent.click(screen.getByRole("button", { name }));
    expect(ids()).toEqual([3, 4, 8, 11]);
  });

  it("a logstream://lines batch of machine lines appends like any other", async () => {
    await mount("macos-running-picked", SYSLOG_LINES.slice(0, 5));
    const h = tauri.state.handler as (e: { payload: unknown }) => void;
    act(() => h({ payload: SYSLOG_LINES.slice(3) }));
    expect(ids()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 501]);
  });
});

describe("the Sources popover renders every real SyslogStatus state", () => {
  it("macOS, running, two apps picked, over the cap: rate on the trigger, the dropped warning, the pick", async () => {
    await mount("macos-running-picked");
    expect(screen.getByRole("button", { name: "Log sources" })).toHaveTextContent("Sources · 500/s ▾");
    const pop = await openSources();
    const section = within(pop).getByRole("group", { name: "Mac apps" });
    expect(within(section).getByRole("checkbox", { name: "Mac apps" })).toBeChecked();
    expect(within(section).queryByTestId("syslog-partial")).toBeNull();
    expect(within(section).getByRole("button", { name: "Choose mac apps" })).toHaveTextContent("2 apps ▾");
    expect(within(section).getByRole("combobox")).toHaveValue("info");
    expect(within(section).getByRole("textbox", { name: "Subsystem" })).toHaveValue("com.example.app");
    expect(section.querySelector(".alog-srcs__stats")).toHaveTextContent(
      "500 lines/s ⚠ dropping 7 lines/s — over the 500/s cap; pick apps or raise the level",
    );
    // No booted simulator → no simulator section at all (never a dead toggle).
    expect(within(pop).queryByRole("group", { name: "iOS Simulator" })).toBeNull();
  });

  it("the AppPicker lists syslog_apps as Rust grouped them: .app bundles first, path, pid count, the pick checked", async () => {
    await mount("macos-running-picked");
    const pop = await openSources();
    fireEvent.click(within(pop).getByRole("button", { name: "Choose mac apps" }));
    await settle();
    const opts = within(screen.getByRole("listbox")).getAllByRole("option").slice(1); // row 0 is "All apps"
    const read = (li: HTMLElement) => [
      li.querySelector(".app-picker__label")?.textContent,
      li.querySelector(".app-picker__sub")?.textContent ?? null,
      li.querySelector(".app-picker__count")?.textContent,
      li.getAttribute("aria-selected"),
    ];
    expect(opts.map(read)).toEqual([
      ["Mail", "/System/Applications/Mail.app/Contents/MacOS/Mail", "1", "true"],
      ["Safari", "/Applications/Safari.app/Contents/MacOS/Safari", "2", "true"],
      ["Xcode", "/Applications/Xcode.app/Contents/MacOS/Xcode", "1", "false"],
      ["bash", "/bin/bash", "1", "false"],
      ["exampled", "/usr/libexec/exampled", "1", "false"],
      ["launchd_sim", null, "1", "false"],
      ["zsh", "/bin/zsh", "2", "false"],
    ]);
  });

  it("a pick goes back to Rust as a whole SyslogFilter with exactly the wire keys; Rust's answer is shown", async () => {
    await mount("macos-all-apps");
    const pop = await openSources();
    expect(within(pop).getByRole("button", { name: "Choose mac apps" })).toHaveTextContent("All apps ▾");
    expect(pop.querySelector(".alog-srcs__stats")).toHaveTextContent("212 lines/s");
    expect(pop.querySelector(".alog-srcs__dropped")).toBeNull();
    tauri.state.setAnswer = SYSLOG_STATUS["macos-running-picked"];
    fireEvent.click(within(pop).getByRole("button", { name: "Choose mac apps" }));
    await settle();
    const safari = within(screen.getByRole("listbox")).getAllByRole("option").find((o) => o.textContent?.includes("Safari")) as HTMLElement;
    fireEvent.click(within(safari).getByRole("button", { name: "Only" }));
    await settle();
    expect(sets()).toEqual([
      { enabled: true, apps: ["Safari"], subsystem: null, minLevel: "default", simulator: false, simulatorApps: null },
    ]);
    // Key for key the filter Rust itself serialised (so its `deny`-free serde default never hides a typo).
    expect(Object.keys(sets()[0]).sort()).toEqual(Object.keys(SYSLOG_STATUS["macos-all-apps"].filter).sort());
    expect(within(pop).getByRole("button", { name: "Choose mac apps" })).toHaveTextContent("2 apps ▾");
  });

  it("Linux, partial visibility: `System apps`, the reason, a Systemd unit box, a pick Rust names but the list lacks", async () => {
    await mount("linux-partial");
    const pop = await openSources();
    const section = within(pop).getByRole("group", { name: "System apps" });
    expect(within(section).getByTestId("syslog-partial")).toHaveTextContent(
      "Only your own journal is visible — add yourself to the `systemd-journal` group to see every app's logs.",
    );
    expect(within(section).getByRole("textbox", { name: "Systemd unit" })).toHaveValue("nginx.service");
    expect(within(section).getByRole("combobox")).toHaveValue("error");
    expect(within(section).getByRole("button", { name: "Choose system apps" })).toHaveTextContent("nginx ▾");
    expect(section.querySelector(".alog-srcs__stats")).toHaveTextContent("3 lines/s");
  });

  it.each([
    ["linux-no-journald", "System apps — journald isn't running on this machine (a container?), so there are no system logs to read."],
    ["other-os-unavailable", "System apps — System app logs aren't supported on this operating system."],
  ] as const)("%s: the reason in place of the control", async (state, text) => {
    await mount(state);
    const pop = await openSources();
    expect(within(pop).getByTestId("syslog-unavailable")).toHaveTextContent(text);
    expect(within(pop).queryByRole("checkbox", { name: "System apps" })).toBeNull();
  });

  it("Windows Event Log, running: `System apps`, Event Log sources picked, the extra channel, the error floor", async () => {
    await mount("windows-eventlog");
    expect(screen.getByRole("button", { name: "Log sources" })).toHaveTextContent("Sources · 2/s ▾");
    const pop = await openSources();
    const section = within(pop).getByRole("group", { name: "System apps" });
    expect(within(section).getByRole("checkbox", { name: "System apps" })).toBeChecked();
    expect(within(section).queryByTestId("syslog-partial")).toBeNull();
    expect(within(section).getByRole("button", { name: "Choose event log sources" })).toHaveTextContent(
      "2 Event Log sources ▾",
    );
    expect(within(section).getByRole("textbox", { name: "Extra channel" })).toHaveValue(
      "Microsoft-Windows-PowerShell/Operational",
    );
    expect(within(section).getByRole("combobox")).toHaveValue("error");
    expect(section.querySelector(".alog-srcs__stats")).toHaveTextContent("2 lines/s");
  });

  it("macOS, the child died: `Not running`, Rust's exit reason (status + stderr tail), no rate on the trigger", async () => {
    await mount("macos-child-exited");
    expect(screen.getByRole("button", { name: "Log sources" })).toHaveTextContent("Sources ▾");
    const pop = await openSources();
    expect(within(pop).getByTestId("syslog-partial")).toHaveTextContent(
      "System apps log stream stopped (exit code 64): log: Cannot open the log store: Operation not permitted",
    );
    expect(pop.querySelector(".alog-srcs__stats")).toHaveTextContent("Not running");
  });

  it("a child that dies while the panel is open is picked up by the 2 s status poll", async () => {
    vi.useFakeTimers();
    await mount("macos-all-apps");
    tauri.state.status = SYSLOG_STATUS["macos-child-exited"];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    const pop = await openSources();
    expect(within(pop).getByTestId("syslog-partial")).toHaveTextContent("System apps log stream stopped (exit code 64)");
  });

  it("simulator booted and streaming: its section, `streaming`, the name list as Rust holds it", async () => {
    await mount("macos-simulator-streaming");
    const pop = await openSources();
    const sim = within(pop).getByRole("group", { name: "iOS Simulator" });
    expect(within(sim).getByRole("checkbox", { name: "iOS Simulator" })).toBeChecked();
    expect(within(sim).getByText("streaming")).toBeInTheDocument();
    expect(within(sim).getByRole("textbox", { name: "Simulator apps" })).toHaveValue("SpringBoard, ExampleApp");
    expect(within(pop).getByRole("checkbox", { name: "Mac apps" })).not.toBeChecked();
  });

  it("simulator stream exited: its reason, not `streaming`", async () => {
    await mount("macos-simulator-exited");
    const pop = await openSources();
    const sim = within(pop).getByRole("group", { name: "iOS Simulator" });
    expect(within(sim).queryByText("streaming")).toBeNull();
    expect(sim).toHaveTextContent(
      "iOS Simulator log stream stopped (exit code 64): log: Cannot open the log store: Operation not permitted",
    );
  });
});
