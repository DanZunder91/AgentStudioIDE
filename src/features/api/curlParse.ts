/** Pasted curl to request parts; hand-rolled, no dependency (zero-install). Reads bash quoting
 * incl. $'…' (DevTools' bash export); unmodelled boolean flags are ignored. The Windows cmd and
 * PowerShell forms are emulated in curlShells.ts, picked by detectCurlDialect. */

import { legacyNativeArgv, tokenizeCmd, tokenizePowerShell } from "./curlShells";

/** Our PowerShell export's wrapper: makes 7.3+ pass args the way 5.1 does (5.1 ignores the
 * variable), so reading it back means "5.1 rules, exactly". */
const PS_LEGACY_WRAPPER =
  /^\s*&\s*\{\s*\$PSNativeCommandArgumentPassing\s*=\s*'Legacy'\s*;([\s\S]*)\}\s*$/i;

/** A leading curl / curl.exe FOLLOWED by whitespace (so a URL or a half-typed word never
 * triggers), or our PowerShell export's wrapper around one. */
export function isCurlCommand(text: string): boolean {
  const inner = PS_LEGACY_WRAPPER.exec(text)?.[1] ?? text;
  return /^\s*curl(?:\.exe)?\s/i.test(inner);
}

/** DevTools' "Copy as PowerShell", recognised only so the paste can say what to copy instead.
 * Deliberately not parsed: a different object model, and the two cURL forms DevTools offers
 * beside it already paste straight in. */
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

/** Read from the FIRST line only (a body can hold anything). cmd: ^"…^" or a " ^" continuation,
 * untrusted when the line holds ' (a bash body may end in " ^"). powershell: our wrapper, a
 * backtick continuation, or curl.exe. bash: everything else. */
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

/** Reads a bash $'…' from just past "$'"; DevTools' bash export uses it for any value holding
 * ', ! or a control char. An escape bash does not define stays as typed, backslash included. */
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

/** Shell tokens, quotes stripped: '…' literal, $'…' ANSI-C, "…" with \ escapes, \-newline
 * continuations and bare \ escapes; unquoted runs split on whitespace. */
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

/** Short flags that take a value. The consume-only ones matter: an unmodelled flag's value would
 * otherwise win the positional-URL slot (curl -o out.json https://api). */
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

/** Expands bundled (-sX POST), attached (-XPOST) and --flag=value forms to one token each, so a
 * flag's value never wins the positional-URL slot. In a bundle the first value-taking flag claims
 * the rest of the token, or the next token when empty (curl's rule). */
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
    // A lone "-" (stdin) returned above, so every token here emits at least one letter.
  }
  return out;
}

/** A token naming a scheme is the better positional-URL candidate: "POST" can never win this. */
function looksLikeUrl(tok: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(tok);
}

/** "Name;" is curl's empty-value header (a bare "Name:" removes the header instead); DevTools
 * writes it for every empty one. */
function splitHeader(raw: string): ParsedHeader | null {
  const idx = raw.indexOf(":");
  if (idx <= 0) {
    const name = raw.endsWith(";") ? raw.slice(0, -1).trim() : "";
    return name === "" ? null : { name, value: "" };
  }
  return { name: raw.slice(0, idx).trim(), value: raw.slice(idx + 1).trim() };
}

/** The argv after the program name, read with the source shell's quoting. CRs never matter to
 * bash or PowerShell (cmd drops them), so a CRLF paste still continues its lines. */
function shellArgs(input: string): string[] {
  const text = input.replace(/\r\n/g, "\n");
  const dialect = detectCurlDialect(text);
  let argv: string[];
  if (dialect === "cmd") {
    argv = tokenizeCmd(text);
  } else if (dialect === "powershell") {
    const wrapped = PS_LEGACY_WRAPPER.exec(text);
    const words = tokenizePowerShell(wrapped ? wrapped[1] : text);
    // Inside our wrapper every arg went out by 5.1 rules, so read them back that way. Outside,
    // CRT quoting applies only to a word carrying \" (the 5.1 idiom); '{"a":1}' stays as written.
    argv = wrapped
      ? legacyNativeArgv(words)
      : words.flatMap((w) => (w.includes('\\"') ? legacyNativeArgv([w]) : [w]));
  } else {
    argv = tokenizeCurl(text);
  }
  return argv.length > 0 && /^curl(?:\.exe)?$/i.test(argv[0]) ? argv.slice(1) : argv;
}

/** null when there is no URL. Method: explicit -X, else POST when a body is present, else GET. */
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
