/**
 * HistoryPanel — the right rail's API request History (M6 follow-on).
 *
 * A persisted, append-only log of every HTTP request the API client executed, newest
 * first. Clicking an entry OPENS it: a fresh request tab is opened, populated with the
 * entry's method/url/headers/body — but NOT sent (clicking history should SHOW the
 * request, not fire it again). The user reviews/edits and hits Send. No
 * limit, no cache (every execution is kept). Clearing the log asks for confirmation
 * first.
 *
 * **Navigable log:** the history of executed requests looked short. Entries after
 * the first 10 are grouped into expandable days, and a search finds them; search
 * results are not grouped by day, only sorted by day. Nothing was capped — the log
 * always kept everything (`recordApiHistory`, `history_store.rs`); what was missing
 * was structure. So:
 *
 * - **Default view** — the newest {@link RECENT_COUNT} entries stay flat and look
 *   exactly as they always did, and everything older collapses into per-day
 *   disclosures, all closed until the user opens one.
 * - **Search view** — one flat list of every match, newest first, with a count and
 *   no day headers at all. Hunting for a request should not require opening a
 *   disclosure first.
 *
 * All of the shaping is pure and lives in `./historyGroup`, with the clock injected;
 * this file only holds the two pieces of UI state (the query, the open day keys).
 *
 * Secret-safety: the log stores the LITERAL request (`{{VAR}}` kept), so
 * opening a request restores the placeholders — the panel never sees a resolved
 * secret. Search therefore matches templates, never resolved values.
 *
 * Hydrates the history log once on mount if not already loaded — the same one-shot
 * guard `<VaultPanel/>`/`<ApiRequestView/>` use for the durable store. The `cancelled`
 * guard drops a late resolve after unmount; the store flag (not a module latch)
 * re-arms the load between tests via `resetStore`.
 */

import { useEffect, useState } from "react";

import { useAppStore } from "../../app/store";
import { partitionHistory, searchHistory, timeLabel } from "./historyGroup";
import type { HistoryEntry } from "./historyIpc";
import { loadApiHistory } from "./historyIpc";
import "./api.css";
import "./history.css";

/** How many of the newest entries stay flat before day-grouping starts (required: 10). */
export const RECENT_COUNT = 10;

/**
 * How often the panel's "now" is refreshed. Only two things depend on it — the
 * `Today`/`Yesterday` day labels and a row's year suffix — and both change at
 * most once a day, so a minute is already far finer than needed. It exists at all
 * because the panel is long-lived: left open across midnight without it, yesterday's
 * group would keep calling itself "Today". Exported so the test advances by the
 * real cadence rather than a copy of it.
 */
export const CLOCK_TICK_MS = 60_000;

export function HistoryPanel(): React.JSX.Element {
  const history = useAppStore((s) => s.apiHistory);
  const hydrateApiHistory = useAppStore((s) => s.apiActions.hydrateApiHistory);
  const clearApiHistory = useAppStore((s) => s.apiActions.clearApiHistory);
  const createApiRequest = useAppStore((s) => s.apiActions.createApiRequest);
  const loadHistoryIntoRequest = useAppStore(
    (s) => s.apiActions.loadHistoryIntoRequest,
  );
  const openApiRequestTab = useAppStore((s) => s.layoutActions.openApiRequestTab);

  // Clearing is destructive + irreversible (the log is the only copy), so it takes a
  // second confirming click rather than a blocking browser dialog.
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [query, setQuery] = useState("");
  // Which day disclosures are open, by `dayKey`. Everything starts collapsed — the
  // point of the grouping is that an old day is out of the way until asked for.
  const [openDays, setOpenDays] = useState<ReadonlySet<string>>(new Set());
  /**
   * "Now", one value shared by every label so no two rows can disagree. Held in
   * state and ticked rather than read during render: `Date.now()` in a render body
   * is an impure read (`react-hooks/purity`, and the same call the metrics/usage
   * panels moved out for), and the labels would otherwise only move when some
   * unrelated state changed.
   */
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (useAppStore.getState().apiHistoryLoaded) return;
    let cancelled = false;
    void loadApiHistory().then((store) => {
      if (!cancelled) hydrateApiHistory(store);
    });
    return () => {
      cancelled = true;
    };
  }, [hydrateApiHistory]);

  // Open (do NOT send): mint a request, populate it from the entry, open its tab so
  // the user can review / edit / re-send it. Clicking history should show the
  // request, not fire it again.
  const openRequest = (entryId: string) => {
    const requestId = createApiRequest();
    loadHistoryIntoRequest(entryId, requestId);
    openApiRequestTab(requestId);
  };

  const toggleDay = (key: string) => {
    setOpenDays((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  };

  // The log is stored oldest-first (append order); reversing first means a
  // same-millisecond tie also resolves newest-first under the stable sorts in
  // `historyGroup`.
  const ordered = [...history].reverse();
  const searching = query.trim() !== "";
  const matches = searching ? searchHistory(ordered, query) : [];
  const { recent, groups } = searching
    ? { recent: [], groups: [] }
    : partitionHistory(ordered, RECENT_COUNT, now);

  const row = (e: HistoryEntry) => {
    const ok = e.error === null;
    return (
      <li key={e.id} className="history-item">
        <button
          type="button"
          className="history-item__run"
          data-testid="history-run"
          title="Open this request"
          onClick={() => openRequest(e.id)}
        >
          <span className="history-item__top">
            <span className={`history-method history-method--${e.method}`}>
              {e.method}
            </span>
            <span className={`history-status${ok ? "" : " history-status--err"}`}>
              {ok ? e.status : "error"}
            </span>
            <span className="history-item__time">{timeLabel(e.at, now)}</span>
          </span>
          <span className="history-item__url" title={e.url}>
            {e.url}
          </span>
          {!ok && e.error !== null && (
            <span className="history-item__err">{e.error}</span>
          )}
        </button>
      </li>
    );
  };

  return (
    <div className="history-panel" data-testid="history-panel">
      <div className="history-panel__head">
        <p className="history-panel__note">
          Every request you send is logged here (stored in the app data dir, never the
          repo). Click one to open it — same method, URL, headers, and body — then Send.
        </p>

        {/* Rendered even for an empty log: it is the panel's widest control, and the
            rail-width E2E measures the panel at its 180px minimum. Hiding it when
            empty would hide it from the only test that watches for overflow. */}
        <div className="history-search">
          <input
            type="text"
            className="history-search__input"
            data-testid="history-search"
            placeholder="Search requests…"
            aria-label="Search request history"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query !== "" && (
            <button
              type="button"
              className="api-add-header history-search__clear"
              data-testid="history-search-clear"
              aria-label="Clear search"
              onClick={() => setQuery("")}
            >
              Clear
            </button>
          )}
        </div>

        {/* The confirm always speaks for the WHOLE log, never the filtered view —
            "Clear all" is not scoped by the search box. */}
        {history.length > 0 &&
          (confirmingClear ? (
            <div className="history-clear-confirm" data-testid="history-clear-confirm">
              <span className="history-clear-confirm__q">
                Clear all {history.length} request{history.length === 1 ? "" : "s"}?
                This can&rsquo;t be undone.
              </span>
              <div className="history-clear-confirm__actions">
                <button
                  type="button"
                  className="api-add-header history-clear-confirm__yes"
                  data-testid="history-clear-confirm-yes"
                  onClick={() => {
                    clearApiHistory();
                    setConfirmingClear(false);
                  }}
                >
                  Clear all
                </button>
                <button
                  type="button"
                  className="api-add-header"
                  data-testid="history-clear-cancel"
                  onClick={() => setConfirmingClear(false)}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="api-add-header"
              data-testid="history-clear"
              onClick={() => setConfirmingClear(true)}
            >
              Clear history
            </button>
          ))}
      </div>

      {history.length === 0 ? (
        <p className="history-panel__empty" data-testid="history-empty">
          No requests yet. Send one from an API request tab and it will appear here.
        </p>
      ) : searching ? (
        <>
          <p className="history-panel__count" data-testid="history-search-count">
            {matches.length === 0
              ? "No matches"
              : `${matches.length} match${matches.length === 1 ? "" : "es"}`}
          </p>
          <ul className="history-list">{matches.map(row)}</ul>
        </>
      ) : (
        <>
          <ul className="history-list">{recent.map(row)}</ul>
          {groups.length > 0 && (
            <div className="history-days">
              {groups.map((g) => {
                const open = openDays.has(g.key);
                return (
                  <div className="history-day" key={g.key}>
                    <button
                      type="button"
                      className="history-day__head"
                      data-testid="history-day"
                      aria-expanded={open}
                      onClick={() => toggleDay(g.key)}
                    >
                      <span className="history-day__caret" aria-hidden="true">
                        {open ? "▾" : "▸"}
                      </span>
                      <span className="history-day__label">{g.label}</span>
                      <span className="history-day__count">
                        {" · "}
                        {g.entries.length}
                      </span>
                    </button>
                    {open && (
                      <ul
                        className="history-list history-day__list"
                        data-testid="history-day-body"
                      >
                        {g.entries.map(row)}
                      </ul>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
