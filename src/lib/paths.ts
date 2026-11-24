/**
 * Filesystem path spelling for the UI — the ONE place that splits, joins, compares and
 * prefix-tests a path (needed once the app ran on Windows).
 *
 * The Rust side sends native paths: `/Users/me/app/src/a.ts` on macOS and Linux,
 * `C:\Users\me\app\src\a.ts` on Windows (never `\\?\…` since `crate::paths::canonicalize`).
 * Some sites still meet MIXED separators — a root the UI knows as `C:\repo` joined with a
 * `/`-separated relative path, a `C:/x` a person or an agent typed — and Windows file systems
 * ignore case, so `c:\repo` and `C:\Repo` are the same folder. Before this module a dozen
 * call sites each assumed `/` (`lastIndexOf("/")`, `root + "/"`), and on Windows every one
 * of them silently answered "not inside" or "the whole path is the file name".
 *
 * The rules, all pure string questions so every OS tests the Windows spelling:
 *   - **Either separator is a separator.** "/" and "\" compare equal everywhere.
 *   - **Segment boundaries:** "/a/bc" is not inside "/a/b".
 *   - **Case is ignored only for Windows-shaped paths** (a drive letter or UNC on either
 *     side). POSIX comparisons stay byte-exact — macOS/Linux names are case-sensitive here.
 *   - **Answers keep the input's own spelling.** Comparison happens on a normalized copy of
 *     the SAME length, so an index into it slices the original string; nothing is re-cased
 *     or re-separated on its way back out.
 */

/** Matches either path separator — "/" (POSIX, and accepted by Windows) or "\" (Windows). */
export const SEPARATOR = /[\\/]/;

/** A run of separators. */
const SEPARATORS = /[\\/]+/;

/** A drive letter plus colon, alone or followed by a separator: `C:`, `C:\…`, `c:/…`. */
const DRIVE = /^[A-Za-z]:(?:[\\/]|$)/;

/**
 * A Windows-shaped path: a drive letter (`C:\x`, `C:/x`, `C:`) or UNC (`\\srv\share`). Read
 * from the SHAPE, not from the platform, because the two coincide (no POSIX path starts with
 * `C:` or `\\`) and a pure test can then pin the Windows behaviour on any OS.
 */
export function isWindowsPath(p: string): boolean {
  return DRIVE.test(p) || p.startsWith("\\\\");
}

/**
 * Absolute on either platform: `/x`, `C:\x`, `C:/x`, `\\srv\share` — and `\x`, which Windows
 * resolves against the current drive's root, so it is never a path relative to some folder.
 */
export function isAbsolutePath(p: string): boolean {
  return /^(?:[\\/]|[A-Za-z]:[\\/])/.test(p);
}

/**
 * The separator `p` itself uses: "\" when it contains one, "/" when it contains only "/",
 * and for a separator-less path "\" on a bare drive (`C:`) and "/" otherwise.
 */
export function separatorOf(p: string): "\\" | "/" {
  if (p.includes("\\")) return "\\";
  if (p.includes("/")) return "/";
  return DRIVE.test(p) ? "\\" : "/";
}

/** Length of the root prefix trimming must never eat: `C:\` → 3, `C:` → 2, `/` or `\…` → 1, relative → 0. */
function rootLength(p: string): number {
  if (DRIVE.test(p)) return p.length > 2 ? 3 : 2;
  return SEPARATOR.test(p.charAt(0)) ? 1 : 0;
}

/** `p` without trailing separators, never shorter than its root: `/w/` → `/w`, `/` → `/`, `C:\` → `C:\`. */
export function trimTrailingSeparators(p: string): string {
  const min = rootLength(p);
  let end = p.length;
  while (end > min && SEPARATOR.test(p[end - 1])) end -= 1;
  return p.slice(0, end);
}

/** The last segment (a file or folder name); `""` for a separator-only path. `C:\` → `C:`. */
export function basename(p: string): string {
  const parts = p.split(SEPARATORS).filter(Boolean);
  return parts.length === 0 ? "" : parts[parts.length - 1];
}

/**
 * The parent directory, in `p`'s own spelling. A root is its own parent (`/` → `/`,
 * `C:\` → `C:\`), a first-level child's parent is the root (`/w` → `/`, `C:\w` → `C:\`), and a
 * bare relative name has none (`a.txt` → `""`). Trailing separators are ignored.
 */
export function dirname(p: string): string {
  const t = trimTrailingSeparators(p);
  const min = rootLength(t);
  let i = t.length;
  while (i > min && !SEPARATOR.test(t[i - 1])) i -= 1;
  return i <= min ? t.slice(0, min) : trimTrailingSeparators(t.slice(0, i - 1));
}

/**
 * `rel` under `dir`, in `dir`'s separator style. Under a Windows-style dir every "/" in `rel`
 * becomes "\" (neither is legal in a Windows file name, so nothing is lost) — the answer then
 * matches what the file tree and git status send. Under a POSIX dir `rel` is kept byte for
 * byte: "\" is an ordinary file-name character there. Exactly one separator joins them.
 */
export function joinPath(dir: string, rel: string): string {
  const sep = separatorOf(dir);
  const head = trimTrailingSeparators(dir);
  const tail = sep === "\\" ? rel.replace(/\//g, "\\") : rel;
  return SEPARATOR.test(head.charAt(head.length - 1)) ? `${head}${tail}` : `${head}${sep}${tail}`;
}

/** Lower-cases `p` without changing its length (a character whose lower case is longer is kept). */
function foldCase(p: string): string {
  let out = "";
  for (const ch of p) {
    const lower = ch.toLowerCase();
    out += lower.length === ch.length ? lower : ch;
  }
  return out;
}

/** Whether comparing these paths ignores case: Windows file systems do, POSIX ones here do not. */
function foldsCase(a: string, b: string): boolean {
  return isWindowsPath(a) || isWindowsPath(b);
}

/** The comparison form: "\" → "/", case-folded when `fold`. Same length as `p`, index for index. */
function comparable(p: string, fold: boolean): string {
  const slashed = p.replace(/\\/g, "/");
  return fold ? foldCase(slashed) : slashed;
}

/** The equality form: {@link comparable} with separator runs collapsed (a leading UNC `\\` kept) and trailing ones dropped. */
function equalityForm(p: string, fold: boolean): string {
  const unc = /^[\\/]{2}[^\\/]/.test(p) ? "/" : "";
  return unc + comparable(trimTrailingSeparators(p), fold).replace(/\/+/g, "/");
}

/**
 * Whether `a` and `b` name the same path: either separator, repeated and trailing separators
 * ignored, and — for Windows-shaped paths — case ignored (`c:\Repo\` is `C:/repo`). Purely
 * textual: no `..` resolution, no symlinks.
 */
export function samePath(a: string, b: string): boolean {
  const fold = foldsCase(a, b);
  return equalityForm(a, fold) === equalityForm(b, fold);
}

/**
 * `path` relative to `root`: `""` when it IS the root, `null` when it is not inside it. The
 * relative part is sliced from `path`, so it keeps `path`'s own separators and case
 * (`relativeTo("c:\\repo", "C:\\repo\\src\\a.ts")` → `src\a.ts`). Segment-boundary aware,
 * separator-agnostic, case-insensitive for Windows paths; a trailing separator on either side
 * is ignored.
 */
export function relativeTo(root: string, path: string): string | null {
  const fold = foldsCase(root, path);
  const r = comparable(trimTrailingSeparators(root), fold);
  const p = comparable(path, fold);
  if (!p.startsWith(r)) return null;
  // The segment-boundary rule. A root that ends in a separator (`/`, `C:\`) is its own boundary.
  if (p.length > r.length && !r.endsWith("/") && p[r.length] !== "/") return null;
  return trimTrailingSeparators(path.slice(r.length).replace(/^[\\/]+/, ""));
}

/**
 * A path RELATIVE to `root`, spelled for the screen the way `root` is: under a Windows-shaped
 * root every "/" becomes "\" (`find_files` sends `scripts/verify.mjs`, `find` sends
 * `src\features\terminal` — a Windows user sees `\` in both); under a POSIX root `rel` is kept
 * byte for byte ("\" is an ordinary file-name character there). Display only — never feed the
 * answer back to Rust.
 */
export function displayRelative(root: string, rel: string): string {
  return isWindowsPath(root) ? rel.replace(/\//g, "\\") : rel;
}

/**
 * `path` with the home folder spelled `~`, for the screen (the agent row's
 * `trunk • ~/projects/gazelle`): `/Users/me/projects/app` → `~/projects/app`,
 * `C:\Users\me\projects\app` → `~\projects\app` (case-insensitive, as Windows is:
 * `c:\users\ME\x` is under `C:\Users\me`), the home itself → `~`. Unchanged when `home` is
 * unknown, a bare root, or not an ancestor (segment-aware: `/Users/meg` is not under
 * `/Users/me`). Display only — `~` means nothing to Rust.
 */
export function tildeHome(path: string, home: string | null): string {
  if (!home) return path;
  const h = trimTrailingSeparators(home);
  if (dirname(h) === h) return path; // a root: "~" would claim the whole disk
  const rel = relativeTo(h, path);
  if (rel === null) return path;
  return rel === "" ? "~" : `~${separatorOf(path)}${rel}`;
}

/**
 * Whether `path`'s trailing segments are exactly `tail`'s: `logs/gazelle.log` and
 * `gazelle.log` end `C:\w\logs\gazelle.log`; `zelle.log` does not (no partial segment).
 * Separator-agnostic; case-insensitive when `path` is Windows-shaped.
 */
export function endsWithSegments(path: string, tail: string): boolean {
  const fold = foldsCase(path, tail);
  const p = equalityForm(path, fold);
  const t = equalityForm(tail, fold);
  return t !== "" && (p === t || p.endsWith(`/${t}`));
}

/**
 * A Git Bash (MSYS) drive path in its Windows spelling: `/c/Users/me` → `C:/Users/me`,
 * `/d` → `D:/`. Anything else unchanged. Claude Code on Windows runs its Bash tool in Git
 * Bash, so an agent's commands name `C:\x` as `/c/x`.
 */
export function msysToWindows(p: string): string {
  const m = /^\/([A-Za-z])(?:\/|$)/.exec(p);
  return m ? `${m[1].toUpperCase()}:/${p.slice(3)}` : p;
}
