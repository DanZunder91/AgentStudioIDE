/** Wires <DbConsole/>; DbConsoleTab.test.tsx drives this seam over mocked IPC. State lives in
 * dbConsoles[connectionId] (Pane renders only the active tab). Never dials or guesses config.
 * ⌘S: a focus-scoped wrapper onKeyDown; its preventDefault makes other save handlers yield. */

import { useState } from "react";

import { blankDbConsole, useAppStore } from "../../../app/store";
import { modChord } from "../../shortcuts/shortcuts";
import { DbConsole } from "./DbConsole";
// Imported explicitly: a console restored on boot can render before <DbPanel/> loads db.css.
import "../db.css";

export function DbConsoleTab({ connectionId }: { connectionId: string }): React.JSX.Element {
  const connection = useAppStore((s) => s.dbConnections.find((c) => c.id === connectionId));
  const engine = useAppStore((s) => s.dbEngines.find((e) => e.id === connection?.engine));
  const session = useAppStore((s) => s.dbSessions[connectionId]);
  const consoleState = useAppStore((s) => s.dbConsoles[connectionId]);
  const prompt = useAppStore((s) => s.dbSaveQueryPrompt);
  const setDbConsoleText = useAppStore((s) => s.dbActions.setDbConsoleText);
  const setDbConsoleSplit = useAppStore((s) => s.dbActions.setDbConsoleSplit);
  const runDbQuery = useAppStore((s) => s.dbActions.runDbQuery);
  const stopWaiting = useAppStore((s) => s.dbActions.stopWaitingForDbQuery);
  const openDbSession = useAppStore((s) => s.dbActions.openDbSession);
  const saveDbConsoleQuery = useAppStore((s) => s.dbActions.saveDbConsoleQuery);

  // A deleted connection can outlive its tab: `deleteDbConnection` drops the record and the
  // session, and the tab is still open. Saying so beats rendering a console wired to nothing.
  if (connection === undefined || engine === undefined) {
    return (
      <div className="db-console db-console--unavailable" data-testid="db-console-unavailable">
        <p>This connection is no longer available.</p>
        <p className="db-console__hint">
          It was deleted, or the connection store has not finished loading. Open the DB tab in
          the right rail to check.
        </p>
      </div>
    );
  }

  if (session?.status !== "open") {
    return (
      <div className="db-console db-console--closed" data-testid="db-console-closed">
        <p>
          Not connected to <strong>{connection.name}</strong>.
        </p>
        {/* The session's `error` is Rust's already-mapped, already-redacted sentence — the
            one db string rendered verbatim. `opening` has no error and needs none. */}
        {session?.error != null && (
          <p className="db-console__error" data-testid="db-console-closed-error">
            {session.error}
          </p>
        )}
        <button
          type="button"
          data-testid="db-console-connect"
          disabled={session?.status === "opening"}
          onClick={() => void openDbSession(connectionId)}
        >
          {session?.status === "opening" ? "Connecting…" : "Connect"}
        </button>
      </div>
    );
  }

  const c = consoleState ?? blankDbConsole();

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.defaultPrevented) return;
    if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
    if (e.key.toLowerCase() !== "s") return;
    // Suppressed regardless of what the store decides, exactly as `<SaveRequestShortcut/>`
    // does: the webview's save-page dialog must never appear in a desktop IDE.
    e.preventDefault();
    void saveDbConsoleQuery(connectionId);
  };

  // The dialog belongs to THIS connection's console only. Two consoles in a split both read
  // the one `dbSaveQueryPrompt`, so without the id check the same modal would render twice.
  const naming = prompt !== null && prompt.connectionId === connectionId;

  return (
    <div className="db-console-tab" data-testid="db-console-tab" onKeyDown={onKeyDown}>
      {/* A failed save. Above the console rather than inside it, because `DbConsole` is
          presentational and has no prop for it — and because a save failure must not clear or
          cover the results the user just got. */}
      {c.saveError !== null && (
        <p className="db-console__error" role="alert" data-testid="db-console-save-error">
          {c.saveError}
        </p>
      )}
      {/* Why Stop failed, above the console: not a query failure, and must not cover results. */}
      {c.cancelError !== null && (
        <p className="db-console__error" role="status" data-testid="db-console-cancel-error">
          {c.cancelError}
        </p>
      )}
      {/* Which query this buffer IS, when it is one. The only place the adopted name is
          visible, and it is what makes the difference between ⌘S updating and ⌘S asking
          legible rather than surprising. */}
      {c.savedQuery !== null && (
        <p className="db-console-tab__saved" data-testid="db-console-saved-name">
          Saved query: <strong>{c.savedQuery.name}</strong> — {modChord("S")} updates it.
        </p>
      )}
      <DbConsole
        engineLabel={engine.label}
        queryLanguage={engine.queryLanguage}
        text={c.text}
        onTextChange={(text) => setDbConsoleText(connectionId, text)}
        // The editor's chosen text, forwarded: this container can't see the caret, and
        // re-reading c.text would send the whole buffer.
        onRun={(mode, text) => void runDbQuery(connectionId, mode, text)}
        onCancel={() => stopWaiting(connectionId)}
        running={c.running}
        results={c.results}
        error={c.error}
        readOnly={connection.readOnly}
        serverEnforcedReadOnly={engine.serverEnforcedReadOnly}
        rowLimit={connection.rowLimit}
        allowMultiStatement={connection.allowMultiStatement}
        splitFraction={c.splitFraction}
        onSplitFractionChange={(f) => setDbConsoleSplit(connectionId, f)}
        // The grids' find bars survive tab moves under this identity — the
        // same per-connection keying as `dbConsoles[connectionId]` itself.
        findScope={connectionId}
      />
      {naming && <SaveQueryDialog />}
    </div>
  );
}

/** Owned by the tab, so it never outlives its console. The name stays in useState: a modal is a
 * gesture, not something Pane unmounts. */
function SaveQueryDialog(): React.JSX.Element {
  const [name, setName] = useState("");
  const confirm = useAppStore((s) => s.dbActions.confirmDbSaveQueryName);
  const cancel = useAppStore((s) => s.dbActions.cancelDbSaveQueryName);
  // `queries.rs` refuses a blank name outright ("A saved query needs a name."), so the button
  // is disabled on the same condition rather than letting the user press Save and be told no.
  const ready = name.trim() !== "";

  return (
    <div className="db-dialog-overlay" data-testid="db-save-query-dialog">
      <div
        className="db-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Name this query"
        // Esc closes, and Enter confirms — the two keys a one-field dialog has to honour.
        // Handled here rather than on the input so the buttons answer them too.
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            cancel();
            return;
          }
          if (e.key === "Enter" && ready) {
            e.preventDefault();
            void confirm(name);
          }
        }}
      >
        <h2 className="db-dialog__title">Name this query</h2>
        <p className="db-dialog__hint">
          Saved with this connection, in the app data dir — never the repo. It survives a
          restart and appears under <strong>Saved queries</strong> in the DB rail.
        </p>
        <input
          className="db-dialog__input"
          aria-label="Query name"
          data-testid="db-save-query-name"
          value={name}
          autoFocus
          onChange={(e) => setName(e.target.value)}
        />
        <div className="db-dialog__actions">
          <button type="button" className="db-dialog__btn" onClick={cancel}>
            Cancel
          </button>
          <button
            type="button"
            className="db-dialog__btn db-dialog__btn--primary"
            data-testid="db-save-query-confirm"
            disabled={!ready}
            onClick={() => void confirm(name)}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
