/**
 * ResponseBody — the response body, in either view, with the tools that act on
 * it: the Raw/Formatted switch, Cmd/Ctrl+F search, and Copy.
 *
 * Three requirements:
 *   • a Command+F search inside a request's response body, in both the A/B
 *     compare and the ordinary view;
 *   • a copy button for the response;
 *   • copy and search in the tree view as well as in Raw, and the tree view
 *     named Formatted rather than Tree.
 *
 * One component for BOTH surfaces — the ordinary request panel and each side of
 * the A/B compare — because a search that behaved differently in the two places
 * would be its own bug.
 *
 * ## Why this component owns the VIEW, not just the raw text
 *
 * The third requirement is a structural one. Find and Copy used to live here while the
 * JSON tree was rendered by the callers, so both controls vanished the moment
 * a response was JSON — which is most of the time. The fix that *seems*
 * smallest is to give the callers their own copy of the tools row; that is the
 * one shape to avoid, because a Copy button in a different place per view (or
 * copying a different string per view) is worse than a missing one: the user
 * stops trusting where it is and what it does.
 *
 * So `ResponseBody` swallowed the switch. `formatted` is the JSON half — pass
 * it and this component renders the tree, the toggle, and the same single tools
 * row above BOTH views. Consequences that are the whole point:
 *   - the tools row is literally the same DOM node in both views, so it cannot
 *     move;
 *   - Copy always writes `text` — the raw view's string — no matter which view
 *     is on screen, because it is one call site, not two.
 *
 * ## Why `<mark>` is safe here, unlike the markdown preview
 *
 * Both views are React-rendered text: the highlighted output is React children
 * split into three parts by `markMatches`, exactly the idiom `FindInFiles`/
 * `ReferencesPanel` already use. It never goes near `innerHTML`, so the
 * erased-by-re-render hazard — the reason the markdown preview needs
 * Ranges instead — simply does not apply.
 *
 * ## The two totals, and why the bar shows both when they differ
 *
 * Match semantics come from `findModel` in BOTH views, so neither can invent a
 * match. But they search different TEXT: Raw searches the pretty-printed JSON
 * (punctuation, indentation, the quotes around key names and all), while
 * Formatted searches only what the tree draws — each key name and each
 * primitive value (see `searchJsonTree`). For a query made of content the two
 * totals therefore agree by construction; a query touching JSON structure
 * (`":`, a comma, a brace) can only exist in Raw.
 *
 * They cannot be reconciled into one number without lying about one of the two
 * screens, so the bar refuses to pick: whenever the totals differ it renders
 * the other view's total next to its own, labelled `Raw:`/`Formatted:`. Two
 * numbers that disagree *out loud* are a fact about the response; one number
 * that changes when you flip the view teaches the user the search is broken.
 *
 * ## Why the bar's state lives in the STORE, not in this component
 *
 * `Pane` renders only the ACTIVE tab, and a cross-pane drag re-parents the
 * subtree — so this component unmounts on every tab switch/move, and any
 * `useState` here dies with it. That was the bug (the find bar still
 * disappeared when moving between tabs): the bar, the query and the
 * Raw/Formatted choice were gone when the tab came back. So `open`/`query`/
 * `cursor`/`view` live in `findBars[findKey]` (store), keyed by the caller's
 * stable tab identity; ABSENCE of the key is the closed/empty/default state.
 * `copied` deliberately stays component state — "Copied" is a transient claim
 * about the clipboard, not part of the tab.
 *
 * ## Cmd/Ctrl+F seeds from the selection
 *
 * Pressing Command+F with something selected should search
 * for that selection. The rule is `editor/find/selectionSeed` — shared with the
 * editor's own bar, the terminal, the preview and the DB grid — and the seed is
 * written through the same `patchFindBar({ query, cursor: 0 })` the input's
 * onChange uses, so a seeded search and a typed one cannot diverge. The read is
 * scoped to THIS body's box, which is what keeps A/B compare honest: two of
 * these render side by side, and a selection in one must never seed the other.
 */

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
  /**
   * The `findBars` key this body's find bar + view survive under across tab
   * switches/moves (which unmount this component). Callers pass the tab's
   * stable identity — `api:<requestId>`, `compare:<requestId>:<side>` — so two
   * tabs can never share a bar by accident.
   */
  findKey: string;
  /** JSON tree half; `null` for a non-JSON body (then there is no toggle). */
  formatted?: FormattedBody | null;
}): React.JSX.Element {
  /**
   * The surviving bar state; `undefined` IS the closed/empty/default state
   * (`dropFindBar` deletes the key rather than zeroing it), so every read
   * defaults here — and the defaults MUST match what the old `useState`s held.
   */
  const bar = useAppStore((s) => s.findBars[findKey]);
  const patchFindBar = useAppStore((s) => s.uiActions.patchFindBar);
  const dropFindBar = useAppStore((s) => s.uiActions.dropFindBar);

  /**
   * Esc / ✕. The find STATE is forgotten entirely — absence is the closed
   * state, so closing can never leave a per-tab tombstone — but a chosen Raw
   * view survives, because the view toggle is a reading preference, not part
   * of the find gesture: a user switching to Raw and then dismissing the
   * search must not have the body snap back to Formatted under them. Only a
   * bar whose record holds nothing BUT the defaults is dropped outright.
   */
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
  /**
   * The text the Copied badge belongs to. Adjusted DURING RENDER rather than in
   * an effect — React's documented way to derive state from changing props:
   * "Copied" is a claim about THIS text, so a new response retires it (keyed on
   * the text rather than a timer — "copied" stops being true when the thing
   * copied changes, not when a second and a bit has passed).
   */
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

  /**
   * A NEW RESPONSE landing while this body is ON SCREEN invalidates the cursor
   * — "2 of 2" would be a claim about the old text. This used to be an
   * adjust-during-render `setState`; the cursor now lives in the shared store,
   * and a store write during render re-renders every subscriber mid-pass, so
   * the reset is an effect (the clamp below keeps even the pre-effect frame
   * inside the new match list). The ref starts as the MOUNT text on purpose:
   * a response that changed while the tab was AWAY must NOT reset the restored
   * cursor — surviving the tab switch is the whole point — the clamp bounds it
   * against the match list that exists now instead.
   */
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

  /**
   * The cursor, clamped into the CURRENT view's totals. Flipping the view keeps
   * the same ordinal where it exists (the two views count in the same document
   * order, so match 3 is the same match) and falls back to the last one where
   * it does not — never a "4/2". The same clamp is what makes a RESTORED cursor
   * safe: the response can change while the tab is away, so the stored ordinal
   * is clamped against the match list that exists NOW, never trusted as-is.
   */
  const cursor = bar?.cursor ?? 0;
  const current = total === 0 ? 0 : Math.min(cursor, total - 1);

  // Keep the current match on screen. Found by query rather than by threading a
  // ref through the render function — a ref may not be read during render, and
  // the marks are rebuilt on every keystroke anyway. `scrollIntoView` is
  // optional-called because jsdom does not implement it (as MarkdownPreview does).
  useEffect(() => {
    const hit = boxRef.current?.querySelector('[data-testid="response-find-current"]');
    (hit as HTMLElement | null | undefined)?.scrollIntoView?.({ block: "nearest" });
    // 🔴 `stepNonce` is in the deps for the SINGLE-MATCH case (the bug: with
    // only one match, Next did not scroll to that match).
    // With `total === 1`, `step` computes `(0 + 1) % 1 === 0` — the
    // cursor cannot change, so `current`/`total` are identical across the
    // render and this effect would never re-run. Pressing Next was a silent
    // no-op on exactly the case where the user most expects a jump. The nonce
    // changes on every step request, so "take me there" always means it.
  }, [current, total, showFormatted, stepNonce]);

  const step = (delta: number): void => {
    if (total === 0) return;
    setStepNonce((n) => n + 1);
    patchFindBar(findKey, { cursor: (((current + delta) % total) + total) % total });
  };

  /**
   * Focus the query input once the bar exists, with its text SELECTED so the
   * next keystroke replaces it — the behaviour every find bar in this app, and
   * VS Code, Chrome and Firefox, share. Deferred a tick because a ref set in the
   * same tick as the state change is still null.
   */
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
      // Selected response text seeds the bar. Read HERE,
      // synchronously — `focusFindInput` below collapses the selection, and it
      // has to run late because the input does not exist yet. The patch is the
      // one the input's onChange makes, so seeding and typing are one path.
      // Scoped to THIS body's box, which is what keeps the A/B compare panes
      // honest: a selection in the other side never seeds this one.
      const seed = domSelectionSeed(boxRef.current as HTMLDivElement);
      // An UNCHANGED query is left alone entirely — the editor's bar skips
      // its own dispatch that way (`!desired.eq(getSearchQuery(…))`),
      // and re-seeding the same text is a refocus, not a new search. A CHANGED
      // one carries `cursor: 0` because that is what typing does: a new query
      // means new matches, and the old ordinal addressed the old ones.
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
