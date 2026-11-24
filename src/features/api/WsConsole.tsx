/**
 * WsConsole — the API client's live WebSocket console.
 *
 * Rendered by `ApiRequestView` when a request's `protocol` is `"ws"`. Connect to
 * a `ws://`/`wss://` URL, watch a streaming log of sent + received frames, send
 * messages, and disconnect. The whole connection lives in the store's `ws` slice
 * (not component state): the `onEvent` callback appends to the store, so the log
 * and status SURVIVE A TAB SWITCH — this view can unmount and re-mount over a live
 * socket and just read the accumulated state back.
 *
 * ── connectionId / open-event ordering ───────────────────────────────────────
 * Two signals establish a connection and they can land in EITHER order: the
 * `ws_connect` promise resolves with the `connectionId` (→ `wsConnected`), while
 * the socket's `open` event flips the status (→ `wsOpened`). Neither depends on
 * the other; send is gated on BOTH having landed (`status === "open"` AND a
 * non-null id), so a brief window where one precedes the other is simply
 * not-yet-ready rather than a crash.
 *
 * ── handshake headers ────────────────────────────────────────────────────────
 * A WebSocket handshake IS an HTTP request, so a server that authenticates the
 * upgrade needs headers on it — without them an authenticated `ws://…` endpoint
 * could only ever answer `HTTP error: 401 Unauthorized`. The rows are the SAME
 * `req.headers` model the HTTP surface and the gRPC console use (metadata IS
 * headers), through the same `addHeader`/`updateHeader`/`removeHeader` actions,
 * so a saved request keeps them for free.
 *
 * 🔴 The rows are sent as the LITERAL text typed, `{{VAR}}` and all —
 * `substituteVars` is deliberately NOT called here. The Vault lookup happens in
 * Rust; resolving first would put the real token on the IPC boundary.
 *
 * They apply ONLY to the opening handshake, so they are LOCKED (disabled, with a
 * note saying why) while a connection is in flight or open — exactly what the url
 * field beside them already does, and for the same reason: a row you can edit
 * mid-session that silently changes nothing is a bug waiting to be filed.
 *
 * ── v1 limitation ────────────────────────────────────────────────────────────
 * Disconnect is EXPLICIT. Unmounting the view (switching tabs, closing the panel)
 * does NOT close the socket — that is what lets the connection survive a tab
 * switch. A socket is only torn down when the user clicks Disconnect.
 */

import { useEffect, useRef } from "react";

import { useAppStore } from "../../app/store";
import { wsClose, wsConnect, wsSend, type WsEvent, type WsHeader } from "./wsIpc";
import "./api.css";

/** The status pill's human label, keyed by connection status. */
const STATUS_LABEL: Record<string, string> = {
  idle: "Idle",
  connecting: "Connecting",
  open: "Connected",
  closed: "Closed",
  error: "Error",
};

/** The log-row direction glyph: ↑ sent, ↓ received, • lifecycle note. */
const DIR_GLYPH: Record<string, string> = { out: "↑", in: "↓", sys: "•" };

/** A short clock time for a log entry (the console shows time-of-day, not date). */
function formatTime(at: number): string {
  return new Date(at).toLocaleTimeString();
}

/** "Disconnected (1000): bye" — the sys note for a `closed` event. */
function closedNote(e: Extract<WsEvent, { kind: "closed" }>): string {
  return `Disconnected${e.code !== null ? ` (${e.code})` : ""}${e.reason !== "" ? `: ${e.reason}` : ""}`;
}

export function WsConsole({
  requestId,
}: {
  requestId: string;
}): React.JSX.Element | null {
  const req = useAppStore((s) => s.apiRequests[requestId]);
  const apiEnvironments = useAppStore((s) => s.apiEnvironments);
  const activeEnvironmentId = useAppStore((s) => s.activeEnvironmentId);
  const patchApiRequest = useAppStore((s) => s.apiActions.patchApiRequest);
  const addHeader = useAppStore((s) => s.apiActions.addHeader);
  const updateHeader = useAppStore((s) => s.apiActions.updateHeader);
  const removeHeader = useAppStore((s) => s.apiActions.removeHeader);
  const setActiveEnvironment = useAppStore(
    (s) => s.apiActions.setActiveEnvironment,
  );
  const wsConnecting = useAppStore((s) => s.apiActions.wsConnecting);
  const wsOpened = useAppStore((s) => s.apiActions.wsOpened);
  const wsConnected = useAppStore((s) => s.apiActions.wsConnected);
  const wsClosed = useAppStore((s) => s.apiActions.wsClosed);
  const wsErrored = useAppStore((s) => s.apiActions.wsErrored);
  const wsAppendMessage = useAppStore((s) => s.apiActions.wsAppendMessage);
  const setWsDraft = useAppStore((s) => s.apiActions.setWsDraft);

  const logRef = useRef<HTMLDivElement>(null);

  // Newest at the bottom: pin the scroll to the end whenever a line is appended.
  // (jsdom has no layout, so scrollHeight is 0 there — the assignment is inert
  // but harmless, and the real app scrolls.)
  const messageCount = req?.ws.messages.length ?? 0;
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messageCount]);

  // Defensive, like ApiRequestView: the tab keys a live request, so this is
  // unreachable through the UI — but keeps the view total on a stale id.
  if (!req) return null;

  const ws = req.ws;
  const isOpen = ws.status === "open";
  const isConnecting = ws.status === "connecting";
  const sendReady = isOpen && ws.connectionId !== null;
  // Everything that only feeds the HANDSHAKE is frozen once one is in flight or
  // done: the url (already), the header rows, and the environment the `{{VAR}}`s
  // resolve against. Editing any of them mid-session cannot affect the live
  // socket, so the UI must not pretend otherwise.
  const locked = isOpen || isConnecting;

  const appendSys = (data: string) =>
    wsAppendMessage(requestId, { dir: "sys", data, at: Date.now() });

  // Every socket event lands here — and keeps landing after unmount, which is
  // exactly what makes the connection survive a tab switch.
  const onEvent = (e: WsEvent) => {
    switch (e.kind) {
      case "open":
        wsOpened(requestId);
        appendSys("Connected");
        break;
      case "message":
        wsAppendMessage(requestId, { dir: "in", data: e.data, at: Date.now() });
        break;
      case "closed":
        wsClosed(requestId);
        appendSys(closedNote(e));
        break;
      case "error":
        wsErrored(requestId, e.message);
        appendSys(`Error: ${e.message}`);
        break;
    }
  };

  // No internal guards: the button gates connect (disabled while url-empty /
  // connecting / open), so this only ever fires from a valid resting state.
  const connect = () => {
    const url = req.url.trim();
    // Only enabled, NAMED rows travel — an empty-named row is scaffolding, the
    // same rule `executeHttpRequest` applies to HTTP headers and gRPC metadata.
    // 🔴 `h.value` is passed through UNTOUCHED: no `substituteVars`, so a
    // `{{TOKEN}}` reaches Rust as the literal template and the secret never
    // crosses IPC. Do not "helpfully" resolve it here.
    const headers: WsHeader[] = req.headers
      .filter((h) => h.enabled && h.name.trim() !== "")
      .map((h) => ({ name: h.name, value: h.value }));
    wsConnecting(requestId);
    appendSys(`Connecting to ${url}`);
    wsConnect(url, onEvent, headers).then(
      (connectionId) => wsConnected(requestId, connectionId),
      (err) => {
        const message = err instanceof Error ? err.message : String(err);
        wsErrored(requestId, message);
        appendSys(`Error: ${message}`);
      },
    );
  };

  const disconnect = () => {
    const connectionId = ws.connectionId;
    // Fire-and-forget: a close on a socket the relay already dropped must never
    // surface as an unhandled rejection.
    if (connectionId !== null) void wsClose(connectionId).catch(() => {});
    wsClosed(requestId);
    appendSys("Disconnected");
  };

  const send = () => {
    const { connectionId, draft } = ws;
    if (connectionId === null || draft === "") return;
    void wsSend(connectionId, draft).catch(() => {});
    wsAppendMessage(requestId, { dir: "out", data: draft, at: Date.now() });
    setWsDraft(requestId, "");
  };

  const buttonLabel = isOpen
    ? "Disconnect"
    : isConnecting
      ? "Connecting…"
      : "Connect";
  const buttonDisabled = isOpen ? false : req.url.trim() === "" || isConnecting;

  return (
    <div className="ws-console" data-testid="ws-console">
      <div className="ws-bar">
        <input
          className="api-url"
          type="text"
          aria-label="WebSocket URL"
          placeholder="wss://echo.example.com"
          value={req.url}
          disabled={locked}
          onChange={(e) => patchApiRequest(requestId, { url: e.target.value })}
        />
        <select
          className="api-env-select"
          aria-label="Environment"
          value={activeEnvironmentId ?? ""}
          disabled={locked}
          onChange={(e) =>
            setActiveEnvironment(e.target.value === "" ? null : e.target.value)
          }
        >
          <option value="">No environment</option>
          {apiEnvironments.map((env) => (
            <option key={env.id} value={env.id}>
              {env.name}
            </option>
          ))}
        </select>
        <span
          className={`ws-status ws-status--${ws.status}`}
          data-testid="ws-status"
        >
          {STATUS_LABEL[ws.status]}
        </span>
        <button
          type="button"
          className="api-send"
          data-testid="ws-connect"
          disabled={buttonDisabled}
          onClick={isOpen ? disconnect : connect}
        >
          {buttonLabel}
        </button>
      </div>

      <section className="api-section">
        <div className="api-section__head">
          <span className="api-section__label">Handshake headers</span>
          <button
            type="button"
            className="api-add-header"
            data-testid="ws-add-header"
            disabled={locked}
            onClick={() => addHeader(requestId)}
          >
            + Add header
          </button>
        </div>
        {locked && (
          <div className="api-section__empty" data-testid="ws-headers-locked">
            Headers are read once, when the handshake is sent — disconnect to
            change them.
          </div>
        )}
        {req.headers.length === 0 ? (
          <div className="api-section__empty">No headers</div>
        ) : (
          <div className="api-headers">
            {req.headers.map((h) => (
              <div
                className="api-header-row"
                data-testid="ws-header-row"
                key={h.id}
              >
                <input
                  type="checkbox"
                  className="api-header-row__enabled"
                  aria-label="Header enabled"
                  checked={h.enabled}
                  disabled={locked}
                  onChange={(e) =>
                    updateHeader(requestId, h.id, { enabled: e.target.checked })
                  }
                />
                <input
                  type="text"
                  className="api-header-row__name"
                  aria-label="Header name"
                  placeholder="Header name"
                  value={h.name}
                  disabled={locked}
                  onChange={(e) =>
                    updateHeader(requestId, h.id, { name: e.target.value })
                  }
                />
                <input
                  type="text"
                  className="api-header-row__value"
                  aria-label="Header value"
                  placeholder="Value or {{VAULT_VAR}}"
                  value={h.value}
                  disabled={locked}
                  onChange={(e) =>
                    updateHeader(requestId, h.id, { value: e.target.value })
                  }
                />
                <button
                  type="button"
                  className="api-header-row__remove"
                  aria-label="Remove header"
                  title="Remove header"
                  disabled={locked}
                  onClick={() => removeHeader(requestId, h.id)}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {ws.error && (
        <div className="api-error" data-testid="ws-error" role="alert">
          {ws.error}
        </div>
      )}

      <div className="ws-log" data-testid="ws-log" ref={logRef}>
        {ws.messages.length === 0 ? (
          <div className="ws-log__empty">No messages yet</div>
        ) : (
          ws.messages.map((m, i) => (
            <div
              key={i}
              className={`ws-log__row ws-log__row--${m.dir}`}
              data-testid="ws-log-row"
            >
              <span className="ws-log__dir">{DIR_GLYPH[m.dir]}</span>
              <span className="ws-log__data">{m.data}</span>
              <span className="ws-log__time">{formatTime(m.at)}</span>
            </div>
          ))
        )}
      </div>

      <div className="ws-send-row">
        <input
          className="api-url"
          type="text"
          aria-label="Message"
          placeholder="Message to send"
          value={ws.draft}
          disabled={!sendReady}
          onChange={(e) => setWsDraft(requestId, e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              send();
            }
          }}
        />
        <button
          type="button"
          className="api-send"
          data-testid="ws-send"
          disabled={!sendReady || ws.draft === ""}
          onClick={send}
        >
          Send
        </button>
      </div>
    </div>
  );
}
