/** Copy-as-curl, the exact inverse of `curlParse.ts` (round-trip tested against the real parser).
 * `resolve` splices live secrets in: the output is for the CLIPBOARD only, never persistence.
 * Always ONE line (pasted into terminals/chat); Windows forms via `buildCurl`'s `shell`. */

/** The request parts the exporter needs — a structural slice of the editor's state. */
export interface CurlableRequest {
  method: string;
  url: string;
  headers: readonly { name: string; value: string; enabled?: boolean }[];
  body: string | null;
}

/** The shell a copied curl command is written for. */
export type CurlShell = "bash" | "cmd" | "powershell";

/** What every shell's command says, before any quoting: one plan, three renderings. */
interface CurlPlan {
  /** `null` when `-X` is left out (a plain GET). */
  method: string | null;
  url: string;
  /** `Name: value` lines, enabled and named ones only, values resolved. */
  headers: string[];
  body: string | null;
}

/** Single-quote for bash/zsh (all literal); an embedded `'` becomes `'\''`, which `tokenizeCurl`
 * reads back as one token, keeping the round-trip exact. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** The request as curl will be told it. Resolve FIRST, quote SECOND (in each renderer), so a
 * resolved secret containing a quote lands inside the quoting. */
function planCurl(request: CurlableRequest, resolve: (text: string) => string): CurlPlan {
  // Uppercase to match curl convention AND `parseCurl`'s own normalisation, so
  // the round-trip is exact whatever the editor stored. An all-blank method is
  // read as GET rather than emitting a nonsense `-X ''`.
  const method = request.method.trim().toUpperCase() || "GET";
  const body = request.body === null || request.body === "" ? null : resolve(request.body);
  return {
    // `-X GET` is omitted (curl's default; `parseCurl` infers it) unless a GET has a body: `--data`
    // switches curl and the parser to POST, so the round-trip needs it said.
    method: method !== "GET" || body !== null ? method : null,
    url: resolve(request.url),
    headers: request.headers
      // Unticked in the UI: not on the wire, not in the copy. A nameless header
      // is noise, not a header.
      .filter((h) => h.enabled !== false && h.name.trim() !== "")
      .map((h) => `${h.name}: ${resolve(h.value)}`),
    body,
  };
}

/** The canonical `-X` shape is a bare token — but only a token-shaped method gets to be bare. */
const isTokenMethod = (method: string) => /^[A-Z]+$/.test(method);

/** bash/zsh: the original, one-line form — unchanged since before Windows. */
function renderBash(p: CurlPlan): string {
  const parts: string[] = ["curl"];
  // Anything but a bare token is quoted: a method string must never be able to
  // smuggle shell syntax past the quoting.
  if (p.method !== null) parts.push("-X", isTokenMethod(p.method) ? p.method : shellQuote(p.method));
  parts.push(shellQuote(p.url));
  for (const h of p.headers) parts.push("-H", shellQuote(h));
  if (p.body !== null) parts.push("--data", shellQuote(p.body));
  return parts.join(" ");
}

/** curl globs `[ ] { }` in a URL unless backslash-escaped (it strips them before sending). The
 * Windows forms escape; the bash form still does not (a known gap). */
const globEscape = (url: string) => url.replace(/[[\]{}]/g, "\\$&");

/** Microsoft C runtime quoting: wrap in `"`, write each literal quote as `quote`, and double a
 * backslash run only before a quote or the closing one (elsewhere a backslash is literal). */
function crtQuote(s: string, quote: string): string {
  return `"${s.replace(/(\\*)"/g, `$1$1${quote}`).replace(/(\\+)$/, "$1$1")}"`;
}

/** cmd.exe: CRT-quoted with `\"`, then `^` before every char cmd could act on (quotes included).
 * Bare backslashes tell ours from DevTools' `^\^\` for `parseCurl`; `%` gets a `^` (no expansion).
 * A newline is `^` + two newlines; a CR becomes a newline (cmd deletes every CR). */
function cmdQuote(value: string): string {
  return crtQuote(value.replace(/\r\n?/g, "\n"), '\\"')
    .replace(/[^\P{ASCII}a-zA-Z0-9\s_\-:=+~'/.,?;*\\]/gu, "^$&")
    .replace(/%(?=[a-zA-Z0-9_])/g, "%^")
    .replace(/\n/g, "^\n\n");
}

/** cmd.exe: `^"…^"` arguments, every one quoted — the method too, as DevTools does. */
function renderCmd(p: CurlPlan): string {
  const parts: string[] = ["curl"];
  if (p.method !== null) parts.push("-X", cmdQuote(p.method));
  parts.push(cmdQuote(globEscape(p.url)));
  for (const h of p.headers) parts.push("-H", cmdQuote(h));
  if (p.body !== null) parts.push("--data-raw", cmdQuote(p.body));
  return parts.join(" ");
}

/** Encode for Windows PowerShell 5.1 → curl.exe (rules measured): no quote and non-empty passes
 * as is (trailing backslashes doubled if 5.1 will wrap it); otherwise self-quote with `""` per
 * literal quote, keeping the quote count odd at every space so 5.1 never adds a second pair. */
function legacyArg(value: string): string {
  if (value !== "" && !value.includes('"')) {
    return /\s/.test(value) ? value.replace(/(\\+)$/, "$1$1") : value;
  }
  return crtQuote(value, '""');
}

/** PowerShell: `curl.exe` (5.1 aliases `curl` to Invoke-WebRequest); values `legacyArg`-encoded,
 * then single-quoted. If any needed encoding, a scriptblock sets `$PSNativeCommandArgumentPassing`
 * to 'Legacy' so 7.3+ passes them the 5.1 way (7.x reasoned from docs, not run). */
function renderPowerShell(p: CurlPlan): string {
  let legacy = false;
  const q = (value: string) => {
    const arg = legacyArg(value);
    if (arg !== value) legacy = true;
    return `'${arg.replace(/'/g, "''")}'`;
  };
  const parts: string[] = ["curl.exe"];
  if (p.method !== null) parts.push("-X", isTokenMethod(p.method) ? p.method : q(p.method));
  parts.push(q(globEscape(p.url)));
  for (const h of p.headers) parts.push("-H", q(h));
  if (p.body !== null) parts.push("--data-raw", q(p.body));
  const command = parts.join(" ");
  return legacy ? `& { $PSNativeCommandArgumentPassing = 'Legacy'; ${command} }` : command;
}

/** Shell-safe curl for `shell` (default bash). `resolve` is the send path's `{{VAR}}` substitution,
 * applied to url, header VALUES and body, never header names (a `{{VAR}}` name is a config error
 * left visible in the pasted command). */
export function buildCurl(
  request: CurlableRequest,
  resolve: (text: string) => string,
  shell: CurlShell = "bash",
): string {
  const plan = planCurl(request, resolve);
  if (shell === "cmd") return renderCmd(plan);
  if (shell === "powershell") return renderPowerShell(plan);
  return renderBash(plan);
}
