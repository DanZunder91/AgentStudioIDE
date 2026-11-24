/**
 * highlightJson — a tiny, LENIENT JSON tokenizer for the request-body editor (the
 * request body should look like JSON). It colors what it can and leaves the
 * rest plain, so it never throws on partial/invalid JSON the user is mid-typing.
 *
 * Not a validator and not `JSON.parse` — a forgiving scanner that emits contiguous
 * `{text, cls}` runs which `JsonBodyEditor` renders as spans over a transparent
 * textarea. `cls` reuses the JsonView palette classes (empty string = plain text).
 */

export interface HlToken {
  text: string;
  /** A `jsonview__*` class, or "" for plain (whitespace / unrecognized). */
  cls: string;
}

const PUNCT = new Set(["{", "}", "[", "]", ":", ","]);

/** Scan a JSON-ish string into colored token runs. Always makes forward progress. */
export function highlightJson(src: string): HlToken[] {
  const tokens: HlToken[] = [];
  let i = 0;
  const n = src.length;

  while (i < n) {
    const c = src[i];

    // String (with escapes). A string immediately followed by `:` is a KEY.
    if (c === '"') {
      let j = i + 1;
      while (j < n && src[j] !== '"') {
        if (src[j] === "\\") j += 1; // skip the escaped char
        j += 1;
      }
      j += 1; // include the closing quote (or run to end if unterminated)
      let k = j;
      while (k < n && /\s/.test(src[k])) k += 1;
      const isKey = src[k] === ":";
      tokens.push({ text: src.slice(i, j), cls: isKey ? "jsonview__key" : "jsonview__string" });
      i = j;
      continue;
    }

    // Number: an optional `-` then digits/decimal/exponent.
    if (c === "-" || (c >= "0" && c <= "9")) {
      let j = i + 1;
      while (j < n && /[0-9.eE+-]/.test(src[j])) j += 1;
      tokens.push({ text: src.slice(i, j), cls: "jsonview__number" });
      i = j;
      continue;
    }

    // Keywords.
    if (src.startsWith("true", i) || src.startsWith("false", i)) {
      const kw = src.startsWith("true", i) ? "true" : "false";
      tokens.push({ text: kw, cls: "jsonview__bool" });
      i += kw.length;
      continue;
    }
    if (src.startsWith("null", i)) {
      tokens.push({ text: "null", cls: "jsonview__null" });
      i += 4;
      continue;
    }

    // Structural punctuation.
    if (PUNCT.has(c)) {
      tokens.push({ text: c, cls: "jsonview__punct" });
      i += 1;
      continue;
    }

    // Anything else (whitespace, stray chars) → a plain run up to the next
    // interesting character, so we emit few tokens. `src[i]` is, by definition of
    // this branch, not an interesting char, so the loop advances at least once
    // (j > i always) — no separate progress guard needed.
    let j = i + 1;
    while (
      j < n &&
      src[j] !== '"' &&
      !PUNCT.has(src[j]) &&
      !(src[j] === "-" || (src[j] >= "0" && src[j] <= "9")) &&
      !src.startsWith("true", j) &&
      !src.startsWith("false", j) &&
      !src.startsWith("null", j)
    ) {
      j += 1;
    }
    tokens.push({ text: src.slice(i, j), cls: "" });
    i = j;
  }

  return tokens;
}
