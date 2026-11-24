/**
 * Layout-prefs IPC — the persisted rail layout preferences.
 *
 * Mirrors `src-tauri/src/layout_prefs.rs`: the user's manual folder ordering (shared
 * by both rails) and the per-rail collapsed-folder sets, so all three survive an app
 * restart. Written to `layout-prefs.json` in the app config dir — never a repo.
 *
 * Same shape as `recentProjects`/`saveApiStore`: a thin typed `invoke` wrapper. Both
 * calls are best-effort at the store's call site — a dropped save is re-issued by the
 * next mutation, and a failed load yields empty prefs, so persistence can never break
 * startup or a drag.
 */

import { invoke } from "@tauri-apps/api/core";

import { isMainWindow } from "./tearoff/windowRole";
import type { Orientation } from "./types";

/**
 * One restorable tab inside a persisted pane, keyed by the id that actually
 * survives a restart.
 *
 * **Not a `TabId`.** Tab ids are minted fresh on every boot, so a blob full of
 * them would restore a skeleton nothing could bind to. A `TerminalId` is durable
 * in the one way that matters: for an agent terminal it IS the agent id, which
 * Rust reuses verbatim when it re-spawns a pinned root — so the tab
 * lands back in the pane the user left it in.
 */
export interface PersistedTerminal {
  terminalId: string;
  /**
   * The user's rename, or null when the tab still wears its derived title.
   *
   * This is the field that fixes a renamed tab losing its name across a
   * restart: before it, a rename lived only in the JS heap. For an agent
   * terminal the name it carries is the AGENT's `customTitle` (that is where
   * both the rail row and the tab read it from), not `Tab.customTitle`.
   */
  customTitle: string | null;
}

/**
 * A persisted pane tree: the store's `PaneNode`, with each leaf's tabs replaced
 * by the terminals that can be brought back.
 *
 * Pane ids are deliberately absent — ephemeral UI identity, minted fresh on
 * hydrate. So is `focusedPaneId`: which pane had focus is a click away, and
 * persisting it would mean persisting the ids to point at.
 */
export type PersistedPane =
  | {
      type: "split";
      orientation: Orientation;
      sizes: number[];
      children: PersistedPane[];
    }
  | {
      type: "leaf";
      terminals: PersistedTerminal[];
      /** Which of `terminals` was the selected tab, if any. */
      activeTerminalId: string | null;
    };

/**
 * One view of the center strip (the iTerm2/tmux "window" model): a name the user
 * can rename, and one whole pane arrangement.
 */
export interface PersistedView {
  id: string;
  name: string;
  layout: PersistedPane;
}

/**
 * The persisted rail prefs. The first three lists are absolute folder paths.
 *   - `folderOrder` — the order folders appear in BOTH rails (a drag rewrites it).
 *   - `collapsedFolders` — folders collapsed in the left (Agents) rail.
 *   - `collapsedRoots` — folders collapsed in the right (Files) rail.
 *   - `focusFollowsAgent` — the "focus follows agent" toggle: when true, selecting
 *     an agent collapses every other Files-rail folder and expands the agent's cwd.
 *     Optional so an older store (or a caller that predates it, e.g. a test) omits
 *     it and gets the `false` default — same defensiveness as the Rust `#[serde(default)]`.
 *   - `collapsedApiFolders` — ids of saved-request folders collapsed in the API
 *     client's Collections rail. It lives HERE, in the file that already means "which
 *     folders did the user leave shut", rather than in `api-store.json` (the Vault, and
 *     a file Rust also writes) — and no second store file was invented for it. Optional
 *     for the same reason `focusFollowsAgent` is.
 */
export interface LayoutPrefs {
  folderOrder: string[];
  collapsedFolders: string[];
  collapsedRoots: string[];
  focusFollowsAgent?: boolean;
  collapsedApiFolders?: string[];
  /**
   * The **center layout**: every view in bar order, with its name and its pane
   * arrangement.
   *
   * Two bugs share this one gap. A view's name lived only in the JS
   * heap, so a rename died with the process; and nothing recorded *which* view a
   * terminal sat in, so on restart every restored agent was dumped into the one
   * view on screen. An empty list means "nothing persisted" — the store then
   * keeps its boot view rather than blanking the window.
   */
  views?: PersistedView[];
  /** Which of `views` was on screen. Null, or an id naming no view, restores the first. */
  activeViewId?: string | null;
}

/** Empty prefs — what a missing/corrupt store loads as (matches Rust's default). */
export const EMPTY_LAYOUT_PREFS: LayoutPrefs = {
  folderOrder: [],
  collapsedFolders: [],
  collapsedRoots: [],
  focusFollowsAgent: false,
  collapsedApiFolders: [],
  views: [],
  activeViewId: null,
};

/**
 * `layout_prefs_load` — read the persisted prefs on boot. NEVER throws: a
 * missing/broken store yields `EMPTY_LAYOUT_PREFS` (like `pinnedAgents`), so boot
 * never fails on persistence. Fields are defaulted defensively in case an older
 * Rust build omitted one.
 */
export async function loadLayoutPrefs(): Promise<LayoutPrefs> {
  try {
    const prefs = await invoke<Partial<LayoutPrefs>>("layout_prefs_load", {});
    return {
      folderOrder: prefs.folderOrder ?? [],
      collapsedFolders: prefs.collapsedFolders ?? [],
      collapsedRoots: prefs.collapsedRoots ?? [],
      focusFollowsAgent: prefs.focusFollowsAgent ?? false,
      collapsedApiFolders: prefs.collapsedApiFolders ?? [],
      views: prefs.views ?? [],
      activeViewId: prefs.activeViewId ?? null,
    };
  } catch {
    return { ...EMPTY_LAYOUT_PREFS };
  }
}

/**
 * `layout_prefs_save` — persist the whole prefs blob (wholesale, like
 * `saveApiStore`). Best-effort: swallows its own failure so a dropped save is never
 * fatal — the store write is the optimistic source of truth for the session, and the
 * next mutation re-issues the persist.
 *
 * **Main window only** (tab tear-off). A detached window runs its own store, holding a
 * different, smaller layout; letting it save would overwrite the main window's views with
 * its own — the two-writers-one-file lost update. Every persisting action in
 * the store funnels here, so this one check covers all of them; Rust refuses the command
 * from any other window as well (`layout_prefs.rs`), so the single writer is enforced twice.
 */
export async function saveLayoutPrefs(prefs: LayoutPrefs): Promise<void> {
  if (!isMainWindow()) return;
  try {
    await invoke<void>("layout_prefs_save", { prefs });
  } catch {
    /* swallowed — a dropped save is not fatal (recent_projects / saveApiStore pattern) */
  }
}
