/**
 * Context-window IPC — the one `invoke` seam for the Metrics panel's "Context window"
 * card.
 *
 * Feature-local (not `app/ipc.ts`) for the same reason as `usageIpc.ts`: the wire
 * types live next to their feature.
 *
 * Like `claudeUsage`, this wrapper **does not swallow**: "this agent hasn't had a
 * conversation yet" or "the CLI is missing" is information the user needs, so the
 * rejection passes through untouched and the store turns it into a code via
 * {@link parseContextError}. The splitter lives HERE rather than in a format module
 * because it is the other half of the wire: the command name, its argument names and
 * its rejection vocabulary are one contract, and they are read in one file.
 */

import { invoke } from "@tauri-apps/api/core";

import { splitWireCode, type WireCode } from "../../lib/wireCode";
import { CONTEXT_ERROR_CODES, type ContextErrorCode, type ContextUsage } from "./contextTypes";

/**
 * Every code the card can render: the wire's six, plus `unknown` for a rejection we
 * cannot classify (a renamed code, a Tauri-level "invalid args", a thrown `Error`).
 * `unknown` is client-only on purpose — Rust never sends it, so it is not in
 * `contextTypes.ts`, which is the wire contract and nothing else.
 */
export type ContextError = ContextErrorCode | "unknown";

/** The list `splitWireCode` matches the head against — the wire's codes, verbatim. */
const KNOWN_CODES: readonly ContextError[] = [...CONTEXT_ERROR_CODES, "unknown"];

/**
 * `context_usage` — ask the user's own `claude` CLI for one live ROOT agent's
 * `/context` reading.
 *
 * Takes the agent id and nothing else: Rust's supervisor looks up that agent's minted
 * session id AND its cwd itself, because the session id never crosses the wire.
 * The key is sent by NAME (Tauri camel-cases Rust's `agent_id`); serde
 * ignores unknown fields, so a misspelt key fails as silence on the Rust side, not as
 * an error here — which is why `contextIpc.test.ts` pins the exact argument object.
 *
 * Rejects with the `"<code>[: detail]"` string documented on
 * {@link ContextErrorCode}.
 */
export function contextUsage(agentId: string): Promise<ContextUsage> {
  return invoke<ContextUsage>("context_usage", { agentId });
}

/**
 * Split a rejection from {@link contextUsage} into `{ code, detail }`.
 *
 * Delegates to the app's ONE wire-code reader (`lib/wireCode`: three private
 * copies of that parser had already drifted). An
 * unrecognised head becomes `unknown` and loses its detail too — an unclassified
 * string is exactly the raw CLI text this card exists to keep off the screen.
 */
export function splitContextError(raw: unknown): WireCode<ContextError> {
  return splitWireCode(raw, KNOWN_CODES, "unknown");
}

/** {@link splitContextError}'s code alone — what the store keeps. */
export function parseContextError(raw: unknown): ContextError {
  return splitContextError(raw).code;
}
