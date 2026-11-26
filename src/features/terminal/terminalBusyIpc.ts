/** Asked once at close time (no pushed signal is fresh enough), batched per pane. Busy = a bound
 * agent session, or a foreground command (Unix process group; Windows console-program child, see
 * Rust `pty::busy_descendant`). An unknown answer (`null`) counts as not busy. */

import { invoke } from "@tauri-apps/api/core";

import type { TerminalId } from "../../app/types";

/** Why a terminal is considered busy — drives the dialog's wording, not its logic. */
export type BusyReason =
  /** A live Claude session is bound to this terminal (tier 1, exact). */
  | "agent"
  /** A foreground command is running in the shell (tier 2, Unix and Windows). */
  | "command";

/** One terminal's answer. Absent from the result array = not busy. */
export interface BusyTerminal {
  id: TerminalId;
  reason: BusyReason;
  /** The agent's name or the terminal's title; never scraped from output (we do not read it). */
  label: string;
}

/** Busy subset of `ids` (idle, exited and unknown are absent). A rejection resolves to `[]` on
 * purpose: a backend hiccup must never strand the user in a tab that will not close. */
export async function terminalsBusy(ids: TerminalId[]): Promise<BusyTerminal[]> {
  if (ids.length === 0) return [];
  try {
    return await invoke<BusyTerminal[]>("terminals_busy", { ids });
  } catch {
    return [];
  }
}
