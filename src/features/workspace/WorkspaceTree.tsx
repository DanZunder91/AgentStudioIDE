/** The right rail's multi-root file tree: one root per unique folder (agent cwds + browse roots),
 * lazy cached reads, inline mutations and confirms (no native dialogs), Git and Open in Browser
 * submenus. The highlight follows `activeFilePath`; only the crosshair expands and scrolls. */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent,
} from "react";

import { open } from "@tauri-apps/plugin-dialog";

import { ContextMenu, type ContextMenuItem } from "../../components/ContextMenu";
import { ChevronIcon, CloseIcon, FileIcon, FolderIcon } from "../../components/icons";
import { InlineEditInput } from "../../components/InlineEditInput";
// Aliased: components/icons' `FileIcon` is the generic glyph (inline-create row); this is the
// colored per-file icon (file-icons.md §3). Folder rows keep `FolderIcon` + role colors.
import { FileIcon as FileTypeIcon } from "../../lib/fileIcons";
import { relativeTo, samePath } from "../../lib/paths";
import { ancestorDirsWithin } from "../../app/revealPath";
import { activeFilePath, useAppStore, workspaceRoots } from "../../app/store";
import type { FsEntry } from "../../app/types";
// The git feature's barrel: the tree consumes the store + its two
// pure selectors for row decoration, starts the shared status poll, and (since
// the Git submenu) calls `git_file_restore` for a confirmed revert.
import {
  dirsWithChanges,
  fileStatusMap,
  gitFileRestore,
  startGitPolling,
  useGitStore,
} from "../git";
// `reloadFromDisk` re-reads a reverted file into any open buffer (Cmd+Z can still undo it).
// `opensInExternalBrowser` is the preview's own predicate via the barrel: no second extension
// table.
import { opensInExternalBrowser, reloadFromDisk } from "../editor";
// The diagnostics log (bridge.ts's idiom): the inline note is what the user
// reads, and this is what survives in the Logs panel with Rust's error code on it.
import { logError, logWarn } from "../logs";
import {
  cachedBrowsers,
  openInBrowser,
  primeBrowsers,
  type BrowserChoice,
} from "./browserIpc";
import { folderRole } from "./folderSemantics";
import {
  basename,
  createDirectory,
  createFile,
  deletePath,
  joinPath,
  parentPath,
  readDir,
  renamePath,
} from "./workspaceIpc";
import "./workspace.css";

const INDENT = 14; // px per depth level

/** The root read can race the cwd's registration into `read_dir`'s scope and 403, so it retries a
 * few times on "Loading…" before conceding. Nested reads follow user expands and never race. */
export const ROOT_READ_TRIES = 4;
export const ROOT_READ_RETRY_MS = 120;

/** Drag payload for reordering a root folder (its absolute path); distinct from `TAB_DND_MIME` so
 * tab and folder drags never accept each other. The drop uses the left rail's `moveFolder`. */
export const FOLDER_DND_MIME = "application/x-agentstudio-ws-folder";

/** Drag payload for moving an entry within one root; distinct from `FOLDER_DND_MIME` so each drop
 * target accepts only its own drag. */
export const ENTRY_DND_MIME = "application/x-agentstudio-ws-entry";

/** A create-at-root request forwarded from the OUTER header button to the INNER
 *  listing (which owns children + reload). `token` bumps on every click so the
 *  inner `useEffect` re-fires even for the same `kind`. */
type RootCreateSignal = { kind: "file" | "dir"; token: number };

/** The row currently swapped for an inline confirm, and which irreversible act
 *  it is asking about. One state for both — see `<WorkspaceTreeView>`'s
 *  `confirming`. */
type ConfirmRequest = { path: string; kind: "delete" | "revert" };

/** Last path segment — the root header label. Tolerates trailing separators and
 *  both separators, matching the rail's folder grouping (fleet/flatten.ts). */
function folderName(path: string): string {
  const parts = path.split(/[/\\]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** Directories first, then files; each group alphabetical. Stable, own copy. */
function sortEntries(entries: FsEntry[]): FsEntry[] {
  return [...entries].sort((a, b) =>
    a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name),
  );
}

/** A short, human message from a rejected IPC — surfaced calmly inline. */
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** `p` re-based from `oldBase` onto `newBase` if at/under it, else null; keeps open editor tabs on
 * the right path after a rename/move. Separator- and (Windows) case-insensitive. */
function repathUnder(p: string, oldBase: string, newBase: string): string | null {
  const rel = relativeTo(oldBase, p);
  if (rel === null) return null;
  return rel === "" ? newBase : joinPath(newBase, rel);
}

/* Small inline icons for the row affordances. icons.tsx owns the shared set; these
 * live here (same `currentColor` stroke look) so the Files feature is
 * self-contained. */
const iconAttrs = (size: number) =>
  ({
    width: size,
    height: size,
    viewBox: "0 0 16 16",
    fill: "none" as const,
    stroke: "currentColor",
    strokeWidth: 1.25,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    focusable: false,
  }) as const;

function PencilIcon({ size = 12 }: { size?: number }) {
  return (
    <svg {...iconAttrs(size)}>
      <path d="M10.5 2.5l3 3-8 8H2.5v-3z" />
      <path d="M9 4l3 3" />
    </svg>
  );
}

function TrashIcon({ size = 12 }: { size?: number }) {
  return (
    <svg {...iconAttrs(size)}>
      <path d="M2.5 4.5h11M6 4.5V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5" />
      <path d="M4 4.5l.6 8.5a1 1 0 0 0 1 .9h4.8a1 1 0 0 0 1-.9L12 4.5" />
    </svg>
  );
}

function NewFileIcon({ size = 12 }: { size?: number }) {
  return (
    <svg {...iconAttrs(size)}>
      <path d="M9 1.5H4.5A1.5 1.5 0 0 0 3 3v10a1.5 1.5 0 0 0 1.5 1.5h7A1.5 1.5 0 0 0 13 13V5.5z" />
      <path d="M9 1.5V5a.5.5 0 0 0 .5.5H13" />
      <path d="M8 8v3.5M6.25 9.75h3.5" />
    </svg>
  );
}

function NewFolderIcon({ size = 12 }: { size?: number }) {
  return (
    <svg {...iconAttrs(size)}>
      <path d="M1.75 12.5V4a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1z" />
      <path d="M8 7v4M6 9h4" />
    </svg>
  );
}

/** Refresh: a circular arrow with its head at the top right. */
function RefreshIcon({ size = 12 }: { size?: number }) {
  return (
    <svg {...iconAttrs(size)}>
      <path d="M13.25 8A5.25 5.25 0 1 1 11.7 4.3" />
      <path d="M12.25 1.75v3h-3" />
    </svg>
  );
}

/** IntelliJ's "Select Opened File" crosshair: a circle + 4 ticks. */
function CrosshairIcon({ size = 13 }: { size?: number }) {
  return (
    <svg {...iconAttrs(size)}>
      <circle cx="8" cy="8" r="4.25" />
      <path d="M8 1.25v2.5M8 12.25v2.5M1.25 8h2.5M12.25 8h2.5" />
    </svg>
  );
}

export function WorkspaceTree(): React.JSX.Element {
  // Derive the roots from three stable store slices via `useMemo`: pure, and referentially stable
  // across renders that changed nothing structural.
  const rootAgentIds = useAppStore((s) => s.rootAgentIds);
  const agents = useAppStore((s) => s.agents);
  const browseRoots = useAppStore((s) => s.browseRoots);
  // The shared folder order: the SAME list the left (Agents) rail sorts
  // by, so passing it into `workspaceRoots` makes the Files rail match the Agents
  // rail, and a folder drag in either rail (both call `moveFolder`) moves the other.
  const folderOrder = useAppStore((s) => s.folderOrder);
  const addBrowseRoot = useAppStore((s) => s.workspaceActions.addBrowseRoot);
  const removeBrowseRoot = useAppStore((s) => s.workspaceActions.removeBrowseRoot);
  const moveFolder = useAppStore((s) => s.workspaceActions.moveFolder);
  // Reveal-active-file: the crosshair's disabled rule derives from the
  // SAME selector the action itself applies (`activeFilePath`), so the button and
  // `revealActiveFile` can never disagree about "is there a file to reveal".
  const revealPath = useAppStore((s) => activeFilePath(s));
  const revealActiveFile = useAppStore((s) => s.uiActions.revealActiveFile);

  const roots = useMemo(
    () => workspaceRoots({ rootAgentIds, agents, browseRoots, folderOrder }),
    [rootAgentIds, agents, browseRoots, folderOrder],
  );
  // A root is closeable exactly when it is NOT an agent cwd — i.e. it exists only
  // because the user opened it (browse-only). An agent-cwd root has no ✕: it lives
  // while its agent does.
  const agentCwds = useMemo(
    () => new Set(rootAgentIds.map((id) => agents[id]?.cwd).filter(Boolean)),
    [rootAgentIds, agents],
  );

  // From the STORE so collapse survives a restart (persisted); absence means expanded.
  const collapsedRoots = useAppStore((s) => s.collapsedRoots);
  const toggleRoot = useAppStore((s) => s.workspaceActions.toggleRootCollapsed);

  // The folder-drag drop target: the root path currently hovered by a
  // folder drag, or null. Drives the calm drop indicator; cleared on drop/leave.
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  // The header's create buttons forward a bumped token to the root's `<WorkspaceTreeView>`, which
  // owns the children cache and opens the inline create row.
  const [rootCreate, setRootCreate] = useState<{ root: string; kind: "file" | "dir"; token: number } | null>(
    null,
  );
  const tokenRef = useRef(0);

  // Refresh: listings are cached, so outside changes need it. Token-forwarded per root like create;
  // a collapsed root needs nothing (expanding remounts and reads fresh).
  const [rootRefresh, setRootRefresh] = useState<Record<string, number>>({});
  const refreshRoot = (root: string): void => {
    tokenRef.current += 1;
    const token = tokenRef.current;
    setRootRefresh((prev) => ({ ...prev, [root]: token }));
    // Row colors + folder dots come from git status, which is just as stale.
    void useGitStore.getState().refreshGitStatus();
  };
  const startRootCreate = (root: string, kind: "file" | "dir"): void => {
    // Expand the root first if collapsed, so its `<WorkspaceTreeView>` is mounted to
    // receive the signal (a collapsed root renders no inner listing).
    if (collapsedRoots.has(root)) toggleRoot(root);
    tokenRef.current += 1;
    setRootCreate({ root, kind, token: tokenRef.current });
  };

  // Root-header menu, out here because headers show while collapsed. New File/Folder only: Rust
  // rejects renaming or deleting a root. ContextMenu's outside listeners keep one menu open at
  // once.
  const [headerMenu, setHeaderMenu] = useState<{ x: number; y: number; root: string } | null>(null);

  // Git status polling while mounted (row colors, folder dots); refcounted, idempotent stop.
  useEffect(() => startGitPolling(), []);

  // Prime the session's one browser enumeration so the menu builds synchronously; idempotent, never
  // rejects (no enumeration still gets the "system default" leaf).
  useEffect(() => {
    void primeBrowsers();
  }, []);

  /* A reveal under no open root would only flip the rail to Files, so say so instead. Seen-once by
   * token, adjusted during render; a later reveal that lands clears the note. */
  const fileReveal = useAppStore((s) => s.fileReveal);
  const [seenReveal, setSeenReveal] = useState(0);
  const [unrootedReveal, setUnrootedReveal] = useState<string | null>(null);
  if (fileReveal !== null && fileReveal.token !== seenReveal) {
    setSeenReveal(fileReveal.token);
    setUnrootedReveal(fileReveal.root === null ? fileReveal.path : null);
  }
  useEffect(() => {
    if (unrootedReveal === null) return;
    logWarn("files", `Reveal: ${unrootedReveal} is not inside any open folder`);
  }, [unrootedReveal]);

  const openHeaderMenu = (e: MouseEvent, root: string): void => {
    e.preventDefault(); // suppress the OS/webview menu
    setHeaderMenu({ x: e.clientX, y: e.clientY, root });
  };

  const folderDragAccepts = (e: DragEvent): boolean =>
    e.dataTransfer.types.includes(FOLDER_DND_MIME);

  const onRootDragStart = (e: DragEvent, path: string): void => {
    e.dataTransfer.setData(FOLDER_DND_MIME, path);
    e.dataTransfer.effectAllowed = "move";
  };

  const onRootDragOver = (e: DragEvent, path: string): void => {
    if (!folderDragAccepts(e)) return; // ignore tab drags / anything else
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDropTarget(path);
  };

  const onRootDragLeave = (e: DragEvent): void => {
    // Ignore bubbling from the header's own children (caret/name/✕): only clear
    // when the pointer actually leaves this header.
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDropTarget(null);
  };

  const onRootDrop = (e: DragEvent, path: string): void => {
    if (!folderDragAccepts(e)) return;
    e.preventDefault();
    setDropTarget(null);
    const dragged = e.dataTransfer.getData(FOLDER_DND_MIME);
    // Dropping a folder onto itself is a no-op; otherwise move it before the target.
    if (dragged && dragged !== path) moveFolder(dragged, path);
  };

  /** What the crosshair promises — and, when it is disabled, why it is. */
  const revealHint =
    revealPath === null
      ? "No file is open — nothing to reveal"
      : `Reveal ${basename(revealPath)} in tree`;

  // The picker → a browse-only root. Copy of LeftRail.openProject's picker call;
  // `addBrowseRoot` also authorizes the folder for `read_dir` (see the store).
  const openFolder = async () => {
    const dir = await open({ directory: true, multiple: false });
    if (typeof dir !== "string") return; // cancelled, or a multi-select array
    addBrowseRoot(dir);
  };

  if (roots.length === 0) {
    return (
      <div className="workspace-tree workspace-tree--empty" data-testid="workspace-tree">
        <p className="workspace-tree__hint">No folder open.</p>
        <button
          type="button"
          className="workspace-tree__open"
          aria-label="Open a folder"
          onClick={() => void openFolder()}
        >
          Open a folder
        </button>
      </div>
    );
  }

  return (
    <div className="workspace-tree" data-testid="workspace-tree">
      {/* The crosshair is disabled only with no file tab open (`activeFilePath`). Its reason
          rides on a never-disabled wrapper's `title`; one `revealHint` serves both. */}
      <div className="workspace-tree__toolbar">
        <span className="workspace-tree__tool-slot" title={revealHint}>
          <button
            type="button"
            className="workspace-tree__tool"
            aria-label="Reveal active file"
            title={revealHint}
            disabled={revealPath === null}
            onClick={() => revealActiveFile()}
          >
            <CrosshairIcon size={13} />
          </button>
        </span>
      </div>
      {unrootedReveal !== null && (
        <p className="workspace-tree__note workspace-tree__note--error" role="alert">
          {basename(unrootedReveal)} isn&rsquo;t inside any open folder — open its
          folder to see it here.
        </p>
      )}
      {roots.map((root) => {
        const isCollapsed = collapsedRoots.has(root);
        const name = folderName(root);
        const headerClass = `workspace-root__header${
          dropTarget === root ? " is-drop-target" : ""
        }`;
        const createSignal: RootCreateSignal | null =
          rootCreate && rootCreate.root === root
            ? { kind: rootCreate.kind, token: rootCreate.token }
            : null;
        return (
          <div className="workspace-root" key={root}>
            <div
              className={headerClass}
              data-testid="workspace-root"
              data-path={root}
              title={root}
              draggable
              onDragStart={(e) => onRootDragStart(e, root)}
              onDragOver={(e) => onRootDragOver(e, root)}
              onDragLeave={onRootDragLeave}
              onDrop={(e) => onRootDrop(e, root)}
              onClick={() => toggleRoot(root)}
              onContextMenu={(e) => openHeaderMenu(e, root)}
            >
              <span className={`workspace-root__caret${isCollapsed ? "" : " is-open"}`}>
                <ChevronIcon size={11} />
              </span>
              <span className="workspace-root__name">{name}</span>
              <span className="workspace-root__actions">
                <button
                  type="button"
                  className="workspace-root__action"
                  aria-label={`New file in ${name}`}
                  title="New file"
                  onClick={(e) => {
                    e.stopPropagation(); // create must not toggle the caret
                    startRootCreate(root, "file");
                  }}
                >
                  <NewFileIcon size={12} />
                </button>
                <button
                  type="button"
                  className="workspace-root__action"
                  aria-label={`New folder in ${name}`}
                  title="New folder"
                  onClick={(e) => {
                    e.stopPropagation();
                    startRootCreate(root, "dir");
                  }}
                >
                  <NewFolderIcon size={12} />
                </button>
                <button
                  type="button"
                  className="workspace-root__action"
                  aria-label={`Refresh ${name}`}
                  title="Refresh"
                  onClick={(e) => {
                    e.stopPropagation();
                    refreshRoot(root);
                  }}
                >
                  <RefreshIcon size={12} />
                </button>
                {!agentCwds.has(root) && (
                  <button
                    type="button"
                    className="workspace-root__close"
                    aria-label={`Close folder ${name}`}
                    title="Close folder"
                    onClick={(e) => {
                      e.stopPropagation(); // closing must not also toggle the caret
                      removeBrowseRoot(root);
                    }}
                  >
                    <CloseIcon size={11} />
                  </button>
                )}
              </span>
            </div>
            {/* key={root} gives each root its own lazy-load + selection state, so a
                new root never disturbs another's expand tree. */}
            {!isCollapsed && (
              <WorkspaceTreeView
                key={root}
                root={root}
                createSignal={createSignal}
                refreshToken={rootRefresh[root] ?? 0}
              />
            )}
          </div>
        );
      })}
      {headerMenu && (
        <ContextMenu
          x={headerMenu.x}
          y={headerMenu.y}
          ariaLabel={`Actions for ${folderName(headerMenu.root)}`}
          onClose={() => setHeaderMenu(null)}
          items={[
            { label: "New File", onSelect: () => startRootCreate(headerMenu.root, "file") },
            { label: "New Folder", onSelect: () => startRootCreate(headerMenu.root, "dir") },
            { label: "Refresh", onSelect: () => refreshRoot(headerMenu.root) },
          ]}
        />
      )}
    </div>
  );
}

function WorkspaceTreeView({
  root,
  createSignal,
  refreshToken,
}: {
  root: string;
  createSignal: RootCreateSignal | null;
  refreshToken: number;
}): React.JSX.Element {
  // All keyed by absolute path. `children` doubles as the "loaded" marker: a
  // present entry (even []) means read; absent means not yet read.
  const [children, setChildren] = useState<Record<string, FsEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [failed, setFailed] = useState<Set<string>>(new Set());
  /* The highlight is DERIVED from the store, never local state (per-root state died on collapse).
   * It follows the active file tab, so rename, move and delete need no code of their own. */
  const selected = useAppStore((s) => activeFilePath(s));
  // Mutation UI state. `confirming` carries a KIND: delete and revert share one confirm mechanism,
  // so two near-identical prompts can never be open at once.
  const [creating, setCreating] = useState<{ parent: string; kind: "file" | "dir" } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<ConfirmRequest | null>(null);
  const [entryDrop, setEntryDrop] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Row (or root-space, `entry` null) context menu; items reuse the hover buttons' handlers.
  const [menu, setMenu] = useState<{ x: number; y: number; entry: FsEntry | null } | null>(null);

  // Git decoration for THIS subtree (headers don't use it); both lookups use absolute paths,
  // matching each row's `data-path`.
  const gitStatus = useGitStore((s) => s.status);
  const gitFiles = useMemo(() => fileStatusMap(gitStatus), [gitStatus]);
  const gitDirs = useMemo(() => dirsWithChanges(gitStatus), [gitStatus]);
  /** Only `not-a-repo` means "no git here"; a transient git error keeps the last good changes and
   * must NOT grey out the menu. */
  const notARepo = gitStatus[root]?.error?.code === "not-a-repo";

  // Clicking a file highlights it here AND opens it in the center editor.
  // `openEditorTab` dedupes by path, so re-clicking reuses the tab.
  const openEditorTab = useAppStore((s) => s.layoutActions.openEditorTab);
  // Git ▸ Compare with HEAD. Deduped by path in the store, so comparing the same
  // file twice re-focuses the one diff tab.
  const openDiffTab = useAppStore((s) => s.layoutActions.openDiffTab);
  // Rename/move closes the stale tab and reopens it at the new path: `renameTab` only relabels and
  // cannot re-point `ref.path`.
  const closeTab = useAppStore((s) => s.layoutActions.closeTab);

  /** Reads `path` into the children cache (first expand and post-mutation refresh); true when the
   * listing landed, false when it failed (joins `failed`). The reveal walk awaits it. */
  const load = useCallback(async (path: string): Promise<boolean> => {
    try {
      const entries = await readDir(path);
      setChildren((prev) => ({ ...prev, [path]: sortEntries(entries) }));
      return true;
    } catch {
      setFailed((prev) => new Set(prev).add(path));
      return false;
    }
  }, []);

  // Root loads on mount (keyed by root, so a re-root remounts) and RETRIES (see ROOT_READ_TRIES);
  // nested reads do not.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let tries = 0;
    const attempt = (): void => {
      readDir(root).then(
        (entries) => {
          if (!cancelled) setChildren((prev) => ({ ...prev, [root]: sortEntries(entries) }));
        },
        () => {
          if (cancelled) return;
          tries += 1;
          if (tries < ROOT_READ_TRIES) timer = setTimeout(attempt, ROOT_READ_RETRY_MS);
          else setFailed((prev) => new Set(prev).add(root));
        },
      );
    };
    attempt();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [root]);

  // Header refresh: re-read the root and EXPANDED folders in place; drop collapsed ones from the
  // cache. The mount token counts as handled, and a ref (not state) makes StrictMode's re-run a
  // no-op.
  const refreshSeenRef = useRef(refreshToken);
  const expandedRef = useRef(expanded);
  useEffect(() => {
    expandedRef.current = expanded;
  }, [expanded]);
  useEffect(() => {
    if (refreshToken === refreshSeenRef.current) return;
    refreshSeenRef.current = refreshToken;
    const dirs = [root, ...[...expandedRef.current].filter((d) => d !== root)];
    void Promise.all(
      dirs.map((dir) =>
        readDir(dir).then(
          (entries) => [dir, sortEntries(entries)] as const,
          () => null,
        ),
      ),
    ).then((results) => {
      const next: Record<string, FsEntry[]> = {};
      for (const r of results) if (r) next[r[0]] = r[1];
      setChildren(next);
      setFailed(root in next ? new Set() : new Set([root]));
    });
  }, [refreshToken, root]);

  // A create-at-root signal (token bumps per click) opens an inline row under `root`; handled
  // during render by comparing the token to state (React's previous-render pattern), no effect.
  const [seenToken, setSeenToken] = useState<number | undefined>(undefined);
  if (createSignal && createSignal.token !== seenToken) {
    setSeenToken(createSignal.token);
    setCreating({ parent: root, kind: createSignal.kind });
    setError(null);
  }

  /* ── reveal active file ── Consume the one-shot `fileReveal` under THIS root: expand the
   * ancestors via the shared `load` cache, then scroll (the highlight is derived). Token claimed
   * up front; a fresh mount starts at 0 so an un-collapsed root takes its own reveal. */
  const fileReveal = useAppStore((s) => s.fileReveal);
  // A ref, not state: consuming a token must not itself re-render.
  const revealSeenRef = useRef(0);
  // Mirrors of the cache for the async walk — it awaits between steps, so a
  // render-time closure would go stale mid-walk. Synced after every commit,
  // BEFORE the reveal effect below runs (effects fire in declaration order).
  const childrenRef = useRef(children);
  const failedRef = useRef(failed);
  useEffect(() => {
    childrenRef.current = children;
    failedRef.current = failed;
  }, [children, failed]);
  // The completed reveal awaiting its scroll — token'd so revealing the SAME
  // path again still re-fires the effect. The row is found by its `data-path`
  // attribute (attribute-equality scan: no CSS escaping of arbitrary paths).
  const [revealDone, setRevealDone] = useState<{ path: string; token: number } | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  useEffect(() => {
    if (fileReveal === null || fileReveal.token === revealSeenRef.current) return;
    // Claim the token up front so a finished walk never re-runs, but hand it back if torn down
    // early: StrictMode's setup → cleanup → setup keeps this ref, and a lost token made the reveal
    // a no-op in `tauri dev` only.
    const previousToken = revealSeenRef.current;
    revealSeenRef.current = fileReveal.token;
    let walked = false;
    const target = fileReveal.path;
    const chain = ancestorDirsWithin(root, target);
    // Not under THIS root — another subtree's request, or nobody's. It returns
    // with no cleanup, so the claim stands: there is nothing here to redo.
    if (chain === null) return;
    let cancelled = false;
    void (async () => {
      for (const dir of chain) {
        if (failedRef.current.has(dir)) return; // known-unreadable → stop calmly
        // Cached dirs are reused (never re-read); a fresh read failing joins
        // `failed` inside `load` and ends the walk — calm, the rail stays up.
        const ok = dir in childrenRef.current || (await load(dir));
        if (!ok || cancelled) return;
        setExpanded((prev) => (prev.has(dir) ? prev : new Set(prev).add(dir)));
      }
      // Every await above has its own `!ok || cancelled` bail-out and nothing suspends after the
      // last, so no guard here. The row is already lit (derived highlight); the scroll effect takes
      // over.
      walked = true;
      setRevealDone({ path: target, token: fileReveal.token });
    })();
    return () => {
      cancelled = true; // a newer reveal (or unmount) supersedes this walk
      // An unfinished walk handled nothing: hand the token back for StrictMode's re-run (a genuine
      // remount gets a fresh ref at 0).
      if (!walked) revealSeenRef.current = previousToken;
    };
  }, [fileReveal, root, load]);

  useEffect(() => {
    if (revealDone === null) return;
    // The <ul> always mounts with this subtree, so the ref is attached; the cast records that (if
    // the <ul> ever becomes conditional, every reveal test fails here).
    const list = listRef.current as HTMLUListElement;
    for (const el of Array.from(list.querySelectorAll("[data-path]"))) {
      if (el.getAttribute("data-path") === revealDone.path) {
        // Optional-call: jsdom ships no scrollIntoView; the browser does.
        el.scrollIntoView?.({ block: "nearest" });
        break;
      }
    }
  }, [revealDone]);

  const toggle = (path: string) => {
    const opening = !expanded.has(path);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
    // Lazy read: only on first open, and never twice for the same folder.
    if (opening && !(path in children) && !failed.has(path)) load(path);
  };

  /** Expand + lazily load `dir`, then open an inline create row under it. */
  const startCreate = (dir: string, kind: "file" | "dir"): void => {
    if (!expanded.has(dir)) {
      setExpanded((prev) => new Set(prev).add(dir));
      if (!(dir in children) && !failed.has(dir)) load(dir);
    }
    setError(null);
    setCreating({ parent: dir, kind });
  };

  const commitCreate = (parent: string, kind: "file" | "dir", name: string): void => {
    const trimmed = name.trim();
    setCreating(null);
    if (!trimmed) return; // empty/whitespace → cancel, no IPC
    setError(null);
    const target = joinPath(parent, trimmed);
    const op = kind === "dir" ? createDirectory(target) : createFile(target);
    op.then(() => {
      load(parent);
      if (kind === "file") openEditorTab(target); // open the new file straight away
    }).catch((e) => setError(errMsg(e)));
  };

  /** Close (and, if `newPath` given, reopen) every editor tab at/under `oldPath`. */
  const reconcileTabs = (oldPath: string, newPath: string | null): void => {
    const tabs = useAppStore.getState().tabs;
    for (const tab of Object.values(tabs)) {
      if (tab.ref.kind !== "editor") continue;
      const moved = repathUnder(tab.ref.path, oldPath, newPath ?? oldPath);
      if (moved === null) continue; // unrelated tab
      closeTab(tab.id);
      if (newPath !== null) openEditorTab(moved);
    }
  };

  const commitRename = (oldPath: string, name: string): void => {
    const trimmed = name.trim();
    setRenaming(null);
    if (!trimmed || trimmed === basename(oldPath)) return; // unchanged/empty → no IPC
    setError(null);
    const parent = parentPath(oldPath);
    const to = joinPath(parent, trimmed);
    renamePath(oldPath, to)
      .then(() => {
        load(parent);
        // `reconcileTabs` re-opens the editor tab at the new path, so the derived
        // highlight follows the rename with no re-pointing of its own.
        reconcileTabs(oldPath, to);
      })
      .catch((e) => setError(errMsg(e)));
  };

  const commitDelete = (path: string): void => {
    setConfirming(null);
    setError(null);
    deletePath(path)
      .then(() => {
        load(parentPath(path));
        // Closing the tab is also what un-highlights the row: `activeFilePath`
        // discards a remembered path no tab shows any more.
        reconcileTabs(path, null);
      })
      .catch((e) => setError(errMsg(e)));
  };

  /** Discards a file's working-tree changes after the inline confirm, then refreshes the listing,
   * git status and the open buffer (else its next save would restore the edits). A rejection shows
   * in the inline note, never swallowed. */
  const commitRevert = (path: string): void => {
    setConfirming(null);
    setError(null);
    gitFileRestore(path)
      .then(() => {
        load(parentPath(path));
        // Never rejects (gitStore rule 2), so nothing to catch here.
        void useGitStore.getState().refreshGitStatus();
        reloadFromDisk(path);
      })
      .catch((e) => setError(errMsg(e)));
  };

  const entryDragAccepts = (e: DragEvent): boolean =>
    e.dataTransfer.types.includes(ENTRY_DND_MIME);

  const onEntryDragStart = (e: DragEvent, path: string): void => {
    e.stopPropagation(); // an entry drag is never also a root-header drag
    e.dataTransfer.setData(ENTRY_DND_MIME, path);
    e.dataTransfer.effectAllowed = "move";
  };

  const onEntryDragOver = (e: DragEvent, dest: string, isRow: boolean): void => {
    if (!entryDragAccepts(e)) return; // ignore folder-reorder / other drags
    e.preventDefault();
    if (isRow) e.stopPropagation(); // a dir row wins over the root-list background
    e.dataTransfer.dropEffect = "move";
    setEntryDrop(dest);
  };

  const onEntryDragLeave = (e: DragEvent): void => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setEntryDrop(null);
  };

  const onEntryDrop = (e: DragEvent, dest: string, isRow: boolean): void => {
    if (!entryDragAccepts(e)) return;
    e.preventDefault();
    if (isRow) e.stopPropagation();
    setEntryDrop(null);
    moveEntry(e.dataTransfer.getData(ENTRY_DND_MIME), dest);
  };

  /** Moves `dragged` into `destDir`, skipping no-ops (already there, onto itself, into its own
   * subtree) before any IPC. Compared as paths, not strings: a drop target may be spelled `c:\w`.
   */
  const moveEntry = (dragged: string, destDir: string): void => {
    if (!dragged) return;
    if (samePath(destDir, parentPath(dragged))) return; // already in this folder
    if (relativeTo(dragged, destDir) !== null) return; // onto itself, or into its own subtree
    setError(null);
    const to = joinPath(destDir, basename(dragged));
    renamePath(dragged, to)
      .then(() => {
        load(parentPath(dragged));
        load(destDir);
        reconcileTabs(dragged, to); // …and the highlight follows the tab (see commitRename)
      })
      .catch((e) => setError(errMsg(e)));
  };

  /** The hover-revealed action buttons for an entry row. */
  const rowActions = (entry: FsEntry): React.JSX.Element => (
    <span className="workspace-node__actions">
      {entry.isDir && (
        <>
          <button
            type="button"
            className="workspace-node__action"
            aria-label={`New file in ${entry.name}`}
            title="New file"
            onClick={(e) => {
              e.stopPropagation();
              startCreate(entry.path, "file");
            }}
          >
            <NewFileIcon size={11} />
          </button>
          <button
            type="button"
            className="workspace-node__action"
            aria-label={`New folder in ${entry.name}`}
            title="New folder"
            onClick={(e) => {
              e.stopPropagation();
              startCreate(entry.path, "dir");
            }}
          >
            <NewFolderIcon size={11} />
          </button>
        </>
      )}
      <button
        type="button"
        className="workspace-node__action"
        aria-label={`Rename ${entry.name}`}
        title="Rename"
        onClick={(e) => {
          e.stopPropagation();
          setError(null);
          setRenaming(entry.path);
        }}
      >
        <PencilIcon size={11} />
      </button>
      <button
        type="button"
        className="workspace-node__action"
        aria-label={`Delete ${entry.name}`}
        title="Delete"
        onClick={(e) => {
          e.stopPropagation();
          setError(null);
          setConfirming({ path: entry.path, kind: "delete" });
        }}
      >
        <TrashIcon size={11} />
      </button>
    </span>
  );

  /** Opens the context menu at the cursor: a row passes its entry and stops propagation, empty
   * space passes `null`; `preventDefault` suppresses the webview menu. */
  const openMenu = (e: MouseEvent, entry: FsEntry | null): void => {
    e.preventDefault();
    if (entry !== null) e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, entry });
  };

  /** A FILE row's Git submenu (folders get none), gated on the status the tree already holds, so no
   * IPC: not a repo disables it all; nothing to revert to (incl. `untracked`) disables Revert
   * only. Revert only ARMS the inline confirm. */
  const gitSubmenu = (entry: FsEntry): ContextMenuItem => {
    const status = gitFiles[entry.path];
    const nothingToRevert = status === undefined || status === "untracked";
    return {
      label: "Git",
      disabled: notARepo,
      items: [
        { label: "Compare with HEAD", onSelect: () => openDiffTab(entry.path) },
        {
          label: "Revert changes…",
          danger: true,
          disabled: nothingToRevert,
          onSelect: () => {
            setError(null);
            setConfirming({ path: entry.path, kind: "revert" });
          },
        },
      ],
    };
  };

  /** Hands a file to an external browser; Rust's coded rejection goes to the inline note plus a
   * Logs line, never swallowed (a silent no-op looks like a window opened behind). */
  const openInBrowserFrom = (path: string, browserId?: string): void => {
    setError(null);
    openInBrowser(path, browserId).catch((e: unknown) => {
      const detail = errMsg(e);
      setError(`Couldn’t open ${basename(path)} in a browser. ${detail}`);
      logError("files", `open_in_browser failed for ${path}`, detail);
    });
  };

  /** Open in Browser for an `.html`/`.htm` row. `cachedBrowsers()` is read SYNCHRONOUSLY (see
   * `browserIpc.ts`); with no list, a single system-default leaf. The default appears twice when
   * known: "System default" follows the OS, the named one pins that browser. */
  const browserGroup = (entry: FsEntry): ContextMenuItem[] => {
    const list: BrowserChoice[] | null = cachedBrowsers();
    if (list === null || list.length === 0) {
      return [{ label: "Open in Browser", onSelect: () => openInBrowserFrom(entry.path) }];
    }
    const fallback = list.find((b) => b.isDefault);
    return [
      {
        label: "Open in Browser",
        items: [
          {
            // Named, so the row says where the file is actually going. Rust
            // promises at most one default, so an unnamed default is the honest
            // wording when the OS did not tell us which browser that is.
            label:
              fallback === undefined ? "System default" : `System default (${fallback.name})`,
            onSelect: () => openInBrowserFrom(entry.path),
          },
          { separator: true },
          ...list.map((b) => ({ label: b.name, onSelect: () => openInBrowserFrom(entry.path, b.id) })),
        ],
      },
    ];
  };

  /** Context-menu items via the existing create/rename/delete flows: root (create), dir (create
   * inside, Rename, Delete), file (create in parent, Git, Rename, Delete); HTML files lead with
   * Open in Browser. Delete stays last. */
  const menuItems = (entry: FsEntry | null): ContextMenuItem[] => {
    const dir = entry === null ? root : entry.isDir ? entry.path : parentPath(entry.path);
    const create: ContextMenuItem[] = [
      { label: "New File", onSelect: () => startCreate(dir, "file") },
      { label: "New Folder", onSelect: () => startCreate(dir, "dir") },
    ];
    if (entry === null) return create;
    const browser: ContextMenuItem[] =
      !entry.isDir && opensInExternalBrowser(entry.path)
        ? [...browserGroup(entry), { separator: true }]
        : [];
    const git: ContextMenuItem[] = entry.isDir
      ? []
      : [{ separator: true }, gitSubmenu(entry)];
    return [
      ...browser,
      ...create,
      ...git,
      { separator: true },
      {
        label: "Rename",
        onSelect: () => {
          setError(null);
          setRenaming(entry.path);
        },
      },
      {
        label: "Delete",
        danger: true,
        onSelect: () => {
          setError(null);
          setConfirming({ path: entry.path, kind: "delete" });
        },
      },
    ];
  };

  /** The body of a loaded/expanded folder (or the root): the inline create row (if
   *  any) plus notes vs. children. */
  const renderChildren = (path: string, depth: number): React.JSX.Element => {
    const createKind = creating && creating.parent === path ? creating.kind : null;
    const createRow = createKind ? (
      <li className="workspace-node__create" role="none" key="__create__">
        <div
          className="workspace-node workspace-node--create"
          style={{ paddingLeft: depth * INDENT + 8 }}
          data-testid="ws-create"
        >
          <span className="workspace-node__icon">
            {createKind === "dir" ? <FolderIcon size={12} /> : <FileIcon size={12} />}
          </span>
          <InlineEditInput
            value=""
            className="workspace-node__input"
            ariaLabel={createKind === "dir" ? "New folder name" : "New file name"}
            onCommit={(v) => commitCreate(path, createKind, v)}
            onCancel={() => setCreating(null)}
          />
        </div>
      </li>
    ) : null;

    let body: React.JSX.Element;
    if (failed.has(path)) {
      body = (
        <li className="workspace-tree__note" role="none">
          Can&rsquo;t read this folder.
        </li>
      );
    } else {
      const kids = children[path];
      if (kids === undefined) {
        body = (
          <li className="workspace-tree__note" role="none">
            Loading&hellip;
          </li>
        );
      } else if (kids.length === 0) {
        // A create row alone is enough; don't also print "Empty folder." over it.
        body = createRow ? <></> : (
          <li className="workspace-tree__note" role="none">
            Empty folder.
          </li>
        );
      } else {
        body = <>{kids.map((entry) => renderNode(entry, depth))}</>;
      }
    }
    return (
      <>
        {createRow}
        {body}
      </>
    );
  };

  const renderNode = (entry: FsEntry, depth: number): React.JSX.Element => {
    const pad = { paddingLeft: depth * INDENT + 8 };

    // One inline two-step prompt (no native dialog) for both irreversible acts, by
    // `confirming.kind`; each names the file in its question and buttons. role="alert" so it is
    // announced.
    const pending = confirming !== null && confirming.path === entry.path ? confirming : null;
    if (pending !== null) {
      const revert = pending.kind === "revert";
      const verb = revert ? "revert" : "delete";
      const action = revert ? "Revert" : "Delete";
      return (
        <li key={entry.path} role="none">
          <div className="workspace-node workspace-node--confirm" style={pad} role="alert" data-testid="ws-confirm">
            <span className="workspace-node__confirm-text">
              {revert ? `Revert ${entry.name} to HEAD?` : `Delete ${entry.name}?`}
            </span>
            <button
              type="button"
              className="workspace-node__confirm-btn is-danger"
              aria-label={`Confirm ${verb} ${entry.name}`}
              onClick={(e) => {
                e.stopPropagation();
                if (revert) commitRevert(entry.path);
                else commitDelete(entry.path);
              }}
            >
              {action}
            </button>
            <button
              type="button"
              className="workspace-node__confirm-btn"
              aria-label={`Cancel ${verb} ${entry.name}`}
              onClick={(e) => {
                e.stopPropagation();
                setConfirming(null);
              }}
            >
              Cancel
            </button>
          </div>
        </li>
      );
    }

    const isRenaming = renaming === entry.path;
    const nameEl = isRenaming ? (
      <InlineEditInput
        value={entry.name}
        className="workspace-node__input"
        ariaLabel={`Rename ${entry.name}`}
        onCommit={(v) => commitRename(entry.path, v)}
        onCancel={() => setRenaming(null)}
      />
    ) : (
      <span
        className="workspace-node__name"
        onDoubleClick={(e) => {
          e.stopPropagation(); // double-click renames; must not select/toggle
          setError(null);
          setRenaming(entry.path);
        }}
      >
        {entry.name}
      </span>
    );

    if (!entry.isDir) {
      const isSelected = selected === entry.path;
      // Git status is a ROW overlay class (file-icons.md §8), never icon resolution; live rows are
      // only added/modified/untracked.
      const fileGit = gitFiles[entry.path];
      const gitClass = fileGit === undefined ? "" : ` workspace-node--git-${fileGit}`;
      return (
        <li key={entry.path} role="treeitem" aria-selected={isSelected}>
          <div
            className={`workspace-node workspace-node--file${gitClass}${isSelected ? " is-selected" : ""}`}
            style={pad}
            title={entry.name}
            data-testid="ws-file"
            data-path={entry.path}
            draggable={!isRenaming}
            onDragStart={(e) => onEntryDragStart(e, entry.path)}
            // Opening the tab IS the selection now: `activeFilePath` reads the
            // tab this click just made active, so one call does both.
            onClick={() => openEditorTab(entry.path)}
            onContextMenu={(e) => openMenu(e, entry)}
          >
            <span className="workspace-node__icon">
              <FileTypeIcon name={entry.name} size={12} />
            </span>
            {nameEl}
            {!isRenaming && rowActions(entry)}
          </div>
        </li>
      );
    }
    const open = expanded.has(entry.path);
    const isDropInto = entryDrop === entry.path;
    // Folder role from its NAME and its parent's name, never the path; it colors name and icon
    // while git is the separate dot, so they never conflict.
    const role = folderRole(entry.name, basename(parentPath(entry.path)));
    const roleClass = role === null ? "" : ` workspace-node--role-${role}`;
    const hasChangesDot = gitDirs.has(entry.path);
    return (
      <li key={entry.path} role="treeitem" aria-expanded={open}>
        <div
          className={`workspace-node workspace-node--dir${roleClass}${isDropInto ? " is-drop-target" : ""}`}
          style={pad}
          title={entry.name}
          data-testid="ws-dir"
          data-path={entry.path}
          draggable={!isRenaming}
          onDragStart={(e) => onEntryDragStart(e, entry.path)}
          onDragOver={(e) => onEntryDragOver(e, entry.path, true)}
          onDragLeave={onEntryDragLeave}
          onDrop={(e) => onEntryDrop(e, entry.path, true)}
          onClick={() => toggle(entry.path)}
          onContextMenu={(e) => openMenu(e, entry)}
        >
          <span className={`workspace-node__caret${open ? " is-open" : ""}`}>
            <ChevronIcon size={11} />
          </span>
          <span className="workspace-node__icon">
            <FolderIcon size={12} open={open} />
          </span>
          {nameEl}
          {/* "This subtree has edits" (from `dirsWithChanges` — ancestors of
              every change, root excluded, so root headers never dot). Purely
              decorative next to the visible name → aria-hidden. */}
          {hasChangesDot && <span className="workspace-node__vcs-dot" aria-hidden />}
          {!isRenaming && rowActions(entry)}
        </div>
        {open && (
          <ul className="workspace-node__children" role="group">
            {renderChildren(entry.path, depth + 1)}
          </ul>
        )}
      </li>
    );
  };

  const listClass = `workspace-tree__list${entryDrop === root ? " is-drop-target" : ""}`;
  return (
    <>
      <ul
        ref={listRef}
        className={listClass}
        role="tree"
        aria-label={`${folderName(root)} files`}
        onDragOver={(e) => onEntryDragOver(e, root, false)}
        onDragLeave={onEntryDragLeave}
        onDrop={(e) => onEntryDrop(e, root, false)}
        onContextMenu={(e) => openMenu(e, null)}
      >
        {error !== null && (
          <li className="workspace-tree__note workspace-tree__note--error" role="alert">
            {error}
          </li>
        )}
        {renderChildren(root, 0)}
      </ul>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          ariaLabel={menu.entry === null ? `Actions for ${folderName(root)}` : `Actions for ${menu.entry.name}`}
          onClose={() => setMenu(null)}
          items={menuItems(menu.entry)}
        />
      )}
    </>
  );
}
