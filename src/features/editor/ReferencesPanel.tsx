/**
 * ReferencesPanel — the find-usages results (M5).
 *
 * A bottom-docked tool window (the classic IntelliJ/VS Code "Find Usages"
 * placement, distinct from the top-docked Find-in-Files overlay) listing every
 * usage of a symbol. Opened by Cmd/Ctrl+Click on a symbol's DECLARATION or
 * Shift+F12 at the cursor (see `lsp/references.ts` + `lsp/definition.ts`); it
 * reads the sole store seam `lspReferences` and closes via `clearReferences`.
 *
 * Rows mirror Find-in-Files: grouped by file (collapsible), each hit a line
 * number + the source line with the reference span marked. Clicking a hit reveals
 * it in the editor AND closes the panel (so the file is visible) — the same
 * click-to-open-and-close that Find does.
 */

import { useCallback, useEffect, useState } from "react";

import { ChevronIcon, CloseIcon } from "../../components/icons";
import { useAppStore, type ReferenceHit } from "../../app/store";
import { revealInEditor } from "./reveal";
import "./references.css";

/** The last path segment (display name); the rest is its dim dir. */
function splitPath(path: string): { name: string; dir: string } {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i < 0 ? { name: path, dir: "" } : { name: path.slice(i + 1), dir: path.slice(0, i) };
}

/** Group hits by display path, preserving first-seen (server) order. */
interface FileGroup {
  file: string;
  hits: ReferenceHit[];
}
function groupByFile(hits: ReferenceHit[]): FileGroup[] {
  const order: string[] = [];
  const byFile = new Map<string, ReferenceHit[]>();
  for (const h of hits) {
    let bucket = byFile.get(h.display);
    if (!bucket) {
      bucket = [];
      byFile.set(h.display, bucket);
      order.push(h.display);
    }
    bucket.push(h);
  }
  return order.map((file) => ({ file, hits: byFile.get(file) as ReferenceHit[] }));
}

/** The source line with leading indentation trimmed and the reference span marked. */
function HitLine({ hit }: { hit: ReferenceHit }): React.JSX.Element {
  const { lineText, matchStart, matchEnd } = hit;
  const leading = lineText.length - lineText.trimStart().length;
  const body = lineText.slice(leading);
  const start = Math.max(0, Math.min(matchStart - leading, body.length));
  const end = Math.max(start, Math.min(matchEnd - leading, body.length));
  return (
    <span className="refs-hit__code">
      {body.slice(0, start)}
      <mark className="refs-hit__mark">{body.slice(start, end)}</mark>
      {body.slice(end)}
    </span>
  );
}

export function ReferencesPanel(): React.JSX.Element | null {
  const references = useAppStore((s) => s.lspReferences);
  const clearReferences = useAppStore((s) => s.lspActions.clearReferences);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  // Esc closes the panel (only while open). Installed unconditionally so the hook
  // order is stable; the early `null` return below happens after the hooks.
  useEffect(() => {
    if (!references) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") clearReferences();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [references, clearReferences]);

  const toggleFile = useCallback((file: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(file)) next.delete(file);
      else next.add(file);
      return next;
    });
  }, []);

  const openHit = useCallback(
    (hit: ReferenceHit) => {
      void revealInEditor(hit.path, hit.line, hit.col);
      clearReferences(); // jump AND close, so the opened file is visible
    },
    [clearReferences],
  );

  if (!references) return null;

  const { symbol, hits, loading } = references;
  const groups = groupByFile(hits);

  return (
    <div className="refs-panel" role="dialog" aria-label="Find usages" data-testid="references-panel">
      <div className="refs-panel__bar">
        <span className="refs-panel__title">
          {loading ? (
            <>
              Finding usages of <code className="refs-panel__symbol">{symbol}</code>&hellip;
            </>
          ) : (
            <>
              {hits.length} {hits.length === 1 ? "usage" : "usages"} of{" "}
              <code className="refs-panel__symbol">{symbol}</code>
            </>
          )}
        </span>
        <button
          type="button"
          className="refs-panel__close"
          aria-label="Close usages"
          title="Close (Esc)"
          onClick={clearReferences}
        >
          <CloseIcon size={12} />
        </button>
      </div>

      {!loading && hits.length === 0 ? (
        <div className="refs-panel__status">No usages found</div>
      ) : (
        <ul className="refs-groups">
          {groups.map((group) => {
            const isCollapsed = collapsed.has(group.file);
            const { name, dir } = splitPath(group.file);
            return (
              <li key={group.file} className="refs-group">
                <button
                  type="button"
                  className="refs-group__header"
                  aria-expanded={!isCollapsed}
                  data-testid="reference-file"
                  onClick={() => toggleFile(group.file)}
                >
                  <span className={`refs-group__caret${isCollapsed ? "" : " is-open"}`}>
                    <ChevronIcon size={11} />
                  </span>
                  <span className="refs-group__name">{name}</span>
                  {dir && <span className="refs-group__dir">{dir}</span>}
                  <span className="refs-group__badge">{group.hits.length}</span>
                </button>
                {!isCollapsed && (
                  <ul className="refs-group__hits">
                    {group.hits.map((hit, i) => (
                      <li key={i}>
                        <button
                          type="button"
                          className="refs-hit"
                          data-testid="reference-hit"
                          onClick={() => openHit(hit)}
                        >
                          <span className="refs-hit__ln">{hit.line}</span>
                          <HitLine hit={hit} />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
