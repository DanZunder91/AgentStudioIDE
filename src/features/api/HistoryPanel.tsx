/** Clicking an entry opens it in a new tab but never sends it. Entries store the LITERAL request
 * ({{VAR}} kept), so search matches templates, never secrets. Shaping is pure in ./historyGroup;
 * hydrates once on mount (the VaultPanel guard). */

import { useEffect, useState } from "react";

import { useAppStore } from "../../app/store";
import { partitionHistory, searchHistory, timeLabel } from "./historyGroup";
import type { HistoryEntry } from "./historyIpc";
import { loadApiHistory } from "./historyIpc";
import "./api.css";
import "./history.css";

/** How many of the newest entries stay flat before day-grouping starts (required: 10). */
export const RECENT_COUNT = 10;

/** The panel is long-lived: without a tick, yesterday's group stays "Today" past midnight.
 * Exported so the test advances by the real cadence. */
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
  /** One "now" for every label, ticked in state: Date.now() in render is impure. */
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
