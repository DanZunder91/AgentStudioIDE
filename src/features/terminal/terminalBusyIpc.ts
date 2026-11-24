/**
 * terminalBusyIpc — "is this terminal doing something I would hate to lose?"
 *
 * A stray tab close can lose a running session, so a terminal that is running
 * claude asks for confirmation before it is closed.
 *
 * # Why this is asked at close time rather than pushed
 *
 * There is no periodic terminal event to ride: `agent://event` is agent-scoped,
 * and `TerminalMeta` only refreshes on an on-demand `fleet_snapshot`. A field
 * pushed on either would be **stale by construction**, and a stale "not busy" is
 * exactly the answer that loses the session. So the question is asked once, at
 * the moment of the gesture, and the answer is used immediately and thrown away.
 *
 * # Why it is BATCHED
 *
 * `closePane` kills every terminal in the pane in one click, and the store
 * already computes that as an array. One call per pane, not one per terminal.
 *
 * # What the backend actually checks — two disjoint tiers
 *
 * The two obvious mechanisms are each blind exactly where the other sees, which
 * is why this takes both:
 *
 *   1. **A bound agent session** (all platforms). For a terminal the app
 *      spawned, `claude` **is** the PTY child — there is no shell — so a
 *      foreground-process check can never see it: the foreground group is always
 *      the child itself. The supervisor's own binding table is the authority
 *      here, and it is exact.
 *   2. **A foreground command** (all platforms, two mechanisms). For a terminal
 *      the user typed into, the shell is the child. On Unix a running command has
 *      its own process group, so `tcgetpgrp(master) != child_pid` means
 *      "something is running". Windows (ConPTY) has no process groups, so there
 *      the shell is busy when it has a child that is a console program — what
 *      closing the terminal would kill; console hosts and GUI programs (an editor
 *      it opened) do not count (`pty::busy_descendant` in Rust). Either way this
 *      catches a hand-typed `claude` **even when agent detection never fired**
 *      (it is workspace-scoped, so a `claude` in a folder the app never opened is
 *      invisible to tier 1) — and it catches a long build or a dev server too,
 *      which is the same hazard wearing different clothes.
 *
 * When the OS cannot answer (the process snapshot fails), tier 2 reports `null`
 * — "unknown", which the gate treats as *not* busy. Warning about nothing is the
 * failure that teaches people to click straight through a dialog, and that
 * failure costs more than the one it prevents.
 */

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
  /**
   * A short human label for the dialog — the agent's name, or the terminal's
   * title. Never a command line scraped from output: we do not read the byte
   * stream, and a half-written line would be worse than no label.
   */
  label: string;
}

/**
 * Which of `ids` are busy right now. Terminals that are idle, already exited, or
 * unknown to the supervisor are simply absent from the result.
 *
 * 🔴 A rejection resolves to `[]` — "nothing is busy" — on purpose. This sits in
 * front of a close the user explicitly asked for, so a backend hiccup must not
 * strand them in a tab they cannot close. The cost of the wrong answer here is
 * one lost terminal; the cost of the other failure mode is an app that stops
 * responding to its own close button.
 */
export async function terminalsBusy(ids: TerminalId[]): Promise<BusyTerminal[]> {
  if (ids.length === 0) return [];
  try {
    return await invoke<BusyTerminal[]>("terminals_busy", { ids });
  } catch {
    return [];
  }
}
