/**
 * FindFiles — the fuzzy FILENAME finder (Cmd/Ctrl+Shift+O).
 *
 * The quick-open sibling of `<FindInFiles>`: type `store.ts`, get the files whose
 * NAME matches, open one. Separate from Cmd/Ctrl+Shift+F, which searches file
 * *content*. Mirrors FindInFiles exactly — a self-contained overlay that installs
 * its OWN global toggle + Esc-close, so `App.tsx`'s only addition is a one-line
 * `<FindFiles/>` mount, and its behaviour lands in the coverage-measured set.
 *
 * The one new thing over FindInFiles is the shared `<ScopeSelector/>`: the search
 * is pinned to `scopeRoot` (workspace/folder), so it need not scan everything.
 * Results are a flat list (no per-file grouping — one row IS a file); clicking a
 * row, or Enter on the first, opens it and closes the overlay.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { CloseIcon } from "../../components/icons";
import { displayRelative, joinPath } from "../../lib/paths";
import { revealInEditor } from "../editor";
import {
  cancelFind,
  findFiles,
  newSearchId,
  type FindFileHit,
  type FindFilesOptions,
  type FindFilesResult,
} from "./findIpc";
import { folderName, ScopeSelector, useScope } from "./ScopeSelector";
import "./find.css";

/**
 * Window event that OPENS the panel (idempotent — never toggles it shut). Fired by
 * the bare Cmd/Ctrl+O binding in `features/shortcuts/FindKeysShortcut`, so that
 * component need not reach into this one's local `open` state.
 */
export const OPEN_FIND_FILES_EVENT = "agentstudio:open-find-files";

/** Idle time after the last keystroke/scope change before a search fires. */
const DEBOUNCE_MS = 200;

/** A rejection from Rust may be a bare string or an Error. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Rust rejects a cancelled walk with the bare message `cancelled` (the
 * `find_cancel` contract) — a NORMAL outcome, never an error and never "no
 * matching files". Matched exactly (trimmed/case-folded), so a genuine failure
 * that merely mentions cancellation still reaches the user. Mirrors
 * `FindInFiles.tsx`'s copy, alongside `errorMessage`/`DEBOUNCE_MS`.
 */
function isCancelled(err: unknown): boolean {
  return errorMessage(err).trim().toLowerCase() === "cancelled";
}

/**
 * One debounced search run — scheduled, then in flight, then settled.
 *
 * `cancelled` is the pre-existing stale-result guard (it was a closure `let`),
 * promoted to a field so the Stop button, which lives outside the effect, can
 * flip it. `ids` are the ids Rust knows this run by: ONE PER ROOT, because "All
 * workspaces" fans out into one `find_files` per root and every leg must stop.
 */
interface SearchRun {
  cancelled: boolean;
  ids: readonly string[];
}

/** A resting run, so `runRef` is non-null (and stopping it a no-op) from render 1. */
function idleRun(): SearchRun {
  return { cancelled: true, ids: [] };
}

/**
 * Stop one run: neuter its reply AND ask Rust to abandon the walk on every leg.
 * Best-effort by design — `cancelFind` never throws, and the walk stops at its
 * next check — so the caller returns to idle itself. Idempotent: the ids are
 * dropped, so a second stop sends nothing.
 */
function stopRun(run: SearchRun): void {
  run.cancelled = true;
  for (const id of run.ids) void cancelFind(id);
  run.ids = [];
}

/** "N files", pluralized. */
function countText(files: number): string {
  return `${files} ${files === 1 ? "file" : "files"}`;
}

/**
 * Join a search root to a hit's relative path, in the root's own separator. `find_files`
 * sends `src/a.ts` on every OS; on Windows the tab must be `C:\repo\src\a.ts` — the file
 * tree's and git's spelling — or it is a second tab on the same file that the Files rail
 * cannot select.
 */
const joinRoot = joinPath;

/**
 * A filename hit tagged with the root it came from: its abs path is
 * `${root}/${path}` — the RIGHT repo — and, when the search fanned out over ≥2
 * roots, the row can show which repo it lives in.
 */
interface RootedFileHit extends FindFileHit {
  root: string;
}

/**
 * The fan-out's merged view: every root's files tagged with their root (root
 * order preserved), whether ANY root truncated, and whether to label each row
 * with its repo (only with ≥2 roots — a single root reads exactly as before).
 */
interface MergedFilesResult {
  files: RootedFileHit[];
  truncated: boolean;
  multiRoot: boolean;
}

/** Merge the per-root filename results into one tagged set (root order preserved). */
function mergeFilesResults(perRoot: { root: string; res: FindFilesResult }[]): MergedFilesResult {
  const files: RootedFileHit[] = [];
  let truncated = false;
  for (const { root, res } of perRoot) {
    for (const f of res.files) files.push({ ...f, root });
    truncated = truncated || res.truncated;
  }
  return { files, truncated, multiRoot: perRoot.length > 1 };
}

export function FindFiles(): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [result, setResult] = useState<MergedFilesResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);

  // The run that currently owns the panel — scheduled (debouncing) or in flight.
  // A ref, not state: the Stop button and the search effect both need it, and it
  // must never itself cause a render. Starts resting, so it is never null.
  const runRef = useRef<SearchRun>(idleRun());

  // The set of roots the search fans out over: one by default (the workspace of
  // the tab the user is in), or every open root under "All workspaces".
  // `open` re-arms the context default on every fresh open.
  const { effectiveScope, scopeRoots, setScope } = useScope(open);

  /**
   * Kill the run that owns the panel (a search must be killable):
   * Rust abandons its walk, the reply is neutered, and the panel lands in a calm
   * "stopped" state at once rather than waiting on an advisory cancel — and NOT
   * in "No matching files", which a search that never finished cannot claim.
   */
  const cancelSearch = useCallback(() => {
    stopRun(runRef.current);
    setLoading(false);
    setStopped(true);
  }, []);

  // The global hotkey — Cmd/Ctrl+Shift+O. Installed once (empty deps), same
  // shape as FindInFiles: `preventDefault` on the toggle keeps any browser
  // default off our shortcut, and Esc closes without reading `open`.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.shiftKey && e.key.toLowerCase() === "o") {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    };
    // Bare Cmd/Ctrl+O (`features/shortcuts/FindKeysShortcut`) asks for the panel
    // through this event — an OPEN, never a toggle, so pressing it with the panel
    // already up keeps it up rather than closing it under the user.
    const onOpenRequest = () => setOpen(true);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener(OPEN_FIND_FILES_EVENT, onOpenRequest);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener(OPEN_FIND_FILES_EVENT, onOpenRequest);
    };
  }, []);

  // Focus + select the input each time the panel opens. No state is reset here:
  // `react-hooks/set-state-in-effect` forbids it, and a lingering "stopped"
  // banner clears itself — it can only be up while the query is non-empty, and a
  // non-empty query re-fires the search on reopen.
  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [open]);

  // Debounced search. Re-runs on query, scope, or the case toggle. Fans out over
  // every root in `scopeRoots` in parallel (one by default, all under "All
  // workspaces") and merges the tagged results. A superseded run is neutered by
  // ONE shared `cancelled` flag (in `apply`) for the whole batch, so a slow
  // result that lands after the query moved on cannot overwrite the fresh one —
  // and the cleanup ALSO calls `find_cancel` on every leg so
  // the walk actually stops rather than merely having its answer discarded. That
  // one cleanup is the single mechanism behind every exit from a search:
  // superseding it, and closing the overlay (✕, Esc, the Cmd+Shift+O toggle,
  // opening a hit) — all change a dep, so all stop Rust. An empty query never
  // searches; an empty root set (no workspace) never searches — the resting hint
  // / "open a folder" states cover both. `scopeRoots` is a stable reference
  // (memoized in `useScope`), so it is a safe effect dep.
  useEffect(() => {
    if (!open || scopeRoots.length === 0 || query === "") return;
    // The run owns the panel from the moment it is SCHEDULED, not from when it
    // fires, so Stop works during the debounce window too.
    const run: SearchRun = { cancelled: false, ids: [] };
    runRef.current = run;
    const options: FindFilesOptions = { caseSensitive };
    const timer = window.setTimeout(() => {
      if (run.cancelled) return;
      // One id per leg of the fan-out: a cancel has to reach every root's walk.
      run.ids = scopeRoots.map(() => newSearchId());
      setLoading(true);
      setStopped(false);
      const apply = (settle: () => void) => {
        // Drop the spinner when the run that owns the panel settles — including a
        // CANCELLED one, whose reply is the last thing that will ever happen to
        // it. A superseded run stays silent rather than blanking the spinner of
        // the run that replaced it.
        if (runRef.current === run) setLoading(false);
        if (run.cancelled) return;
        settle();
      };
      Promise.all(
        scopeRoots.map((root, i) =>
          findFiles(root, query, options, run.ids[i]).then((res) => ({ root, res })),
        ),
      ).then(
        (perRoot) =>
          apply(() => {
            setResult(mergeFilesResults(perRoot));
            setError(null);
          }),
        (err) =>
          apply(() => {
            // A cancelled walk is a normal outcome, not a failure.
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
  }, [open, scopeRoots, query, caseSensitive]);

  const onQueryChange = useCallback((value: string) => {
    setQuery(value);
    // Emptying the box returns to the resting hint at once (an event handler, not
    // the search effect, which must not setState synchronously).
    if (value === "") {
      setResult(null);
      setError(null);
      setLoading(false);
      setStopped(false);
    }
  }, []);

  // Open a hit and close the overlay so the opened file is visible — the
  // click-to-open-and-close behaviour. `abs` is built by a caller that
  // has already narrowed `scopeRoot` non-null. Line 1: a filename finder lands at
  // the top of the file, not at a match.
  const openHit = useCallback((abs: string) => {
    void revealInEditor(abs, 1);
    setOpen(false);
  }, []);

  // The absolute path Enter would open: the first (top-ranked) hit, joined to ITS
  // OWN root, or null when there is nothing to open. Derived once so the key
  // handler is a single branch.
  const firstHit = result && result.files.length > 0 ? result.files[0] : null;
  const firstHitAbs = firstHit ? joinRoot(firstHit.root, firstHit.path) : null;

  // Enter opens the first hit — the keyboard path to the same "open-and-close"
  // the click gives.
  const onInputKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && firstHitAbs) {
        e.preventDefault();
        openHit(firstHitAbs);
      }
    },
    [firstHitAbs, openHit],
  );

  if (!open) return <></>;

  return (
    <div className="find-panel" role="dialog" aria-label="Find files by name" data-testid="find-files">
      <div className="find-panel__bar">
        <input
          ref={inputRef}
          className="find-panel__input"
          type="text"
          placeholder="File name"
          aria-label="Find files"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={onInputKeyDown}
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
        </div>
        <button
          type="button"
          className="find-panel__close"
          aria-label="Close find files"
          title="Close (Esc)"
          onClick={() => setOpen(false)}
        >
          <CloseIcon size={12} />
        </button>
      </div>

      <div className="find-panel__scope">
        <ScopeSelector value={effectiveScope} onChange={setScope} />
      </div>

      <FindFilesResults
        hasRoot={scopeRoots.length > 0}
        loading={loading}
        stopped={stopped}
        error={error}
        result={result}
        onCancel={cancelSearch}
        onOpen={openHit}
      />
    </div>
  );
}

/**
 * The body under the bar: one calm state at a time (no root / searching / error /
 * stopped / empty query / no matches / results). Split out so each state is a
 * single `if`, the same shape as FindInFiles' `FindResults`.
 */
function FindFilesResults({
  hasRoot,
  loading,
  stopped,
  error,
  result,
  onCancel,
  onOpen,
}: {
  hasRoot: boolean;
  loading: boolean;
  stopped: boolean;
  error: string | null;
  result: MergedFilesResult | null;
  onCancel: () => void;
  onOpen: (abs: string) => void;
}): React.JSX.Element {
  if (!hasRoot) {
    return <div className="find-panel__status">Open a folder to search.</div>;
  }
  if (loading) {
    // The Stop control sits WITH the spinner: it exists only while there is
    // something to stop, and this is where the user is already looking.
    return (
      <div className="find-panel__status find-panel__status--busy">
        <span className="find-spinner" aria-hidden="true" />
        <span className="find-panel__busy-label">Searching…</span>
        <button
          type="button"
          className="find-stop"
          data-testid="find-files-cancel"
          aria-label="Cancel file search"
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
    // Deliberately NOT "No matching files": the walk never finished, so nothing
    // may be claimed about what the project does or does not contain.
    return (
      <div className="find-panel__status" data-testid="find-files-stopped">
        Search stopped before it finished.
      </div>
    );
  }
  if (!result) {
    return <div className="find-panel__status find-panel__status--hint">Type a file name.</div>;
  }
  if (result.files.length === 0) {
    return <div className="find-panel__status">No matching files</div>;
  }

  return (
    <div className="find-panel__results">
      <div className="find-panel__count" data-testid="find-files-count">
        {countText(result.files.length)}
      </div>
      {result.truncated && (
        <div className="find-panel__truncated" data-testid="find-files-truncated">
          Showing the first {result.files.length} files — narrow the search to see more.
        </div>
      )}
      <ul className="find-files">
        {result.files.map((hit: RootedFileHit) => (
          <li key={`${hit.root} ${hit.path}`}>
            <button
              type="button"
              className="find-file"
              data-testid="find-file-hit"
              onClick={() => onOpen(joinRoot(hit.root, hit.path))}
            >
              {/* With ≥2 roots, tag the row with its repo so hits are distinguishable. */}
              {result.multiRoot && (
                <span className="find-file__repo" data-testid="find-file-repo">
                  {folderName(hit.root)}
                </span>
              )}
              <span className="find-file__name">{hit.name}</span>
              {/* `find_files` sends `/`; a Windows root shows `\`, like Find in Files. */}
              <span className="find-file__path">{displayRelative(hit.root, hit.path)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
