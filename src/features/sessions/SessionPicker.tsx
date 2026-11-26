/** A folder's past Claude sessions (one tab per cwd), greyed as history. Double-click relaunches
 * as a new agent via `useLaunchAgent` + `resumeSessionId`; the picker stays open. A rejection is
 * a calm inline note, never a crash. */

import { useEffect, useRef, useState } from "react";

import { useLaunchAgent } from "../fleet/useLaunchAgent";
import { formatSessionDate, formatSize } from "./sessionModel";
import { listClaudeSessions, type ClaudeSessionMeta } from "./sessionsIpc";
import "./sessions.css";

/** A UX debounce, not a completion signal (the spawn is lazy): while it shows, further recovers
 * are no-ops, so a repeated double-click cannot spawn two agents off one session. */
export const RECOVERING_MS = 2500;

type LoadState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; sessions: ClaudeSessionMeta[] };

/** A settled fetch, stamped with WHICH fetch it answers (cwd + reload token). */
interface FetchResult {
  cwd: string;
  token: number;
  state: Exclude<LoadState, { phase: "loading" }>;
}

export function SessionPicker({ cwd }: { cwd: string }): React.JSX.Element {
  const launch = useLaunchAgent();
  /** The last SETTLED fetch; null before the first settles. */
  const [result, setResult] = useState<FetchResult | null>(null);
  /** Single-click selection — visual + the Enter target. Never launches. */
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** The row whose recover is "in flight" (see RECOVERING_MS); null = none. */
  const [recoveringId, setRecoveringId] = useState<string | null>(null);
  /** Bumped by ↻; a distinct dep so a refresh re-runs the same-cwd effect. */
  const [reloadToken, setReloadToken] = useState(0);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    let active = true;
    listClaudeSessions(cwd)
      .then((sessions) => {
        if (active) setResult({ cwd, token: reloadToken, state: { phase: "ready", sessions } });
      })
      .catch((err: unknown) => {
        // Calm inline error, never a crash. Tauri command errors arrive as
        // plain strings, not Error instances — cover both shapes.
        const message = err instanceof Error ? err.message : String(err);
        if (active) setResult({ cwd, token: reloadToken, state: { phase: "error", message } });
      });
    return () => {
      active = false;
    };
  }, [cwd, reloadToken]);

  // Loading is derived, never set: an answer for another cwd or an older token is stale, so the
  // current fetch is still in flight (no synchronous setState in the effect).
  const state: LoadState =
    result && result.cwd === cwd && result.token === reloadToken
      ? result.state
      : { phase: "loading" };

  // The "Recovering…" debounce must not fire a state update after unmount.
  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  const recover = (session: ClaudeSessionMeta): void => {
    // Inert rows stay inert, and one recover at a time: a second double-click
    // while the debounce shows must not spawn a second agent.
    if (!session.resumable || recoveringId !== null) return;
    setRecoveringId(session.sessionId);
    launch(cwd, { resumeSessionId: session.sessionId });
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setRecoveringId(null);
    }, RECOVERING_MS);
  };

  return (
    <div className="session-picker">
      <header className="session-picker__header">
        <span className="session-picker__title">Past sessions</span>
        <span className="session-picker__cwd" title={cwd}>
          {cwd}
        </span>
        <button
          type="button"
          className="session-picker__refresh"
          aria-label="Refresh sessions"
          title="Refresh sessions"
          onClick={() => setReloadToken((t) => t + 1)}
        >
          ↻
        </button>
      </header>

      {state.phase === "loading" && (
        <div className="session-picker__note">Loading sessions…</div>
      )}
      {state.phase === "error" && (
        <div className="session-picker__note session-picker__note--error" role="alert">
          Couldn't load sessions: {state.message}
        </div>
      )}
      {state.phase === "ready" && state.sessions.length === 0 && (
        <div className="session-picker__note">No past sessions for this folder</div>
      )}

      {state.phase === "ready" && state.sessions.length > 0 && (
        <ul
          className="session-picker__list"
          role="listbox"
          aria-label={`Past sessions in ${cwd}`}
        >
          {state.sessions.map((session) => {
            const recovering = recoveringId === session.sessionId;
            const className = [
              "session-row",
              selectedId === session.sessionId && "session-row--selected",
              !session.resumable && "session-row--unresumable",
              recovering && "session-row--recovering",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <li
                key={session.sessionId}
                role="option"
                aria-selected={selectedId === session.sessionId}
                aria-disabled={!session.resumable || undefined}
                tabIndex={0}
                className={className}
                title={session.label}
                onClick={() => setSelectedId(session.sessionId)}
                onDoubleClick={() => recover(session)}
                onKeyDown={(e) => {
                  // Keyboard parity with the double-click: Enter recovers the
                  // focused row (inert/in-flight rows no-op inside `recover`).
                  if (e.key === "Enter") {
                    e.preventDefault();
                    recover(session);
                  }
                }}
              >
                <span className="session-row__date">
                  {formatSessionDate(session.mtimeMs)}
                </span>
                <span className="session-row__label">{session.label}</span>
                {!session.resumable && (
                  <span className="session-row__hint">(not resumable)</span>
                )}
                {recovering && (
                  <span className="session-row__recovering">Recovering…</span>
                )}
                <span className="session-row__size">{formatSize(session.sizeBytes)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
