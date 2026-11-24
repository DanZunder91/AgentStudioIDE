/**
 * SEAM TEST — Network · whole computer. Not a unit test.
 *
 * The samples and statuses fed in were produced by REAL Rust
 * (`src-tauri/tests/contract_goldens/machine.rs`): the nettop fixture through the real
 * `NetMachine` sampler (splitter → parser → rate tracker; the second sample has rates), and
 * synthetic `/proc/net/*` + `ss -tinH` text through the real Linux parsers, `assemble` and the
 * rate tracker with a real reverse-DNS cache. Only `invoke` / `listen` are mocked; `netmachineIpc`
 * → `machineStore` → `NetworkPanel` / `MachineView` / `machineFormat` / `AppPicker` are real.
 *
 * Every expected string is written out by hand.
 */

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => {
  const handlers = new Map<string, (e: { payload: unknown }) => void>();
  const answers = new Map<string, () => unknown>();
  const invoke = vi.fn((cmd: string) => {
    const answer = answers.get(cmd);
    if (!answer) return Promise.reject(new Error(`not part of this contract test: ${cmd}`));
    return Promise.resolve().then(answer);
  });
  const listen = vi.fn((name: string, cb: (e: { payload: unknown }) => void) => {
    handlers.set(name, cb);
    return Promise.resolve(() => handlers.delete(name));
  });
  return { handlers, answers, invoke, listen };
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: tauri.listen }));

import { NO_BYTES_TITLE, NO_RATE_TITLE, OTHER_USER_TITLE } from "../../features/network/machineFormat";
import { resetMachineStore } from "../../features/network/machineStore";
import { NetworkPanel } from "../../features/network/NetworkPanel";
import { resetNetworkStore } from "../../features/network/networkStore";
import type { MachineStatus } from "../../features/network/networkTypes";
import { resetStore } from "../store-harness";
import { MACHINE_SAMPLES, MACHINE_STATUS, STATUS, type MachineSampleScenario } from "./goldens";

const settle = async () => {
  for (let i = 0; i < 6; i++) await act(async () => {});
};

/** `status` answers netmachine_status; `started` answers netmachine_start (the running state). */
async function mount(status: MachineStatus, started: MachineStatus = status): Promise<void> {
  tauri.answers.set("netcap_snapshot", () => []);
  tauri.answers.set("netcap_status", () => STATUS.default);
  tauri.answers.set("netmachine_status", () => status);
  tauri.answers.set("netmachine_start", () => started);
  tauri.answers.set("netmachine_stop", () => ({ ...started, running: false }));
  render(<NetworkPanel />);
  await settle();
}

async function enterMachineMode(label: string): Promise<void> {
  fireEvent.click(within(screen.getByRole("group", { name: "Network mode" })).getByRole("button", { name: label }));
  await settle();
}

/** Rust's `netmachine://sample`, through the real subscription. */
function emit(scenario: MachineSampleScenario): void {
  const h = tauri.handlers.get("netmachine://sample");
  if (!h) throw new Error("the store never subscribed to netmachine://sample");
  act(() => h({ payload: MACHINE_SAMPLES[scenario] }));
}

const title = () => screen.getByTestId("netm-title").textContent;
const appKeys = () => screen.getAllByTestId("netm-row").map((r) => r.dataset.appKey);
const appRow = (key: string) => document.querySelector(`[data-app-key="${key}"]`) as HTMLElement;
const cellsOf = (el: HTMLElement) => Array.from(el.children).map((c) => c.textContent);
function connRows(app: string): HTMLElement[] {
  const t = screen.getByRole("table", { name: `${app} connections` });
  return within(t).getAllByTestId("netm-conn");
}

beforeEach(() => {
  resetStore();
  resetNetworkStore();
  resetMachineStore();
  tauri.handlers.clear();
  tauri.answers.clear();
  vi.clearAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
  resetMachineStore();
  resetNetworkStore();
});

describe("the mode switch is labelled from the backend Rust reports", () => {
  it.each([
    ["macos-idle", "Whole Mac"],
    ["linux-partial-running", "Whole computer"],
    ["windows-idle", "Whole computer"],
    ["other-os-unavailable", "Whole computer"],
    ["macos-nettop-missing", "Whole Mac"],
  ] as const)("%s → %s", async (state, label) => {
    await mount(MACHINE_STATUS[state]);
    const group = screen.getByRole("group", { name: "Network mode" });
    expect(within(group).getAllByRole("button").map((b) => b.textContent)).toEqual(["IDE traffic", label]);
  });
});

describe("macOS: the real nettop sampler's two samples", () => {
  it("entering the mode listens, starts, and the first sample's rates read `—` titled as NOT YET (not a blind backend)", async () => {
    await mount(MACHINE_STATUS["macos-idle"], MACHINE_STATUS["macos-running"]);
    await enterMachineMode("Whole Mac");
    expect(tauri.invoke.mock.calls.filter((c) => c[0] === "netmachine_start")).toHaveLength(1);
    emit("macos-first");
    expect(title()).toBe("Whole Mac — 10 apps · 22 connections · ↓ — ↑ —");
    const cells = Array.from(appRow("ide:230").children) as HTMLElement[];
    expect(cells.map((c) => c.textContent)).toEqual(["▸ ide", "230", "10", "—", "—", "1.5MB", "5.0MB"]);
    // nettop always sees bytes — a null rate here only means "one sample so far".
    expect(cells[3]).toHaveAttribute("title", NO_RATE_TITLE);
    expect(cells[4]).toHaveAttribute("title", NO_RATE_TITLE);
    expect(cells[5]).not.toHaveAttribute("title");
  });

  it("the second sample: rates, the default rate-desc order, Hide listeners on (mDNS-only pushd hidden)", async () => {
    await mount(MACHINE_STATUS["macos-idle"], MACHINE_STATUS["macos-running"]);
    await enterMachineMode("Whole Mac");
    emit("macos-first");
    emit("macos-second");
    expect(title()).toBe("Whole Mac — 10 apps · 22 connections · ↓ 50B/s ↑ 80B/s");
    expect(appKeys()).toEqual([
      "ide:230",
      "cloudd:250",
      "kernel_task:190",
      "mdnsd:150", // no sockets listed at all: kept (traffic without a socket list)
      "Music Helper:120",
      "netd:160",
      "sharingd:200",
      "syncd:140",
      "timed:210",
      "updaterd:170",
    ]);
    expect(cellsOf(appRow("ide:230"))).toEqual(["▸ ide", "230", "10", "50B/s", "80B/s", "1.5MB", "5.0MB"]);
    expect(cellsOf(appRow("cloudd:250"))).toEqual(["▸ cloudd", "250", "4", "0B/s", "0B/s", "42.0KB", "36.1KB"]);
    // nettop has no user column: never dimmed.
    expect(appRow("ide:230")).not.toHaveClass("netm-row--other");
    expect(screen.queryByTestId("netm-partial")).toBeNull();
  });

  it("Hide listeners off shows every socket Rust sent, including the unconnected-UDP-only apps", async () => {
    await mount(MACHINE_STATUS["macos-idle"], MACHINE_STATUS["macos-running"]);
    await enterMachineMode("Whole Mac");
    emit("macos-second");
    fireEvent.click(screen.getByRole("switch", { name: "Hide listeners" }));
    expect(title()).toBe("Whole Mac — 16 apps · 42 connections · ↓ 3.0KB/s ↑ 880B/s");
    expect(appKeys()[0]).toBe("pushd:180");
    expect(cellsOf(appRow("pushd:180"))).toEqual(["▸ pushd", "180", "2", "2.9KB/s", "800B/s", "66.8MB", "20.4MB"]);
  });

  it("expanding an app: its connections as Rust formatted them (IPv6 bracketed with scope, listeners hidden)", async () => {
    await mount(MACHINE_STATUS["macos-idle"], MACHINE_STATUS["macos-running"]);
    await enterMachineMode("Whole Mac");
    emit("macos-second");
    fireEvent.click(appRow("sharingd:200"));
    expect(appRow("sharingd:200")).toHaveAttribute("aria-selected", "true");
    expect(appRow("sharingd:200")).toHaveAttribute("aria-expanded", "true");
    expect(connRows("sharingd").map(cellsOf)).toEqual([
      ["tcp6", "[fe80::1%en0]:50500", "[fe80::2%en0]:50501", "Established", "13.7KB", "7.2KB"],
    ]);
    fireEvent.click(screen.getByRole("switch", { name: "Hide listeners" }));
    expect(connRows("sharingd").map(cellsOf)).toEqual([
      ["tcp6", "[fe80::1%en0]:50500", "[fe80::2%en0]:50501", "Established", "13.7KB", "7.2KB"],
      ["tcp6", "*:50500", "—", "Listen", "0B", "0B"],
      ["tcp4", "*:50500", "—", "Listen", "0B", "0B"],
      ["udp6", "*:50502", "—", "—", "0B", "8B"], // QUIC/UDP: no state → `—`
    ]);
  });

  it("the AppPicker offers every app name with its socket count; Only narrows the table", async () => {
    await mount(MACHINE_STATUS["macos-idle"], MACHINE_STATUS["macos-running"]);
    await enterMachineMode("Whole Mac");
    emit("macos-second");
    fireEvent.click(screen.getByRole("button", { name: "Filter by app" }));
    const opts = within(screen.getByRole("listbox")).getAllByRole("option").slice(1);
    const read = (li: HTMLElement) =>
      `${li.querySelector(".app-picker__label")?.textContent}=${li.querySelector(".app-picker__count")?.textContent}`;
    expect(opts.map(read)).toEqual([
      // Names resolved from the pid's executable, not nettop's truncation.
      "Browser Helper (Renderer)=3",
      "Chat Helper=1",
      "claude 2.1.0=1", // `…/claude/versions/2.1.0` → `claude 2.1.0`
      "cloudd=5",
      "dbserver=2",
      "ide=14",
      "identityd=1",
      "kernel_task=3",
      "mdnsd=0",
      "Music Helper=3",
      "netd=0",
      "pushd=2",
      "sharingd=4",
      "syncd=1",
      "timed=2",
      "updaterd=0",
    ]);
    fireEvent.click(within(opts[5]).getByRole("button", { name: "Only" }));
    expect(title()).toBe("Whole Mac — 1 of 10 apps · 10 connections · ↓ 50B/s ↑ 80B/s");
    expect(appKeys()).toEqual(["ide:230"]);
  });

  it(
    "SEAM: a sampler that dies while the view is open says why — Rust records the reason in " +
      "`netmachine_status` (running:false, reason) but emits nothing, and machineStore reads the status only " +
      "on start/stop, so the table silently freezes on the last sample (contrast: the Logs view polls syslog_status every 2 s)",
    async () => {
      vi.useFakeTimers();
      await mount(MACHINE_STATUS["macos-idle"], MACHINE_STATUS["macos-running"]);
      await enterMachineMode("Whole Mac");
      emit("macos-second");
      // The nettop child exits: from now on Rust answers the died state.
      tauri.answers.set("netmachine_status", () => MACHINE_STATUS["macos-died"]);
      tauri.answers.set("netmachine_start", () => MACHINE_STATUS["macos-died"]);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(screen.getByTestId("netm-partial")).toHaveTextContent("nettop stopped unexpectedly (exit status: 1).");
    },
  );
});

describe("Linux: /proc/net + ss through the real parsers", () => {
  it("the partial-visibility reason, `Whole computer`, grouped rows with rates, other-user dimmed", async () => {
    await mount(MACHINE_STATUS["linux-partial-running"]);
    await enterMachineMode("Whole computer");
    emit("linux-first");
    emit("linux-second");
    expect(screen.getByTestId("netm-partial")).toHaveTextContent(
      "Other users' connections are listed without a process — naming them needs root.",
    );
    expect(title()).toBe("Whole computer — 3 apps · 4 connections · ↓ 19.5KB/s ↑ 1.5KB/s");
    expect(appKeys()).toEqual(["node:4242", "no process:0", "other user:0"]);
    expect(cellsOf(appRow("node:4242"))).toEqual(["▸ node", "4242", "2", "19.5KB/s", "1000B/s", "112.7KB", "2.7KB"]);
    expect(cellsOf(appRow("no process:0"))).toEqual(["▸ no process", "—", "1", "0B/s", "0B/s", "0B", "0B"]);
    const other = appRow("other user:0");
    expect(cellsOf(other)).toEqual(["▸ other user", "—", "1", "0B/s", "500B/s", "2.0KB", "1.3KB"]);
    expect(other).toHaveClass("netm-row--other");
    expect(other).toHaveAttribute("title", OTHER_USER_TITLE);
    expect(other.children[1]).toHaveAttribute("title", "Unknown process");
    expect(appRow("node:4242")).not.toHaveClass("netm-row--other");
  });

  it("expanded: `host (ip:port)` from the reverse-DNS cache, IPv6 in brackets, UDP `—` bytes titled as blind", async () => {
    await mount(MACHINE_STATUS["linux-partial-running"]);
    await enterMachineMode("Whole computer");
    emit("linux-second");
    fireEvent.click(screen.getByRole("switch", { name: "Hide listeners" }));
    fireEvent.click(appRow("node:4242"));
    const rows = connRows("node");
    expect(rows.map(cellsOf)).toEqual([
      ["tcp4", "127.0.0.1:3000", "—", "Listen", "0B", "0B"],
      ["tcp4", "10.0.0.5:52000", "api.example.com (93.184.216.34:443)", "Established", "9.2KB", "2.1KB"],
      ["tcp6", "[::1]:9229", "—", "Listen", "0B", "0B"],
      ["tcp6", "[2001:db8::5]:40000", "one.one.one.one ([2606:4700::1111]:443)", "Established", "103.5KB", "612B"],
      ["udp4", "*:5353", "—", "—", "—", "—"],
      ["udp6", "[fe80::1]:546", "—", "—", "—", "—"],
    ]);
    const udpBytes = Array.from(rows[4].children).slice(4) as HTMLElement[];
    for (const c of udpBytes) {
      expect(c).toHaveAttribute("title", NO_BYTES_TITLE);
      expect(c).toHaveClass("netm-na");
    }
    expect(rows[1].children[2]).toHaveAttribute("title", "api.example.com (93.184.216.34:443)");
  });

  it("without `ss`: no byte or rate columns (hasBytes false), and the header says why", async () => {
    await mount(MACHINE_STATUS["linux-no-ss"]);
    await enterMachineMode("Whole computer");
    emit("linux-no-ss");
    // A backend with no byte counts hides the four empty columns rather than
    // filling them with `—`; the header still names the reason.
    const cells = Array.from(appRow("node:4242").children) as HTMLElement[];
    expect(cells.map((c) => c.textContent)).toEqual(["▸ node", "4242", "2"]);
    expect(screen.getByTestId("netm-partial")).toHaveTextContent("byte counts need `ss` (iproute2), which isn't installed.");
  });

  it("Windows: every app is named, no byte or rate columns, and the header says why", async () => {
    await mount(MACHINE_STATUS["windows-idle"], MACHINE_STATUS["windows-running"]);
    await enterMachineMode("Whole computer");
    // The mode is there and running — not the "isn't available here" box Windows used to get.
    expect(screen.queryByTestId("netm-unavailable")).toBeNull();
    emit("windows-first");
    // Hide listeners is on by default: `System` only listens, so it is not a row; chrome's
    // peer-less UDP socket and node's listener are not counted.
    expect(appKeys()).toEqual(["chrome:9044", "node:5120"]);
    const chrome = Array.from(appRow("chrome:9044").children) as HTMLElement[];
    expect(chrome.map((c) => c.textContent)).toEqual(["▸ chrome", "9044", "2"]);
    expect(screen.getByTestId("netm-partial")).toHaveTextContent(
      "Byte counts aren't shown on Windows: the system only keeps them per connection after an administrator turns them on.",
    );
    fireEvent.click(appRow("node:5120"));
    expect(connRows("node").map(cellsOf)).toEqual([
      ["tcp4", "10.0.0.5:52001", "api.example.com (93.184.216.34:443)", "Established"],
    ]);
  });

  it("the filter matches a resolved host name; selection by keyboard walks the sorted rows", async () => {
    await mount(MACHINE_STATUS["linux-partial-running"]);
    await enterMachineMode("Whole computer");
    emit("linux-second");
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter apps and connections" }), {
      target: { value: "one.one" },
    });
    expect(appKeys()).toEqual(["node:4242"]);
    expect(title()).toBe("Whole computer — 1 of 3 apps · 1 connection · ↓ 19.5KB/s ↑ 1000B/s");
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter apps and connections" }), { target: { value: "" } });
    const box = screen.getByTestId("netm-scroll");
    fireEvent.keyDown(box, { key: "j" });
    fireEvent.keyDown(box, { key: "j" });
    expect(appRow("no process:0")).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(box, { key: "Enter" });
    expect(connRows("no process").map(cellsOf)).toEqual([
      ["tcp4", "10.0.0.5:52001", "api.example.com (93.184.216.34:443)", "TimeWait", "0B", "0B"],
    ]);
  });
});

describe("unavailable backends explain themselves inside the mode", () => {
  it.each([
    ["other-os-unavailable", "Whole computer", "Whole computer isn't available here.", "Whole-computer connections aren't supported on this system yet."],
    ["macos-nettop-missing", "Whole Mac", "Whole Mac isn't available here.", "/usr/bin/nettop is missing, so connections can't be listed."],
  ] as const)("%s", async (state, label, head, reason) => {
    await mount(MACHINE_STATUS[state]);
    await enterMachineMode(label);
    const box = screen.getByTestId("netm-unavailable");
    expect(Array.from(box.querySelectorAll("p")).map((p) => p.textContent)).toEqual([head, reason]);
    expect(screen.queryByTestId("netm-title")).toBeNull();
  });
});
