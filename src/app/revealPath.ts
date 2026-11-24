/**
 * Pure path logic for "Reveal active file in Files tree" (IntelliJ's crosshair /
 * "Select Opened File").
 *
 * Revealing a file means (1) finding WHICH workspace root the file lives under and
 * (2) expanding every ancestor directory between that root and the file. Both steps
 * are pure string questions, so they live here — pure and testable — instead of
 * inside the store or the tree component. The one genuinely tricky part is honoring
 * path-SEGMENT boundaries ("/a/bc" is not under "/a/b") across both separator
 * styles, since paths from the Rust side use "\" on Windows — and, since Windows
 * file systems ignore case, `c:\w` owns `C:\w\a.rs`. The comparison itself is
 * `lib/paths`' `relativeTo`, shared with every other path test in the UI.
 */

import { relativeTo, SEPARATOR } from "../lib/paths";

/** Length of `p` once trailing separators are dropped (`"/w/g/"` → 4, `"/"` → 0). */
function lengthSansTrailingSeps(p: string): number {
  let end = p.length;
  while (end > 0 && SEPARATOR.test(p[end - 1])) end -= 1;
  return end;
}

/**
 * The index just past `root` within `path` when `path` is STRICTLY under `root`
 * (i.e. a file or dir inside it, not the root itself), or -1 otherwise. At the
 * returned index `path` always holds a separator. Segment-boundary aware,
 * separator-agnostic and — for Windows paths — case-insensitive (`lib/paths`'
 * `relativeTo`, whose comparison is length-preserving, so the root's trimmed length
 * is also the index in `path`); trailing separators on either input are ignored.
 */
function boundaryIn(root: string, path: string): number {
  // null = outside; "" = the root itself, which is not "inside".
  return relativeTo(root, path) ? lengthSansTrailingSeps(root) : -1;
}

/**
 * The longest root in `roots` that contains `path` (a file or dir INSIDE the root,
 * not the root itself), honoring path-segment boundaries — "/a/bc" is NOT under
 * "/a/b". Returns null when no root contains the path. Separator-agnostic: treats
 * "/" and "\" as equivalent for comparison (Windows paths from the Rust side use
 * "\"), and ignores a trailing separator on a root. "Longest" makes nested roots
 * unambiguous: with both "/w" and "/w/gazelle" open, a file in gazelle reveals
 * under "/w/gazelle". The returned string is the root exactly as it appears in
 * `roots` (first one wins on a tie).
 */
export function rootContaining(
  roots: readonly string[],
  path: string,
): string | null {
  let best: string | null = null;
  let bestLen = -1;
  for (const root of roots) {
    if (boundaryIn(root, path) < 0) continue;
    const len = lengthSansTrailingSeps(root);
    if (len > bestLen) {
      best = root;
      bestLen = len;
    }
  }
  return best;
}

/**
 * The chain of ancestor DIRECTORIES of `path` strictly below `root`, ordered
 * outermost → innermost, EXCLUDING the root itself and EXCLUDING `path` itself.
 * Each returned entry is a full absolute path in the same form the input used
 * (the original separators/casing of `root` plus the relevant `path` segments are
 * preserved — these strings are later compared against FsEntry.path values from
 * the same source). Returns [] when `path` is a direct child of `root`. Returns
 * null when `path` is not under `root` (same boundary rule as `rootContaining`).
 *
 * Example: ancestorDirsWithin("/w/gazelle", "/w/gazelle/crates/core/src/lib.rs")
 * → ["/w/gazelle/crates", "/w/gazelle/crates/core", "/w/gazelle/crates/core/src"].
 */
export function ancestorDirsWithin(root: string, path: string): string[] | null {
  const start = boundaryIn(root, path);
  if (start < 0) return null;
  const base = root.slice(0, lengthSansTrailingSeps(root));
  const end = lengthSansTrailingSeps(path);
  const dirs: string[] = [];
  // Every separator strictly between the root boundary and the final segment closes
  // one ancestor directory. Runs of separators only count once (at their first char),
  // and `end` excludes trailing separators, so `path` itself is never emitted.
  for (let i = start + 1; i < end; i += 1) {
    if (SEPARATOR.test(path[i]) && !SEPARATOR.test(path[i - 1])) {
      dirs.push(base + path.slice(start, i));
    }
  }
  return dirs;
}
