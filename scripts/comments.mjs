#!/usr/bin/env node
// Comment rule: no comment block over 3 lines; history belongs in git and LESSONS.
//   report [files…] | show [files…] (long blocks + the code after) | apply <plan.json>
//   check --base <ref> [files…]: code tokens and tool directives unchanged, rule holds

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

export const MAX_COMMENT_LINES = 3;
export const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|rs|css)$/;
const EXEMPT = [/^src-tauri\/vendor\//, /\.d\.ts$/];
// Comments that tools read: removing or rewording one changes behaviour, not just prose.
const DIRECTIVE =
  /eslint-(?:disable|enable)[\w-]*[^\n*]*?(?=\s--|\*\/|$)|@ts-(?:expect-error|ignore|nocheck)|[cv]8 ignore[^\n*]*|istanbul ignore[^\n*]*|prettier-ignore|@vitest-environment \S+|<reference [^>]*>|SAFETY:|@vite-ignore|webpackChunkName/gm;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const isExempt = (file) => EXEMPT.some((re) => re.test(file));

function langOf(file) {
  if (file.endsWith(".rs")) return "rust";
  if (file.endsWith(".css")) return "css";
  return "js";
}

/* ── JS / TS: the TypeScript parser, so regex literals and JSX never look like comments ── */

function scriptKind(file) {
  if (/\.tsx$/.test(file)) return ts.ScriptKind.TSX;
  if (/\.jsx$/.test(file)) return ts.ScriptKind.JSX;
  if (/\.[mc]?ts$/.test(file)) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

// JSX text as React sees it: lines trimmed at their inner edges, blank lines dropped.
function jsxText(raw) {
  const lines = raw.split(/\r?\n/);
  if (lines.length === 1) return raw;
  return lines
    .map((l, i) => (i === 0 ? l.trimEnd() : i === lines.length - 1 ? l.trimStart() : l.trim()))
    .filter(Boolean)
    .join(" ");
}

function analyzeJs(file, text) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
  const tokens = [];
  const comments = [];
  const seen = new Set();
  const take = (ranges) => {
    for (const r of ranges ?? []) {
      if (seen.has(r.pos)) continue;
      seen.add(r.pos);
      comments.push({ start: r.pos, end: r.end });
    }
  };
  const visit = (node, emit) => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
    // `{/* note */}` is a comment in JSX: its braces are not code either.
    const quiet = !emit || (ts.isJsxExpression(node) && !node.expression);
    const kids = node.getChildren(sf);
    if (kids.length === 0) {
      take(ts.getLeadingCommentRanges(text, node.getFullStart()));
      take(ts.getTrailingCommentRanges(text, node.getEnd()));
      if (quiet) return;
      const t = node.kind === ts.SyntaxKind.JsxText ? jsxText(node.getText(sf)) : node.getText(sf);
      if (node.kind === ts.SyntaxKind.JsxText && t.trim() === "") return;
      tokens.push(`${node.kind}:${t}`);
      return;
    }
    for (const k of kids) visit(k, !quiet);
  };
  visit(sf, true);
  return { tokens, comments: comments.sort((a, b) => a.start - b.start) };
}

/* ── Rust: a small lexer that knows strings, raw strings, chars vs lifetimes, nested comments ── */

function analyzeRust(text) {
  const tokens = [];
  const comments = [];
  const n = text.length;
  let i = 0;
  const identChar = (c) => /[A-Za-z0-9_]/.test(c ?? "");
  while (i < n) {
    const c = text[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      comments.push({ start: i, end: stop });
      i = stop;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const start = i;
      let depth = 0;
      while (i < n) {
        if (text[i] === "/" && text[i + 1] === "*") { depth++; i += 2; }
        else if (text[i] === "*" && text[i + 1] === "/") { depth--; i += 2; if (depth === 0) break; }
        else i++;
      }
      comments.push({ start, end: i });
      continue;
    }
    const raw = !identChar(text[i - 1]) && /^(?:b|c)?r(#*)"/.exec(text.slice(i, i + 260));
    if (raw) {
      const close = `"${raw[1]}`;
      const end = text.indexOf(close, i + raw[0].length);
      const stop = end === -1 ? n : end + close.length;
      tokens.push(text.slice(i, stop));
      i = stop;
      continue;
    }
    if (c === '"' || ((c === "b" || c === "c") && text[i + 1] === '"' && !identChar(text[i - 1]))) {
      let j = c === '"' ? i + 1 : i + 2;
      while (j < n && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      tokens.push(text.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    if (c === "'" || (c === "b" && text[i + 1] === "'" && !identChar(text[i - 1]))) {
      const s = c === "'" ? i : i + 1;
      const ch = /^'(?:\\(?:x[0-9a-fA-F]{2}|u\{[0-9a-fA-F_]+\}|.)|[^\\'\n])'/u.exec(text.slice(s, s + 16));
      if (ch) { tokens.push(text.slice(i, s + ch[0].length)); i = s + ch[0].length; continue; }
      if (c === "'") {
        let j = i + 1;
        while (identChar(text[j])) j++;
        tokens.push(text.slice(i, j));
        i = j;
        continue;
      }
    }
    if (identChar(c)) {
      let j = i;
      while (identChar(text[j])) j++;
      tokens.push(text.slice(i, j));
      i = j;
      continue;
    }
    tokens.push(c);
    i++;
  }
  return { tokens, comments };
}

/* ── CSS ── */

function analyzeCss(text) {
  const tokens = [];
  const comments = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      comments.push({ start: i, end: stop });
      i = stop;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && text[j] !== c) j += text[j] === "\\" ? 2 : 1;
      tokens.push(text.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    if (/[{}();:,>+~[\]=]/.test(c)) { tokens.push(c); i++; continue; }
    let j = i;
    while (j < n && !/[\s{}();:,>+~[\]="']/.test(text[j]) && !(text[j] === "/" && text[j + 1] === "*")) j++;
    tokens.push(text.slice(i, j));
    i = j;
  }
  return { tokens, comments };
}

export function analyze(file, text) {
  const lang = langOf(file);
  return lang === "rust" ? analyzeRust(text) : lang === "css" ? analyzeCss(text) : analyzeJs(file, text);
}

/** Comment blocks: adjacent own-line comments merge; a trailing comment stands alone. */
export function commentBlocks(file, text, comments = analyze(file, text).comments) {
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") lineStarts.push(i + 1);
  const lineOf = (pos) => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= pos) lo = mid; else hi = mid - 1; }
    return lo;
  };
  const blocks = [];
  let prev = null;
  for (const c of comments) {
    const startLine = lineOf(c.start);
    const endLine = lineOf(Math.max(c.start, c.end - 1));
    const ownLine = /^\s*\{?\s*$/.test(text.slice(lineStarts[startLine], c.start));
    const joins =
      prev && ownLine && prev.ownLine && startLine === prev.endLine + 1 &&
      /^\s*\}?\s*\{?\s*$/.test(text.slice(prev.endPos, c.start));
    if (joins) { prev.endLine = endLine; prev.endPos = c.end; }
    else { prev = { startLine, endLine, ownLine, endPos: c.end }; blocks.push(prev); }
  }
  return blocks.map((b) => ({ line: b.startLine + 1, lines: b.endLine - b.startLine + 1 }));
}

export const longBlocks = (file, text) => commentBlocks(file, text).filter((b) => b.lines > MAX_COMMENT_LINES);

// A block comment's later lines line up under its text: " * " for stars, else past the opener.
function continuation(first, line, k) {
  const t = line.trimStart();
  const opener = first.trimStart();
  if (k === 0 || !opener.startsWith("/*") && !opener.startsWith("{/*")) return t;
  if (t.startsWith("*")) return ` ${t}`;
  return (opener.startsWith("{/*") ? "    " : "   ") + t;
}

/**
 * Replace own-line comment blocks, given by their 1-based start line, with new comment lines
 * (indented like the old first line; "" deletes). Refuses a block that shares a line with code.
 */
export function applyBlocks(file, text, edits) {
  const lines = text.split("\n");
  const blocks = commentBlocks(file, text);
  const errors = [];
  for (const e of [...edits].sort((x, y) => y.line - x.line)) {
    const b = blocks.find((x) => x.line === e.line);
    if (!b) { errors.push(`line ${e.line}: no comment block starts here`); continue; }
    const first = b.line - 1;
    const last = first + b.lines - 1;
    const indent = /^\s*/.exec(lines[first])[0];
    const before = analyze(file, lines.slice(first, last + 1).join("\n"));
    // Alone, a JSX comment parses as `{ }` and every TS file ends in an empty EOF token.
    if (before.tokens.some((t) => !/^\d+:[{}]?$/.test(t) && t !== "{" && t !== "}")) {
      errors.push(`line ${e.line}: the block shares a line with code; edit it by hand`);
      continue;
    }
    const next = e.text === "" ? [] : e.text.split("\n").map((l, k, all) => (l ? indent + continuation(all[0], l, k) : ""));
    lines.splice(first, last - first + 1, ...next);
  }
  return { text: lines.join("\n"), errors };
}

export function directives(file, text) {
  const out = [];
  for (const c of analyze(file, text).comments) {
    for (const m of text.slice(c.start, c.end).matchAll(DIRECTIVE)) out.push(m[0].trim());
  }
  return out.sort();
}

/** Problems with going from `before` to `after` when only comments may change. */
export function commentsOnlyProblems(file, before, after) {
  const problems = [];
  const a = analyze(file, before).tokens;
  const b = analyze(file, after).tokens;
  const at = a.findIndex((t, k) => t !== b[k]);
  if (at !== -1 || a.length !== b.length) {
    const k = at === -1 ? Math.min(a.length, b.length) : at;
    problems.push(`code changed near token ${k}: ${JSON.stringify(a[k])} → ${JSON.stringify(b[k])}`);
  }
  if (JSON.stringify(directives(file, before)) !== JSON.stringify(directives(file, after))) {
    problems.push(`a tool directive comment changed (eslint/@ts/v8/SAFETY/…)`);
  }
  return problems;
}

/* ── CLI ── */

const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 });

export function trackedSources() {
  return git("ls-files", "-z").split("\0").filter((f) => SOURCE.test(f) && !isExempt(f));
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const baseAt = rest.indexOf("--base");
  const base = baseAt === -1 ? null : rest[baseAt + 1];
  const named = rest.filter((_, k) => baseAt === -1 || (k !== baseAt && k !== baseAt + 1));
  if (cmd === "report") {
    const files = named.length ? named : trackedSources();
    let total = 0;
    const rows = [];
    for (const f of files) {
      const long = longBlocks(f, readFileSync(path.join(root, f), "utf8"));
      if (long.length) rows.push([long.length, long.reduce((s, b) => s + b.lines, 0), f]);
      total += long.length;
    }
    rows.sort((x, y) => y[1] - x[1]);
    for (const [count, lines, f] of rows) console.log(`${String(count).padStart(5)} blocks ${String(lines).padStart(6)} lines  ${f}`);
    console.log(`${total} blocks over ${MAX_COMMENT_LINES} lines in ${rows.length} files`);
    return total ? 1 : 0;
  }
  if (cmd === "show") {
    for (const f of named) {
      const text = readFileSync(path.join(root, f), "utf8");
      const lines = text.split("\n");
      for (const b of longBlocks(f, text)) {
        console.log(`@@ ${f}:${b.line} (${b.lines} lines)`);
        for (let k = b.line - 1; k < b.line - 1 + b.lines; k++) console.log(lines[k]);
        for (const l of lines.slice(b.line - 1 + b.lines, b.line + b.lines + 1)) console.log(`|${l}`);
      }
    }
    return 0;
  }
  if (cmd === "apply") {
    const plan = JSON.parse(readFileSync(named[0], "utf8"));
    const byFile = new Map();
    for (const e of plan) byFile.set(e.file, [...(byFile.get(e.file) ?? []), e]);
    let bad = 0;
    for (const [f, edits] of byFile) {
      const full = path.join(root, f);
      const { text, errors } = applyBlocks(f, readFileSync(full, "utf8"), edits);
      for (const err of errors) console.log(`✗ ${f}: ${err}`);
      bad += errors.length;
      writeFileSync(full, text);
    }
    console.log(`applied ${plan.length - bad} of ${plan.length} edits in ${byFile.size} files`);
    return bad ? 1 : 0;
  }
  if (cmd === "check") {
    if (!base) throw new Error("check needs --base <ref>");
    const changed = git("diff", "--name-only", "-z", base, "--").split("\0").filter(Boolean);
    const files = (named.length ? named : changed).filter((f) => SOURCE.test(f) && !isExempt(f));
    let bad = 0;
    for (const f of files) {
      const full = path.join(root, f);
      if (!existsSync(full)) { console.log(`✗ ${f}: deleted`); bad++; continue; }
      const after = readFileSync(full, "utf8");
      let before;
      try { before = git("show", `${base}:${f}`); } catch { console.log(`✗ ${f}: new file`); bad++; continue; }
      const problems = commentsOnlyProblems(f, before, after);
      for (const b of longBlocks(f, after)) problems.push(`line ${b.line}: ${b.lines}-line comment`);
      if (problems.length) { bad++; for (const p of problems) console.log(`✗ ${f}: ${p}`); }
    }
    console.log(bad ? `${bad} of ${files.length} files have problems` : `✓ ${files.length} files: only comments changed, none over ${MAX_COMMENT_LINES} lines`);
    return bad ? 1 : 0;
  }
  console.error("usage: comments.mjs report [files…] | check --base <ref> [files…]");
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
