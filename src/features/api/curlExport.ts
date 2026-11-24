/**
 * curlExport — turn the API client's current request into a paste-ready `curl`
 * command (a Postman-style copy-as-curl). This is the exact
 * inverse of `curlParse.ts`: whatever this builds, `parseCurl` must read back
 * unchanged — the round-trip is tested against the REAL parser, not a copy of
 * its rules.
 *
 * 🔴 Secret-safety: `resolve` splices real environment values into
 * the output, so the returned string can carry live secrets. It exists for the
 * CLIPBOARD, and only the clipboard — never call this on a persistence path.
 * Saved collections keep `{{VAR}}` literal; this module must never feed them.
 *
 * Shell safety is the whole job. Every value rides inside single quotes, where
 * bash and zsh treat EVERYTHING as literal — `$`, backticks, newlines, unicode,
 * and `!` (history expansion does not fire inside single quotes). The one
 * character a single-quoted run cannot hold is the single quote itself, handled
 * with the classic `'\''` idiom: close the quoted run, emit one
 * backslash-escaped literal `'`, reopen. The output is ONE line — these get
 * pasted into terminals and chat windows, where a trailing-`\` line wrap
 * gets mangled — so no backslash-newline continuations are ever added. (A
 * newline INSIDE a quoted body is a different thing: legal shell, kept
 * verbatim.)
 *
 * Windows. None of that survives a Windows shell: PowerShell takes
 * `'…'` literally but then re-quotes native arguments by its own 5.1 rules, and
 * cmd.exe knows no single quotes at all; neither continues a line with `\`. So
 * the same request can also be written for cmd (`^"…^"`, carets) or PowerShell
 * (`curl.exe`, C-runtime quoting inside `'…'`) — see `buildCurl`'s `shell`. The
 * bash form is untouched, byte for byte; each Windows form round-trips through
 * `parseCurl` exactly like it, and was run for real (cmd.exe, Windows PowerShell
 * 5.1, System32 curl.exe) before its rules were written down.
 */

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

/**
 * Wrap `s` so it pastes into bash/zsh verbatim-safe. Single quotes make every
 * character literal; an embedded `'` becomes `'\''`. `tokenizeCurl` reads that
 * idiom back as one token (quoted run + bare escape + quoted run), which is
 * what keeps the round-trip exact.
 */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * The request as curl will be told it — resolved, filtered, method decided.
 *
 * Order matters: resolve FIRST, quote SECOND (in each renderer) — a resolved
 * secret containing a quote must land inside the quoting, not break out of it.
 */
function planCurl(request: CurlableRequest, resolve: (text: string) => string): CurlPlan {
  // Uppercase to match curl convention AND `parseCurl`'s own normalisation, so
  // the round-trip is exact whatever the editor stored. An all-blank method is
  // read as GET rather than emitting a nonsense `-X ''`.
  const method = request.method.trim().toUpperCase() || "GET";
  const body = request.body === null || request.body === "" ? null : resolve(request.body);
  return {
    // `-X GET` is omitted for a plain GET — it is curl's default, and `parseCurl`
    // infers GET when no body is present — EXCEPT when a GET carries a body:
    // `--data` makes curl itself (and the parser's inference) switch to POST, so
    // that one case must say `-X GET` out loud or the round-trip comes back POST.
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

/**
 * curl globs `[ ] { }` in a URL — `?filter[a]=1` is a "bad range" error, and an
 * unresolved `{{VAR}}` a broken set — unless each is backslash-escaped, which curl
 * strips again before sending (DevTools escapes them the same way). The Windows
 * forms do this; the bash form still does not (a known gap in the bash shape).
 */
const globEscape = (url: string) => url.replace(/[[\]{}]/g, "\\$&");

/**
 * The Microsoft C runtime's quoting for one argument: wrap in `"`, write each
 * literal quote as `quote`, and double a backslash run only where the runtime
 * reads it — right before a quote, or before the closing one. Everywhere else a
 * backslash is literal, so it is left alone (DevTools doubles every one, and the
 * server then receives two — measured).
 */
function crtQuote(s: string, quote: string): string {
  return `"${s.replace(/(\\*)"/g, `$1$1${quote}`).replace(/(\\+)$/, "$1$1")}"`;
}

/**
 * cmd.exe. The argument is C-runtime-quoted with `\"`, then every character cmd
 * could act on gets a `^` — the quotes included, so cmd never enters its own
 * quoted mode and every caret is honoured. Backslashes stay bare on purpose:
 * they mean nothing to cmd, and a bare one is how `parseCurl` tells our command
 * from DevTools' doubled `^\^\`. `%` before a name character is followed by a `^`
 * so `%PATH%` can never expand (DevTools' trick; verified live). A newline is `^`
 * plus TWO newlines: the first continues the line, the second is the escaped,
 * literal one. cmd cannot carry a CR at all — it deletes every one it reads — so a
 * CR becomes that newline (a textarea never produces one anyway).
 */
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

/**
 * What Windows PowerShell 5.1 must be handed so curl.exe receives exactly `value`.
 *
 * 5.1 wraps an argument in `"` when it holds whitespace after an even number of
 * quotes, never escapes what is inside, and drops an empty argument (all measured).
 *   • No quote, not empty: pass it as is. With whitespace 5.1 will wrap it, so a
 *     trailing backslash run is doubled to survive the closing quote it adds.
 *   • A quote, or empty: quote it ourselves, writing each literal quote as `""` (a
 *     literal quote inside quotes, to the C runtime). That keeps the quote count
 *     odd at every space — so 5.1 never adds a second pair — where `\"` would
 *     flip it and split the JSON at its first space.
 */
function legacyArg(value: string): string {
  if (value !== "" && !value.includes('"')) {
    return /\s/.test(value) ? value.replace(/(\\+)$/, "$1$1") : value;
  }
  return crtQuote(value, '""');
}

/**
 * PowerShell. `curl.exe`, never `curl` — in a stock 5.1 window `curl` is an alias
 * for Invoke-WebRequest. Each value is `legacyArg`-encoded and then single-quoted
 * (`''` for a `'`), where PowerShell expands nothing: no `$`, no backtick.
 *
 * When any value needed that encoding, the command is wrapped in a scriptblock
 * that sets `$PSNativeCommandArgumentPassing = 'Legacy'` — scoped to the block,
 * ignored by 5.1, and what makes PowerShell 7.3+ pass the arguments the 5.1 way
 * instead of escaping our quotes a second time. (7.x is reasoned from its docs,
 * not run here: the VM has only 5.1.)
 */
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

/**
 * Build a shell-safe curl command from `request`, written for `shell` (bash by
 * default — the only form before Windows, and still every call site's on macOS
 * and Linux). `resolve` is the send path's own `{{VAR}}` substitution, applied to
 * the url, header VALUES and body — never to header names: a `{{VAR}}` header name
 * is a config error, not a secret seam, and leaving it literal keeps the mistake
 * visible in the pasted command instead of silently exporting a wrong-named header.
 */
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
