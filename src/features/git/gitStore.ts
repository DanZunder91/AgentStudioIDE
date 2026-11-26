/** Feature-local git store with an API frozen for the workspace feature. Paths are absolute and
 * native-separator, split only via `lib/paths`. `usageStore.ts` rules apply per root (never blank,
 * single-flight, never reject); only status polls, and `not-a-repo` never escalates backoff. */
import { create } from "zustand";

import { useAppStore, workspaceRoots } from "../../app/store";
import type { GitStatus } from "../../app/types";
import { dirname, relativeTo } from "../../lib/paths";
import { splitWireCode } from "../../lib/wireCode";
import { ghPrs, gitStatus, type RepoStatus } from "./gitIpc";

export interface GitChange {
  path: string;
  status: GitStatus;
}

export interface PullRequest {
  number: number;
  title: string;
  author: string;
  url: string;
  headRef: string;
  baseRef: string;
  isDraft: boolean;
  updatedAt: string;
}

export type GitStatusErrorCode = "out-of-scope" | "not-a-repo" | "git" | "unknown";
export type PrErrorCode =
  | "gh-missing"
  | "gh-not-signed-in"
  | "no-remote"
  | "gh-failed"
  | "timeout"
  | "parse"
  | "out-of-scope"
  | "unknown";

/** Every `git_status` code we act on; anything else parses to `"unknown"`. */
export const GIT_STATUS_CODES: readonly GitStatusErrorCode[] = [
  "out-of-scope",
  "not-a-repo",
  "git",
  "unknown",
];

/** Every `gh_prs` code we act on; anything else parses to `"unknown"`. */
export const PR_CODES: readonly PrErrorCode[] = [
  "gh-missing",
  "gh-not-signed-in",
  "no-remote",
  "gh-failed",
  "timeout",
  "parse",
  "out-of-scope",
  "unknown",
];

export interface RootGitState {
  branch: string;
  changes: GitChange[];
  error: { code: GitStatusErrorCode; detail: string | null } | null;
}

export interface RootPrState {
  items: PullRequest[] | null;
  error: { code: PrErrorCode; detail: string | null } | null;
}

export interface GitState {
  /** Working-tree status, keyed by workspace root (the `workspaceRoots` set). */
  status: Record<string, RootGitState>;
  /** Open pull requests, keyed by workspace root. On-demand, never polled. */
  prs: Record<string, RootPrState>;
  /** null = show every author. Session-only on purpose (no LayoutPrefs schema change). */
  prAuthorFilter: string | null;
  setPrAuthorFilter(author: string | null): void;
  refreshGitStatus(): Promise<void>;
  refreshPrs(): Promise<void>;
}

export const useGitStore = create<GitState>((set) => ({
  status: {},
  prs: {},
  prAuthorFilter: null,
  setPrAuthorFilter: (author) => set({ prAuthorFilter: author }),
  // Stable function identities (hoisted declarations, not closures minted per
  // store creation), so a consumer can safely put them in a useEffect dep array.
  refreshGitStatus: refreshStatusNow,
  refreshPrs: refreshPrsNow,
}));

/* ── cadence constants (the usage panel's numbers, and for the same reasons) ── */

/** Auto-refresh cadence on the happy path, ms. One constant so tests advance the clock by exactly this. */
export const GIT_POLL_MS = 5000;

/** Delay before the next automatic status attempt, by consecutive failed cycles. */
export const GIT_BACKOFF_MS: readonly number[] = [GIT_POLL_MS, 15_000, 30_000, 60_000];

/* ── the single-flight status refresh ─────────────────────────────────────── */

type StatusOutcome =
  | { root: string; ok: true; repo: RepoStatus }
  | { root: string; ok: false; error: { code: GitStatusErrorCode; detail: string | null } };

/** One `git_status` per root; failures are caught per root, so one broken repo blanks nothing. */
async function fetchStatusOnce(): Promise<void> {
  const roots = workspaceRoots(useAppStore.getState());
  const results: StatusOutcome[] = await Promise.all(
    roots.map(async (root): Promise<StatusOutcome> => {
      try {
        return { root, ok: true, repo: await gitStatus(root) };
      } catch (reason) {
        return { root, ok: false, error: splitWireCode(reason, GIT_STATUS_CODES, "unknown") };
      }
    }),
  );

  // Rebuilt from the CURRENT roots only — a root that left `workspaceRoots`
  // is pruned by simply not being carried over. Reading the previous map here
  // is race-free: single-flight means no other status write can interleave.
  const before = useGitStore.getState().status;
  const status: Record<string, RootGitState> = {};
  let faulted = false;
  for (const r of results) {
    if (r.ok) {
      status[r.root] = { branch: r.repo.branch, changes: r.repo.changes, error: null };
    } else {
      // Never-blank: keep the last good reading for THIS root, error beside it.
      const kept = before[r.root];
      status[r.root] = {
        branch: kept?.branch ?? "",
        changes: kept?.changes ?? [],
        error: r.error,
      };
      // `not-a-repo` is an expected steady state, not a fault — see rule 4.
      if (r.error.code !== "not-a-repo") faulted = true;
    }
  }
  failures = faulted ? Math.min(failures + 1, GIT_BACKOFF_MS.length - 1) : 0;
  useGitStore.setState({ status });
}

/** The outstanding status fetch — the single-flight gate AND the ordering guarantee. */
let statusInFlight: Promise<void> | null = null;

/** Start a status fetch, or join the one already running. Never rejects. */
function refreshStatusNow(): Promise<void> {
  if (statusInFlight) return statusInFlight;
  const pending = fetchStatusOnce().finally(() => {
    statusInFlight = null;
    // Re-arm relative to the fetch that FINISHED (one rescheduling point for
    // manual and automatic alike — see usageStore.ts on why).
    rearmAutoTimer();
  });
  statusInFlight = pending;
  return pending;
}

/* ── the single-flight PR refresh (on-demand only — never polled) ─────────── */

type PrOutcome =
  | { root: string; ok: true; items: PullRequest[] }
  | { root: string; ok: false; error: { code: PrErrorCode; detail: string | null } };

async function fetchPrsOnce(): Promise<void> {
  const roots = workspaceRoots(useAppStore.getState());
  const results: PrOutcome[] = await Promise.all(
    roots.map(async (root): Promise<PrOutcome> => {
      try {
        return { root, ok: true, items: await ghPrs(root) };
      } catch (reason) {
        return { root, ok: false, error: splitWireCode(reason, PR_CODES, "unknown") };
      }
    }),
  );

  const before = useGitStore.getState().prs;
  const prs: Record<string, RootPrState> = {};
  for (const r of results) {
    prs[r.root] = r.ok
      ? { items: r.items, error: null }
      : // Never-blank: a failed re-fetch keeps the last loaded list (null only
        // when this root has never loaded), with the error recorded beside it.
        { items: before[r.root]?.items ?? null, error: r.error };
  }
  useGitStore.setState({ prs });
}

/** The outstanding PR fetch. Independent of the status gate on purpose. */
let prsInFlight: Promise<void> | null = null;

/** Start a PR fetch, or join the one already running. Never rejects. */
function refreshPrsNow(): Promise<void> {
  if (prsInFlight) return prsInFlight;
  const pending = fetchPrsOnce().finally(() => {
    prsInFlight = null;
  });
  prsInFlight = pending;
  return pending;
}

/* ── polling lifecycle: reference-counted, visibility-aware (status only) ──── */
/* The shape below is usageStore.ts's, kept line-for-line comparable on purpose —
 * one proven lifecycle, two stores. See that module for the full rationale. */

/** `document` when there is one, else `null` (non-DOM consumers read "always visible"). */
function gitDocument(): Document | null {
  return typeof document === "undefined" ? null : document;
}

/** True only when a document exists AND reports itself hidden. */
function isHidden(): boolean {
  return gitDocument()?.visibilityState === "hidden";
}

/** How many live `startGitPolling()` callers there are. Zero ⇒ nothing runs. */
let consumers = 0;

/** True between first start and last stop, except while paused for a hidden document. */
let ticking = false;

/** Handle for the next automatic attempt; `null` while idle, paused, or mid-fetch. */
let timer: ReturnType<typeof setTimeout> | null = null;

/** Consecutive failed status CYCLES — an index into {@link GIT_BACKOFF_MS}. */
let failures = 0;

/** Undo for the `visibilitychange` subscription; `null` when unbound / non-DOM. */
let unbindVisibility: (() => void) | null = null;

/** Cancel any armed attempt. Safe to call when none is armed. */
function clearTimer(): void {
  if (timer === null) return;
  clearTimeout(timer);
  timer = null;
}

/** Arm the next automatic attempt, unless stopped or paused. */
function rearmAutoTimer(): void {
  if (!ticking) return;
  clearTimer();
  timer = setTimeout(() => void refreshStatusNow(), GIT_BACKOFF_MS[failures]);
}

/** Begin ticking (idempotent). The first attempt is IMMEDIATE. */
function startTicking(): void {
  if (ticking) return;
  ticking = true;
  void refreshStatusNow();
}

/** Stop ticking (idempotent, so pausing an already-paused poller is a no-op). */
function stopTicking(): void {
  if (!ticking) return;
  ticking = false;
  clearTimer();
}

/** First consumer: subscribe to visibility, and start ticking unless hidden. */
function attachPolling(): void {
  const doc = gitDocument();
  if (doc) {
    const handler = (): void => {
      if (isHidden()) stopTicking();
      else startTicking();
    };
    doc.addEventListener("visibilitychange", handler);
    unbindVisibility = () => doc.removeEventListener("visibilitychange", handler);
  }
  if (!isHidden()) startTicking();
}

/** Last consumer left: stop the clock and remove the listener — no leaks. */
function detachPolling(): void {
  stopTicking();
  unbindVisibility?.();
  unbindVisibility = null;
}

/** Refcounted, visibility-aware status poll with failure backoff; the stop is idempotent
 * (StrictMode double-cleanup). */
export function startGitPolling(): () => void {
  consumers += 1;
  if (consumers === 1) attachPolling();

  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    consumers -= 1;
    if (consumers === 0) detachPolling();
  };
}

/** Flatten every root's changes into one absolute-path → status lookup. */
export function fileStatusMap(status: Record<string, RootGitState>): Record<string, GitStatus> {
  const out: Record<string, GitStatus> = {};
  for (const root of Object.keys(status)) {
    for (const change of status[root].changes) out[change.path] = change.status;
  }
  return out;
}

/** Every directory containing a change, below the root (root headers carry no badge). Entries are
 * sliced from each change's own path, so they match the tree's `data-path` on every OS. */
export function dirsWithChanges(status: Record<string, RootGitState>): Set<string> {
  const out = new Set<string>();
  for (const root of Object.keys(status)) {
    for (const change of status[root].changes) {
      let dir = dirname(change.path);
      // `dirname` stops at the filesystem root, where `relativeTo` answers "" or null.
      while (relativeTo(root, dir)) {
        out.add(dir);
        dir = dirname(dir);
      }
    }
  }
  return out;
}
