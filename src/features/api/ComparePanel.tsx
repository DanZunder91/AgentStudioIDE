/** A/B compare for the HTTP lane: `CompareBar` (B's method + URL; B reuses A's headers and body)
 * and `ComparePanel` (replaces ResponsePanel; bodies only). Compare state lives in the store
 * (survives tab switches); the shared `compare.selectedKey` IS the cross-highlight sync. */

import { useEffect, useRef } from "react";

import { useAppStore } from "../../app/store";
import type { CompareOutcome } from "../../app/store";
import { HTTP_METHODS } from "./execute";
import { ResponseBody } from "./ResponseBody";
import { sortJsonKeys } from "./jsonSort";
import {
  formatBody,
  humanizeSize,
  parseJsonBody,
  statusClass,
} from "./responseFormat";
import "./compare.css";

/** Request B's bar (same `api-bar` chrome; `compare-bar` for compare-only tweaks). Null for an
 * unknown requestId, keeping the view total. */
export function CompareBar({
  requestId,
  onSend,
}: {
  requestId: string;
  onSend: () => void;
}): React.JSX.Element | null {
  const req = useAppStore((s) => s.apiRequests[requestId]);
  const patchCompare = useAppStore((s) => s.apiActions.patchCompare);
  if (!req) return null;
  const compare = req.compare;

  // Cmd/Ctrl+Enter sends from the B URL field, matching the A bar's shortcut.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      onSend();
    }
  };

  return (
    <div className="api-bar compare-bar" data-testid="compare-bar">
      <select
        className="api-method"
        aria-label="Request B method"
        value={compare.method}
        onChange={(e) => patchCompare(requestId, { method: e.target.value })}
      >
        {HTTP_METHODS.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
      <input
        className="api-url"
        type="text"
        aria-label="Request B URL"
        placeholder="https://api.example.com/…  (request B)"
        value={compare.url}
        onChange={(e) => patchCompare(requestId, { url: e.target.value })}
        onKeyDown={onKeyDown}
      />
      {/* Honest about what travels: B reuses A's headers and body. */}
      <span className="compare-bar__hint">same headers &amp; body as A</span>
    </div>
  );
}

/** The side-by-side A/B response surface; null for an unknown requestId. */
export function ComparePanel({
  requestId,
}: {
  requestId: string;
}): React.JSX.Element | null {
  const req = useAppStore((s) => s.apiRequests[requestId]);
  const setCompareSelectedKey = useAppStore(
    (s) => s.apiActions.setCompareSelectedKey,
  );
  const setCompareSortKeys = useAppStore(
    (s) => s.apiActions.setCompareSortKeys,
  );
  if (!req) return null;
  const compare = req.compare;
  const { selectedKey, sortKeys } = compare;

  // Clicking a key toggles the selection: the same name again clears it. The
  // store write is the whole cross-pane sync — both panes re-render off it.
  const onSelectKey = (k: string) =>
    setCompareSelectedKey(requestId, k === selectedKey ? null : k);

  return (
    <section className="api-response-panel compare" data-testid="compare-panel">
      <div className="compare-toolbar">
        <button
          type="button"
          className="api-add-header"
          data-testid="compare-sort"
          aria-pressed={sortKeys}
          onClick={() => setCompareSortKeys(requestId, !sortKeys)}
        >
          Sort keys
        </button>
        {selectedKey !== null && (
          <button
            type="button"
            className="compare-selected"
            data-testid="compare-selected"
            title="Clear the selected key"
            onClick={() => setCompareSelectedKey(requestId, null)}
          >
            {selectedKey} ✕
          </button>
        )}
      </div>
      <div className="compare-split" data-testid="compare-split">
        <ComparePane
          side="a"
          requestId={requestId}
          method={req.method}
          url={req.url}
          outcome={compare.a}
          sending={compare.sending}
          selectedKey={selectedKey}
          sortKeys={sortKeys}
          onSelectKey={onSelectKey}
        />
        <ComparePane
          side="b"
          requestId={requestId}
          method={compare.method}
          url={compare.url}
          outcome={compare.b}
          sending={compare.sending}
          selectedKey={selectedKey}
          sortKeys={sortKeys}
          onSelectKey={onSelectKey}
        />
      </div>
    </section>
  );
}

/** One side: head (label, method+url echo, status once landed) over the side's scroll box. Each
 * pane owns its scroll-into-view effect. */
function ComparePane({
  side,
  requestId,
  method,
  url,
  outcome,
  sending,
  selectedKey,
  sortKeys,
  onSelectKey,
}: {
  side: "a" | "b";
  /** The tab's stable identity; with `side` it keys the find bar's state. */
  requestId: string;
  method: string;
  url: string;
  outcome: CompareOutcome;
  sending: boolean;
  selectedKey: string | null;
  sortKeys: boolean;
  onSelectKey: (key: string) => void;
}): React.JSX.Element {
  const bodyRef = useRef<HTMLDivElement>(null);

  // Bring this pane's FIRST occurrence of a new selection into view. `el` can be null (error
  // pane, key absent) and jsdom lacks `scrollIntoView`, hence both `?.`s.
  useEffect(() => {
    if (selectedKey === null) return;
    const el = bodyRef.current!.querySelector<HTMLElement>(
      '[data-selected="true"]',
    );
    el?.scrollIntoView?.({ block: "nearest" });
  }, [selectedKey]);

  const response = outcome.response;

  let body: React.JSX.Element;
  if (outcome.error !== null) {
    body = (
      <div
        className="api-error"
        role="alert"
        data-testid={`compare-error-${side}`}
      >
        {outcome.error}
      </div>
    );
  } else if (response !== null) {
    const parsed = parseJsonBody(response);
    // `ResponseBody` for EVERY body kind, so search, copy and the Raw/Formatted switch match the
    // ordinary panel in each pane.
    body = (
      <ResponseBody
        text={formatBody(response)}
        testId={`compare-raw-${side}`}
        copyLabel={`response ${side.toUpperCase()}`}
        // requestId + side: stable across re-renders and tab moves, distinct per pane.
        findKey={`compare:${requestId}:${side}`}
        formatted={
          parsed.isJson
            ? {
                value: sortKeys ? sortJsonKeys(parsed.value) : parsed.value,
                selectedKey,
                onSelectKey,
              }
            : null
        }
      />
    );
  } else {
    body = (
      <div
        className="compare-pane__empty"
        data-testid={`compare-empty-${side}`}
      >
        {sending ? "Sending…" : "No response yet"}
      </div>
    );
  }

  return (
    <div className="compare-pane" data-testid={`compare-pane-${side}`}>
      <div className="compare-pane__head">
        <span className="compare-pane__side">{side === "a" ? "A" : "B"}</span>
        <span className="compare-pane__method">{method}</span>
        <span className="compare-pane__url" title={url}>
          {url}
        </span>
        {response !== null && (
          <>
            <span
              className={`api-status ${statusClass(response.status)}`}
              data-testid={`compare-status-${side}`}
            >
              {response.status}
            </span>
            <span className="compare-pane__statustext">
              {response.statusText}
            </span>
            <span className="compare-pane__stat">{response.durationMs} ms</span>
            <span className="compare-pane__stat">
              {humanizeSize(response.sizeBytes)}
            </span>
            {response.truncated && (
              <span
                className="compare-pane__truncated"
                data-testid={`compare-truncated-${side}`}
              >
                truncated
              </span>
            )}
          </>
        )}
      </div>
      <div
        className="compare-pane__body"
        data-testid={`compare-body-${side}`}
        ref={bodyRef}
      >
        {body}
      </div>
    </div>
  );
}
