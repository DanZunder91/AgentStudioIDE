/**
 * DbConsoleTab — the container that makes `<DbConsole/>` a real, working tab.
 *
 * `DbConsole` is deliberately presentational: every one of its props is data or a callback,
 * which is why it could be built and tested in parallel with the IPC layer. This file is the
 * seam between the two, and the seam is where the interesting mistakes live — the metrics
 * dashboard shipped a broken screen because a fully-tested button met a fully-tested command
 * across an untested join (`metricsNoSelectionSeam.test.tsx`). So this file is small,
 * and `DbConsoleTab.test.tsx` drives it end to end over a mocked IPC edge only.
 *
 * ── Where the state lives, and why not here ──────────────────────────────────
 * All of it is in the store (`dbConsoles[connectionId]`), none of it in `useState`, because
 * `Pane`'s `TabView` renders **only the active tab**. A console holding its buffer locally
 * loses everything you typed the moment you click the terminal next to it. Keyed by
 * connection id to match `openDbConsoleTab`'s dedupe: one connection → one console → one
 * session → one draft.
 *
 * ── What it refuses to invent ────────────────────────────────────────────────
 * A console for a connection that is not open renders the reason and a Connect button —
 * it does **not** silently dial. Connecting is a gesture with a cost (a real round trip,
 * a credential read from the Vault) and the panel is where the user makes it.
 *
 * Nothing about a not-yet-loaded connection is guessed: with no record, there is no engine,
 * no row limit and no read-only flag, and the honest render is "still loading", not a
 * console configured from defaults that may be wrong about read-only.
 *
 * ── ⌘/Ctrl+S: save the query ─────────────────────────────────────────
 * The keystroke is handled by a `onKeyDown` on the wrapper element, NOT by a window-level
 * listener like `<SaveRequestShortcut/>`, and the difference is load-bearing in two ways:
 *
 * 1. **Scope.** Two consoles can be mounted at once (one per pane in a split). A window
 *    listener would have to guess which one the user meant; a DOM-scoped handler fires only
 *    for the subtree that actually contains focus, so the answer is not a guess.
 * 2. **It reaches the editor.** ⌘S is not a native-menu accelerator (`src-tauri/src/menu.rs`
 *    binds only Cmd+W), and `QueryEditor`'s CM6 keymap does not claim `Mod-s`, so the keydown
 *    bubbles out of the `contenteditable` and through React's root listener to here. That is
 *    the native-menu trap read in the other direction: a `contenteditable` swallows a native
 *    *key equivalent*, not an ordinary keydown nobody has bound.
 *
 * `preventDefault` runs before the store is asked, so the webview's "save page" is suppressed
 * and `<SaveRequestShortcut/>`'s `defaultPrevented` guard yields cleanly — one keystroke
 * cannot save both an API request and a query.
 */

import { useState } from "react";

import { blankDbConsole, useAppStore } from "../../../app/store";
import { modChord } from "../../shortcuts/shortcuts";
import { DbConsole } from "./DbConsole";
// The wrapper's and the name dialog's rules live in the feature's stylesheet, and this file
// imports it EXPLICITLY rather than relying on `<DbPanel/>` having pulled it in: a console tab
// restored on boot can render before the DB rail tab has ever been opened, and a tab whose
// layout depends on another component having mounted first is a bug waiting for a fresh profile.
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
      {/* Why Stop could not be delivered. Above the console for the same reason a save error is:
          it must not clear or cover the results, and it is not a query failure — the query is fine
          and may still be running. The commonest value is not a failure at all: three engines have
          no server-side cancel, and saying so beats a button that appears to work. */}
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
        // `text` is what the editor decided to run — the selection, the statement under the
        // cursor, or the whole buffer. Forwarded rather than re-derived here: this
        // container cannot see the caret, and re-reading `c.text` is exactly the bug that
        // made ⌘⏎ send the whole buffer and be refused as multi-statement.
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

/**
 * The "name this query" dialog — the create half of ⌘S.
 *
 * Rendered by the console tab rather than by a host in `App.tsx`, which keeps the feature in
 * its own files — and that is also the better place for it: a dialog owned by the tab
 * cannot be left on screen over a console that has been closed.
 *
 * The typed name lives in `useState` here, not in the store, for the same reason
 * `<ExportDialog/>`'s draft does: a modal is a gesture, not a surface `Pane` unmounts, and the
 * store should not accumulate a key per in-flight text field.
 */
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
