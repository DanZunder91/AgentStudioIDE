/**
 * The tear-off wire contract — what a tab looks like while it crosses from one window to
 * another (docs/design/tab-tearoff.md).
 *
 * Mirrored in Rust by `src-tauri/src/tearoff.rs` (`TornTab`, `Mail`, `Claim`, `Holding`),
 * and pinned on both sides by one golden, `src/test/contract/goldens/tearoff.json`: Rust
 * writes it from its own values and round-trips it; the TS contract test feeds it through
 * `tabKey` and the adopter. A rename on either side goes red on that side.
 *
 * ── Why a description and not the tab ───────────────────────────────────────
 * Each window is its own JS realm with its own store and registries (tab-tearoff.md §2.1),
 * so nothing live can be handed over — only enough to rebuild it. A terminal's PTY never
 * moves at all: the receiver re-binds the same process with `terminal_reattach`.
 *
 * ── What is deliberately lost in a move (the §3 rehydration list, decided) ──
 * - terminal: scrollback older than Rust's 256 KB ring, the selection, the find bar;
 * - editor: nothing on the explicit move (text, dirty, selection, undo history and the disk
 *   stamp all travel); on a CRASHED window's re-home, the undo history and the last few
 *   hundred milliseconds of typing (the periodic report carries text only, debounced).
 */

import type { Tab } from "../types";

/** A file's on-disk identity (`workspaceIpc` `FileStamp`). */
export interface Stamp {
  mtimeMs: number | null;
  size: number;
}

/** An editor's buffer as it leaves a window (`tearoff.rs` `EditorBuffer`). */
export interface EditorBuffer {
  /** What the buffer holds now, saved or not. */
  text: string;
  /** The last saved (or loaded) text — the dirty flag is `text !== baseline`. */
  baseline: string;
  /**
   * CodeMirror's `EditorState.toJSON({ history })`, stringified: the selection and the undo
   * stack. A string so Rust never parses (and re-orders) it. `null` in a periodic report.
   */
  state: string | null;
  /** The disk stamp the buffer was last read or written at. */
  stamp: Stamp | null;
  /** Already flagged as changed on disk (`staleOnDisk`). */
  stale: boolean;
}

/** One tab, described well enough to be re-created in another window. */
export type TornTab =
  | { kind: "terminal"; terminalId: string; title: string; customTitle: string | null }
  | {
      kind: "agent-terminal";
      terminalId: string;
      agentId: string;
      title: string;
      customTitle: string | null;
    }
  | {
      kind: "editor";
      path: string;
      title: string;
      customTitle: string | null;
      /**
       * `null` when the editor had not finished loading — the receiver reads the file.
       * There is no `dirty` beside it: dirty IS `text !== baseline`, and a second copy of
       * one fact is a copy that can disagree.
       */
      buffer: EditorBuffer | null;
    }
  | { kind: "diff"; path: string; title: string }
  | { kind: "metrics"; cwd: string | null }
  | { kind: "agent-logs" }
  | { kind: "network" }
  | { kind: "village" };

/** One message in a window's mailbox. */
export type Mail =
  /** Take these tabs (a move, or a dead window's tabs coming home). */
  | { t: "adopt"; tabs: TornTab[] }
  /** Bring the tab with this key to the front. */
  | { t: "focus"; key: string }
  /** Close the tab with this key for good — already confirmed by the sender. */
  | { t: "close"; key: string }
  /** To the main window: this agent's tab was closed for good in a detached window. */
  | { t: "dismissed"; agentId: string }
  /**
   * To the window a dragged tab came from: it was dropped on window `to`, so move it there.
   * `tabId` is the SENDER's tab id — meaningless anywhere else. Rust only accepts one whose
   * `to` is the window asking.
   */
  | { t: "give"; tabId: string; to: string }
  /**
   * An agent's custom name changed in the sending window (`null` = back to its derived
   * title): detached → main, which persists it with the layout; main → the holder, whose tab
   * then shows what the main rail says.
   */
  | { t: "renamed"; agentId: string; name: string | null };

/** `tearoff_claim`'s answer: the tabs a detached window holds (reload recovery) + its mail. */
export interface Claim {
  tabs: TornTab[];
  mail: Mail[];
}

/** One detached window and the keys of the tabs it holds. */
export interface Holding {
  label: string;
  keys: string[];
}

/** A desktop point exactly as `cursorPosition()` reported it. */
export interface ScreenPoint {
  x: number;
  y: number;
}

/** The kinds that can leave their window — `TornTab["kind"]`, as a runtime set. */
export const TEAROFF_KINDS: ReadonlySet<Tab["kind"]> = new Set<TornTab["kind"]>([
  "terminal",
  "agent-terminal",
  "editor",
  "diff",
  "metrics",
  "agent-logs",
  "network",
  "village",
]);

/**
 * Can this tab move to another window? The kinds left out are the ones a move would break
 * (tab-tearoff.md §3): an API request's in-flight response and a sequence's captured bearer
 * tokens live in this window's store; a DB console is a live Rust session that is
 * one-per-connection per store; the session picker and an activity view are cheap to
 * re-open from the rail of the window that has one. Their menu item is simply absent.
 */
export function canTearOff(tab: Tab | undefined): boolean {
  return !!tab && TEAROFF_KINDS.has(tab.ref.kind);
}

/** The key prefix every terminal tab shares (`tabKey`). */
export const TERMINAL_KEY = "terminal:";

/**
 * A tab's identity across windows: at most one window holds a key at any moment. Mirrors
 * `TornTab::key` in Rust; the golden pins both.
 *
 * A plain and an agent terminal share the PTY id space (an agent's TerminalId IS its
 * AgentId), so they share `terminal:`; an editor and a diff of one file are two tabs, so two
 * keys; the singletons key on their kind.
 */
export function tabKey(t: TornTab | Tab["ref"]): string {
  switch (t.kind) {
    case "terminal":
    case "agent-terminal":
      return `${TERMINAL_KEY}${t.terminalId}`;
    case "editor":
      return `editor:${t.path}`;
    case "diff":
      return `diff:${t.path}`;
    default:
      return t.kind;
  }
}

/**
 * The terminal ids detached windows hold — the ones a main-window reload must NOT rebuild
 * (`bridge.ts`): re-attaching them would steal their PTY stream from the window showing them.
 */
export function heldTerminalIds(holdings: readonly Holding[]): Set<string> {
  const ids = new Set<string>();
  for (const h of holdings) {
    for (const key of h.keys) {
      if (key.startsWith(TERMINAL_KEY)) ids.add(key.slice(TERMINAL_KEY.length));
    }
  }
  return ids;
}
