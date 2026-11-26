/** Git rail panel: changes per root and open PRs. `data-testid="git-panel"` and zero props are a
 * contract (`App.test.tsx`). The rail clips, so `git.css` keeps children shrinkable. Failures are
 * inline notes, last good rows stay, nothing auto-opens; deleted-file rows are not clickable. */
import { useEffect, useMemo, useState } from "react";

import { useAppStore, workspaceRoots } from "../../app/store";
import { basename, dirname, relativeTo } from "../../lib/paths";
import { isMac, isWindows } from "../shortcuts/shortcuts";
import { urlOpen } from "./gitIpc";
import {
  startGitPolling,
  useGitStore,
  type GitChange,
  type GitStatusErrorCode,
  type PrErrorCode,
  type PullRequest,
  type RootGitState,
  type RootPrState,
} from "./gitStore";
import "./git.css";

/** The shared do-nothing rejection sink: opening a PR is fire-and-forget. */
const swallow = (): void => {};

/** A change's parent relative to `root`, in the path's own separators ("" at the root). Git paths
 * use the canonical repo dir, which may differ (subfolder workspace, Windows case); a parent
 * outside `root` shows in full. */
function relativeParent(root: string, path: string): string {
  const parent = dirname(path);
  return relativeTo(root, parent) ?? parent;
}

/** Where the GitHub CLI comes from on this platform — the next move when it is missing. */
function ghInstallHint(): string {
  if (isMac()) return "brew install gh";
  if (isWindows()) return "winget install GitHub.cli";
  return "install it from cli.github.com";
}

/** One calm sentence for a failed `git_status` read (never `not-a-repo` — that renders as its own note). */
function statusErrorLine(error: { code: GitStatusErrorCode; detail: string | null }): string {
  return error.detail === null
    ? "Couldn't read git status"
    : `Couldn't read git status — ${error.detail}`;
}

/** One calm sentence per PR failure code — what happened, and the next move. */
function prErrorLine(error: { code: PrErrorCode; detail: string | null }): string {
  switch (error.code) {
    case "gh-missing":
      return `GitHub CLI not found — ${ghInstallHint()}`;
    case "gh-not-signed-in":
      return "Run `gh auth login` in a terminal";
    case "no-remote":
      return "No GitHub remote";
    default:
      return error.detail ?? "Couldn't load pull requests";
  }
}

/** Feature-local, not in `src/components/icons.tsx`, like the usage panel's. */
function RefreshIcon(): React.JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M13.25 8a5.25 5.25 0 1 1-1.54-3.71"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <path
        d="M13.4 2.4v3.1h-3.1"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** One changed file. Non-deleted rows are buttons that open the file in the editor. */
function ChangeRow({
  root,
  change,
  onOpen,
}: {
  root: string;
  change: GitChange;
  onOpen: (path: string) => void;
}): React.JSX.Element {
  const dir = relativeParent(root, change.path);
  const body = (
    <>
      <span className="git-change__name">{basename(change.path)}</span>
      {dir === "" ? null : <span className="git-change__dir">{dir}</span>}
    </>
  );
  if (change.status === "deleted") {
    // Not a button on purpose: the file no longer exists, so there is nothing
    // to open. This row is where "red deleted" lives — the tree cannot show it.
    return (
      <li
        className="git-change git-change--deleted"
        data-testid="git-change"
        data-status="deleted"
        data-path={change.path}
        title={change.path}
      >
        {body}
      </li>
    );
  }
  return (
    <li className="git-change-item">
      <button
        type="button"
        className={`git-change git-change--${change.status}`}
        data-testid="git-change"
        data-status={change.status}
        data-path={change.path}
        title={change.path}
        onClick={() => onOpen(change.path)}
      >
        {body}
      </button>
    </li>
  );
}

/** One workspace root's collapsible Changes group. */
function ChangesGroup({
  root,
  state,
  collapsed,
  onToggle,
  onOpen,
}: {
  root: string;
  state: RootGitState | undefined;
  collapsed: boolean;
  onToggle: () => void;
  onOpen: (path: string) => void;
}): React.JSX.Element {
  const name = basename(root);
  if (state?.error?.code === "not-a-repo") {
    // A calm steady state, not a failure: header + one-line note, collapsed
    // for good (no rows exist, so there is nothing to expand).
    return (
      <div className="git-group git-group--collapsed" data-testid="git-root" data-path={root}>
        <div className="git-group__header">
          <span className="git-group__name">{name}</span>
        </div>
        <p className="git-note">Not a git repository</p>
      </div>
    );
  }
  const changes = state?.changes ?? [];
  return (
    <div className="git-group" data-testid="git-root" data-path={root}>
      <button
        type="button"
        className="git-group__header"
        aria-expanded={!collapsed}
        onClick={onToggle}
      >
        <span className="git-group__caret" aria-hidden="true">
          {collapsed ? "▸" : "▾"}
        </span>
        <span className="git-group__name">{name}</span>
        {state !== undefined && state.branch !== "" ? (
          <span className="git-group__branch">{state.branch}</span>
        ) : null}
        <span className="git-group__count">{changes.length}</span>
      </button>
      {collapsed ? null : (
        <>
          {state?.error ? (
            <p className="git-note git-note--error">{statusErrorLine(state.error)}</p>
          ) : null}
          {changes.length === 0 ? (
            <p className="git-note">No changes</p>
          ) : (
            <ul className="git-list">
              {changes.map((c) => (
                <ChangeRow key={c.path} root={root} change={c} onOpen={onOpen} />
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

/** One open pull request. Click opens it in the OS browser (https-only, Rust-enforced). */
function PrRow({ pr }: { pr: PullRequest }): React.JSX.Element {
  return (
    <li className="git-change-item">
      <button
        type="button"
        className="git-pr"
        data-testid="git-pr"
        title={pr.url}
        onClick={() => {
          urlOpen(pr.url).catch(swallow);
        }}
      >
        <span className="git-pr__title">
          <span className="git-pr__number">#{pr.number}</span> {pr.title}
          {pr.isDraft ? (
            <span className="git-pr__draft" data-testid="git-pr-draft">
              Draft
            </span>
          ) : null}
        </span>
        <span className="git-pr__meta">
          {pr.author} · {pr.headRef}
        </span>
      </button>
    </li>
  );
}

/** One workspace root's Pull Requests group. */
function PrGroup({
  root,
  state,
  filter,
}: {
  root: string;
  state: RootPrState | undefined;
  filter: string | null;
}): React.JSX.Element {
  const items = state?.items ?? null;
  const error = state?.error ?? null;
  const shown = items === null ? [] : filter === null ? items : items.filter((p) => p.author === filter);
  return (
    <div className="git-group" data-testid="git-pr-root" data-path={root}>
      <div className="git-group__header">
        <span className="git-group__name">{basename(root)}</span>
      </div>
      {error !== null ? (
        <p className="git-note git-note--error" data-testid="git-pr-error">
          {prErrorLine(error)}
        </p>
      ) : null}
      {items === null ? (
        // Never loaded. With an error beside it the error line says it all;
        // otherwise the first fetch is still in flight.
        error === null ? <p className="git-note">Loading pull requests…</p> : null
      ) : items.length === 0 ? (
        // An empty list we could not re-verify is not a confirmed "none open".
        error === null ? <p className="git-note">No open pull requests</p> : null
      ) : (
        <ul className="git-list">
          {shown.map((pr) => (
            <PrRow key={pr.number} pr={pr} />
          ))}
        </ul>
      )}
    </div>
  );
}

export function GitPanel(): React.JSX.Element {
  // Subscribe to the slices `workspaceRoots` reads (each a stable reference
  // under immer's structural sharing) and derive with useMemo — the same
  // discipline as WorkspaceTree, for the same "no fresh array per render" reason.
  const rootAgentIds = useAppStore((s) => s.rootAgentIds);
  const agents = useAppStore((s) => s.agents);
  const browseRoots = useAppStore((s) => s.browseRoots);
  const folderOrder = useAppStore((s) => s.folderOrder);
  const roots = useMemo(
    () => workspaceRoots({ rootAgentIds, agents, browseRoots, folderOrder }),
    [rootAgentIds, agents, browseRoots, folderOrder],
  );
  // The EXACT action the tree's file-row click uses — clicking a change opens
  // (or refocuses, it dedupes by path) the file in the center editor.
  const openEditorTab = useAppStore((s) => s.layoutActions.openEditorTab);

  const status = useGitStore((s) => s.status);
  const prs = useGitStore((s) => s.prs);
  const prAuthorFilter = useGitStore((s) => s.prAuthorFilter);
  const setPrAuthorFilter = useGitStore((s) => s.setPrAuthorFilter);
  const refreshPrs = useGitStore((s) => s.refreshPrs);

  // Mount starts the status poll; the returned stop is the cleanup (refcounted,
  // so WorkspaceTree keeping its own consumer alive costs no second timer).
  useEffect(() => startGitPolling(), []);

  // PRs are on-demand, never polled — but an empty section on first open would
  // just be a Refresh button. Fetch once if nothing has ever loaded.
  useEffect(() => {
    if (Object.keys(useGitStore.getState().prs).length === 0) {
      void useGitStore.getState().refreshPrs();
    }
  }, []);

  // Which Changes groups are collapsed. Session-only component state on purpose
  // (no LayoutPrefs schema change); absence means expanded.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const toggleRoot = (root: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(root)) next.delete(root);
      else next.add(root);
      return next;
    });
  };

  // Distinct PR authors across the CURRENT roots' loaded lists, with counts.
  // Derived from `roots`, not from every `prs` key, so a pruned root's authors
  // can never linger as chips.
  const authorCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const root of roots) {
      const items = prs[root]?.items;
      if (!items) continue;
      for (const pr of items) counts.set(pr.author, (counts.get(pr.author) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [roots, prs]);

  return (
    <div className="git-panel" data-testid="git-panel">
      <h2 className="git-panel__title">Git</h2>

      <section className="git-section" aria-label="Changes" data-testid="git-changes">
        <h3 className="git-section__title">Changes</h3>
        {roots.length === 0 ? (
          <p className="git-note">Open a folder to see its changes</p>
        ) : (
          roots.map((root) => (
            <ChangesGroup
              key={root}
              root={root}
              state={status[root]}
              collapsed={collapsed.has(root)}
              onToggle={() => toggleRoot(root)}
              onOpen={openEditorTab}
            />
          ))
        )}
      </section>

      <section className="git-section" aria-label="Pull requests" data-testid="git-prs">
        <div className="git-section__head">
          <h3 className="git-section__title">Pull Requests</h3>
          <button
            type="button"
            className="git-refresh"
            aria-label="Refresh pull requests"
            title="Refresh pull requests"
            data-testid="git-prs-refresh"
            onClick={() => void refreshPrs()}
          >
            <RefreshIcon />
          </button>
        </div>
        {authorCounts.length > 0 ? (
          <div className="git-chips" data-testid="git-author-chips">
            <button
              type="button"
              className={prAuthorFilter === null ? "git-chip git-chip--active" : "git-chip"}
              data-testid="git-author-all"
              onClick={() => setPrAuthorFilter(null)}
            >
              All
            </button>
            {authorCounts.map(([author, count]) => (
              <button
                key={author}
                type="button"
                className={prAuthorFilter === author ? "git-chip git-chip--active" : "git-chip"}
                data-testid="git-author-chip"
                data-author={author}
                onClick={() => setPrAuthorFilter(author)}
              >
                {author} ({count})
              </button>
            ))}
          </div>
        ) : null}
        {roots.map((root) => (
          <PrGroup key={root} root={root} state={prs[root]} filter={prAuthorFilter} />
        ))}
      </section>
    </div>
  );
}
