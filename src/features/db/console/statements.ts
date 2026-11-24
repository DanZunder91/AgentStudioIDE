/**
 * `statements.ts` — the frontend mirror of `guard.rs`'s statement splitter.
 *
 * 🔴 **Written to fix a bug.** With a four-line buffer whose two commented-out lines were
 * selected, ⌘⏎ answered *"That statement was blocked before it ran — this
 * connection is read-only, or it does not allow multiple statements."* Two things were wrong,
 * and this file is the fix for the first:
 *
 * 1. `QueryEditor`'s ⌘⏎ passed a **mode** (`"statement"`) and nothing else, so the store sent
 *    the **whole buffer** and Rust's `guard::multi_statement_refusal` counted two statements
 *    and refused. The mode said "one statement"; the payload said "all of them".
 * 2. `consoleFormat.runHint` had been telling users *"Runs the statement under the cursor."*
 *    since the console shipped. **Nothing computed that**, so the promise was never true.
 *
 * ── Why a mirror and not a call into Rust ────────────────────────────────────
 * The answer is needed **synchronously, inside a keystroke handler**, from the CM6 state — an
 * `invoke()` round trip to ask "where does this statement end" would make ⌘⏎ async for no gain.
 * So the rules are duplicated, deliberately, and the duplication is the risk: if this file and
 * `guard.rs` disagree, the frontend sends a fragment Rust then splits differently. That is why
 * every rule below names the `guard.rs` behaviour it mirrors, and why the tests use the same
 * cases as `guard.rs`'s own (`a_semicolon_inside_a_string_literal_is_not_a_terminator`, …).
 *
 * ── Lexical, never a parser — and never a security boundary ──────────────────
 * Same statement as `guard.rs`'s header, for the same reason: read-only is enforced by the
 * *server*, and the multi-statement refusal is enforced by *Rust*. This module decides what to
 * put in the box, not whether the box is allowed to be opened. A splitter that is wrong about
 * some exotic quoting form here mis-sends a query; it cannot grant a permission.
 *
 * The forms understood are exactly `guard.rs`'s: `-- line comments`, **nested** block comments
 * (an inner `/*` opens a second level that the first closer only closes back down to one),
 * `'single quoted'` with `''` doubling, `E'…\'…'` with backslash escapes, `"quoted identifiers"`
 * with `""` doubling, and `$$dollar$$` / `$tag$…$tag$` bodies.
 * Every one of them can contain a `;` that is not a terminator — and a `;` swallowed from the
 * middle of a string literal does not merely misparse, it *corrupts* the query that runs.
 *
 * ── Offsets, not just text ───────────────────────────────────────────────────
 * `guard.rs` returns `Vec<String>` because it only ever needs the text. The editor needs to
 * answer "which of these contains the caret", so each statement carries its range as well.
 * `text === buffer.slice(from, to)` always holds: the range is the *trimmed* span, so a caret
 * in the whitespace between two statements belongs to neither and falls back by position.
 *
 * Offsets are JavaScript string indices (UTF-16 code units) because that is what CodeMirror's
 * `EditorState` uses. `guard.rs` indexes by `char`; the two disagree beyond the BMP, which is
 * harmless here because every character the lexer reacts to is ASCII — a surrogate half can
 * never equal `'`, `;` or `-`.
 */

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

/**
 * Split `text` into statements at top-level `;`, dropping empty and comment-only fragments.
 *
 * Mirrors `guard.rs::split_statements` rule for rule. The two behaviours worth stating out
 * loud, because both are load-bearing and neither is obvious:
 *
 * * A trailing fragment that is **only comments** is dropped (`is_only_comments` in Rust).
 *   Without that, an ordinary script ending in `-- done` would count as an extra statement and
 *   be refused as multi-statement.
 * * Whitespace and comments *inside* a statement are preserved verbatim, because the statement
 *   is echoed back next to its result and rewriting the user's SQL would be a small lie.
 */
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

/**
 * The statement `offset` sits in, or `null` when the buffer holds none at all.
 *
 * A caret in the whitespace *after* a statement (the newline that follows its `;`, most of the
 * time) belongs to that statement — a caret is at the end of a line far more often
 * than it is inside one. A caret before the first statement gets the first: there is nothing
 * preceding it, and the alternative — running the whole buffer — is the bug this file fixes.
 */
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

/**
 * The whole line containing `offset`, without its line break.
 *
 * The `commandline` engines (Redis, Valkey) have no `;` and no statements — Run means
 * "one command line", so the line is the unit. CodeMirror normalises `\r\n` and `\r` to `\n`
 * when it builds a document, so `\n` is the only separator that can reach this.
 */
export function lineAtOffset(text: string, offset: number): string {
  const pos = Math.min(Math.max(offset, 0), text.length);
  const start = text.slice(0, pos).lastIndexOf("\n") + 1;
  const next = text.indexOf("\n", pos);
  return text.slice(start, next === -1 ? text.length : next);
}

/**
 * **What ⌘⏎ actually sends** — the one function `QueryEditor` calls, per engine family.
 *
 * | | no selection | selection |
 * |---|---|---|
 * | `sql` | the statement under the cursor | the selected text, verbatim |
 * | `commandline` | the line under the cursor | the selected text, verbatim |
 * | `json` | the whole buffer | the selected text, verbatim |
 *
 * **A selection wins for every engine, and is passed through untouched.** If the selection
 * is two *commented-out* lines, sending exactly that — and being told by
 * the server that there is nothing to run — is the correct outcome. Second-guessing a
 * selection because it looks like a comment would mean ⌘⏎ ran something other than what is
 * highlighted on screen, which is the accident the multi-statement guard exists to prevent, in miniature.
 *
 * `json` is deliberately NOT split: a MongoDB command document is one object, and there is no
 * `;` in it to split on — the SQL lexer would be answering a question that was never asked.
 *
 * The one exception to "verbatim": a selection of nothing but whitespace is treated as no
 * selection. It cannot be what the user meant, and honouring it would make Run a silent no-op
 * (the store refuses a blank buffer) — a button that does nothing and says nothing.
 *
 * `from`/`to` come from CodeMirror's `state.selection.main`, which guarantees `from <= to`.
 */
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

/**
 * The length of a dollar-quote opening tag at `i` (`$$` → 2, `$tag$` → 5), or `null` when this
 * `$` is not one — a `$1` placeholder, or a bare `$`.
 */
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

/**
 * True when `s` is nothing but comments and whitespace.
 *
 * Mirrors `guard.rs::is_only_comments`: a trailing `-- done` must not count as a statement, or
 * an ordinary script would look multi-statement and be refused.
 */
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
