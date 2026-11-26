/** Persisted layout prefs; mirrors `src-tauri/src/layout_prefs.rs` (`layout-prefs.json` in the
 * app config dir, never a repo). Best-effort at the store's call site: the next mutation re-saves
 * and a failed load yields empty prefs, so persistence never breaks startup or a drag. */

import { invoke } from "@tauri-apps/api/core";

import { isMainWindow } from "./tearoff/windowRole";
import type { Orientation } from "./types";

/** A restorable tab, keyed by `TerminalId`, not `TabId` (minted fresh each boot): an agent
 * terminal's id is the agent id, which Rust reuses when it re-spawns a pinned root. */
export interface PersistedTerminal {
  terminalId: string;
  /** The user's rename, or null for a derived title. For an agent terminal this is the AGENT's
   * `customTitle` (the rail row and tab read it there), not `Tab.customTitle`. */
  customTitle: string | null;
}

/** The store's `PaneNode` with leaf tabs replaced by restorable terminals. Pane ids and
 * `focusedPaneId` are not persisted: pane ids are minted fresh on hydrate. */
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

/** One center-strip view (the iTerm2/tmux "window" model): a renameable name, one arrangement. */
export interface PersistedView {
  id: string;
  name: string;
  layout: PersistedPane;
}

/** Rail prefs (absolute paths). `folderOrder` orders both rails; `collapsedFolders` and
 * `collapsedRoots` are the left/right collapsed sets; `collapsedApiFolders` lives here, not in
 * api-store.json (Rust writes that). Optional fields default when absent (`#[serde(default)]`). */
export interface LayoutPrefs {
  folderOrder: string[];
  collapsedFolders: string[];
  collapsedRoots: string[];
  focusFollowsAgent?: boolean;
  /** How the agent rail draws projects (`railGroupStyle.ts`). A plain string, not the union, so a
   * newer build's value round-trips untouched instead of failing to load. */
  railGroupStyle?: string | null;
  collapsedApiFolders?: string[];
  /** The center layout: every view in bar order with its name and panes. Empty means nothing was
   * persisted, and the store keeps its boot view. */
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
  railGroupStyle: null,
  collapsedApiFolders: [],
  views: [],
  activeViewId: null,
};

/** `layout_prefs_load`: never throws; a missing or broken store yields `EMPTY_LAYOUT_PREFS`, and
 * fields are defaulted in case an older Rust build omitted one. */
export async function loadLayoutPrefs(): Promise<LayoutPrefs> {
  try {
    const prefs = await invoke<Partial<LayoutPrefs>>("layout_prefs_load", {});
    return {
      folderOrder: prefs.folderOrder ?? [],
      collapsedFolders: prefs.collapsedFolders ?? [],
      collapsedRoots: prefs.collapsedRoots ?? [],
      focusFollowsAgent: prefs.focusFollowsAgent ?? false,
      railGroupStyle: prefs.railGroupStyle ?? null,
      collapsedApiFolders: prefs.collapsedApiFolders ?? [],
      views: prefs.views ?? [],
      activeViewId: prefs.activeViewId ?? null,
    };
  } catch {
    return { ...EMPTY_LAYOUT_PREFS };
  }
}

/** `layout_prefs_save`: the whole blob, best-effort (the next mutation re-saves). Main window
 * only: a detached window's smaller layout would overwrite the main one; Rust also refuses other
 * windows (`layout_prefs.rs`). Every persisting store action funnels here. */
export async function saveLayoutPrefs(prefs: LayoutPrefs): Promise<void> {
  if (!isMainWindow()) return;
  try {
    await invoke<void>("layout_prefs_save", { prefs });
  } catch {
    /* swallowed — a dropped save is not fatal (recent_projects / saveApiStore pattern) */
  }
}
