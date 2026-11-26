/** Host half of the HTML preview; `src-tauri/src/html_preview.rs` explains the design. The jail is
 * the feature: `sandbox="allow-scripts"` and nothing else, NEVER `allow-same-origin` (the sandbox
 * escape). Every absent token is deliberate, and the test pins the exact string. */

import { useState } from "react";

import "./htmlPreview.css";

/** Detected from the path shape so the function stays pure and sync (no platform lookup before
 * first paint) and the Windows spelling is testable on any OS. */
const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/;

/** Mirrors the filesystem so `../` hrefs resolve (Rust canonicalizes and scope-checks). Segments
 * are percent-encoded, separators not: Rust reads `uri().path()`, so a raw `#` or `?` would
 * truncate it. `path` must be absolute; Windows is served as `http://preview.localhost/…`. */
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
  /** Reload bumps the iframe `key`: `contentWindow.location.reload()` throws (opaque origin) and
   * a `?r=N` query would be visible to the page. A remount also drops the previous run's timers and
   * state. Asset caching is the engine's call; Rust sends `no-store`. */
  const [reloadNonce, setReloadNonce] = useState(0);

  /** Collapsed by default: users will hit these limits, but a banner on every load goes unread. */
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
        // A page's own URL is an absolute path inside the user's home: never send it as a referrer.
        // Rust sends the matching response header.
        referrerPolicy="no-referrer"
        title={`Rendered preview of ${baseNameOf(path)}`}
      />
    </div>
  );
}
