/**
 * `{{var}}` substitution for the API client (secrets exist only on the wire).
 *
 * The whole point of this file is secret-safety: a saved collection keeps
 * `{{TOKEN}}` LITERAL, and the real token — held only in an `Environment` — is
 * spliced in HERE, at send time, so the secret exists only on the wire and never
 * at rest. `substituteVars` is a pure string function; `activeVars` derives the
 * lookup map from the active environment.
 */

import type { Environment } from "./apiStoreIpc";

/**
 * Matches a `{{ KEY }}` placeholder: two braces, any run of non-brace characters,
 * two braces. Because the inner class forbids `{`/`}`, an unterminated `{{` (no
 * closing `}}`) simply never matches and is left alone — the "leave a truly
 * malformed `{{` alone" rule falls out of the pattern rather than a guard.
 */
const VAR_PATTERN = /\{\{([^{}]*)\}\}/g;

/**
 * Replace every `{{KEY}}` in `text` with `vars[KEY]`, trimming whitespace inside
 * the braces (`{{ TOKEN }}` → key `TOKEN`). An unset key resolves to the empty
 * string (never the literal `undefined`); a malformed `{{` with no closing `}}`
 * is left untouched.
 */
export function substituteVars(text: string, vars: Record<string, string>): string {
  return text.replace(VAR_PATTERN, (_match, inner: string) => vars[inner.trim()] ?? "");
}

/**
 * The active environment's variables as a `key → value` lookup, or `{}` when no
 * environment is active. This is the map `substituteVars` reads on send.
 */
export function activeVars(state: {
  apiEnvironments: Environment[];
  activeEnvironmentId: string | null;
}): Record<string, string> {
  const env = state.apiEnvironments.find((e) => e.id === state.activeEnvironmentId);
  if (!env) return {};
  const map: Record<string, string> = {};
  for (const v of env.variables) map[v.key] = v.value;
  return map;
}
