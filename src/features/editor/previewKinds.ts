/** Which rendered view a file gets: pure extension→kind tables every consumer reads, so a file is
 * never previewable in one place only. `isImagePath` mirrors Rust's `image_mime` (`fs_tree.rs`) as
 * a test-pinned subset: widen Rust in the same commit or the image tab never loads. */

/** Which rendered preview a file supports, or null for none. */
export type PreviewKind = "markdown" | "csv" | "html" | "image";

const MARKDOWN_EXTS = new Set(["md", "markdown", "mdown", "mkd", "mkdn", "mdwn"]);
const CSV_EXTS = new Set(["csv", "tsv"]);
const HTML_EXTS = new Set(["html", "htm"]);

/** Raster extensions, a subset of `image_mime`'s arms; `svg` is handled apart (it is also text). */
const RASTER_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif"]);

/** The lowercased extension of `path` without its dot, or "" if it has none. */
export function extensionOf(path: string): string {
  const name = path.toLowerCase();
  const slash = Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\"));
  const dot = name.lastIndexOf(".");
  // A dot must be in the BASENAME and not be the leading character of it: a
  // dotfile (`.gitignore`) has no extension, and `~/.config/notes` must not
  // report `config/notes`.
  if (dot <= slash + 1) return "";
  return name.slice(dot + 1);
}

/** Which rendered preview `path` supports, or null for an ordinary text file. */
export function previewKindOf(path: string): PreviewKind | null {
  const ext = extensionOf(path);
  if (MARKDOWN_EXTS.has(ext)) return "markdown";
  if (CSV_EXTS.has(ext)) return "csv";
  if (HTML_EXTS.has(ext)) return "html";
  if (ext === "svg" || RASTER_EXTS.has(ext)) return "image";
  return null;
}

/** Raster or SVG. Separate from `previewKindOf` because the SVG viewer asks it on its own. */
export function isImagePath(path: string): boolean {
  const ext = extensionOf(path);
  return ext === "svg" || RASTER_EXTS.has(ext);
}

/** Is this an SVG — the one image format that is also editable text? */
export function isSvgPath(path: string): boolean {
  return extensionOf(path) === "svg";
}

/** Should a CodeMirror buffer exist? False only for raster images, which `read_file` rejects as
 * `"binary file"`; such a tab has no view, dirty flag, save or undo. */
export function hasTextSource(path: string): boolean {
  return !(previewKindOf(path) === "image" && !isSvgPath(path));
}

/** Label for the rendered half of the view toggle (shown only when `hasTextSource`). */
export function renderedLabel(kind: PreviewKind): string {
  switch (kind) {
    case "csv":
      return "Table";
    case "image":
      return "Image";
    // Markdown and HTML both render a *page*; "Preview" is what Markdown tabs
    // already show and there is no reason to rename it.
    default:
      return "Preview";
  }
}

/** Markdown and images zoom; CSV scrolls. Not HTML: CSS `zoom` on the sandboxed cross-origin
 * iframe scales the box, not the document, so a % control would lie. */
export function hasZoom(kind: PreviewKind): boolean {
  return kind === "markdown" || kind === "image";
}

/** The html preview kind, not a second table. Not `.svg` (a top-level SVG runs its scripts), `.md`
 * (raw text) or `.csv` (a download). Complements `preview://`, which serves ES modules that
 * `file://` blocks. */
export function opensInExternalBrowser(path: string): boolean {
  return previewKindOf(path) === "html";
}
