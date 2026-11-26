/** Only `./gitIpc` is mocked; the real stores sit underneath, so effects are asserted, not
 * spies. React swallows handler throws, so window `error`/`unhandledrejection` events are
 * collected and asserted empty instead of `.not.toThrow()`. */

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RepoStatus } from "./gitIpc";

const { mockGitStatus, mockGhPrs, mockUrlOpen } = vi.hoisted(() => ({
  mockGitStatus: vi.fn<(root: string) => Promise<unknown>>(),
  mockGhPrs: vi.fn<(root: string) => Promise<unknown>>(),
  mockUrlOpen: vi.fn<(url: string) => Promise<void>>(),
}));

vi.mock("./gitIpc", () => ({
  gitStatus: mockGitStatus,
  ghPrs: mockGhPrs,
  urlOpen: mockUrlOpen,
}));

import { useAppStore } from "../../app/store";
import { resetStore } from "../../test/store-harness";
import { GitPanel, useGitStore, type PullRequest } from "./index";

const A = "/w/alpha";
const B = "/w/beta";

/** Seed a workspace root directly — no action side effects. */
const openRoot = (path: string) =>
  act(() => {
    useAppStore.setState((s) => {
      s.browseRoots.push(path);
    });
  });

/** A git_status that answers per-root from a table; a string value = reject with it. */
const serveStatus = (table: Record<string, RepoStatus | string>) =>
  mockGitStatus.mockImplementation((root) => {
    const v = table[root];
    if (v === undefined) return Promise.reject(`unknown: unexpected root ${root}`);
    return typeof v === "string" ? Promise.reject(v) : Promise.resolve(v);
  });

/** Same table shape for gh_prs. */
const servePrs = (table: Record<string, PullRequest[] | string>) =>
  mockGhPrs.mockImplementation((root) => {
    const v = table[root];
    if (v === undefined) return Promise.reject(`unknown: unexpected root ${root}`);
    return typeof v === "string" ? Promise.reject(v) : Promise.resolve(v);
  });

const repo = (root: string, branch: string, changes: RepoStatus["changes"]): RepoStatus => ({
  root,
  branch,
  changes,
});

const mkPr = (number: number, over: Partial<PullRequest> = {}): PullRequest => ({
  number,
  title: `PR ${number}`,
  author: "alex",
  url: `https://github.com/o/r/pull/${number}`,
  headRef: `head-${number}`,
  baseRef: "main",
  isDraft: false,
  updatedAt: "2026-08-20T10:00:00Z",
  ...over,
});

/** Let the mount refresh chains (mocked IPC → setState) settle, inside act. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
}

const changesGroupFor = (path: string) =>
  screen.getAllByTestId("git-root").find((el) => el.getAttribute("data-path") === path)!;
const prGroupFor = (path: string) =>
  screen.getAllByTestId("git-pr-root").find((el) => el.getAttribute("data-path") === path)!;
const changeRow = (scope: HTMLElement, path: string) =>
  within(scope)
    .getAllByTestId("git-change")
    .find((el) => el.getAttribute("data-path") === path)!;

const editorPaths = () =>
  Object.values(useAppStore.getState().tabs)
    .filter((t) => t.ref.kind === "editor")
    .map((t) => (t.ref.kind === "editor" ? t.ref.path : ""));

/** React swallows handler throws — catch them at the window instead. */
const windowFaults: Event[] = [];
const onFault = (e: Event): void => {
  windowFaults.push(e);
};

beforeEach(() => {
  resetStore();
  act(() => {
    useAppStore.setState((s) => {
      s.folderOrder = [];
    });
  });
  useGitStore.setState({ status: {}, prs: {}, prAuthorFilter: null });
  // Defaults: clean repo, no PRs, url_open succeeds. Tests override per root.
  mockGitStatus.mockReset().mockImplementation((root: string) => Promise.resolve(repo(root, "main", [])));
  mockGhPrs.mockReset().mockResolvedValue([]);
  mockUrlOpen.mockReset().mockResolvedValue(undefined);
  windowFaults.length = 0;
  window.addEventListener("error", onFault);
  window.addEventListener("unhandledrejection", onFault);
});

afterEach(() => {
  window.removeEventListener("error", onFault);
  window.removeEventListener("unhandledrejection", onFault);
});

describe("GitPanel — shell", () => {
  it("renders the contract testid, both sections, and the empty state with no roots", async () => {
    render(<GitPanel />);
    await settle();

    expect(screen.getByTestId("git-panel")).toBeInTheDocument();
    expect(screen.getByTestId("git-changes")).toBeInTheDocument();
    expect(screen.getByTestId("git-prs")).toBeInTheDocument();
    expect(screen.getByText("Open a folder to see its changes")).toBeInTheDocument();
    // No roots ⇒ nothing to ask about, and no PR groups either.
    expect(mockGitStatus).not.toHaveBeenCalled();
    expect(screen.queryAllByTestId("git-pr-root")).toHaveLength(0);
  });

  it("mount starts the status poll: one git_status per root, immediately", async () => {
    openRoot(A);
    openRoot(B);
    render(<GitPanel />);
    await settle();

    expect(mockGitStatus).toHaveBeenCalledTimes(2);
    expect(mockGitStatus.mock.calls.map((c) => c[0])).toEqual([A, B]);
  });
});

describe("GitPanel — Changes", () => {
  it("shows one group per root in workspaceRoots order: basename, branch, count", async () => {
    openRoot(A);
    openRoot(B);
    serveStatus({
      [A]: repo(A, "main", [{ path: `${A}/x.ts`, status: "modified" }]),
      [B]: repo(B, "feat/fit", [
        { path: `${B}/a.ts`, status: "added" },
        { path: `${B}/b.ts`, status: "deleted" },
      ]),
    });
    render(<GitPanel />);
    await settle();

    const groups = screen.getAllByTestId("git-root");
    expect(groups.map((el) => el.getAttribute("data-path"))).toEqual([A, B]);
    expect(within(groups[0]).getByText("alpha")).toBeInTheDocument();
    expect(within(groups[0]).getByText("main")).toBeInTheDocument();
    expect(within(groups[0]).getByText("1")).toBeInTheDocument();
    expect(within(groups[1]).getByText("feat/fit")).toBeInTheDocument();
    expect(within(groups[1]).getByText("2")).toBeInTheDocument();
  });

  it("colors rows by status class and exposes data-status", async () => {
    openRoot(A);
    serveStatus({
      [A]: repo(A, "main", [
        { path: `${A}/m.ts`, status: "modified" },
        { path: `${A}/a.ts`, status: "added" },
        { path: `${A}/u.ts`, status: "untracked" },
        { path: `${A}/d.ts`, status: "deleted" },
      ]),
    });
    render(<GitPanel />);
    await settle();

    const byStatus = Object.fromEntries(
      screen.getAllByTestId("git-change").map((el) => [el.getAttribute("data-status") ?? "", el]),
    );
    expect(byStatus["modified"]).toHaveClass("git-change--modified");
    expect(byStatus["added"]).toHaveClass("git-change--added");
    expect(byStatus["untracked"]).toHaveClass("git-change--untracked");
    expect(byStatus["deleted"]).toHaveClass("git-change--deleted");
  });

  it("splits a row into bold-ish basename + dimmed parent path (omitted at the root)", async () => {
    openRoot(A);
    serveStatus({
      [A]: repo(A, "main", [
        { path: `${A}/src/deep/x.ts`, status: "modified" },
        { path: `${A}/top.ts`, status: "added" },
      ]),
    });
    render(<GitPanel />);
    await settle();

    const nested = changeRow(changesGroupFor(A), `${A}/src/deep/x.ts`);
    expect(within(nested).getByText("x.ts")).toHaveClass("git-change__name");
    expect(within(nested).getByText("src/deep")).toHaveClass("git-change__dir");

    const atRoot = changeRow(changesGroupFor(A), `${A}/top.ts`);
    expect(within(atRoot).getByText("top.ts")).toHaveClass("git-change__name");
    expect(atRoot.querySelector(".git-change__dir")).toBeNull();
  });

  it("splits a Windows path at its backslashes — what git status sends on Windows", async () => {
    // Shape from `git_status.rs`: root and every change path are canonical native paths.
    const W = "C:\\Users\\me\\repo";
    openRoot(W);
    serveStatus({
      [W]: repo(W, "main", [
        { path: `${W}\\src\\deep\\x.ts`, status: "modified" },
        { path: `${W}\\top.ts`, status: "added" },
      ]),
    });
    render(<GitPanel />);
    await settle();

    // The group header is the root's last segment, not the whole path.
    expect(within(changesGroupFor(W)).getByText("repo")).toBeInTheDocument();
    const nested = changeRow(changesGroupFor(W), `${W}\\src\\deep\\x.ts`);
    expect(within(nested).getByText("x.ts")).toHaveClass("git-change__name");
    expect(within(nested).getByText("src\\deep")).toHaveClass("git-change__dir");
    const atRoot = changeRow(changesGroupFor(W), `${W}\\top.ts`);
    expect(within(atRoot).getByText("top.ts")).toHaveClass("git-change__name");
    expect(atRoot.querySelector(".git-change__dir")).toBeNull();
  });

  it("a Windows root spelled with another drive-letter case still reads as the root", async () => {
    const W = "c:\\repo";
    openRoot(W);
    serveStatus({ [W]: repo("C:\\repo", "main", [{ path: "C:\\repo\\a.ts", status: "modified" }]) });
    render(<GitPanel />);
    await settle();

    const row = changeRow(changesGroupFor(W), "C:\\repo\\a.ts");
    expect(row.querySelector(".git-change__dir")).toBeNull();
  });

  it("a change outside the workspace root shows its full parent, never a slice of it", async () => {
    // The workspace is a subfolder of the repo; git reports the whole repo.
    const sub = "/w/repo/app";
    openRoot(sub);
    serveStatus({ [sub]: repo("/w/repo", "main", [{ path: "/w/repo/docs/x.md", status: "modified" }]) });
    render(<GitPanel />);
    await settle();

    const row = changeRow(changesGroupFor(sub), "/w/repo/docs/x.md");
    expect(within(row).getByText("/w/repo/docs")).toHaveClass("git-change__dir");
  });

  it("clicking a non-deleted row opens the file in the editor (the tree's own action)", async () => {
    const user = userEvent.setup();
    openRoot(A);
    serveStatus({ [A]: repo(A, "main", [{ path: `${A}/src/x.ts`, status: "modified" }]) });
    render(<GitPanel />);
    await settle();

    await user.click(changeRow(changesGroupFor(A), `${A}/src/x.ts`));

    expect(editorPaths()).toEqual([`${A}/src/x.ts`]);
    expect(windowFaults).toHaveLength(0);
  });

  it("a deleted row is not a button and a click opens nothing — the file is gone", async () => {
    openRoot(A);
    serveStatus({ [A]: repo(A, "main", [{ path: `${A}/gone.ts`, status: "deleted" }]) });
    render(<GitPanel />);
    await settle();

    const row = changeRow(changesGroupFor(A), `${A}/gone.ts`);
    expect(row.tagName).not.toBe("BUTTON");
    expect(row.querySelector("button")).toBeNull();
    fireEvent.click(row);
    expect(editorPaths()).toEqual([]);
  });

  it("a not-a-repo root renders collapsed with a calm one-line note and no toggle", async () => {
    openRoot(A);
    serveStatus({ [A]: "not-a-repo" });
    render(<GitPanel />);
    await settle();

    const group = changesGroupFor(A);
    expect(within(group).getByText("Not a git repository")).toBeInTheDocument();
    expect(within(group).queryAllByTestId("git-change")).toHaveLength(0);
    // Nothing to expand: the header is not a button here.
    expect(group.querySelector("button.git-group__header")).toBeNull();
  });

  it("other status failures get one calm inline line — with the detail when there is one", async () => {
    openRoot(A);
    openRoot(B);
    serveStatus({ [A]: "git: index locked", [B]: "git" });
    render(<GitPanel />);
    await settle();

    expect(
      within(changesGroupFor(A)).getByText("Couldn't read git status — index locked"),
    ).toHaveClass("git-note--error");
    expect(within(changesGroupFor(B)).getByText("Couldn't read git status")).toHaveClass(
      "git-note--error",
    );
    // Never-successful roots have no branch to show — and no invented one.
    expect(changesGroupFor(A).querySelector(".git-group__branch")).toBeNull();
  });

  it("the header toggle collapses and re-expands a group", async () => {
    const user = userEvent.setup();
    openRoot(A);
    serveStatus({ [A]: repo(A, "main", [{ path: `${A}/x.ts`, status: "modified" }]) });
    render(<GitPanel />);
    await settle();

    const header = () => changesGroupFor(A).querySelector("button.git-group__header")!;
    expect(header()).toHaveAttribute("aria-expanded", "true");

    await user.click(header());
    expect(header()).toHaveAttribute("aria-expanded", "false");
    expect(within(changesGroupFor(A)).queryAllByTestId("git-change")).toHaveLength(0);

    await user.click(header());
    expect(header()).toHaveAttribute("aria-expanded", "true");
    expect(within(changesGroupFor(A)).getAllByTestId("git-change")).toHaveLength(1);
  });

  it("a clean repo says 'No changes' calmly", async () => {
    openRoot(A);
    render(<GitPanel />);
    await settle();

    expect(within(changesGroupFor(A)).getByText("No changes")).toBeInTheDocument();
  });

  it("a root whose first poll is still in flight renders its header without a branch", async () => {
    openRoot(A);
    mockGitStatus.mockImplementation(() => new Promise(() => {})); // never lands
    render(<GitPanel />);
    await settle();

    const group = changesGroupFor(A);
    expect(within(group).getByText("alpha")).toBeInTheDocument();
    expect(group.querySelector(".git-group__branch")).toBeNull();
    expect(within(group).queryAllByTestId("git-change")).toHaveLength(0);
  });
});

describe("GitPanel — Pull Requests", () => {
  it("fetches on first mount when nothing has ever loaded, and renders the rows", async () => {
    openRoot(A);
    servePrs({ [A]: [mkPr(7, { title: "Fix the fit control", headRef: "fix/fit" })] });
    render(<GitPanel />);
    await settle();

    expect(mockGhPrs).toHaveBeenCalledTimes(1);
    const row = within(prGroupFor(A)).getByTestId("git-pr");
    expect(row).toHaveTextContent("#7");
    expect(row).toHaveTextContent("Fix the fit control");
    expect(row).toHaveTextContent("alex · fix/fit");
  });

  it("does NOT auto-fetch when PRs are already loaded; Refresh does it on demand", async () => {
    const user = userEvent.setup();
    openRoot(A);
    useGitStore.setState({ prs: { [A]: { items: [], error: null } } });
    servePrs({ [A]: [mkPr(1)] });
    render(<GitPanel />);
    await settle();
    expect(mockGhPrs).not.toHaveBeenCalled();

    await user.click(screen.getByTestId("git-prs-refresh"));
    await settle();

    expect(mockGhPrs).toHaveBeenCalledTimes(1);
    expect(within(prGroupFor(A)).getAllByTestId("git-pr")).toHaveLength(1);
  });

  it("marks draft PRs with a Draft chip — and only those", async () => {
    openRoot(A);
    servePrs({ [A]: [mkPr(1, { isDraft: true }), mkPr(2)] });
    render(<GitPanel />);
    await settle();

    const rows = within(prGroupFor(A)).getAllByTestId("git-pr");
    expect(rows).toHaveLength(2);
    expect(screen.getAllByTestId("git-pr-draft")).toHaveLength(1);
    expect(within(rows[0]).getByTestId("git-pr-draft")).toBeInTheDocument();
  });

  it("clicking a PR opens ITS url via url_open — and nothing auto-opens", async () => {
    const user = userEvent.setup();
    openRoot(A);
    servePrs({ [A]: [mkPr(7)] });
    render(<GitPanel />);
    await settle();
    expect(mockUrlOpen).not.toHaveBeenCalled(); // nothing opened un-asked

    await user.click(within(prGroupFor(A)).getByTestId("git-pr"));

    expect(mockUrlOpen).toHaveBeenCalledExactlyOnceWith("https://github.com/o/r/pull/7");
    expect(windowFaults).toHaveLength(0);
  });

  it("a failing url_open is swallowed — no window error, no unhandled rejection", async () => {
    const user = userEvent.setup();
    openRoot(A);
    servePrs({ [A]: [mkPr(7)] });
    mockUrlOpen.mockRejectedValue("out-of-scope: not https");
    render(<GitPanel />);
    await settle();

    await user.click(within(prGroupFor(A)).getByTestId("git-pr"));
    await settle();

    expect(windowFaults).toHaveLength(0);
  });

  it("author chips filter the rows client-side, across every root", async () => {
    const user = userEvent.setup();
    openRoot(A);
    openRoot(B);
    servePrs({
      [A]: [mkPr(1, { author: "alex" }), mkPr(2, { author: "ana" })],
      [B]: [mkPr(3, { author: "alex" })],
    });
    render(<GitPanel />);
    await settle();

    // "All" + one chip per distinct author (alphabetical), with counts.
    const chips = screen.getAllByTestId("git-author-chip");
    expect(chips.map((el) => el.textContent)).toEqual(["alex (2)", "ana (1)"]);
    expect(screen.getByTestId("git-author-all")).toHaveClass("git-chip--active");
    expect(screen.getAllByTestId("git-pr")).toHaveLength(3);

    await user.click(chips[1]); // ana
    expect(screen.getAllByTestId("git-pr")).toHaveLength(1);
    expect(screen.getByTestId("git-pr")).toHaveTextContent("#2");
    expect(chips[1]).toHaveClass("git-chip--active");
    expect(screen.getByTestId("git-author-all")).not.toHaveClass("git-chip--active");

    await user.click(screen.getByTestId("git-author-all"));
    expect(screen.getAllByTestId("git-pr")).toHaveLength(3);
  });

  it.each([
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X)", "GitHub CLI not found — brew install gh"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "GitHub CLI not found — winget install GitHub.cli"],
    ["Mozilla/5.0 (X11; Linux x86_64)", "GitHub CLI not found — install it from cli.github.com"],
  ])("gh-missing names this platform's installer (%s)", async (ua, line) => {
    const spy = vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue(ua);
    try {
      openRoot(A);
      servePrs({ [A]: "gh-missing: not on PATH" });
      render(<GitPanel />);
      await settle();

      expect(screen.getByTestId("git-pr-error")).toHaveTextContent(line);
    } finally {
      spy.mockRestore();
    }
  });

  it.each([
    ["gh-not-signed-in: no token", "Run `gh auth login` in a terminal"],
    ["no-remote", "No GitHub remote"],
    ["gh-failed: rate limited", "rate limited"],
    ["parse", "Couldn't load pull requests"],
  ])("renders the calm line for %j", async (wire, line) => {
    openRoot(A);
    servePrs({ [A]: wire });
    render(<GitPanel />);
    await settle();

    expect(screen.getByTestId("git-pr-error")).toHaveTextContent(line);
  });

  it("an empty loaded list says 'No open pull requests'", async () => {
    openRoot(A);
    render(<GitPanel />);
    await settle();

    expect(within(prGroupFor(A)).getByText("No open pull requests")).toBeInTheDocument();
  });

  it("shows a loading note only until the first fetch lands", async () => {
    openRoot(A);
    let land!: (items: PullRequest[]) => void;
    mockGhPrs.mockImplementation(() => new Promise((res) => (land = res)));
    render(<GitPanel />);
    await settle();

    expect(within(prGroupFor(A)).getByText("Loading pull requests…")).toBeInTheDocument();

    await act(async () => {
      land([mkPr(1)]);
      for (let i = 0; i < 8; i++) await Promise.resolve();
    });
    expect(within(prGroupFor(A)).queryByText("Loading pull requests…")).toBeNull();
    expect(within(prGroupFor(A)).getByTestId("git-pr")).toBeInTheDocument();
  });

  it("never-blank: a failed refresh keeps the loaded rows with the error line beside them", async () => {
    const user = userEvent.setup();
    openRoot(A);
    servePrs({ [A]: [mkPr(7)] });
    render(<GitPanel />);
    await settle();
    expect(within(prGroupFor(A)).getByTestId("git-pr")).toBeInTheDocument();

    servePrs({ [A]: "gh-failed: rate limited" });
    await user.click(screen.getByTestId("git-prs-refresh"));
    await settle();

    expect(screen.getByTestId("git-pr-error")).toHaveTextContent("rate limited");
    expect(within(prGroupFor(A)).getByTestId("git-pr")).toBeInTheDocument();
  });

  it("an empty list we could not re-verify drops its 'No open pull requests' claim", async () => {
    const user = userEvent.setup();
    openRoot(A);
    render(<GitPanel />);
    await settle();
    expect(within(prGroupFor(A)).getByText("No open pull requests")).toBeInTheDocument();

    servePrs({ [A]: "timeout: 10s" });
    await user.click(screen.getByTestId("git-prs-refresh"));
    await settle();

    expect(screen.getByTestId("git-pr-error")).toHaveTextContent("10s");
    expect(within(prGroupFor(A)).queryByText("No open pull requests")).toBeNull();
  });
});
