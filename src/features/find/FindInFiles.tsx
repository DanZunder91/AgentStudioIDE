/**
 * FindInFiles — project-wide search, on IntelliJ's "Find in Files" model
 * (frontend half).
 *
 * A self-contained toggleable overlay: it installs its OWN global
 * Cmd/Ctrl+Shift+F listener (toggle + focus the input) and Esc (close), so
 * `App.tsx`'s only addition is a one-line `<FindInFiles/>` mount — the same
 * "component wires itself to the world" pattern as `<LeftRail/>` /
 * `<WorkspaceTree/>`. Locating the hotkey here (rather than in App) also means
 * it lives in the coverage-measured feature set, so its behaviour is gated.
 *
 * The `open` state lives in the store (`findInFilesOpen`) so the
 * Cmd/Ctrl+Shift+F hotkey AND the right rail's Find tab drive the SAME overlay —
 * mirroring `<ShortcutsPanel/>`'s store-driven open. Everything ELSE stays LOCAL:
 * query, the four modifiers, the file mask, results, per-file collapse, loading
 * and error. The search root comes from the shared `<ScopeSelector/>` (`useScope`)
 * — a workspace/folder scope that DEFAULTS to the workspace owning the focused
 * tab (its file, or its terminal's cwd — `contextScope.ts`),
 * else the primary root. Opening a hit still
 * rides the `openEditorTab` action.
 *
 * The search is debounced; results are grouped by file (collapsible), each hit
 * a row that highlights the matched span and, on click, opens the file (see the
 * `revealInEditor` TODO below for landing on the exact line).
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { useAppStore } from "../../app/store";
import { ChevronIcon, CloseIcon } from "../../components/icons";
import {
  cancelFind,
  findInFiles,
  newSearchId,
  type FindMatch,
  type FindOptions,
  type FindResult,
} from "./findIpc";
import { folderName, ScopeSelector, useScope } from "./ScopeSelector";
import { displayRelative, joinPath } from "../../lib/paths";
import { revealInEditor } from "../editor";
import "./find.css";

/** Idle time after the last keystroke/toggle before a search fires. */
const DEBOUNCE_MS = 200;

/** A hit's error surfaced from Rust may be a bare string or an Error. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Rust rejects a cancelled walk with the bare message `cancelled` (the
 * `find_cancel` contract). That is a NORMAL outcome — somebody stopped it — so
 * it must never be painted red, and never collapse into "No matches": a search
 * that was stopped has made no claim about the codebase.
 *
 * Matched exactly (trimmed/case-folded) rather than by substring, so a genuine
 * failure that merely *mentions* cancellation still reaches the user.
 */
function isCancelled(err: unknown): boolean {
  return errorMessage(err).trim().toLowerCase() === "cancelled";
}

/**
 * One debounced search run — scheduled, then in flight, then settled.
 *
 * `cancelled` is the pre-existing stale-result guard (it was a closure `let`),
 * promoted to a field so that code OUTSIDE the effect — the Stop button — can
 * flip it. `ids` are the search ids Rust knows this run by: ONE PER ROOT, because
 * a scope of "All workspaces" fans out into one `find_in_files` per root and every
 * leg has to be stopped, not just the first.
 */
interface SearchRun {
  cancelled: boolean;
  ids: readonly string[];
}

/** A resting run, so `runRef` is non-null (and stopping it is a no-op) from render 1. */
function idleRun(): SearchRun {
  return { cancelled: true, ids: [] };
}

/**
 * Stop one run: neuter its reply AND ask Rust to abandon the walk on every leg.
 * Best-effort by design — `cancelFind` never throws, and the walk stops at its
 * next check, so the caller returns to idle itself rather than waiting on this.
 * Idempotent: the ids are dropped, so a second stop sends nothing.
 */
function stopRun(run: SearchRun): void {
  run.cancelled = true;
  for (const id of run.ids) void cancelFind(id);
  run.ids = [];
}

/** "N matches in M files", pluralized. */
function countText(matches: number, files: number): string {
  const m = `${matches} ${matches === 1 ? "match" : "matches"}`;
  const f = `${files} ${files === 1 ? "file" : "files"}`;
  return `${m} in ${f}`;
}

/** The last path segment (the file's display name); the rest is its dim dir. */
function splitPath(path: string): { name: string; dir: string } {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i < 0 ? { name: path, dir: "" } : { name: path.slice(i + 1), dir: path.slice(0, i) };
}

/**
 * A hit tagged with the root it came from. `file` is RELATIVE to that
 * root, so the abs path for `revealInEditor` is `${root}/${file}` — the RIGHT
 * repo — and, when the search fanned out over ≥2 roots, the row can show which.
 */
interface RootedMatch extends FindMatch {
  root: string;
}

/**
 * The fan-out's merged view: every root's hits tagged with their root (root
 * order, Rust order within a root), whether ANY root truncated, and whether to
 * label each result with its repo (only with ≥2 roots — a single root, the
 * default, reads exactly as before).
 */
interface MergedResult {
  matches: RootedMatch[];
  truncated: boolean;
  multiRoot: boolean;
}

/** Merge the per-root results into one tagged set (root order preserved). */
function mergeResults(perRoot: { root: string; res: FindResult }[]): MergedResult {
  const matches: RootedMatch[] = [];
  let truncated = false;
  for (const { root, res } of perRoot) {
    for (const m of res.matches) matches.push({ ...m, root });
    truncated = truncated || res.truncated;
  }
  return { matches, truncated, multiRoot: perRoot.length > 1 };
}

/**
 * Group matches by (root, file), preserving first-seen order (Rust's order, root
 * by root). Keying on root+file keeps two repos' identically-named files apart.
 */
interface FileGroup {
  key: string;
  root: string;
  file: string;
  matches: RootedMatch[];
}
function groupByFile(matches: RootedMatch[]): FileGroup[] {
  const order: string[] = [];
  const byKey = new Map<string, FileGroup>();
  for (const m of matches) {
    const key = `${m.root}\u0000${m.file}`;
    let group = byKey.get(key);
    if (!group) {
      group = { key, root: m.root, file: m.file, matches: [] };
      byKey.set(key, group);
      order.push(key);
    }
    group.matches.push(m);
  }
  return order.map((key) => byKey.get(key) as FileGroup);
}

/** The match line with leading indentation trimmed and the hit span marked. */
function MatchLine({ match }: { match: FindMatch }): React.JSX.Element {
  const { lineText, matchStart, matchEnd } = match;
  // Trim leading indentation for "light context" without losing the span:
  // shift the offsets by however much we dropped, then clamp into range.
  const leading = lineText.length - lineText.trimStart().length;
  const body = lineText.slice(leading);
  const start = Math.max(0, Math.min(matchStart - leading, body.length));
  const end = Math.max(start, Math.min(matchEnd - leading, body.length));
  return (
    <span className="find-match__code">
      {body.slice(0, start)}
      <mark className="find-match__hit">{body.slice(start, end)}</mark>
      {body.slice(end)}
    </span>
  );
}

export function FindInFiles(): React.JSX.Element {
  // Open state is the store's so the hotkey and the Find rail tab drive
  // the same overlay; the toggle/close actions are stable store references.
  const open = useAppStore((s) => s.findInFilesOpen);
  const toggleFindInFiles = useAppStore((s) => s.uiActions.toggleFindInFiles);
  const setFindInFilesOpen = useAppStore((s) => s.uiActions.setFindInFilesOpen);
  const [query, setQuery] = useState("");
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [glob, setGlob] = useState("");
  const [result, setResult] = useState<MergedResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const inputRef = useRef<HTMLInputElement>(null);

  // The run that currently owns the panel — scheduled (debouncing) or in flight.
  // A ref, not state: the Stop button and the search effect both need it, and it
  // must never itself cause a render. Starts resting, so it is never null.
  const runRef = useRef<SearchRun>(idleRun());

  // The shared scope (workspace/folder). `scopeRoots` is the set of absolute
  // roots the search fans out over: one root by default (the workspace of the tab
  // the user is in), or every open root under "All workspaces". `open`
  // re-arms the context default on every fresh open.
  const { effectiveScope, scopeRoots, setScope } = useScope(open);

  /**
   * The requirement: the search runs in parallel, so that it can be killed.
   * Stop the run that owns the panel — Rust abandons the walk, the
   * reply (whenever it lands) is neutered, and the panel returns to a calm
   * "stopped" state IMMEDIATELY rather than waiting on an advisory cancel.
   *
   * It deliberately does NOT fall back to "No matches": a stopped search never
   * finished, so claiming the project has no matches would be a lie.
   */
  const cancelSearch = useCallback(() => {
    stopRun(runRef.current);
    setLoading(false);
    setStopped(true);
  }, []);

  // The global hotkey. Installed once: the store actions are stable references,
  // and closing an already-closed panel is a no-op, so Esc need not read `open`.
  // `preventDefault` on the toggle keeps the browser's own Find-in-page off our
  // shortcut.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        toggleFindInFiles();
      } else if (e.key === "Escape") {
        setFindInFilesOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggleFindInFiles, setFindInFilesOpen]);

  // Focus (and select) the input each time the panel opens, so a re-toggle lands
  // the cursor ready to type — refs are set at commit, before this effect runs.
  // No state is reset here: `react-hooks/set-state-in-effect` forbids it, and a
  // lingering "stopped" banner clears itself — it can only be up while the query
  // is non-empty, and a non-empty query re-fires the search on reopen.
  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [open]);

  // Debounced search. Re-runs on any input OR modifier change. Fans out over
  // every root in `scopeRoots` in parallel (one root by default, all under "All
  // workspaces") and merges the tagged results. A superseded run is neutered by
  // ONE shared `cancelled` flag (in `apply`) for the whole batch, so a slow
  // result that lands after the query moved on cannot overwrite the fresh one —
  // and the cleanup ALSO calls `find_cancel` on every leg, so
  // the walk actually stops instead of merely having its answer thrown away.
  // That one cleanup is the single mechanism behind every way out of a search:
  // superseding it (query/modifier/scope change), closing the overlay (✕, Esc,
  // the Cmd+Shift+F toggle, clicking a result) — all of them change a dep, so all
  // of them stop Rust. An empty query never searches — clearing back to the
  // resting hint is done eagerly in `onQueryChange` (an effect must not setState
  // synchronously). `scopeRoots` is a stable reference (memoized in `useScope`),
  // so it is a safe effect dep.
  useEffect(() => {
    if (!open || scopeRoots.length === 0 || query === "") return;
    // The run owns the panel from the moment it is SCHEDULED, not from when it
    // fires — so Stop works during the debounce window too (it flips `cancelled`,
    // which the timer reads before doing anything).
    const run: SearchRun = { cancelled: false, ids: [] };
    runRef.current = run;
    const options: FindOptions = { regex, caseSensitive, wholeWord, glob };
    const timer = window.setTimeout(() => {
      if (run.cancelled) return;
      // One id per leg of the fan-out: cancelling has to reach every root's walk,
      // and giving two concurrent commands the same id would make Rust's registry
      // ambiguous about which one a cancel meant.
      run.ids = scopeRoots.map(() => newSearchId());
      setLoading(true);
      setStopped(false);
      const apply = (settle: () => void) => {
        // Drop the spinner when the run that owns the panel settles — including a
        // CANCELLED one, whose reply is the last thing that will ever happen to
        // it (leaving `loading` true there stranded the panel on reopen, and made
        // `loading` useless as the Stop button's gate). A superseded run stays
        // silent: blanking the spinner of the run that replaced it would be worse.
        if (runRef.current === run) setLoading(false);
        if (run.cancelled) return;
        settle();
      };
      Promise.all(
        scopeRoots.map((root, i) =>
          findInFiles(root, query, options, run.ids[i]).then((res) => ({ root, res })),
        ),
      ).then(
        (perRoot) =>
          apply(() => {
            setResult(mergeResults(perRoot));
            setError(null);
          }),
        (err) =>
          apply(() => {
            // A cancelled walk is a normal outcome, not a failure: stay calm and
            // leave the panel as it was rather than crying wolf in red.
            if (isCancelled(err)) return;
            setError(errorMessage(err));
            setResult(null);
          }),
      );
    }, DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      stopRun(run);
    };
  }, [open, scopeRoots, query, regex, caseSensitive, wholeWord, glob]);

  const onQueryChange = useCallback((value: string) => {
    setQuery(value);
    // Emptying the box returns to the resting hint at once — there is nothing to
    // search for, so drop any prior result/error/loading. Done here (an event
    // handler), not in the search effect, which must not setState synchronously.
    if (value === "") {
      setResult(null);
      setError(null);
      setLoading(false);
      setStopped(false);
    }
  }, []);

  const toggleFile = useCallback((file: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(file)) next.delete(file);
      else next.add(file);
      return next;
    });
  }, []);

  const openResult = useCallback((abs: string, match: FindMatch) => {
    // `abs` is built by `FindResults` from the match's OWN root (the right repo);
    // reveal the exact line, then close the overlay so the opened file is visible.
    void revealInEditor(abs, match.line, match.col);
    setFindInFilesOpen(false);
  }, [setFindInFilesOpen]);

  if (!open) return <></>;

  return (
    <div className="find-panel" role="dialog" aria-label="Find in files" data-testid="find-in-files">
      <div className="find-panel__bar">
        <input
          ref={inputRef}
          className="find-panel__input"
          type="text"
          placeholder="Search"
          aria-label="Search in files"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
        />
        <div className="find-panel__toggles">
          <button
            type="button"
            className={`find-toggle${caseSensitive ? " is-active" : ""}`}
            aria-label="Case sensitive"
            aria-pressed={caseSensitive}
            title="Case sensitive"
            onClick={() => setCaseSensitive((v) => !v)}
          >
            Cc
          </button>
          <button
            type="button"
            className={`find-toggle${wholeWord ? " is-active" : ""}`}
            aria-label="Whole word"
            aria-pressed={wholeWord}
            title="Whole word"
            onClick={() => setWholeWord((v) => !v)}
          >
            W
          </button>
          <button
            type="button"
            className={`find-toggle${regex ? " is-active" : ""}`}
            aria-label="Regular expression"
            aria-pressed={regex}
            title="Regular expression"
            onClick={() => setRegex((v) => !v)}
          >
            .*
          </button>
        </div>
        <input
          className="find-panel__mask"
          type="text"
          placeholder="File mask"
          aria-label="File mask"
          value={glob}
          onChange={(e) => setGlob(e.target.value)}
        />
        <button
          type="button"
          className="find-panel__close"
          aria-label="Close search"
          title="Close (Esc)"
          onClick={() => setFindInFilesOpen(false)}
        >
          <CloseIcon size={12} />
        </button>
      </div>

      <div className="find-panel__scope">
        <ScopeSelector value={effectiveScope} onChange={setScope} />
      </div>

      <FindResults
        hasRoot={scopeRoots.length > 0}
        loading={loading}
        stopped={stopped}
        error={error}
        result={result}
        collapsed={collapsed}
        onCancel={cancelSearch}
        onToggleFile={toggleFile}
        onOpenResult={openResult}
      />
    </div>
  );
}

/**
 * The body under the search bar: one calm state at a time (no root / searching /
 * error / stopped / empty query / no matches / results). Split out so each state
 * is a single `if` rather than a stack of compound `&&` conditions.
 */
function FindResults({
  hasRoot,
  loading,
  stopped,
  error,
  result,
  collapsed,
  onCancel,
  onToggleFile,
  onOpenResult,
}: {
  hasRoot: boolean;
  loading: boolean;
  stopped: boolean;
  error: string | null;
  result: MergedResult | null;
  collapsed: ReadonlySet<string>;
  onCancel: () => void;
  onToggleFile: (key: string) => void;
  onOpenResult: (abs: string, match: RootedMatch) => void;
}): React.JSX.Element {
  if (!hasRoot) {
    return <div className="find-panel__status">Open a folder to search.</div>;
  }
  // A hit's RELATIVE `file` (find_in_files contract) joins to its OWN root — the
  // absolute path `read_file`/`revealInEditor` require, in the right repo — and in the
  // root's own separator: `find_in_files` sends `src\a.ts` on Windows, and the tab must be
  // the tree's `C:\repo\src\a.ts`, never a mixed `C:\repo/src\a.ts` second tab.
  const toAbs = (m: RootedMatch) => joinPath(m.root, m.file);
  if (loading) {
    // The Stop control sits WITH the spinner, not in the toolbar: it exists only
    // while there is something to stop, and this is where the user is looking.
    return (
      <div className="find-panel__status find-panel__status--busy">
        <span className="find-spinner" aria-hidden="true" />
        <span className="find-panel__busy-label">Searching…</span>
        <button
          type="button"
          className="find-stop"
          data-testid="find-cancel"
          aria-label="Cancel search"
          title="Stop this search"
          onClick={onCancel}
        >
          Stop
        </button>
      </div>
    );
  }
  if (error) {
    return (
      <div className="find-panel__status find-panel__status--error" role="alert">
        {error}
      </div>
    );
  }
  if (stopped) {
    // Deliberately NOT "No matches": the walk never finished, so the project has
    // not been searched and nothing may be claimed about what is in it.
    return (
      <div className="find-panel__status" data-testid="find-stopped">
        Search stopped before it finished.
      </div>
    );
  }
  if (!result) {
    return <div className="find-panel__status find-panel__status--hint">Type to search the project.</div>;
  }
  if (result.matches.length === 0) {
    return <div className="find-panel__status">No matches</div>;
  }

  const groups = groupByFile(result.matches);
  return (
    <div className="find-panel__results">
      <div className="find-panel__count" data-testid="find-count">
        {countText(result.matches.length, groups.length)}
      </div>
      {result.truncated && (
        <div className="find-panel__truncated" data-testid="find-truncated">
          Showing the first {result.matches.length} results — narrow the search to see more.
        </div>
      )}
      <ul className="find-groups">
        {groups.map((group) => {
          const isCollapsed = collapsed.has(group.key);
          const { name, dir } = splitPath(group.file);
          return (
            <li key={group.key} className="find-group">
              <button
                type="button"
                className="find-group__header"
                aria-expanded={!isCollapsed}
                data-testid="find-file"
                onClick={() => onToggleFile(group.key)}
              >
                <span className={`find-group__caret${isCollapsed ? "" : " is-open"}`}>
                  <ChevronIcon size={11} />
                </span>
                {/* With ≥2 roots, tag the group with its repo so hits are distinguishable. */}
                {result.multiRoot && (
                  <span className="find-group__repo" data-testid="find-repo">
                    {folderName(group.root)}
                  </span>
                )}
                <span className="find-group__name">{name}</span>
                {dir && <span className="find-group__dir">{displayRelative(group.root, dir)}</span>}
                <span className="find-group__badge">{group.matches.length}</span>
              </button>
              {!isCollapsed && (
                <ul className="find-group__matches">
                  {group.matches.map((match, i) => (
                    <li key={i}>
                      <button
                        type="button"
                        className="find-match"
                        data-testid="find-match"
                        onClick={() => onOpenResult(toAbs(match), match)}
                      >
                        <span className="find-match__ln">{match.line}</span>
                        <MatchLine match={match} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
