/** TS twin of Rust's `classify_level` (`src-tauri/src/logstream/level.rs`) for block output
 * lines: same rules, same precedence, golden-checked by `src/test/contract/level.contract.test.ts`
 * (change both). Unicode classes stand in for `\d`/`\s`/`\b`; no lookbehind (old WebKit). */

import type { LogLevel } from "./agentLogsTypes";

/** Rust's Unicode `\w` (UTS #18 Annex C): what a `\b` looks at on either side. */
const W = String.raw`\p{Alphabetic}\p{M}\p{Nd}\p{Pc}\p{Join_Control}`;
/** A Unicode `\b` BEFORE a word character: start of text, or a non-word character. */
const B_START = `(?:^|[^${W}])`;
/** A Unicode `\b` AFTER a word character. */
const B_END = `(?![${W}])`;
const D = String.raw`\p{Nd}`;
const S = String.raw`[\p{White_Space}]`;

const re = (src: string, flags = "u"): RegExp => new RegExp(src, flags);

/** `YYYY-MM-DD HH:MM:SS.fff[+zzzz] <TYPE> ` — os_log's compact prefix (`log stream --style compact`). */
const OS_LOG_COMPACT = re(
  `^${D}{4}-${D}{2}-${D}{2} ${D}{2}:${D}{2}:${D}{2}\\.${D}{1,9}(?:[+-]${D}{4})?${S}+(E|Fa|F|Df|Db|D|I|A)${S}`,
);

/** Structured loggers' level column tokens, uppercase — Rust's `LEVEL_TOKENS`, verbatim. */
const LEVEL_TOKENS =
  "ERROR|ERRO|ERR|FATAL|CRITICAL|CRIT|PANIC|WARNING|WARN|WRN|INFO|INF|NOTICE|DEBUG|DBG|TRACE|TRC";

/** A timestamp (optionally in `[`), then the level token as its own column. */
const TIMESTAMP_LEVEL = re(
  `^${S}*\\[?${D}{4}-${D}{2}-${D}{2}[T ]${D}{2}:${D}{2}:${D}{2}(?:[.,]${D}{1,9})?(?:Z|[+-]${D}{2}:?${D}{2})?\\]?${S}+\\[?(${LEVEL_TOKENS})\\]?(?:${S}|$)`,
);

/** The token first on the line (tracing without a timer, `INFO:` prefixes). */
const LEADING_LEVEL = re(`^${S}*\\[?(${LEVEL_TOKENS})\\]?(?:[\\p{White_Space}:]|$)`);

/** `level=error` (logfmt) / `"level":"error"` (JSON), any case. */
const KEYED_LEVEL = re(
  `(?:${B_START}level=|"level"${S}*:${S}*)"?(error|err|fatal|critical|crit|panic|warning|warn|info|notice|debug|trace)${B_END}`,
  "iu",
);

const words = (alts: string): RegExp => re(`${B_START}(?:${alts})${B_END}`);
const ERROR_WORDS = words("error|ERROR|Error|fatal|FATAL|Fatal|panic|panicked|PANIC|Traceback|FAILED");
const WARN_WORDS = words("warn|WARN|Warn|warning|Warning|WARNING|deprecated|Deprecated|DEPRECATED");
const DEBUG_WORDS = words("DEBUG|TRACE");

function levelOfToken(token: string): LogLevel {
  switch (token.toUpperCase()) {
    case "ERROR":
    case "ERRO":
    case "ERR":
    case "FATAL":
    case "CRITICAL":
    case "CRIT":
    case "PANIC":
      return "error";
    case "WARNING":
    case "WARN":
    case "WRN":
      return "warn";
    case "DEBUG":
    case "DBG":
    case "TRACE":
    case "TRC":
      return "debug";
    default:
      return "info"; // INFO, INF, NOTICE
  }
}

/** The level a structured logger declared in a column of its own, if the line has one. */
function declaredLevel(line: string): LogLevel | null {
  for (const rule of [TIMESTAMP_LEVEL, LEADING_LEVEL, KEYED_LEVEL]) {
    const m = rule.exec(line);
    if (m !== null) return levelOfToken(m[1]);
  }
  return null;
}

/** Guess a level for one ANSI-stripped output line. Pure; mirrors Rust's `classify_level`. */
export function classifyLine(line: string): LogLevel {
  const os = OS_LOG_COMPACT.exec(line);
  if (os !== null) {
    if (os[1] === "E" || os[1] === "F" || os[1] === "Fa") return "error";
    if (os[1] === "Df" || os[1] === "Db" || os[1] === "D") return "debug";
    return "info"; // I, A
  }
  const declared = declaredLevel(line);
  if (declared !== null) return declared;
  // `✗` is not a word character, so no boundary can anchor it — checked on its own.
  if (ERROR_WORDS.test(line) || line.includes("✗")) return "error";
  if (WARN_WORDS.test(line)) return "warn";
  if (DEBUG_WORDS.test(line)) return "debug";
  return "info";
}
