/**
 * ScopeSelector — the shared "Workspace ▾ + Folder ▾" scope picker used by BOTH
 * find overlays. It narrows where a search looks — pin a search to
 * `workspace/folder` so it need not scan everything.
 *
 * Controlled (`{ value, onChange }`): the parent overlay owns the scope so it can
 * feed `scopeRootOf(value)` straight into its search. This component reads the
 * store only for its two dropdowns' OPTIONS — the workspace list and, via
 * `read_dir`, the selected workspace's immediate subfolders.
 *
 * The parent's scope wiring is the `useScope` hook below: it holds the local
 * scope, resolves the default workspace from what the user is LOOKING AT (the
 * focused tab's file / terminal cwd — `contextScope.ts`),
 * falling back to the primary root, and derives the effective value + its root —
 * so FindFiles and FindInFiles share one implementation of "which folder are we
 * searching".
 */

import { useEffect, useMemo, useState } from "react";

import { useAppStore, workspaceRoots } from "../../app/store";
import type { FsEntry } from "../../app/types";
import { joinPath } from "../../lib/paths";
import { getTerminalMeta } from "../terminal";
import { readDir } from "../workspace/workspaceIpc";
import {
  contextRoot,
  rememberContextTab,
  type ContextMemory,
  type TerminalCwdLookup,
} from "./contextScope";

/**
 * Sentinel workspace value for "All workspaces": search EVERY open
 * root at once. A leading space keeps it from ever colliding with a real path
 * (no filesystem root is `" all"`), so `scopeRootOf` / `read_dir` never treat it
 * as a directory. When it is the workspace, the Folder box is locked to "All"
 * (you cannot pick one subfolder across many repos).
 */
export const ALL_WORKSPACES = " all";

/** The scope the overlays search under: a workspace root + an optional subfolder. */
export interface ScopeValue {
  /**
   * The absolute workspace root, `ALL_WORKSPACES` for the fan-out over every
   * open root, or null until one is open.
   */
  workspace: string | null;
  /** A subfolder NAME under `workspace`, or "" for the whole workspace. */
  folder: string;
}

/** Last path segment — a root's display label. Tolerates trailing / both separators. */
export function folderName(path: string): string {
  const parts = path.split(/[/\\]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * The workspace dropdown's options: the primary root first, then the multi-root
 * list (`workspaceRoots`), deduped, nulls dropped. Including `workspaceRoot` (the
 * primary) is what lets a search work with no agents/browse roots open at all.
 */
export function workspaceOptions(primary: string | null, roots: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of [primary, ...roots]) {
    if (path && !seen.has(path)) {
      seen.add(path);
      out.push(path);
    }
  }
  return out;
}

/**
 * The absolute root a search runs against: the workspace itself for the "Whole
 * workspace" choice (`folder === ""`), else `workspace/folder` in the workspace's own
 * separator (`C:\repo\src` on Windows). Null when no workspace is open — the overlays
 * render "Open a folder to search." for that.
 */
export function scopeRootOf(value: ScopeValue): string | null {
  if (!value.workspace) return null;
  return value.folder === "" ? value.workspace : joinPath(value.workspace, value.folder);
}

/**
 * A plain terminal's cwd, for `contextPath`: the directory Rust actually opened
 * its PTY in (`TerminalMeta.cwd`), or null before the PTY has opened. The spawn
 * cwd, not a live `cd` — the shell's current directory is not tracked anywhere.
 */
const terminalCwd: TerminalCwdLookup = (id) => {
  const meta = getTerminalMeta(id);
  return meta ? meta.cwd : null;
};

/**
 * The last focused tab that could name a folder (`ContextMemory`), kept current
 * by a module-level store subscription — it has to see focus moves made while
 * BOTH overlays are closed, which is exactly when no `useScope` selector runs.
 * Never written to the store; validated against the live tabs on every read.
 */
let contextMemory: ContextMemory | null = rememberContextTab(null, useAppStore.getState());
useAppStore.subscribe((s) => {
  contextMemory = rememberContextTab(contextMemory, s);
});

/**
 * The scope state both overlays share. Holds the *user's* scope (workspace null
 * until they touch it), resolves the DEFAULT workspace from the store, and hands
 * back the effective value + its resolved root.
 *
 * The default is the CONTEXT workspace (from a gazelle file or a gazelle
 * terminal, the search should cover gazelle): the open root that
 * owns the focused tab's file / terminal cwd, else the last such tab, else the
 * last file tab (`contextRoot`), falling back to the first open root (the
 * primary) when none of them is inside an open root. The first `setScope` — which
 * always carries a concrete workspace, since `value` did — pins the user's choice
 * over it.
 *
 * `open` is the overlay's visibility. The context root is resolved ONCE per open,
 * on the closed → open edge, and held for as long as the overlay stays open: the
 * overlay has no backdrop, so clicking another pane (or an agent's cwd arriving)
 * while it is up must not silently switch the Workspace dropdown and restart the
 * search under a different root. The same edge drops the user's pinned choice, so
 * a FRESH open follows the context again — an explicit pick lasts until the
 * overlay closes, never into the next search from somewhere else. (Both overlays
 * stay mounted while closed, so without this a pick from an hour ago would still
 * win.) While closed the hook resolves nothing at all — its store selector is a
 * constant — so two hidden overlays cost nothing per store update. Callers that
 * are always visible pass nothing and resolve once, on mount.
 */
export interface Scope {
  scope: ScopeValue;
  effectiveScope: ScopeValue;
  /**
   * The single resolved root — kept for callers where one value is convenient.
   * Null when no workspace is open OR when "All workspaces" is chosen (there is
   * no single root to name then; the overlays iterate `scopeRoots` instead).
   */
  scopeRoot: string | null;
  /**
   * The roots a search fans out over: every open root under "All workspaces",
   * else the one resolved root (empty when none is open). The overlays run one
   * search per entry in parallel and merge.
   */
  scopeRoots: string[];
  /** True when the scope is `ALL_WORKSPACES` — search across every open root. */
  isAll: boolean;
  setScope: (value: ScopeValue) => void;
}

const UNPINNED: ScopeValue = { workspace: null, folder: "" };

export function useScope(open = true): Scope {
  const workspaceRoot = useAppStore((s) => s.workspaceRoot);
  const rootAgentIds = useAppStore((s) => s.rootAgentIds);
  const agents = useAppStore((s) => s.agents);
  const browseRoots = useAppStore((s) => s.browseRoots);

  // Every open root (primary + the multi-root union) — the "All workspaces" set,
  // and the options the context default is chosen from.
  const allRoots = useMemo(
    () => workspaceOptions(workspaceRoot, workspaceRoots({ rootAgentIds, agents, browseRoots })),
    [workspaceRoot, rootAgentIds, agents, browseRoots],
  );

  const [scope, setScope] = useState<ScopeValue>(UNPINNED);
  // The context root this open started with — `undefined` while closed (or not
  // yet taken), `{ root }` once taken; `root` is null when no context root exists.
  const [opened, setOpened] = useState<{ root: string | null } | undefined>(undefined);
  const resolving = open && opened === undefined;
  // Live only on the edge render: a primitive (a root or null), and a constant
  // null the rest of the time, so nothing re-renders off it while open or closed.
  const contextNow = useAppStore((s) =>
    resolving ? contextRoot(allRoots, s, terminalCwd, contextMemory) : null,
  );
  // Snapshot + unpin on the closed → open edge, forget on close. Adjusting state
  // while rendering (React's "storing information from previous renders"
  // pattern) rather than in an effect, so the very first frame of the opened
  // overlay already shows the context workspace instead of flashing a stale one.
  if (resolving) {
    setOpened({ root: contextNow });
    setScope(UNPINNED);
  } else if (!open && opened !== undefined) {
    setOpened(undefined);
  }
  const openedWith = resolving ? contextNow : (opened?.root ?? null);
  // A snapshot whose root has since been closed is dropped, never searched.
  const defaultWorkspace =
    (openedWith !== null && allRoots.includes(openedWith) ? openedWith : null) ??
    allRoots[0] ??
    null;

  const effectiveScope: ScopeValue = {
    workspace: scope.workspace ?? defaultWorkspace,
    folder: scope.folder,
  };

  const isAll = effectiveScope.workspace === ALL_WORKSPACES;
  const scopeRoot = isAll ? null : scopeRootOf(effectiveScope);
  // Memoized so its reference is stable while the set is unchanged — the overlays
  // list it in a debounced effect's deps, and a fresh array each render would
  // re-fire the search every render.
  const scopeRoots = useMemo(
    () => (isAll ? allRoots : scopeRoot ? [scopeRoot] : []),
    [isAll, allRoots, scopeRoot],
  );

  return { scope, effectiveScope, scopeRoot, scopeRoots, isAll, setScope };
}

export function ScopeSelector({
  value,
  onChange,
}: {
  value: ScopeValue;
  onChange: (value: ScopeValue) => void;
}): React.JSX.Element {
  // The workspace list — the primary root plus the multi-root union.
  const workspaceRoot = useAppStore((s) => s.workspaceRoot);
  const rootAgentIds = useAppStore((s) => s.rootAgentIds);
  const agents = useAppStore((s) => s.agents);
  const browseRoots = useAppStore((s) => s.browseRoots);
  const options = useMemo(
    () => workspaceOptions(workspaceRoot, workspaceRoots({ rootAgentIds, agents, browseRoots })),
    [workspaceRoot, rootAgentIds, agents, browseRoots],
  );

  // The selected workspace's immediate subfolders (the Folder dropdown). Reloaded
  // whenever the workspace changes; a superseded/failed read (or no workspace)
  // leaves it empty (a calm "Whole workspace only", never a crash), guarded by
  // `cancelled`. No workspace reads no directory — it resolves to [] directly, so
  // the state update stays on the async path (never synchronous in the effect).
  const [subdirs, setSubdirs] = useState<FsEntry[]>([]);
  useEffect(() => {
    // "All workspaces" reads no directory (its Folder box is locked to "All").
    const ws = value.workspace === ALL_WORKSPACES ? null : value.workspace;
    let cancelled = false;
    const settle = (dirs: FsEntry[]) => {
      if (!cancelled) setSubdirs(dirs);
    };
    const load = ws ? readDir(ws) : Promise.resolve<FsEntry[]>([]);
    load.then(
      (entries) => settle(entries.filter((e) => e.isDir)),
      () => settle([]),
    );
    return () => {
      cancelled = true;
    };
  }, [value.workspace]);

  // "All workspaces" locks the Folder box (there is no one subfolder across many
  // repos), showing a single disabled "All".
  const isAll = value.workspace === ALL_WORKSPACES;

  return (
    <div className="find-scope">
      <select
        className="find-scope__select"
        aria-label="Search workspace"
        value={value.workspace ?? ""}
        onChange={(e) => onChange({ workspace: e.target.value || null, folder: "" })}
      >
        {options.length === 0 ? (
          <option value="">No folder open</option>
        ) : (
          <>
            {/* First, before the individual roots: the fan-out over every root. */}
            <option value={ALL_WORKSPACES}>All workspaces</option>
            {options.map((path) => (
              <option key={path} value={path}>
                {folderName(path)}
              </option>
            ))}
          </>
        )}
      </select>
      <select
        className="find-scope__select"
        aria-label="Search folder"
        value={value.folder}
        disabled={isAll}
        onChange={(e) => onChange({ workspace: value.workspace, folder: e.target.value })}
      >
        {isAll ? (
          <option value="">All</option>
        ) : (
          <>
            <option value="">Whole workspace</option>
            {subdirs.map((dir) => (
              <option key={dir.path} value={dir.name}>
                {dir.name}
              </option>
            ))}
          </>
        )}
      </select>
    </div>
  );
}
