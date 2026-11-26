/** The ONE place that splits, joins, compares and prefix-tests UI paths (Rust sends native paths;
 * some sites meet mixed separators). Either separator counts; segment-aware; case ignored only for
 * Windows-shaped paths; answers keep the input's spelling (normalized copies keep the length). */

/** Matches either path separator — "/" (POSIX, and accepted by Windows) or "\" (Windows). */
export const SEPARATOR = /[\\/]/;

/** A run of separators. */
const SEPARATORS = /[\\/]+/;

/** A drive letter plus colon, alone or followed by a separator: `C:`, `C:\…`, `c:/…`. */
const DRIVE = /^[A-Za-z]:(?:[\\/]|$)/;

/** Drive letter (`C:\x`, `C:/x`, `C:`) or UNC (`\\srv\share`), read from the SHAPE, not the
 * platform (no POSIX path starts so), so pure tests pin Windows behaviour on any OS. */
export function isWindowsPath(p: string): boolean {
  return DRIVE.test(p) || p.startsWith("\\\\");
}

/** Absolute on either platform: `/x`, `C:\x`, `C:/x`, `\\srv\share`, and `\x` (Windows resolves
 * it against the current drive's root). */
export function isAbsolutePath(p: string): boolean {
  return /^(?:[\\/]|[A-Za-z]:[\\/])/.test(p);
}

/** The separator `p` uses: "\" if it has one, "/" if only "/"; with none, "\" for a bare
 * drive (`C:`), else "/". */
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

/** Parent in `p`'s own spelling: a root is its own parent, `/w` → `/`, `C:\w` → `C:\`, a bare
 * name → `""`. Trailing separators are ignored. */
export function dirname(p: string): string {
  const t = trimTrailingSeparators(p);
  const min = rootLength(t);
  let i = t.length;
  while (i > min && !SEPARATOR.test(t[i - 1])) i -= 1;
  return i <= min ? t.slice(0, min) : trimTrailingSeparators(t.slice(0, i - 1));
}

/** `rel` under `dir` with exactly one separator. Under a Windows dir "/" becomes "\" (matching
 * the tree and git status); under a POSIX dir `rel` is kept byte for byte ("\" is a name char). */
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

/** Same path ignoring separator kind, repeats and trailing ones, and (Windows-shaped) case.
 * Purely textual: no `..` resolution, no symlinks. */
export function samePath(a: string, b: string): boolean {
  const fold = foldsCase(a, b);
  return equalityForm(a, fold) === equalityForm(b, fold);
}

/** `path` relative to `root` (`""` for the root itself, `null` if outside), sliced from `path`
 * so it keeps its own separators and case. Segment-aware; case-insensitive for Windows paths. */
export function relativeTo(root: string, path: string): string | null {
  const fold = foldsCase(root, path);
  const r = comparable(trimTrailingSeparators(root), fold);
  const p = comparable(path, fold);
  if (!p.startsWith(r)) return null;
  // The segment-boundary rule. A root that ends in a separator (`/`, `C:\`) is its own boundary.
  if (p.length > r.length && !r.endsWith("/") && p[r.length] !== "/") return null;
  return trimTrailingSeparators(path.slice(r.length).replace(/^[\\/]+/, ""));
}

/** `rel` spelled for the screen like `root`: "/" → "\" under a Windows-shaped root, else byte
 * for byte. Display only: never send the answer back to Rust. */
export function displayRelative(root: string, rel: string): string {
  return isWindowsPath(root) ? rel.replace(/\//g, "\\") : rel;
}

/** `path` with the home folder as `~` (`~/projects/app`, `~\projects\app`; case-insensitive on
 * Windows; segment-aware). Unchanged when `home` is unknown, a bare root or not an ancestor.
 * Display only: `~` means nothing to Rust. */
export function tildeHome(path: string, home: string | null): string {
  if (!home) return path;
  const h = trimTrailingSeparators(home);
  if (dirname(h) === h) return path; // a root: "~" would claim the whole disk
  const rel = relativeTo(h, path);
  if (rel === null) return path;
  return rel === "" ? "~" : `~${separatorOf(path)}${rel}`;
}

/** Whether `path` ends in exactly `tail`'s segments (no partial segment). Separator-agnostic;
 * case-insensitive when `path` is Windows-shaped. */
export function endsWithSegments(path: string, tail: string): boolean {
  const fold = foldsCase(path, tail);
  const p = equalityForm(path, fold);
  const t = equalityForm(tail, fold);
  return t !== "" && (p === t || p.endsWith(`/${t}`));
}

/** Git Bash (MSYS) drive path to Windows spelling: `/c/Users/me` → `C:/Users/me`, `/d` → `D:/`.
 * Claude Code on Windows runs its Bash tool in Git Bash, so agents name `C:\x` as `/c/x`. */
export function msysToWindows(p: string): string {
  const m = /^\/([A-Za-z])(?:\/|$)/.exec(p);
  return m ? `${m[1].toUpperCase()}:/${p.slice(3)}` : p;
}
