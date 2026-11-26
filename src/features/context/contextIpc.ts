/** Does not swallow: a missing CLI or no conversation yet is information, so rejections pass
 * through and the store classifies them. Command name, args and rejection vocabulary are one
 * contract, kept in this one file. */

import { invoke } from "@tauri-apps/api/core";

import { splitWireCode, type WireCode } from "../../lib/wireCode";
import { CONTEXT_ERROR_CODES, type ContextErrorCode, type ContextUsage } from "./contextTypes";

/** unknown is client-only (an unclassifiable rejection); Rust never sends it. */
export type ContextError = ContextErrorCode | "unknown";

/** The list `splitWireCode` matches the head against — the wire's codes, verbatim. */
const KNOWN_CODES: readonly ContextError[] = [...CONTEXT_ERROR_CODES, "unknown"];

/** Takes only the agent id: Rust resolves the session id and cwd, as the session id never crosses
 * the wire. serde ignores a misspelt key, so contextIpc.test.ts pins the argument object. Rejects
 * with "<code>[: detail]" (see ContextErrorCode). */
export function contextUsage(agentId: string): Promise<ContextUsage> {
  return invoke<ContextUsage>("context_usage", { agentId });
}

/** Via lib/wireCode, the app's one wire-code reader. An unrecognised head becomes unknown and
 * drops its detail, keeping raw CLI text off screen. */
export function splitContextError(raw: unknown): WireCode<ContextError> {
  return splitWireCode(raw, KNOWN_CODES, "unknown");
}

/** {@link splitContextError}'s code alone — what the store keeps. */
export function parseContextError(raw: unknown): ContextError {
  return splitContextError(raw).code;
}
