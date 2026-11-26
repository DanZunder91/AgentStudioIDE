/** Dev apps in Logs, real Chromium layout: the app card between header and list leaves the list a
 * real scroll box (its one `flex: 1 1 0` child), and an app's streams read as rows UNDER it. */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "../../App.css";

const ipc = vi.hoisted(() => ({ snapshot: [] as unknown[], apps: [] as unknown[] }));
vi.mock("./logstreamIpc", () => ({
  logstreamSnapshot: () => Promise.resolve(ipc.snapshot),
  logstreamClear: () => Promise.resolve(),
  onLogstreamLines: () => Promise.resolve(() => {}),
  syslogStatus: () => Promise.reject(new Error("not in this test")),
  syslogSet: () => Promise.reject(new Error("not in this test")),
  syslogApps: () => Promise.resolve([]),
}));
vi.mock("../procs/procsIpc", () => ({
  procsList: () => Promise.resolve({ available: true, reason: null, apps: ipc.apps }),
  tailApp: () => Promise.reject(new Error("not in this test")),
  tailDocker: () => Promise.reject(new Error("not in this test")),
  untail: () => Promise.resolve(),
  pickLogFile: () => Promise.resolve(null),
  restartPrepare: () => Promise.reject(new Error("not in this test")),
  restartInIde: () => Promise.reject(new Error("not in this test")),
}));

import { useColumnLayoutStore } from "../../components/columns";
import type { DevApp } from "../procs/procsTypes";
import { AgentLogsPanel } from "./AgentLogsPanel";
import { resetAgentLogsForTests } from "./agentLogsStore";
import type { LogLine } from "./agentLogsTypes";

const L = (id: number, source: string, text: string, p: Partial<LogLine> = {}): LogLine => ({
  id, tsMs: new Date(2026, 8, 28, 11, 0, id).getTime(), terminalId: null, agentId: null,
  source, kind: "app", level: "info", text, detail: null, toolUseId: null, ...p,
});
const app = (name: string, pid: number, logFiles: DevApp["logFiles"] = []): DevApp => ({
  key: `${name}:${pid}`, pid, runtime: "node", name, exe: "/usr/local/bin/node", argv: ["node", "server.js"],
  cwd: `/w/${name}`, startedMs: 1, ports: [3000], console: "terminal", logFiles, containerId: null,
  origin: "external", terminalId: null, agentId: null, launchedBy: null, captured: null,
});

beforeEach(() => {
  resetAgentLogsForTests();
  useColumnLayoutStore.setState({ layouts: {} });
  ipc.apps = [app("web", 42, [{ path: "/w/web/server.log", kind: "log" }]), app("api", 7)];
  ipc.snapshot = [
    L(1, "zsh · repo", "$ ls", { kind: "output" }),
    ...Array.from({ length: 40 }, (_, i) => L(i + 2, "web · server.log", `GET /item/${i} 200`)),
  ];
});
afterEach(() => {
  cleanup();
  resetAgentLogsForTests();
});

async function mount(): Promise<void> {
  render(
    <div style={{ width: 1200, height: 600, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <AgentLogsPanel />
    </div>,
  );
  await screen.findAllByTestId("procs-row");
}
const rect = (el: Element) => el.getBoundingClientRect();
const appRow = (key: string) => document.querySelector<HTMLElement>(`[data-testid="procs-row"][data-key="${key}"]`)!;
const srcRow = (source: string) => document.querySelector<HTMLElement>(`[data-testid="alog-src-row"][data-source="${source}"]`)!;

describe("dev apps in the Logs view (real layout)", () => {
  it("a stream row sits under its app's row, indented past it", async () => {
    await mount();
    const web = appRow("web:42");
    const stream = srcRow("web · server.log");
    expect(rect(stream).top).toBeGreaterThanOrEqual(rect(web).bottom - 1);
    expect(rect(stream).bottom).toBeLessThanOrEqual(rect(appRow("api:7")).top + 1);
    const nameLeft = (el: HTMLElement) => rect(el.querySelector(".alog-side__name, .procs-side__name")!).left;
    expect(nameLeft(stream)).toBeGreaterThan(nameLeft(srcRow("zsh · repo")));
  });

  it("the card sits between the stream header and the list, and the list stays a real scroll box under it", async () => {
    await mount();
    fireEvent.click(appRow("web:42"));
    const head = await screen.findByTestId("alog-stream-head");
    const card = screen.getByTestId("procs-card");
    const list = screen.getByTestId("alog-list");
    expect(rect(card).top).toBeGreaterThanOrEqual(rect(head).bottom - 1);
    expect(rect(list).top).toBeGreaterThanOrEqual(rect(card).bottom - 1);
    // The list keeps a real share of the pane and scrolls its 40 rows inside it (the panel did
    // not grow past its 600px box).
    expect(list.clientHeight).toBeGreaterThan(18 * 3);
    expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);
    expect(rect(screen.getByTestId("agent-logs-panel")).bottom).toBeLessThanOrEqual(601);
  });

  it("an app with no stream shows its card and the “Pick a log to stream” hint in view", async () => {
    await mount();
    fireEvent.click(appRow("api:7"));
    const hint = await screen.findByTestId("alog-app-hint");
    const list = screen.getByTestId("alog-list");
    expect(rect(hint).height).toBeGreaterThan(0);
    expect(rect(hint).top).toBeGreaterThanOrEqual(rect(list).top - 1);
    expect(rect(hint).bottom).toBeLessThanOrEqual(rect(list).bottom + 1);
  });
});

describe("the Apps group (grouped by runtime — real layout)", () => {
  it("sits above every other group; every runtime heading is on screen; a long `by …` tag stays inside the sidebar", async () => {
    ipc.apps = [
      { ...app("gazelle", 77), runtime: "rust", origin: "ide", terminalId: "t-1", agentId: "a-1", launchedBy: "claude · a-very-long-agent-title-that-would-overflow", console: "ide-terminal" },
      app("web", 42, [{ path: "/w/web/server.log", kind: "log" }]),
    ];
    await mount();
    const apps = screen.getByTestId("procs-section");
    const terminals = screen.getAllByTestId("alog-src-group").find((g) => g.getAttribute("aria-label") === "Terminals")!;
    expect(rect(apps).bottom).toBeLessThanOrEqual(rect(terminals).top + 1);
    const heads = screen.getAllByTestId("procs-runtime-head");
    expect(heads.map((h) => h.querySelector(".procs-rt__label")?.textContent)).toEqual([
      "Rust · Cargo", "JVM", "Node · JS", "Python", "Go", "Docker", "Shell",
    ]);
    for (const h of heads) expect(rect(h).height).toBeGreaterThan(0);
    // An empty section reads dimmer than one with apps.
    const opacity = (el: Element) => Number(getComputedStyle(el).opacity);
    expect(opacity(heads[1])).toBeLessThan(opacity(heads[0]));
    const sidebar = screen.getByTestId("alog-sidebar");
    const tag = appRow("gazelle:77").querySelector('[data-testid="procs-origin"]')!;
    expect(rect(tag).right).toBeLessThanOrEqual(rect(sidebar).right + 1);
  });
});
