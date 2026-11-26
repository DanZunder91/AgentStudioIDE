/** Secret safety: collections keep {{TOKEN}} literal and the real value is spliced in here at
 * send time, so it exists only on the wire, never at rest. */

import type { Environment } from "./apiStoreIpc";

/** The inner class forbids braces, so an unterminated {{ never matches and is left alone. */
const VAR_PATTERN = /\{\{([^{}]*)\}\}/g;

/** Keys are trimmed ({{ TOKEN }} reads TOKEN); an unset key becomes "", never "undefined". */
export function substituteVars(text: string, vars: Record<string, string>): string {
  return text.replace(VAR_PATTERN, (_match, inner: string) => vars[inner.trim()] ?? "");
}

/** The active environment's variables, or {} when none is active. */
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
