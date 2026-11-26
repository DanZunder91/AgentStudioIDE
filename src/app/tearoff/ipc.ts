/** Typed `invoke()` wrappers and event names for `src-tauri/src/tearoff.rs`. Holdings reads and
 * reports never throw (the cache stays; the next report resends all); the moves DO reject, since
 * the caller already released the tab and must take it back. */

import { invoke } from "@tauri-apps/api/core";

import type { Claim, Holding, Mail, ScreenPoint, TornTab } from "./contract";

/** The doorbell (payload: the addressee's label). Mirrors `tearoff::MAIL_EVENT`. */
export const MAIL_EVENT = "tearoff://mail";
/** Broadcast: who holds what now (payload: `Holding[]`). Mirrors `tearoff::HOLDINGS_EVENT`. */
export const HOLDINGS_EVENT = "tearoff://holdings";
/** To a detached window whose close button was pressed. Mirrors `tearoff::CLOSING_EVENT`. */
export const CLOSING_EVENT = "tearoff://closing";

/** Open a new window holding `tabs`; `at` is a drag's release point. Resolves its label. */
export function tearoffOpen(tabs: TornTab[], at: ScreenPoint | null): Promise<string> {
  return invoke<string>("tearoff_open", { tabs, at });
}

/** Post `mail` to the window `to` (and ring its doorbell). */
export function tearoffSend(to: string, mail: Mail): Promise<void> {
  return invoke<void>("tearoff_send", { to, mail });
}

/** Drain this window's mailbox (+ the tabs a detached window holds). */
export function tearoffClaim(): Promise<Claim> {
  return invoke<Claim>("tearoff_claim", {});
}

/** A detached window's report of what it holds now. Never throws. */
export async function tearoffReport(tabs: TornTab[]): Promise<void> {
  try {
    await invoke<void>("tearoff_report", { tabs });
  } catch {
    /* the next report re-sends everything */
  }
}

/** Who holds what. Never throws — `[]` ("nobody holds anything") on failure. */
export async function tearoffHoldings(): Promise<Holding[]> {
  try {
    return await invoke<Holding[]>("tearoff_holdings", {});
  } catch {
    return [];
  }
}

/** A detached window that has handed its tabs back asks to be destroyed. */
export function tearoffClose(): Promise<void> {
  return invoke<void>("tearoff_close", {});
}
