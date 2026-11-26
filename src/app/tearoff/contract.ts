/** Tear-off wire contract (docs/design/tab-tearoff.md), mirrored by `src-tauri/src/tearoff.rs`
 * and pinned by `src/test/contract/goldens/tearoff.json`. A description, not the tab: each window
 * is its own realm; PTYs re-bind via `terminal_reattach`. Losses: tab-tearoff.md §3. */

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
  /** `EditorState.toJSON({ history })` stringified (selection + undo), a string so Rust never
   * re-orders it. `null` in a periodic report. */
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
      /** `null` if the editor had not loaded (the receiver reads the file). No `dirty`: dirty IS
       * `text !== baseline`. */
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
  /** To a dragged tab's source window: it was dropped on `to`, move it there. `tabId` is the
   * SENDER's id; Rust only accepts it when `to` is the asking window. */
  | { t: "give"; tabId: string; to: string }
  /** An agent's custom name changed (`null` = derived title): detached → main, which persists
   * it; main → the holder, to match the main rail. */
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

/** Can this tab move windows? Excluded kinds would break (tab-tearoff.md §3: in-flight API
 * state, one-per-connection DB sessions, cheap-to-reopen views); they get no menu item. */
export function canTearOff(tab: Tab | undefined): boolean {
  return !!tab && TEAROFF_KINDS.has(tab.ref.kind);
}

/** The key prefix every terminal tab shares (`tabKey`). */
export const TERMINAL_KEY = "terminal:";

/** Cross-window tab identity (one holder per key); mirrors Rust's `TornTab::key`, golden-pinned.
 * Plain and agent terminals share `terminal:` (one PTY id space); editor and diff differ. */
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

/** Terminal ids held by detached windows; a main-window reload must NOT rebuild them
 * (`bridge.ts`) or it would steal their PTY stream. */
export function heldTerminalIds(holdings: readonly Holding[]): Set<string> {
  const ids = new Set<string>();
  for (const h of holdings) {
    for (const key of h.keys) {
      if (key.startsWith(TERMINAL_KEY)) ids.add(key.slice(TERMINAL_KEY.length));
    }
  }
  return ids;
}
