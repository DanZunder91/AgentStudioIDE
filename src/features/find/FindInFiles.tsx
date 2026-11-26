/** Project-wide search overlay (IntelliJ's Find in Files) installing its own Cmd/Ctrl+Shift+F and
 * Esc listeners. `open` is in the store so the hotkey and the right rail's Find tab share one
 * overlay; all else is local. The search root comes from `<ScopeSelector/>` (`useScope`). */

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

/** Rust's bare `cancelled` (the `find_cancel` contract) is a normal stop: never red, never "No
 * matches". Matched exactly so a real error that mentions cancellation still surfaces. */
function isCancelled(err: unknown): boolean {
  return errorMessage(err).trim().toLowerCase() === "cancelled";
}

/** One debounced search run. `cancelled` lets the Stop button neuter its reply; `ids` holds one
 * search id per root, since "All workspaces" fans out and every leg must be stopped. */
interface SearchRun {
  cancelled: boolean;
  ids: readonly string[];
}

/** A resting run, so `runRef` is non-null (and stopping it is a no-op) from render 1. */
function idleRun(): SearchRun {
  return { cancelled: true, ids: [] };
}

/** Neuter the run's reply and ask Rust to abandon every leg. Best-effort (`cancelFind` never
 * throws), so callers go idle themselves; idempotent because the ids are dropped. */
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

/** A hit tagged with its root; `file` is relative to it, so the path lands in the right repo. */
interface RootedMatch extends FindMatch {
  root: string;
}

/** Every root's hits in root order (Rust order within), whether any root truncated, and whether
 * to label rows with their repo (only with ≥2 roots). */
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

/** Grouped by (root, file) in first-seen order, so two repos' same-named files stay apart. */
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

  // `scopeRoots`: the roots the search fans out over. `open` re-arms the context default per open.
  const { effectiveScope, scopeRoots, setScope } = useScope(open);

  /** Stop the owning run (Rust abandons the walk, its reply is neutered); show "stopped" at once,
   * never "No matches": a stopped search made no claim. */
  const cancelSearch = useCallback(() => {
    stopRun(runRef.current);
    setLoading(false);
    setStopped(true);
  }, []);

  // Installed once: actions are stable and closing a closed panel is a no-op. `preventDefault`
  // keeps the browser's find-in-page off our shortcut.
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

  // No state reset here (`react-hooks/set-state-in-effect`). A "stopped" banner needs none: a
  // non-empty query re-fires the search on reopen.
  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [open]);

  // Fans out over `scopeRoots` (memoized, a safe dep) in parallel. The cleanup sets the batch's
  // shared `cancelled` flag and calls `find_cancel` per leg; every way out (query/scope change,
  // close) changes a dep, so it is the one stop. An empty query is cleared in `onQueryChange`.
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
        // Only the owning run drops the spinner, cancelled ones included (`loading` gates Stop); a
        // superseded run must not blank its replacement's spinner.
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

/** One state at a time (no root / searching / error / stopped / empty / no matches / results). */
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
  // Join the relative `file` to its own root in that root's separator: Windows sends `src\a.ts`,
  // and a mixed `C:\repo/src\a.ts` would open a second tab.
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
