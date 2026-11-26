/** `findIpc` is mocked at the module boundary (its marshalling is in `findIpc.test.ts`). Fake
 * timers + `fireEvent`: `advanceTimersByTimeAsync` fires the debounce and flushes the promise. */

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The factory replaces the module: a forgotten export arrives as `undefined` and crashes inside
// an effect while the suite stays green.
const findIpc = vi.hoisted(() => ({
  findInFiles: vi.fn(),
  cancelFind: vi.fn(),
  newSearchId: vi.fn(),
}));
vi.mock("./findIpc", () => findIpc);

// Only `readDir` is mocked (for the Folder dropdown); `readFile`/`writeFile` stay real. Default:
// no subdirs.
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
import { asAgentId, asTabId, asTerminalId, type Tab } from "../../app/types";
import { resetFleetStore, wireAgent } from "../../test/fleet-harness";
import { resetStore } from "../../test/store-harness";
import { FindInFiles } from "./FindInFiles";
import { ALL_WORKSPACES } from "./ScopeSelector";
import type { FindMatch, FindResult } from "./findIpc";

const DEBOUNCE_MS = 200;

const match = (over: Partial<FindMatch> & { file: string; line: number }): FindMatch => ({
  col: 1,
  lineText: "x",
  matchStart: 0,
  matchEnd: 1,
  ...over,
});

const result = (matches: FindMatch[], truncated = false): FindResult => ({ matches, truncated });

const setRoot = (path: string | null) =>
  act(() => {
    useAppStore.setState((s) => {
      s.workspaceRoot = path;
    });
  });

const press = (init: Partial<KeyboardEventInit>) => fireEvent.keyDown(window, init);
const openPanel = () => press({ key: "F", metaKey: true, shiftKey: true });

const input = () => screen.getByLabelText("Search in files");
const typeQuery = (value: string) => fireEvent.change(input(), { target: { value } });

/** Fire the debounce timer and flush the resolved search promise. */
async function runSearch() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
  });
}

const editorTabs = (): Tab[] =>
  Object.values(useAppStore.getState().tabs).filter((t) => t.ref.kind === "editor");

/** The searchId the component handed Rust for call `i` (the 4th invoke arg). */
const searchIds = (): unknown[] => findIpc.findInFiles.mock.calls.map((c) => c[3]);
/** Every id `find_cancel` was asked to stop, in order. */
const cancelIds = (): unknown[] => findIpc.cancelFind.mock.calls.map((c) => c[0]);

/** Deterministic search ids ("sid-1", "sid-2", …) so cancels are assertable by NAME. */
let mintedIds = 0;

beforeEach(() => {
  resetStore();
  resetFleetStore();
  findIpc.findInFiles.mockReset();
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

describe("FindInFiles — toggle + hotkeys", () => {
  it("is hidden until Cmd+Shift+F, focuses the input on open, and toggles closed on a second press", () => {
    render(<FindInFiles />);
    expect(screen.queryByTestId("find-in-files")).toBeNull();
    expect(useAppStore.getState().findInFilesOpen).toBe(false);

    openPanel();
    expect(screen.getByTestId("find-in-files")).toBeInTheDocument();
    expect(input()).toHaveFocus();
    // The hotkey drives the store flag, not a local state.
    expect(useAppStore.getState().findInFilesOpen).toBe(true);

    openPanel();
    expect(screen.queryByTestId("find-in-files")).toBeNull();
    expect(useAppStore.getState().findInFilesOpen).toBe(false);
  });

  it("opens with Ctrl+Shift+F too (the non-mac modifier)", () => {
    render(<FindInFiles />);
    press({ key: "F", ctrlKey: true, shiftKey: true });
    expect(screen.getByTestId("find-in-files")).toBeInTheDocument();
  });

  it("closes on Esc", () => {
    render(<FindInFiles />);
    openPanel();
    expect(screen.getByTestId("find-in-files")).toBeInTheDocument();

    press({ key: "Escape" });
    expect(screen.queryByTestId("find-in-files")).toBeNull();
  });

  it("closes on the ✕ button", () => {
    render(<FindInFiles />);
    openPanel();
    fireEvent.click(screen.getByLabelText("Close search"));
    expect(screen.queryByTestId("find-in-files")).toBeNull();
  });

  it("ignores the shortcut without shift, non-'f' chords, and unmodified keys", () => {
    render(<FindInFiles />);
    press({ key: "f", metaKey: true }); // no shift
    press({ key: "g", metaKey: true, shiftKey: true }); // wrong key
    press({ key: "a" }); // no modifier, not Escape
    expect(screen.queryByTestId("find-in-files")).toBeNull();
  });
});

describe("FindInFiles — search", () => {
  it("debounces, searches the workspace root with default options, and groups results with a count", async () => {
    setRoot("/w");
    findIpc.findInFiles.mockResolvedValue(
      result([
        match({ file: "/w/src/a.ts", line: 3 }),
        match({ file: "/w/src/a.ts", line: 9 }),
        match({ file: "b.md", line: 1 }), // bare filename → no dir segment
      ]),
    );

    render(<FindInFiles />);
    openPanel();
    // Nothing typed yet: a calm hint, and no IPC call.
    expect(screen.getByText("Type to search the project.")).toBeInTheDocument();

    typeQuery("todo");
    await runSearch();

    expect(findIpc.findInFiles).toHaveBeenCalledTimes(1);
    // The 4th argument is the cancellable search id; the id ITSELF
    // is pinned by the cancellation suite at the bottom of this file.
    expect(findIpc.findInFiles).toHaveBeenCalledWith(
      "/w",
      "todo",
      { regex: false, caseSensitive: false, wholeWord: false, glob: "" },
      "sid-1",
    );
    expect(screen.getByTestId("find-count")).toHaveTextContent("3 matches in 2 files");
    expect(screen.getAllByTestId("find-file")).toHaveLength(2);
    expect(screen.getAllByTestId("find-match")).toHaveLength(3);
    // The dir segment shows for a nested file, and is absent for a bare name.
    expect(screen.getByText("/w/src")).toBeInTheDocument();
  });

  it("passes every modifier and the file mask through to the search", async () => {
    setRoot("/w");
    findIpc.findInFiles.mockResolvedValue(result([]));

    render(<FindInFiles />);
    openPanel();

    fireEvent.click(screen.getByLabelText("Case sensitive"));
    fireEvent.click(screen.getByLabelText("Whole word"));
    fireEvent.click(screen.getByLabelText("Regular expression"));
    fireEvent.change(screen.getByLabelText("File mask"), { target: { value: "*.rs" } });

    typeQuery("fn main");
    await runSearch();

    expect(findIpc.findInFiles).toHaveBeenLastCalledWith(
      "/w",
      "fn main",
      { regex: true, caseSensitive: true, wholeWord: true, glob: "*.rs" },
      expect.any(String),
    );
    // The active toggles reflect their pressed state.
    expect(screen.getByLabelText("Regular expression")).toHaveAttribute("aria-pressed", "true");
  });

  it("shows a searching indicator while a search is in flight", async () => {
    setRoot("/w");
    findIpc.findInFiles.mockReturnValue(new Promise<FindResult>(() => {})); // never resolves

    render(<FindInFiles />);
    openPanel();
    typeQuery("x");
    await runSearch();

    expect(screen.getByText("Searching…")).toBeInTheDocument();
  });

  it("opens a hit in an editor tab, and renders the singular count", async () => {
    setRoot("/w");
    findIpc.findInFiles.mockResolvedValue(
      result([match({ file: "main.rs", line: 12, lineText: "  let x = 1", matchStart: 6, matchEnd: 7 })]),
    );

    render(<FindInFiles />);
    openPanel();
    typeQuery("x");
    await runSearch();

    expect(screen.getByTestId("find-count")).toHaveTextContent("1 match in 1 file");

    fireEvent.click(screen.getByTestId("find-match"));
    expect(editorTabs()).toHaveLength(1);
    expect(editorTabs()[0].ref).toEqual({ kind: "editor", path: "/w/main.rs" });
    // Clicking a result closes the overlay so the opened file is visible.
    expect(screen.queryByTestId("find-in-files")).toBeNull();
  });

  it("opens a Windows hit at the tree's spelling — root `C:\\w`, file `src\\main.rs`", async () => {
    // `find_in_files` sends native separators; the old `${root}/${file}` made `C:\w/src\main.rs`.
    setRoot("C:\\w");
    findIpc.findInFiles.mockResolvedValue(result([match({ file: "src\\main.rs", line: 1 })]));

    render(<FindInFiles />);
    openPanel();
    typeQuery("x");
    await runSearch();

    fireEvent.click(screen.getByTestId("find-match"));
    expect(editorTabs()[0].ref).toEqual({ kind: "editor", path: "C:\\w\\src\\main.rs" });
  });

  it("shows a Windows root's folders with `\\`, like Quick open", async () => {
    setRoot("C:\\w");
    findIpc.findInFiles.mockResolvedValue(result([match({ file: "src/features/terminal/x.ts", line: 1 })]));
    render(<FindInFiles />);
    openPanel();
    typeQuery("x");
    await runSearch();
    expect(screen.getByTestId("find-file").querySelector(".find-group__dir")).toHaveTextContent(
      /^src\\features\\terminal$/,
    );
  });

  it("shows a POSIX root's folders exactly as sent", async () => {
    setRoot("/w");
    findIpc.findInFiles.mockResolvedValue(result([match({ file: "src/features/terminal/x.ts", line: 1 })]));
    render(<FindInFiles />);
    openPanel();
    typeQuery("y");
    await runSearch();
    expect(screen.getByTestId("find-file").querySelector(".find-group__dir")).toHaveTextContent(
      /^src\/features\/terminal$/,
    );
  });

  it("highlights the matched span within the line, trimming leading indentation", async () => {
    setRoot("/w");
    // "    const answer = 42" → 4-space indent; "answer" spans [10, 16).
    findIpc.findInFiles.mockResolvedValue(
      result([match({ file: "/w/a.ts", line: 2, lineText: "    const answer = 42", matchStart: 10, matchEnd: 16 })]),
    );

    const { container } = render(<FindInFiles />);
    openPanel();
    typeQuery("answer");
    await runSearch();

    const hit = container.querySelector(".find-match__hit");
    expect(hit).toHaveTextContent("answer");
    // Indentation was trimmed for context, so the rendered code starts at "const".
    expect(container.querySelector(".find-match__code")?.textContent).toBe("const answer = 42");
  });

  it("collapses and re-expands a file group", async () => {
    setRoot("/w");
    findIpc.findInFiles.mockResolvedValue(
      result([match({ file: "/w/a.ts", line: 1 }), match({ file: "/w/a.ts", line: 2 })]),
    );

    render(<FindInFiles />);
    openPanel();
    typeQuery("x");
    await runSearch();
    expect(screen.getAllByTestId("find-match")).toHaveLength(2);

    const header = screen.getByTestId("find-file");
    fireEvent.click(header); // collapse
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryAllByTestId("find-match")).toHaveLength(0);

    fireEvent.click(header); // re-expand
    expect(header).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByTestId("find-match")).toHaveLength(2);
  });

  it("notes when Rust truncated the result set", async () => {
    setRoot("/w");
    findIpc.findInFiles.mockResolvedValue(result([match({ file: "/w/a.ts", line: 1 })], true));

    render(<FindInFiles />);
    openPanel();
    typeQuery("x");
    await runSearch();

    expect(screen.getByTestId("find-truncated")).toBeInTheDocument();
  });

  it("shows a calm 'No matches' state", async () => {
    setRoot("/w");
    findIpc.findInFiles.mockResolvedValue(result([]));

    render(<FindInFiles />);
    openPanel();
    typeQuery("nope");
    await runSearch();

    expect(screen.getByText("No matches")).toBeInTheDocument();
  });

  it("surfaces an invalid-regex Error message from Rust", async () => {
    setRoot("/w");
    findIpc.findInFiles.mockRejectedValue(new Error("regex parse error: unclosed group"));

    render(<FindInFiles />);
    openPanel();
    fireEvent.click(screen.getByLabelText("Regular expression"));
    typeQuery("(");
    await runSearch();

    expect(within(screen.getByRole("alert")).getByText(/unclosed group/)).toBeInTheDocument();
  });

  it("surfaces a bare-string rejection too", async () => {
    setRoot("/w");
    findIpc.findInFiles.mockRejectedValue("search backend unavailable");

    render(<FindInFiles />);
    openPanel();
    typeQuery("x");
    await runSearch();

    expect(screen.getByRole("alert")).toHaveTextContent("search backend unavailable");
  });

  it("clears results (without searching) when the query is emptied", async () => {
    setRoot("/w");
    findIpc.findInFiles.mockResolvedValue(result([match({ file: "/w/a.ts", line: 1 })]));

    render(<FindInFiles />);
    openPanel();
    typeQuery("x");
    await runSearch();
    expect(screen.getByTestId("find-count")).toBeInTheDocument();

    const callsBefore = findIpc.findInFiles.mock.calls.length;
    typeQuery(""); // effect clears synchronously; no new timer, no new call
    expect(screen.getByText("Type to search the project.")).toBeInTheDocument();
    expect(findIpc.findInFiles.mock.calls.length).toBe(callsBefore);
  });

  it("neither searches nor crashes when there is no workspace root", async () => {
    setRoot(null);
    findIpc.findInFiles.mockResolvedValue(result([]));

    render(<FindInFiles />);
    openPanel();
    typeQuery("x");
    await runSearch();

    expect(findIpc.findInFiles).not.toHaveBeenCalled();
    expect(screen.getByText("Open a folder to search.")).toBeInTheDocument();
  });

  it("ignores a stale in-flight result when the query changes mid-flight", async () => {
    setRoot("/w");
    let resolveStale!: (r: FindResult) => void;
    findIpc.findInFiles
      .mockImplementationOnce(() => new Promise<FindResult>((res) => (resolveStale = res)))
      .mockResolvedValueOnce(result([match({ file: "/w/fresh.ts", line: 1 })]));

    render(<FindInFiles />);
    openPanel();
    typeQuery("a");
    await runSearch(); // first search fires, stays pending → "Searching…"
    expect(screen.getByText("Searching…")).toBeInTheDocument();

    typeQuery("ab"); // supersedes: cleanup marks the first cancelled
    await runSearch(); // second search resolves fresh

    // Assert on the file-group name (a single text node — the match line itself
    // is split by the highlight <mark>).
    expect(screen.getByText("fresh.ts")).toBeInTheDocument();

    // The stale resolution must be ignored — it cannot overwrite the fresh view.
    await act(async () => {
      resolveStale(result([match({ file: "/w/stale.ts", line: 1 })]));
      await Promise.resolve();
    });
    expect(screen.getByText("fresh.ts")).toBeInTheDocument();
    expect(screen.queryByText("stale.ts")).toBeNull();
  });
});

describe("FindInFiles — scope selector", () => {
  const OPTS = { regex: false, caseSensitive: false, wholeWord: false, glob: "" };

  /** Flush the scope selector's `read_dir` microtask so its Folder options load. */
  const loadSubdirs = () => act(async () => {});

  it("defaults the scope to the workspace root and offers it in the Workspace dropdown", async () => {
    setRoot("/w");
    findIpc.findInFiles.mockResolvedValue(result([]));

    render(<FindInFiles />);
    openPanel();

    // The primary root is present (labeled by its basename) — critical so search
    // works even with no agents/browse roots open.
    expect(screen.getByLabelText("Search workspace")).toHaveValue("/w");
    expect(within(screen.getByLabelText("Search workspace")).getByText("w")).toBeInTheDocument();

    typeQuery("todo");
    await runSearch();
    expect(findIpc.findInFiles).toHaveBeenLastCalledWith("/w", "todo", OPTS, expect.any(String));
  });

  it("scopes the search to a subfolder when the Folder dropdown changes", async () => {
    setRoot("/w");
    workspaceIpc.readDir.mockResolvedValue([{ name: "src", path: "/w/src", isDir: true }]);
    findIpc.findInFiles.mockResolvedValue(result([]));

    render(<FindInFiles />);
    openPanel();
    await loadSubdirs(); // "src" joins the Folder dropdown

    fireEvent.change(screen.getByLabelText("Search folder"), { target: { value: "src" } });
    typeQuery("todo");
    await runSearch();

    expect(findIpc.findInFiles).toHaveBeenLastCalledWith("/w/src", "todo", OPTS, expect.any(String));
  });

  it("scopes the search to a chosen workspace when the Workspace dropdown changes", async () => {
    setRoot("/w");
    // A second root via browseRoots, so the Workspace dropdown has two options.
    act(() => {
      useAppStore.setState((s) => {
        s.browseRoots = ["/w2"];
      });
    });
    findIpc.findInFiles.mockResolvedValue(result([]));

    render(<FindInFiles />);
    openPanel();

    fireEvent.change(screen.getByLabelText("Search workspace"), { target: { value: "/w2" } });
    typeQuery("todo");
    await runSearch();

    expect(findIpc.findInFiles).toHaveBeenLastCalledWith("/w2", "todo", OPTS, expect.any(String));
  });
});

/** Fan-out over two roots: one search per root, merged, repo-labelled, and each hit opens in its
 * own repo. */
describe("FindInFiles — All workspaces (fan-out)", () => {
  const OPTS = { regex: false, caseSensitive: false, wholeWord: false, glob: "" };

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
  // Distinct hits per root, so the merge and per-repo abs paths are observable.
  const perRoot = () =>
    findIpc.findInFiles.mockImplementation((root: string) =>
      Promise.resolve(
        root === "/work/alpha"
          ? result([match({ file: "a.ts", line: 1 })])
          : result([match({ file: "b.ts", line: 2 })]),
      ),
    );

  it("searches every root once, merges, and labels each group with its repo", async () => {
    seedTwoRoots();
    perRoot();

    render(<FindInFiles />);
    openPanel();
    selectAll();
    typeQuery("x");
    await runSearch();

    // One call per root, each with the shared options.
    expect(findIpc.findInFiles).toHaveBeenCalledTimes(2);
    expect(findIpc.findInFiles).toHaveBeenCalledWith("/work/alpha", "x", OPTS, "sid-1");
    expect(findIpc.findInFiles).toHaveBeenCalledWith("/work/beta", "x", OPTS, "sid-2");

    // Honest merged total, and a repo tag (root basename) on each group, in root order.
    expect(screen.getByTestId("find-count")).toHaveTextContent("2 matches in 2 files");
    expect(screen.getAllByTestId("find-repo").map((e) => e.textContent)).toEqual(["alpha", "beta"]);
  });

  it("opens the primary-repo hit under the primary root", async () => {
    seedTwoRoots();
    perRoot();

    render(<FindInFiles />);
    openPanel();
    selectAll();
    typeQuery("x");
    await runSearch();

    fireEvent.click(screen.getAllByTestId("find-match")[0]);
    expect(editorTabs()[0].ref).toEqual({ kind: "editor", path: "/work/alpha/a.ts" });
  });

  it("opens the second-repo hit under ITS root (not the primary)", async () => {
    seedTwoRoots();
    perRoot();

    render(<FindInFiles />);
    openPanel();
    selectAll();
    typeQuery("x");
    await runSearch();

    fireEvent.click(screen.getAllByTestId("find-match")[1]);
    expect(editorTabs()[0].ref).toEqual({ kind: "editor", path: "/work/beta/b.ts" });
  });

  it("merges truncation — a note shows when ANY root truncated", async () => {
    seedTwoRoots();
    findIpc.findInFiles.mockImplementation((root: string) =>
      Promise.resolve(
        root === "/work/alpha"
          ? result([match({ file: "a.ts", line: 1 })])
          : result([match({ file: "b.ts", line: 2 })], true),
      ),
    );

    render(<FindInFiles />);
    openPanel();
    selectAll();
    typeQuery("x");
    await runSearch();

    expect(screen.getByTestId("find-truncated")).toBeInTheDocument();
  });
});

/** Searches held still (never-settling promises): Stop exists only while there is something to
 * stop, every exit cancels the right walk by id, and a stopped search never claims no matches. */
describe("FindInFiles — cancelling a slow search", () => {
  /** A search that never settles — a slow walk, held still. */
  const hangs = () =>
    findIpc.findInFiles.mockReturnValue(new Promise<FindResult>(() => {}));

  /** Open the panel and get one slow search in flight (id "sid-1"). */
  const startSlowSearch = async () => {
    setRoot("/w");
    hangs();
    render(<FindInFiles />);
    openPanel();
    typeQuery("slow");
    await runSearch();
  };

  it("offers the Stop control only while a search is actually running", async () => {
    setRoot("/w");
    let settle!: (r: FindResult) => void;
    findIpc.findInFiles.mockReturnValue(new Promise<FindResult>((res) => (settle = res)));

    render(<FindInFiles />);
    openPanel();
    // Idle: there is nothing to stop, so no control claims otherwise.
    expect(screen.queryByTestId("find-cancel")).toBeNull();

    typeQuery("slow");
    await runSearch();
    expect(screen.getByTestId("find-cancel")).toBeInTheDocument();
    expect(screen.getByLabelText("Cancel search")).toBeInTheDocument();

    await act(async () => {
      settle(result([]));
      await Promise.resolve();
    });
    // Finished on its own → the control goes away with the spinner.
    expect(screen.queryByTestId("find-cancel")).toBeNull();
  });

  it("Stop cancels the RUNNING walk by its own id and lands on a calm stopped state", async () => {
    await startSlowSearch();

    fireEvent.click(screen.getByTestId("find-cancel"));

    // The id Rust was given for THIS search — not a freshly minted one.
    expect(searchIds()).toEqual(["sid-1"]);
    expect(cancelIds()).toEqual(["sid-1"]);

    // Honest: the walk never finished, so nothing is claimed about the project.
    expect(screen.getByTestId("find-stopped")).toHaveTextContent(
      "Search stopped before it finished.",
    );
    expect(screen.queryByText("No matches")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("Searching…")).toBeNull();
  });

  it("Escape cancels the in-flight walk on its way out — and still closes the panel", async () => {
    await startSlowSearch();

    press({ key: "Escape" });

    expect(screen.queryByTestId("find-in-files")).toBeNull(); // Esc still means "close"
    expect(cancelIds()).toEqual(["sid-1"]);
  });

  it("closing with ✕ cancels the in-flight walk", async () => {
    await startSlowSearch();

    fireEvent.click(screen.getByLabelText("Close search"));

    expect(cancelIds()).toEqual(["sid-1"]);
  });

  it("a new search cancels the one it supersedes — and only that one", async () => {
    await startSlowSearch();

    typeQuery("slower"); // supersedes: the old walk is abandoned at once
    expect(cancelIds()).toEqual(["sid-1"]);

    await runSearch(); // the replacement fires
    expect(searchIds()).toEqual(["sid-1", "sid-2"]);
    expect(cancelIds()).toEqual(["sid-1"]); // the live one is left alone
  });

  it("cancels EVERY root's walk when the search fanned out over all workspaces", async () => {
    setRoot("/work/alpha");
    act(() => {
      useAppStore.setState((s) => {
        s.browseRoots = ["/work/beta"];
      });
    });
    hangs();

    render(<FindInFiles />);
    openPanel();
    fireEvent.change(screen.getByLabelText("Search workspace"), {
      target: { value: ALL_WORKSPACES },
    });
    typeQuery("x");
    await runSearch();

    // One id per leg, so a cancel can name each root's walk individually.
    expect(searchIds()).toEqual(["sid-1", "sid-2"]);

    fireEvent.click(screen.getByTestId("find-cancel"));
    // BOTH legs stop. Cancelling only the first would leave a second walk
    // pinning a CPU with nobody left who wants its answer.
    expect(cancelIds()).toEqual(["sid-1", "sid-2"]);
  });

  it("Stop during the debounce window keeps the queued search from ever starting", async () => {
    await startSlowSearch();

    typeQuery("slower"); // old walk cancelled; the replacement is queued, not fired
    // The spinner stays up across a supersede: a search IS still pending, and a
    // superseded run's late reply must not blank it.
    expect(screen.getByTestId("find-cancel")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("find-cancel"));
    await runSearch(); // the queued timer fires and finds itself already stopped

    expect(findIpc.findInFiles).toHaveBeenCalledTimes(1); // no second walk was launched
    expect(screen.getByTestId("find-stopped")).toBeInTheDocument();
  });

  it("drops the spinner when a cancelled walk finally replies — it must not stay stuck", async () => {
    // The bug this pins: `apply` used to return on `cancelled` BEFORE clearing
    // `loading`, so a search abandoned at close left the panel claiming to be
    // searching for ever — and made `loading` useless as the Stop control's gate.
    setRoot("/w");
    let rejectWalk!: (e: unknown) => void;
    findIpc.findInFiles.mockReturnValue(
      new Promise<FindResult>((_res, rej) => (rejectWalk = rej)),
    );

    render(<FindInFiles />);
    openPanel();
    typeQuery("slow");
    await runSearch();
    expect(screen.getByText("Searching…")).toBeInTheDocument();

    press({ key: "Escape" }); // closed; the walk is cancelled but has not replied yet
    await act(async () => {
      rejectWalk(new Error("cancelled"));
      await Promise.resolve();
    });

    openPanel(); // back in: nothing is running, so nothing may claim to be
    expect(screen.queryByText("Searching…")).toBeNull();
    expect(screen.queryByTestId("find-cancel")).toBeNull();
  });

  it("a `cancelled` rejection is silent — neither an error nor a false 'No matches'", async () => {
    // Rust may cancel a walk we did not ask about (a superseded one, server-side).
    // `cancelled` is a normal outcome, so it is neither painted red nor collapsed
    // into a verdict about the codebase.
    setRoot("/w");
    findIpc.findInFiles.mockRejectedValue(new Error("cancelled"));

    render(<FindInFiles />);
    openPanel();
    typeQuery("x");
    await runSearch();

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("No matches")).toBeNull();
    expect(screen.queryByText("Searching…")).toBeNull();
  });

  it("a genuine failure that merely MENTIONS cancellation still reaches the user", async () => {
    // The other side of the test above: swallowing everything that contains the
    // word would be indistinguishable from having no error handling at all.
    setRoot("/w");
    findIpc.findInFiles.mockRejectedValue(new Error("read cancelled by the OS"));

    render(<FindInFiles />);
    openPanel();
    typeQuery("x");
    await runSearch();

    expect(screen.getByRole("alert")).toHaveTextContent("read cancelled by the OS");
  });

  it("a slow walk's late reply cannot overwrite the fast one that replaced it", async () => {
    // Two-sided: current results land and superseded ones do not ("stale absent" alone passes an
    // empty panel).
    setRoot("/w");
    let resolveSlow!: (r: FindResult) => void;
    findIpc.findInFiles
      .mockImplementationOnce(() => new Promise<FindResult>((res) => (resolveSlow = res)))
      .mockResolvedValueOnce(result([match({ file: "/w/fresh.ts", line: 1 })]));

    render(<FindInFiles />);
    openPanel();
    typeQuery("a");
    await runSearch(); // slow run — sid-1
    typeQuery("ab");
    await runSearch(); // fast run — sid-2, settles immediately

    // Half one: the current search's results ARE on screen.
    expect(screen.getByText("fresh.ts")).toBeInTheDocument();
    expect(cancelIds()).toEqual(["sid-1"]); // and the slow one was told to stop

    await act(async () => {
      resolveSlow(result([match({ file: "/w/stale.ts", line: 1 })]));
      await Promise.resolve();
    });

    // Half two: the superseded reply changed nothing.
    expect(screen.getByText("fresh.ts")).toBeInTheDocument();
    expect(screen.queryByText("stale.ts")).toBeNull();
  });
});

/** Two roots with alpha as primary; the focused tab lives in gazelle, so the search must cover
 * gazelle. */
describe("FindInFiles — scope follows the focused tab", () => {
  const OPTS = { regex: false, caseSensitive: false, wholeWord: false, glob: "" };
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
    findIpc.findInFiles.mockResolvedValue(result([]));

    render(<FindInFiles />);
    openPanel();
    expect(workspaceSelect()).toHaveValue("/w/gazelle");

    typeQuery("todo");
    await runSearch();
    expect(findIpc.findInFiles).toHaveBeenLastCalledWith("/w/gazelle", "todo", OPTS, expect.any(String));
  });

  it("a focused gazelle TERMINAL (its cwd) scopes to gazelle too", async () => {
    seedRoots();
    terminalMeta.cwds["term-g"] = "/w/gazelle";
    focusTab("t", { kind: "terminal", terminalId: asTerminalId("term-g") });
    findIpc.findInFiles.mockResolvedValue(result([]));

    render(<FindInFiles />);
    openPanel();
    expect(workspaceSelect()).toHaveValue("/w/gazelle");

    typeQuery("todo");
    await runSearch();
    expect(findIpc.findInFiles).toHaveBeenLastCalledWith("/w/gazelle", "todo", OPTS, expect.any(String));
  });

  it("a focused AGENT terminal scopes to the agent's cwd — and so does the rail's Find tab", () => {
    seedRoots();
    act(() => {
      useAppStore.setState((s) => {
        s.agents[asAgentId("a1")] = wireAgent({ id: asAgentId("a1"), cwd: "/w/gazelle" });
      });
    });
    focusTab("at", { kind: "agent-terminal", terminalId: asTerminalId("a1"), agentId: asAgentId("a1") });

    render(<FindInFiles />);
    // Opened through the store (the right rail's Find tab), not the hotkey.
    act(() => useAppStore.getState().uiActions.setFindInFilesOpen(true));
    expect(workspaceSelect()).toHaveValue("/w/gazelle");
  });

  it("an explicit pick wins while open, and a fresh open follows the context again", async () => {
    seedRoots();
    focusTab("g", { kind: "editor", path: "/w/gazelle/src/lib.rs" });
    findIpc.findInFiles.mockResolvedValue(result([]));

    render(<FindInFiles />);
    openPanel();
    fireEvent.change(workspaceSelect(), { target: { value: "/w/alpha" } });
    typeQuery("todo");
    await runSearch();
    expect(workspaceSelect()).toHaveValue("/w/alpha");
    expect(findIpc.findInFiles).toHaveBeenLastCalledWith("/w/alpha", "todo", OPTS, expect.any(String));

    // Close and reopen: the pick does not outlive the overlay — gazelle again.
    openPanel();
    openPanel();
    expect(workspaceSelect()).toHaveValue("/w/gazelle");
    await runSearch(); // the kept query re-searches — under the context root
    expect(findIpc.findInFiles).toHaveBeenLastCalledWith("/w/gazelle", "todo", OPTS, expect.any(String));
  });

  it("with no tab that names a folder, keeps the old default (the primary root)", () => {
    seedRoots();
    focusTab("v", { kind: "village" });

    render(<FindInFiles />);
    openPanel();
    expect(workspaceSelect()).toHaveValue("/w/alpha");
  });

  it("a focus change while OPEN neither moves the dropdown nor restarts the search", async () => {
    seedRoots();
    focusTab("g", { kind: "editor", path: "/w/gazelle/src/lib.rs" });
    findIpc.findInFiles.mockResolvedValue(result([]));

    render(<FindInFiles />);
    openPanel();
    typeQuery("todo");
    await runSearch();
    expect(findIpc.findInFiles).toHaveBeenCalledTimes(1);

    // An agent's cwd landing / a click into an alpha pane while the overlay is up.
    focusTab("a", { kind: "editor", path: "/w/alpha/a.ts" });
    await runSearch();
    expect(workspaceSelect()).toHaveValue("/w/gazelle");
    expect(findIpc.findInFiles).toHaveBeenCalledTimes(1);
    expect(findIpc.findInFiles).toHaveBeenLastCalledWith("/w/gazelle", "todo", OPTS, expect.any(String));
  });

  it("gazelle console → village: the default stays gazelle", () => {
    seedRoots();
    render(<FindInFiles />);
    terminalMeta.cwds["term-g"] = "/w/gazelle";
    focusTab("t", { kind: "terminal", terminalId: asTerminalId("term-g") });
    focusTab("v", { kind: "village" });

    openPanel();
    expect(workspaceSelect()).toHaveValue("/w/gazelle");
  });
});
