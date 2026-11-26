/** Frontend mirror of guard.rs's splitter, needed synchronously in the ⌘⏎ handler: keep the two in
 * sync (the tests share guard.rs's cases). Lexical, never a security boundary. Offsets are UTF-16
 * indices (CM6's); guard.rs counts chars, harmless as every char the lexer reacts to is ASCII. */

/** One statement, trimmed, with the range it occupies in the buffer it came from. */
export interface SqlStatement {
  /** The statement's text, whitespace-trimmed. Always exactly `buffer.slice(from, to)`. */
  text: string;
  /** Offset of the first character, inclusive. */
  from: number;
  /** Offset one past the last character, exclusive. */
  to: number;
}

/** A single whitespace character. Non-global, so `.test()` carries no `lastIndex` state. */
const WHITESPACE = /\s/;

/** A character that may appear inside a dollar-quote tag. `guard.rs` uses `is_alphanumeric`. */
const TAG_CHAR = /[\p{L}\p{N}_]/u;

/** `$1` is a placeholder, not a dollar quote — a tag may not START with a digit. */
const DIGIT = /[0-9]/;

/** Mirrors guard.rs::split_statements. A comment-only trailing fragment is dropped (else "-- done"
 * reads as multi-statement); text inside a statement is kept verbatim, as it is echoed back. */
export function splitStatements(text: string): SqlStatement[] {
  const out: SqlStatement[] = [];
  let start = 0;
  let i = 0;

  while (i < text.length) {
    const c = text[i];
    if (c === "-" && text[i + 1] === "-") {
      // ── line comment ─────────────────────────────────────────────────────
      i += 2;
      while (i < text.length && text[i] !== "\n") i += 1;
    } else if (c === "/" && text[i + 1] === "*") {
      // ── block comment, NESTED (Postgres allows nesting) ──────────────────
      i = skipBlockComment(text, i);
    } else if (c === "'") {
      // ── single-quoted literal, `''` doubling and `E'…\'…'` escapes ───────
      const escapes = i > 0 && (text[i - 1] === "E" || text[i - 1] === "e");
      i += 1;
      while (i < text.length) {
        if (escapes && text[i] === "\\") {
          i += 2;
          continue;
        }
        if (text[i] === "'") {
          if (text[i + 1] === "'") {
            i += 2; // an escaped quote — still inside the literal
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
    } else if (c === '"') {
      // ── quoted identifier, with `""` doubling ────────────────────────────
      i += 1;
      while (i < text.length) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
    } else if (c === "$") {
      // ── dollar quoting: `$$…$$` or `$tag$…$tag$` ─────────────────────────
      const tagLength = dollarTag(text, i);
      if (tagLength === null) {
        i += 1;
      } else {
        const tag = text.slice(i, i + tagLength);
        i += tagLength;
        // Scan for the closing copy of the same tag.
        while (i < text.length) {
          if (text.startsWith(tag, i)) {
            i += tag.length;
            break;
          }
          i += 1;
        }
      }
    } else if (c === ";") {
      // ── the terminator ───────────────────────────────────────────────────
      pushTrimmed(out, text, start, i);
      i += 1;
      start = i;
    } else {
      i += 1;
    }
  }
  pushTrimmed(out, text, start, text.length);
  return out;
}

/** A caret after a statement (usually just past its ";") belongs to it; one before the first
 * statement gets the first. null when the buffer holds none. */
export function statementAtOffset(text: string, offset: number): SqlStatement | null {
  const statements = splitStatements(text);
  if (statements.length === 0) return null;
  const pos = Math.min(Math.max(offset, 0), text.length);
  let preceding: SqlStatement | null = null;
  for (const statement of statements) {
    // Statements come out in order, so the first one that starts after the caret ends
    // the search: everything later starts later still.
    if (pos < statement.from) break;
    if (pos <= statement.to) return statement;
    preceding = statement;
  }
  return preceding ?? statements[0];
}

/** Redis/Valkey run one command line. CM6 normalises line breaks, so \n is the only separator. */
export function lineAtOffset(text: string, offset: number): string {
  const pos = Math.min(Math.max(offset, 0), text.length);
  const start = text.slice(0, pos).lastIndexOf("\n") + 1;
  const next = text.indexOf("\n", pos);
  return text.slice(start, next === -1 ? text.length : next);
}

/** What ⌘⏎ sends. A selection wins verbatim on every engine (whitespace-only counts as none);
 * otherwise sql runs the statement under the cursor, commandline the line, and json the whole
 * buffer (one command document, never split). */
export function textToRun(
  queryLanguage: "sql" | "json" | "commandline",
  text: string,
  from: number,
  to: number,
): string {
  const selected = text.slice(from, to);
  if (selected.trim() !== "") return selected;
  if (queryLanguage === "json") return text;
  if (queryLanguage === "commandline") return lineAtOffset(text, to);
  // No statement under the cursor means the buffer holds none — hand the whole thing over and
  // let Rust say "There is nothing to run.", which is both true and its sentence to say.
  return statementAtOffset(text, to)?.text ?? text;
}

/* ────────────────────────────── the lexer's helpers ────────────────────────────── */

/** Index just past the block comment starting at `i`, honouring nesting. */
function skipBlockComment(text: string, i: number): number {
  let depth = 1;
  let j = i + 2;
  while (j < text.length && depth > 0) {
    if (text[j] === "/" && text[j + 1] === "*") {
      depth += 1;
      j += 2;
    } else if (text[j] === "*" && text[j + 1] === "/") {
      depth -= 1;
      j += 2;
    } else {
      j += 1;
    }
  }
  return j;
}

/** Length of a dollar-quote tag at i ($$ is 2, $tag$ is 5), or null ($1 placeholder, bare $). */
function dollarTag(text: string, i: number): number | null {
  let j = i + 1;
  while (j < text.length && TAG_CHAR.test(text[j])) {
    // A tag cannot start with a digit — that is `$1`, a placeholder.
    if (j === i + 1 && DIGIT.test(text[j])) return null;
    j += 1;
  }
  return text[j] === "$" ? j - i + 1 : null;
}

/** Push `text[start..end]` onto `out` if it holds anything but whitespace and comments. */
function pushTrimmed(out: SqlStatement[], text: string, start: number, end: number): void {
  let from = start;
  let to = end;
  while (from < to && WHITESPACE.test(text[from])) from += 1;
  while (to > from && WHITESPACE.test(text[to - 1])) to -= 1;
  const trimmed = text.slice(from, to);
  if (trimmed === "" || isOnlyComments(trimmed)) return;
  out.push({ text: trimmed, from, to });
}

/** Mirrors guard.rs::is_only_comments: a trailing "-- done" must not count as a statement. */
function isOnlyComments(s: string): boolean {
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (WHITESPACE.test(c)) {
      i += 1;
    } else if (c === "-" && s[i + 1] === "-") {
      while (i < s.length && s[i] !== "\n") i += 1;
    } else if (c === "/" && s[i + 1] === "*") {
      i = skipBlockComment(s, i);
    } else {
      return false;
    }
  }
  return true;
}
