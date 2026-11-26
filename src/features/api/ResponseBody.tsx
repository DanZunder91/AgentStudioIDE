/** Owns the Raw/Formatted switch so one tools row serves both views; Copy always writes raw text.
 * Find state lives in the store (findBars[findKey]) because Pane unmounts inactive tabs. The views
 * search different text, so the bar shows both totals when they differ. Marks are React nodes. */

import { useEffect, useMemo, useRef, useState } from "react";

import { useAppStore } from "../../app/store";
import { formatCount, listMatches } from "../editor/find/findModel";
import { domSelectionSeed } from "../editor/find/selectionSeed";
import { modKey } from "../shortcuts/shortcuts";
import { JsonView, searchJsonTree } from "./JsonView";
import { markMatches } from "./matchMarks";
import "./responseBody.css";

/** The JSON half of a response, when the body parsed as JSON. */
export interface FormattedBody {
  /** The already-parsed value — key-sorted already, in the compare panel. */
  value: unknown;
  /** A/B compare cross-highlight; forwarded to `JsonView` untouched. */
  selectedKey?: string | null;
  onSelectKey?: (key: string) => void;
}

export function ResponseBody({
  text,
  testId,
  copyLabel,
  findKey,
  formatted = null,
}: {
  /** The response text exactly as the Raw view shows it, and what Copy copies. */
  text: string;
  /** `data-testid` for the body element, so existing tests keep their handle. */
  testId: string;
  /** Distinguishes the two compare sides for assistive tech. */
  copyLabel: string;
  /** The caller's stable tab id (api:<requestId>, compare:<requestId>:<side>), the findBars key. */
  findKey: string;
  /** JSON tree half; `null` for a non-JSON body (then there is no toggle). */
  formatted?: FormattedBody | null;
}): React.JSX.Element {
  /** undefined is the closed/default state (dropFindBar deletes the key); reads default. */
  const bar = useAppStore((s) => s.findBars[findKey]);
  const patchFindBar = useAppStore((s) => s.uiActions.patchFindBar);
  const dropFindBar = useAppStore((s) => s.uiActions.dropFindBar);

  /** Forgets the find state, but a chosen Raw view survives: the view is a reading preference,
   * not part of the find. A record holding only defaults is dropped outright. */
  const closeFind = (): void => {
    if (bar?.view === "raw") patchFindBar(findKey, { open: false, query: "", cursor: 0 });
    else dropFindBar(findKey);
  };
  const open = bar?.open ?? false;
  const query = bar?.query ?? "";
  /** Formatted is the default for a JSON body; `view: "raw"` flips to the text. */
  const rawView = bar?.view === "raw";
  /** Transient by design: a claim about the CLIPBOARD, not part of the tab. */
  const [copied, setCopied] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  /** Bumped by every Next/Previous, so a step is honoured even when it cannot
   *  move the cursor (a single match). Local: a scroll request is a transient
   *  gesture, not state a tab move should carry. */
  const [stepNonce, setStepNonce] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  /** Derived during render: a new response retires "Copied", a claim about this exact text. */
  const [copiedText, setCopiedText] = useState(text);
  if (copiedText !== text) {
    setCopiedText(text);
    setCopied(false);
  }

  const spec = { search: query, caseSensitive: false, wholeWord: false, regexp: false };
  const rawMatches = useMemo(
    () => (query === "" ? [] : listMatches(spec, text)),
    // `spec` is rebuilt every render; its contents are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [query, text],
  );
  // No "bad pattern" state: this bar is literal-only (`regexp: false`), so a
  // query can never fail to compile. A branch for it would be unreachable.

  const hasTree = formatted !== null;
  const treeValue = formatted?.value;
  const treeSearch = useMemo(
    () => (query === "" || !hasTree ? null : searchJsonTree(treeValue, query)),
    [query, hasTree, treeValue],
  );

  /** The formatted half when it is what is on screen — `null` narrows the JSX. */
  const tree = rawView ? null : formatted;
  const showFormatted = tree !== null;

  /** The total for the view being LOOKED at, and the one for the other view. */
  const total = showFormatted ? (treeSearch?.total ?? 0) : rawMatches.length;
  const otherTotal = showFormatted ? rawMatches.length : (treeSearch?.total ?? 0);

  /** A new response while on screen resets the cursor; an effect, as a store write during render
   * re-renders subscribers mid-pass. The ref starts at the mount text so a restored cursor survives
   * a tab switch; the clamp below bounds it. */
  const cursorTextRef = useRef(text);
  useEffect(() => {
    if (cursorTextRef.current === text) return;
    cursorTextRef.current = text;
    // Only a bar that exists needs its cursor retired: patching an absent one
    // would recreate exactly the tombstone `dropFindBar` deletes to avoid.
    if (useAppStore.getState().findBars[findKey] !== undefined) {
      patchFindBar(findKey, { cursor: 0 });
    }
  }, [text, findKey, patchFindBar]);

  /** Clamped to the current view's total: both views count in the same order, and a restored
   * cursor may outlive the response it pointed into. */
  const cursor = bar?.cursor ?? 0;
  const current = total === 0 ? 0 : Math.min(cursor, total - 1);

  // Found by query because a ref can't be read during render.
  // scrollIntoView is optional-called: jsdom does not implement it.
  useEffect(() => {
    const hit = boxRef.current?.querySelector('[data-testid="response-find-current"]');
    (hit as HTMLElement | null | undefined)?.scrollIntoView?.({ block: "nearest" });
    // stepNonce: with one match the cursor can't change, so Next would never re-run this effect.
  }, [current, total, showFormatted, stepNonce]);

  const step = (delta: number): void => {
    if (total === 0) return;
    setStepNonce((n) => n + 1);
    patchFindBar(findKey, { cursor: (((current + delta) % total) + total) % total });
  };

  /** Selects the text so the next keystroke replaces it; deferred, as the ref is still null. */
  const focusFindInput = (): void => {
    window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
  };

  /** Cmd/Ctrl+F opens the bar; Escape closes it. Scoped to this body. */
  const onKeyDown = (e: React.KeyboardEvent): void => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && !e.shiftKey && e.key.toLowerCase() === "f") {
      // preventDefault so the key never escapes to WebKit's own find, which
      // would search the whole window instead of this response.
      e.preventDefault();
      // Read now: focusFindInput collapses the selection. Scoped to this box so one A/B pane never
      // seeds the other; the patch matches the input's onChange, so seeding and typing agree.
      const seed = domSelectionSeed(boxRef.current as HTMLDivElement);
      // An unchanged query is left alone (a refocus, as in the editor's bar); a changed one resets
      // the cursor, as typing does.
      patchFindBar(
        findKey,
        seed === null || seed === query ? { open: true } : { open: true, query: seed, cursor: 0 },
      );
      focusFindInput();
      return;
    }
    if (e.key === "Escape" && open) {
      e.preventDefault();
      closeFind();
    }
  };

  const copy = (): void => {
    if (!navigator.clipboard) return;
    void navigator.clipboard
      // Always `text` — the raw string — whichever view is showing. A Copy that
      // copied a different string per view would be a trap.
      .writeText(text)
      .then(() => setCopied(true))
      // A refused clipboard (no permission, a locked-down profile) is not worth
      // shouting about — but the button must not claim success either, so this
      // clears rather than swallowing into a bare noop.
      .catch(() => setCopied(false));
  };

  return (
    <div className="response-body" ref={boxRef} onKeyDown={onKeyDown} tabIndex={-1}>
      <div className="response-body__tools">
        {hasTree && (
          <button
            type="button"
            className="api-add-header"
            data-testid="response-view-toggle"
            // The label is the view you switch TO, so it reads "Formatted"
            // while you are looking at the raw text.
            aria-label={`Show ${copyLabel} ${rawView ? "formatted" : "raw"}`}
            title="Switch between the raw text and the JSON tree"
            onClick={() => patchFindBar(findKey, { view: rawView ? "formatted" : "raw" })}
          >
            {rawView ? "Formatted" : "Raw"}
          </button>
        )}
        <button
          type="button"
          className="api-add-header"
          data-testid="response-find-toggle"
          aria-label={`Search ${copyLabel}`}
          title={`Search this response (${modKey()}+F)`}
          onClick={() => {
            // The toggle CLOSES softly (keeps query + view, unlike Esc/✕ which
            // drop the record) — exactly the old `setOpen(v => !v)` semantics.
            patchFindBar(findKey, { open: !open });
            focusFindInput();
          }}
        >
          Find
        </button>
        <button
          type="button"
          className="api-add-header"
          data-testid="response-copy"
          aria-label={`Copy ${copyLabel}`}
          onClick={copy}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>

      {open && (
        <div className="response-body__find" data-testid="response-find">
          <input
            ref={inputRef}
            className="api-input response-body__find-input"
            data-testid="response-find-input"
            aria-label="Search the response"
            placeholder="Find in response…"
            value={query}
            // A new query invalidates the cursor; written in ONE patch so no
            // render can ever see the pair disagree (the old belongs-to reset).
            onChange={(e) => patchFindBar(findKey, { query: e.target.value, cursor: 0 })}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                step(e.shiftKey ? -1 : 1);
              }
            }}
          />
          <span className="response-body__count" data-testid="response-find-count">
            {formatCount(total === 0 ? null : current + 1, total)}
          </span>
          {hasTree && query !== "" && otherTotal !== total && (
            <span
              className="response-body__count response-body__count--other"
              data-testid="response-find-other-count"
              title="Formatted searches key names and values; Raw also searches the JSON punctuation, quotes and indentation — so the two totals can differ."
            >
              {showFormatted ? `Raw: ${otherTotal}` : `Formatted: ${otherTotal}`}
            </span>
          )}
          <button
            type="button"
            className="api-add-header"
            data-testid="response-find-prev"
            aria-label="Previous match"
            disabled={total === 0}
            onClick={() => step(-1)}
          >
            ↑
          </button>
          <button
            type="button"
            className="api-add-header"
            data-testid="response-find-next"
            aria-label="Next match"
            disabled={total === 0}
            onClick={() => step(1)}
          >
            ↓
          </button>
          <button
            type="button"
            className="api-add-header"
            data-testid="response-find-close"
            aria-label="Close search"
            // Same semantics as Esc — see `closeFind`.
            onClick={closeFind}
          >
            ✕
          </button>
        </div>
      )}

      {tree !== null ? (
        <div
          className="api-response__body response-body__formatted"
          data-testid={testId}
        >
          <JsonView
            value={tree.value}
            selectedKey={tree.selectedKey}
            onSelectKey={tree.onSelectKey}
            search={treeSearch}
            currentMatch={current}
          />
        </div>
      ) : (
        <pre className="api-response__body" data-testid={testId}>
          {markMatches(text, rawMatches, current)}
        </pre>
      )}
    </div>
  );
}
