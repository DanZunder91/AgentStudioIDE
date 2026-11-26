/** cmd.exe / PowerShell 5.1 emulation, in order: the shell (carets, quotes, continuations, 5.1
 * re-quoting), then the MS C runtime's argv split. Measured on Windows 11. DevTools' cmd export
 * doubles each backslash not before a quote; careted-only runs are halved; a bare \ is CRT's. */

/** One character after cmd.exe's caret pass, remembering whether a `^` escaped it. */
export interface ShellChar {
  c: string;
  caret: boolean;
}

/** cmd.exe's pass over the FIRST command: drops CRs; outside quotes ^ escapes the next char, and
 * a line-ending ^ joins and escapes the next line's first char. An unescaped newline, &, |, < or >
 * ends the command ("Copy all as cURL (cmd)" joins commands with " &"). */
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

/** The UCRT (post-2008) argv split curl.exe uses, plus the DevTools backslash correction above.
 * Args end at an unquoted space or tab; a newline is ordinary text. */
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

/** PowerShell's native-command split, as pasted curls use it: '…' literal ('' is one quote), "…"
 * with backtick escapes and "", $name never expanded; a bare backtick escapes or continues the
 * line. An unquoted newline, ; or | ends the statement. */
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

/** 5.1 quotes an arg holding whitespace after an EVEN number of " (escaped ones count).
 * Measured: {\"a\":\"x y\"} has three quotes before its space, so it goes out bare. */
function needsQuotes51(arg: string): boolean {
  let quotes = 0;
  for (const c of arg) {
    if (c === '"') quotes++;
    else if (/\s/.test(c) && quotes % 2 === 0) return true;
  }
  return false;
}

/** 5.1 drops empty args (measured), re-quotes the rest by needsQuotes51 and joins them; the CRT
 * re-splits that line, so one string in can be several out. */
export function legacyNativeArgv(args: readonly string[]): string[] {
  const line = args
    .filter((a) => a !== "")
    .map((a) => (needsQuotes51(a) ? `"${a}"` : a))
    .join(" ");
  return crtSplit(Array.from(line, (c) => ({ c, caret: false })));
}
