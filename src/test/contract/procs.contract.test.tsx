/** SEAM TEST: the JSON was written by Rust (`src-tauri/tests/contract_goldens.rs`). Only `invoke`
 * / `listen` are mocked; IPC, stores and views are real. Golden keys are checked both ways against
 * `procsTypes.ts`; expected strings are written by hand, never derived from the golden. */

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => {
  const state = {
    list: null as unknown,
    snapshot: [] as unknown[],
    commands: {} as Record<string, unknown>,
    handler: null as null | ((e: { payload: unknown }) => void),
  };
  const invoke = vi.fn((cmd: string) => {
    if (cmd === "logstream_snapshot") return Promise.resolve(state.snapshot);
    if (cmd === "procs_list") return Promise.resolve(state.list);
    const reply: Record<string, string> = {
      logstream_tail_app: "tailApp",
      logstream_tail_docker: "tailDocker",
      logstream_untail: "untail",
      procs_restart_prepare: "restartPrepare",
      procs_restart_in_ide: "restartInIde",
    };
    if (cmd in reply) return Promise.resolve(state.commands[reply[cmd]]);
    // syslog_* have their own seam test (syslog.contract.test.tsx).
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

import { leafOfTab, useAppStore } from "../../app/store";
import { useColumnLayoutStore } from "../../components/columns";
import { AgentLogsPanel } from "../../features/agentlogs/AgentLogsPanel";
import { focusTerminalTab } from "../../features/agentlogs/agentLogsFocus";
import { resetAgentLogsForTests, useAgentLogsStore } from "../../features/agentlogs/agentLogsStore";
import type { LogLine } from "../../features/agentlogs/agentLogsTypes";
import { resetNetworkStore, useNetworkStore } from "../../features/network/networkStore";
import { DEV_APPS_EMPTY } from "../../features/procs/DevAppsSection";
import { confirmRestart, requestRestart, useProcsStore } from "../../features/procs/procsStore";
import { RUNTIME_LABELS, type DevApp, type ProcsList } from "../../features/procs/procsTypes";
import { resetStore } from "../store-harness";
import appLinesJson from "./goldens/app-lines.json";
import procsCommandsJson from "./goldens/procs-commands.json";
import procsListJson from "./goldens/procs-list.json";

type ListScenario = "dockerDown" | "machine" | "noDocker" | "unavailable";
const LISTS = procsListJson as unknown as Record<ListScenario, ProcsList>;
const APP_LINES = appLinesJson as unknown as LogLine[];
const COMMANDS = procsCommandsJson as unknown as Record<string, unknown>;

const settle = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });

async function mount(list: ListScenario, lines: LogLine[] = []): Promise<void> {
  tauri.state.list = LISTS[list];
  tauri.state.snapshot = lines;
  render(<AgentLogsPanel />);
  await settle();
}
const appRow = (key: string) =>
  screen.getAllByTestId("procs-row").find((r) => r.dataset.key === key) as HTMLElement;
const sent = (cmd: string) => tauri.invoke.mock.calls.filter((c) => c[0] === cmd).map((c) => (c as unknown[])[1]);

beforeEach(() => {
  resetAgentLogsForTests();
  resetStore();
  useColumnLayoutStore.setState({ layouts: {} });
  tauri.state.commands = COMMANDS;
  tauri.invoke.mockClear();
});
afterEach(() => resetAgentLogsForTests());

/* ── shape, both directions ── */

const APP_KEYS = [
  "agentId",
  "argv",
  "captured",
  "console",
  "containerId",
  "cwd",
  "exe",
  "key",
  "launchedBy",
  "logFiles",
  "name",
  "origin",
  "pid",
  "ports",
  "runtime",
  "startedMs",
  "terminalId",
];
const CONSOLES = ["terminal", "pipe", "file", "none", "ide-terminal"];
const ORIGINS = ["ide", "external"];
const nullOrString = (x: unknown) => x === null || typeof x === "string";
const FILE_KINDS = ["stdout", "stderr", "log"];

describe("procs goldens match the TS contract (procsTypes.ts)", () => {
  it("every procs_list scenario: exactly { available, reason, apps }, every app exactly a DevApp", () => {
    expect(Object.keys(LISTS).sort()).toEqual(["dockerDown", "machine", "noDocker", "unavailable"]);
    const failures: string[] = [];
    for (const [name, list] of Object.entries(LISTS)) {
      if (JSON.stringify(Object.keys(list).sort()) !== JSON.stringify(["apps", "available", "reason"])) failures.push(`${name}: keys ${Object.keys(list)}`);
      if (typeof list.available !== "boolean") failures.push(`${name}.available`);
      if (list.reason !== null && typeof list.reason !== "string") failures.push(`${name}.reason`);
      list.apps.forEach((a, i) => {
        const at = `${name}.apps[${i}]`;
        if (JSON.stringify(Object.keys(a).sort()) !== JSON.stringify(APP_KEYS)) failures.push(`${at}: keys ${Object.keys(a).sort()}`);
        if (!(a.runtime in RUNTIME_LABELS)) failures.push(`${at}.runtime "${a.runtime}" is not a DevRuntime`);
        if (!CONSOLES.includes(a.console)) failures.push(`${at}.console "${a.console}"`);
        // Origin + who started it. An external app names no terminal/agent/launcher.
        if (!ORIGINS.includes(a.origin)) failures.push(`${at}.origin "${a.origin}"`);
        if (!nullOrString(a.terminalId) || !nullOrString(a.agentId) || !nullOrString(a.launchedBy)) failures.push(`${at}: terminalId/agentId/launchedBy`);
        if (a.origin === "external" && (a.terminalId !== null || a.agentId !== null || a.launchedBy !== null)) failures.push(`${at}: external but launched by the IDE`);
        if (a.origin === "ide" && a.terminalId === null) failures.push(`${at}: an IDE app with no terminal`);
        if (a.console === "ide-terminal" && a.origin !== "ide") failures.push(`${at}: ide-terminal console on an external app`);
        // The capture guard: a boolean or null, never anything env-shaped; only an IDE app is judged.
        if (a.captured !== null && typeof a.captured !== "boolean") failures.push(`${at}.captured`);
        if (a.origin === "external" && a.captured !== null) failures.push(`${at}: an external app judged for capture`);
        if (a.pid !== null && typeof a.pid !== "number") failures.push(`${at}.pid`);
        if (!Array.isArray(a.argv) || a.argv.some((x) => typeof x !== "string")) failures.push(`${at}.argv`);
        if (!Array.isArray(a.ports) || a.ports.some((x) => typeof x !== "number")) failures.push(`${at}.ports`);
        for (const f of a.logFiles) {
          if (JSON.stringify(Object.keys(f).sort()) !== JSON.stringify(["kind", "path"]) || !FILE_KINDS.includes(f.kind)) {
            failures.push(`${at}.logFiles: ${JSON.stringify(f)}`);
          }
        }
      });
    }
    expect(failures).toEqual([]);
    // The golden exercises every runtime the UI has a badge for (so the badge check bites).
    const runtimes = new Set(Object.values(LISTS).flatMap((l) => l.apps.map((a) => a.runtime)));
    expect([...runtimes].sort()).toEqual(Object.keys(RUNTIME_LABELS).sort());
    // …and both origins, every console kind the card has a branch for, and an agent-launched app.
    const all = Object.values(LISTS).flatMap((l) => l.apps);
    expect([...new Set(all.map((a) => a.origin))].sort()).toEqual(["external", "ide"]);
    expect([...new Set(all.map((a) => a.console))].sort()).toEqual(["file", "ide-terminal", "none", "pipe", "terminal"]);
    expect(all.some((a) => a.origin === "ide" && a.agentId !== null)).toBe(true);
    // …and every capture state the card and the Network banner have a branch for.
    expect([...new Set(all.map((a) => String(a.captured)))].sort()).toEqual(["false", "null", "true"]);
  });

  it("the command replies: tail → { key, source }, untail → boolean, prepare → { token, summary }, restart → { terminalId }", () => {
    expect(Object.keys(COMMANDS).sort()).toEqual(["restartInIde", "restartPrepare", "tailApp", "tailDocker", "untail"]);
    for (const k of ["tailApp", "tailDocker"]) expect(Object.keys(COMMANDS[k] as object).sort()).toEqual(["key", "source"]);
    expect(typeof COMMANDS.untail).toBe("boolean");
    const prep = COMMANDS.restartPrepare as { token: unknown; summary: Record<string, unknown> };
    expect(Object.keys(prep).sort()).toEqual(["summary", "token"]);
    expect(Object.keys(prep.summary).sort()).toEqual(["argv", "cwd", "name"]);
    expect(Object.keys(COMMANDS.restartInIde as object)).toEqual(["terminalId"]);
  });

  it("app lines are `system` (open/close) + `app` lines, stamped like every LogLine", () => {
    expect([...new Set(APP_LINES.map((l) => l.kind))].sort()).toEqual(["app", "system"]);
    expect(APP_LINES.every((l) => l.terminalId === null && l.agentId === null && l.toolUseId === null)).toBe(true);
  });
});

/* ── through the real views ── */

describe("procs_list through the Logs sidebar", () => {
  it("machine: every app grouped by runtime — the IDE's apps first in a section, tagged — Shell included, last", async () => {
    await mount("machine");
    const rows = await screen.findAllByTestId("procs-row");
    // Grouped by runtime (Rust · Cargo, JVM, Node · JS, Python, Go, Docker, Shell); in a
    // section the IDE's apps before external ones, otherwise Rust's order. Written by hand.
    expect(rows.map((r) => `${r.dataset.runtime} ${r.querySelector(".procs-side__name")?.textContent} [${within(r).getByTestId("procs-origin").textContent}]`)).toEqual([
      "rust gazelle [external]",
      "jvm gradle daemon [external]",
      "jvm shop-0.1.jar · shop [external]",
      "node server.js · gazelle [by claude · gazelle]",
      "node vite · web [by zsh]",
      "node vite · site [external]",
      "python uvicorn · api [external]",
      "go gateway [external]",
      "docker cache [external]",
      "docker db-fixtures-postgres-1 [external]",
      "shell sh · worker [external]",
    ]);
    const heads = screen.getAllByTestId("procs-runtime-head").map((h) => h.textContent);
    expect(heads).toEqual(["▾Rust · Cargo1", "▾JVM2", "▾Node · JS3", "▾Python1", "▾Go1", "▾Docker2", "▾Shell1"]);
    // Rows are badge-free: the section heading names the runtime.
    expect(within(screen.getByTestId("procs-section")).queryAllByTestId("procs-badge")).toEqual([]);
    // The masked argv is shown as Rust sent it — never unmasked, never more.
    expect(appRow("pid:202").title).toBe("pid 202\n/work/gazelle\ntarget/debug/gazelle --db-password=•••• --port 3000");
    expect(within(appRow("pid:202")).getByTestId("procs-ports").textContent).toBe(":3000");
  });

  it("dockerDown: the apps, plus Rust's note", async () => {
    await mount("dockerDown");
    expect(await screen.findAllByTestId("procs-row")).toHaveLength(9);
    expect(screen.getByTestId("procs-note").textContent).toBe("Docker is not running");
  });

  it("noDocker (nothing running) and unavailable (Rust's reason)", async () => {
    await mount("noDocker");
    expect((await screen.findByText(DEV_APPS_EMPTY)).dataset.testid).toBe("procs-empty");
    useProcsStore.setState({ list: LISTS.unavailable });
    await settle();
    expect(screen.getByTestId("procs-unavailable").textContent).toBe("Dev-app discovery is not available on this OS yet");
  });
});

describe("app lines through the Logs view", () => {
  it("render RAW with Rust's levels, the open/close lines are dividers, and the stream sits UNDER its app", async () => {
    await mount("machine", APP_LINES);
    await screen.findAllByTestId("procs-row");
    const rows = screen.getAllByTestId("alog-row");
    expect(rows.map((r) => r.dataset.id)).toEqual(["2", "3", "4", "5"]);
    expect(rows.map((r) => /alog-row--(error|warn|info|debug)\b/.exec(r.className)?.[1])).toEqual(["info", "warn", "error", "debug"]);
    expect(rows.every((r) => r.className.includes("alog-row--kind-app"))).toBe(true);
    expect(screen.getAllByTestId("alog-divider").map((d) => d.dataset.id)).toEqual(["1", "6"]);
    expect(screen.queryAllByTestId("alog-block-head")).toEqual([]);

    const gazelle = appRow("pid:202");
    const stream = gazelle.nextElementSibling as HTMLElement;
    expect(stream.dataset.source).toBe("gazelle · gazelle.log");
    expect(stream.dataset.group).toBe("app");
    expect(stream.querySelector(".alog-side__name")?.textContent).toBe("gazelle.log");
    // Closed by its `app log stopped` line.
    expect(stream.dataset.running).toBe("false");
    expect(within(stream).getByTestId("alog-src-errors").textContent).toBe("1");
  });

  it("the app's stream has ended, so selecting the app shows its card and “Pick a log to stream”", async () => {
    await mount("machine", APP_LINES);
    await screen.findAllByTestId("procs-row");
    fireEvent.click(appRow("pid:202"));
    expect(useAgentLogsStore.getState().filter.onlySources).toEqual([]);
    expect(screen.getByTestId("procs-card").dataset.key).toBe("pid:202");
    expect(screen.getByTestId("alog-app-hint").textContent).toMatch(/^Pick a log to stream/);
  });
});

describe("the commands, with Rust's replies", () => {
  it("Stream a file sends { pid, path } and solos the source Rust named; Stop sends Rust's key back", async () => {
    await mount("machine");
    await screen.findAllByTestId("procs-row");
    fireEvent.click(appRow("pid:202"));
    const card = screen.getByTestId("procs-card");
    expect(within(card).getByTestId("procs-console").dataset.console).toBe("file");
    fireEvent.click(within(card).getByRole("button", { name: "Stream gazelle.log" }));
    await settle();
    expect(sent("logstream_tail_app")).toEqual([{ pid: 202, path: "/work/gazelle/gazelle.log" }]);
    expect(useAgentLogsStore.getState().filter.onlySources).toEqual(["gazelle · gazelle.log"]);
    expect(within(appRow("pid:202")).getByTestId("procs-live")).toBeTruthy();

    fireEvent.click(within(card).getByRole("button", { name: "Stop gazelle.log" }));
    await settle();
    expect(sent("logstream_untail")).toEqual([{ key: "file:/work/gazelle/gazelle.log" }]);
    expect(within(appRow("pid:202")).queryByTestId("procs-live")).toBeNull();
  });

  it("Stream a container's logs sends { id } and solos `<container> · docker`", async () => {
    await mount("machine");
    await screen.findAllByTestId("procs-row");
    const key = "docker:3f2a9c1b0d4e5f60718293a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4";
    fireEvent.click(appRow(key));
    fireEvent.click(within(screen.getByTestId("procs-card")).getByRole("button", { name: "Stream docker logs" }));
    await settle();
    expect(sent("logstream_tail_docker")).toEqual([{ id: "3f2a9c1b0d4e5f60718293a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4" }]);
    expect(useAgentLogsStore.getState().filter.onlySources).toEqual(["db-fixtures-postgres-1 · docker"]);
  });

  it("Restart on an app whose pid Rust now reports as another program stops there — nothing is restarted", async () => {
    await mount("machine");
    await screen.findAllByTestId("procs-row");
    fireEvent.click(appRow("pid:300")); // shop, console `terminal`
    fireEvent.click(screen.getByTestId("procs-restart"));
    fireEvent.click(screen.getByTestId("procs-restart-confirm"));
    await settle();
    expect(sent("procs_restart_prepare")).toEqual([{ pid: 300 }]);
    expect(sent("procs_restart_in_ide")).toEqual([]);
    expect(screen.getByTestId("procs-restart-error").textContent).toMatch(/^pid 300 is now gazelle, not shop-0\.1\.jar · shop — nothing was stopped\./);
  });

  it("Restart of the app Rust prepared: its token is spent, and the terminal it answers with gets a focused tab", async () => {
    await mount("machine");
    await screen.findAllByTestId("procs-row");
    const gazelle = LISTS.machine.apps.find((a) => a.key === "pid:202") as DevApp;
    requestRestart(gazelle.key);
    const terminalId = await confirmRestart(gazelle);
    expect(sent("procs_restart_in_ide")).toEqual([{ token: "rs-01J0000000000000000000000" }]);
    expect(terminalId).toBe("01J00000000000000000000000");
    expect(focusTerminalTab(terminalId as string, gazelle.name, gazelle.cwd)).toBe(true);
    const s = useAppStore.getState();
    const tab = Object.values(s.tabs).find((t) => t.ref.kind === "terminal" && t.ref.terminalId === terminalId);
    expect(leafOfTab(s.layout, tab!.id)?.activeTabId).toBe(tab!.id);
  });
});

describe("the IDE's own apps, as Rust lists them", () => {
  beforeEach(() => resetNetworkStore());
  it("an app in an IDE terminal: console names the terminal, Open terminal focuses it, requests → picks its process, no Restart", async () => {
    await mount("machine");
    await screen.findAllByTestId("procs-row");
    // A tab for the terminal Rust named (its title is the tab's, not Rust's `launchedBy`).
    useAppStore.getState().layoutActions.rebuildTerminalTabs([
      { id: "01J0000000000000000000TERM" as never, kind: "terminal", title: "zsh · web", cwd: "/work/web", cols: 80, rows: 24, status: "live" },
    ]);
    fireEvent.click(appRow("pid:102"));
    const card = screen.getByTestId("procs-card");
    expect(within(card).getByTestId("procs-console").dataset.console).toBe("ide-terminal");
    expect(within(card).getByTestId("procs-console-terminal").textContent).toBe("zsh · web");
    expect(within(card).queryByTestId("procs-restart")).toBeNull();
    fireEvent.click(within(card).getByTestId("procs-requests"));
    expect(useNetworkStore.getState().processSelection).toEqual(["node"]);
    expect(useNetworkStore.getState().mode).toBe("ide");
    fireEvent.click(within(screen.getByTestId("procs-card")).getByTestId("procs-open-terminal"));
    const s = useAppStore.getState();
    const tab = Object.values(s.tabs).find((t) => t.ref.kind === "terminal" && t.ref.terminalId === "01J0000000000000000000TERM");
    expect(leafOfTab(s.layout, tab!.id)?.activeTabId).toBe(tab!.id);
  });

  it("an app an agent started on a pipe: says whose console it is, and never offers Restart", async () => {
    await mount("machine");
    await screen.findAllByTestId("procs-row");
    fireEvent.click(appRow("pid:112"));
    expect(screen.getByTestId("procs-console").textContent).toBe(
      "Its console is a pipe held by claude · gazelle — its output shows in that stream, not here.",
    );
    expect(screen.queryByTestId("procs-restart")).toBeNull();
  });
});
