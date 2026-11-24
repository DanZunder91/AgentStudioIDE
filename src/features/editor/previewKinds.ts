/**
 * previewKinds — which rendered view a file gets, and what that view can do.
 *
 * Extracted out of `CodeEditor.tsx` when the preview family grew from two kinds
 * (Markdown, CSV) to four (+ HTML, + images). It is the single frontend answer
 * to "what do we show for this path", and it is deliberately a pure
 * extension→kind table with no DOM, no IPC and no store: the mount switch, the
 * header toggle, the zoom cluster and every test read the SAME tables, so a file
 * cannot be previewable in one place and not in another.
 *
 * 🔴 **`isImagePath` is a MIRROR of Rust's `image_mime`
 * (`src-tauri/src/fs_tree.rs`), never a second authority.** Rust gates the bytes
 * — it decides what `read_image_data_url` will serve — while this decides which
 * component mounts. The mirror must stay a SUBSET of Rust's arms, pinned by a
 * test, for exactly the reason `LSP_SERVER_NAMES` is pinned against
 * `registry.rs::spec_for`: there is no codegen between a Rust list and a TS list
 * in this repo, so the coupling is a test plus a same-commit rule. Widening this
 * list without widening Rust's produces an image tab that can never load.
 */

/** Which rendered preview a file supports, or null for none. */
export type PreviewKind = "markdown" | "csv" | "html" | "image";

const MARKDOWN_EXTS = new Set(["md", "markdown", "mdown", "mkd", "mkdn", "mdwn"]);
const CSV_EXTS = new Set(["csv", "tsv"]);
const HTML_EXTS = new Set(["html", "htm"]);

/**
 * Raster image extensions — a SUBSET of `image_mime`'s arms
 * (`src-tauri/src/fs_tree.rs`), minus `svg`, which is handled separately below
 * because it is the one image format that is also text.
 */
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

/**
 * Is this path an image we can display at all (raster **or** SVG)?
 *
 * The mirror of Rust's `image_mime` described in the header. Kept separate from
 * `previewKindOf` because the question "can this be shown as a picture" is asked
 * on its own — by the SVG viewer, which is an image with text behind it.
 */
export function isImagePath(path: string): boolean {
  const ext = extensionOf(path);
  return ext === "svg" || RASTER_EXTS.has(ext);
}

/** Is this an SVG — the one image format that is also editable text? */
export function isSvgPath(path: string): boolean {
  return extensionOf(path) === "svg";
}

/**
 * Does this path have TEXT SOURCE behind the preview — i.e. should a CodeMirror
 * buffer be created for it at all?
 *
 * True for everything except a raster image. This is the predicate that keeps a
 * PNG away from `read_file`, which rejects it as `"binary file"`
 * (`src-tauri/src/fs_tree.rs`) and lands the tab in the *"Can't preview this
 * file."* state. A raster tab therefore has NO view, no
 * dirty flag, no save and no undo — all of which the registry already returns
 * null/false for while a file is loading, so this is a third view-less state
 * rather than a new class of tab.
 */
export function hasTextSource(path: string): boolean {
  return !(previewKindOf(path) === "image" && !isSvgPath(path));
}

/**
 * The label on the "show me the rendered thing" half of the view toggle.
 *
 * The toggle itself only renders when `hasTextSource(path)` — a raster image has
 * no source to flip to.
 */
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

/**
 * Does this preview kind carry the −/%/+ zoom cluster in the header?
 *
 * - **markdown** — yes.
 * - **image** — yes; zoom and Fit are the core interaction for a picture.
 * - **csv** — no; a table is scrolled, not magnified.
 * - **html** — 🔴 **no, in v1, and deliberately.** Preview zoom is the CSS
 *   `zoom` *layout* property, and the HTML preview renders inside a
 *   sandboxed cross-origin iframe: `zoom` on the frame ELEMENT scales the frame
 *   box, not the inner document's layout, and the parent cannot reach into an
 *   opaque-origin document to set it there. Shipping a control that moves the %
 *   label without moving the page would be a control that lies. If HTML zoom is
 *   ever added, the honest route is the protocol handler injecting a zoom hook
 *   into the served document — a deliberate step, not a table row.
 */
export function hasZoom(kind: PreviewKind): boolean {
  return kind === "markdown" || kind === "image";
}

/**
 * Can this path be handed to an **external** browser as a page ("Open in Browser")?
 *
 * Deliberately defined as `previewKindOf(path) === "html"` rather than as a
 * second extension table: a file the IDE renders as a page is exactly a file a
 * browser renders as a page, and the module header forbids a second authority.
 * That also means `.xhtml` is excluded on purpose — `src/lib/language/tables.ts`
 * maps it to the html *grammar*, but it has never been a preview kind, so it
 * gets neither view. Widening is one row in `HTML_EXTS`, for both at once.
 *
 * The three near-misses, and why each is a no:
 *  - **`.svg`** — 🔴 a browser treats a top-level SVG as a *document* and runs
 *    its inline `<script>` (measured in Chromium and WebKit). The image viewer
 *    keeps SVG inside an `<img>` precisely because that sink is inert; this predicate
 *    must not be the caller that undoes it.
 *  - **`.md`** — both engines show the raw markdown as plain text. Strictly
 *    worse than `MarkdownPreview`.
 *  - **`.csv` / `.tsv`** — Chromium starts a *download*, WebKit shows raw text.
 *
 * Note this is not "the browser is better": under `file://` an ES module is
 * blocked in both engines (opaque origin, CORS), which is the one thing the
 * `preview://` handler exists to deliver. The two views are complements.
 */
export function opensInExternalBrowser(path: string): boolean {
  return previewKindOf(path) === "html";
}
