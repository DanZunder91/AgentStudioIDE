/**
 * DevAppsSection — the sidebar group, rendered over the real IPC seam (the section itself starts
 * the `procs_list` poll, so a test that mocked the store would not see that it does).
 */

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installTauriMock, type TauriMock } from "../../test/tauri-mock";

const plat = vi.hoisted(() => ({ mac: true }));
vi.mock("../shortcuts/shortcuts", () => ({ isMac: () => plat.mac }));

import { DEV_APPS_EMPTY, DEV_APPS_LOADING, DevAppsSection } from "./DevAppsSection";
import * as index from "./index";
import { pollProcsOnce, resetProcsStore, startStream, useProcsStore } from "./procsStore";
import type { DevApp, DevRuntime, ProcsList } from "./procsTypes";

const mk = (runtime: DevRuntime, name: string, over: Partial<DevApp> = {}): DevApp => ({
  key: `${name}:1`,
  pid: 1,
  runtime,
  name,
  exe: null,
  argv: [],
  cwd: null,
  startedMs: null,
  ports: [],
  console: "terminal",
  logFiles: [],
  containerId: null,
  origin: "external",
  terminalId: null,
  agentId: null,
  launchedBy: null,
  captured: null,
  ...over,
});

const APPS: DevApp[] = [
  mk("jvm", "orders-service", { ports: [8080], argv: ["java", "-jar", "orders.jar"], cwd: "/w/orders" }),
  mk("node", "web", { ports: [3000, 5173, 9229] }),
  mk("rust", "gazelle"),
  mk("python", "ml"),
  mk("go", "gw"),
  mk("docker", "pg", { pid: null, containerId: "abc123" }),
];

describe("the Shell runtime (a script whose output goes to a file — procscan `Runtime::Shell`)", () => {
  it("sits in the Shell section, the last one", async () => {
    list = { ...list, apps: [mk("shell", "worker", { console: "file" })] };
    render(<DevAppsSection onSelect={vi.fn()} />);
    const [row] = await screen.findAllByTestId("procs-row");
    expect(row.dataset.runtime).toBe("shell");
    const sections = screen.getAllByTestId("procs-runtime");
    expect(sections[sections.length - 1].contains(row)).toBe(true);
    expect(sections[sections.length - 1].getAttribute("aria-label")).toBe("Shell");
  });
});

let ipc: TauriMock;
let list: ProcsList;
beforeEach(() => {
  plat.mac = true;
  ipc = installTauriMock();
  list = { available: true, reason: null, apps: APPS };
  ipc.handle("procs_list", () => list);
  resetProcsStore();
});
afterEach(() => {
  cleanup();
  resetProcsStore();
  ipc.reset();
});

async function mount(onSelect = vi.fn()) {
  render(<DevAppsSection onSelect={onSelect} />);
  await screen.findAllByTestId("procs-row");
  return onSelect;
}

describe("DevAppsSection", () => {
  it("is exported from the feature's index", () => {
    expect(index.DevAppsSection).toBe(DevAppsSection);
  });

  it("starts the poll on mount and groups every app by runtime, in the fixed section order; rows carry no badge", async () => {
    await mount();
    expect(ipc.calls("procs_list")).toHaveLength(1);
    const rows = screen.getAllByTestId("procs-row");
    expect(rows.map((r) => r.querySelector(".procs-side__name")?.textContent)).toEqual([
      "gazelle",
      "orders-service",
      "web",
      "ml",
      "gw",
      "pg",
    ]);
    // The section heading names the runtime; the rows do not repeat it.
    expect(screen.queryAllByTestId("procs-badge")).toEqual([]);
    expect(rows.map((r) => r.closest("[data-testid=procs-runtime]")?.getAttribute("aria-label"))).toEqual([
      "Rust · Cargo",
      "JVM",
      "Node · JS",
      "Python",
      "Go",
      "Docker",
    ]);
  });

  it("shows ports as :port (two, then +N) and nothing for an app without any", async () => {
    await mount();
    const rows = screen.getAllByTestId("procs-row");
    expect(within(rows[1]).getByTestId("procs-ports").textContent).toBe(":8080");
    expect(within(rows[2]).getByTestId("procs-ports").textContent).toBe(":3000 :5173 +1");
    expect(within(rows[0]).queryByTestId("procs-ports")).toBeNull();
  });

  it("titles each row with pid (or container), cwd and the masked command", async () => {
    list = { ...list, apps: [...APPS, mk("docker", "orphan", { pid: null, containerId: null })] };
    await mount();
    const rows = screen.getAllByTestId("procs-row");
    expect(rows[1].title).toBe("pid 1\n/w/orders\njava -jar orders.jar");
    expect(rows[0].title).toBe("pid 1");
    expect(rows[5].title).toBe("container abc123");
    expect(rows[6].title).toBe("container ?");
  });

  it("marks ● only on the app with an active stream", async () => {
    ipc.handle("logstream_tail_app", () => ({ key: "k", source: "web · a.log" }));
    await mount();
    expect(screen.queryByTestId("procs-live")).toBeNull();
    await act(() => startStream(APPS[1], "/a.log"));
    const live = screen.getAllByTestId("procs-live");
    expect(live).toHaveLength(1);
    expect(live[0].closest("[data-testid=procs-row]")?.getAttribute("data-key")).toBe("web:1");
  });

  it("selects on click (store + onSelect), and a second click deselects", async () => {
    const onSelect = await mount();
    const row = screen.getAllByTestId("procs-row")[2];
    expect(row.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(row);
    expect(onSelect).toHaveBeenLastCalledWith(APPS[1]);
    expect(useProcsStore.getState().selectedKey).toBe("web:1");
    expect(row.getAttribute("aria-pressed")).toBe("true");
    expect(row.className).toContain("procs-side__row--sel");
    fireEvent.click(row);
    expect(onSelect).toHaveBeenLastCalledWith(null);
    expect(useProcsStore.getState().selectedKey).toBeNull();
    expect(row.getAttribute("aria-pressed")).toBe("false");
  });

  it("is the Apps group, and its heading says so on every platform", async () => {
    await mount();
    const group = screen.getByRole("group", { name: "Apps" });
    expect(group.querySelector(".procs-side__heading")?.textContent).toBe("Apps");
    cleanup();
    plat.mac = false;
    await mount();
    expect(screen.getByRole("group", { name: "Apps" })).toBeTruthy();
  });
});

describe("runtime sections (grouped by runtime, every option shown)", () => {
  const ide = (runtime: DevRuntime, name: string, over: Partial<DevApp> = {}): DevApp =>
    mk(runtime, name, {
      key: `${name}:ide`,
      origin: "ide",
      terminalId: "t-1",
      agentId: "a-1",
      launchedBy: "claude · gazelle",
      console: "ide-terminal",
      ...over,
    });
  const heads = () =>
    screen.getAllByTestId("procs-runtime").map((sec) => ({
      runtime: sec.dataset.runtime,
      label: sec.querySelector(".procs-rt__label")?.textContent,
      count: within(sec).getByTestId("procs-runtime-count").textContent,
      open: within(sec).getByTestId("procs-runtime-head").getAttribute("aria-expanded"),
      empty: sec.className.includes("procs-rt--empty"),
    }));
  const head = (rt: string) =>
    within(screen.getAllByTestId("procs-runtime").find((x) => x.dataset.runtime === rt) as HTMLElement).getByTestId(
      "procs-runtime-head",
    );

  it("every runtime has a section, in order, with its count — empty ones dimmed and closed", async () => {
    list = { available: true, reason: null, apps: [mk("node", "web"), mk("rust", "gazelle"), mk("node", "api")] };
    await mount();
    expect(heads()).toEqual([
      { runtime: "rust", label: "Rust · Cargo", count: "1", open: "true", empty: false },
      { runtime: "jvm", label: "JVM", count: "0", open: "false", empty: true },
      { runtime: "node", label: "Node · JS", count: "2", open: "true", empty: false },
      { runtime: "python", label: "Python", count: "0", open: "false", empty: true },
      { runtime: "go", label: "Go", count: "0", open: "false", empty: true },
      { runtime: "docker", label: "Docker", count: "0", open: "false", empty: true },
      { runtime: "shell", label: "Shell", count: "0", open: "false", empty: true },
    ]);
    expect(screen.queryAllByTestId("procs-runtime-none")).toEqual([]);
  });

  it("nothing running at all: still every section, all at 0, plus the one-line empty note", async () => {
    list = { available: true, reason: null, apps: [] };
    render(<DevAppsSection onSelect={vi.fn()} />);
    await screen.findByText(DEV_APPS_EMPTY);
    expect(heads().map((h) => `${h.label} ${h.count}`)).toEqual([
      "Rust · Cargo 0",
      "JVM 0",
      "Node · JS 0",
      "Python 0",
      "Go 0",
      "Docker 0",
      "Shell 0",
    ]);
  });

  it("a heading click closes / opens it; an opened empty one says “Nothing running”; the choice survives a remount", async () => {
    list = { available: true, reason: null, apps: [mk("rust", "gazelle")] };
    await mount();
    fireEvent.click(head("rust"));
    expect(head("rust").getAttribute("aria-expanded")).toBe("false");
    expect(head("rust").textContent).toBe("▸Rust · Cargo1");
    expect(head("rust").title).toBe("Show the Rust · Cargo apps");
    expect(screen.queryAllByTestId("procs-row")).toEqual([]);
    fireEvent.click(head("go"));
    expect(head("go").getAttribute("aria-expanded")).toBe("true");
    expect(head("go").title).toBe("Hide the Go apps");
    expect(screen.getByTestId("procs-runtime-none").textContent).toBe("Nothing running");
    expect(useProcsStore.getState().runtimeOpen).toEqual({ rust: false, go: true });
    // A tab switch remounts the sidebar; the choices are in the store.
    cleanup();
    render(<DevAppsSection onSelect={vi.fn()} />);
    await screen.findAllByTestId("procs-runtime");
    expect(head("rust").getAttribute("aria-expanded")).toBe("false");
    expect(head("go").getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(head("rust"));
    expect(screen.getAllByTestId("procs-row")).toHaveLength(1);
  });

  it("within a section: a live stream first, then the IDE's apps, then external — else Rust's order; every row tagged", async () => {
    list = {
      available: true,
      reason: null,
      apps: [
        mk("node", "ext-a"),
        ide("node", "ide-b", { launchedBy: null }),
        mk("node", "ext-live"),
        ide("node", "ide-c"),
        mk("node", "ext-d"),
      ],
    };
    render(<DevAppsSection onSelect={vi.fn()} liveKeys={new Set(["ext-live:1"])} />);
    await screen.findAllByTestId("procs-row");
    const rows = screen.getAllByTestId("procs-row");
    expect(
      rows.map((r) => `${r.querySelector(".procs-side__name")?.textContent} [${within(r).getByTestId("procs-origin").textContent}]`),
    ).toEqual([
      "ext-live [external]",
      "ide-b [by the IDE]",
      "ide-c [by claude · gazelle]",
      "ext-a [external]",
      "ext-d [external]",
    ]);
    expect(rows.map((r) => r.dataset.origin)).toEqual(["external", "ide", "ide", "external", "external"]);
    expect(within(rows[1]).getByTestId("procs-origin").className).toBe("procs-side__tag procs-side__tag--ide");
    expect(within(rows[0]).getByTestId("procs-origin").className).toBe("procs-side__tag procs-side__tag--external");
    // The host's liveKeys light ● like a stream started from the card.
    expect(within(rows[0]).getByTestId("procs-live")).toBeTruthy();
    expect(screen.getAllByTestId("procs-live")).toHaveLength(1);
  });

  it("a stream started from the card also sorts its app first", async () => {
    ipc.handle("logstream_tail_app", () => ({ key: "k", source: "b · a.log" }));
    list = { available: true, reason: null, apps: [mk("node", "a", { key: "a:1" }), mk("node", "b", { key: "b:1" })] };
    await mount();
    await act(() => startStream(list.apps[1], "/a.log"));
    expect(screen.getAllByTestId("procs-row").map((r) => r.dataset.key)).toEqual(["b:1", "a:1"]);
  });

  it("renderUnder keeps an app's streams under ITS row, in its section", async () => {
    list = { available: true, reason: null, apps: [mk("node", "web"), ide("rust", "gazelle")] };
    render(<DevAppsSection onSelect={vi.fn()} renderUnder={(app) => <i data-testid="under">{app.name}</i>} />);
    await screen.findAllByTestId("procs-row");
    const under = screen.getAllByTestId("under");
    expect(under.map((u) => u.textContent)).toEqual(["gazelle", "web"]);
    expect(under[0].previousElementSibling?.getAttribute("data-key")).toBe("gazelle:ide");
    expect(under[0].closest("[data-testid=procs-runtime]")?.getAttribute("data-runtime")).toBe("rust");
  });

  it("`leading` renders right under the heading, in every state", async () => {
    render(<DevAppsSection onSelect={vi.fn()} leading={<b data-testid="lead">All apps</b>} />);
    await screen.findAllByTestId("procs-row");
    expect(screen.getByTestId("lead").previousElementSibling?.className).toBe("procs-side__heading");
    cleanup();
    resetProcsStore();
    ipc.handle("procs_list", () => new Promise(() => {}));
    render(<DevAppsSection onSelect={vi.fn()} leading={<b data-testid="lead">All apps</b>} />);
    expect(screen.getByTestId("lead").nextElementSibling?.getAttribute("data-testid")).toBe("procs-empty");
  });
});

describe("same-name apps", () => {
  it("two apps with one name are told apart by pid; a unique name shows none; a pid-less one never", async () => {
    list = {
      available: true,
      reason: null,
      apps: [
        mk("node", "repo", { key: "pid:11", pid: 11 }),
        mk("node", "repo", { key: "pid:12", pid: 12 }),
        mk("docker", "repo", { key: "docker:x", pid: null, containerId: "x" }),
        mk("rust", "gazelle", { key: "pid:13", pid: 13 }),
      ],
    };
    await mount();
    const rows = screen.getAllByTestId("procs-row");
    // Grouped: Rust (gazelle), then Node (the two repos), then Docker (the container).
    expect(rows.map((r) => r.querySelector('[data-testid="procs-pid"]')?.textContent ?? null)).toEqual([
      null,
      "pid 11",
      "pid 12",
      null,
    ]);
  });
});

describe("DevAppsSection states", () => {
  it("says it is looking before the first answer", () => {
    ipc.handle("procs_list", () => new Promise(() => {}));
    render(<DevAppsSection onSelect={vi.fn()} />);
    expect(screen.getByTestId("procs-empty").textContent).toBe(DEV_APPS_LOADING);
  });

  it("says why when the first poll failed", async () => {
    ipc.handle("procs_list", () => {
      throw new Error("scan exploded");
    });
    render(<DevAppsSection onSelect={vi.fn()} />);
    expect((await screen.findByText("Could not list apps: scan exploded")).getAttribute("data-testid")).toBe("procs-empty");
  });

  it("marks the list stale when a later poll fails, keeping the rows", async () => {
    await mount();
    expect(screen.queryByTestId("procs-stale")).toBeNull();
    ipc.handle("procs_list", () => {
      throw new Error("later");
    });
    await act(() => pollProcsOnce());
    expect(screen.getByTestId("procs-stale").title).toBe("Could not refresh: later");
    expect(screen.getAllByTestId("procs-row")).toHaveLength(6);
  });

  it("shows Rust's reason when unavailable, and a fallback when it gave none", async () => {
    list = { available: false, reason: "Windows is not supported yet", apps: [] };
    render(<DevAppsSection onSelect={vi.fn()} />);
    expect((await screen.findByTestId("procs-unavailable")).textContent).toBe("Windows is not supported yet");
    list = { available: false, reason: null, apps: [] };
    await act(() => pollProcsOnce());
    expect(screen.getByTestId("procs-unavailable").textContent).toBe("Not available on this system.");
  });

  it("shows Rust's partial note (a reason while available) above the rows, and none without one", async () => {
    list = { available: true, reason: "Docker is not running", apps: APPS };
    await mount();
    expect(screen.getByTestId("procs-note").textContent).toBe("Docker is not running");
    expect(screen.getAllByTestId("procs-row")).toHaveLength(6);
    list = { available: true, reason: null, apps: APPS };
    await act(() => pollProcsOnce());
    expect(screen.queryByTestId("procs-note")).toBeNull();
    list = { available: false, reason: "nope", apps: [] };
    await act(() => pollProcsOnce());
    // Unavailable: the reason is the body, not a note on top of it.
    expect(screen.queryByTestId("procs-note")).toBeNull();
    expect(screen.getByTestId("procs-unavailable").textContent).toBe("nope");
  });

  it("says so when nothing is running", async () => {
    list = { available: true, reason: null, apps: [] };
    render(<DevAppsSection onSelect={vi.fn()} />);
    expect((await screen.findByText(DEV_APPS_EMPTY)).getAttribute("data-testid")).toBe("procs-empty");
    expect(screen.queryAllByTestId("procs-row")).toEqual([]);
  });
});

describe("DevAppsSection slots (the Logs sidebar's mount)", () => {
  it("renders renderUnder(app) directly under that app's row, and nothing extra without it", async () => {
    render(
      <DevAppsSection
        onSelect={vi.fn()}
        renderUnder={(app) => (app.name === "web" ? <span data-testid="under">web streams</span> : null)}
      />,
    );
    await screen.findAllByTestId("procs-row");
    const under = screen.getByTestId("under");
    // Its previous sibling is the web row: the host's rows sit under the app they belong to.
    expect((under.previousElementSibling as HTMLElement).getAttribute("data-key")).toBe("web:1");
    cleanup();
    await mount();
    expect(screen.queryByTestId("under")).toBeNull();
  });

  it("renders `trailing` after the list in every state — listed, loading, unavailable", async () => {
    const trailing = <span data-testid="trail">orphan</span>;
    render(<DevAppsSection onSelect={vi.fn()} trailing={trailing} />);
    await screen.findAllByTestId("procs-row");
    const section = screen.getByTestId("procs-section");
    expect(section.lastElementChild?.getAttribute("data-testid")).toBe("trail");
    cleanup();
    resetProcsStore();
    ipc.handle("procs_list", () => new Promise(() => {}));
    render(<DevAppsSection onSelect={vi.fn()} trailing={trailing} />);
    expect(screen.getByTestId("procs-empty")).toBeTruthy();
    expect(screen.getByTestId("trail")).toBeTruthy();
    cleanup();
    resetProcsStore();
    list = { available: false, reason: "nope", apps: [] };
    ipc.handle("procs_list", () => list);
    render(<DevAppsSection onSelect={vi.fn()} trailing={trailing} />);
    await screen.findByTestId("procs-unavailable");
    expect(screen.getByTestId("trail")).toBeTruthy();
  });
});

describe("the capture guard on a row", () => {
  it("an IDE app started without the IDE's proxy carries ⚠ with why; a captured, unknown or external one does not", async () => {
    list = {
      ...list,
      apps: [
        mk("rust", "gazelle", { key: "g:1", origin: "ide", terminalId: "T", launchedBy: "zsh", captured: false }),
        mk("node", "web", { key: "w:1", origin: "ide", terminalId: "T", launchedBy: "zsh", captured: true }),
        mk("go", "gw", { key: "gw:1", origin: "ide", terminalId: "T", launchedBy: "zsh", captured: null }),
        mk("python", "ml", { key: "ml:1" }),
      ],
    };
    render(<DevAppsSection onSelect={vi.fn()} />);
    await screen.findAllByTestId("procs-row");
    const marks = screen.getAllByTestId("procs-uncaptured-mark");
    expect(marks).toHaveLength(1);
    expect(marks[0].closest("[data-testid='procs-row']")?.getAttribute("data-key")).toBe("g:1");
    expect(marks[0].getAttribute("title")).toBe("gazelle was started without the IDE's proxy — its HTTP calls can't show in Network.");
  });

  it("a host's rowLead / rowTrail wrap the row in a line, replace the ⚠ and take the click with onRowClick", async () => {
    list = { ...list, apps: [mk("rust", "gazelle", { key: "g:1", origin: "ide", terminalId: "T", captured: false })] };
    const onRowClick = vi.fn();
    const onSelect = vi.fn();
    render(
      <DevAppsSection
        onSelect={onSelect}
        onRowClick={onRowClick}
        isSelected={() => true}
        rowLead={(a) => <i data-testid="lead">{a.name}</i>}
        rowTrail={() => <b data-testid="trail" />}
      />,
    );
    const [row] = await screen.findAllByTestId("procs-row");
    const line = screen.getByTestId("procs-line");
    expect(line.firstElementChild?.getAttribute("data-testid")).toBe("lead");
    expect(line.lastElementChild?.getAttribute("data-testid")).toBe("trail");
    expect(row.getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByTestId("procs-uncaptured-mark")).toBeNull();
    fireEvent.click(row);
    expect(onRowClick).toHaveBeenCalledWith(expect.objectContaining({ key: "g:1" }));
    expect(onSelect).not.toHaveBeenCalled();
    expect(useProcsStore.getState().selectedKey).toBeNull();
  });
});
