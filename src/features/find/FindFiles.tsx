/** Fuzzy filename finder (Cmd/Ctrl+Shift+O), FindInFiles' sibling: a self-installing overlay
 * scoped by `<ScopeSelector/>`; one row per file. Click, or Enter on row one, opens and closes. */

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

/** Window event that opens the panel (never toggles it shut). Fired by Cmd/Ctrl+O in
 * `features/shortcuts/FindKeysShortcut`, which cannot reach this local `open` state. */
export const OPEN_FIND_FILES_EVENT = "agentstudio:open-find-files";

/** Idle time after the last keystroke/scope change before a search fires. */
const DEBOUNCE_MS = 200;

/** A rejection from Rust may be a bare string or an Error. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Rust's bare `cancelled` (the `find_cancel` contract) is a normal stop, never an error or "no
 * matching files". Matched exactly; mirrors `FindInFiles.tsx`. */
function isCancelled(err: unknown): boolean {
  return errorMessage(err).trim().toLowerCase() === "cancelled";
}

/** One debounced search run. `cancelled` lets the Stop button neuter its reply; `ids` holds one
 * search id per root, since "All workspaces" fans out and every leg must stop. */
interface SearchRun {
  cancelled: boolean;
  ids: readonly string[];
}

/** A resting run, so `runRef` is non-null (and stopping it a no-op) from render 1. */
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

/** "N files", pluralized. */
function countText(files: number): string {
  return `${files} ${files === 1 ? "file" : "files"}`;
}

/** `find_files` sends `src/a.ts` on every OS. Joining in the root's separator gives the tree's
 * `C:\repo\src\a.ts` on Windows, not a second tab on the same file. */
const joinRoot = joinPath;

/** A filename hit tagged with its root, so the abs path lands in the right repo. */
interface RootedFileHit extends FindFileHit {
  root: string;
}

/** Every root's files in root order, whether any root truncated, and whether to label rows with
 * their repo (only with ≥2 roots). */
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

  /** Stop the owning run (Rust abandons the walk, the reply is neutered) and show "stopped" at
   * once, never "No matching files". */
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

  // No state reset here (`react-hooks/set-state-in-effect`). A "stopped" banner needs none: a
  // non-empty query re-fires the search on reopen.
  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [open]);

  // Fans out over `scopeRoots` (memoized, a safe dep) in parallel. The cleanup sets the batch's
  // shared `cancelled` flag and calls `find_cancel` on every leg; every exit (query/scope change,
  // close) changes a dep, so it is the one stop. No search on an empty query or root set.
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
        // Only the owning run drops the spinner, cancelled ones included; a superseded run must not
        // blank its replacement's spinner.
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

  // Close so the opened file is visible; a filename hit opens at line 1.
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

/** One state at a time (no root / searching / error / stopped / empty / no matches / results). */
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
