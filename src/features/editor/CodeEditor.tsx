/**
 * CodeEditor — the React surface of the editor (M4; plus the Markdown/CSV preview).
 *
 * Thin by design: it mounts a host div and hands it to the EditorRegistry (which
 * owns the CodeMirror 6 view), and renders the header — filename, the Save
 * affordance when dirty, save feedback, and (for Markdown/CSV) a Rendered↔Source
 * view toggle.
 *
 * For `.md`/`.csv` files the header carries a small toggle: the
 * default view is the RENDERED one (formatted Markdown / a CSV table), with a
 * "Source" button to drop to the raw editor. The CodeMirror host stays mounted at
 * all times (so the buffer loads and `Save`/`currentText` keep working) — it is
 * only visually hidden while the rendered preview is showing.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { useAppStore } from "../../app/store";
import { ContextMenu } from "../../components/ContextMenu";
import { modKey } from "../shortcuts/shortcuts";
import { blameErrorNote } from "./blame/blame";
import { hideBlame, showBlame } from "./blame/blameGutter";
import { gitBlame } from "./blame/blameIpc";
import { CsvTable } from "./CsvTable";
import {
  attach,
  currentText,
  detach,
  ensureEditor,
  getView,
  reloadFromDisk,
  save,
} from "./EditorRegistry";
import { buildEditorMenu } from "./editorMenu";
import { LspStatus } from "./LspStatus";
import { MarkdownPreview } from "./MarkdownPreview";
import { HtmlPreview } from "./HtmlPreview";
import { ImageViewer } from "./ImageViewer";
import { hasTextSource, hasZoom, isSvgPath, previewKindOf, renderedLabel } from "./previewKinds";
import { formatPreviewZoom, PREVIEW_ZOOM_DEFAULT, stepPreviewZoom } from "./previewZoom";
import "./editor.css";

/** The directory containing `path` (for a preview's relative-asset base). */
function dirOf(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i > 0 ? path.slice(0, i) : "";
}

export function CodeEditor({ path }: { path: string }): React.JSX.Element {
  const ui = useAppStore((s) => s.editors[path]);
  const dirty = useAppStore((s) =>
    Object.values(s.tabs).some(
      (t) => t.ref.kind === "editor" && t.ref.path === path && Boolean(t.dirty),
    ),
  );

  const status = ui?.status ?? "loading";
  const saveError = ui?.saveError ?? null;
  const staleOnDisk = ui?.staleOnDisk ?? false;
  const savedAt = ui?.savedAt ?? 0;

  // Markdown-preview zoom lives in the STORE (per file, so it survives tab
  // switches); this component only reads it and steps it. All math/bounds come
  // from previewZoom.ts — never re-derived here.
  const zoom = useAppStore((s) => s.editors[path]?.previewZoom ?? PREVIEW_ZOOM_DEFAULT);
  const setPreviewZoom = useAppStore((s) => s.editorActions.setPreviewZoom);

  const previewKind = previewKindOf(path);
  // Does this path have a CodeMirror buffer behind it? False only for a RASTER
  // image: `read_file` rejects a PNG as "binary file", which is what put
  // image tabs in the "Can't preview this file." state.
  const textBacked = hasTextSource(path);
  // Rendered view is the default for previewable files (so the formatting shows); the
  // toggle drops to raw source. It lives in the STORE, not in `useState`, because
  // `Pane` renders only the active tab and a cross-pane drag
  // re-parents the subtree, so a component-held toggle snapped back to Preview on
  // every tab switch and every move.
  const showSource = useAppStore((s) => s.editors[path]?.showSource ?? false);
  const setShowSource = useAppStore((s) => s.editorActions.setShowSource);
  // Only show a rendered preview once content is available. A raster image has no
  // buffer to wait for — the viewer owns its own load — so it is ready at once.
  const rendered = previewKind !== null && !showSource && (textBacked ? status === "ready" : true);

  // Git blame — per editor INSTANCE (local state, not global): the toggle
  // (driven from the right-click menu), and a transient note when
  // git_blame rejects (not a repo / out of scope).
  const [blameOn, setBlameOn] = useState(false);
  const [blameNote, setBlameNote] = useState<string | null>(null);
  const blameNoteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The editor's right-click "Editor tools" menu — anchored where the
  // pointer was. Only the CM6 host suppresses the native menu; the Markdown/CSV
  // rendered preview keeps it (text-selection niceties like Look Up stay useful
  // on read-only prose).
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  // Reload from disk: re-reads the file the way opening it does.
  // A clean buffer reloads in one click. A DIRTY one would lose the user's edits,
  // so its first click only arms the button ("Discard edits?") and the second does
  // it — the inline two-step the file tree uses for delete, never a native dialog.
  // Disarmed when the pointer leaves or the buffer stops being dirty.
  const [reloadArmed, setReloadArmed] = useState(false);
  if (reloadArmed && !dirty) setReloadArmed(false);
  const onReload = (): void => {
    if (dirty && !reloadArmed) {
      setReloadArmed(true);
      return;
    }
    setReloadArmed(false);
    reloadFromDisk(path);
  };

  const hostRef = useRef<HTMLDivElement | null>(null);
  const initEditor = useAppStore((s) => s.editorActions.initEditor);
  const editorReady = useAppStore((s) => s.editorActions.editorReady);
  useLayoutEffect(() => {
    if (!textBacked) {
      // 🔴 A raster image must never reach `ensureEditor`, which unconditionally
      // calls `read_file` — and `read_file` rejects binary. The tab still needs its
      // `editors[path]` slice, because `setPreviewZoom` / `setShowSource` no-op on a
      // path they do not know, which would leave the zoom buttons inert. Marked
      // ready-and-not-editable by construction: there is nothing to load and nothing
      // to save. `EditorRegistry.dispose` drops the slice on close even with no
      // buffer to tear down (see its early-return comment).
      initEditor(path);
      editorReady(path, false);
      return;
    }
    ensureEditor(path);
    // The host div is rendered whenever the path is text-backed, so the ref is set
    // by the time a layout effect runs — no null branch to guard.
    attach(path, hostRef.current as HTMLDivElement);
    return () => detach(path);
  }, [path, textBacked, initEditor, editorReady]);

  // Fetch + render blame while the toggle is on. `savedAt` is a dependency ON
  // PURPOSE: blame is computed against the file on disk, so every successful
  // save refetches it (a dirty buffer meanwhile shows the "(out of date)" hint).
  useEffect(() => {
    // A raster image has no buffer and no blame; the toggle that sets this lives in
    // the editor context menu, which only renders over the CM6 host.
    if (!blameOn || !textBacked) {
      hideBlame(getView(path));
      return;
    }
    let stale = false; // toggled off / saved again / unmounted before resolve
    gitBlame(path).then(
      (blame) => {
        if (!stale) showBlame(getView(path), blame);
      },
      (err: unknown) => {
        if (stale) return;
        // Calm inline note, auto-dismissed — never a crash, never console spam.
        setBlameOn(false);
        setBlameNote(blameErrorNote(err));
        if (blameNoteTimer.current) clearTimeout(blameNoteTimer.current);
        blameNoteTimer.current = setTimeout(() => setBlameNote(null), 3000);
      },
    );
    return () => {
      stale = true;
    };
  }, [blameOn, savedAt, path, textBacked]);

  // On unmount: drop the gutter from the (surviving) registry view so a remount
  // starts consistent with this instance's fresh local state, and stop the note
  // timer from setting state on an unmounted component.
  useEffect(
    () => () => {
      hideBlame(getView(path));
      if (blameNoteTimer.current) clearTimeout(blameNoteTimer.current);
    },
    [path],
  );

  return (
    <div className="code-editor" data-testid="code-editor" data-path={path}>
      <header className="code-editor__bar">
        <span className="code-editor__name" title={path}>
          {fileName(path)}
        </span>
        <LspStatus path={path} />
        <span className="code-editor__spacer" />
        {/* Git blame: transient error note + stale hint. The toggle itself
            lives in the right-click menu — not a header button. */}
        {blameNote !== null && (
          <span className="code-editor__feedback code-editor__feedback--blame" data-testid="blame-note">
            {blameNote}
          </span>
        )}
        {blameOn && dirty && (
          <span
            className="code-editor__feedback code-editor__feedback--blame"
            data-testid="blame-stale"
            title="Blame is computed against the file on disk — save to refresh it"
          >
            (out of date)
          </span>
        )}
        {/* Rendered↔Source toggle for Markdown/CSV, once the file has loaded. */}
        {previewKind !== null && textBacked && status === "ready" && (
          <div className="code-editor__viewtoggle" role="group" aria-label="View mode">
            <button
              type="button"
              className="code-editor__viewbtn"
              data-testid="view-rendered"
              aria-pressed={!showSource}
              onClick={() => setShowSource(path, false)}
            >
              {renderedLabel(previewKind)}
            </button>
            <button
              type="button"
              className="code-editor__viewbtn"
              data-testid="view-source"
              aria-pressed={showSource}
              onClick={() => setShowSource(path, true)}
            >
              Source
            </button>
          </div>
        )}
        {/* − / % / + preview-zoom controls — shown under exactly the condition
            that mounts <MarkdownPreview> below (CSV and Source view get none).
            The % button resets; ctrl/cmd+scroll in the preview zooms too. */}
        {previewKind !== null && hasZoom(previewKind) && rendered && (
          <div className="code-editor__zoom" role="group" aria-label="Preview zoom">
            <button
              type="button"
              className="code-editor__zoombtn"
              data-testid="preview-zoom-out"
              title={`Zoom out (${modKey()}+scroll)`}
              onClick={() => setPreviewZoom(path, stepPreviewZoom(zoom, -1))}
            >
              −
            </button>
            <button
              type="button"
              className="code-editor__zoombtn code-editor__zoombtn--reset"
              data-testid="preview-zoom-reset"
              title="Reset zoom"
              onClick={() => setPreviewZoom(path, PREVIEW_ZOOM_DEFAULT)}
            >
              {formatPreviewZoom(zoom)}
            </button>
            <button
              type="button"
              className="code-editor__zoombtn"
              data-testid="preview-zoom-in"
              title={`Zoom in (${modKey()}+scroll)`}
              onClick={() => setPreviewZoom(path, stepPreviewZoom(zoom, 1))}
            >
              +
            </button>
          </div>
        )}
        {/* Manual reload. Hidden while the "Changed on disk" prompt is up: that
            prompt carries its own Reload, and two would be one too many. */}
        {textBacked && status === "ready" && !staleOnDisk && (
          <button
            type="button"
            className={`code-editor__reloadbtn${reloadArmed ? " is-armed" : ""}`}
            data-testid="editor-reload-manual"
            title={
              dirty
                ? "Reload from disk — discards your unsaved edits"
                : "Reload from disk"
            }
            aria-label={reloadArmed ? "Confirm: discard edits and reload" : "Reload from disk"}
            onClick={onReload}
            onMouseLeave={() => setReloadArmed(false)}
          >
            {reloadArmed ? "Discard edits?" : <ReloadIcon />}
          </button>
        )}
        {/* Editable by default — the Save affordance is shown while there are unsaved
            edits (a read-only file can't be dirty). */}
        {status === "ready" && dirty && (
          <button
            type="button"
            className="code-editor__save"
            data-testid="editor-save"
            onClick={() => void save(path)}
          >
            Save
          </button>
        )}
        {/* Changed on disk while THIS buffer had unsaved edits. Only ever shown
            for a dirty file — a clean one was already reloaded silently. The
            choice is the user's because the alternative is eating their work. */}
        {staleOnDisk && (
          <span
            className="code-editor__feedback code-editor__feedback--error"
            role="alert"
            data-testid="editor-stale"
          >
            Changed on disk
            <button
              type="button"
              className="code-editor__reload"
              data-testid="editor-reload"
              title="Discard your unsaved edits and load what is on disk"
              onClick={() => reloadFromDisk(path)}
            >
              Reload
            </button>
          </span>
        )}
        {saveError ? (
          <span className="code-editor__feedback code-editor__feedback--error" role="alert">
            {saveError}
          </span>
        ) : savedAt > 0 && !dirty ? (
          <span className="code-editor__feedback code-editor__feedback--saved">Saved</span>
        ) : null}
      </header>

      {textBacked && status === "loading" && (
        <div className="code-editor__state">Loading&hellip;</div>
      )}
      {textBacked && status === "error" && (
        <div className="code-editor__state">Can&rsquo;t preview this file.</div>
      )}
      {/* The rendered preview. Markdown, CSV and SVG all read the LIVE buffer via
          `currentText`, so a Source-mode edit shows the moment you switch back —
          and for SVG, as you type. HTML is the exception and says so below. */}
      {rendered && previewKind === "markdown" && (
        <MarkdownPreview
          text={currentText(path) ?? ""}
          path={path}
          basePath={dirOf(path)}
          zoom={zoom}
          onZoomChange={(z) => setPreviewZoom(path, z)}
        />
      )}
      {rendered && previewKind === "csv" && <CsvTable text={currentText(path) ?? ""} />}
      {rendered && previewKind === "image" && (
        <ImageViewer
          path={path}
          // An SVG is the one image that is also text, so its picture is built from
          // the live buffer — edit the source and the drawing follows. A raster has
          // no buffer at all and the viewer fetches its bytes itself.
          svgText={isSvgPath(path) ? (currentText(path) ?? "") : null}
          zoom={zoom}
          onZoomChange={(z) => setPreviewZoom(path, z)}
        />
      )}
      {rendered && previewKind === "html" && (
        // Served from DISK by the `preview://` handler, not from the buffer: the
        // page's own <link> and <script> are real requests for real files, so there
        // is nothing coherent to render "as edited" until the edit is on disk.
        // `savedAt` bumps on every successful save, which reloads the frame.
        <HtmlPreview path={path} reloadKey={savedAt} />
      )}
      {textBacked && (
        <div
          ref={hostRef}
          className="code-editor__host"
          data-testid="editor-host"
          style={status === "ready" && !rendered ? undefined : { display: "none" }}
          onContextMenu={(e) => {
            // OUR menu, not the native WebKit one (Look Up / Translate / …).
            e.preventDefault();
            setMenu({ x: e.clientX, y: e.clientY });
          }}
        />
      )}
      {menu !== null && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          ariaLabel="Editor tools"
          onClose={() => setMenu(null)}
          items={buildEditorMenu({
            view: getView(path),
            editable: ui?.editable ?? false,
            blameOn,
            onToggleBlame: () => setBlameOn((on) => !on),
          })}
        />
      )}
    </div>
  );
}

/** The file's basename, for the header. */
function fileName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1];
}

/** Circular-arrow glyph for the manual reload button. */
function ReloadIcon(): React.JSX.Element {
  return (
    <svg
      width={13}
      height={13}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M13.25 8A5.25 5.25 0 1 1 11.7 4.3" />
      <path d="M12.25 1.75v3h-3" />
    </svg>
  );
}
