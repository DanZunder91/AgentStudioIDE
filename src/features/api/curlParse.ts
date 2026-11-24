/**
 * curlParse — turn a pasted `curl` command into the API client's HTTP request parts
 * (cURL import): paste a curl, get method/url/headers/body filled in,
 * Postman-style. Frontend-only, hand-rolled + fully tested — no external tool, no
 * new dependency (the zero-install principle).
 *
 * Handles the flags everyday curls use: `-X/--request`, `-H/--header` (repeatable),
 * `--url` / a positional URL, `-d/--data[-raw|-binary|-ascii|-urlencode]` (repeatable
 * → joined with `&`, and implies POST when no method is given), `-u/--user` → a
 * Basic `Authorization` header, `-b/--cookie name=value` → a `Cookie` header. Boolean
 * flags it doesn't model (`-L/--location`, `--compressed`, `-k`, `-s`, …) are
 * ignored. Shell quoting is respected: single quotes (literal), `$'…'` (bash's
 * ANSI-C form, which DevTools' "Copy as cURL (bash)" uses for any `'` or `!`), double
 * quotes (with `\` escapes), backslash line-continuations, and bare backslash escapes.
 *
 * Windows: the same paste also reads DevTools' "Copy as cURL (cmd)"
 * (`^"…^"`, `^` continuations) and a PowerShell `curl.exe` command (backtick
 * continuations) — the shell emulation lives in `curlShells.ts`, and
 * `detectCurlDialect` picks which reading applies.
 */

import { legacyNativeArgv, tokenizeCmd, tokenizePowerShell } from "./curlShells";

/**
 * The scriptblock our PowerShell "Copy as cURL" wraps a command in when an argument
 * needed the C runtime's quoting: it makes PowerShell 7.3+ pass arguments the way
 * 5.1 does (5.1 ignores the variable). Reading it back means "5.1 rules, exactly".
 */
const PS_LEGACY_WRAPPER =
  /^\s*&\s*\{\s*\$PSNativeCommandArgumentPassing\s*=\s*'Legacy'\s*;([\s\S]*)\}\s*$/i;

/**
 * Does `text` look like a curl command (so the URL field should auto-convert it)?
 * True only for a leading `curl` (or `curl.exe`) FOLLOWED by whitespace — so a real
 * URL, or the word "curl" mid-typing without args, never triggers prematurely — or
 * for our own PowerShell export's legacy-passing wrapper around one.
 */
export function isCurlCommand(text: string): boolean {
  const inner = PS_LEGACY_WRAPPER.exec(text)?.[1] ?? text;
  return /^\s*curl(?:\.exe)?\s/i.test(inner);
}

/**
 * DevTools' "Copy as PowerShell" — `Invoke-WebRequest`, often after a
 * `$session = New-Object …WebRequestSession` block. Recognised so the paste can say
 * what to copy instead, rather than landing in the URL field as junk.
 *
 * Deliberately NOT parsed: it is a different object model (cookies on a session
 * object, `-ContentType` split from `-Headers @{…}`, bodies as
 * `[Text.Encoding]::UTF8.GetBytes(…)`, `$([char]N)` escapes) — a second PowerShell
 * evaluator for information both cURL forms DevTools offers right beside it
 * already carry, and both of those paste straight in.
 */
export function isPowerShellWebRequest(text: string): boolean {
  return /^\s*(?:\$session\s*=\s*New-Object\s+Microsoft\.PowerShell\.Commands\.WebRequestSession\b|Invoke-(?:WebRequest|RestMethod)\s)/i.test(
    text,
  );
}

/** What the API client says when it is handed an `Invoke-WebRequest` paste. */
export const POWERSHELL_PASTE_HINT =
  "That is “Copy as PowerShell” (Invoke-WebRequest), which the API client does not read. " +
  "In DevTools, use “Copy as cURL (cmd)” or “Copy as cURL (bash)” instead — both paste straight in.";

/** Which shell's quoting a pasted curl command was written for. */
export type CurlDialect = "bash" | "cmd" | "powershell";

/**
 * Which shell wrote this curl? Read from the FIRST line only — the body, which can
 * hold anything, always comes later.
 *
 *   • cmd — DevTools wraps arguments in `^"…^"` (the URL is the first or second
 *     argument), or the line continues with ` ^`. Older DevTools quoted plain
 *     `"…"`, so the continuation is the only sign; it is not trusted when the line
 *     holds a `'`, because a bash body that opens on line one could end it in ` ^`.
 *   • powershell — our legacy-passing wrapper, a backtick continuation, or the
 *     program spelled `curl.exe` (how PowerShell users dodge 5.1's `curl` alias).
 *   • bash — everything else, which keeps every pre-Windows paste reading as before.
 */
export function detectCurlDialect(text: string): CurlDialect {
  if (PS_LEGACY_WRAPPER.test(text)) return "powershell";
  const firstLine = text.trimStart().split(/\r?\n/, 1)[0];
  if (/^curl(?:\.exe)?\s+(?:\S+\s+)?\^"/i.test(firstLine)) return "cmd";
  if (/\s\^$/.test(firstLine) && !firstLine.includes("'")) return "cmd";
  if (/\s`$/.test(firstLine) || /^curl\.exe\s/i.test(firstLine)) return "powershell";
  return "bash";
}

/** One parsed header (name/value, order-preserving — duplicates allowed). */
export interface ParsedHeader {
  name: string;
  value: string;
}

/** The request parts extracted from a curl command. `body` is null when none. */
export interface ParsedCurl {
  method: string;
  url: string;
  headers: ParsedHeader[];
  body: string | null;
}

/** Flags that take a following value we care about. */
const DATA_FLAGS = new Set([
  "-d",
  "--data",
  "--data-raw",
  "--data-ascii",
  "--data-binary",
  "--data-urlencode",
]);

/** The single-character escapes bash's `$'…'` understands (DevTools uses `\\ \' \n \r`). */
const ANSI_C_ESCAPES: Readonly<Record<string, string>> = {
  "\\": "\\",
  "'": "'",
  '"': '"',
  "?": "?",
  a: "\x07",
  b: "\b",
  e: "\x1b",
  E: "\x1b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
};

/** How many hex digits each numeric `$'…'` escape may take. */
const ANSI_C_HEX: Readonly<Record<string, number>> = { x: 2, u: 4, U: 8 };

/**
 * Read a bash `$'…'` string starting just past its `$'`; returns the text and the
 * index after the closing quote. DevTools' bash export switches to this form for
 * any value holding a `'`, a `!` or a control character — so a JSON body saying
 * "it's" arrives as `$'{"note":"it\'s"}'`, which plain single-quote reading tore in
 * half. An escape bash does not define stays as typed, backslash included.
 */
function readAnsiC(s: string, start: number): { text: string; end: number } {
  let i = start;
  let text = "";
  while (i < s.length && s[i] !== "'") {
    if (s[i] !== "\\" || i + 1 >= s.length) {
      text += s[i];
      i++;
      continue;
    }
    const e = s[i + 1];
    const width = ANSI_C_HEX[e];
    const hex = width === undefined ? null : new RegExp(`^[0-9a-fA-F]{1,${width}}`).exec(s.slice(i + 2));
    if (hex) {
      text += String.fromCodePoint(parseInt(hex[0], 16));
      i += 2 + hex[0].length;
    } else {
      text += ANSI_C_ESCAPES[e] ?? `\\${e}`;
      i += 2;
    }
  }
  return { text, end: i + 1 };
}

/**
 * Split a curl command into shell-style tokens (quotes stripped). Respects single
 * quotes (fully literal), `$'…'` (ANSI-C escapes), double quotes (with `\` escapes),
 * `\`-newline continuations, and bare `\` escapes; unquoted runs split on whitespace.
 */
export function tokenizeCurl(input: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let started = false; // distinguishes an empty quoted token "" from no token
  let i = 0;
  const s = input;
  while (i < s.length) {
    const c = s[i];
    if (c === "$" && s[i + 1] === "'") {
      const ansi = readAnsiC(s, i + 2);
      cur += ansi.text;
      started = true;
      i = ansi.end;
      continue;
    }
    if (c === "\\" && s[i + 1] === "\n") {
      i += 2; // line continuation — drop the backslash + newline
      continue;
    }
    if (c === "\\" && i + 1 < s.length) {
      cur += s[i + 1]; // bare escape — take the next char literally
      started = true;
      i += 2;
      continue;
    }
    if (c === "'") {
      started = true;
      i++;
      while (i < s.length && s[i] !== "'") {
        cur += s[i];
        i++;
      }
      i++; // skip closing quote
      continue;
    }
    if (c === '"') {
      started = true;
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === "\\" && i + 1 < s.length) {
          cur += s[i + 1];
          i += 2;
        } else {
          cur += s[i];
          i++;
        }
      }
      i++;
      continue;
    }
    if (/\s/.test(c)) {
      if (started) {
        tokens.push(cur);
        cur = "";
        started = false;
      }
      i++;
      continue;
    }
    cur += c;
    started = true;
    i++;
  }
  if (started) tokens.push(cur);
  return tokens;
}

/**
 * Short flags that take a VALUE — the ones we model, plus ones we only consume.
 *
 * 🔴 The consume-only half is not padding. The loop below treats the first token
 * that is not a flag as the positional URL, so an unmodelled value-taking flag
 * donates its value to the URL: `curl -o out.json https://api` would have opened
 * a request to `out.json`. Consuming the value is what stops that.
 */
const SHORT_WITH_VALUE = new Set([
  // modelled
  "X", "H", "d", "u",
  // consumed so their value is never mistaken for the URL
  "A", "b", "c", "C", "D", "E", "F", "K", "m", "o", "P", "Q", "r", "t", "T", "U",
  "w", "x", "y", "Y", "z",
]);

/** The single-letter flags that map onto one we model. */
const SHORT_TO_LONG: Record<string, string> = {
  X: "-X",
  H: "-H",
  d: "-d",
  u: "-u",
};

/**
 * Normalise curl's argument forms into one token per flag and one per value.
 *
 * 🔴 **The `-sX` paste.** `curl -sX POST http://…` filled the URL
 * field with the word **`POST`**. `-sX` is two BUNDLED short flags — `-s` and
 * `-X` — which the old loop saw as one unknown flag and skipped, so `POST` became
 * the first non-flag token and won the positional-URL slot; the real URL arrived
 * second and was dropped. Bundling is ordinary curl (and ordinary POSIX), and it
 * is what every "copy as curl" snippet in a README uses.
 *
 * Three forms are expanded here, all of which reached the old loop as one opaque
 * token:
 *   • `-sX POST`  → `-s` `-X` `POST`   (bundle; a value-taking flag ends it)
 *   • `-XPOST`    → `-X` `POST`        (value attached to the flag)
 *   • `--request=POST` → `--request` `POST`
 *
 * Within a bundle each letter is a boolean until one takes a value; that flag
 * claims the REST of the token, or the next token when the rest is empty. That is
 * curl's own rule, which is why `-H'Accept: x'` (no space) also lands correctly.
 */
export function normalizeCurlFlags(tokens: string[]): string[] {
  const out: string[] = [];
  for (const tok of tokens) {
    // `--flag=value` — split on the FIRST `=`, so a value containing `=` survives.
    if (tok.startsWith("--")) {
      const eq = tok.indexOf("=");
      if (eq > 2) {
        out.push(tok.slice(0, eq), tok.slice(eq + 1));
      } else {
        out.push(tok);
      }
      continue;
    }
    // A bare `-` is curl's stdin placeholder, not a flag; leave it alone.
    if (!tok.startsWith("-") || tok === "-") {
      out.push(tok);
      continue;
    }
    // A short-flag run: walk it letter by letter.
    for (let i = 1; i < tok.length; i++) {
      const letter = tok[i];
      if (SHORT_WITH_VALUE.has(letter)) {
        out.push(SHORT_TO_LONG[letter] ?? `-${letter}`);
        const rest = tok.slice(i + 1);
        // Empty rest → the value is the NEXT token, which is already in place.
        if (rest !== "") out.push(rest);
        break;
      }
      out.push(`-${letter}`);
    }
    // No trailing "nothing was claimed" guard: a lone `-` is curl's stdin
    // placeholder and already returned above, so a token that reaches this loop
    // always has at least one letter to emit. The guard that used to sit here was
    // unreachable, and the coverage gate is what said so.
  }
  return out;
}

/**
 * Does `tok` carry a URL scheme? Used to pick the positional URL.
 *
 * Belt-and-braces beside `normalizeCurlFlags`: even if some future flag form slips
 * an unexpected bare word into the argument list, a token that names a scheme is a
 * far better URL candidate than one that does not. `POST` would never win this.
 */
function looksLikeUrl(tok: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(tok);
}

/**
 * A header string `Name: value` → a header, or null when it has no `:` separator.
 * `Name;` is curl's spelling of a header with an EMPTY value (a bare `Name:` tells
 * curl to remove the header instead) — DevTools writes it for every empty one.
 */
function splitHeader(raw: string): ParsedHeader | null {
  const idx = raw.indexOf(":");
  if (idx <= 0) {
    const name = raw.endsWith(";") ? raw.slice(0, -1).trim() : "";
    return name === "" ? null : { name, value: "" };
  }
  return { name: raw.slice(0, idx).trim(), value: raw.slice(idx + 1).trim() };
}

/**
 * The argv after the program name, read with the quoting rules of the shell the
 * command was written for. CRs never matter to bash or PowerShell here (and cmd
 * drops them itself), so a paste carrying Windows line endings continues its lines.
 */
function shellArgs(input: string): string[] {
  const text = input.replace(/\r\n/g, "\n");
  const dialect = detectCurlDialect(text);
  let argv: string[];
  if (dialect === "cmd") {
    argv = tokenizeCmd(text);
  } else if (dialect === "powershell") {
    const wrapped = PS_LEGACY_WRAPPER.exec(text);
    const words = tokenizePowerShell(wrapped ? wrapped[1] : text);
    // Inside our wrapper every argument went out by 5.1's rules, so read them
    // back exactly that way. Outside it, the C runtime's quoting is applied only
    // to a word that plainly carries it (`\"`, the 5.1 idiom) — a word like
    // `'{"a":1}'` is taken as written, which is what its author meant (and what
    // PowerShell 7.3+ sends).
    argv = wrapped
      ? legacyNativeArgv(words)
      : words.flatMap((w) => (w.includes('\\"') ? legacyNativeArgv([w]) : [w]));
  } else {
    argv = tokenizeCurl(text);
  }
  return argv.length > 0 && /^curl(?:\.exe)?$/i.test(argv[0]) ? argv.slice(1) : argv;
}

/**
 * Parse a curl command into request parts, or `null` if it has no URL (nothing
 * usable). A leading `curl` token is optional. Method is inferred: an explicit
 * `-X` wins, else POST when a body is present, else GET.
 */
export function parseCurl(input: string): ParsedCurl | null {
  // Bundled (`-sX POST`), attached (`-XPOST`) and `--flag=value` forms all reach
  // the loop below as one opaque token otherwise — see `normalizeCurlFlags`.
  const tokens = normalizeCurlFlags(shellArgs(input.trim()));

  let method: string | null = null;
  let url: string | null = null;
  let body: string | null = null;
  let globOff = false;
  let cookie: ParsedHeader | null = null;
  const headers: ParsedHeader[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === "-X" || tok === "--request") {
      const v = tokens[++i];
      if (v !== undefined) method = v;
    } else if (tok === "-H" || tok === "--header") {
      const v = tokens[++i];
      const h = v !== undefined ? splitHeader(v) : null;
      if (h) headers.push(h);
    } else if (tok === "--url") {
      const v = tokens[++i];
      if (v !== undefined) url = v;
    } else if (DATA_FLAGS.has(tok)) {
      const v = tokens[++i];
      if (v !== undefined) body = body === null ? v : `${body}&${v}`;
    } else if (tok === "-u" || tok === "--user") {
      const v = tokens[++i];
      if (v !== undefined) headers.push({ name: "Authorization", value: `Basic ${btoa(v)}` });
    } else if (tok === "-b" || tok === "--cookie") {
      // DevTools sends the request's cookies as `-b 'a=1; b=2'`. Without an `=`
      // curl reads the value as a cookie FILE, which is no header at all. Several
      // -b join into one Cookie header, the way curl sends them.
      const v = tokens[++i];
      if (v !== undefined && v.includes("=")) {
        if (cookie) cookie.value += `; ${v}`;
        else headers.push((cookie = { name: "Cookie", value: v }));
      }
    } else if (tok === "-g" || tok === "--globoff") {
      globOff = true;
    } else if (SHORT_WITH_VALUE.has(tok.slice(1)) && tok.length === 2) {
      // A value-taking short flag we don't model (-o, -A, -b, …). Its value is
      // consumed, never left to be mistaken for the positional URL.
      i++;
    } else if (tok.startsWith("-")) {
      // A boolean flag we don't model (-L/--location, --compressed, -k, -s, …). Ignore.
    } else if (url === null || (!looksLikeUrl(url) && looksLikeUrl(tok))) {
      // The positional URL. A later token that actually names a scheme beats an
      // earlier bare word — so a stray argument cannot keep the real URL out.
      url = tok;
    }
  }

  if (url === null) return null;
  if (method === null) method = body !== null ? "POST" : "GET";
  // curl reads `[ ] { }` in a URL as a glob unless they are backslash-escaped,
  // so DevTools escapes them (`?filter\[a\]=1`) — and curl strips the escape
  // before sending. So do we, unless -g turned globbing (and the escape) off.
  if (!globOff) url = url.replace(/\\([[\]{}])/g, "$1");
  return { method: method.toUpperCase(), url, headers, body };
}
