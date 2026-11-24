/**
 * previewKinds — the single frontend answer to "what rendered view does this
 * path get" (Markdown/CSV, HTML/images).
 *
 * Two things here are load-bearing beyond the ordinary table lookups:
 *
 *  1. `hasTextSource` is what keeps a raster image away from `read_file`, which
 *     rejects binary and produced *"Can't preview this file."* —
 *     while still giving an SVG the CodeMirror buffer its Source↔Image toggle
 *     needs. It is tested in both directions, per format.
 *  2. The image list is a MIRROR of Rust's `image_mime`
 *     (`src-tauri/src/fs_tree.rs`), never a second authority. There is no
 *     codegen between them, so the coupling is a test — the same idiom
 *     `LSP_SERVER_NAMES` uses against `registry.rs::spec_for`. The last
 *     `describe` block reads the Rust file off disk and pins the subset.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  extensionOf,
  hasTextSource,
  hasZoom,
  isImagePath,
  isSvgPath,
  opensInExternalBrowser,
  previewKindOf,
  renderedLabel,
} from "./previewKinds";

/** Every raster format the TS table claims — enumerated once, reused per suite. */
const RASTER = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif"];

/** Every spelling of Markdown the preview accepts. */
const MARKDOWN = ["md", "markdown", "mdown", "mkd", "mkdn", "mdwn"];

describe("extensionOf", () => {
  it("returns the extension of an ordinary path, without the dot", () => {
    expect(extensionOf("/home/sam/notes.md")).toBe("md");
  });

  it("returns the extension of a bare filename with no directory", () => {
    expect(extensionOf("README.md")).toBe("md");
  });

  it("lowercases the extension, so a shouty filename still previews", () => {
    // Cameras and scanners emit `IMG_0001.JPG`; the tables are lowercase.
    expect(extensionOf("/photos/IMG_0001.JPG")).toBe("jpg");
  });

  it("returns \"\" for a path with no dot at all", () => {
    expect(extensionOf("/usr/local/bin/claude")).toBe("");
  });

  it("returns \"\" for a dotfile — a leading dot is not an extension", () => {
    // `.gitignore` must NOT report `gitignore`; it is a name, not a type.
    expect(extensionOf(".gitignore")).toBe("");
    expect(extensionOf("/home/sam/.gitignore")).toBe("");
  });

  it("still reads the extension of a dotfile that has one", () => {
    expect(extensionOf("/home/sam/.eslintrc.json")).toBe("json");
  });

  it("returns \"\" when the only dot is in a DIRECTORY, not the basename", () => {
    // Without the `dot > slash` rule this reports `config/notes`, which would
    // then match nothing — or, worse, something.
    expect(extensionOf("/home/sam/.config/notes")).toBe("");
  });

  it("takes only the last segment of a multi-dot name", () => {
    expect(extensionOf("archive.tar.gz")).toBe("gz");
  });

  it("handles Windows backslash separators", () => {
    expect(extensionOf("C:\\Users\\sam\\notes.md")).toBe("md");
  });

  it("returns \"\" when the only dot is in a Windows DIRECTORY segment", () => {
    expect(extensionOf("C:\\Users\\sam\\.config\\notes")).toBe("");
  });

  it("returns \"\" for the empty string", () => {
    expect(extensionOf("")).toBe("");
  });
});

describe("previewKindOf", () => {
  it("returns \"markdown\" for every Markdown alias", () => {
    for (const ext of MARKDOWN) {
      expect(previewKindOf(`/docs/notes.${ext}`), ext).toBe("markdown");
    }
  });

  it("returns \"csv\" for csv and tsv", () => {
    expect(previewKindOf("/data/rows.csv")).toBe("csv");
    expect(previewKindOf("/data/rows.tsv")).toBe("csv");
  });

  it("returns \"html\" for html and htm", () => {
    expect(previewKindOf("/site/index.html")).toBe("html");
    expect(previewKindOf("/site/index.htm")).toBe("html");
  });

  it("returns \"image\" for every raster extension", () => {
    for (const ext of RASTER) {
      expect(previewKindOf(`/photos/shot.${ext}`), ext).toBe("image");
    }
  });

  it("returns \"image\" for svg, which is a picture even though it is text", () => {
    expect(previewKindOf("/icons/logo.svg")).toBe("image");
  });

  it("returns null for an ordinary source file", () => {
    expect(previewKindOf("/src/app/store.ts")).toBeNull();
    expect(previewKindOf("/src-tauri/src/lib.rs")).toBeNull();
  });

  it("returns null for a file with no extension", () => {
    expect(previewKindOf("/home/sam/Makefile")).toBeNull();
  });

  it("is case-insensitive, because the lookup goes through extensionOf", () => {
    expect(previewKindOf("/docs/README.MD")).toBe("markdown");
    expect(previewKindOf("/photos/SHOT.PNG")).toBe("image");
  });
});

describe("isImagePath", () => {
  it("is true for every raster extension", () => {
    for (const ext of RASTER) {
      expect(isImagePath(`/photos/shot.${ext}`), ext).toBe(true);
    }
  });

  it("is true for svg", () => {
    expect(isImagePath("/icons/logo.svg")).toBe(true);
  });

  it("is false for every non-image preview kind and for plain source", () => {
    for (const path of ["/docs/notes.md", "/data/rows.csv", "/site/index.html", "/src/app/store.ts", "/Makefile"]) {
      expect(isImagePath(path), path).toBe(false);
    }
  });
});

describe("isSvgPath", () => {
  it("is true for an .svg path, in any case", () => {
    expect(isSvgPath("/icons/logo.svg")).toBe(true);
    expect(isSvgPath("/icons/LOGO.SVG")).toBe(true);
  });

  it("is false for a raster image — the one distinction the toggle depends on", () => {
    for (const ext of RASTER) {
      expect(isSvgPath(`/photos/shot.${ext}`), ext).toBe(false);
    }
  });

  it("is false for a non-image file", () => {
    expect(isSvgPath("/docs/notes.md")).toBe(false);
  });
});

describe("hasTextSource", () => {
  /**
   * 🔴 The predicate raster tabs turn on. A raster tab must NOT ask
   * `read_file` for its bytes: Rust rejects it as a binary file and the tab
   * lands in the *"Can't preview this file."* state. So: false for a
   * raster, true for absolutely everything else.
   */
  it("is false for every raster image, which has no text to load", () => {
    for (const ext of RASTER) {
      expect(hasTextSource(`/photos/shot.${ext}`), ext).toBe(false);
    }
  });

  it("is true for an SVG — its CodeMirror buffer is what the Source toggle shows", () => {
    // An SVG previews as an image AND has editable source behind it; drop this
    // and the Source↔Image toggle has nothing to flip to and no live preview.
    expect(hasTextSource("/icons/logo.svg")).toBe(true);
  });

  it("is true for every non-image preview kind", () => {
    for (const path of ["/docs/notes.md", "/data/rows.csv", "/data/rows.tsv", "/site/index.html"]) {
      expect(hasTextSource(path), path).toBe(true);
    }
  });

  it("is true for an ordinary text file and for one with no extension", () => {
    expect(hasTextSource("/src/app/store.ts")).toBe(true);
    expect(hasTextSource("/home/sam/Makefile")).toBe(true);
  });
});

describe("renderedLabel", () => {
  it("labels the CSV view \"Table\"", () => {
    expect(renderedLabel("csv")).toBe("Table");
  });

  it("labels the image view \"Image\"", () => {
    expect(renderedLabel("image")).toBe("Image");
  });

  it("labels Markdown \"Preview\" — the word Markdown tabs already show", () => {
    expect(renderedLabel("markdown")).toBe("Preview");
  });

  it("labels HTML \"Preview\" too, because both render a page", () => {
    expect(renderedLabel("html")).toBe("Preview");
  });
});

describe("hasZoom", () => {
  it("is true for markdown", () => {
    expect(hasZoom("markdown")).toBe(true);
  });

  it("is true for an image, where zoom and Fit are the core interaction", () => {
    expect(hasZoom("image")).toBe(true);
  });

  it("is false for csv — a table is scrolled, not magnified", () => {
    expect(hasZoom("csv")).toBe(false);
  });

  it("is false for html because CSS `zoom` cannot reach into the sandboxed cross-origin iframe, so the control would move the % label without moving the page", () => {
    // Pinned WITH its reason so a future change has to argue with it rather
    // than read this as an oversight. If HTML zoom is ever added, the honest route
    // is the protocol handler injecting a zoom hook into the served document —
    // a deliberate step, not a flip of this table row.
    expect(hasZoom("html")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The mirror pin.
// ---------------------------------------------------------------------------

/**
 * Read from disk, from the repo root (`process.cwd()` under vitest — the same
 * idiom `cspReporter.test.ts` uses to read `tauri.conf.json`; `new URL(…,
 * import.meta.url)` is not a `file:` URL here because the module graph is
 * served over http by Vite).
 */
const RUST_SOURCE = resolve(process.cwd(), "src-tauri/src/fs_tree.rs");
const TS_SOURCE = resolve(process.cwd(), "src/features/editor/previewKinds.ts");

/**
 * Extensions Rust's `image_mime` will serve, parsed out of its match block.
 *
 * Throws rather than returning `[]` if the shape it expects is gone: a check
 * that silently ran over an empty set reads exactly like a passing check.
 */
function rustImageExtensions(): Set<string> {
  const src = readFileSync(RUST_SOURCE, "utf8");
  const fnAt = src.indexOf("fn image_mime(");
  if (fnAt === -1) {
    throw new Error(
      `Could not find \`fn image_mime(\` in ${RUST_SOURCE}. This test pins the TS image list ` +
        `against that function; if it was renamed or moved, update this parser — do NOT delete ` +
        `the pin, or the two lists drift silently.`,
    );
  }
  const matchAt = src.indexOf("match ext.as_str() {", fnAt);
  if (matchAt === -1) {
    throw new Error(
      `Found \`fn image_mime(\` in ${RUST_SOURCE} but not its \`match ext.as_str() {\` block. ` +
        `Update this parser to the function's new shape.`,
    );
  }

  // Brace-booking from the match's `{` to its `}` so the parse cannot run off
  // the end of the function and pick up unrelated arms.
  const open = src.indexOf("{", matchAt);
  let depth = 0;
  let close = -1;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1) {
    throw new Error(`Unbalanced braces in \`image_mime\`'s match block (${RUST_SOURCE}).`);
  }

  const exts = new Set<string>();
  for (const line of src.slice(open + 1, close).split("\n")) {
    const arrow = line.indexOf("=>");
    if (arrow === -1) continue;
    // Only the PATTERN side: the right-hand side is a MIME string, not an
    // extension. `"jpg" | "jpeg" => …` contributes both.
    for (const [, ext] of line.slice(0, arrow).matchAll(/"([^"]+)"/g)) exts.add(ext);
  }
  return exts;
}

/**
 * Extensions the TS side treats as images, derived from `previewKinds.ts`'s own
 * source rather than from a hand-copied list — otherwise adding one to the
 * module without adding it here would leave the pin passing over a stale set.
 *
 * Every string literal in the module (comments stripped, so prose cannot inject
 * a phantom extension) is offered to the real `isImagePath`; the ones it accepts
 * ARE the TS image surface. That also makes the parse self-checking: a literal
 * this returns is one the shipping predicate genuinely calls an image.
 */
function tsImageExtensions(): Set<string> {
  const src = readFileSync(TS_SOURCE, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  const exts = new Set<string>();
  for (const [, literal] of src.matchAll(/"([^"\n]*)"/g)) {
    if (isImagePath(`file.${literal}`)) exts.add(literal);
  }
  return exts;
}

/**
 * Extensions Rust serves that the TS side deliberately does not surface.
 * Empty today, and it should stay that way: an entry here is a decision that
 * needs a reason written next to it, not a place to silence drift.
 */
const RUST_ONLY_ALLOWED: readonly string[] = [];

describe("the image list mirrors Rust's image_mime", () => {
  it("parses a non-empty extension list out of both sides", () => {
    // The guard against a vacuous pass: if either parser matched nothing, the
    // subset assertions below would trivially hold.
    const rust = rustImageExtensions();
    const ts = tsImageExtensions();
    expect(rust.size, `parsed no arms out of image_mime in ${RUST_SOURCE}`).toBeGreaterThan(0);
    expect(ts.size, `parsed no image extensions out of ${TS_SOURCE}`).toBeGreaterThan(0);
    // Anchors: these two will not leave either list by accident, so their
    // absence means the PARSE broke, not the product.
    expect([...rust].sort(), "Rust anchors").toEqual(expect.arrayContaining(["png", "svg"]));
    expect([...ts].sort(), "TS anchors").toEqual(expect.arrayContaining(["png", "svg"]));
  });

  it("every extension the TS side treats as an image is one Rust will serve", () => {
    const rust = rustImageExtensions();
    const orphans = [...tsImageExtensions()].filter((ext) => !rust.has(ext)).sort();
    expect(
      orphans,
      orphans.length === 0
        ? ""
        : `previewKinds.ts treats ${orphans.map((e) => `.${e}`).join(", ")} as an image, but ` +
          `image_mime() in src-tauri/src/fs_tree.rs will not serve it — read_image_data_url ` +
          `returns an error, so the image tab mounts and can NEVER load. Fix by adding the same ` +
          `extension(s) to image_mime's match (with the right MIME) in the SAME commit, or by ` +
          `removing them from previewKinds.ts. Rust serves: ${[...rust].sort().join(", ")}.`,
    ).toEqual([]);
  });

  it("reports any extension Rust serves that the TS side does not surface", () => {
    const ts = tsImageExtensions();
    const unsurfaced = [...rustImageExtensions()]
      .filter((ext) => !ts.has(ext) && !RUST_ONLY_ALLOWED.includes(ext))
      .sort();
    expect(
      unsurfaced,
      unsurfaced.length === 0
        ? ""
        : `image_mime() in src-tauri/src/fs_tree.rs serves ` +
          `${unsurfaced.map((e) => `.${e}`).join(", ")}, but previewKinds.ts does not open an ` +
          `image tab for it, so the user sees a "Can't preview this file." tab for a file the ` +
          `backend would happily render. Fix by adding it to previewKinds.ts, or — if the omission ` +
          `is deliberate — by listing it in RUST_ONLY_ALLOWED in this file WITH the reason.`,
    ).toEqual([]);
  });
});

describe("opensInExternalBrowser", () => {
  it("is true for every spelling of an HTML page", () => {
    for (const path of ["/w/index.html", "/w/page.htm", "/w/INDEX.HTML"]) {
      expect(opensInExternalBrowser(path), path).toBe(true);
    }
  });

  it("is false for an SVG, because a browser tab RUNS its inline script", () => {
    // The image viewer keeps SVG inside an inert <img>. A browser treats a top-level
    // SVG as a document and executes the script, so this predicate must never
    // be the call site that hands one over.
    expect(opensInExternalBrowser("/w/logo.svg")).toBe(false);
  });

  it("is false for the kinds a browser renders WORSE than we do", () => {
    // Markdown shows as raw text in both engines; a CSV downloads in Chromium.
    for (const path of ["/w/README.md", "/w/rows.csv", "/w/rows.tsv", "/w/photo.png"]) {
      expect(opensInExternalBrowser(path), path).toBe(false);
    }
  });

  it("is false for ordinary source, and for .xhtml (not a preview kind here)", () => {
    for (const path of ["/w/main.rs", "/w/app.ts", "/w/page.xhtml", "/w/Makefile"]) {
      expect(opensInExternalBrowser(path), path).toBe(false);
    }
  });

  it("agrees with previewKindOf, so the two views can never disagree", () => {
    // The predicate is DEFINED as `previewKindOf === "html"`; this pins that it
    // stays defined that way rather than drifting into a second table.
    for (const path of ["/w/a.html", "/w/a.htm", "/w/a.md", "/w/a.svg", "/w/a.rs"]) {
      expect(opensInExternalBrowser(path), path).toBe(previewKindOf(path) === "html");
    }
  });
});
