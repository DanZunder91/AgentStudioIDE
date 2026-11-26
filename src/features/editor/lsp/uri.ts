/** `file://` URI ↔ OS path. The drive letter is returned UPPER-case: servers send `c%3A`, but
 * Rust paths say `C:\`, and tabs dedupe and the Files rail selects by exact path. */

/** Percent-encodes each segment (spaces etc.), keeps `/` + `:`. */
function encodeSegments(slashed: string): string {
  return slashed
    .split("/")
    .map((seg) => encodeURIComponent(seg).replace(/%3A/gi, ":"))
    .join("/");
}

/** OS path → `file://` URI. */
export function uriFromPath(path: string): string {
  const slashed = path.replace(/\\/g, "/");
  // UNC `\\srv\share\x` → `file://srv/share/x`: the server is the URI's authority.
  if (path.startsWith("\\\\")) return `file:${encodeSegments(slashed)}`;
  // A drive-letter path has no leading slash; a POSIX path already does.
  const rooted = /^[A-Za-z]:/.test(path) ? `/${slashed}` : slashed;
  return `file://${encodeSegments(rooted)}`;
}

/** `file://` URI → OS path. Decodes percent-escapes; rebuilds Windows paths. */
export function pathFromUri(uri: string): string {
  // A `file:` URI with an authority names a UNC server: `file://srv/share/x` → `\\srv\share\x`.
  if (/^file:\/\/[^/]/.test(uri)) {
    return `\\\\${decodeURIComponent(uri.slice("file://".length)).replace(/\//g, "\\")}`;
  }
  const body = decodeURIComponent(uri.replace(/^file:\/\//, ""));
  // `/c:/Users/…` → `C:\Users\…`
  if (/^\/[A-Za-z]:/.test(body)) {
    return body.charAt(1).toUpperCase() + body.slice(2).replace(/\//g, "\\");
  }
  return body;
}
