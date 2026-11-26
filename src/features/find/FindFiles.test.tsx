/** `findIpc` and `read_dir` are mocked at the module boundary (marshalling is in
 * `findIpc.test.ts`). Fake timers + `fireEvent` keep the debounce deterministic. */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The factory replaces the module: a forgotten export arrives as `undefined` and crashes inside
// an effect while the suite stays green.
const findIpc = vi.hoisted(() => ({
  findFiles: vi.fn(),
  cancelFind: vi.fn(),
  newSearchId: vi.fn(),
}));
vi.mock("./findIpc", () => findIpc);

// The scope selector's Folder dropdown reads subdirs via `read_dir`; mock only
// that wrapper, keeping `readFile`/`writeFile` real for the editor a hit opens.
const workspaceIpc = vi.hoisted(() => ({ readDir: vi.fn() }));
vi.mock("../workspace/workspaceIpc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../workspace/workspaceIpc")>()),
  readDir: workspaceIpc.readDir,
}));

// A plain terminal's cwd is the registry's (`getTerminalMeta` — the cwd Rust
// opened the PTY in). Overridden so the context-scope tests can say "this terminal
// runs in gazelle" without a PTY; every other export stays real (the store uses them).
const terminalMeta = vi.hoisted(() => ({ cwds: {} as Record<string, string> }));
vi.mock("../terminal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../terminal")>()),
  getTerminalMeta: (id: string) => {
    const cwd = terminalMeta.cwds[id];
    return cwd === undefined
      ? null
      : { id, kind: "terminal", title: id, cwd, cols: 80, rows: 24, status: "live" };
  },
}));

import { useAppStore } from "../../app/store";
import { asTabId, asTerminalId, type Tab } from "../../app/types";
import { resetFleetStore } from "../../test/fleet-harness";
import { resetStore } from "../../test/store-harness";
import { FindFiles, OPEN_FIND_FILES_EVENT } from "./FindFiles";
import { ALL_WORKSPACES } from "./ScopeSelector";
import type { FindFileHit, FindFilesResult } from "./findIpc";

const DEBOUNCE_MS = 200;

const hit = (path: string, name: string): FindFileHit => ({ path, name });
const result = (files: FindFileHit[], truncated = false): FindFilesResult => ({ files, truncated });

const setRoot = (path: string | null) =>
  act(() => {
    useAppStore.setState((s) => {
      s.workspaceRoot = path;
    });
  });

const press = (init: Partial<KeyboardEventInit>) => fireEvent.keyDown(window, init);
const openPanel = () => press({ key: "O", metaKey: true, shiftKey: true });

const input = () => screen.getByLabelText("Find files");
const typeQuery = (value: string) => fireEvent.change(input(), { target: { value } });

/** Fire the debounce timer and flush the resolved search promise. */
async function runSearch() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
  });
}

const editorTabs = (): Tab[] =>
  Object.values(useAppStore.getState().tabs).filter((t) => t.ref.kind === "editor");

/** The searchId the component handed Rust for each call (the 4th invoke arg). */
const searchIds = (): unknown[] => findIpc.findFiles.mock.calls.map((c) => c[3]);
/** Every id `find_cancel` was asked to stop, in order. */
const cancelIds = (): unknown[] => findIpc.cancelFind.mock.calls.map((c) => c[0]);

/** Deterministic search ids ("sid-1", "sid-2", …) so cancels are assertable by NAME. */
let mintedIds = 0;

beforeEach(() => {
  resetStore();
  resetFleetStore();
  findIpc.findFiles.mockReset();
  findIpc.cancelFind.mockReset();
  findIpc.cancelFind.mockResolvedValue(true);
  mintedIds = 0;
  findIpc.newSearchId.mockReset();
  findIpc.newSearchId.mockImplementation(() => `sid-${++mintedIds}`);
  workspaceIpc.readDir.mockReset();
  workspaceIpc.readDir.mockResolvedValue([]);
  terminalMeta.cwds = {};
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("FindFiles — toggle + hotkeys", () => {
  it("is hidden until Cmd+Shift+O, focuses the input on open, and toggles closed on a second press", () => {
    render(<FindFiles />);
    expect(screen.queryByTestId("find-files")).toBeNull();

    openPanel();
    expect(screen.getByTestId("find-files")).toBeInTheDocument();
    expect(input()).toHaveFocus();

    openPanel();
    expect(screen.queryByTestId("find-files")).toBeNull();
  });

  it("opens with Ctrl+Shift+O too (the non-mac modifier)", () => {
    render(<FindFiles />);
    press({ key: "O", ctrlKey: true, shiftKey: true });
    expect(screen.getByTestId("find-files")).toBeInTheDocument();
  });

  it("closes on Esc and on the ✕ button", () => {
    render(<FindFiles />);
    openPanel();
    press({ key: "Escape" });
    expect(screen.queryByTestId("find-files")).toBeNull();

    openPanel();
    fireEvent.click(screen.getByLabelText("Close find files"));
    expect(screen.queryByTestId("find-files")).toBeNull();
  });

  it("ignores the shortcut without shift, non-'o' chords, and unmodified keys", () => {
    render(<FindFiles />);
    press({ key: "o", metaKey: true }); // no shift
    press({ key: "p", metaKey: true, shiftKey: true }); // wrong key
    press({ key: "a" }); // no modifier, not Escape
    expect(screen.queryByTestId("find-files")).toBeNull();
  });

  it("OPENS (never toggles) on the bare Cmd/Ctrl+O request event, and stops listening on unmount", () => {
    const { unmount } = render(<FindFiles />);
    act(() => {
      window.dispatchEvent(new Event(OPEN_FIND_FILES_EVENT));
    });
    expect(screen.getByTestId("find-files")).toBeInTheDocument();
    expect(input()).toHaveFocus();
    act(() => {
      window.dispatchEvent(new Event(OPEN_FIND_FILES_EVENT));
    });
    expect(screen.getByTestId("find-files")).toBeInTheDocument();

    unmount();
    render(<FindFiles />);
    press({ key: "Escape" });
    // A fresh mount starts closed; the old instance's listener is gone (no stray re-open).
    expect(screen.queryByTestId("find-files")).toBeNull();
  });
});

describe("FindFiles — search", () => {
  it("debounces, searches the scope root with the default (case-insensitive) option, and lists hits", async () => {
    setRoot("/w");
    findIpc.findFiles.mockResolvedValue(
      result([hit("src/store.ts", "store.ts"), hit("store.test.ts", "store.test.ts")]),
    );

    render(<FindFiles />);
    openPanel();
    // Nothing typed yet: a calm hint, and no IPC call.
    expect(screen.getByText("Type a file name.")).toBeInTheDocument();

    typeQuery("store");
    await runSearch();

    expect(findIpc.findFiles).toHaveBeenCalledTimes(1);
    expect(findIpc.findFiles).toHaveBeenCalledWith("/w", "store", { caseSensitive: false }, "sid-1");
    expect(screen.getByTestId("find-files-count")).toHaveTextContent("2 files");
    expect(screen.getAllByTestId("find-file-hit")).toHaveLength(2);
    // Row shows the basename (bold) plus the dim relative path.
    expect(screen.getByText("store.ts")).toBeInTheDocument();
    expect(screen.getByText("src/store.ts")).toBeInTheDocument();
  });

  it("passes the case-sensitive toggle through, and renders the singular count", async () => {
    setRoot("/w");
    findIpc.findFiles.mockResolvedValue(result([hit("README.md", "README.md")]));

    render(<FindFiles />);
    openPanel();
    fireEvent.click(screen.getByLabelText("Case sensitive"));
    expect(screen.getByLabelText("Case sensitive")).toHaveAttribute("aria-pressed", "true");

    typeQuery("README");
    await runSearch();

    expect(findIpc.findFiles).toHaveBeenLastCalledWith("/w", "README", { caseSensitive: true }, expect.any(String));
    expect(screen.getByTestId("find-files-count")).toHaveTextContent("1 file");
  });

  it("opens a hit in an editor tab (joined to the scope root) and closes the overlay", async () => {
    setRoot("/w");
    findIpc.findFiles.mockResolvedValue(result([hit("src/store.ts", "store.ts")]));

    render(<FindFiles />);
    openPanel();
    typeQuery("store");
    await runSearch();

    // A POSIX root shows the relative path exactly as `find_files` sent it.
    expect(screen.getByTestId("find-file-hit").querySelector(".find-file__path")).toHaveTextContent(/^src\/store\.ts$/);
    fireEvent.click(screen.getByTestId("find-file-hit"));
    expect(editorTabs()).toHaveLength(1);
    expect(editorTabs()[0].ref).toEqual({ kind: "editor", path: "/w/src/store.ts" });
    // Opening a hit closes the overlay so the opened file is visible.
    expect(screen.queryByTestId("find-files")).toBeNull();
  });

  it("opens a Windows hit at the tree's own spelling — `find_files` sends `/`, the tab is `C:\\…\\…`", async () => {
    // A mixed `C:\w/src/store.ts` tab is a second tab on a file the tree calls `C:\w\src\store.ts`.
    setRoot("C:\\w\\");
    findIpc.findFiles.mockResolvedValue(result([hit("src/store.ts", "store.ts")]));

    render(<FindFiles />);
    openPanel();
    typeQuery("store");
    await runSearch();

    // On screen too: `\`, the way Find in Files (native from `find`) shows its folders.
    expect(screen.getByTestId("find-file-hit").querySelector(".find-file__path")).toHaveTextContent(/^src\\store\.ts$/);
    fireEvent.click(screen.getByTestId("find-file-hit"));
    expect(editorTabs()[0].ref).toEqual({ kind: "editor", path: "C:\\w\\src\\store.ts" });
  });

  it("opens the FIRST hit on Enter, and ignores a non-Enter key", async () => {
    setRoot("/w");
    findIpc.findFiles.mockResolvedValue(
      result([hit("src/store.ts", "store.ts"), hit("b.ts", "b.ts")]),
    );

    render(<FindFiles />);
    openPanel();
    typeQuery("store");
    await runSearch();

    fireEvent.keyDown(input(), { key: "a" }); // not Enter → no-op
    expect(editorTabs()).toHaveLength(0);

    fireEvent.keyDown(input(), { key: "Enter" }); // opens the first (top-ranked) hit
    expect(editorTabs()[0].ref).toEqual({ kind: "editor", path: "/w/src/store.ts" });
    expect(screen.queryByTestId("find-files")).toBeNull();
  });

  it("does nothing on Enter when there are no results", async () => {
    setRoot("/w");
    findIpc.findFiles.mockResolvedValue(result([]));

    render(<FindFiles />);
    openPanel();
    // Empty query → resting hint; Enter has nothing to open.
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(editorTabs()).toHaveLength(0);
    expect(screen.getByTestId("find-files")).toBeInTheDocument();
  });

  it("notes when Rust truncated the file list", async () => {
    setRoot("/w");
    findIpc.findFiles.mockResolvedValue(result([hit("a.ts", "a.ts")], true));

    render(<FindFiles />);
    openPanel();
    typeQuery("a");
    await runSearch();

    expect(screen.getByTestId("find-files-truncated")).toBeInTheDocument();
  });

  it("shows a searching indicator while a search is in flight", async () => {
    setRoot("/w");
    findIpc.findFiles.mockReturnValue(new Promise<FindFilesResult>(() => {})); // never resolves

    render(<FindFiles />);
    openPanel();
    typeQuery("x");
    await runSearch();

    expect(screen.getByText("Searching…")).toBeInTheDocument();
  });

  it("shows a calm 'No matching files' state", async () => {
    setRoot("/w");
    findIpc.findFiles.mockResolvedValue(result([]));

    render(<FindFiles />);
    openPanel();
    typeQuery("nope");
    await runSearch();

    expect(screen.getByText("No matching files")).toBeInTheDocument();
  });

  it("surfaces an Error message from Rust", async () => {
    setRoot("/w");
    findIpc.findFiles.mockRejectedValue(new Error("index unavailable"));

    render(<FindFiles />);
    openPanel();
    typeQuery("x");
    await runSearch();

    expect(screen.getByRole("alert")).toHaveTextContent("index unavailable");
  });

  it("surfaces a bare-string rejection too", async () => {
    setRoot("/w");
    findIpc.findFiles.mockRejectedValue("backend down");

    render(<FindFiles />);
    openPanel();
    typeQuery("x");
    await runSearch();

    expect(screen.getByRole("alert")).toHaveTextContent("backend down");
  });

  it("clears results (without searching) when the query is emptied", async () => {
    setRoot("/w");
    findIpc.findFiles.mockResolvedValue(result([hit("a.ts", "a.ts")]));

    render(<FindFiles />);
    openPanel();
    typeQuery("a");
    await runSearch();
    expect(screen.getByTestId("find-files-count")).toBeInTheDocument();

    const callsBefore = findIpc.findFiles.mock.calls.length;
    typeQuery(""); // clears synchronously; no new timer, no new call
    expect(screen.getByText("Type a file name.")).toBeInTheDocument();
    expect(findIpc.findFiles.mock.calls.length).toBe(callsBefore);
  });

  it("neither searches nor crashes when there is no workspace root", async () => {
    setRoot(null);
    findIpc.findFiles.mockResolvedValue(result([]));

    render(<FindFiles />);
    openPanel();
    typeQuery("x");
    await runSearch();

    expect(findIpc.findFiles).not.toHaveBeenCalled();
    expect(screen.getByText("Open a folder to search.")).toBeInTheDocument();
  });

  it("ignores a stale in-flight result when the query changes mid-flight", async () => {
    setRoot("/w");
    let resolveStale!: (r: FindFilesResult) => void;
    findIpc.findFiles
      .mockImplementationOnce(() => new Promise<FindFilesResult>((res) => (resolveStale = res)))
      .mockResolvedValueOnce(result([hit("dir/fresh.ts", "fresh.ts")]));

    render(<FindFiles />);
    openPanel();
    typeQuery("a");
    await runSearch(); // first search fires, stays pending → "Searching…"
    expect(screen.getByText("Searching…")).toBeInTheDocument();

    typeQuery("ab"); // supersedes: cleanup marks the first cancelled
    await runSearch(); // second search resolves fresh
    expect(screen.getByText("fresh.ts")).toBeInTheDocument();

    // The stale resolution must be ignored — it cannot overwrite the fresh view.
    await act(async () => {
      resolveStale(result([hit("dir/stale.ts", "stale.ts")]));
      await Promise.resolve();
    });
    expect(screen.getByText("fresh.ts")).toBeInTheDocument();
    expect(screen.queryByText("stale.ts")).toBeNull();
  });
});

/** Fan-out over two roots: one search per root, merged, repo-labelled; click and Enter both open
 * in the right repo. */
describe("FindFiles — All workspaces (fan-out)", () => {
  const CI = { caseSensitive: false };

  const seedTwoRoots = () => {
    setRoot("/work/alpha");
    act(() => {
      useAppStore.setState((s) => {
        s.browseRoots = ["/work/beta"];
      });
    });
  };
  const selectAll = () =>
    fireEvent.change(screen.getByLabelText("Search workspace"), { target: { value: ALL_WORKSPACES } });
  const perRoot = () =>
    findIpc.findFiles.mockImplementation((root: string) =>
      Promise.resolve(
        root === "/work/alpha" ? result([hit("a.ts", "a.ts")]) : result([hit("b.ts", "b.ts")]),
      ),
    );

  it("searches every root once, merges, and labels each row with its repo", async () => {
    seedTwoRoots();
    perRoot();

    render(<FindFiles />);
    openPanel();
    selectAll();
    typeQuery("x");
    await runSearch();

    expect(findIpc.findFiles).toHaveBeenCalledTimes(2);
    expect(findIpc.findFiles).toHaveBeenCalledWith("/work/alpha", "x", CI, "sid-1");
    expect(findIpc.findFiles).toHaveBeenCalledWith("/work/beta", "x", CI, "sid-2");

    expect(screen.getByTestId("find-files-count")).toHaveTextContent("2 files");
    expect(screen.getAllByTestId("find-file-repo").map((e) => e.textContent)).toEqual(["alpha", "beta"]);
  });

  it("clicking a row opens it under ITS root (not the primary)", async () => {
    seedTwoRoots();
    perRoot();

    render(<FindFiles />);
    openPanel();
    selectAll();
    typeQuery("x");
    await runSearch();

    fireEvent.click(screen.getAllByTestId("find-file-hit")[1]);
    expect(editorTabs()[0].ref).toEqual({ kind: "editor", path: "/work/beta/b.ts" });
  });

  it("Enter opens the first hit under ITS root", async () => {
    seedTwoRoots();
    perRoot();

    render(<FindFiles />);
    openPanel();
    selectAll();
    typeQuery("x");
    await runSearch();

    fireEvent.keyDown(input(), { key: "Enter" });
    expect(editorTabs()[0].ref).toEqual({ kind: "editor", path: "/work/alpha/a.ts" });
  });
});

/** The same kill switch as Find in Files; a stopped search never claims no matching files.
 * Searches are held still (never-settling promises). */
describe("FindFiles — cancelling a slow search", () => {
  /** A search that never settles — a slow walk, held still. */
  const hangs = () =>
    findIpc.findFiles.mockReturnValue(new Promise<FindFilesResult>(() => {}));

  /** Open the panel and get one slow search in flight (id "sid-1"). */
  const startSlowSearch = async () => {
    setRoot("/w");
    hangs();
    render(<FindFiles />);
    openPanel();
    typeQuery("slow");
    await runSearch();
  };

  it("offers the Stop control only while a search is actually running", async () => {
    setRoot("/w");
    let settle!: (r: FindFilesResult) => void;
    findIpc.findFiles.mockReturnValue(new Promise<FindFilesResult>((res) => (settle = res)));

    render(<FindFiles />);
    openPanel();
    expect(screen.queryByTestId("find-files-cancel")).toBeNull(); // nothing to stop

    typeQuery("slow");
    await runSearch();
    expect(screen.getByTestId("find-files-cancel")).toBeInTheDocument();
    expect(screen.getByLabelText("Cancel file search")).toBeInTheDocument();

    await act(async () => {
      settle(result([]));
      await Promise.resolve();
    });
    expect(screen.queryByTestId("find-files-cancel")).toBeNull();
  });

  it("Stop cancels the RUNNING walk by its own id and lands on a calm stopped state", async () => {
    await startSlowSearch();

    fireEvent.click(screen.getByTestId("find-files-cancel"));

    expect(searchIds()).toEqual(["sid-1"]);
    expect(cancelIds()).toEqual(["sid-1"]);

    expect(screen.getByTestId("find-files-stopped")).toHaveTextContent(
      "Search stopped before it finished.",
    );
    // "No matching files" is a claim about the project; a stopped walk made none.
    expect(screen.queryByText("No matching files")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("Searching…")).toBeNull();
  });

  it("Escape cancels the in-flight walk on its way out — and still closes the panel", async () => {
    await startSlowSearch();

    press({ key: "Escape" });

    expect(screen.queryByTestId("find-files")).toBeNull();
    expect(cancelIds()).toEqual(["sid-1"]);
  });

  it("closing with ✕ cancels the in-flight walk", async () => {
    await startSlowSearch();

    fireEvent.click(screen.getByLabelText("Close find files"));

    expect(cancelIds()).toEqual(["sid-1"]);
  });

  it("a new search cancels the one it supersedes — and only that one", async () => {
    await startSlowSearch();

    typeQuery("slower");
    expect(cancelIds()).toEqual(["sid-1"]);

    await runSearch();
    expect(searchIds()).toEqual(["sid-1", "sid-2"]);
    expect(cancelIds()).toEqual(["sid-1"]);
  });

  it("cancels EVERY root's walk when the search fanned out over all workspaces", async () => {
    setRoot("/work/alpha");
    act(() => {
      useAppStore.setState((s) => {
        s.browseRoots = ["/work/beta"];
      });
    });
    hangs();

    render(<FindFiles />);
    openPanel();
    fireEvent.change(screen.getByLabelText("Search workspace"), {
      target: { value: ALL_WORKSPACES },
    });
    typeQuery("x");
    await runSearch();

    expect(searchIds()).toEqual(["sid-1", "sid-2"]);

    fireEvent.click(screen.getByTestId("find-files-cancel"));
    // Both legs, not just the first — otherwise a walk keeps burning a CPU with
    // nobody left who wants its answer.
    expect(cancelIds()).toEqual(["sid-1", "sid-2"]);
  });

  it("Stop during the debounce window keeps the queued search from ever starting", async () => {
    await startSlowSearch();

    typeQuery("slower"); // old walk cancelled; the replacement is queued, not fired
    expect(screen.getByTestId("find-files-cancel")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("find-files-cancel"));
    await runSearch();

    expect(findIpc.findFiles).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("find-files-stopped")).toBeInTheDocument();
  });

  it("drops the spinner when a cancelled walk finally replies — it must not stay stuck", async () => {
    setRoot("/w");
    let rejectWalk!: (e: unknown) => void;
    findIpc.findFiles.mockReturnValue(
      new Promise<FindFilesResult>((_res, rej) => (rejectWalk = rej)),
    );

    render(<FindFiles />);
    openPanel();
    typeQuery("slow");
    await runSearch();
    expect(screen.getByText("Searching…")).toBeInTheDocument();

    press({ key: "Escape" });
    await act(async () => {
      rejectWalk(new Error("cancelled"));
      await Promise.resolve();
    });

    openPanel();
    expect(screen.queryByText("Searching…")).toBeNull();
    expect(screen.queryByTestId("find-files-cancel")).toBeNull();
  });

  it("a `cancelled` rejection is silent — neither an error nor a false 'No matching files'", async () => {
    setRoot("/w");
    findIpc.findFiles.mockRejectedValue(new Error("cancelled"));

    render(<FindFiles />);
    openPanel();
    typeQuery("x");
    await runSearch();

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("No matching files")).toBeNull();
    expect(screen.queryByText("Searching…")).toBeNull();
  });

  it("a genuine failure that merely MENTIONS cancellation still reaches the user", async () => {
    setRoot("/w");
    findIpc.findFiles.mockRejectedValue(new Error("read cancelled by the OS"));

    render(<FindFiles />);
    openPanel();
    typeQuery("x");
    await runSearch();

    expect(screen.getByRole("alert")).toHaveTextContent("read cancelled by the OS");
  });

  it("a slow walk's late reply cannot overwrite the fast one that replaced it", async () => {
    // Two-sided: the current search's rows must be present AND the
    // superseded one's must be absent — "stale is gone" alone is also satisfied
    // by a panel that renders nothing.
    setRoot("/w");
    let resolveSlow!: (r: FindFilesResult) => void;
    findIpc.findFiles
      .mockImplementationOnce(() => new Promise<FindFilesResult>((res) => (resolveSlow = res)))
      .mockResolvedValueOnce(result([hit("dir/fresh.ts", "fresh.ts")]));

    render(<FindFiles />);
    openPanel();
    typeQuery("a");
    await runSearch(); // slow run — sid-1
    typeQuery("ab");
    await runSearch(); // fast run — sid-2

    expect(screen.getByText("fresh.ts")).toBeInTheDocument();
    expect(cancelIds()).toEqual(["sid-1"]);

    await act(async () => {
      resolveSlow(result([hit("dir/stale.ts", "stale.ts")]));
      await Promise.resolve();
    });

    expect(screen.getByText("fresh.ts")).toBeInTheDocument();
    expect(screen.queryByText("stale.ts")).toBeNull();
  });
});

/** Two roots with alpha as primary; the focused tab lives in gazelle, so the search must cover
 * gazelle. */
describe("FindFiles — scope follows the focused tab", () => {
  const CI = { caseSensitive: false };
  const workspaceSelect = () => screen.getByLabelText("Search workspace");

  const seedRoots = () => {
    setRoot("/w/alpha");
    act(() => {
      useAppStore.setState((s) => {
        s.browseRoots = ["/w/gazelle"];
      });
    });
  };
  /** Make `ref` the focused pane's active tab (the harness has one leaf). */
  const focusTab = (id: string, ref: Tab["ref"]) =>
    act(() => {
      useAppStore.setState((s) => {
        const tabId = asTabId(id);
        s.tabs[tabId] = { id: tabId, kind: ref.kind, title: id, ref };
        const leaf = s.layout;
        if (leaf.type !== "leaf") throw new Error("harness expects a single leaf");
        leaf.tabIds.push(tabId);
        leaf.activeTabId = tabId;
      });
    });

  it("a focused gazelle FILE scopes a fresh open to gazelle, not the primary root", async () => {
    seedRoots();
    focusTab("g", { kind: "editor", path: "/w/gazelle/src/lib.rs" });
    findIpc.findFiles.mockResolvedValue(result([]));

    render(<FindFiles />);
    openPanel();
    expect(workspaceSelect()).toHaveValue("/w/gazelle");

    typeQuery("x");
    await runSearch();
    expect(findIpc.findFiles).toHaveBeenLastCalledWith("/w/gazelle", "x", CI, expect.any(String));
  });

  it("a focused gazelle TERMINAL (its cwd) scopes to gazelle too", async () => {
    seedRoots();
    terminalMeta.cwds["term-g"] = "/w/gazelle";
    focusTab("t", { kind: "terminal", terminalId: asTerminalId("term-g") });
    findIpc.findFiles.mockResolvedValue(result([]));

    render(<FindFiles />);
    openPanel();
    expect(workspaceSelect()).toHaveValue("/w/gazelle");

    typeQuery("x");
    await runSearch();
    expect(findIpc.findFiles).toHaveBeenLastCalledWith("/w/gazelle", "x", CI, expect.any(String));
  });

  it("a terminal whose PTY has not opened yet falls back to the last file tab activated", () => {
    seedRoots();
    // A gazelle file was the last file tab made active, in some other pane/view.
    act(() => {
      useAppStore.setState((s) => {
        const tabId = asTabId("g");
        s.tabs[tabId] = { id: tabId, kind: "editor", title: "g", ref: { kind: "editor", path: "/w/gazelle/g.ts" } };
        s.lastFilePath = "/w/gazelle/g.ts";
      });
    });
    // No `terminalMeta.cwds` entry: the registry has no cwd for this one yet.
    focusTab("t", { kind: "terminal", terminalId: asTerminalId("term-new") });

    render(<FindFiles />);
    openPanel();
    expect(workspaceSelect()).toHaveValue("/w/gazelle");
  });

  it("with no tab that names a folder, keeps the old default (the primary root)", () => {
    seedRoots();
    focusTab("v", { kind: "village" });

    render(<FindFiles />);
    openPanel();
    expect(workspaceSelect()).toHaveValue("/w/alpha");
  });

  it("an explicit pick wins while open, and a fresh open follows the context again", async () => {
    seedRoots();
    focusTab("g", { kind: "editor", path: "/w/gazelle/src/lib.rs" });
    findIpc.findFiles.mockResolvedValue(result([]));

    render(<FindFiles />);
    openPanel();
    fireEvent.change(workspaceSelect(), { target: { value: "/w/alpha" } });
    typeQuery("x");
    await runSearch();
    expect(workspaceSelect()).toHaveValue("/w/alpha");
    expect(findIpc.findFiles).toHaveBeenLastCalledWith("/w/alpha", "x", CI, expect.any(String));

    // Close and reopen: the pick does not outlive the overlay — gazelle again.
    openPanel();
    openPanel();
    expect(workspaceSelect()).toHaveValue("/w/gazelle");
    await runSearch(); // the kept query re-searches — under the context root
    expect(findIpc.findFiles).toHaveBeenLastCalledWith("/w/gazelle", "x", CI, expect.any(String));
  });

  it("re-resolves on every open — moving to another repo's file moves the default", () => {
    seedRoots();
    focusTab("a", { kind: "editor", path: "/w/alpha/a.ts" });

    render(<FindFiles />);
    openPanel();
    expect(workspaceSelect()).toHaveValue("/w/alpha");
    openPanel(); // close

    focusTab("g", { kind: "editor", path: "/w/gazelle/g.ts" });
    openPanel();
    expect(workspaceSelect()).toHaveValue("/w/gazelle");
  });

  it("a focus change while OPEN neither moves the dropdown nor restarts the search", async () => {
    seedRoots();
    focusTab("g", { kind: "editor", path: "/w/gazelle/src/lib.rs" });
    findIpc.findFiles.mockResolvedValue(result([]));

    render(<FindFiles />);
    openPanel();
    typeQuery("x");
    await runSearch();
    expect(findIpc.findFiles).toHaveBeenCalledTimes(1);
    expect(findIpc.findFiles).toHaveBeenLastCalledWith("/w/gazelle", "x", CI, expect.any(String));

    // The overlay has no backdrop: clicking an alpha pane while it is up must not
    // silently re-scope it — the context is taken once, when it opened.
    focusTab("a", { kind: "editor", path: "/w/alpha/a.ts" });
    await runSearch();
    expect(workspaceSelect()).toHaveValue("/w/gazelle");
    expect(findIpc.findFiles).toHaveBeenCalledTimes(1);

    // …and the next fresh open does follow the new focus.
    openPanel();
    openPanel();
    expect(workspaceSelect()).toHaveValue("/w/alpha");
  });

  it("gazelle console → village: the default stays gazelle, not an older file elsewhere", () => {
    seedRoots();
    // The last FILE tab was in alpha…
    act(() => {
      useAppStore.setState((s) => {
        const tabId = asTabId("a");
        s.tabs[tabId] = { id: tabId, kind: "editor", title: "a", ref: { kind: "editor", path: "/w/alpha/a.ts" } };
        s.lastFilePath = "/w/alpha/a.ts";
      });
    });
    render(<FindFiles />);
    // …but the console the user was just in runs in gazelle; then the pane
    // switches to the village (all while the overlay is closed).
    terminalMeta.cwds["term-g"] = "/w/gazelle";
    focusTab("t", { kind: "terminal", terminalId: asTerminalId("term-g") });
    focusTab("v", { kind: "village" });

    openPanel();
    expect(workspaceSelect()).toHaveValue("/w/gazelle");
  });

  it("a terminal outside every root falls through to the last file's root, not the primary", () => {
    seedRoots();
    act(() => {
      useAppStore.setState((s) => {
        const tabId = asTabId("g");
        s.tabs[tabId] = { id: tabId, kind: "editor", title: "g", ref: { kind: "editor", path: "/w/gazelle/g.ts" } };
        s.lastFilePath = "/w/gazelle/g.ts";
      });
    });
    // A "+" terminal spawned in the home folder — inside no open root.
    terminalMeta.cwds["term-home"] = "/home/u";
    focusTab("t", { kind: "terminal", terminalId: asTerminalId("term-home") });

    render(<FindFiles />);
    openPanel();
    expect(workspaceSelect()).toHaveValue("/w/gazelle");
  });

  it("drops a snapshot whose root closes while the overlay is open", () => {
    seedRoots();
    focusTab("g", { kind: "editor", path: "/w/gazelle/src/lib.rs" });

    render(<FindFiles />);
    openPanel();
    expect(workspaceSelect()).toHaveValue("/w/gazelle");
    act(() => {
      useAppStore.setState((s) => {
        s.browseRoots = [];
      });
    });
    expect(workspaceSelect()).toHaveValue("/w/alpha");
  });
});
