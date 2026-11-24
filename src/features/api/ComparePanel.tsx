/**
 * ComparePanel — the A/B compare surface for the HTTP lane. Two exports, both
 * rendered by ApiRequestView while
 * `compare.enabled`:
 *
 * - `CompareBar` — request B's method + URL pickers, drawn under the A bar.
 *   B travels with A's headers and body (the `CompareState` docblock's rule:
 *   the comparison varies only what this bar shows), so the bar SAYS so in a
 *   muted hint instead of pretending B is a full second request. Send routing
 *   lives in ApiRequestView — this bar only calls the `onSend` it was given
 *   (Cmd/Ctrl+Enter, matching the A bar's shortcut).
 *
 * - `ComparePanel` — the side-by-side response surface that REPLACES
 *   ResponsePanel while compare is on. Each pane echoes its side's method+url
 *   (A = the request's own, B = `compare.*`) so the reader never has to
 *   remember which wire is which, then renders that side's outcome: a calm
 *   error block, a muted placeholder, or — for any body at all — a
 *   `ResponseBody`, which owns BOTH the Formatted (JSON tree) and Raw views
 *   plus the one tools row above them (Raw/Formatted, Find, Copy). All
 *   compare state (both outcomes, the selected key, the sort toggle) lives in
 *   the store, so it survives a tab switch — `Pane` unmounts inactive tabs.
 *
 * Cross-highlight: clicking a key NAME in EITHER tree writes it to
 * `compare.selectedKey`; both panes hand the same value to `JsonView`, which
 * marks every occurrence (`data-selected="true"`) — the shared store field IS
 * the sync, there is no cross-pane messaging. Clicking the same key (or the
 * toolbar chip) clears it. On a new selection each pane scrolls its first
 * occurrence into view; the call is optional-chained because jsdom has no
 * `scrollIntoView`.
 *
 * Sort: `Sort keys` runs both parsed bodies through `sortJsonKeys` at render
 * time (recursive, arrays keep order, never mutates), so the two trees align
 * structurally. The raw response strings are untouched — toggling off restores
 * the wire order exactly.
 *
 * Response HEADERS are deliberately NOT rendered here: the single-mode panel
 * already has them behind its toggle, and the panes stay focused on comparing
 * bodies — half a pane's width is too narrow to carry a header list that is
 * noise most of the time.
 *
 * Display helpers (`statusClass` / `formatBody` / `parseJsonBody` /
 * `humanizeSize`) are the SAME functions ResponsePanel uses (responseFormat.ts)
 * so the two surfaces cannot drift on what "is JSON" or how a status buckets.
 */

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

/**
 * Request B's bar: method picker + URL input, rendered by ApiRequestView under
 * the A bar. Same `api-bar` chrome as the A bar; `compare-bar` is the seam for
 * compare-only tweaks. Null for an unknown requestId (same defensive style as
 * ApiRequestView — unreachable through the UI, keeps the view total).
 */
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

/**
 * The side-by-side A/B response surface. Null for an unknown requestId (same
 * defensive style as ApiRequestView).
 */
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

/**
 * One side of the split: a head (side label, method+url echo, and — once that
 * side has landed — the status pill + stats) over THE scroll box for that
 * side's body. Split out so each body state is one `if` rather than a nest of
 * ternaries (the ResponsePanel precedent), and so each pane owns its own
 * scroll-into-view effect.
 */
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

  // On a new selection, bring this pane's FIRST occurrence into view — a long
  // response may hold the pairable row hundreds of keys down. The ref is
  // non-null by effect time (the body div renders unconditionally; React
  // attaches refs before effects). `el` CAN be null — an error pane, or a tree
  // without that key — and jsdom has no `scrollIntoView`, hence both `?.`s.
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
    // Same component as the ordinary response panel, for EVERY body kind: search
    // must work in both the A/B compare and the ordinary view, search+copy in the
    // tree view too, and a pane whose tools appeared
    // only for non-JSON — or moved when you flipped the view — would be its own
    // bug. `ResponseBody` owns the Raw/Formatted switch, so each pane gets one.
    body = (
      <ResponseBody
        text={formatBody(response)}
        testId={`compare-raw-${side}`}
        copyLabel={`response ${side.toUpperCase()}`}
        // requestId + side is the pane's stable identity: the panes are fixed
        // positions of ONE compare surface (A = the request's own wire, B =
        // `compare.*`), so `side` survives every re-render and tab move while
        // still keeping the two bars apart.
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
