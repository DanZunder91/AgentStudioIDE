/** Driven from the buttons over the real IPC seam: a store-level test cannot see which action a
 * button calls. */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { installTauriMock, type TauriMock } from "../../test/tauri-mock";

import { useMachineStore } from "../network/machineStore";
import { CONSOLE_NONE, CONSOLE_UNREADABLE, DevAppCard, ideOwnedConsole, type TailedBy } from "./DevAppCard";
import * as index from "./index";
import { resetProcsStore, useProcsStore } from "./procsStore";
import type { DevApp } from "./procsTypes";
import { RESTART_QUESTION } from "./RestartDialog";

const WEB: DevApp = {
  key: "web:42",
  pid: 42,
  runtime: "node",
  name: "web",
  exe: "/usr/local/bin/node",
  argv: ["node", "server.js", "--password=•••"],
  cwd: "/Users/me/w/web",
  startedMs: 1_000_000,
  ports: [3000, 9229],
  console: "terminal",
  logFiles: [{ path: "/Users/me/w/web/logs/app.log", kind: "log" }],
  containerId: null,
  origin: "external",
  terminalId: null,
  agentId: null,
  launchedBy: null,
  captured: null,
};
const PG: DevApp = {
  ...WEB,
  key: "c:abc",
  pid: null,
  runtime: "docker",
  name: "pg",
  argv: [],
  cwd: null,
  ports: [5432],
  console: "none",
  logFiles: [],
  containerId: "abc123def456789",
};

let ipc: TauriMock;
let props: {
  onStreamStarted: Mock<(source: string) => void>;
  onOpenTerminal: Mock<(terminalId: string) => void>;
  onShowConnections: Mock<(pid: number) => void>;
  onShowRequests: Mock<(processName: string) => void>;
  terminalTitle: string | null;
  serviceTailing: Mock<(path: string) => TailedBy | null>;
};

beforeEach(() => {
  ipc = installTauriMock();
  ipc.handle("procs_list", () => ({ available: true, reason: null, apps: [WEB, PG] }));
  ipc.handle("logstream_tail_app", (a) => ({ key: `tail:${String(a.path)}`, source: `web · ${String(a.path).split("/").pop()}` }));
  ipc.handle("logstream_tail_docker", () => ({ key: "tail:docker", source: "pg · docker" }));
  ipc.handle("logstream_untail", () => null);
  resetProcsStore();
  props = {
    onStreamStarted: vi.fn(),
    onOpenTerminal: vi.fn(),
    onShowConnections: vi.fn(),
    onShowRequests: vi.fn(),
    terminalTitle: null,
    serviceTailing: vi.fn(() => null),
  };
});
afterEach(() => {
  cleanup();
  resetProcsStore();
  ipc.reset();
});

/** Render and let the mount's poll land. */
async function mount(app: DevApp) {
  const r = render(<DevAppCard app={app} {...props} />);
  await waitFor(() => expect(useProcsStore.getState().polledAtMs).not.toBeNull());
  return r;
}
const nonListCalls = () => ipc.calls().filter((c) => c.cmd !== "procs_list").map((c) => [c.cmd, c.args]);

describe("header and facts", () => {
  it("is exported from the feature's index", () => {
    expect(index.DevAppCard).toBe(DevAppCard);
  });

  it("shows badge, name, pid and uptime measured against the last poll", async () => {
    await mount(WEB);
    act(() => useProcsStore.setState({ polledAtMs: WEB.startedMs! + 3 * 3_600_000 + 12 * 60_000 }));
    const card = screen.getByTestId("procs-card");
    expect(card.getAttribute("aria-label")).toBe("web — Node app");
    expect(within(card).getByTestId("procs-badge").textContent).toBe("Node");
    expect(screen.getByTestId("procs-card-id").textContent).toBe("pid 42");
    expect(screen.getByTestId("procs-card-uptime").textContent).toBe("up 3h 12m");
  });

  it("has no uptime before the first poll lands, or when Rust has no start time", async () => {
    ipc.handle("procs_list", () => new Promise(() => {}));
    render(<DevAppCard app={WEB} {...props} />);
    expect(screen.queryByTestId("procs-card-uptime")).toBeNull();
    cleanup();
    resetProcsStore();
    ipc.handle("procs_list", () => ({ available: true, reason: null, apps: [] }));
    await mount({ ...WEB, startedMs: null });
    expect(screen.queryByTestId("procs-card-uptime")).toBeNull();
  });

  it("renders the command exactly as Rust masked it — full in the title, nowhere else", async () => {
    const { container } = await mount(WEB);
    const cmd = screen.getByTestId("procs-card-cmd");
    expect(cmd.textContent).toBe("node server.js --password=•••");
    expect(cmd.title).toBe("node server.js --password=•••");
    // The masked flag appears exactly twice in the whole card (text + title) and never un-masked.
    expect(container.innerHTML.split("--password=").length - 1).toBe(2);
    expect(container.innerHTML).not.toMatch(/--password=[^•]/);
    // exe is not the command line and is not shown.
    expect(container.textContent).not.toContain("/usr/local/bin/node");
  });

  it("omits cwd and command when Rust has neither", async () => {
    await mount({ ...WEB, cwd: null, argv: [] });
    expect(screen.queryByTestId("procs-copy-cwd")).toBeNull();
    expect(screen.queryByTestId("procs-card-cmd")).toBeNull();
  });

  it("copies the cwd, and says so only when the copy worked", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await mount(WEB);
    const btn = screen.getByTestId("procs-copy-cwd");
    expect(btn.textContent).toBe("copy");
    fireEvent.click(btn);
    expect(writeText).toHaveBeenCalledWith("/Users/me/w/web");
    await waitFor(() => expect(btn.textContent).toBe("copied"));

    writeText.mockRejectedValue(new Error("denied"));
    cleanup();
    await mount(WEB);
    fireEvent.click(screen.getByTestId("procs-copy-cwd"));
    await act(async () => {});
    expect(screen.getByTestId("procs-copy-cwd").textContent).toBe("copy");
  });

  it("each port links to its connections by pid", async () => {
    await mount(WEB);
    const ports = screen.getAllByTestId("procs-card-port");
    expect(ports.map((p) => p.querySelector("code")?.textContent)).toEqual([":3000", ":9229"]);
    fireEvent.click(within(ports[1]).getByTestId("procs-connections"));
    expect(props.onShowConnections).toHaveBeenCalledExactlyOnceWith(42);
  });

  it("omits the ports row without ports", async () => {
    await mount({ ...WEB, ports: [] });
    expect(screen.queryByTestId("procs-card-port")).toBeNull();
  });
});

describe("console states", () => {
  it("terminal: says it cannot be read and offers Restart in the IDE", async () => {
    await mount(WEB);
    const c = screen.getByTestId("procs-console");
    expect(c.getAttribute("data-console")).toBe("terminal");
    expect(c.textContent).toContain(CONSOLE_UNREADABLE);
    expect(within(c).getByTestId("procs-restart").textContent).toBe("Restart in the IDE");
    // Windows lists these too: the reason names no one OS.
    expect(c.textContent).not.toMatch(/macOS|Windows|Linux/);
  });

  it("pipe: the same, and no restart without a pid", async () => {
    await mount({ ...WEB, console: "pipe" });
    expect(screen.getByTestId("procs-console").getAttribute("data-console")).toBe("pipe");
    expect(screen.getByTestId("procs-restart")).toBeTruthy();
    cleanup();
    await mount({ ...WEB, console: "pipe", pid: null });
    expect(screen.getByTestId("procs-console").textContent).toBe(CONSOLE_UNREADABLE);
    expect(screen.queryByTestId("procs-restart")).toBeNull();
  });

  it("none: says the output is discarded, no restart", async () => {
    await mount({ ...WEB, console: "none" });
    expect(screen.getByTestId("procs-console").textContent).toBe(CONSOLE_NONE);
    expect(screen.queryByTestId("procs-restart")).toBeNull();
  });

  it("file: names the console files with Stream; only the other logs stay in the list", async () => {
    const app: DevApp = {
      ...WEB,
      console: "file",
      logFiles: [
        { path: "/tmp/web.out", kind: "stdout" },
        { path: "/tmp/web.err", kind: "stderr" },
        { path: "/w/logs/app.log", kind: "log" },
      ],
    };
    await mount(app);
    const c = screen.getByTestId("procs-console");
    expect(c.textContent).toContain("Console is written to web.out");
    expect(c.textContent).toContain("Console (stderr) is written to web.err");
    expect(screen.queryByTestId("procs-restart")).toBeNull();
    expect(screen.getAllByTestId("procs-log-file").map((li) => li.getAttribute("data-path"))).toEqual(["/w/logs/app.log"]);

    fireEvent.click(within(c).getByRole("button", { name: "Stream web.out" }));
    await waitFor(() => expect(props.onStreamStarted).toHaveBeenCalledWith("web · web.out"));
    expect(nonListCalls()).toEqual([["logstream_tail_app", { pid: 42, path: "/tmp/web.out" }]]);
  });

  it("file without a visible file says so", async () => {
    await mount({ ...WEB, console: "file", logFiles: [] });
    expect(screen.getByTestId("procs-console").textContent).toBe("Console is written to a file the IDE can't see.");
  });

  it("docker: the console is docker logs — Stream tails the container; no file list, no pick, no port links", async () => {
    await mount(PG);
    expect(screen.getByTestId("procs-card-id").textContent).toBe("container abc123def456789");
    const c = screen.getByTestId("procs-console");
    expect(c.getAttribute("data-console")).toBe("docker");
    expect(c.textContent).toContain("Console is docker logs abc123def456");
    expect(screen.queryByTestId("procs-log-file")).toBeNull();
    expect(screen.queryByTestId("procs-pick-file")).toBeNull();
    expect(screen.queryByTestId("procs-connections")).toBeNull();
    fireEvent.click(within(c).getByRole("button", { name: "Stream docker logs" }));
    await waitFor(() => expect(props.onStreamStarted).toHaveBeenCalledWith("pg · docker"));
    expect(nonListCalls()).toEqual([["logstream_tail_docker", { id: "abc123def456789" }]]);
  });

  it("names an unknown container as such", async () => {
    await mount({ ...WEB, pid: null, containerId: null });
    expect(screen.getByTestId("procs-card-id").textContent).toBe("container ?");
  });
});

describe("log files: Stream / Stop / pick", () => {
  it("Stream → tail_app(pid, path) → onStreamStarted(source); Stop → untail(key)", async () => {
    let release: () => void = () => {};
    ipc.handle("logstream_tail_app", () => new Promise((r) => (release = () => r({ key: "tail:app", source: "web · app.log" }))));
    await mount(WEB);
    const li = screen.getByTestId("procs-log-file");
    expect(li.textContent).toContain("app.log");
    const btn = within(li).getByTestId("procs-stream-toggle");
    expect(btn.textContent).toBe("Stream");
    fireEvent.click(btn);
    // In flight: disabled, and a second click is impossible.
    expect(btn.textContent).toBe("…");
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    await act(async () => release());
    expect(props.onStreamStarted).toHaveBeenCalledExactlyOnceWith("web · app.log");
    expect(btn.textContent).toBe("Stop");
    expect(btn.getAttribute("aria-label")).toBe("Stop app.log");
    expect(btn.className).toContain("procs-card__btn--on");

    fireEvent.click(btn);
    await waitFor(() => expect(btn.textContent).toBe("Stream"));
    expect(nonListCalls()).toEqual([
      ["logstream_tail_app", { pid: 42, path: "/Users/me/w/web/logs/app.log" }],
      ["logstream_untail", { key: "tail:app" }],
    ]);
    expect(props.onStreamStarted).toHaveBeenCalledTimes(1);
  });

  it("lists a redirected stdout under a terminal console as a log with its kind", async () => {
    await mount({ ...WEB, logFiles: [{ path: "/tmp/err.log", kind: "stderr" }] });
    expect(screen.getByTestId("procs-log-file").textContent).toContain("stderr");
  });

  it("says when there are no log files", async () => {
    await mount({ ...WEB, logFiles: [] });
    expect(screen.getByTestId("procs-no-logs").textContent).toBe("No open log files found.");
  });

  it("shows a failed tail inline, does not report a start, and can be dismissed", async () => {
    ipc.handle("logstream_tail_app", () => {
      throw new Error("file closed");
    });
    await mount(WEB);
    fireEvent.click(screen.getByRole("button", { name: "Stream app.log" }));
    const err = await screen.findByTestId("procs-stream-error");
    expect(err.textContent).toContain("Could not stream: file closed");
    expect(err.getAttribute("role")).toBe("alert");
    expect(props.onStreamStarted).not.toHaveBeenCalled();
    fireEvent.click(within(err).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("procs-stream-error")).toBeNull();
  });

  it("Pick a log file… → pick → tail the picked path; it is listed as picked until stopped", async () => {
    ipc.handle("logstream_pick_file", () => "/Users/me/other/trace.log");
    await mount(WEB);
    fireEvent.click(screen.getByTestId("procs-pick-file"));
    await waitFor(() => expect(props.onStreamStarted).toHaveBeenCalledWith("web · trace.log"));
    expect(nonListCalls()).toEqual([
      ["logstream_pick_file", {}],
      ["logstream_tail_app", { pid: 42, path: "/Users/me/other/trace.log" }],
    ]);
    const rows = screen.getAllByTestId("procs-log-file");
    expect(rows.map((r) => r.getAttribute("data-path"))).toEqual(["/Users/me/w/web/logs/app.log", "/Users/me/other/trace.log"]);
    expect(rows[1].textContent).toContain("picked");
    fireEvent.click(within(rows[1]).getByRole("button", { name: "Stop trace.log" }));
    await waitFor(() => expect(screen.getAllByTestId("procs-log-file")).toHaveLength(1));
    expect(ipc.calls("logstream_untail").map((c) => c.args)).toEqual([{ key: "tail:/Users/me/other/trace.log" }]);
  });

  it("a cancelled pick tails nothing and reports nothing", async () => {
    ipc.handle("logstream_pick_file", () => null);
    await mount(WEB);
    fireEvent.click(screen.getByTestId("procs-pick-file"));
    await waitFor(() => expect(ipc.calls("logstream_pick_file")).toHaveLength(1));
    await act(async () => {});
    expect(ipc.calls("logstream_tail_app")).toEqual([]);
    expect(props.onStreamStarted).not.toHaveBeenCalled();
  });

  it("offers no pick without a pid", async () => {
    await mount({ ...WEB, pid: null });
    expect(screen.queryByTestId("procs-pick-file")).toBeNull();
  });
});

describe("Restart in the IDE", () => {
  beforeEach(() => {
    ipc.handle("procs_restart_prepare", () => ({ token: "tok-1", summary: { name: "web", cwd: WEB.cwd, argv: WEB.argv } }));
    ipc.handle("procs_restart_in_ide", () => ({ terminalId: "term-7" }));
  });

  async function openConfirm(app = WEB) {
    await mount(app);
    const opener = screen.getByTestId("procs-restart");
    opener.focus();
    fireEvent.click(opener);
    return { dialog: screen.getByRole("alertdialog"), opener };
  }

  it("the confirm names pid, name, command and cwd, asks the question, and focuses Cancel", async () => {
    const { dialog } = await openConfirm();
    expect(dialog.getAttribute("aria-labelledby")).toBe("procs-restart-title-web:42");
    expect(within(dialog).getByRole("heading").textContent).toBe("Restart web in the IDE?");
    expect(document.getElementById(dialog.getAttribute("aria-describedby")!)?.textContent).toBe(RESTART_QUESTION);
    expect(RESTART_QUESTION).toBe(
      "Stop it and run the same command in an IDE terminal? Its console and HTTP calls will then show here.",
    );
    expect(screen.getByTestId("procs-restart-pid").textContent).toBe("42");
    expect(screen.getByTestId("procs-restart-cmd").textContent).toBe("node server.js --password=•••");
    expect(screen.getByTestId("procs-restart-cwd").textContent).toBe("/Users/me/w/web");
    expect(document.activeElement).toBe(screen.getByTestId("procs-restart-cancel"));
  });

  it("says the cwd is unknown when Rust has none", async () => {
    await openConfirm({ ...WEB, cwd: null });
    expect(screen.getByTestId("procs-restart-cwd").textContent).toBe("unknown");
  });

  it("confirm → prepare(pid) → restart(token) → onOpenTerminal(id); the dialog closes", async () => {
    await openConfirm();
    fireEvent.click(screen.getByTestId("procs-restart-confirm"));
    await waitFor(() => expect(props.onOpenTerminal).toHaveBeenCalledExactlyOnceWith("term-7"));
    expect(nonListCalls()).toEqual([
      ["procs_restart_prepare", { pid: 42 }],
      ["procs_restart_in_ide", { token: "tok-1" }],
    ]);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("while running both buttons are disabled and Escape does not cancel", async () => {
    let release: () => void = () => {};
    ipc.handle("procs_restart_prepare", () => new Promise((r) => (release = () => r({ token: "t", summary: { name: "web", cwd: null, argv: [] } }))));
    await openConfirm();
    fireEvent.click(screen.getByTestId("procs-restart-confirm"));
    const confirm = screen.getByTestId("procs-restart-confirm") as HTMLButtonElement;
    expect(confirm.textContent).toBe("Restarting…");
    expect(confirm.disabled).toBe(true);
    expect((screen.getByTestId("procs-restart-cancel") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    // Tab with nothing focusable left inside: nothing to wrap to.
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Tab" });
    await act(async () => release());
    await waitFor(() => expect(props.onOpenTerminal).toHaveBeenCalledWith("term-7"));
  });

  it("Cancel closes it, sends nothing, and gives focus back to the opener", async () => {
    const { opener } = await openConfirm();
    fireEvent.click(screen.getByTestId("procs-restart-cancel"));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(nonListCalls()).toEqual([]);
    expect(props.onOpenTerminal).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(opener);
  });

  it("Escape and a backdrop click cancel; a click inside does not", async () => {
    await openConfirm();
    fireEvent.click(screen.getByRole("alertdialog"));
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    fireEvent.click(screen.getByTestId("procs-restart"));
    fireEvent.click(screen.getByTestId("procs-restart-backdrop"));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(nonListCalls()).toEqual([]);
  });

  it("a reflexive Enter cancels (focus starts on Cancel); Enter on the destructive button confirms", async () => {
    const user = userEvent.setup();
    await openConfirm();
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(nonListCalls()).toEqual([]);

    fireEvent.click(screen.getByTestId("procs-restart"));
    await user.keyboard("{Tab}");
    expect(document.activeElement).toBe(screen.getByTestId("procs-restart-confirm"));
    await user.keyboard("{Enter}");
    await waitFor(() => expect(props.onOpenTerminal).toHaveBeenCalledWith("term-7"));
  });

  it("traps Tab: forward from the last wraps to the first, backward from the first to the last; other keys pass", async () => {
    const { dialog } = await openConfirm();
    const cancel = screen.getByTestId("procs-restart-cancel");
    const confirm = screen.getByTestId("procs-restart-confirm");
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(confirm);
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(cancel);
    // A Tab in the middle is left to the browser (not prevented).
    expect(fireEvent.keyDown(dialog, { key: "Tab" })).toBe(true);
    expect(fireEvent.keyDown(dialog, { key: "a" })).toBe(true);
    expect(screen.getByRole("alertdialog")).toBeTruthy();
  });

  it("a failure is shown inline on the card, nothing opens, and it can be dismissed", async () => {
    ipc.handle("procs_restart_in_ide", () => {
      throw new Error("no such pid");
    });
    await openConfirm();
    fireEvent.click(screen.getByTestId("procs-restart-confirm"));
    const err = await screen.findByTestId("procs-restart-error");
    expect(err.textContent).toContain("Could not restart: no such pid");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(props.onOpenTerminal).not.toHaveBeenCalled();
    fireEvent.click(within(err).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("procs-restart-error")).toBeNull();
  });

  it("the open confirm survives a tab switch (remount) — it lives in the store", async () => {
    await openConfirm();
    cleanup();
    await mount(WEB);
    expect(screen.getByRole("alertdialog")).toBeTruthy();
  });

  it("a confirm open for another app is not shown on this card", async () => {
    await mount(WEB);
    act(() => useProcsStore.setState({ restart: { appKey: "other", phase: "confirm", error: null } }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});

it("holds the poll by itself (so a collapsed sidebar does not freeze uptime)", async () => {
  expect(ipc.calls("procs_list")).toHaveLength(0);
  await mount(WEB);
  expect(ipc.calls("procs_list")).toHaveLength(1);
});

/* ── an app the IDE's own terminal / agent started ── */

const GAZELLE: DevApp = {
  ...WEB,
  key: "gazelle:77",
  pid: 77,
  runtime: "rust",
  name: "gazelle",
  exe: "/work/gazelle/target/debug/gazelle",
  argv: ["target/debug/gazelle", "--port", "3000"],
  cwd: "/work/gazelle",
  ports: [3000],
  console: "ide-terminal",
  logFiles: [],
  origin: "ide",
  terminalId: "t-9",
  agentId: "a-1",
  launchedBy: "claude · gazelle",
};

describe("an IDE app", () => {
  it("ide-terminal: names the terminal by its tab's title and Open terminal focuses that id — no Restart", async () => {
    props.terminalTitle = "claude · gazelle (renamed)";
    await mount(GAZELLE);
    const c = screen.getByTestId("procs-console");
    expect(c.getAttribute("data-console")).toBe("ide-terminal");
    expect(c.textContent).toContain("Console is the terminal claude · gazelle (renamed)");
    expect(within(c).getByTestId("procs-console-terminal").textContent).toBe("claude · gazelle (renamed)");
    expect(screen.queryByTestId("procs-restart")).toBeNull();
    fireEvent.click(within(c).getByTestId("procs-open-terminal"));
    expect(props.onOpenTerminal).toHaveBeenCalledExactlyOnceWith("t-9");
  });

  it("ide-terminal with no tab to name it: launchedBy, then the terminal id", async () => {
    await mount(GAZELLE);
    expect(screen.getByTestId("procs-console-terminal").textContent).toBe("claude · gazelle");
    cleanup();
    await mount({ ...GAZELLE, launchedBy: null });
    expect(screen.getByTestId("procs-console-terminal").textContent).toBe("t-9");
  });

  it("ide-terminal without a terminal id (Rust lost it): says who holds the console, nothing to open, no Restart", async () => {
    await mount({ ...GAZELLE, terminalId: null });
    const c = screen.getByTestId("procs-console");
    expect(c.textContent).toBe("Its console is a ide-terminal held by claude · gazelle — its output shows in that stream, not here.");
    expect(screen.queryByTestId("procs-open-terminal")).toBeNull();
    expect(screen.queryByTestId("procs-restart")).toBeNull();
  });

  it("terminal / pipe of an IDE app: never Restart in the IDE — it is already in the IDE", async () => {
    await mount({ ...GAZELLE, console: "pipe" });
    expect(screen.getByTestId("procs-console").textContent).toBe(
      "Its console is a pipe held by claude · gazelle — its output shows in that stream, not here.",
    );
    expect(screen.queryByTestId("procs-restart")).toBeNull();
    cleanup();
    await mount({ ...GAZELLE, console: "terminal", launchedBy: null });
    expect(screen.getByTestId("procs-console").textContent).toBe(
      "Its console is a terminal held by the IDE — its output shows in that stream, not here.",
    );
    expect(screen.queryByTestId("procs-restart")).toBeNull();
    expect(ideOwnedConsole({ console: "pipe", launchedBy: "bash · w" })).toBe(
      "Its console is a pipe held by bash · w — its output shows in that stream, not here.",
    );
  });

  it("requests → opens IDE traffic on the executable's name; external apps and nameless ones have none", async () => {
    await mount(GAZELLE);
    const btn = screen.getByTestId("procs-requests");
    expect(btn.textContent).toBe("requests →");
    expect(btn.getAttribute("title")).toBe("Show this app's requests in Network › IDE traffic (Process: gazelle)");
    fireEvent.click(btn);
    expect(props.onShowRequests).toHaveBeenCalledExactlyOnceWith("gazelle");
    // The connections link stays, next to it — naming the machine view as the Network toggle
    // does (no status yet and jsdom is not macOS → "Whole computer"; the nettop backend → Mac).
    expect(screen.getAllByTestId("procs-connections")).toHaveLength(1);
    expect(screen.getByTestId("procs-connections")).toHaveAttribute("title", "Show this app's connections in Network › Whole computer");
    act(() =>
      useMachineStore.setState({
        status: { available: true, backend: "macos-nettop", reason: null, running: true, hasBytes: true },
      }),
    );
    expect(screen.getByTestId("procs-connections")).toHaveAttribute("title", "Show this app's connections in Network › Whole Mac");
    act(() => useMachineStore.setState({ status: null }));
    cleanup();
    await mount({ ...GAZELLE, origin: "external" });
    expect(screen.queryByTestId("procs-requests")).toBeNull();
    cleanup();
    await mount({ ...GAZELLE, exe: null, argv: [] });
    expect(screen.queryByTestId("procs-requests")).toBeNull();
  });

  it("a file a Service already tails: “Already streaming as <service>” soloes that stream — no second tail", async () => {
    props.serviceTailing = vi.fn((path: string) =>
      path === "/work/gazelle/gazelle.log" ? { source: "gazelle · bg", name: "gazelle" } : null,
    );
    await mount({
      ...GAZELLE,
      console: "file",
      logFiles: [
        { path: "/work/gazelle/gazelle.log", kind: "stdout" },
        { path: "/work/gazelle/logs/audit.log", kind: "log" },
      ],
    });
    const c = screen.getByTestId("procs-console");
    const already = within(c).getByTestId("procs-already");
    expect(already.textContent).toBe("Already streaming as gazelle");
    expect(already.getAttribute("data-stream")).toBe("/work/gazelle/gazelle.log");
    expect(within(c).queryByTestId("procs-stream-toggle")).toBeNull();
    fireEvent.click(within(c).getByTestId("procs-already-link"));
    expect(props.onStreamStarted).toHaveBeenCalledExactlyOnceWith("gazelle · bg");
    // The other file is not tailed by a service: it still offers Stream.
    const li = screen.getByTestId("procs-log-file");
    expect(within(li).getByTestId("procs-stream-toggle").textContent).toBe("Stream");
    expect(nonListCalls()).toEqual([]);
  });

  it("a tail started HERE stays stoppable even when a service tails the same file too", async () => {
    await mount(WEB);
    fireEvent.click(screen.getByRole("button", { name: "Stream app.log" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Stop app.log" })).toBeTruthy());
    props.serviceTailing = vi.fn(() => ({ source: "web · bg", name: "web" }));
    cleanup();
    await mount(WEB);
    expect(screen.getByRole("button", { name: "Stop app.log" })).toBeTruthy();
    expect(screen.queryByTestId("procs-already")).toBeNull();
  });
});

describe("the capture guard", () => {
  const GAZELLE: DevApp = {
    ...WEB,
    key: "pid:77",
    pid: 77,
    runtime: "rust",
    name: "gazelle",
    exe: "/w/gazelle/target/debug/gazelle",
    argv: ["target/debug/gazelle"],
    console: "ide-terminal",
    origin: "ide",
    terminalId: "T1",
    launchedBy: "claude · gazelle",
    captured: false,
  };

  it("an IDE app started without the proxy: why, and Restart with capture opens the card's own confirm, worded for capture", async () => {
    ipc.handle("procs_list", () => ({ available: true, reason: null, apps: [GAZELLE] }));
    ipc.handle("netmachine_start", () => ({ available: true, backend: "macos-nettop", reason: null, running: true, hasBytes: true }));
    ipc.handle("netmachine_stop", () => ({ available: true, backend: "macos-nettop", reason: null, running: false, hasBytes: true }));
    ipc.handle("netmachine_status", () => ({ available: true, backend: "macos-nettop", reason: null, running: false, hasBytes: true }));
    await mount(GAZELLE);
    expect(screen.getByTestId("procs-uncaptured").textContent).toBe(
      "⚠ gazelle was started without the IDE's proxy — its launcher removed the proxy variables, so its HTTP calls can't reach Network.",
    );
    fireEvent.click(screen.getByTestId("procs-restart-capture"));
    const dialogs = screen.getAllByTestId("procs-restart-dialog");
    expect(dialogs).toHaveLength(1);
    expect(within(dialogs[0]).getByRole("heading").textContent).toBe("Restart gazelle with capture?");
    fireEvent.click(screen.getByTestId("net-idecap-all-conns"));
    expect(props.onShowConnections).toHaveBeenCalledWith(77);
  });

  it("an IDE app that is captured: ✓, Show them → onShowRequests with its process, and where (its terminal's title)", async () => {
    const ok = { ...GAZELLE, captured: true };
    ipc.handle("procs_list", () => ({ available: true, reason: null, apps: [ok] }));
    props.terminalTitle = "claude · fix the build";
    await mount(ok);
    expect(screen.getByTestId("net-idecap-receiving").textContent).toBe("✓ Captured — no requests from gazelle yet Show them");
    expect(screen.getByTestId("net-idecap-where").textContent).toBe(
      "They appear under IDE traffic, Source claude · fix the build, Process gazelle.",
    );
    fireEvent.click(screen.getByTestId("net-idecap-show"));
    expect(props.onShowRequests).toHaveBeenCalledWith("gazelle");
  });

  it("an IDE app with no terminal title or launcher falls back to “its terminal”; an external app shows no capture block", async () => {
    const ok = { ...GAZELLE, captured: true, launchedBy: null };
    ipc.handle("procs_list", () => ({ available: true, reason: null, apps: [ok] }));
    await mount(ok);
    expect(screen.getByTestId("net-idecap-where").textContent).toBe("They appear under IDE traffic, Source its terminal, Process gazelle.");
    cleanup();
    await mount(WEB);
    expect(screen.queryByTestId("net-idecap")).toBeNull();
  });
});
