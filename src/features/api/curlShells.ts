/**
 * curlShells — what cmd.exe and Windows PowerShell 5.1 do to a pasted command line
 * before curl.exe ever sees it. `curlParse` reads the bash form itself; this module
 * reads the two Windows forms, so a Windows user's paste lands as the request they
 * meant (the API client must fully work on Windows).
 *
 * Two layers, and the order is the whole point:
 *
 *   1. **The shell.** cmd.exe strips `^` carets (outside its own quotes), joins
 *      `^`-continued lines and stops at an unescaped `&`, `|`, `<` or `>`.
 *      PowerShell unquotes `'…'` / `"…"` and joins backtick-continued lines, then —
 *      in 5.1 — re-quotes each argument by its own legacy rule.
 *   2. **The C runtime.** curl.exe receives ONE command-line string and splits it
 *      into argv with the Microsoft C runtime's rules (`"` toggles quoting,
 *      backslashes only escape a `"`, `""` inside quotes is a literal quote).
 *
 * Everything here was checked against the real thing on Windows 11 (cmd.exe,
 * Windows PowerShell 5.1.26100, System32 curl.exe 8.22) before it was written:
 *
 *   • DevTools' "Copy as cURL (cmd)" — both the `\"` generation (to 2026-08) and
 *     the `""` one (Chromium main, 2026-11) — DOUBLES every backslash that is not
 *     before a quote: `{"a":"x\ny"}` reaches the server as `{"a":"x\\ny"}`. That is
 *     a DevTools bug, and the paste wants the browser's request, not the bug. Every
 *     backslash DevTools writes is caret-escaped (`^\`), so a run made only of
 *     careted backslashes that is not before a quote is read back at half length.
 *     A bare `\` — ours, or a human's — keeps the C runtime's meaning exactly.
 *   • PowerShell 5.1 wraps an argument in quotes when it holds whitespace after an
 *     EVEN number of `"` — counting escaped ones too — and silently drops an empty
 *     argument. `curl.exe --data-raw '{\"a\":\"x y\"}'` sends `{"a":"x`.
 *
 * Pure functions, no DOM, no Tauri: the risky logic, tested at the unit level.
 */

/** One character after cmd.exe's caret pass, remembering whether a `^` escaped it. */
export interface ShellChar {
  c: string;
  caret: boolean;
}

/**
 * cmd.exe's own pass over the FIRST command of a pasted line.
 *
 * CRs go first (cmd drops every one). Outside cmd's quotes a `^` escapes the next
 * character; a `^` that ends a line joins the next line and escapes ITS first
 * character — which is how DevTools gets a newline into an argument (`^` LF LF).
 * A plain `"` toggles cmd's quoting (inside it carets are literal) and is kept for
 * the C runtime. An unescaped newline, `&`, `|`, `<` or `>` ends the command:
 * "Copy all as cURL (cmd)" joins commands with ` &`, and the first one is the paste.
 */
export function cmdCaretPass(input: string): ShellChar[] {
  const s = input.replace(/\r/g, "");
  const out: ShellChar[] = [];
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') {
      quoted = !quoted;
      out.push({ c, caret: false });
    } else if (!quoted && c === "^") {
      // `^` LF: the line continues, and the next line's first character is the
      // escaped one. A caret at the very end escapes nothing.
      const j = s[i + 1] === "\n" ? i + 2 : i + 1;
      if (j < s.length) out.push({ c: s[j], caret: true });
      i = j;
    } else if (c === "\n" || (!quoted && "&|<>".includes(c))) {
      break;
    } else {
      out.push({ c, caret: false });
    }
  }
  return out;
}

/**
 * The Microsoft C runtime's command-line split (the post-2008 UCRT rules curl.exe
 * is built with), plus the one DevTools correction described at the top of this
 * file. Arguments end at an unquoted space or tab; a newline is ordinary text.
 */
export function crtSplit(chars: readonly ShellChar[]): string[] {
  const args: string[] = [];
  const n = chars.length;
  const isBlank = (k: number) => chars[k].c === " " || chars[k].c === "\t";
  let i = 0;
  for (;;) {
    while (i < n && isBlank(i)) i++;
    if (i >= n) return args;
    let cur = "";
    let quoted = false;
    while (i < n) {
      let j = i;
      while (j < n && chars[j].c === "\\") j++;
      const slashes = j - i;
      if (j < n && chars[j].c === '"') {
        // Backslashes before a quote: each pair is one backslash, and an odd one
        // out makes the quote literal. An even run leaves the quote to toggle —
        // except `""` inside quotes, which is a literal quote that stays inside.
        cur += "\\".repeat(slashes >> 1);
        if (slashes % 2 === 1) {
          cur += '"';
          i = j + 1;
        } else if (quoted && j + 1 < n && chars[j + 1].c === '"') {
          cur += '"';
          i = j + 2;
        } else {
          quoted = !quoted;
          i = j + 1;
        }
      } else if (slashes > 0) {
        // Not before a quote: literal — unless DevTools doubled them (every one
        // caret-escaped, an even count), in which case the browser sent half.
        const doubled = slashes % 2 === 0 && chars.slice(i, j).every((x) => x.caret);
        cur += "\\".repeat(doubled ? slashes / 2 : slashes);
        i = j;
      } else if (!quoted && isBlank(i)) {
        break;
      } else {
        cur += chars[i].c;
        i++;
      }
    }
    args.push(cur);
  }
}

/** A cmd.exe command line → the argv curl.exe receives (program name included). */
export function tokenizeCmd(input: string): string[] {
  return crtSplit(cmdCaretPass(input));
}

/** PowerShell's backtick escapes inside a double-quoted string. */
const PS_ESCAPES: Readonly<Record<string, string>> = {
  "0": "\0",
  a: "\x07",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
};

/**
 * PowerShell's argument-mode split for a native command — the subset a pasted curl
 * uses. `'…'` is literal (`''` is one quote); `"…"` takes backtick escapes and `""`,
 * and leaves `$name` as typed (we never expand a variable from a paste); a backtick
 * outside quotes escapes the next character, or continues the line before a
 * newline. Adjacent pieces form one argument. An unquoted newline, `;` or `|` ends
 * the statement — whatever follows is not this command's.
 */
export function tokenizePowerShell(input: string): string[] {
  const s = input.replace(/\r/g, "");
  const tokens: string[] = [];
  let cur = "";
  let started = false;
  const flush = () => {
    if (started) tokens.push(cur);
    cur = "";
    started = false;
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "`") {
      if (s[i + 1] === "\n") flush();
      else if (i + 1 < s.length) {
        cur += s[i + 1];
        started = true;
      }
      i += 2;
    } else if (c === "'") {
      started = true;
      i++;
      while (i < s.length && !(s[i] === "'" && s[i + 1] !== "'")) {
        cur += s[i];
        i += s[i] === "'" ? 2 : 1;
      }
      i++;
    } else if (c === '"') {
      started = true;
      i++;
      while (i < s.length && !(s[i] === '"' && s[i + 1] !== '"')) {
        if (s[i] === "`" && i + 1 < s.length) {
          cur += PS_ESCAPES[s[i + 1]] ?? s[i + 1];
          i += 2;
        } else {
          cur += s[i];
          i += s[i] === '"' ? 2 : 1;
        }
      }
      i++;
    } else if (c === "\n" || c === ";" || c === "|") {
      break;
    } else if (/\s/.test(c)) {
      flush();
      i++;
    } else {
      cur += c;
      started = true;
      i++;
    }
  }
  flush();
  return tokens;
}

/**
 * Windows PowerShell 5.1's legacy rule for re-quoting one native argument: quote
 * it when it holds whitespace after an EVEN number of `"` — every `"` counts, a
 * backslash-escaped one included. (Measured: `{\"a\":\"x y\"}` has three quotes
 * before its space, so it goes out bare and the C runtime splits it.)
 */
function needsQuotes51(arg: string): boolean {
  let quotes = 0;
  for (const c of arg) {
    if (c === '"') quotes++;
    else if (/\s/.test(c) && quotes % 2 === 0) return true;
  }
  return false;
}

/**
 * The argv curl.exe receives when Windows PowerShell 5.1 passes these argument
 * strings: empty ones dropped (measured), the rest re-quoted by `needsQuotes51`,
 * joined with spaces and split again by the C runtime. One string in can be
 * several out — exactly the 5.1 behaviour that breaks naive JSON bodies.
 */
export function legacyNativeArgv(args: readonly string[]): string[] {
  const line = args
    .filter((a) => a !== "")
    .map((a) => (needsQuotes51(a) ? `"${a}"` : a))
    .join(" ");
  return crtSplit(Array.from(line, (c) => ({ c, caret: false })));
}
