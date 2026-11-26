/** Routes the webview's CSP violation reports into the Logs panel: a too-narrow directive fails
 * silently and packaged builds have no console (see `docs/design/csp.md`). Report-only, never sent
 * anywhere (no `report-uri`). Mounted once from `<App/>`. */

import { logWarn } from "./logStore";

/** The log `source` every violation line carries — filterable in the panel. */
export const CSP_LOG_SOURCE = "csp";

/** Stand-in for a field the browser reported empty (WebKit/Blink differ). */
const UNKNOWN = "(unknown)";

/** Structural: a synthetic jsdom event types without `any`, and missing fields are expected. */
interface ViolationFields {
  violatedDirective?: string;
  effectiveDirective?: string;
  blockedURI?: string;
  sourceFile?: string;
  lineNumber?: number;
  columnNumber?: number;
  sample?: string;
}

/** `effectiveDirective` first (`violatedDirective` is the deprecated alias). Every field has a
 * literal fallback: a half-reported violation must still read clearly. */
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

/** Log each CSP violation as a WARN line; returns the unsubscribe. No-op without `document`. */
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
