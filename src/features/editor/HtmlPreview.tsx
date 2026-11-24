/**
 * HtmlPreview — the rendered `.html` preview.
 *
 * An HTML display like the Markdown one, with the page's JS and CSS loaded when
 * they sit in the proper place.
 *
 * This component is the **host** half of that feature. The other half is
 * `src-tauri/src/html_preview.rs`, whose module header carries the full
 * architecture rationale — read it first. In one line: the page is served from
 * disk over a custom `preview://` URI scheme, so the previewed document has a
 * **real URL** and its own `<link>`, `<script type="module">`, `@import`,
 * `url(...)` and local `@font-face` resolve natively, with nothing rewritten.
 * Everything here does is point an iframe at that URL and build the jail
 * around it.
 *
 * ## The jail is the feature — read this before editing the iframe
 *
 * The preview runs whatever JavaScript is in the repository the user opened.
 * That is the point of it, so the only question is *where* it runs. Two walls
 * hold it, one on each side of the boundary:
 *
 *   1. **Rust's per-response CSP** (`PREVIEW_CSP`) — `connect-src 'none'`, no
 *      remote origin admitted for anything.
 *   2. **`sandbox="allow-scripts"` on the iframe below, and nothing else.**
 *
 * Wall 2 is this file's entire security responsibility, and every token that is
 * *absent* from that attribute is absent on purpose:
 *
 *   - 🔴 **`allow-same-origin` — NEVER.** `allow-scripts` + `allow-same-origin`
 *     together is the documented sandbox escape: the frame is then same-origin
 *     with its embedder, can reach `parent.document`, and can simply remove its
 *     own `sandbox` attribute and reload itself out of the jail. Without it the
 *     document has an **opaque origin**, which is what actually buys us: no
 *     parent DOM access, no `localStorage`/IndexedDB, no cookies, and no reach
 *     into Tauri IPC.
 *   - **`allow-top-navigation`** (and `-by-user-activation`) — absent, so a
 *     `<a href="https://…" target="_top">` or `top.location = …` cannot
 *     navigate the *app window* away from the IDE. There is no way back from
 *     that; the app has no address bar.
 *   - **`allow-popups`** — absent: no `window.open`, so a preview cannot spawn
 *     an un-sandboxed browsing context.
 *   - **`allow-modals`** — absent: an `alert()`/`confirm()` loop in a page
 *     would otherwise freeze the whole IDE window, not just the frame.
 *   - **`allow-forms`** — absent. It would be inert anyway (Rust sends
 *     `form-action 'none'`), but two walls beat one.
 *   - **`allow-downloads`**, **`allow-pointer-lock`**, **`allow-presentation`**,
 *     **`allow-orientation-lock`**, **`allow-storage-access-by-user-activation`**
 *     — absent; none is needed to render a page and each is a capability
 *     handed to untrusted code for nothing in return.
 *
 * `HtmlPreview.test.tsx` asserts the sandbox attribute as an **exact string**.
 * That test is the regression guard for the whole jail: any widening at all has
 * to be a deliberate edit to a failing test, which is the only kind of change
 * that gets thought about.
 *
 * ## Why there is no zoom and no find bar
 *
 * Both are deliberate absences, both for the same underlying reason — the
 * document is cross-origin and we cannot reach into it.
 *
 *   - **Zoom.** `previewKinds.ts`'s `hasZoom` returns false for `"html"`, so
 *     `CodeEditor` renders no zoom cluster here. Preview zoom is the CSS `zoom`
 *     *layout* property; applied to an iframe **element** that
 *     scales the frame box, not the inner document's layout, and the parent
 *     cannot set it on an opaque-origin document. A control that moved the `%`
 *     label without moving the page would be a control that lies.
 *   - **Find.** `previewFind.ts` paints matches with the CSS Custom Highlight
 *     API over live `Range`s in *our* DOM. There are no Ranges to be had inside
 *     a cross-origin document.
 *
 * ## Why the preview is served from DISK, not from the CodeMirror buffer
 *
 * Markdown, CSV and SVG previews all render the live buffer, so an edit shows
 * the moment you switch back. HTML cannot: the page's own `<link>` and
 * `<script>` are *real requests for real files*, so there is no coherent way to
 * show "the buffer as edited" alongside on-disk assets. `reloadKey` is the
 * store's `editors[path].savedAt`, which bumps on every successful save — that
 * is the moment the preview has something new to show, and it reloads then.
 */

import { useState } from "react";

import "./htmlPreview.css";

/**
 * A Windows absolute path — `C:\dir\x.html` or `C:/dir/x.html`.
 *
 * Detected from the **path shape** rather than from `navigator`/`platform()`
 * because the two coincide (a drive-letter path only ever occurs on Windows)
 * and this way the function stays pure and synchronous: no async platform
 * lookup in front of the first paint, and the Windows spelling is unit-testable
 * from macOS, which is where this repo is developed.
 */
const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/;

/**
 * The `preview://` URL for an **absolute** filesystem path.
 *
 * The URL mirrors the filesystem — `/Users/sam/proj/index.html` becomes
 * `preview://localhost/Users/sam/proj/index.html`. Mirroring is load-bearing,
 * not cosmetic: it is what makes `../shared/a.css` work, because the URL
 * normaliser collapses the `..` into a path that Rust then canonicalizes and
 * scope-checks. (A per-preview token root would have been eaten by that same
 * normaliser on the first `..`.)
 *
 * On **Windows** a Tauri custom scheme is served over the platform spelling
 * `http://preview.localhost/C:/Users/…`, and backslashes become `/` — a URL
 * path has one separator.
 *
 * Each path **segment** is percent-encoded; the `/` separators are not. That
 * split matters twice over:
 *   - Encoding the separators would flatten the whole path into one segment and
 *     break every relative `href` in the document.
 *   - NOT encoding the segments would truncate the URL at the first `#` or `?`
 *     in a directory name — Rust reads `request.uri().path()`, which excludes
 *     the fragment and the query, so `/proj/v#2/index.html` would arrive as
 *     `/proj/v`. A space, a `%`, and non-ASCII are the same story; Rust's
 *     `percent_decode` reverses all of it.
 *
 * `C:` therefore encodes to `C%3A`, which Rust decodes straight back to `C:`
 * before it builds the `PathBuf`. Uniform encoding beats a per-segment special
 * case for the drive letter.
 *
 * Precondition: `path` is absolute. Every path reaching this component comes
 * from the workspace file tree or an open editor tab, both of which are
 * absolute by construction, so there is no guard here for a relative one — an
 * unfalsifiable guard is dead code.
 */
export function previewUrlFor(path: string): string {
  const encoded = path.split(/[\\/]/).map(encodeURIComponent).join("/");
  // A POSIX path already starts with its separator, so it splits to a leading
  // "" and rejoins with the leading "/" intact. A Windows path starts at the
  // drive letter and needs the separator added.
  return WINDOWS_ABSOLUTE_PATH.test(path)
    ? `http://preview.localhost/${encoded}`
    : `preview://localhost${encoded}`;
}

/** The file's basename, for the frame's accessible name. */
function baseNameOf(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1];
}

export function HtmlPreview({
  path,
  reloadKey,
}: {
  path: string;
  reloadKey: number;
}): React.JSX.Element {
  /**
   * Bumped by the Reload button. Combined with `reloadKey` (saves) and the URL
   * (a tab that changed file) into the iframe's `key`.
   *
   * 🔴 **Remount, not `contentWindow.location.reload()`** — the frame has an
   * opaque origin, so touching its `contentWindow` throws a cross-origin
   * SecurityError. **And not a cache-busting `?r=N` query either**, which was
   * the other candidate: that would leave our counter visible to the previewed
   * page through `location.search`, so a page reading its own query string
   * would behave differently under our preview than under a real server — the
   * preview's job is to disagree with a real server as little as possible.
   * Changing the `key` discards the whole browsing context, so the previous
   * run's timers, listeners and module-level state go with it; re-pointing an
   * existing frame's `src` would not.
   *
   * Honest limit: this controls the *document* load. Whether the engine
   * re-fetches `style.css` or serves it from its own HTTP cache is the engine's
   * decision, not ours — `html_preview.rs` answers with `Cache-Control: no-store`.
   */
  const [reloadNonce, setReloadNonce] = useState(0);

  /**
   * The limitations note starts collapsed and stays a single quiet line. The
   * two facts below are real and users *will* hit them, so they have to
   * be visible rather than discovered as mystery breakage — but a warning
   * banner redrawn on every preview is a banner nobody reads.
   */
  const [detailsOpen, setDetailsOpen] = useState(false);

  const url = previewUrlFor(path);

  return (
    <div className="html-preview" data-testid="html-preview">
      <div className="html-preview__bar">
        <button
          type="button"
          className="html-preview__note"
          data-testid="html-preview-note"
          aria-expanded={detailsOpen}
          aria-controls="html-preview-details"
          onClick={() => setDetailsOpen((open) => !open)}
        >
          <span className="html-preview__glyph" aria-hidden="true">
            i
          </span>
          <span className="html-preview__note-text">
            Local files only &mdash; remote URLs and root-absolute paths don&rsquo;t load
          </span>
          <span className="html-preview__caret" aria-hidden="true">
            {/* Both arms are the same length so the bar cannot jitter on toggle. */}
            {detailsOpen ? "\u2303" : "\u2304"}
          </span>
        </button>
        <button
          type="button"
          className="html-preview__reload"
          data-testid="html-preview-reload"
          title="Re-run the page from disk"
          onClick={() => setReloadNonce((n) => n + 1)}
        >
          Reload
        </button>
      </div>

      {detailsOpen && (
        <dl
          className="html-preview__details"
          id="html-preview-details"
          data-testid="html-preview-details"
        >
          <dt>Remote resources are blocked.</dt>
          <dd>
            CDN scripts, web fonts, remote images and <code>fetch</code> all fail. The frame
            can read files from your workspace, so a remote URL would be a working way to
            send them out.
          </dd>
          <dt>There is no document root.</dt>
          <dd>
            <code>/assets/app.css</code> is read as the literal filesystem path{" "}
            <code>/assets/app.css</code> and 404s &mdash; nothing is serving this page. Use a
            relative path (<code>./assets/app.css</code>).
          </dd>
        </dl>
      )}

      <iframe
        // See the header: remount over reload()/cache-bust. The URL is in the key
        // too, so a tab that switches file can never show the old document for a
        // frame.
        key={`${url}|${reloadKey}|${reloadNonce}`}
        className="html-preview__frame"
        data-testid="html-preview-frame"
        src={url}
        // 🔴 EXACTLY this — see the header for why every other token is absent.
        // Never add `allow-same-origin`.
        sandbox="allow-scripts"
        // The frame's requests are already same-scheme and local, but a preview
        // must not hand a page's own URL — an absolute path inside the user's
        // home directory — to anything it fetches. Rust sends the matching
        // response header; this is the request side of the same statement.
        referrerPolicy="no-referrer"
        title={`Rendered preview of ${baseNameOf(path)}`}
      />
    </div>
  );
}
