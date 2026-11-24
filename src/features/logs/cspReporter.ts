/**
 * CSP violation reporter — the webview's own `securitypolicyviolation` events,
 * surfaced in the diagnostics log.
 *
 * WHY THIS EXISTS. `src-tauri/tauri.conf.json` now ships a real
 * Content-Security-Policy (see `docs/design/csp.md`). A CSP is defence in depth,
 * but its failure mode is *silence*: a directive that is one source too narrow
 * does not error, it just makes a feature quietly not render — a blank Markdown
 * preview, an unstyled editor, an image that never appears. In a packaged build
 * there is no DevTools console to check, and a user cannot be asked to
 * screenshot-verify. So the browser's own violation report is
 * routed into the Logs panel: open it, and you SEE what the policy blocked.
 *
 * It is deliberately tiny and dependency-free — one `document` listener, one
 * `logWarn` per event, an unsubscribe returned. Mounted exactly once, from
 * `<App/>`. Being an app-lifetime listener it must never be the thing that
 * breaks a render, hence the `typeof document` guard (Node/SSR-shaped
 * environments have no `document` at all).
 *
 * Report-only by design: no `report-uri` / `report-to` is configured anywhere,
 * because this app must not phone home. This listener is the *entire* reporting
 * channel, and it never leaves the process.
 */

import { logWarn } from "./logStore";

/** The log `source` every violation line carries — filterable in the panel. */
export const CSP_LOG_SOURCE = "csp";

/** Stand-in for a field the browser reported empty (WebKit/Blink differ). */
const UNKNOWN = "(unknown)";

/**
 * The subset of `SecurityPolicyViolationEvent` we read. Declared structurally
 * rather than using the DOM type so a synthetic event (jsdom has no
 * `SecurityPolicyViolationEvent` constructor at all) is describable in a test
 * without casting through `any`, and so a browser that omits an optional field
 * is a typed possibility rather than a surprise at runtime.
 */
interface ViolationFields {
  violatedDirective?: string;
  effectiveDirective?: string;
  blockedURI?: string;
  sourceFile?: string;
  lineNumber?: number;
  columnNumber?: number;
  sample?: string;
}

/**
 * One violation → the `(message, detail)` pair of a WARN log line.
 *
 * `effectiveDirective` is preferred over `violatedDirective`: the latter is the
 * deprecated alias and carries the whole source list in older engines, while the
 * former is exactly the directive name a reader has to go and widen. Every field
 * is optional in practice, so each one has a literal fallback — a half-reported
 * violation must still produce a readable line, since the line IS the diagnosis.
 */
function describe(e: ViolationFields): { message: string; detail: string } {
  const directive = e.effectiveDirective || e.violatedDirective || UNKNOWN;
  const blocked = e.blockedURI || UNKNOWN;
  const file = e.sourceFile || UNKNOWN;
  const line = e.lineNumber ?? 0;
  const column = e.columnNumber ?? 0;
  const where = `at ${file}:${line}:${column}`;
  const sample = e.sample;
  return {
    message: `${directive} blocked ${blocked}`,
    detail: sample ? `${where} — sample: ${sample}` : where,
  };
}

/**
 * Subscribe to the document's CSP violation reports and append each one to the
 * diagnostics log as a WARN line. Returns the unsubscribe.
 *
 * No-op (and never throws) where there is no `document`.
 */
export function startCspReporter(): () => void {
  if (typeof document === "undefined") return () => {};

  const onViolation = (e: ViolationFields): void => {
    const { message, detail } = describe(e);
    logWarn(CSP_LOG_SOURCE, message, detail);
  };

  document.addEventListener("securitypolicyviolation", onViolation);
  return () => {
    document.removeEventListener("securitypolicyviolation", onViolation);
  };
}
