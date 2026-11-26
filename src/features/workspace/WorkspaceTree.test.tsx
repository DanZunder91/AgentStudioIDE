/** `workspaceIpc`, the folder picker and `fleetIpc` (`addBrowseRoot`'s `push_recent_project`) are
 * mocked at the module boundary: none belongs in jsdom. */

import { StrictMode } from "react";

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock only the invoke-backed IPC functions; keep the REAL pure path helpers
// (joinPath/parentPath/basename) the tree joins/splits paths with.
const workspaceIpc = vi.hoisted(() => ({
  readDir: vi.fn(),
  createDirectory: vi.fn(),
  createFile: vi.fn(),
  renamePath: vi.fn(),
  deletePath: vi.fn(),
}));
vi.mock("./workspaceIpc", async (importActual) => {
  const actual = await importActual<typeof import("./workspaceIpc")>();
  return { ...actual, ...workspaceIpc };
});

// The Files panel's "Open a folder" opens the native picker; mock it (default:
// cancelled). Same pattern as LeftRail's project picker.
const dialog = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => dialog);

// `addBrowseRoot` pushes to the persisted recents AND installs the ad-hoc hook
// for the opened folder — both best-effort; stub the IPC for both.
const fleetIpc = vi.hoisted(() => ({
  pushRecentProject: vi.fn().mockResolvedValue(undefined),
  ensureAgentHooks: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../fleet/fleetIpc", () => fleetIpc);

// Spy the git poller and `gitFileRestore` (a real one rewrites files over Tauri); the store and
// selectors stay REAL. Spreading `importActual` keeps every other barrel export real.
const gitMock = vi.hoisted(() => ({
  startGitPolling: vi.fn(() => vi.fn()),
  gitFileRestore: vi.fn(),
}));
vi.mock("../git", async (importActual) => {
  const actual = await importActual<typeof import("../git")>();
  return { ...actual, ...gitMock };
});

// `reloadFromDisk` is a spy: this file asserts the tree ASKS for the reload. Deliberately NOT
// mocked: `opensInExternalBrowser`, so the menu and the preview consult the same predicate.
const editorMock = vi.hoisted(() => ({ reloadFromDisk: vi.fn() }));
vi.mock("../editor", async (importActual) => {
  const actual = await importActual<typeof import("../editor")>();
  return { ...actual, ...editorMock };
});

// The Rust behind these launches real apps, so mocked at the boundary; `cachedBrowsers` is a
// function so each test decides synchronously what the menu builder sees (never awaited).
const browserIpc = vi.hoisted(() => ({
  primeBrowsers: vi.fn(),
  cachedBrowsers: vi.fn(),
  openInBrowser: vi.fn(),
}));
vi.mock("./browserIpc", async (importActual) => {
  const actual = await importActual<typeof import("./browserIpc")>();
  return { ...actual, ...browserIpc };
});

import { useAppStore } from "../../app/store";
import {
  asAgentId,
  type AgentEvent,
  type AgentId,
  type FsEntry,
  type GitStatus,
  type PaneId,
  type TabId,
} from "../../app/types";
import { resolveFileIconId } from "../../lib/fileIcons";
import { fireDragLeave, makeDataTransfer } from "../../test/dnd";
import { resetFleetStore } from "../../test/fleet-harness";
import { resetStore } from "../../test/store-harness";
import { useGitStore } from "../git";
import { useLogStore } from "../logs";
import type { BrowserChoice } from "./browserIpc";
import {
  ENTRY_DND_MIME,
  FOLDER_DND_MIME,
  ROOT_READ_RETRY_MS,
  ROOT_READ_TRIES,
  WorkspaceTree,
} from "./WorkspaceTree";

const id = (s: string) => s as AgentId;
const fleet = () => useAppStore.getState().agentActions;
const ws = () => useAppStore.getState().workspaceActions;
const state = () => useAppStore.getState();

const started = (agentId: string, cwd: string): AgentEvent => ({
  t: "agent_started",
  agentId: id(agentId),
  parentId: null,
  title: agentId,
  cwd,
  branch: "trunk",
  runtime: "claude-code",
});

const dir = (name: string, path: string): FsEntry => ({ name, path, isDir: true });
const file = (name: string, path: string): FsEntry => ({ name, path, isDir: false });

/** A readDir that answers per-path from a table; unknown paths reject. */
const serve = (table: Record<string, FsEntry[]>) =>
  workspaceIpc.readDir.mockImplementation((p: string) =>
    p in table ? Promise.resolve(table[p]) : Promise.reject(new Error(`no ${p}`)),
  );

/** Open a browse-only root — the simplest way to seed a single root for the
 *  inner-tree tests (the tree body is agnostic to how its root arrived). */
const openRoot = (path: string) =>
  act(() => {
    ws().addBrowseRoot(path);
  });

/** Seed a root agent whose cwd becomes an (uncloseable) agent-cwd root. */
const startAgent = (agentId: string, cwd: string) =>
  act(() => {
    fleet().applyAgentEvent(started(agentId, cwd));
  });

const names = (scope: HTMLElement) =>
  Array.from(scope.querySelectorAll(".workspace-node__name")).map((e) => e.textContent);

const rootHeaders = () =>
  screen.queryAllByTestId("workspace-root").map((el) => el.getAttribute("data-path"));

const headerFor = (path: string) =>
  screen.getAllByTestId("workspace-root").find((el) => el.getAttribute("data-path") === path)!;

/** A DataTransfer stub carrying the dragged folder path under our folder MIME
 *  (`makeDataTransfer` from the shared DnD helpers — jsdom ships no DataTransfer). */
const folderDrag = (draggedPath: string) => makeDataTransfer({ [FOLDER_DND_MIME]: draggedPath });

/** A DataTransfer carrying an entry path under the entry-move MIME. */
const entryDrag = (draggedPath: string) => makeDataTransfer({ [ENTRY_DND_MIME]: draggedPath });

/** The row div for `path` of the given kind (there can be several per kind). */
const nodeByPath = (testid: "ws-file" | "ws-dir", path: string) =>
  screen.getAllByTestId(testid).find((el) => el.getAttribute("data-path") === path)!;

/** Seed the git store the way the (mocked-out) poller would: one root's
 *  status snapshot, absolute paths matching the tree's `data-path`. */
const seedGit = (root: string, changes: Array<{ path: string; status: GitStatus }>) =>
  act(() => {
    useGitStore.setState({ status: { [root]: { branch: "main", changes, error: null } } });
  });

const editorTabs = () =>
  Object.values(useAppStore.getState().tabs).filter((t) => t.ref.kind === "editor");
const editorPaths = () =>
  editorTabs().map((t) => (t.ref.kind === "editor" ? t.ref.path : ""));

beforeEach(() => {
  resetStore();
  resetFleetStore();
  // resetStore leaves the rail-layout prefs untouched; clear them so a collapse or
  // reorder from one test never leaks into the next (collapse and order state).
  act(() => {
    useAppStore.setState((s) => {
      s.folderOrder = [];
      s.collapsedRoots = new Set();
    });
  });
  workspaceIpc.readDir.mockReset();
  // The mutation IPCs default to success; individual tests override to reject.
  workspaceIpc.createDirectory.mockReset().mockResolvedValue(undefined);
  workspaceIpc.createFile.mockReset().mockResolvedValue(undefined);
  workspaceIpc.renamePath.mockReset().mockResolvedValue(undefined);
  workspaceIpc.deletePath.mockReset().mockResolvedValue(undefined);
  dialog.open.mockReset();
  fleetIpc.pushRecentProject.mockClear();
  // Git store back to empty (setState merges, so the real actions survive) and
  // a fresh polling spy — no status snapshot leaks between tests.
  act(() => {
    useGitStore.setState({ status: {}, prs: {}, prAuthorFilter: null });
  });
  gitMock.startGitPolling.mockClear();
  gitMock.gitFileRestore.mockReset().mockResolvedValue(undefined);
  editorMock.reloadFromDisk.mockClear();
  // Open in Browser: nothing primed by default — the "system default" fallback leaf. Tests
  // that want the submenu set `cachedBrowsers` to a list.
  browserIpc.primeBrowsers.mockReset().mockResolvedValue([]);
  browserIpc.cachedBrowsers.mockReset().mockReturnValue(null);
  browserIpc.openInBrowser.mockReset().mockResolvedValue(undefined);
  // The diagnostics log is a module singleton shared with every other suite;
  // a leaked line would make a "did we log it?" assertion pass for free.
  useLogStore.getState().clear();
});

afterEach(() => {
  cleanup();
});

describe("WorkspaceTree — multi-root shell", () => {
  it("shows the 'Open a folder' empty state — and reads nothing — with no roots", () => {
    render(<WorkspaceTree />);

    expect(screen.getByTestId("workspace-tree")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open a folder" })).toBeInTheDocument();
    expect(workspaceIpc.readDir).not.toHaveBeenCalled();
  });

  it("opens a folder from the picker → adds a browse root that renders", async () => {
    serve({ "/picked": [file("hi.ts", "/picked/hi.ts")] });
    dialog.open.mockResolvedValue("/picked");
    render(<WorkspaceTree />);

    await userEvent.setup().click(screen.getByRole("button", { name: "Open a folder" }));

    // The picked folder became a browse root, authorized for read_dir…
    expect(state().browseRoots).toEqual(["/picked"]);
    expect(fleetIpc.pushRecentProject).toHaveBeenCalledWith("/picked");
    // …and its root header + files paint.
    expect(await screen.findByText("hi.ts")).toBeInTheDocument();
    expect(rootHeaders()).toEqual(["/picked"]);
  });

  it("ignores a cancelled picker (no root added)", async () => {
    dialog.open.mockResolvedValue(null); // user cancelled
    render(<WorkspaceTree />);

    await userEvent.setup().click(screen.getByRole("button", { name: "Open a folder" }));

    expect(state().browseRoots).toEqual([]);
    expect(screen.queryByTestId("workspace-root")).toBeNull();
  });

  it("renders one root per agent folder, deduping agents that share a cwd", async () => {
    serve({ "/wa": [file("a.ts", "/wa/a.ts")], "/wb": [file("b.ts", "/wb/b.ts")] });
    act(() => {
      fleet().applyAgentEvent(started("A1", "/wa"));
      fleet().applyAgentEvent(started("A2", "/wa")); // same folder → still one root
      fleet().applyAgentEvent(started("B", "/wb"));
    });
    render(<WorkspaceTree />);

    await screen.findByText("a.ts");
    // Two roots (not three): /wa is shared by A1 and A2.
    expect(rootHeaders()).toEqual(["/wa", "/wb"]);
    expect(await screen.findByText("b.ts")).toBeInTheDocument();
  });

  it("unions browse roots after agent folders, in order", async () => {
    serve({ "/wa": [file("a.ts", "/wa/a.ts")], "/browse": [file("z.ts", "/browse/z.ts")] });
    startAgent("A", "/wa");
    openRoot("/browse");
    render(<WorkspaceTree />);

    await screen.findByText("a.ts");
    expect(rootHeaders()).toEqual(["/wa", "/browse"]);
  });

  it("gives a browse-only root a ✕ that closes it; an agent-cwd root has none", async () => {
    serve({ "/wa": [file("a.ts", "/wa/a.ts")], "/browse": [file("z.ts", "/browse/z.ts")] });
    startAgent("A", "/wa");
    openRoot("/browse");
    render(<WorkspaceTree />);
    await screen.findByText("a.ts");

    // The agent-cwd root ("wa") has no close button; the browse-only one ("browse") does.
    expect(screen.queryByRole("button", { name: "Close folder wa" })).toBeNull();
    const close = screen.getByRole("button", { name: "Close folder browse" });

    await userEvent.setup().click(close);
    expect(state().browseRoots).toEqual([]);
    expect(rootHeaders()).toEqual(["/wa"]); // only the agent folder remains
  });

  it("collapsing a root header hides its files; re-expanding shows them, via the store", async () => {
    serve({ "/w": [file("keep.ts", "/w/keep.ts")] });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("keep.ts");

    const user = userEvent.setup();
    const header = screen.getByTestId("workspace-root");
    await user.click(header); // collapse the whole root
    expect(screen.queryByText("keep.ts")).toBeNull();
    // Collapse is store-backed, so it lands in `collapsedRoots` — which
    // is persisted, so the folder reopens collapsed after a restart.
    expect(state().collapsedRoots.has("/w")).toBe(true);

    await user.click(header); // re-expand
    expect(await screen.findByText("keep.ts")).toBeInTheDocument();
    expect(state().collapsedRoots.has("/w")).toBe(false);
  });

  it("renders no root for a rootAgentId whose record hasn't arrived, but keeps browse roots", async () => {
    serve({ "/browse": [file("z.ts", "/browse/z.ts")] });
    act(() => {
      // A root id can be listed a beat before its record lands (event ordering).
      useAppStore.setState((s) => {
        s.rootAgentIds.push(asAgentId("ghost"));
      });
      ws().addBrowseRoot("/browse");
    });
    render(<WorkspaceTree />);

    await screen.findByText("z.ts");
    // The ghost contributes no root; the browse-only one still shows its ✕.
    expect(rootHeaders()).toEqual(["/browse"]);
    expect(screen.getByRole("button", { name: "Close folder browse" })).toBeInTheDocument();
  });
});

describe("WorkspaceTree — per-root tree body", () => {
  it("loads a root's children and lists directories before files", async () => {
    serve({
      "/w": [
        file("zebra.ts", "/w/zebra.ts"),
        dir("src", "/w/src"),
        file("app.ts", "/w/app.ts"),
        dir("docs", "/w/docs"),
      ],
    });
    openRoot("/w");
    const { container } = render(<WorkspaceTree />);

    await screen.findByText("src");
    // Dirs first (alphabetical), then files (alphabetical) — stable regardless
    // of the order Rust returned.
    expect(names(container)).toEqual(["docs", "src", "app.ts", "zebra.ts"]);
    expect(workspaceIpc.readDir).toHaveBeenCalledTimes(1);
    expect(workspaceIpc.readDir).toHaveBeenCalledWith("/w");
  });

  it("lazy-loads a folder on first expand, caches it across collapse/re-expand", async () => {
    serve({
      "/w": [dir("src", "/w/src")],
      "/w/src": [file("main.rs", "/w/src/main.rs")],
    });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("src");
    expect(workspaceIpc.readDir).toHaveBeenCalledTimes(1); // root only

    const user = userEvent.setup();
    await user.click(screen.getByText("src")); // expand → reads /w/src
    await screen.findByText("main.rs");
    expect(workspaceIpc.readDir).toHaveBeenCalledTimes(2);
    expect(workspaceIpc.readDir).toHaveBeenCalledWith("/w/src");

    await user.click(screen.getByText("src")); // collapse hides the child
    expect(screen.queryByText("main.rs")).toBeNull();

    await user.click(screen.getByText("src")); // re-expand: cached, no new read
    expect(screen.getByText("main.rs")).toBeInTheDocument();
    expect(workspaceIpc.readDir).toHaveBeenCalledTimes(2);
  });

  it("shows a loading note while a read is in flight", () => {
    workspaceIpc.readDir.mockReturnValue(new Promise<FsEntry[]>(() => {})); // never resolves
    openRoot("/w");
    render(<WorkspaceTree />);

    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("renders an empty-folder note for a root that has no children", async () => {
    // Root "/" also exercises the folderName fallback (no trailing segment).
    serve({ "/": [] });
    openRoot("/");
    const { container } = render(<WorkspaceTree />);

    await screen.findByText("Empty folder.");
    // The root header carries the path as its title (basename "/" for the label).
    expect(within(container).getByTestId("workspace-root")).toHaveAttribute("data-path", "/");
    expect(names(container)).toEqual([]);
  });

  it("retries a failing ROOT read, then concedes a calm state without crashing", async () => {
    vi.useFakeTimers();
    try {
      workspaceIpc.readDir.mockRejectedValue(new Error("outside workspace"));
      openRoot("/w");
      render(<WorkspaceTree />);

      // Drive every retry interval; each attempt's rejection is a microtask the
      // async advance flushes before the next timer fires.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ROOT_READ_RETRY_MS * ROOT_READ_TRIES);
      });

      expect(screen.getByText("Can’t read this folder.")).toBeInTheDocument();
      // It genuinely retried (not one-and-done) before conceding.
      expect(workspaceIpc.readDir).toHaveBeenCalledTimes(ROOT_READ_TRIES);
      // The tree container is intact — the failure did not take the rail down.
      expect(screen.getByTestId("workspace-tree")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers a ROOT read that briefly fails then succeeds (just-registered folder)", async () => {
    vi.useFakeTimers();
    try {
      // The folder is out-of-scope on the first read (registration still in flight),
      // then in-scope on the retry — the "Can't read this folder." bug.
      workspaceIpc.readDir
        .mockRejectedValueOnce(new Error("outside workspace"))
        .mockResolvedValue([file("app.ts", "/w/app.ts")]);
      openRoot("/w");
      render(<WorkspaceTree />);

      // After the first rejection it stays on "Loading…" — the error never flashes.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.queryByText("Can’t read this folder.")).toBeNull();
      expect(screen.getByText("Loading…")).toBeInTheDocument();

      // The retry lands in-scope: files paint, still no error.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ROOT_READ_RETRY_MS);
      });
      expect(screen.getByText("app.ts")).toBeInTheDocument();
      expect(screen.queryByText("Can’t read this folder.")).toBeNull();
      expect(workspaceIpc.readDir).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("swallows a ROOT read that RESOLVES after unmount (no state update on a dead tree)", async () => {
    // A deferred read still in flight when the tree unmounts: the effect cleanup
    // flips `cancelled`, so the late success must be dropped (no setState warning).
    let resolve!: (v: FsEntry[]) => void;
    workspaceIpc.readDir.mockReturnValueOnce(
      new Promise<FsEntry[]>((r) => {
        resolve = r;
      }),
    );
    openRoot("/w");
    const { unmount } = render(<WorkspaceTree />);

    unmount(); // cleanup runs → cancelled = true, while the read is still pending
    await act(async () => {
      resolve([file("late.ts", "/w/late.ts")]);
      await Promise.resolve();
    });

    // The guard swallowed it: only the single in-flight read happened, no retry.
    expect(workspaceIpc.readDir).toHaveBeenCalledTimes(1);
  });

  it("swallows a ROOT read that REJECTS after unmount (no retry, no state update)", async () => {
    let reject!: (e: Error) => void;
    workspaceIpc.readDir.mockReturnValueOnce(
      new Promise<FsEntry[]>((_r, rej) => {
        reject = rej;
      }),
    );
    openRoot("/w");
    const { unmount } = render(<WorkspaceTree />);

    unmount(); // cancelled = true before the read settles
    await act(async () => {
      reject(new Error("settled after unmount"));
      await Promise.resolve();
    });

    // The reject handler returned early on `cancelled`: no retry was scheduled.
    expect(workspaceIpc.readDir).toHaveBeenCalledTimes(1);
  });

  it("keeps the tree usable when a CHILD folder read fails, and never retries it", async () => {
    serve({
      "/w": [dir("locked", "/w/locked"), file("keep.ts", "/w/keep.ts")],
      // "/w/locked" is absent → its read rejects.
    });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("keep.ts");

    const user = userEvent.setup();
    await user.click(screen.getByText("locked")); // expand → read fails
    expect(await screen.findByText("Can’t read this folder.")).toBeInTheDocument();
    expect(screen.getByText("keep.ts")).toBeInTheDocument(); // sibling still there
    const afterFail = workspaceIpc.readDir.mock.calls.length;

    // Collapse then re-expand a failed folder: it must not hammer read_dir again.
    await user.click(screen.getByText("locked"));
    await user.click(screen.getByText("locked"));
    expect(workspaceIpc.readDir.mock.calls.length).toBe(afterFail);
  });

  it("shows an empty note for an expanded folder that has no children", async () => {
    serve({
      "/w": [dir("empty", "/w/empty")],
      "/w/empty": [],
    });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("empty");

    await userEvent.setup().click(screen.getByText("empty"));
    expect(await screen.findByText("Empty folder.")).toBeInTheDocument();
  });

  it("opens (and dedupes) an editor tab in the center when a file is clicked", async () => {
    serve({ "/w": [file("main.rs", "/w/main.rs")] });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("main.rs");

    const user = userEvent.setup();
    const editorTabs = () =>
      Object.values(useAppStore.getState().tabs).filter((t) => t.ref.kind === "editor");

    await user.click(screen.getByText("main.rs"));
    expect(editorTabs()).toHaveLength(1);
    expect(editorTabs()[0].ref).toEqual({ kind: "editor", path: "/w/main.rs" });

    // Re-clicking the same file reuses the tab (dedupe by path).
    await user.click(screen.getByText("main.rs"));
    expect(editorTabs()).toHaveLength(1);
  });

  it("highlights the file you click, moving the highlight on the next click", async () => {
    serve({ "/w": [file("a.ts", "/w/a.ts"), file("b.ts", "/w/b.ts")] });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("a.ts");

    const nodeOf = (name: string) => screen.getByText(name).closest(".workspace-node")!;
    const user = userEvent.setup();

    await user.click(screen.getByText("a.ts"));
    expect(nodeOf("a.ts")).toHaveClass("is-selected");
    expect(nodeOf("b.ts")).not.toHaveClass("is-selected");

    await user.click(screen.getByText("b.ts"));
    expect(nodeOf("b.ts")).toHaveClass("is-selected");
    expect(nodeOf("a.ts")).not.toHaveClass("is-selected");
  });
});

describe("WorkspaceTree — shared folder order + persisted collapse (features 2 & 3)", () => {
  it("orders roots by the shared folderOrder, so the Files rail matches the Agents rail", async () => {
    serve({ "/wa": [file("a.ts", "/wa/a.ts")], "/wb": [file("b.ts", "/wb/b.ts")] });
    startAgent("A", "/wa");
    startAgent("B", "/wb");
    // Discovery order is /wa, /wb — but folderOrder puts /wb first, so the rail must
    // paint them in THAT order (the same key the left rail sorts by).
    act(() => {
      useAppStore.setState((s) => {
        s.folderOrder = ["/wb", "/wa"];
      });
    });
    render(<WorkspaceTree />);

    await screen.findByText("b.ts");
    expect(rootHeaders()).toEqual(["/wb", "/wa"]);
  });

  it("reads collapse from the store: a folder already in collapsedRoots renders collapsed", async () => {
    serve({ "/w": [file("keep.ts", "/w/keep.ts")] });
    openRoot("/w");
    act(() => {
      useAppStore.setState((s) => {
        s.collapsedRoots = new Set(["/w"]);
      });
    });
    render(<WorkspaceTree />);

    // Seeded collapsed → its files are hidden and the caret is not open (this is what makes
    // a collapse survive a restart once prefs are hydrated).
    expect(screen.queryByText("keep.ts")).toBeNull();
    expect(headerFor("/w").querySelector(".workspace-root__caret")).not.toHaveClass("is-open");
  });

  it("a root header is a folder drag source publishing its path under the folder MIME", () => {
    serve({ "/w": [file("a.ts", "/w/a.ts")] });
    openRoot("/w");
    render(<WorkspaceTree />);

    const header = screen.getByTestId("workspace-root");
    expect(header).toHaveAttribute("draggable", "true");

    const dt = makeDataTransfer();
    fireEvent.dragStart(header, { dataTransfer: dt });
    expect(dt.getData(FOLDER_DND_MIME)).toBe("/w");
    expect(dt.effectAllowed).toBe("move");
  });

  it("dropping folder A onto folder B calls moveFolder(A, B) — reordering BOTH rails' folderOrder", async () => {
    serve({ "/wa": [file("a.ts", "/wa/a.ts")], "/wb": [file("b.ts", "/wb/b.ts")] });
    startAgent("A", "/wa");
    startAgent("B", "/wb");
    act(() => {
      useAppStore.setState((s) => {
        s.folderOrder = ["/wa", "/wb"];
      });
    });
    render(<WorkspaceTree />);
    await screen.findByText("a.ts");

    // Drag /wb, drop it on /wa → /wb lands immediately before /wa.
    const dt = folderDrag("/wb");
    const target = headerFor("/wa");
    const prevented = !fireEvent.dragOver(target, { dataTransfer: dt });
    expect(prevented).toBe(true); // accepted the folder drag
    expect(dt.dropEffect).toBe("move");
    // The hovered target shows the calm drop indicator.
    expect(target).toHaveClass("is-drop-target");

    fireEvent.drop(target, { dataTransfer: dt });

    // The shared order is rewritten — which is what keeps both rails in sync.
    expect(state().folderOrder).toEqual(["/wb", "/wa"]);
    expect(rootHeaders()).toEqual(["/wb", "/wa"]);
    // The indicator clears once dropped.
    expect(headerFor("/wa")).not.toHaveClass("is-drop-target");
  });

  it("dragging a folder onto ITSELF is a no-op (order unchanged)", async () => {
    serve({ "/wa": [file("a.ts", "/wa/a.ts")], "/wb": [file("b.ts", "/wb/b.ts")] });
    startAgent("A", "/wa");
    startAgent("B", "/wb");
    act(() => {
      useAppStore.setState((s) => {
        s.folderOrder = ["/wa", "/wb"];
      });
    });
    render(<WorkspaceTree />);
    await screen.findByText("a.ts");

    const dt = folderDrag("/wa");
    const self = headerFor("/wa");
    fireEvent.dragOver(self, { dataTransfer: dt });
    fireEvent.drop(self, { dataTransfer: dt });

    expect(state().folderOrder).toEqual(["/wa", "/wb"]); // untouched
  });

  it("clears the drop indicator on drag-leave, but ignores leaves into the header's own children", async () => {
    serve({ "/wa": [file("a.ts", "/wa/a.ts")] });
    openRoot("/wa");
    render(<WorkspaceTree />);
    await screen.findByText("a.ts");

    const header = headerFor("/wa");
    const dt = folderDrag("/wa");
    fireEvent.dragOver(header, { dataTransfer: dt });
    expect(header).toHaveClass("is-drop-target");

    // Leaving toward a child of the header (relatedTarget inside it) must NOT clear —
    // `fireDragLeave` defines relatedTarget explicitly (jsdom's plain-Event fallback
    // silently drops it from a fireEvent init).
    const child = header.querySelector(".workspace-root__name") as Node;
    fireDragLeave(header, child);
    expect(header).toHaveClass("is-drop-target");

    // Leaving the header entirely (relatedTarget outside) clears it.
    fireDragLeave(header, document.body);
    expect(header).not.toHaveClass("is-drop-target");
  });

  it("ignores a NON-folder drag (e.g. a tab): no preventDefault, no reorder", async () => {
    serve({ "/wa": [file("a.ts", "/wa/a.ts")], "/wb": [file("b.ts", "/wb/b.ts")] });
    startAgent("A", "/wa");
    startAgent("B", "/wb");
    act(() => {
      useAppStore.setState((s) => {
        s.folderOrder = ["/wa", "/wb"];
      });
    });
    render(<WorkspaceTree />);
    await screen.findByText("a.ts");

    // A dataTransfer that carries some OTHER mime — the folder gate must reject it.
    const foreign = {
      setData: () => {},
      getData: () => "",
      types: ["application/x-agentstudio-tab"],
      effectAllowed: "",
      dropEffect: "",
    };
    const target = headerFor("/wa");
    const notPrevented = fireEvent.dragOver(target, { dataTransfer: foreign });
    expect(notPrevented).toBe(true); // default NOT prevented → not a drop target
    expect(target).not.toHaveClass("is-drop-target");

    fireEvent.drop(target, { dataTransfer: foreign });
    expect(state().folderOrder).toEqual(["/wa", "/wb"]); // untouched
  });

  it("toggling collapse still fires on a plain header click (the drag gesture does not eat it)", async () => {
    serve({ "/w": [file("keep.ts", "/w/keep.ts")] });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("keep.ts");

    await userEvent.setup().click(screen.getByTestId("workspace-root"));
    expect(state().collapsedRoots.has("/w")).toBe(true);
  });
});

describe("WorkspaceTree — create folder + file", () => {
  it("creates a folder at the root: joins the path, calls create_directory, reloads", async () => {
    serve({ "/w": [file("a.ts", "/w/a.ts")] });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("a.ts");
    workspaceIpc.readDir.mockClear();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "New folder in w" }));
    const input = await screen.findByLabelText("New folder name");
    await user.type(input, "newdir{Enter}");

    expect(workspaceIpc.createDirectory).toHaveBeenCalledWith("/w/newdir");
    // Reloaded the parent so the cache reflects the new folder.
    expect(workspaceIpc.readDir).toHaveBeenCalledWith("/w");
  });

  it("creates a folder under a nested folder button (expands it first)", async () => {
    serve({
      "/w": [dir("src", "/w/src")],
      "/w/src": [file("main.rs", "/w/src/main.rs")],
    });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("src");

    const user = userEvent.setup();
    // The button on the collapsed dir row expands + opens the create row inside it.
    await user.click(screen.getByRole("button", { name: "New folder in src" }));
    const input = await screen.findByLabelText("New folder name");
    await user.type(input, "gen{Enter}");

    expect(workspaceIpc.createDirectory).toHaveBeenCalledWith("/w/src/gen");
    expect(workspaceIpc.readDir).toHaveBeenCalledWith("/w/src");
  });

  it("cancels a create on Esc — no IPC", async () => {
    serve({ "/w": [file("a.ts", "/w/a.ts")] });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("a.ts");

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "New folder in w" }));
    const input = await screen.findByLabelText("New folder name");
    await user.type(input, "throwaway{Escape}");

    expect(workspaceIpc.createDirectory).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("New folder name")).toBeNull();
  });

  it("cancels a create on an empty/whitespace name — no IPC", async () => {
    serve({ "/w": [file("a.ts", "/w/a.ts")] });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("a.ts");

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "New file in w" }));
    const input = await screen.findByLabelText("New file name");
    await user.type(input, "   {Enter}"); // whitespace only

    expect(workspaceIpc.createFile).not.toHaveBeenCalled();
  });

  it("creates a file and opens it in the editor", async () => {
    serve({ "/w": [file("a.ts", "/w/a.ts")] });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("a.ts");

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "New file in w" }));
    const input = await screen.findByLabelText("New file name");
    await user.type(input, "fresh.ts{Enter}");

    expect(workspaceIpc.createFile).toHaveBeenCalledWith("/w/fresh.ts");
    // The new file opened in the center editor.
    expect(editorPaths()).toContain("/w/fresh.ts");
  });

  it("surfaces a create rejection as a calm inline error, no crash", async () => {
    serve({ "/w": [file("a.ts", "/w/a.ts")] });
    workspaceIpc.createDirectory.mockRejectedValue(new Error("already exists"));
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("a.ts");

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "New folder in w" }));
    await user.type(await screen.findByLabelText("New folder name"), "dup{Enter}");

    expect(await screen.findByRole("alert")).toHaveTextContent("already exists");
    expect(screen.getByTestId("workspace-tree")).toBeInTheDocument();
  });
});

describe("WorkspaceTree — rename", () => {
  it("renames a file: calls rename_path with the joined destination and reloads", async () => {
    serve({ "/w": [file("a.ts", "/w/a.ts")] });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("a.ts");
    workspaceIpc.readDir.mockClear();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Rename a.ts" }));
    const input = await screen.findByLabelText("Rename a.ts");
    await user.clear(input);
    await user.type(input, "renamed.ts{Enter}");

    expect(workspaceIpc.renamePath).toHaveBeenCalledWith("/w/a.ts", "/w/renamed.ts");
    expect(workspaceIpc.readDir).toHaveBeenCalledWith("/w");
  });

  it("renames via double-clicking the name", async () => {
    serve({ "/w": [file("a.ts", "/w/a.ts")] });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("a.ts");

    const user = userEvent.setup();
    await user.dblClick(screen.getByText("a.ts"));
    const input = await screen.findByLabelText("Rename a.ts");
    await user.clear(input);
    await user.type(input, "b.ts{Enter}");

    expect(workspaceIpc.renamePath).toHaveBeenCalledWith("/w/a.ts", "/w/b.ts");
  });

  it("Esc cancels a rename — no IPC, the label returns", async () => {
    serve({ "/w": [file("a.ts", "/w/a.ts")] });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("a.ts");

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Rename a.ts" }));
    const input = await screen.findByLabelText("Rename a.ts");
    await user.type(input, "nope{Escape}");

    expect(workspaceIpc.renamePath).not.toHaveBeenCalled();
    expect(screen.getByText("a.ts")).toBeInTheDocument();
  });

  it("an unchanged name commits nothing", async () => {
    serve({ "/w": [file("a.ts", "/w/a.ts")] });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("a.ts");

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Rename a.ts" }));
    const input = await screen.findByLabelText("Rename a.ts");
    await user.type(input, "{Enter}"); // committed as-is (still "a.ts")

    expect(workspaceIpc.renamePath).not.toHaveBeenCalled();
  });

  it("keeps an OPEN editor tab consistent after a rename (re-points its path)", async () => {
    serve({ "/w": [file("a.ts", "/w/a.ts")] });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("a.ts");

    const user = userEvent.setup();
    await user.click(screen.getByText("a.ts")); // open a.ts in the editor
    expect(editorPaths()).toEqual(["/w/a.ts"]);

    await user.click(screen.getByRole("button", { name: "Rename a.ts" }));
    const input = await screen.findByLabelText("Rename a.ts");
    await user.clear(input);
    await user.type(input, "renamed.ts{Enter}");

    // The stale tab was closed and reopened at the new path.
    expect(editorPaths()).toEqual(["/w/renamed.ts"]);
  });
});

describe("WorkspaceTree — delete with inline confirm", () => {
  it("clicking delete does NOT delete — it shows a two-step inline confirm", async () => {
    serve({ "/w": [file("a.ts", "/w/a.ts")] });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("a.ts");

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Delete a.ts" }));

    expect(workspaceIpc.deletePath).not.toHaveBeenCalled();
    const confirm = screen.getByTestId("ws-confirm");
    expect(confirm).toHaveAttribute("role", "alert");
    expect(confirm).toHaveTextContent("Delete a.ts?");
  });

  it("confirming deletes, reloads, and closes an open tab", async () => {
    serve({ "/w": [file("a.ts", "/w/a.ts")] });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("a.ts");

    const user = userEvent.setup();
    await user.click(screen.getByText("a.ts")); // open it first
    expect(editorPaths()).toEqual(["/w/a.ts"]);
    workspaceIpc.readDir.mockClear();

    await user.click(screen.getByRole("button", { name: "Delete a.ts" }));
    await user.click(screen.getByRole("button", { name: "Confirm delete a.ts" }));

    expect(workspaceIpc.deletePath).toHaveBeenCalledWith("/w/a.ts");
    expect(workspaceIpc.readDir).toHaveBeenCalledWith("/w");
    expect(editorPaths()).toEqual([]); // the open tab was closed
  });

  it("cancelling reverts the confirm without deleting", async () => {
    serve({ "/w": [file("a.ts", "/w/a.ts")] });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("a.ts");

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Delete a.ts" }));
    await user.click(screen.getByRole("button", { name: "Cancel delete a.ts" }));

    expect(workspaceIpc.deletePath).not.toHaveBeenCalled();
    expect(screen.queryByTestId("ws-confirm")).toBeNull();
    expect(screen.getByText("a.ts")).toBeInTheDocument();
  });

  it("surfaces a delete rejection inline", async () => {
    serve({ "/w": [file("a.ts", "/w/a.ts")] });
    workspaceIpc.deletePath.mockRejectedValue(new Error("permission denied"));
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("a.ts");

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Delete a.ts" }));
    await user.click(screen.getByRole("button", { name: "Confirm delete a.ts" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("permission denied");
  });
});

describe("WorkspaceTree — drag-to-move within one root", () => {
  it("dropping a file onto a folder moves it in, reloading both ends", async () => {
    serve({
      "/w": [dir("sub", "/w/sub"), file("a.ts", "/w/a.ts")],
      "/w/sub": [file("keep.ts", "/w/sub/keep.ts")],
    });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("a.ts");
    workspaceIpc.readDir.mockClear();

    const dt = entryDrag("/w/a.ts");
    const target = nodeByPath("ws-dir", "/w/sub");
    const prevented = !fireEvent.dragOver(target, { dataTransfer: dt });
    expect(prevented).toBe(true);
    expect(dt.dropEffect).toBe("move");
    expect(target).toHaveClass("is-drop-target");

    // The reload rides on renamePath's resolution (a microtask), so flush it.
    await act(async () => {
      fireEvent.drop(target, { dataTransfer: dt });
    });

    expect(workspaceIpc.renamePath).toHaveBeenCalledWith("/w/a.ts", "/w/sub/a.ts");
    // Both the source parent and the destination are refreshed.
    expect(workspaceIpc.readDir).toHaveBeenCalledWith("/w");
    expect(workspaceIpc.readDir).toHaveBeenCalledWith("/w/sub");
  });

  it("dropping onto the root list background moves an entry to the top level", async () => {
    serve({
      "/w": [dir("sub", "/w/sub")],
      "/w/sub": [file("b.ts", "/w/sub/b.ts")],
    });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("sub");

    const user = userEvent.setup();
    await user.click(screen.getByText("sub")); // expand to reach b.ts
    await screen.findByText("b.ts");
    workspaceIpc.readDir.mockClear();

    const dt = entryDrag("/w/sub/b.ts");
    const list = screen.getByRole("tree");
    fireEvent.dragOver(list, { dataTransfer: dt });
    await act(async () => {
      fireEvent.drop(list, { dataTransfer: dt });
    });

    expect(workspaceIpc.renamePath).toHaveBeenCalledWith("/w/sub/b.ts", "/w/b.ts");
  });

  it("guards the no-op moves (already there / onto itself / into own subtree) — no IPC", async () => {
    serve({
      "/w": [dir("sub", "/w/sub"), file("a.ts", "/w/a.ts")],
      "/w/sub": [dir("inner", "/w/sub/inner")],
    });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("a.ts");

    // (a) already there: a.ts (parent /w) dropped on the root list.
    const list = screen.getByRole("tree");
    fireEvent.drop(list, { dataTransfer: entryDrag("/w/a.ts") });
    expect(workspaceIpc.renamePath).not.toHaveBeenCalled();

    // (b) onto itself: sub dropped on sub.
    const subRow = nodeByPath("ws-dir", "/w/sub");
    fireEvent.drop(subRow, { dataTransfer: entryDrag("/w/sub") });
    expect(workspaceIpc.renamePath).not.toHaveBeenCalled();

    // (c) into its own subtree: sub dropped on /w/sub/inner.
    const user = userEvent.setup();
    await user.click(screen.getByText("sub"));
    await screen.findByText("inner");
    const innerRow = nodeByPath("ws-dir", "/w/sub/inner");
    fireEvent.drop(innerRow, { dataTransfer: entryDrag("/w/sub") });
    expect(workspaceIpc.renamePath).not.toHaveBeenCalled();
  });

  it("guards the no-op moves for Windows spellings too — the root as typed vs the tree's canonical rows", async () => {
    // Root opened as `c:\w`; the tree lists canonical `C:\w\…` rows (fs_tree canonicalizes).
    serve({
      "c:\\w": [dir("sub", "C:\\w\\sub"), file("a.ts", "C:\\w\\a.ts")],
      "C:\\w\\sub": [dir("inner", "C:\\w\\sub\\inner")],
    });
    openRoot("c:\\w");
    render(<WorkspaceTree />);
    await screen.findByText("a.ts");

    // (a) already there: `C:\w\a.ts` dropped on the root list `c:\w`.
    fireEvent.drop(screen.getByRole("tree"), { dataTransfer: entryDrag("C:\\w\\a.ts") });
    expect(workspaceIpc.renamePath).not.toHaveBeenCalled();

    // (c) into its own subtree, the dragged path spelled with `/`.
    const user = userEvent.setup();
    await user.click(screen.getByText("sub"));
    await screen.findByText("inner");
    fireEvent.drop(nodeByPath("ws-dir", "C:\\w\\sub\\inner"), { dataTransfer: entryDrag("C:/w/sub") });
    expect(workspaceIpc.renamePath).not.toHaveBeenCalled();
  });

  it("clears the entry drop indicator on drag-leave", async () => {
    serve({ "/w": [dir("sub", "/w/sub"), file("a.ts", "/w/a.ts")] });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("sub");

    const target = nodeByPath("ws-dir", "/w/sub");
    fireEvent.dragOver(target, { dataTransfer: entryDrag("/w/a.ts") });
    expect(target).toHaveClass("is-drop-target");

    fireDragLeave(target, document.body);
    expect(target).not.toHaveClass("is-drop-target");
  });

  it("a file row is an entry drag source publishing its path under the entry MIME", async () => {
    serve({ "/w": [file("a.ts", "/w/a.ts")] });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("a.ts");

    const row = nodeByPath("ws-file", "/w/a.ts");
    expect(row).toHaveAttribute("draggable", "true");
    const dt = makeDataTransfer();
    fireEvent.dragStart(row, { dataTransfer: dt });
    expect(dt.getData(ENTRY_DND_MIME)).toBe("/w/a.ts");
    expect(dt.effectAllowed).toBe("move");
  });

  it("ignores a non-entry drag over the root list (no preventDefault)", async () => {
    serve({ "/w": [file("a.ts", "/w/a.ts")] });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("a.ts");

    const list = screen.getByRole("tree");
    // A folder-reorder drag must not be accepted by the entry drop target.
    const notPrevented = fireEvent.dragOver(list, { dataTransfer: folderDrag("/w") });
    expect(notPrevented).toBe(true);
    expect(list).not.toHaveClass("is-drop-target");
  });

  it("surfaces a move rejection inline (Rust rejected the rename)", async () => {
    serve({ "/w": [dir("sub", "/w/sub"), file("a.ts", "/w/a.ts")] });
    workspaceIpc.renamePath.mockRejectedValue(new Error("target exists"));
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("a.ts");

    await act(async () => {
      fireEvent.drop(nodeByPath("ws-dir", "/w/sub"), { dataTransfer: entryDrag("/w/a.ts") });
    });

    expect(await screen.findByRole("alert")).toHaveTextContent("target exists");
  });
});

describe("WorkspaceTree — mutation edge cases", () => {
  it("creates at a COLLAPSED root (expands it first, then opens the create row)", async () => {
    serve({ "/w": [file("a.ts", "/w/a.ts")] });
    openRoot("/w");
    act(() => {
      useAppStore.setState((s) => {
        s.collapsedRoots = new Set(["/w"]);
      });
    });
    render(<WorkspaceTree />);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "New folder in w" }));
    // The root uncollapsed and its create row opened.
    expect(state().collapsedRoots.has("/w")).toBe(false);
    await user.type(await screen.findByLabelText("New folder name"), "gen{Enter}");
    expect(workspaceIpc.createDirectory).toHaveBeenCalledWith("/w/gen");
  });

  it("creates a FILE under an ALREADY-EXPANDED, already-loaded nested folder (no re-read)", async () => {
    serve({
      "/w": [dir("src", "/w/src")],
      "/w/src": [file("main.rs", "/w/src/main.rs")],
    });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("src");

    const user = userEvent.setup();
    await user.click(screen.getByText("src")); // expand + load /w/src
    await screen.findByText("main.rs");
    const readsBefore = workspaceIpc.readDir.mock.calls.length;

    await user.click(screen.getByRole("button", { name: "New file in src" }));
    // Already expanded + loaded → startCreate re-reads nothing before the input opens.
    expect(workspaceIpc.readDir.mock.calls.length).toBe(readsBefore);
    await user.type(await screen.findByLabelText("New file name"), "x.ts{Enter}");
    expect(workspaceIpc.createFile).toHaveBeenCalledWith("/w/src/x.ts");
    expect(editorPaths()).toContain("/w/src/x.ts");
  });

  it("re-expands a cached-but-collapsed folder for a create without re-reading it", async () => {
    serve({
      "/w": [dir("src", "/w/src")],
      "/w/src": [file("main.rs", "/w/src/main.rs")],
    });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("src");

    const user = userEvent.setup();
    await user.click(screen.getByText("src")); // expand → reads + caches /w/src
    await screen.findByText("main.rs");
    await user.click(screen.getByText("src")); // collapse (cache kept)
    const readsBefore = workspaceIpc.readDir.mock.calls.length;

    // Create on the collapsed folder: it re-expands but the cache spares a re-read.
    await user.click(screen.getByRole("button", { name: "New folder in src" }));
    expect(workspaceIpc.readDir.mock.calls.length).toBe(readsBefore);
    await user.type(await screen.findByLabelText("New folder name"), "gen{Enter}");
    expect(workspaceIpc.createDirectory).toHaveBeenCalledWith("/w/src/gen");
  });

  it("opens a create row inside an EMPTY folder (no 'Empty folder.' over the input)", async () => {
    serve({
      "/w": [dir("empty", "/w/empty")],
      "/w/empty": [],
    });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("empty");

    const user = userEvent.setup();
    await user.click(screen.getByText("empty"));
    await screen.findByText("Empty folder.");

    await user.click(screen.getByRole("button", { name: "New file in empty" }));
    expect(await screen.findByLabelText("New file name")).toBeInTheDocument();
    expect(screen.queryByText("Empty folder.")).toBeNull(); // input replaces the note
  });

  it("surfaces a NON-Error rejection calmly (String(e))", async () => {
    serve({ "/w": [file("a.ts", "/w/a.ts")] });
    workspaceIpc.createDirectory.mockRejectedValue("disk full"); // a bare string, not an Error
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("a.ts");

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "New folder in w" }));
    await user.type(await screen.findByLabelText("New folder name"), "x{Enter}");

    expect(await screen.findByRole("alert")).toHaveTextContent("disk full");
  });

  it("surfaces a rename rejection inline", async () => {
    serve({ "/w": [file("a.ts", "/w/a.ts")] });
    workspaceIpc.renamePath.mockRejectedValue(new Error("name taken"));
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("a.ts");

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Rename a.ts" }));
    const input = await screen.findByLabelText("Rename a.ts");
    await user.clear(input);
    await user.type(input, "b.ts{Enter}");

    expect(await screen.findByRole("alert")).toHaveTextContent("name taken");
  });

  it("renaming an UNRELATED file leaves an open+selected file untouched", async () => {
    serve({ "/w": [file("a.ts", "/w/a.ts"), file("b.ts", "/w/b.ts")] });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("a.ts");

    const user = userEvent.setup();
    await user.click(screen.getByText("a.ts")); // open + select a.ts
    expect(editorPaths()).toEqual(["/w/a.ts"]);

    await user.click(screen.getByRole("button", { name: "Rename b.ts" }));
    const input = await screen.findByLabelText("Rename b.ts");
    await user.clear(input);
    await user.type(input, "c.ts{Enter}");

    expect(workspaceIpc.renamePath).toHaveBeenCalledWith("/w/b.ts", "/w/c.ts");
    // a.ts's tab is unrelated → left open; a.ts stays selected.
    expect(editorPaths()).toEqual(["/w/a.ts"]);
    expect(screen.getByText("a.ts").closest(".workspace-node")).toHaveClass("is-selected");
  });

  it("renaming a FOLDER re-points an open descendant tab + selection", async () => {
    serve({
      "/w": [dir("src", "/w/src")],
      "/w/src": [file("main.rs", "/w/src/main.rs")],
    });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("src");

    const user = userEvent.setup();
    await user.click(screen.getByText("src"));
    await screen.findByText("main.rs");
    await user.click(screen.getByText("main.rs")); // open + select the descendant
    expect(editorPaths()).toEqual(["/w/src/main.rs"]);

    await user.click(screen.getByRole("button", { name: "Rename src" }));
    const input = await screen.findByLabelText("Rename src");
    await user.clear(input);
    await user.type(input, "lib{Enter}");

    expect(workspaceIpc.renamePath).toHaveBeenCalledWith("/w/src", "/w/lib");
    // The open descendant tab followed the folder to its new path.
    expect(editorPaths()).toEqual(["/w/lib/main.rs"]);
  });

  it("renaming a Windows FOLDER re-points a tab spelled with another drive-letter case", async () => {
    // The tree says `C:\w\src`; a tab can arrive as `c:\w\src\main.rs` (a root typed in
    // lower case + a find hit). Windows sees one file — so must the rename.
    serve({ "C:\\w": [dir("src", "C:\\w\\src")] });
    openRoot("C:\\w");
    render(<WorkspaceTree />);
    await screen.findByText("src");
    act(() => {
      useAppStore.getState().layoutActions.openEditorTab("c:\\w\\src\\main.rs");
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Rename src" }));
    const input = await screen.findByLabelText("Rename src");
    await user.clear(input);
    await user.type(input, "lib{Enter}");

    expect(workspaceIpc.renamePath).toHaveBeenCalledWith("C:\\w\\src", "C:\\w\\lib");
    expect(editorPaths()).toEqual(["C:\\w\\lib\\main.rs"]);
  });

  it("skips NON-editor tabs when reconciling on a rename", async () => {
    serve({ "/w": [file("a.ts", "/w/a.ts")] });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("a.ts");
    // A non-editor (api-request) tab must be skipped by tab reconciliation.
    act(() => {
      useAppStore.getState().layoutActions.openApiRequestTab();
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Rename a.ts" }));
    const input = await screen.findByLabelText("Rename a.ts");
    await user.clear(input);
    await user.type(input, "b.ts{Enter}");

    expect(workspaceIpc.renamePath).toHaveBeenCalledWith("/w/a.ts", "/w/b.ts");
    // The api-request tab is still there — reconciliation only touches editor tabs.
    expect(
      Object.values(useAppStore.getState().tabs).some((t) => t.ref.kind === "api-request"),
    ).toBe(true);
  });

  it("deleting a FOLDER clears a selection that pointed inside it", async () => {
    serve({
      "/w": [dir("src", "/w/src")],
      "/w/src": [file("main.rs", "/w/src/main.rs")],
    });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("src");

    const user = userEvent.setup();
    await user.click(screen.getByText("src"));
    await screen.findByText("main.rs");
    await user.click(screen.getByText("main.rs")); // select the descendant

    await user.click(screen.getByRole("button", { name: "Delete src" }));
    await user.click(screen.getByRole("button", { name: "Confirm delete src" }));

    expect(workspaceIpc.deletePath).toHaveBeenCalledWith("/w/src");
    expect(editorPaths()).toEqual([]); // the descendant tab closed
  });

  it("deleting a file with NOTHING selected keeps selection null", async () => {
    serve({ "/w": [file("a.ts", "/w/a.ts")] });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("a.ts");
    workspaceIpc.readDir.mockClear();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Delete a.ts" }));
    await user.click(screen.getByRole("button", { name: "Confirm delete a.ts" }));

    expect(workspaceIpc.deletePath).toHaveBeenCalledWith("/w/a.ts");
    expect(workspaceIpc.readDir).toHaveBeenCalledWith("/w"); // parent reloaded
  });

  it("a dir row is an entry drag SOURCE publishing its path", async () => {
    serve({ "/w": [dir("sub", "/w/sub")] });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("sub");

    const row = nodeByPath("ws-dir", "/w/sub");
    expect(row).toHaveAttribute("draggable", "true");
    const dt = makeDataTransfer();
    fireEvent.dragStart(row, { dataTransfer: dt });
    expect(dt.getData(ENTRY_DND_MIME)).toBe("/w/sub");
  });

  it("ignores a drag-leave into the row's own child (indicator stays)", async () => {
    serve({ "/w": [dir("sub", "/w/sub"), file("a.ts", "/w/a.ts")] });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("sub");

    const row = nodeByPath("ws-dir", "/w/sub");
    fireEvent.dragOver(row, { dataTransfer: entryDrag("/w/a.ts") });
    expect(row).toHaveClass("is-drop-target");

    // Leaving toward a child of the row must NOT clear the indicator.
    const child = row.querySelector(".workspace-node__name") as Node;
    fireDragLeave(row, child);
    expect(row).toHaveClass("is-drop-target");
  });

  it("ignores a non-entry DROP on the root list (no move)", async () => {
    serve({ "/w": [file("a.ts", "/w/a.ts")] });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("a.ts");

    fireEvent.drop(screen.getByRole("tree"), { dataTransfer: folderDrag("/w") });
    expect(workspaceIpc.renamePath).not.toHaveBeenCalled();
  });

  it("ignores a drop whose entry payload is empty", async () => {
    serve({ "/w": [dir("sub", "/w/sub")] });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("sub");

    // The MIME is present (accepted) but carries no path → guarded, no IPC.
    fireEvent.drop(nodeByPath("ws-dir", "/w/sub"), { dataTransfer: entryDrag("") });
    expect(workspaceIpc.renamePath).not.toHaveBeenCalled();
  });

  it("a successful move leaves an UNRELATED selection intact", async () => {
    serve({
      "/w": [dir("sub", "/w/sub"), file("a.ts", "/w/a.ts"), file("b.ts", "/w/b.ts")],
    });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("a.ts");

    const user = userEvent.setup();
    await user.click(screen.getByText("b.ts")); // select an unrelated file

    await act(async () => {
      fireEvent.drop(nodeByPath("ws-dir", "/w/sub"), { dataTransfer: entryDrag("/w/a.ts") });
    });

    expect(workspaceIpc.renamePath).toHaveBeenCalledWith("/w/a.ts", "/w/sub/a.ts");
    // b.ts was unrelated to the move → still selected.
    expect(screen.getByText("b.ts").closest(".workspace-node")).toHaveClass("is-selected");
  });

  it("moves an entry within a WINDOWS-separator root (preserves the \\ style)", async () => {
    serve({
      "C:\\proj": [dir("sub", "C:\\proj\\sub"), file("a.ts", "C:\\proj\\a.ts")],
    });
    openRoot("C:\\proj");
    render(<WorkspaceTree />);
    await screen.findByText("a.ts");

    await act(async () => {
      fireEvent.drop(nodeByPath("ws-dir", "C:\\proj\\sub"), {
        dataTransfer: entryDrag("C:\\proj\\a.ts"),
      });
    });

    expect(workspaceIpc.renamePath).toHaveBeenCalledWith("C:\\proj\\a.ts", "C:\\proj\\sub\\a.ts");
  });
});

describe("WorkspaceTree — right-click context menu", () => {
  /** Right-click at (x,y); returns false when default was prevented. */
  const rightClick = (el: Element, x = 60, y = 60) =>
    fireEvent.contextMenu(el, { clientX: x, clientY: y });
  const menu = () => screen.getByRole("menu");
  const menuNames = () =>
    within(menu())
      .getAllByRole("menuitem")
      .map((b) => b.textContent);
  const clickItem = (name: string) =>
    userEvent.setup().click(within(menu()).getByRole("menuitem", { name }));

  it("right-clicking a FILE opens a menu with the five actions and suppresses the OS menu", async () => {
    serve({ "/w": [file("a.ts", "/w/a.ts")] });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("a.ts");

    const prevented = !rightClick(nodeByPath("ws-file", "/w/a.ts"));
    expect(prevented).toBe(true); // e.preventDefault() ran → no native menu
    expect(menu()).toHaveAttribute("aria-label", "Actions for a.ts");
    // The chevron is ContextMenu's aria-hidden glyph (in `textContent`, not the name). Git sits
    // between create and rename/delete so Delete stays last.
    expect(menuNames()).toEqual(["New File", "New Folder", "Git▸", "Rename", "Delete"]);
  });

  it("choosing Rename from a file's menu enters the inline rename flow", async () => {
    serve({ "/w": [file("a.ts", "/w/a.ts")] });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("a.ts");

    rightClick(nodeByPath("ws-file", "/w/a.ts"));
    await clickItem("Rename");

    // The SAME inline rename the pencil button / double-click use.
    const input = await screen.findByLabelText("Rename a.ts");
    const user = userEvent.setup();
    await user.clear(input);
    await user.type(input, "b.ts{Enter}");
    expect(workspaceIpc.renamePath).toHaveBeenCalledWith("/w/a.ts", "/w/b.ts");
    // The menu closed once the item was chosen.
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("choosing Delete from a file's menu shows the inline two-step confirm", async () => {
    serve({ "/w": [file("a.ts", "/w/a.ts")] });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("a.ts");

    rightClick(nodeByPath("ws-file", "/w/a.ts"));
    await clickItem("Delete");

    expect(workspaceIpc.deletePath).not.toHaveBeenCalled(); // confirm first
    expect(screen.getByTestId("ws-confirm")).toHaveTextContent("Delete a.ts?");
  });

  it("New File / New Folder from a FILE's menu create in the file's PARENT dir", async () => {
    serve({
      "/w": [dir("src", "/w/src")],
      "/w/src": [file("main.rs", "/w/src/main.rs")],
    });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("src");

    const user = userEvent.setup();
    await user.click(screen.getByText("src")); // expand so the file is visible
    await screen.findByText("main.rs");

    rightClick(nodeByPath("ws-file", "/w/src/main.rs"));
    await clickItem("New File");
    await user.type(await screen.findByLabelText("New file name"), "x.ts{Enter}");
    // Created in the parent (VS Code-style), not "inside" the clicked file.
    expect(workspaceIpc.createFile).toHaveBeenCalledWith("/w/src/x.ts");
  });

  it("New Folder from a DIRECTORY's menu expands it and creates inside it", async () => {
    serve({
      "/w": [dir("src", "/w/src")],
      "/w/src": [file("main.rs", "/w/src/main.rs")],
    });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("src"); // src is collapsed

    rightClick(nodeByPath("ws-dir", "/w/src"));
    expect(menu()).toHaveAttribute("aria-label", "Actions for src");
    await clickItem("New Folder");

    // Right-clicking a collapsed folder + New Folder expands it + opens the input.
    await screen.findByText("main.rs"); // the folder expanded
    await userEvent.setup().type(await screen.findByLabelText("New folder name"), "gen{Enter}");
    expect(workspaceIpc.createDirectory).toHaveBeenCalledWith("/w/src/gen");
  });

  it("New File from a DIRECTORY's menu creates inside that directory", async () => {
    serve({ "/w": [dir("src", "/w/src")], "/w/src": [] });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("src");

    rightClick(nodeByPath("ws-dir", "/w/src"));
    await clickItem("New File");
    await userEvent.setup().type(await screen.findByLabelText("New file name"), "y.ts{Enter}");
    expect(workspaceIpc.createFile).toHaveBeenCalledWith("/w/src/y.ts");
  });

  it("right-clicking the root's empty space offers create-only (no Rename/Delete)", async () => {
    serve({ "/w": [file("a.ts", "/w/a.ts")] });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("a.ts");

    // The list container (role=tree) is the root's empty-space target.
    rightClick(screen.getByRole("tree"));
    expect(menu()).toHaveAttribute("aria-label", "Actions for w");
    expect(menuNames()).toEqual(["New File", "New Folder"]); // root is not renamable/deletable

    await clickItem("New File");
    await userEvent.setup().type(await screen.findByLabelText("New file name"), "top.ts{Enter}");
    expect(workspaceIpc.createFile).toHaveBeenCalledWith("/w/top.ts");
  });

  it("New Folder from the root's empty-space menu creates at the top level", async () => {
    serve({ "/w": [file("a.ts", "/w/a.ts")] });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("a.ts");

    rightClick(screen.getByRole("tree"));
    await clickItem("New Folder");
    await userEvent.setup().type(await screen.findByLabelText("New folder name"), "pkg{Enter}");
    expect(workspaceIpc.createDirectory).toHaveBeenCalledWith("/w/pkg");
  });

  it("right-clicking the ROOT HEADER offers create-only, wired to the header create flow", async () => {
    serve({ "/w": [file("a.ts", "/w/a.ts")] });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("a.ts");

    const prevented = !rightClick(headerFor("/w"));
    expect(prevented).toBe(true);
    expect(menu()).toHaveAttribute("aria-label", "Actions for w");
    expect(menuNames()).toEqual(["New File", "New Folder", "Refresh"]);

    await clickItem("New Folder");
    await userEvent.setup().type(await screen.findByLabelText("New folder name"), "hdr{Enter}");
    expect(workspaceIpc.createDirectory).toHaveBeenCalledWith("/w/hdr");
  });

  it("New File from the root HEADER menu creates + opens the file", async () => {
    serve({ "/w": [file("a.ts", "/w/a.ts")] });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("a.ts");

    rightClick(headerFor("/w"));
    await clickItem("New File");
    await userEvent.setup().type(await screen.findByLabelText("New file name"), "made.ts{Enter}");
    expect(workspaceIpc.createFile).toHaveBeenCalledWith("/w/made.ts");
    expect(editorPaths()).toContain("/w/made.ts");
  });

  it("right-clicking the header of a COLLAPSED root still opens the menu, and create re-expands it", async () => {
    serve({ "/w": [file("a.ts", "/w/a.ts")] });
    openRoot("/w");
    act(() => {
      useAppStore.setState((s) => {
        s.collapsedRoots = new Set(["/w"]);
      });
    });
    render(<WorkspaceTree />);

    rightClick(headerFor("/w"));
    expect(menuNames()).toEqual(["New File", "New Folder", "Refresh"]);
    await clickItem("New Folder");

    // startRootCreate expanded the root and opened the inline create row.
    expect(state().collapsedRoots.has("/w")).toBe(false);
    await userEvent.setup().type(await screen.findByLabelText("New folder name"), "gen{Enter}");
    expect(workspaceIpc.createDirectory).toHaveBeenCalledWith("/w/gen");
  });

  it("opening a second menu replaces the first (only one open at a time)", async () => {
    serve({ "/w": [file("a.ts", "/w/a.ts"), file("b.ts", "/w/b.ts")] });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("a.ts");

    rightClick(nodeByPath("ws-file", "/w/a.ts"));
    expect(menu()).toHaveAttribute("aria-label", "Actions for a.ts");

    // Right-click a different row: the first menu closes, the second is the only one.
    rightClick(nodeByPath("ws-file", "/w/b.ts"));
    expect(screen.getAllByRole("menu")).toHaveLength(1);
    expect(menu()).toHaveAttribute("aria-label", "Actions for b.ts");
  });

  it("opening the header menu closes an open row menu, and vice versa (cross-component singleton)", async () => {
    serve({ "/w": [file("a.ts", "/w/a.ts")] });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("a.ts");

    // Row menu (inner component) open…
    rightClick(nodeByPath("ws-file", "/w/a.ts"));
    expect(menu()).toHaveAttribute("aria-label", "Actions for a.ts");

    // …right-clicking the header (outer component) closes it and opens the header menu.
    rightClick(headerFor("/w"));
    expect(screen.getAllByRole("menu")).toHaveLength(1);
    expect(menuNames()).toEqual(["New File", "New Folder", "Refresh"]);

    // …and right-clicking the row again closes the header menu, reopening the row menu.
    rightClick(nodeByPath("ws-file", "/w/a.ts"));
    expect(screen.getAllByRole("menu")).toHaveLength(1);
    expect(menu()).toHaveAttribute("aria-label", "Actions for a.ts");
  });

  it("choosing Delete on a DIRECTORY confirms deleting that directory", async () => {
    serve({ "/w": [dir("src", "/w/src")] });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("src");

    rightClick(nodeByPath("ws-dir", "/w/src"));
    await clickItem("Delete");
    expect(screen.getByTestId("ws-confirm")).toHaveTextContent("Delete src?");
  });
});

/* ═══════════ the Git submenu: Compare with HEAD / Revert changes… ═══════════
 * Both `disabled` decisions come from the tree's git status and are asserted TWO-SIDED: a rule
 * that only greys out is indistinguishable from one that greys out everything. */
describe("WorkspaceTree — Git submenu (compare / revert)", () => {
  const rightClick = (el: Element) => fireEvent.contextMenu(el, { clientX: 60, clientY: 60 });
  /** The row/root menu — named "Actions for …", unlike the "Git" submenu. */
  const rootMenu = () => screen.getByRole("menu", { name: /^Actions for/ });
  const gitParent = () => within(rootMenu()).getByRole("menuitem", { name: "Git" });
  /** Hover the parent to open its child surface (the primitive opens on hover). */
  const openGit = (): HTMLElement => {
    fireEvent.mouseOver(gitParent());
    return screen.getByRole("menu", { name: "Git" });
  };
  const gitItem = (name: string) => within(openGit()).getByRole("menuitem", { name });

  /** Seed a root that git reports as NOT a repository (gitStore's stable code). */
  const seedNotARepo = (root: string) =>
    act(() => {
      useGitStore.setState({
        status: { [root]: { branch: "", changes: [], error: { code: "not-a-repo", detail: null } } },
      });
    });

  const diffPaths = () =>
    Object.values(useAppStore.getState().tabs)
      .filter((t) => t.ref.kind === "diff")
      .map((t) => (t.ref.kind === "diff" ? t.ref.path : ""));

  // `refreshGitStatus` lives ON the store, so it is swapped for a spy and put
  // back afterwards — leaving a spy in a module-singleton store would leak into
  // every test that runs after this block.
  const realRefresh = useGitStore.getState().refreshGitStatus;
  const refreshGitStatus = vi.fn<() => Promise<void>>();

  beforeEach(() => {
    refreshGitStatus.mockReset().mockResolvedValue(undefined);
    act(() => {
      useGitStore.setState({ refreshGitStatus });
    });
  });
  afterEach(() => {
    act(() => {
      useGitStore.setState({ refreshGitStatus: realRefresh });
    });
  });

  /** One modified file under `/w`, tree rendered, that file's menu open. */
  const openFileMenu = async (status: GitStatus | null = "modified") => {
    serve({ "/w": [file("a.ts", "/w/a.ts"), file("b.ts", "/w/b.ts")] });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("a.ts");
    seedGit("/w", status === null ? [] : [{ path: "/w/a.ts", status }]);
    rightClick(nodeByPath("ws-file", "/w/a.ts"));
  };

  it("offers Git ▸ Compare with HEAD / Revert changes… on a FILE row", async () => {
    await openFileMenu();

    const sub = openGit();
    expect(within(sub).getAllByRole("menuitem").map((b) => b.textContent)).toEqual([
      "Compare with HEAD",
      "Revert changes…",
    ]);
    // The ellipsis is load-bearing: it is what tells the user a confirm follows.
    expect(within(sub).getByRole("menuitem", { name: /^Revert changes/ }).textContent).toContain("…");
  });

  it("offers NO Git submenu on a FOLDER row — this slice is per-file", async () => {
    serve({ "/w": [dir("src", "/w/src")] });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("src");
    seedGit("/w", [{ path: "/w/src/main.rs", status: "modified" }]);

    rightClick(nodeByPath("ws-dir", "/w/src"));

    expect(within(rootMenu()).queryByRole("menuitem", { name: "Git" })).toBeNull();
    expect(within(rootMenu()).getAllByRole("menuitem").map((b) => b.textContent)).toEqual([
      "New File",
      "New Folder",
      "Rename",
      "Delete",
    ]);
  });

  it("Compare with HEAD opens a diff tab for that exact file, and closes the menu", async () => {
    await openFileMenu();

    await userEvent.setup().click(gitItem("Compare with HEAD"));

    expect(diffPaths()).toEqual(["/w/a.ts"]);
    expect(screen.queryByRole("menu")).toBeNull();
    // A diff is a view, not an edit — no editor tab was opened as a side effect.
    expect(editorPaths()).toEqual([]);
  });

  it("disables the WHOLE submenu when the root is not a repo — and enables it when it is", async () => {
    // Side one: not a repo. Neither command has an answer, so neither is offered.
    serve({ "/w": [file("a.ts", "/w/a.ts")] });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("a.ts");
    seedNotARepo("/w");

    rightClick(nodeByPath("ws-file", "/w/a.ts"));
    expect(gitParent()).toBeDisabled();
    fireEvent.mouseOver(gitParent()); // a disabled parent is inert to hover
    expect(screen.queryByRole("menu", { name: "Git" })).toBeNull();

    // Side two: the same row, the same gesture, in a real repo — enabled.
    seedGit("/w", [{ path: "/w/a.ts", status: "modified" }]);
    expect(gitParent()).toBeEnabled();
    expect(within(openGit()).getByRole("menuitem", { name: "Compare with HEAD" })).toBeEnabled();
  });

  it("keeps the submenu ENABLED through a transient git failure (never-blank, not not-a-repo)", async () => {
    // gitStore keeps the last good changes beside a transient error, so a bad
    // poll cycle must not grey out the menu on a repo that is perfectly fine.
    serve({ "/w": [file("a.ts", "/w/a.ts")] });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("a.ts");
    act(() => {
      useGitStore.setState({
        status: {
          "/w": {
            branch: "main",
            changes: [{ path: "/w/a.ts", status: "modified" }],
            error: { code: "git", detail: "index.lock exists" },
          },
        },
      });
    });

    rightClick(nodeByPath("ws-file", "/w/a.ts"));

    expect(gitParent()).toBeEnabled();
    expect(within(openGit()).getByRole("menuitem", { name: /^Revert changes/ })).toBeEnabled();
  });

  it("disables Revert when the file has no working-tree change — Compare stays enabled", async () => {
    await openFileMenu("modified"); // a.ts is modified; b.ts is not

    // Side one: the clean file. Nothing to revert…
    rightClick(nodeByPath("ws-file", "/w/b.ts"));
    expect(within(openGit()).getByRole("menuitem", { name: /^Revert changes/ })).toBeDisabled();
    // …but comparing it is a legitimate way to ask "is it really clean?".
    expect(within(openGit()).getByRole("menuitem", { name: "Compare with HEAD" })).toBeEnabled();

    // Side two: the modified file, same menu, Revert live.
    rightClick(nodeByPath("ws-file", "/w/a.ts"));
    expect(within(openGit()).getByRole("menuitem", { name: /^Revert changes/ })).toBeEnabled();
  });

  it("disables Revert for an UNTRACKED file — there is no HEAD side to go back to", async () => {
    await openFileMenu("untracked");

    // git has never seen this file, so `git checkout HEAD -- <it>` has nothing to
    // restore; the only "revert" would be deleting it, which is Delete's job.
    expect(within(openGit()).getByRole("menuitem", { name: /^Revert changes/ })).toBeDisabled();
    expect(within(openGit()).getByRole("menuitem", { name: "Compare with HEAD" })).toBeEnabled();
  });

  it("Revert changes… ASKS first — cancelling never calls git_file_restore", async () => {
    await openFileMenu();
    const user = userEvent.setup();

    await user.click(gitItem("Revert changes…"));

    // The same inline two-step prompt Delete uses (no native dialog), naming the file.
    const confirm = screen.getByTestId("ws-confirm");
    expect(confirm).toHaveTextContent("Revert a.ts to HEAD?");
    expect(gitMock.gitFileRestore).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Cancel revert a.ts" }));

    expect(screen.queryByTestId("ws-confirm")).toBeNull();
    expect(gitMock.gitFileRestore).not.toHaveBeenCalled();
    expect(screen.getByText("a.ts")).toBeInTheDocument(); // the row came back
  });

  it("confirming restores the file, reloads its open editor and refreshes git status", async () => {
    await openFileMenu();
    const user = userEvent.setup();
    workspaceIpc.readDir.mockClear();

    await user.click(gitItem("Revert changes…"));
    await user.click(screen.getByRole("button", { name: "Confirm revert a.ts" }));

    expect(gitMock.gitFileRestore).toHaveBeenCalledWith("/w/a.ts");
    await vi.waitFor(() => expect(editorMock.reloadFromDisk).toHaveBeenCalledWith("/w/a.ts"));
    // Both stale surfaces refreshed: the folder listing and the status colors.
    expect(workspaceIpc.readDir).toHaveBeenCalledWith("/w");
    expect(refreshGitStatus).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("ws-confirm")).toBeNull();
  });

  it("surfaces a failed revert instead of pretending it worked", async () => {
    await openFileMenu();
    gitMock.gitFileRestore.mockRejectedValueOnce(
      new Error("file is not tracked — there is nothing to revert to"),
    );
    const user = userEvent.setup();

    await user.click(gitItem("Revert changes…"));
    await user.click(screen.getByRole("button", { name: "Confirm revert a.ts" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "file is not tracked — there is nothing to revert to",
    );
    // Nothing downstream ran: the buffer is untouched and status was not refreshed.
    expect(editorMock.reloadFromDisk).not.toHaveBeenCalled();
    expect(refreshGitStatus).not.toHaveBeenCalled();
  });

  it("swaps only the confirming row — its neighbours stay ordinary rows", async () => {
    await openFileMenu();

    await userEvent.setup().click(gitItem("Revert changes…"));

    expect(screen.getAllByTestId("ws-confirm")).toHaveLength(1);
    // b.ts renders normally while a.ts is asking — the confirm is per PATH, not
    // a mode the whole tree enters.
    expect(nodeByPath("ws-file", "/w/b.ts")).toBeInTheDocument();
    expect(screen.queryByText("a.ts")).toBeNull(); // its row is the prompt now
  });

  it("asks a DIFFERENT question for delete than for revert on the same file", async () => {
    // One mechanism, two kinds. If the discriminator were dropped, a revert would
    // ask "Delete a.ts?" — and would then call the wrong IPC on confirm.
    await openFileMenu();
    const user = userEvent.setup();

    await user.click(gitItem("Revert changes…"));
    expect(screen.getByTestId("ws-confirm")).toHaveTextContent("Revert a.ts to HEAD?");
    await user.click(screen.getByRole("button", { name: "Cancel revert a.ts" }));

    rightClick(nodeByPath("ws-file", "/w/a.ts"));
    await user.click(within(rootMenu()).getByRole("menuitem", { name: "Delete" }));
    expect(screen.getByTestId("ws-confirm")).toHaveTextContent("Delete a.ts?");

    await user.click(screen.getByRole("button", { name: "Confirm delete a.ts" }));
    expect(workspaceIpc.deletePath).toHaveBeenCalledWith("/w/a.ts");
    expect(gitMock.gitFileRestore).not.toHaveBeenCalled();
  });
});

describe("WorkspaceTree — reveal active file", () => {
  const layout = () => useAppStore.getState().layoutActions;
  const revealButton = () => screen.getByRole("button", { name: "Reveal active file" });
  /** Open (or re-focus) an editor tab — what makes `activeFilePath` non-null. */
  const openEditor = (path: string) =>
    act(() => {
      layout().openEditorTab(path);
    });
  /** Fire the REAL store action the crosshair calls (not a synthetic setState). */
  const reveal = () =>
    act(() => {
      useAppStore.getState().uiActions.revealActiveFile();
    });
  const selectedNode = () => document.querySelector(".workspace-node.is-selected");
  const caretOf = (path: string) =>
    nodeByPath("ws-dir", path).querySelector(".workspace-node__caret");

  it("crosshair: disabled without an active editor tab, enabled with one, click posts the reveal", async () => {
    serve({ "/w": [file("a.ts", "/w/a.ts")] });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("a.ts");

    // No tabs at all → nothing to reveal, and the button SAYS so: a greyed-out
    // 13px glyph at opacity .35 was its only signal before.
    expect(revealButton()).toBeDisabled();
    expect(revealButton()).toHaveAttribute("title", "No file is open — nothing to reveal");
    // A file-less tab, with no file tab ever opened, is equally not revealable.
    act(() => {
      layout().openApiRequestTab();
    });
    expect(revealButton()).toBeDisabled();

    openEditor("/w/a.ts");
    expect(revealButton()).toBeEnabled();
    expect(revealButton()).toHaveAttribute("title", "Reveal a.ts in tree");

    await userEvent.setup().click(revealButton());
    // The click drove the real action: the one-shot request landed in the store,
    // carrying the root that owns the path (see the out-of-root case below,
    // which is what that field exists for).
    expect(state().fileReveal).toEqual({ path: "/w/a.ts", token: 1, root: "/w" });
    // …and the tree consumed it: the file is selected.
    expect(screen.getByText("a.ts").closest(".workspace-node")).toHaveClass("is-selected");
  });

  it("reveals a DEEP file: loads + expands the ancestor chain, selects it, scrolls it into view", async () => {
    // jsdom ships no scrollIntoView; the component optional-calls it, so a stub
    // on the prototype makes the scroll observable.
    const scroll = vi.fn();
    const proto = Element.prototype as unknown as { scrollIntoView?: typeof scroll };
    proto.scrollIntoView = scroll;
    try {
      serve({
        "/w": [dir("a", "/w/a")],
        "/w/a": [dir("b", "/w/a/b")],
        "/w/a/b": [file("c.ts", "/w/a/b/c.ts")],
      });
      openRoot("/w");
      render(<WorkspaceTree />);
      await screen.findByText("a");

      openEditor("/w/a/b/c.ts");
      reveal();

      // The whole chain painted: both ancestors were read and rendered open.
      const target = await screen.findByText("c.ts");
      expect(workspaceIpc.readDir).toHaveBeenCalledWith("/w/a");
      expect(workspaceIpc.readDir).toHaveBeenCalledWith("/w/a/b");
      expect(caretOf("/w/a")).toHaveClass("is-open");
      expect(caretOf("/w/a/b")).toHaveClass("is-open");
      // The file itself is selected…
      const row = target.closest(".workspace-node")!;
      expect(row).toHaveClass("is-selected");
      // …and was scrolled into view (on ITS row, block: nearest). Awaited: the scroll is a
      // passive effect after the commit that painted `c.ts`, and `findByText` can resolve in
      // between — under coverage instrumentation it can.
      await waitFor(() => expect(scroll).toHaveBeenCalledWith({ block: "nearest" }));
      expect(scroll.mock.contexts[0]).toBe(row);
    } finally {
      delete proto.scrollIntoView;
    }
  });

  it("re-revealing the SAME path (bumped token) re-applies selection without re-reading", async () => {
    serve({
      "/w": [dir("a", "/w/a"), file("other.ts", "/w/other.ts")],
      "/w/a": [file("x.ts", "/w/a/x.ts")],
    });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("other.ts");

    openEditor("/w/a/x.ts");
    reveal();
    const target = await screen.findByText("x.ts");
    expect(target.closest(".workspace-node")).toHaveClass("is-selected");

    // The user clicks another file: selection (and the active editor) move away.
    await userEvent.setup().click(screen.getByText("other.ts"));
    expect(target.closest(".workspace-node")).not.toHaveClass("is-selected");
    const readsBefore = workspaceIpc.readDir.mock.calls.length;

    // Re-focus x.ts's tab (dedupe) and reveal again: the token bumps, so the
    // same path re-fires — selection returns, and the cached chain is not re-read.
    openEditor("/w/a/x.ts");
    reveal();
    expect(state().fileReveal?.token).toBe(2);
    expect(screen.getByText("x.ts").closest(".workspace-node")).toHaveClass("is-selected");
    expect(workspaceIpc.readDir.mock.calls.length).toBe(readsBefore);
  });

  // A reveal outside every root skips the walk but says why, with the calm inline note: a silent
  // no-op is indistinguishable from a broken button.
  it("REPORTS a reveal for a path outside every rendered root (still no reads, no crash)", async () => {
    serve({ "/w": [file("a.ts", "/w/a.ts")] });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("a.ts");
    workspaceIpc.readDir.mockClear();

    openEditor("/elsewhere/deep/x.ts");
    reveal();
    // Let any (wrongly-started) walk settle before asserting nothing happened.
    await act(async () => {});

    expect(state().fileReveal).toEqual({
      path: "/elsewhere/deep/x.ts",
      token: 1,
      root: null,
    });
    expect(workspaceIpc.readDir).not.toHaveBeenCalled();
    expect(selectedNode()).toBeNull();
    expect(screen.getByTestId("workspace-tree")).toBeInTheDocument();
    // The user is told, by name, and it is announced (role="alert").
    const note = screen.getByRole("alert");
    expect(note).toHaveTextContent("x.ts isn’t inside any open folder");
    expect(note).toHaveClass("workspace-tree__note--error");
    // …and it is in the diagnostics log with the path on it.
    expect(
      useLogStore.getState().entries.some((e) => e.message.includes("/elsewhere/deep/x.ts")),
    ).toBe(true);
  });

  it("clears the out-of-root note once a reveal LANDS under a root", async () => {
    serve({ "/w": [file("a.ts", "/w/a.ts")] });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("a.ts");

    openEditor("/elsewhere/x.ts");
    reveal();
    expect(await screen.findByRole("alert")).toBeInTheDocument();

    // A second, good reveal supersedes it — the note is per-request, not sticky.
    openEditor("/w/a.ts");
    reveal();
    await act(async () => {});
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("a.ts").closest(".workspace-node")).toHaveClass("is-selected");
  });

  it("only the OWNING root's subtree walks the chain (multi-root)", async () => {
    serve({
      "/wa": [dir("sub", "/wa/sub")],
      "/wb": [dir("sub", "/wb/sub")],
      "/wb/sub": [file("x.ts", "/wb/sub/x.ts")],
    });
    openRoot("/wa");
    openRoot("/wb");
    render(<WorkspaceTree />);
    await screen.findAllByText("sub"); // both roots painted (x.ts not visible yet)

    openEditor("/wb/sub/x.ts");
    reveal();

    const target = await screen.findByText("x.ts");
    expect(target.closest(".workspace-node")).toHaveClass("is-selected");
    // /wb's subtree read its chain; /wa's subtree left its own "sub" alone.
    expect(workspaceIpc.readDir).toHaveBeenCalledWith("/wb/sub");
    expect(workspaceIpc.readDir).not.toHaveBeenCalledWith("/wa/sub");
    expect(caretOf("/wa/sub")).not.toHaveClass("is-open");
  });

  it("stops calmly when an ancestor read fails MID-CHAIN — no crash, no selection, failure recorded", async () => {
    serve({
      "/w": [dir("a", "/w/a")],
      "/w/a": [dir("b", "/w/a/b")],
      // "/w/a/b" is absent → its read rejects, mid-walk.
    });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("a");

    openEditor("/w/a/b/c.ts");
    reveal();

    // The walk got as far as expanding /w/a (b is visible)…
    await screen.findByText("b");
    await act(async () => {}); // flush the rejected /w/a/b read
    expect(workspaceIpc.readDir).toHaveBeenCalledWith("/w/a/b");
    // …then stopped: b stays closed, nothing selected, the rail is intact.
    expect(caretOf("/w/a/b")).not.toHaveClass("is-open");
    expect(selectedNode()).toBeNull();
    expect(screen.getByTestId("workspace-tree")).toBeInTheDocument();

    // The failure joined the `failed` set: expanding b by hand shows the calm
    // note WITHOUT hammering read_dir again.
    const readsBefore = workspaceIpc.readDir.mock.calls.length;
    await userEvent.setup().click(screen.getByText("b"));
    expect(await screen.findByText("Can’t read this folder.")).toBeInTheDocument();
    expect(workspaceIpc.readDir.mock.calls.length).toBe(readsBefore);
  });

  it("stops up front at a dir ALREADY known-unreadable — no re-read, nothing selected", async () => {
    serve({
      "/w": [dir("a", "/w/a")],
      // "/w/a" is absent → its read rejects.
    });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("a");

    // The user expands `a` by hand FIRST — the failure joins `failed` before any
    // reveal exists (the reverse order of the mid-chain test above).
    await userEvent.setup().click(screen.getByText("a"));
    expect(await screen.findByText("Can’t read this folder.")).toBeInTheDocument();

    const readsBefore = workspaceIpc.readDir.mock.calls.length;
    openEditor("/w/a/b/c.ts");
    reveal();
    await act(async () => {}); // let the walk run
    // Known-unreadable → the walk bailed before its first read: the failure
    // cache was honored (no new read_dir), and nothing got selected.
    expect(workspaceIpc.readDir.mock.calls.length).toBe(readsBefore);
    expect(selectedNode()).toBeNull();
    expect(screen.getByTestId("workspace-tree")).toBeInTheDocument();
  });

  it("a reveal whose file is MISSING from the final listing expands the chain but highlights nothing", async () => {
    serve({
      "/w": [dir("a", "/w/a")],
      "/w/a": [file("real.ts", "/w/a/real.ts")],
    });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("a");

    openEditor("/w/a/ghost.ts"); // a tab can outlive its file (e.g. deleted on disk)
    reveal();

    // The chain still expanded fine…
    await screen.findByText("real.ts");
    expect(caretOf("/w/a")).toHaveClass("is-open");
    // …but no row matches the missing file: nothing highlights, nothing crashes.
    expect(selectedNode()).toBeNull();
    expect(screen.getByTestId("workspace-tree")).toBeInTheDocument();
  });

  it("reveals into a COLLAPSED root: the action un-collapses it and the fresh subtree consumes the request", async () => {
    serve({
      "/w": [dir("a", "/w/a")],
      "/w/a": [file("x.ts", "/w/a/x.ts")],
    });
    openRoot("/w");
    act(() => {
      useAppStore.setState((s) => {
        s.collapsedRoots = new Set(["/w"]);
      });
    });
    render(<WorkspaceTree />);
    expect(screen.queryByText("a")).toBeNull(); // collapsed → no listing mounted

    openEditor("/w/a/x.ts");
    reveal();

    // The store expanded the root, mounting a fresh subtree — whose seen-token
    // starts at 0, so it picks up the very reveal that mounted it.
    expect(state().collapsedRoots.has("/w")).toBe(false);
    const target = await screen.findByText("x.ts");
    expect(target.closest(".workspace-node")).toHaveClass("is-selected");
  });
});

describe("WorkspaceTree — git status colors + semantic folder roles", () => {
  it("file rows carry their git-status class, gained LIVE when the snapshot lands; clean files carry none", async () => {
    serve({
      "/w": [
        file("a.ts", "/w/a.ts"),
        file("b.ts", "/w/b.ts"),
        file("c.ts", "/w/c.ts"),
        file("d.ts", "/w/d.ts"),
      ],
    });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("a.ts");

    // Baseline before any status: NO git class anywhere (the two-sided half
    // that reds if classes are applied ignoring the map).
    expect(nodeByPath("ws-file", "/w/a.ts").className).not.toMatch(/workspace-node--git-/);

    seedGit("/w", [
      { path: "/w/a.ts", status: "modified" },
      { path: "/w/b.ts", status: "added" },
      { path: "/w/c.ts", status: "untracked" },
    ]);

    // The zustand subscription re-rendered the subtree — no remount needed.
    expect(nodeByPath("ws-file", "/w/a.ts")).toHaveClass("workspace-node--git-modified");
    expect(nodeByPath("ws-file", "/w/b.ts")).toHaveClass("workspace-node--git-added");
    expect(nodeByPath("ws-file", "/w/c.ts")).toHaveClass("workspace-node--git-untracked");
    // The clean file stays undecorated.
    expect(nodeByPath("ws-file", "/w/d.ts").className).not.toMatch(/workspace-node--git-/);
  });

  it("folder roles: src / tests / node_modules colored by class, a plain folder not", async () => {
    serve({
      "/w": [
        dir("src", "/w/src"),
        dir("tests", "/w/tests"),
        dir("node_modules", "/w/node_modules"),
        dir("docs", "/w/docs"),
      ],
    });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("src");

    expect(nodeByPath("ws-dir", "/w/src")).toHaveClass("workspace-node--role-src");
    expect(nodeByPath("ws-dir", "/w/tests")).toHaveClass("workspace-node--role-test");
    expect(nodeByPath("ws-dir", "/w/node_modules")).toHaveClass("workspace-node--role-generated");
    expect(nodeByPath("ws-dir", "/w/docs").className).not.toMatch(/workspace-node--role-/);
  });

  it("the src/main/kotlin chain: the PARENT name flows into the role, and a top-level 'main' stays plain", async () => {
    serve({
      "/w": [dir("main", "/w/main"), dir("src", "/w/src")],
      "/w/src": [dir("main", "/w/src/main")],
      "/w/src/main": [dir("kotlin", "/w/src/main/kotlin")],
    });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("src");

    // Top-level `main` (parent is the root folder "w") is NOT source — the
    // negative side of the context rule.
    expect(nodeByPath("ws-dir", "/w/main").className).not.toMatch(/workspace-node--role-/);

    const user = userEvent.setup();
    await user.click(nodeByPath("ws-dir", "/w/src"));
    await screen.findAllByText("main"); // the nested main painted
    expect(nodeByPath("ws-dir", "/w/src/main")).toHaveClass("workspace-node--role-src");

    await user.click(nodeByPath("ws-dir", "/w/src/main"));
    await screen.findByText("kotlin");
    expect(nodeByPath("ws-dir", "/w/src/main/kotlin")).toHaveClass("workspace-node--role-src");
  });

  it("a folder containing a change shows the vcs dot; its clean sibling and the root header do not", async () => {
    serve({ "/w": [dir("other", "/w/other"), dir("sub", "/w/sub")] });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("sub");

    seedGit("/w", [{ path: "/w/sub/x.ts", status: "modified" }]);

    expect(nodeByPath("ws-dir", "/w/sub").querySelector(".workspace-node__vcs-dot")).not.toBeNull();
    expect(nodeByPath("ws-dir", "/w/other").querySelector(".workspace-node__vcs-dot")).toBeNull();
    // Root headers never carry the dot (`dirsWithChanges` excludes the root by
    // contract) — and document-wide there is exactly the ONE dot, so the badge
    // cannot be leaking onto file rows or headers anywhere else.
    expect(headerFor("/w").querySelector(".workspace-node__vcs-dot")).toBeNull();
    expect(document.querySelectorAll(".workspace-node__vcs-dot")).toHaveLength(1);
  });

  it("a selected file row COMPOSES is-selected with its git class (both present, two-sided)", async () => {
    serve({ "/w": [file("a.ts", "/w/a.ts"), file("b.ts", "/w/b.ts")] });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("a.ts");
    seedGit("/w", [{ path: "/w/a.ts", status: "modified" }]);

    await userEvent.setup().click(screen.getByText("a.ts"));

    // jsdom asserts the CLASS COMPOSITION only; that the CSS actually paints
    // the selected row white over the git blue is the browser-tier item
    // (workspace.css keeps the is-selected rules at higher specificity).
    const row = nodeByPath("ws-file", "/w/a.ts");
    expect(row).toHaveClass("is-selected");
    expect(row).toHaveClass("workspace-node--git-modified");
    // …and its unselected neighbour has neither.
    const clean = nodeByPath("ws-file", "/w/b.ts");
    expect(clean).not.toHaveClass("is-selected");
    expect(clean.className).not.toMatch(/workspace-node--git-/);
  });

  it("mounting starts the git poll; unmounting calls the returned stop", async () => {
    const stop = vi.fn();
    gitMock.startGitPolling.mockReturnValueOnce(stop);
    serve({ "/w": [file("a.ts", "/w/a.ts")] });
    openRoot("/w");
    const { unmount } = render(<WorkspaceTree />);
    await screen.findByText("a.ts");

    expect(gitMock.startGitPolling).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled(); // two-sided: stop is the CLEANUP, not the setup

    unmount();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

describe("WorkspaceTree — per-file-type icons (file-icons.md §3/§6 wiring)", () => {
  // No <IconSprite> is mounted here on purpose: jsdom never paints <use>
  // targets, so the wiring is asserted via `data-icon-id`/href attributes
  // (the sprite itself is pinned by IconSprite.test.tsx).
  it("a file row consults the resolver; a folder row keeps the generic folder glyph (two-sided)", async () => {
    serve({ "/w": [dir("src", "/w/src"), file("Cargo.toml", "/w/Cargo.toml")] });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("Cargo.toml");

    const fileRow = nodeByPath("ws-file", "/w/Cargo.toml");
    const icon = fileRow.querySelector(".workspace-node__icon svg")!;
    // WIRING only, self-referential on purpose: the row consults resolveFileIconId with its
    // BASENAME; the value is pinned in resolveIconId.test.ts.
    const expected = resolveFileIconId("Cargo.toml");
    expect(icon.getAttribute("data-icon-id")).toBe(expected);
    expect(icon.querySelector("use")!.getAttribute("href")).toBe(`#mi-${expected}`);
    // Two-sided: the old generic monochrome document glyph is GONE from file rows…
    expect(fileRow.querySelector('[data-icon="file"]')).toBeNull();

    // …while folder rows keep the OLD generic folder glyph: the §3 dir branch
    // is deliberately deferred — folder identity ships as role COLORS.
    const dirRow = nodeByPath("ws-dir", "/w/src");
    expect(dirRow.querySelector('[data-icon="folder"]')).not.toBeNull();
    expect(dirRow.querySelector("[data-icon-id]")).toBeNull();
  });

  it("the inline-create row still uses the generic glyphs, not the resolver", async () => {
    serve({ "/w": [file("a.ts", "/w/a.ts")] });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("a.ts");

    // Open the root's "new file" affordance → the pending-name row appears.
    await userEvent.setup().click(screen.getByRole("button", { name: "New file in w" }));
    const pending = await screen.findByLabelText("New file name");
    const pendingRow = pending.closest(".workspace-node")!;
    // The pending row has no name yet — resolving an icon for it would be
    // meaningless churn; it keeps the monochrome document glyph.
    expect(pendingRow.querySelector('[data-icon="file"]')).not.toBeNull();
    expect(pendingRow.querySelector("[data-icon-id]")).toBeNull();
  });
});

/** Renders the REAL component and drives the REAL button: a store-level test never has the call
 * site in frame, and that is where this behaviour lives. */
describe("WorkspaceTree — the crosshair is alive, and the highlight follows the file", () => {
  const layout = () => useAppStore.getState().layoutActions;
  const revealButton = () => screen.getByRole("button", { name: "Reveal active file" });
  const selectedPaths = () =>
    Array.from(document.querySelectorAll(".workspace-node.is-selected")).map((e) =>
      e.getAttribute("data-path"),
    );
  const caretOf = (path: string) =>
    nodeByPath("ws-dir", path).querySelector(".workspace-node__caret");

  it("stays ENABLED while a TERMINAL pane holds focus and an editor is open elsewhere", async () => {
    serve({ "/w": [file("a.ts", "/w/a.ts")] });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("a.ts");

    act(() => {
      layout().openEditorTab("/w/a.ts");
    });
    expect(revealButton()).toBeEnabled();

    // Split, and put a terminal in the new pane — which also FOCUSES it. That is
    // what any mousedown in a terminal does (`Pane`'s onMouseDownCapture), and it
    // used to kill the button while the editor sat visible right beside it.
    let terminalPane = "" as PaneId;
    act(() => {
      terminalPane = layout().splitPane(useAppStore.getState().focusedPaneId, "row");
      layout().openTerminalTab({ paneId: terminalPane });
    });
    // Two-sided: the focus really did move off the editor's pane…
    expect(state().focusedPaneId).toBe(terminalPane);
    // …and the button survived it.
    expect(revealButton()).toBeEnabled();
    expect(revealButton()).toHaveAttribute("title", "Reveal a.ts in tree");
    // …and the row stays lit, rather than going blank the moment focus moved.
    expect(selectedPaths()).toEqual(["/w/a.ts"]);
  });

  it("stays enabled on a Compare-with-HEAD (diff) tab — a diff is a real file", async () => {
    serve({ "/w": [file("a.ts", "/w/a.ts")] });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("a.ts");

    act(() => {
      layout().openDiffTab("/w/a.ts");
    });
    expect(revealButton()).toBeEnabled();
    expect(selectedPaths()).toEqual(["/w/a.ts"]);
  });

  it("keeps the highlight across collapsing and re-expanding the root", async () => {
    serve({ "/w": [file("a.ts", "/w/a.ts")] });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("a.ts");
    const user = userEvent.setup();

    await user.click(screen.getByText("a.ts"));
    expect(selectedPaths()).toEqual(["/w/a.ts"]);

    // Collapsing a root UNMOUNTS its <WorkspaceTreeView key={root}>. With the
    // selection as component state this is exactly where it was lost.
    await user.click(headerFor("/w"));
    expect(screen.queryByText("a.ts")).toBeNull();
    await user.click(headerFor("/w"));

    expect(await screen.findByText("a.ts")).toBeInTheDocument();
    expect(selectedPaths()).toEqual(["/w/a.ts"]);
  });

  it("is RAIL-WIDE: exactly one row is lit across several roots", async () => {
    serve({
      "/wa": [file("a.ts", "/wa/a.ts")],
      "/wb": [file("b.ts", "/wb/b.ts")],
    });
    openRoot("/wa");
    openRoot("/wb");
    render(<WorkspaceTree />);
    await screen.findByText("a.ts");
    const user = userEvent.setup();

    await user.click(screen.getByText("a.ts"));
    expect(selectedPaths()).toEqual(["/wa/a.ts"]);
    // Clicking in the OTHER root moves the one highlight — it does not add a
    // second one, which is what per-root component state produced.
    await user.click(screen.getByText("b.ts"));
    expect(selectedPaths()).toEqual(["/wb/b.ts"]);
  });

  it("FOLLOWS a tab switch — and switches no rail, expands nothing, reads nothing", async () => {
    serve({
      "/w": [dir("sub", "/w/sub"), file("a.ts", "/w/a.ts")],
      "/w/sub": [file("deep.ts", "/w/sub/deep.ts")],
    });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("a.ts");

    // Two editor tabs, opened from OUTSIDE the tree (a Find hit / a Git click):
    // the highlight must land on them without anyone clicking a row.
    let aTab = "" as TabId;
    act(() => {
      aTab = layout().openEditorTab("/w/a.ts");
      layout().openEditorTab("/w/sub/deep.ts");
    });
    // The deep file's row is not rendered (sub is collapsed) → nothing is lit,
    // and crucially the tree did NOT go expand it. Following is free.
    expect(caretOf("/w/sub")).not.toHaveClass("is-open");
    expect(selectedPaths()).toEqual([]);

    // Switch back to a.ts's tab in the strip: the row lights up…
    act(() => {
      useAppStore.setState((s) => {
        s.rightRailTab = "vault";
        s.rightRailCollapsed = true;
      });
    });
    const readsBefore = workspaceIpc.readDir.mock.calls.length;
    act(() => {
      layout().setActiveTab(useAppStore.getState().focusedPaneId, aTab);
    });
    expect(selectedPaths()).toEqual(["/w/a.ts"]);
    // …and NOTHING else moved: the rail stayed where the user put it, no folder
    // opened, no read_dir fired. Only the crosshair is allowed to do that.
    expect(state().rightRailTab).toBe("vault");
    expect(state().rightRailCollapsed).toBe(true);
    expect(caretOf("/w/sub")).not.toHaveClass("is-open");
    expect(workspaceIpc.readDir.mock.calls.length).toBe(readsBefore);
  });

  it("but the CROSSHAIR still does the loud thing: rail + expand + scroll", async () => {
    const scroll = vi.fn();
    const proto = Element.prototype as unknown as { scrollIntoView?: typeof scroll };
    proto.scrollIntoView = scroll;
    try {
      serve({
        "/w": [dir("sub", "/w/sub")],
        "/w/sub": [file("deep.ts", "/w/sub/deep.ts")],
      });
      openRoot("/w");
      render(<WorkspaceTree />);
      await screen.findByText("sub");

      act(() => {
        layout().openEditorTab("/w/sub/deep.ts");
        useAppStore.setState((s) => {
          s.rightRailTab = "vault";
          s.rightRailCollapsed = true;
        });
      });
      // The button is enabled even though the row is not rendered — that is the
      // whole point of it.
      await userEvent.setup().click(revealButton());

      const row = (await screen.findByText("deep.ts")).closest(".workspace-node")!;
      expect(caretOf("/w/sub")).toHaveClass("is-open");
      expect(row).toHaveClass("is-selected");
      expect(scroll).toHaveBeenCalledWith({ block: "nearest" });
      expect(state().rightRailTab).toBe("files");
      expect(state().rightRailCollapsed).toBe(false);
    } finally {
      delete proto.scrollIntoView;
    }
  });

  it("goes dark only when the last file tab closes", async () => {
    serve({ "/w": [file("a.ts", "/w/a.ts")] });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("a.ts");

    let tab = "" as TabId;
    act(() => {
      tab = layout().openEditorTab("/w/a.ts");
      layout().openTerminalTab();
    });
    expect(revealButton()).toBeEnabled(); // a terminal is active, the file is still open
    expect(selectedPaths()).toEqual(["/w/a.ts"]);

    act(() => {
      layout().closeTab(tab);
    });
    expect(revealButton()).toBeDisabled();
    expect(revealButton()).toHaveAttribute("title", "No file is open — nothing to reveal");
    expect(selectedPaths()).toEqual([]);
  });
});

/** The gate is the REAL `opensInExternalBrowser`, so the menu and in-app preview must agree about
 * what a "page" is. */
describe("WorkspaceTree — Open in Browser", () => {
  const CHROME: BrowserChoice = { id: "com.google.Chrome", name: "Google Chrome", isDefault: true };
  const SAFARI: BrowserChoice = { id: "com.apple.Safari", name: "Safari", isDefault: false };

  const rightClick = (el: Element) => fireEvent.contextMenu(el, { clientX: 60, clientY: 60 });
  const rootMenu = () => screen.getByRole("menu", { name: /^Actions for/ });
  const menuNames = () =>
    within(rootMenu())
      .getAllByRole("menuitem")
      .map((b) => b.textContent);
  /** Hover the "Open in Browser" parent to open its flyout (the primitive's own rule). */
  const openFlyout = (): HTMLElement => {
    fireEvent.mouseOver(within(rootMenu()).getByRole("menuitem", { name: "Open in Browser" }));
    return screen.getByRole("menu", { name: "Open in Browser" });
  };

  /** One page, one note, one folder under `/w`, rendered, with `path`'s menu open. */
  const openMenuFor = async (path: string, testid: "ws-file" | "ws-dir" = "ws-file") => {
    serve({
      "/w": [
        dir("assets", "/w/assets"),
        file("index.html", "/w/index.html"),
        file("about.htm", "/w/about.htm"),
        file("notes.md", "/w/notes.md"),
        file("logo.svg", "/w/logo.svg"),
      ],
    });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("index.html");
    rightClick(nodeByPath(testid, path));
  };

  it("primes the browser list ONCE on mount, and never on opening a menu", async () => {
    await openMenuFor("/w/index.html");
    // The submenu is built from the cache; opening it must fire no IPC of its own
    // (the Git submenu's rule too), and the menu must know its full size before it opens.
    expect(browserIpc.primeBrowsers).toHaveBeenCalledTimes(1);
    // The cache WAS consulted while the items were built…
    expect(browserIpc.cachedBrowsers).toHaveBeenCalled();
    // …and opening the menu asked for no fresh enumeration.
    expect(browserIpc.primeBrowsers).toHaveBeenCalledTimes(1);
  });

  it("offers it on .html and .htm, as the FIRST group", async () => {
    await openMenuFor("/w/index.html");
    expect(menuNames()).toEqual([
      "Open in Browser",
      "New File",
      "New Folder",
      "Git▸",
      "Rename",
      "Delete",
    ]);
    cleanup();
    await openMenuFor("/w/about.htm");
    expect(menuNames()[0]).toBe("Open in Browser");
  });

  it("does NOT offer it on .md, on .svg, on a folder, or on a workspace root", async () => {
    // .md renders better in the app's own preview; .svg is the one image format a
    // browser runs as a DOCUMENT, scripts and all (previewKinds.ts spells both out).
    await openMenuFor("/w/notes.md");
    expect(menuNames()).not.toContain("Open in Browser");
    cleanup();

    await openMenuFor("/w/logo.svg");
    expect(menuNames()).not.toContain("Open in Browser");
    cleanup();

    await openMenuFor("/w/assets", "ws-dir");
    expect(menuNames()).not.toContain("Open in Browser");
    cleanup();

    // The root HEADER's own menu is create-only and must stay that way — a root
    // is not an entry (Rust rejects renaming or deleting one).
    serve({ "/w": [file("index.html", "/w/index.html")] });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("index.html");
    rightClick(headerFor("/w"));
    expect(menuNames()).toEqual(["New File", "New Folder", "Refresh"]);
  });

  it("lists the primed browsers with the system default FIRST and NAMED", async () => {
    browserIpc.cachedBrowsers.mockReturnValue([CHROME, SAFARI]);
    await openMenuFor("/w/index.html");

    const rows = within(openFlyout())
      .getAllByRole("menuitem")
      .map((b) => b.textContent);
    // The default appears twice on purpose: "follow whatever the OS default is"
    // and "pin Chrome" are different requests.
    expect(rows).toEqual(["System default (Google Chrome)", "Google Chrome", "Safari"]);
  });

  it("says just 'System default' when the OS did not flag one", async () => {
    browserIpc.cachedBrowsers.mockReturnValue([{ ...CHROME, isDefault: false }, SAFARI]);
    await openMenuFor("/w/index.html");

    expect(
      within(openFlyout())
        .getAllByRole("menuitem")
        .map((b) => b.textContent)[0],
    ).toBe("System default");
  });

  it("picking a browser sends THAT id; the default row sends none", async () => {
    browserIpc.cachedBrowsers.mockReturnValue([CHROME, SAFARI]);
    await openMenuFor("/w/index.html");

    await userEvent.setup().click(within(openFlyout()).getByRole("menuitem", { name: "Safari" }));
    expect(browserIpc.openInBrowser).toHaveBeenCalledWith("/w/index.html", "com.apple.Safari");
    expect(screen.queryByRole("menu")).toBeNull(); // a leaf closes the whole tree

    browserIpc.openInBrowser.mockClear();
    rightClick(nodeByPath("ws-file", "/w/index.html"));
    await userEvent
      .setup()
      .click(within(openFlyout()).getByRole("menuitem", { name: "System default (Google Chrome)" }));
    // No id at all — NOT an id the frontend guessed at.
    expect(browserIpc.openInBrowser).toHaveBeenCalledWith("/w/index.html", undefined);
  });

  it("falls back to a single leaf when the list has not arrived — and it still opens", async () => {
    browserIpc.cachedBrowsers.mockReturnValue(null); // prime still in flight, or failed
    await openMenuFor("/w/index.html");

    // A LEAF, not a submenu parent: no chevron, no aria-haspopup.
    const item = within(rootMenu()).getByRole("menuitem", { name: "Open in Browser" });
    expect(item).not.toHaveAttribute("aria-haspopup");
    expect(item.textContent).toBe("Open in Browser");

    await userEvent.setup().click(item);
    expect(browserIpc.openInBrowser).toHaveBeenCalledWith("/w/index.html", undefined);
  });

  it("falls back the same way for an EMPTY list (an OS we cannot enumerate)", async () => {
    browserIpc.cachedBrowsers.mockReturnValue([]);
    await openMenuFor("/w/index.html");

    const item = within(rootMenu()).getByRole("menuitem", { name: "Open in Browser" });
    expect(item).not.toHaveAttribute("aria-haspopup");
    await userEvent.setup().click(item);
    expect(browserIpc.openInBrowser).toHaveBeenCalledWith("/w/index.html", undefined);
  });

  it("surfaces a rejection in the calm inline note AND the diagnostics log", async () => {
    browserIpc.openInBrowser.mockRejectedValue(new Error("spawn-failed: Safari quit unexpectedly"));
    browserIpc.cachedBrowsers.mockReturnValue([CHROME, SAFARI]);
    await openMenuFor("/w/index.html");

    await userEvent.setup().click(within(openFlyout()).getByRole("menuitem", { name: "Safari" }));

    const note = await screen.findByRole("alert");
    expect(note).toHaveTextContent("Couldn’t open index.html in a browser.");
    expect(note).toHaveTextContent("spawn-failed: Safari quit unexpectedly");
    // Never swallowed: Rust's code survives into the Logs panel.
    const logged = useLogStore.getState().entries.find((e) => e.source === "files");
    expect(logged?.level).toBe("error");
    expect(logged?.detail).toContain("spawn-failed");
    // …and the rail is still up.
    expect(screen.getByTestId("workspace-tree")).toBeInTheDocument();
  });
});

/** StrictMode double-invokes effects at mount; the reveal walk claims its one-shot token before its
 * first `await`, so a cancelled first setup must not leave the second with nothing to do. */
describe("WorkspaceTree — the reveal walk survives StrictMode's double-invoke", () => {
  const layout = () => useAppStore.getState().layoutActions;

  it("reveals into a COLLAPSED root under StrictMode, exactly as in production", async () => {
    // The double-invoke happens only at MOUNT, so the reveal must be one a FRESHLY-MOUNTED subtree
    // picks up (the collapsed root `revealActiveFile` un-collapses); re-firing a mounted effect
    // proves nothing.
    serve({
      "/w": [dir("a", "/w/a")],
      "/w/a": [file("x.ts", "/w/a/x.ts")],
    });
    openRoot("/w");
    act(() => {
      useAppStore.setState((s) => {
        s.collapsedRoots = new Set(["/w"]);
      });
    });
    render(<WorkspaceTree />, { wrapper: StrictMode });
    expect(screen.queryByText("a")).toBeNull(); // collapsed → no listing mounted

    act(() => {
      layout().openEditorTab("/w/a/x.ts");
    });
    act(() => {
      useAppStore.getState().uiActions.revealActiveFile();
    });

    // The uncached `/w/a` really was read, the folder really did open, and the
    // row really is there — none of which happened before the token hand-back.
    const target = await screen.findByText("x.ts");
    expect(workspaceIpc.readDir).toHaveBeenCalledWith("/w/a");
    expect(
      nodeByPath("ws-dir", "/w/a").querySelector(".workspace-node__caret"),
    ).toHaveClass("is-open");
    expect(target.closest(".workspace-node")).toHaveClass("is-selected");
  });
});

describe("WorkspaceTree — Refresh", () => {
  // The tree caches every listing; Refresh is how a file an AGENT created shows up.
  const realRefresh = useGitStore.getState().refreshGitStatus;
  const refreshGitStatus = vi.fn<() => Promise<void>>();
  beforeEach(() => {
    refreshGitStatus.mockReset().mockResolvedValue(undefined);
    act(() => {
      useGitStore.setState({ refreshGitStatus });
    });
  });
  afterEach(() => {
    act(() => {
      useGitStore.setState({ refreshGitStatus: realRefresh });
    });
  });

  it("re-reads the root AND expanded folders, keeping expand state; drops collapsed caches", async () => {
    const table: Record<string, FsEntry[]> = {
      "/w": [dir("src", "/w/src"), dir("docs", "/w/docs"), file("a.ts", "/w/a.ts")],
      "/w/src": [file("main.rs", "/w/src/main.rs")],
      "/w/docs": [file("x.md", "/w/docs/x.md")],
    };
    serve(table);
    openRoot("/w");
    render(<WorkspaceTree />);
    const user = userEvent.setup();
    await user.click(await screen.findByText("src"));
    await screen.findByText("main.rs");
    // docs: expanded then collapsed → cached but not visible.
    await user.click(screen.getByText("docs"));
    await screen.findByText("x.md");
    await user.click(screen.getByText("docs"));

    // An agent writes files behind the tree's back.
    table["/w"] = [...table["/w"], file("new.ts", "/w/new.ts")];
    table["/w/src"] = [...table["/w/src"], file("lib.rs", "/w/src/lib.rs")];
    table["/w/docs"] = [...table["/w/docs"], file("y.md", "/w/docs/y.md")];
    workspaceIpc.readDir.mockClear();

    await user.click(screen.getByRole("button", { name: "Refresh w" }));

    expect(await screen.findByText("new.ts")).toBeInTheDocument();
    expect(await screen.findByText("lib.rs")).toBeInTheDocument(); // still expanded
    const read = workspaceIpc.readDir.mock.calls.map((c) => c[0]);
    expect(read.sort()).toEqual(["/w", "/w/src"]); // collapsed docs NOT re-read…
    expect(refreshGitStatus).toHaveBeenCalledTimes(1);
    // …but its stale cache is gone: expanding it reads fresh.
    await user.click(screen.getByText("docs"));
    expect(await screen.findByText("y.md")).toBeInTheDocument();
  });

  it("the header menu's Refresh does the same, and a failed root read shows the calm note", async () => {
    const table: Record<string, FsEntry[]> = { "/w": [file("a.ts", "/w/a.ts")] };
    serve(table);
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("a.ts");

    table["/w"] = [file("b.ts", "/w/b.ts")];
    fireEvent.contextMenu(headerFor("/w"), { clientX: 10, clientY: 10 });
    await userEvent
      .setup()
      .click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Refresh" }));
    expect(await screen.findByText("b.ts")).toBeInTheDocument();
    expect(screen.queryByText("a.ts")).toBeNull();

    // The folder vanished on disk: the refresh read fails → the root's error note.
    delete table["/w"];
    await userEvent.setup().click(screen.getByRole("button", { name: "Refresh w" }));
    expect(await screen.findByText(/can.t read this folder/i)).toBeInTheDocument();
  });

  it("does not toggle the root, and a collapsed root needs no read (it remounts fresh)", async () => {
    serve({ "/w": [file("a.ts", "/w/a.ts")] });
    openRoot("/w");
    render(<WorkspaceTree />);
    await screen.findByText("a.ts");
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Refresh w" }));
    expect(state().collapsedRoots.has("/w")).toBe(false); // click didn't toggle

    await user.click(headerFor("/w")); // collapse
    workspaceIpc.readDir.mockClear();
    await user.click(screen.getByRole("button", { name: "Refresh w" }));
    expect(workspaceIpc.readDir).not.toHaveBeenCalled();
    await user.click(headerFor("/w")); // expand → exactly one fresh mount read
    await screen.findByText("a.ts");
    expect(workspaceIpc.readDir).toHaveBeenCalledTimes(1);
  });

  it("survives StrictMode's double-invoke — one read per folder", async () => {
    serve({ "/w": [file("a.ts", "/w/a.ts")] });
    openRoot("/w");
    render(
      <StrictMode>
        <WorkspaceTree />
      </StrictMode>,
    );
    await screen.findByText("a.ts");
    workspaceIpc.readDir.mockClear();
    await userEvent.setup().click(screen.getByRole("button", { name: "Refresh w" }));
    await screen.findByText("a.ts");
    expect(workspaceIpc.readDir).toHaveBeenCalledTimes(1);
  });
});
