/**
 * WorkspaceTree — the right rail's real file tree (multi-root).
 *
 * The panel is **multi-root**: one collapsible root per UNIQUE folder path, the
 * `workspaceRoots` union of the root agents' distinct cwds (the same dedup the
 * AGENTS rail's folder grouping does) with the user-opened browse roots. Every
 * root is browsable at once (VS Code multi-root style) — selecting an agent no
 * longer re-roots the tree, it just adds/keeps that folder's root.
 *
 * Empty by default (no agents, no browse roots) → an "Open a folder" action that
 * adds a browse-only root via the native picker, so the panel is
 * never a dead end. A browse-only root (a folder with no agent of its own) carries
 * a ✕ to close it; an agent-cwd root has none — it lives while its agent does.
 *
 * Each root's file listing lives in `<WorkspaceTreeView>`: children load lazily (a
 * folder's `read_dir` fires only on first expand; the root loads on mount), reads
 * are cached across collapse/re-expand, and a failed read is a calm inline note
 * that never takes the rail down. Per-root expand/selection state is isolated by
 * the `key={root}` remount.
 *
 * File-mutation affordances live in `<WorkspaceTreeView>` too: create
 * folder/file, rename, delete (inline two-step confirm — NO native dialog), and
 * drag-to-move WITHIN a single root. All mutations refresh via the same `load()`
 * that seeds a folder, so the local children cache stays honest without lifting
 * state to the store; an open editor tab is kept consistent as paths change.
 *
 * A file row's menu also carries a **Git** submenu:
 * *Compare with HEAD* opens a read-only `diff` center tab, and *Revert changes…*
 * throws the working-tree edits away — behind the SAME inline two-step confirm
 * delete uses, because it is destructive and irreversible. Both are gated on the
 * git status the tree already subscribes to for its row colors, so opening the
 * menu costs no extra IPC: no Git submenu on a folder (it is per-file),
 * the whole submenu disabled when the root is not a repo, and Revert disabled
 * when there is nothing at HEAD to go back to.
 *
 * Reveal-active-file (IntelliJ's "Select Opened File"): the panel
 * toolbar's crosshair posts `uiActions.revealActiveFile()`, and each root's
 * `<WorkspaceTreeView>` consumes the store's one-shot `fileReveal` request when
 * the path is under ITS root — loading + expanding the ancestor chain (reusing
 * the same readDir cache as click-expand) and scrolling the row into view.
 * Tokens are seen-once per subtree, mirroring `rootCreate`. A reveal for a path
 * under NO open root can do none of that, so the shell says so in a calm note
 * rather than flipping the rail to Files and nothing else.
 *
 * 🔴 **Two behaviours, deliberately separate** (pressing the button should select
 * the file, so it is clear which one is open):
 *  - the **highlight** is `activeFilePath` read straight from the store, so it
 *    FOLLOWS the active file tab — open a file from Find, Git or a tab click and
 *    the row lights up on its own. It is free: highlighting an already-rendered
 *    row costs no `read_dir`, expands nothing, and must never switch the rail or
 *    force the Files tab. It is also rail-wide and survives a root collapse,
 *    because it is one store value rather than per-subtree component state
 *    (component state IS tab state until proven otherwise).
 *  - the **crosshair** is the loud gesture: un-collapse the rail, force Files,
 *    expand the ancestor chain, scroll. Only it does any of that.
 *
 * "Open in Browser" on an `.html` row: a submenu of the browsers
 * installed on this machine, default first and named, falling back to a single
 * "system default" leaf when the list has not arrived. The list is primed ONCE on
 * mount and read SYNCHRONOUSLY while the items are built, because `ContextMenu`
 * cannot grow after it opens — see `browserIpc.ts`, which owns that reasoning.
 *
 * `workspaceRoot` (single) is untouched — Find + the new-terminal cwd still ride
 * on it; only the Files panel became multi-root.
 */

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
// NAME COLLISION, aliased on purpose: `FileIcon` from components/icons is the
// generic monochrome document glyph (still used by the inline-create row);
// `FileTypeIcon` is the per-file COLORED icon resolved via file-icons.md §3
// against the sprite `<IconSprite>` injects app-level. File rows only —
// folder rows keep `FolderIcon` + role colors (dir branch deferred).
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
// A revert rewrites the file underneath any open editor for it. `reloadFromDisk`
// re-reads it into that buffer as an ordinary CM6 transaction, so the editor stops
// showing content that no longer exists on disk — and the user can still Cmd+Z the
// revert inside the buffer. No-op when the file has no editor.
// …and `opensInExternalBrowser` is the SAME predicate the preview mount
// asks, taken from the barrel rather than deep-imported (`previewKinds.ts` is
// the single authority and must stay the only one). A file
// that renders as a page in the app is exactly a file the menu offers to a
// browser; there is no second extension table to drift out of step.
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

/**
 * The ROOT read can momentarily lose a race with folder *registration*: when an
 * ad-hoc `claude` is detected, its cwd is added to `read_dir`'s scope (the recents
 * push in `bridge.registerFleetRoots`) at the same instant this tree mounts and
 * reads that cwd. If the read lands first it is out-of-scope and 403s — and the
 * failure used to be sticky, so the folder showed "Can't read this folder." forever
 * (a real bug). So the root read RETRIES a few times, staying on "Loading…",
 * before conceding: by the next tick the registration has settled and the read is in
 * scope. Nested reads happen on user-expand, long after any registration, so they
 * never race and are never retried.
 */
export const ROOT_READ_TRIES = 4;
export const ROOT_READ_RETRY_MS = 120;

/**
 * Drag payload for reordering a FOLDER (root) in the Files rail: the
 * absolute folder path being moved. Deliberately distinct from `TAB_DND_MIME`
 * (application/x-agentstudio-tab) so a tab drag and a folder drag never accept each
 * other's payload — `dataTransfer.types.includes(...)` gates on this exact string.
 * The drop calls the SAME `moveFolder` action the left rail sorts by, so both rails
 * stay in lockstep.
 */
export const FOLDER_DND_MIME = "application/x-agentstudio-ws-folder";

/**
 * Drag payload for MOVING an entry (file or folder) within a single root: the
 * absolute entry path. DISTINCT from `FOLDER_DND_MIME` so the root-header
 * reorder drag and the entry-move drag never accept each other's payload — each
 * drop target gates on its own exact mime via `dataTransfer.types.includes(...)`.
 */
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

/** Re-base `p` from `oldBase` onto `newBase` if it is at/under `oldBase`, else
 *  null (it is unrelated and unchanged). Used to keep open editor tabs pointing
 *  at the right path after a rename/move — and, through them, the highlight.
 *  Either separator, and Windows paths without case: a tab opened as `c:\w\a.ts`
 *  follows the rename of the tree's `C:\w`. */
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
  // Subscribe to the three slices `workspaceRoots` reads, each a stable reference
  // under immer's structural sharing, and derive the roots with `useMemo`. That
  // keeps the union pure (no module-level cache to reset) while staying
  // referentially stable across renders that changed nothing structural — the
  // same "don't build a fresh array on every render" discipline as the rail.
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

  // Which roots are collapsed (header caret). Read from the STORE, not
  // component state, so a collapsed folder survives an app restart: `collapsedRoots`
  // is persisted (via `toggleRootCollapsed`), and absence still means expanded — so a
  // new root opens showing its files, matching the rail's folders-open default.
  const collapsedRoots = useAppStore((s) => s.collapsedRoots);
  const toggleRoot = useAppStore((s) => s.workspaceActions.toggleRootCollapsed);

  // The folder-drag drop target: the root path currently hovered by a
  // folder drag, or null. Drives the calm drop indicator; cleared on drop/leave.
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  // Create-at-root: the header's New file/New folder buttons live out here, but the
  // children cache + reload live in the INNER component. So a click forwards a
  // bumped-token signal to that root's `<WorkspaceTreeView>`, which opens an inline
  // create row at the root and reloads it on commit (children ownership stays put).
  const [rootCreate, setRootCreate] = useState<{ root: string; kind: "file" | "dir"; token: number } | null>(
    null,
  );
  const tokenRef = useRef(0);

  // Refresh (the tree needs a button to update it): the tree
  // caches every listing it has read, so a file created OUTSIDE the app (an agent,
  // a terminal, git) never showed up. Same token-forwarding shape as create-at-root,
  // one token per root. A COLLAPSED root needs nothing: its listing is unmounted,
  // and expanding it remounts and reads fresh.
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

  // Right-click menu for a ROOT HEADER. Lives out here because
  // the header — unlike the file listing — is present even when the root is
  // collapsed. Its items reuse the SAME `startRootCreate` the header's hover
  // buttons call; the root offers New File/New Folder only (Rust rejects a
  // rename/delete of a workspace root, so those are omitted — a root is not an
  // entry). Only one menu shows at a time: the ContextMenu's own outside-click /
  // outside-contextmenu listeners close it (and any inner-listing menu) whenever
  // another opens.
  const [headerMenu, setHeaderMenu] = useState<{ x: number; y: number; root: string } | null>(null);

  // Keep the git status poll running while the Files rail is mounted — it feeds
  // the row colors + folder dots below. The store refcounts starts, and the
  // returned stop is idempotent (StrictMode double-cleanup safe), so this is
  // exactly `useEffect`'s setup/teardown shape.
  useEffect(() => startGitPolling(), []);

  // Start the ONE browser enumeration for this app session, so the Open in
  // Browser submenu can be built synchronously later (the Git submenu's rule:
  // no IPC fires just to open a menu). Idempotent and
  // de-duplicated in `browserIpc`, so a StrictMode double-invoke costs nothing
  // and a remount of this rail never re-asks. The promise is deliberately
  // unawaited and never rejects — a machine we cannot enumerate still gets the
  // working "system default" leaf.
  useEffect(() => {
    void primeBrowsers();
  }, []);

  /* A reveal for a path under no open root.
   * The store already resolved the owning root — a `root: null` means every
   * subtree will early-return and the ONLY visible effect would be the rail
   * flipping to Files. Say so instead. Seen-once by token, the same
   * adjust-state-during-render pattern the inner listing uses for `rootCreate`;
   * a later reveal that DOES land clears the note. */
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
      {/* Panel toolbar: the reveal-active-file crosshair. Disabled
          only when NO file tab is open anywhere — see `activeFilePath`, which is
          also what the highlight follows. The empty state above has no toolbar:
          with zero roots there is no tree to reveal into.

          The reason rides on a WRAPPER's `title`, not only the button's: a
          disabled button is inert to the pointer, and the one thing worse than a
          greyed-out button is a greyed-out button that will not say why. The
          wrapper is not disabled, so the tooltip resolves from it in either
          state, while the button keeps the same string as its own accessible
          description — one `revealHint`, so the two can never disagree. */}
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
  /* The highlighted row — DERIVED from the store, never local state.
   * As `useState` it was per-root component state, and
   * `<WorkspaceTreeView key={root}>` unmounts on root collapse, so the highlight
   * was dropped by collapsing a folder and was never rail-wide across the several
   * roots the panel puts side by side. Deriving it also makes it FOLLOW the active
   * file tab for free, and deletes every bespoke re-point: a rename/move closes
   * and reopens the editor tab at the new path (`reconcileTabs`), and a delete
   * closes it — so the highlight tracks all three with no code of its own. */
  const selected = useAppStore((s) => activeFilePath(s));
  // Mutation UI state: the inline create row (`{ parent, kind }`), the
  // path currently being renamed, the entry awaiting a destructive confirm, the
  // entry-move drop target, and the calm inline error note.
  //
  // `confirming` carries a KIND as well as a path: delete and revert are both
  // irreversible, both confirm the same way, and both swap the same row — so they
  // share one mechanism with a discriminator rather than growing a second,
  // near-identical one that could be open at the same time as the first.
  const [creating, setCreating] = useState<{ parent: string; kind: "file" | "dir" } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<ConfirmRequest | null>(null);
  const [entryDrop, setEntryDrop] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The open right-click menu for a row or the root's empty space:
  // `entry` is the right-clicked file/dir, or `null` for the root listing itself.
  // Its items reuse the SAME begin-create/rename/delete handlers the hover
  // buttons + double-click use — nothing is reimplemented.
  const [menu, setMenu] = useState<{ x: number; y: number; entry: FsEntry | null } | null>(null);

  // Git decoration: subscribe THIS subtree — not the outer
  // shell, whose headers don't use git — to the working-tree status and derive
  // the two row lookups once per snapshot. Paths in both are absolute, exactly
  // matching each row's `data-path`/`entry.path`.
  const gitStatus = useGitStore((s) => s.status);
  const gitFiles = useMemo(() => fileStatusMap(gitStatus), [gitStatus]);
  const gitDirs = useMemo(() => dirsWithChanges(gitStatus), [gitStatus]);
  /**
   * Is THIS root a git repo? `not-a-repo` is the poller's stable, expected answer
   * for a plain folder (gitStore rule 4), so it is the one code that means "there
   * is no git here" rather than "git failed this cycle" — a transient `git` error
   * keeps the last good changes beside it and must NOT grey out the menu.
   */
  const notARepo = gitStatus[root]?.error?.code === "not-a-repo";

  // Clicking a file highlights it here AND opens it in the center editor.
  // `openEditorTab` dedupes by path, so re-clicking reuses the tab.
  const openEditorTab = useAppStore((s) => s.layoutActions.openEditorTab);
  // Git ▸ Compare with HEAD. Deduped by path in the store, so comparing the same
  // file twice re-focuses the one diff tab.
  const openDiffTab = useAppStore((s) => s.layoutActions.openDiffTab);
  // Keeping an OPEN editor tab consistent as paths change: close the stale tab and
  // (for a rename/move) reopen it at the new path so its `ref.path` — what the
  // editor reads by — is correct. `renameTab` only relabels; it can't re-point the
  // ref, so close+reopen is the simplest correct thing.
  const closeTab = useAppStore((s) => s.layoutActions.closeTab);

  /** Read `path` into the children cache — the lazy first-expand load AND the
   *  forced refresh after a mutation. Resolves true when the listing landed,
   *  false when the read failed (the path joins `failed`); most callers are
   *  fire-and-forget, but the reveal walk awaits it per ancestor. */
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

  // Root loads on mount (root is fixed per instance — the component is keyed by
  // it, so a re-root remounts rather than mutating in place). Unlike a nested
  // read, the root read RETRIES on failure (see ROOT_READ_TRIES): it can briefly
  // lose a race with the folder being registered into read_dir's scope, and must
  // not stick on "Can't read this folder." while the scope is about to widen.
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

  // Refresh from the header: re-read the root and every folder that is EXPANDED,
  // in place, so the user keeps their expand state. Collapsed-but-cached folders
  // are dropped from the cache instead of re-read — they read fresh on their next
  // expand, which costs nothing now. A folder that vanished on disk just fails its
  // read and is dropped (its parent's fresh listing no longer shows it anyway);
  // previously-failed reads get another chance. The token seen at MOUNT counts as
  // handled — a fresh mount has just read everything — and the ref (not state)
  // makes StrictMode's re-run a no-op while the first run's reads still land.
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

  // React to a create-at-root signal from the header (the token bumps per click, so
  // the same `kind` re-fires). The root listing is always shown while this inner
  // component is mounted, so "create at root" is just an inline row under `root`.
  // This is React's "store information from previous renders" pattern — compare the
  // signal's token against a piece of STATE during render (no effect, no ref) and
  // adjust immediately. React re-renders before painting; no cascading effect.
  const [seenToken, setSeenToken] = useState<number | undefined>(undefined);
  if (createSignal && createSignal.token !== seenToken) {
    setSeenToken(createSignal.token);
    setCreating({ parent: root, kind: createSignal.kind });
    setError(null);
  }

  /* ── reveal active file ────────────────────────────────────────────────────
   * Consume the store's one-shot `fileReveal` when the path is under THIS root:
   * walk the ancestor chain outermost → innermost (loading each dir through the
   * same `load`/cache click-expand uses, expanding as we go), then scroll the
   * file's row into view. Selecting it is not this effect's job: the highlight is
   * derived from `activeFilePath`. The token is seen-once per subtree — the
   * same discipline as `rootCreate` above — claimed up front so a failed walk
   * never retries, and handed BACK if the walk is torn down before it finished
   * (the StrictMode note in the effect). A fresh mount starts at token 0, which
   * is what lets a just-un-collapsed root (revealActiveFile expands it) consume
   * the request that caused its own mount. */
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
    // Claim the token up front, so a walk that FINISHES — successfully or not —
    // never runs twice. But remember what it was: a walk that is torn down before
    // it finishes has not handled anything, and must hand the token back.
    //
    // 🔴 That is what makes this survive React StrictMode, which double-invokes
    // every effect in dev (setup → cleanup → setup) against the SAME component
    // instance, so the ref above is not reset in between. Without the hand-back,
    // setup #1 claimed the token and was immediately cancelled, setup #2 saw the
    // token as already handled, and a reveal into a freshly-mounted subtree that
    // needed an uncached `read_dir` silently did nothing in `tauri dev` — while
    // working perfectly in the production build, which does not double-invoke.
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
      // No post-loop `cancelled` check: every await above is followed by its own
      // `!ok || cancelled` bail-out, and nothing suspends after the last one, so
      // cancellation cannot land between the loop and here (a guard would be an
      // untestable dead branch). Nothing selects the file here: the highlight is
      // derived from `activeFilePath`, which is the very value `revealActiveFile`
      // computed its target from — so the row is already lit. Hand off to the
      // scroll effect, which runs after the expansion above has committed.
      walked = true;
      setRevealDone({ path: target, token: fileReveal.token });
    })();
    return () => {
      cancelled = true; // a newer reveal (or unmount) supersedes this walk
      // A walk that never reached its end handled nothing, so hand the token
      // back — see the claim above. Only a re-run of THIS effect can pick it up
      // again (the deps are the request object itself), which in practice means
      // StrictMode's double-invoke; a genuine remount gets a fresh ref at 0.
      if (!walked) revealSeenRef.current = previousToken;
    };
  }, [fileReveal, root, load]);

  useEffect(() => {
    if (revealDone === null) return;
    // The <ul> mounts unconditionally with this subtree (the root-error note
    // renders INSIDE it), and an effect only runs while mounted — so the ref is
    // always attached here. The cast records that invariant instead of a
    // null-guard, which would be an untestable dead branch; if the <ul> ever
    // becomes conditional, every reveal test fails loudly right here.
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

  /**
   * Throw away a file's working-tree changes (Git ▸ Revert changes…), AFTER the
   * inline confirm has been answered — `commitDelete`'s shape, and for the same
   * reason: by the time this runs, the destructive question has been asked.
   *
   * Three surfaces can be stale afterwards and all three are refreshed:
   *  - the folder listing (`load`) — size/mtime, and a reverted-away new file;
   *  - the git status (`refreshGitStatus`) — the row's color and the Git panel;
   *  - the open editor's BUFFER (`reloadFromDisk`) — otherwise the editor keeps
   *    showing the edits that no longer exist on disk, and its next save would
   *    put them straight back.
   * A rejection ("file is not tracked — there is nothing to revert to") lands in
   * the same calm inline note every other mutation uses. Never swallowed: a
   * revert that quietly did nothing is a lie about the user's file.
   */
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

  /** Move `dragged` into `destDir`, guarding the clearly-no-op cases before any
   *  IPC (already there / onto itself / into its own subtree). Rust rejects these
   *  too — a rejection is surfaced calmly, never a crash. Compared as paths, not
   *  strings: the root list's drop target is the root as the UI spells it (`c:\w`),
   *  the dragged row the tree's canonical `C:\w\a.ts`. */
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

  /** Open the right-click menu at the cursor. A ROW click carries its entry and
   *  stops propagation so the root-list handler underneath does not also fire; the
   *  root-list (empty-space) click passes `null`. `preventDefault` suppresses the
   *  OS/webview menu in both cases. */
  const openMenu = (e: MouseEvent, entry: FsEntry | null): void => {
    e.preventDefault();
    if (entry !== null) e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, entry });
  };

  /**
   * The **Git** submenu for one FILE row. Folders get none —
   * the submenu is per-file, and "revert this whole directory" is a much bigger
   * promise than the one command behind it.
   *
   * Both `disabled` decisions are read off the status the tree ALREADY holds for
   * its row colors, so opening a menu fires no IPC:
   *  - not a repo → the whole submenu is disabled; neither command has an answer.
   *  - nothing to go back to → **Revert** alone is disabled. That means no
   *    recorded working-tree change, and also `untracked`: a file git has never
   *    seen has no HEAD side, so a revert could only mean "delete it", which is
   *    Delete's job and not something a menu item called *Revert* should do.
   *    Compare stays enabled — comparing a clean file is a legitimate way to ask
   *    "am I sure this is clean?", and it answers "No changes".
   *
   * The ellipsis on *Revert changes…* is the standard signal that a confirm step
   * follows; the item itself only ARMS the inline confirm (`commitRevert` runs
   * when that is answered).
   */
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

  /**
   * Hand one file to an external browser. The rejection is Rust's stable
   * `"<code>[: detail]"` string, and it lands in the SAME calm inline note every
   * other failed action from this tree uses, plus a Logs line carrying the code —
   * never swallowed. A launch that quietly did nothing is indistinguishable from
   * a browser that opened behind the window.
   */
  const openInBrowserFrom = (path: string, browserId?: string): void => {
    setError(null);
    openInBrowser(path, browserId).catch((e: unknown) => {
      const detail = errMsg(e);
      setError(`Couldn’t open ${basename(path)} in a browser. ${detail}`);
      logError("files", `open_in_browser failed for ${path}`, detail);
    });
  };

  /**
   * The **Open in Browser** group for one `.html`/`.htm` row.
   *
   * 🔴 `cachedBrowsers()` is read SYNCHRONOUSLY, never awaited. `ContextMenu`
   * clamps on `[x, y, anchor]` and focuses on `[activeIndex, openSub]`, so a
   * submenu that opens as "Loading…" and gains rows later is never re-measured
   * (it can run off the bottom of the screen) and never gains a focus ring. The
   * list is primed once on mount instead — the Git submenu's rule, *"no IPC fires
   * just to open a menu"*.
   *
   * Nothing primed yet (or enumeration failed, or an OS we cannot enumerate) is
   * **not** an error state: it collapses to a single leaf that opens the system
   * default, which is an accepted fallback (opening in the default browser is
   * acceptable). Losing the gesture because a list did
   * not arrive would be the worse failure by far.
   *
   * The default appears TWICE on purpose when it is known — once as *System
   * default (Chrome)* and once by name — because they are different requests:
   * the first follows whatever the OS default becomes, the second pins Chrome.
   */
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

  /** The menu items for a right-clicked target, all routed through the EXISTING
   *  begin-create / begin-rename / begin-delete flows (same as the hover buttons).
   *  - root listing (`entry === null`): New File / New Folder at the root top level.
   *  - a directory: New File / New Folder INSIDE it, then Rename / Delete.
   *  - a file: New File / New Folder in its PARENT (VS Code-style), then the Git
   *    submenu, then Rename / Delete.
   *  - an `.html`/`.htm` file: **Open in Browser** first of all, then the above.
   *
   *  Git sits between the create group and the rename/delete group so that Delete
   *  stays last — the danger item at the bottom is the convention every menu in
   *  this app follows, and burying a new submenu under it would hide it. Open in
   *  Browser goes at the TOP for the mirror-image reason: on an HTML file it is
   *  the thing you came to the menu for, and the create group is the thing you
   *  did not. */
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

    // A destructive confirm swaps the whole row for an inline two-step prompt (NO
    // native dialog — banned in this app). role="alert" so it is announced.
    //
    // ONE prompt for both irreversible acts, distinguished by `confirming.kind`:
    // delete removes the file, revert removes the edits to it. Each names the file
    // in its question and in both buttons' labels, so a confirm can never be
    // answered without knowing what it is about.
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
      // Git status as a ROW-level overlay class (file-icons.md §8): composed
      // with the icon via CSS, never part of icon resolution. `deleted` never
      // occurs here — a deleted file has no tree row (it lives in the Git
      // panel); live rows only ever carry added/modified/untracked.
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
    // Semantic folder role (IntelliJ-style): derived from the folder's NAME and
    // its parent's name — the path never enters the table. When the folder ALSO
    // contains git changes there is no conflict by construction: the role
    // colors the name/icon, and the git signal is the separate dot after the
    // name — two independent channels on one row.
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
