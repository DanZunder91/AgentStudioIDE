/** Pure path logic for "Reveal active file in Files tree": which root owns a file and which
 * ancestors to expand. Respects segment boundaries ("/a/bc" is not under "/a/b"), both separators
 * and Windows case-insensitivity via `lib/paths`' `relativeTo`. */

import { relativeTo, SEPARATOR } from "../lib/paths";

/** Length of `p` once trailing separators are dropped (`"/w/g/"` → 4, `"/"` → 0). */
function lengthSansTrailingSeps(p: string): number {
  let end = p.length;
  while (end > 0 && SEPARATOR.test(p[end - 1])) end -= 1;
  return end;
}

/** Index just past `root` in `path` when `path` is strictly inside it (a separator sits there),
 * else -1. `relativeTo` is length-preserving, so the root's trimmed length is that index. */
function boundaryIn(root: string, path: string): number {
  // null = outside; "" = the root itself, which is not "inside".
  return relativeTo(root, path) ? lengthSansTrailingSeps(root) : -1;
}

/** The longest root that strictly contains `path` (so nested roots resolve to the innermost), as
 * written in `roots` (first wins a tie), or null. Same boundary rules as `boundaryIn`. */
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

/** Ancestor directories of `path` strictly between `root` and `path`, outermost first, keeping the
 * input's separators and casing (compared later with FsEntry.path). [] for a direct child; null
 * when `path` is not under `root`. */
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
