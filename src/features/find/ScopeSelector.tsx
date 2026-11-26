/** The shared Workspace + Folder scope picker for both find overlays. Controlled: the parent owns
 * the scope; the store only feeds the dropdown options. `useScope` below is the shared wiring. */

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

/** "All workspaces": search every open root. The leading space keeps it from colliding with a
 * real path; it locks the Folder box to "All". */
export const ALL_WORKSPACES = " all";

/** The scope the overlays search under: a workspace root + an optional subfolder. */
export interface ScopeValue {
  /** Absolute workspace root, `ALL_WORKSPACES`, or null until one is open. */
  workspace: string | null;
  /** A subfolder NAME under `workspace`, or "" for the whole workspace. */
  folder: string;
}

/** Last path segment — a root's display label. Tolerates trailing / both separators. */
export function folderName(path: string): string {
  const parts = path.split(/[/\\]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** Primary root first, then `workspaceRoots`, deduped. The primary lets search work with no other
 * roots open. */
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

/** The workspace, or `workspace/folder` in its own separator; null with no workspace open. */
export function scopeRootOf(value: ScopeValue): string | null {
  if (!value.workspace) return null;
  return value.folder === "" ? value.workspace : joinPath(value.workspace, value.folder);
}

/** A plain terminal's PTY spawn cwd (`TerminalMeta.cwd`), null before it opens; a live `cd` is
 * not tracked. */
const terminalCwd: TerminalCwdLookup = (id) => {
  const meta = getTerminalMeta(id);
  return meta ? meta.cwd : null;
};

/** Last focused tab that could name a folder. A module-level subscription, so it sees focus moves
 * while both overlays are closed; validated against the live tabs on every read. */
let contextMemory: ContextMemory | null = rememberContextTab(null, useAppStore.getState());
useAppStore.subscribe((s) => {
  contextMemory = rememberContextTab(contextMemory, s);
});

/** Shared scope state. Defaults to the open root owning the focused tab (else the last such tab,
 * else the primary), resolved once per closed→open edge so clicks elsewhere never switch it; that
 * edge also drops the user's pick. Closed, it resolves nothing. Without `open`: once, on mount. */
export interface Scope {
  scope: ScopeValue;
  effectiveScope: ScopeValue;
  /** One resolved root; null with no workspace or under "All workspaces" (see `scopeRoots`). */
  scopeRoot: string | null;
  /** Roots a search fans out over (one search each, in parallel): all open roots, or the one. */
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
  // Adjusted during render, not in an effect, so the first open frame already shows the context
  // workspace.
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

  // Reloaded per workspace; a superseded/failed read leaves it empty (guarded by `cancelled`). No
  // workspace resolves [] asynchronously, so the effect never sets state synchronously.
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
