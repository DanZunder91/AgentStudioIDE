/**
 * DbConsole tests.
 *
 * ── Nothing is mocked except Shiki ───────────────────────────────────────────
 * Every action is a prop, so the doubles are plain `vi.fn()`s — no store, no IPC, no
 * `invoke`. The one `vi.mock` is `../../editor/shiki`, stubbed to "no grammar
 * available": the console mounts a real CodeMirror view, and a real grammar import
 * per test would track a few hundred milliseconds for nothing this file asserts.
 * `QueryEditor.test.tsx` owns the highlighting claims.
 *
 * ── What is claimed here, and what is deferred to the browser tier ───────────
 * jsdom has no layout engine, so the divider's *geometry* cannot be asserted here:
 * `getBoundingClientRect().height` is 0, which is why the component bails out of a
 * drag it cannot measure — and that bail-out is itself tested below, unstubbed. The
 * drag arithmetic is then tested with the height stubbed, and the comment says
 * plainly that this proves the maths, not the layout. **The real claim — dragging
 * changes the two panes' pixel heights — is in `DbConsole.browser.test.tsx`, and it
 * was falsified before being trusted** (see that file's header).
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { stubGeometry } from "../../editor/find/cmTestKit";
import { dbFailure, describeDbFailure } from "../dbErrors";
import type { DbConsoleProps } from "./DbConsole";
import {
  AFFECTED_RESULT,
  EMPTY_RESULT,
  MESSAGE_RESULT,
  TRACKS_RESULT,
  TRUNCATED_RESULT,
} from "./consoleFixtures";

/**
 * Every grammar id the console's editor actually asked Shiki for, in order.
 *
 * This is the seam between `shikiIdForText` — 100% covered next door in
 * `consoleFormat.test.ts` — and the editor that has to be *given* its answer. Neither
 * half's tests can see the prop between them, which is exactly the join that ships broken.
 * `applyShikiHighlight` calls `ensureLang(shikiId)` synchronously with the id it was
 * handed, so recording that argument records the grammar the editor was given.
 */
const asked = vi.hoisted(() => ({ langs: [] as string[] }));

// No grammar for anything: `applyShikiHighlight` returns before it tokenises, so the
// editor stays plaintext and no async chunk is imported.
vi.mock("../../editor/shiki", () => ({
  ensureLang: (lang: string) => {
    asked.langs.push(lang);
    return Promise.resolve(false);
  },
  highlighter: () => Promise.resolve({ codeToTokens: () => ({ tokens: [] }) }),
  THEME_DARK: "tokyo-night",
  THEME_LIGHT: "github-light",
}));

const { DbConsole } = await import("./DbConsole");

beforeAll(() => stubGeometry());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  asked.langs.length = 0;
});

const base: DbConsoleProps = {
  engineLabel: "PostgreSQL",
  queryLanguage: "sql",
  text: "SELECT 1",
  onTextChange: () => {},
  onRun: () => {},
  onCancel: () => {},
  running: false,
  results: [],
  error: null,
  readOnly: true,
  serverEnforcedReadOnly: true,
  rowLimit: 500,
};

const move = (clientY: number) =>
  act(() => {
    window.dispatchEvent(new MouseEvent("pointermove", { clientY, bubbles: true }));
  });
const up = () =>
  act(() => {
    window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
  });

/** Pretend the split box has been laid out, so the drag maths has a denominator. */
function stubSplitHeight(height: number): void {
  const split = screen.getByTestId("db-console-split");
  vi.spyOn(split, "getBoundingClientRect").mockReturnValue({
    height,
    width: 800,
    top: 0,
    left: 0,
    right: 800,
    bottom: height,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
}

const divider = () => screen.getByTestId("db-console-divider");
const editorPane = () => screen.getByTestId("db-console-editor-pane");
const outputPane = () => screen.getByTestId("db-console-output-pane");

/* ════════════════════════ the tab's two halves ════════════════════════════ */

describe("DbConsole — one tab, two internal panes", () => {
  it("renders the query editor above the output, with a divider between them", () => {
    render(<DbConsole {...base} />);
    // Both halves live inside ONE split box — not two pane-tree leaves, which is
    // what would make the results grid a separately closable, draggable tab.
    const split = screen.getByTestId("db-console-split");
    expect(within(split).getByTestId("db-query-editor")).toBeInTheDocument();
    expect(split.children[0]).toBe(editorPane());
    expect(split.children[1]).toBe(divider());
    expect(split.children[2]).toBe(outputPane());
    // Named regions, so the two halves are addressable by assistive tech.
    expect(screen.getByRole("region", { name: "Query" })).toBe(editorPane());
    expect(screen.getByRole("region", { name: "Output" })).toBe(outputPane());
  });

  it("gives the divider a real separator role, orientation and value", () => {
    render(<DbConsole {...base} splitFraction={0.5} />);
    const bar = screen.getByRole("separator", { name: "Resize query and output" });
    expect(bar).toBe(divider());
    expect(bar).toHaveAttribute("aria-orientation", "horizontal");
    expect(bar).toHaveAttribute("aria-valuenow", "50");
    expect(bar).toHaveAttribute("aria-valuemin", "15");
    expect(bar).toHaveAttribute("aria-valuemax", "85");
    expect(bar).toHaveAttribute("tabindex", "0");
  });

  it("splits the panes by flex-grow, so the divider is the only thing deciding the ratio", () => {
    render(<DbConsole {...base} splitFraction={0.3} />);
    expect(editorPane()).toHaveStyle({ flexGrow: "0.3" });
    expect(outputPane()).toHaveStyle({ flexGrow: "0.7" });
  });

  it("clamps an out-of-range initial fraction rather than collapsing a pane", () => {
    render(<DbConsole {...base} splitFraction={5} />);
    expect(divider()).toHaveAttribute("aria-valuenow", "85");
  });
});

describe("DbConsole — the divider drags", () => {
  it("moves the split and keeps BOTH panes alive", () => {
    // The height is stubbed: this pins the fraction ARITHMETIC (dy / height), not
    // that anything was laid out. The pixel claim is in the browser tier.
    const onSplitFractionChange = vi.fn();
    render(<DbConsole {...base} onSplitFractionChange={onSplitFractionChange} />);
    stubSplitHeight(400);

    fireEvent.pointerDown(divider(), { clientY: 200 });
    move(280); // +80 of 400 = +0.20 → 0.70
    expect(divider()).toHaveAttribute("aria-valuenow", "70");
    expect(editorPane()).toHaveStyle({ flexGrow: "0.7" });
    expect(onSplitFractionChange).toHaveBeenLastCalledWith(0.7);

    move(120); // -80 of 400 = -0.20 → 0.30
    expect(divider()).toHaveAttribute("aria-valuenow", "30");

    up();
    // Both halves survived the drag — a console whose halves can be separated is a
    // broken console, so this is the assertion the one-tab design protects.
    expect(editorPane()).toBeInTheDocument();
    expect(outputPane()).toBeInTheDocument();
    expect(screen.getByTestId("db-query-editor")).toBeInTheDocument();
  });

  it("clamps the drag so neither pane can be dragged away entirely", () => {
    render(<DbConsole {...base} />);
    stubSplitHeight(400);
    fireEvent.pointerDown(divider(), { clientY: 200 });
    move(5000);
    expect(divider()).toHaveAttribute("aria-valuenow", "85");
    move(-5000);
    expect(divider()).toHaveAttribute("aria-valuenow", "15");
    up();
  });

  it("stops tracking on pointerup", () => {
    render(<DbConsole {...base} />);
    stubSplitHeight(400);
    fireEvent.pointerDown(divider(), { clientY: 200 });
    move(280);
    up();
    move(200); // ignored — the window listeners were removed
    expect(divider()).toHaveAttribute("aria-valuenow", "70");
  });

  it("suppresses text selection for the duration of the drag", () => {
    render(<DbConsole {...base} />);
    stubSplitHeight(400);
    expect(document.body.classList.contains("is-resizing")).toBe(false);
    fireEvent.pointerDown(divider(), { clientY: 200 });
    expect(document.body.classList.contains("is-resizing")).toBe(true);
    up();
    expect(document.body.classList.contains("is-resizing")).toBe(false);
  });

  it("refuses to drag a box it cannot measure, instead of handing NaN to flex-grow", () => {
    // Unstubbed, so this is jsdom's real answer: height 0. A `dy / 0` would produce
    // ±Infinity, and a NaN/Infinity grow silently collapses a pane.
    render(<DbConsole {...base} />);
    fireEvent.pointerDown(divider(), { clientY: 200 });
    move(280);
    expect(divider()).toHaveAttribute("aria-valuenow", "50");
    expect(editorPane()).toHaveStyle({ flexGrow: "0.5" });
    // No drag started, so no global selection lock was left behind either.
    expect(document.body.classList.contains("is-resizing")).toBe(false);
  });

  it("resizes with the arrow keys, which need no layout at all", () => {
    const onSplitFractionChange = vi.fn();
    render(<DbConsole {...base} onSplitFractionChange={onSplitFractionChange} />);
    fireEvent.keyDown(divider(), { key: "ArrowDown" });
    expect(divider()).toHaveAttribute("aria-valuenow", "52");
    fireEvent.keyDown(divider(), { key: "ArrowUp" });
    fireEvent.keyDown(divider(), { key: "ArrowUp" });
    expect(divider()).toHaveAttribute("aria-valuenow", "48");
    expect(onSplitFractionChange).toHaveBeenCalledTimes(3);
  });

  it("ignores a key that is not an arrow", () => {
    render(<DbConsole {...base} />);
    fireEvent.keyDown(divider(), { key: "a" });
    expect(divider()).toHaveAttribute("aria-valuenow", "50");
  });
});

/* ═══════════════════════════ run / stop ══════════════════════════════════ */

describe("DbConsole — running and stopping", () => {
  it("runs the statement under the cursor from the Run button", () => {
    const onRun = vi.fn();
    render(<DbConsole {...base} onRun={onRun} />);
    fireEvent.click(screen.getByTestId("db-run"));
    // The SAFE mode by default — never the whole buffer — AND the text to run,
    // asked of the editor so the button cannot mean something different from ⌘⏎.
    expect(onRun).toHaveBeenCalledExactlyOnceWith("statement", "SELECT 1");
  });

  it("says what ⌘/Ctrl+⏎ does, per engine family", () => {
    render(<DbConsole {...base} />);
    expect(screen.getByTestId("db-run").title).toContain(
      "⏎ — Runs the selection, or the statement under the cursor.",
    );
    cleanup();
    render(<DbConsole {...base} queryLanguage="json" engineLabel="MongoDB" />);
    expect(screen.getByTestId("db-run").title).toContain(
      "⏎ — Runs the selection, or the whole command document.",
    );
    cleanup();
    render(<DbConsole {...base} queryLanguage="commandline" engineLabel="Redis" />);
    expect(screen.getByTestId("db-run").title).toContain(
      "⏎ — Runs the selection, or the line under the cursor.",
    );
  });

  it("goes busy while a query is in flight, and offers Stop only then", () => {
    const onCancel = vi.fn();
    const { rerender } = render(<DbConsole {...base} onCancel={onCancel} />);
    expect(screen.getByTestId("db-run")).toBeEnabled();
    expect(screen.getByTestId("db-run")).toHaveTextContent("Run");
    expect(screen.getByTestId("db-cancel")).toBeDisabled();

    rerender(<DbConsole {...base} onCancel={onCancel} running />);
    expect(screen.getByTestId("db-run")).toBeDisabled();
    expect(screen.getByTestId("db-run")).toHaveTextContent("Running…");
    expect(screen.getByTestId("db-console-running")).toBeInTheDocument();

    const stop = screen.getByTestId("db-cancel");
    expect(stop).toBeEnabled();
    fireEvent.click(stop);
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("will not run an empty or whitespace-only buffer", () => {
    render(<DbConsole {...base} text={"   \n  "} />);
    expect(screen.getByTestId("db-run")).toBeDisabled();
    expect(screen.getByTestId("db-run-script")).toBeDisabled();
  });
});

describe("DbConsole — script mode is opt-in", () => {
  it("disables Script and explains why when the connection has not opted in", () => {
    render(<DbConsole {...base} />);
    const script = screen.getByTestId("db-run-script");
    expect(script).toBeDisabled();
    expect(script.title).toBe(
      "Multi-statement execution is off for this connection. Turn it on in the " +
        "connection settings if you mean to run a whole script.",
    );
  });

  it("runs the whole buffer once the connection allows it", () => {
    const onRun = vi.fn();
    render(<DbConsole {...base} onRun={onRun} allowMultiStatement />);
    const script = screen.getByTestId("db-run-script");
    expect(script).toBeEnabled();
    expect(script.title).toContain("runs every statement in the buffer, stopping at the first error");
    fireEvent.click(script);
    expect(onRun).toHaveBeenCalledExactlyOnceWith("script");
  });
});

describe("DbConsole — ⌘/Ctrl+⏎", () => {
  it("runs the statement from inside the editor exactly ONCE", () => {
    // Both the CM6 keymap and the container handler see this keystroke. The
    // container defers to `defaultPrevented`, so a double-run is impossible.
    const onRun = vi.fn();
    render(<DbConsole {...base} onRun={onRun} />);
    const content = screen.getByTestId("db-query-editor").querySelector(".cm-content")!;
    fireEvent.keyDown(content, { key: "Enter", ctrlKey: true });
    expect(onRun).toHaveBeenCalledExactlyOnceWith("statement", "SELECT 1");
  });

  it("runs the statement when focus is on the toolbar, not the editor", () => {
    const onRun = vi.fn();
    render(<DbConsole {...base} onRun={onRun} />);
    fireEvent.keyDown(screen.getByTestId("db-cancel"), { key: "Enter", metaKey: true });
    // Same payload as the in-editor keystroke: the container asks the editor rather than
    // guessing, so where focus happens to be cannot change what runs.
    expect(onRun).toHaveBeenCalledExactlyOnceWith("statement", "SELECT 1");
  });

  it("runs the script on ⇧⌘⏎ only when the connection allows it", () => {
    const onRun = vi.fn();
    const { rerender } = render(<DbConsole {...base} onRun={onRun} />);
    fireEvent.keyDown(screen.getByTestId("db-cancel"), {
      key: "Enter",
      metaKey: true,
      shiftKey: true,
    });
    expect(onRun).not.toHaveBeenCalled();

    rerender(<DbConsole {...base} onRun={onRun} allowMultiStatement />);
    fireEvent.keyDown(screen.getByTestId("db-cancel"), {
      key: "Enter",
      metaKey: true,
      shiftKey: true,
    });
    expect(onRun).toHaveBeenCalledExactlyOnceWith("script");
  });

  it("does nothing while a query is already running, or on a blank buffer", () => {
    const onRun = vi.fn();
    const { rerender } = render(<DbConsole {...base} onRun={onRun} running />);
    fireEvent.keyDown(screen.getByTestId("db-cancel"), { key: "Enter", metaKey: true });
    rerender(<DbConsole {...base} onRun={onRun} text="" allowMultiStatement />);
    fireEvent.keyDown(screen.getByTestId("db-cancel"), { key: "Enter", metaKey: true });
    fireEvent.keyDown(screen.getByTestId("db-cancel"), {
      key: "Enter",
      metaKey: true,
      shiftKey: true,
    });
    expect(onRun).not.toHaveBeenCalled();
  });

  it("ignores Enter without a modifier, and a modifier without Enter", () => {
    const onRun = vi.fn();
    render(<DbConsole {...base} onRun={onRun} />);
    fireEvent.keyDown(screen.getByTestId("db-cancel"), { key: "Enter" });
    fireEvent.keyDown(screen.getByTestId("db-cancel"), { key: "a", metaKey: true });
    expect(onRun).not.toHaveBeenCalled();
  });
});

/* ══════════════════ the editor's grammar tracks the buffer ═══════════════ */

describe("DbConsole — the grammar the editor is GIVEN (the seam)", () => {
  it("switches the MongoDB console from json to sql when SQL is typed, and back", async () => {
    // 🔴 The bug: SQL in a MongoDB console had no keyword colour, because
    // the grammar was picked from the engine once. `shikiIdForText` is unit-tested next
    // door; what nothing could see until now is whether its answer REACHES the editor —
    // and re-reaches it on every keystroke.
    const mongo = { ...base, queryLanguage: "json" as const, engineLabel: "MongoDB" };
    const { rerender } = render(<DbConsole {...mongo} text='{"find": "tracks", "limit": 10}' />);
    await waitFor(() => expect(asked.langs).toEqual(["json"]));

    rerender(<DbConsole {...mongo} text="select * from ARCHIVEDB.temp_playlists LIMIT 10;" />);
    await waitFor(() => expect(asked.langs).toEqual(["json", "sql"]));

    // And back: a command document whose *value* quotes SQL is a document again. If the
    // grammar were sticky, or chosen by searching the text, this last id would be "sql".
    rerender(<DbConsole {...mongo} text='{"find": "t", "filter": {"note": "select * from x"}}' />);
    await waitFor(() => expect(asked.langs).toEqual(["json", "sql", "json"]));
  });

  it("asks for no grammar at all in a Redis console typing a Redis command", async () => {
    // `commandline` has no Shiki grammar, so the editor must ask for nothing rather than
    // borrow one — and the buffer's leading token gives it no reason to.
    render(<DbConsole {...base} queryLanguage="commandline" engineLabel="Redis" text="GET k" />);
    // Nothing to wait FOR, so wait for the debounce to have elapsed on a control that
    // does fire, then assert the absence.
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(asked.langs).toEqual([]);
  });
});

/* ═══════════════════════ the guardrails are visible ══════════════════════ */

describe("DbConsole — the read-only guardrail says how strong it is", () => {
  it("shows a plain read-only badge, with no caveat, when the server enforces it", () => {
    render(<DbConsole {...base} readOnly serverEnforcedReadOnly />);
    const badge = screen.getByTestId("db-guard-badge");
    expect(badge).toHaveTextContent("read-only");
    expect(badge).toHaveAttribute("data-tone", "safe");
    expect(badge.title).toBe(
      "Enforced by the server: a write or DDL fails at the engine, not in this app. Statements that would switch this session back to read-write are refused before they are sent.",
    );
    // Nothing to qualify — and no scary sentence to train the user to ignore.
    expect(screen.queryByTestId("db-guard-caveat")).toBeNull();
  });

  it("names the enforcer and prints the speed-bump warning when only this app enforces it", () => {
    render(<DbConsole {...base} readOnly serverEnforcedReadOnly={false} engineLabel="MongoDB" />);
    const badge = screen.getByTestId("db-guard-badge");
    expect(badge).toHaveTextContent("read-only (enforced by this app)");
    expect(badge).toHaveAttribute("data-tone", "warn");
    expect(screen.getByTestId("db-guard-caveat")).toHaveTextContent(
      "Read-only is a client-side speed bump on this engine, not a guarantee — " +
        "connect with a read-only database user for a real boundary.",
    );
  });

  it("makes writes-enabled loud", () => {
    render(<DbConsole {...base} readOnly={false} />);
    const badge = screen.getByTestId("db-guard-badge");
    expect(badge).toHaveTextContent("writes enabled");
    expect(badge).toHaveAttribute("data-tone", "danger");
    expect(screen.getByTestId("db-guard-caveat")).toHaveTextContent(
      "Writes and DDL will run against this database.",
    );
  });

  it("shows the engine and the row cap", () => {
    render(<DbConsole {...base} engineLabel="Amazon Aurora PostgreSQL" rowLimit={1000} />);
    expect(screen.getByTestId("db-engine")).toHaveTextContent("Amazon Aurora PostgreSQL");
    expect(screen.getByTestId("db-rowlimit")).toHaveTextContent("Rows 1000");
  });
});

/* ══════════════════════════════ the output ═══════════════════════════════ */

describe("DbConsole — the output pane", () => {
  it("says nothing has run yet, before anything has", () => {
    render(<DbConsole {...base} />);
    // "Ctrl", not "⌘": `modKey()` resolves the platform label and jsdom reports a
    // non-Mac userAgent. On a Mac the same string reads "⌘⏎".
    expect(screen.getByTestId("db-console-idle")).toHaveTextContent(
      "Nothing has run yet. Ctrl⏎ runs the selection, or the statement under the cursor.",
    );
    expect(screen.queryByTestId("db-result")).toBeNull();
  });

  it("renders several results together, with a message-kind among them", () => {
    // The whole point of per-statement results: statement 3 failing must not hide 1 and 2.
    render(<DbConsole {...base} results={[TRACKS_RESULT, AFFECTED_RESULT, MESSAGE_RESULT]} />);
    const blocks = screen.getAllByTestId("db-result");
    expect(blocks).toHaveLength(3);
    expect(blocks.map((b) => b.getAttribute("data-kind"))).toEqual([
      "rows",
      "affected",
      "message",
    ]);

    // 1: the grid, with its rows.
    expect(within(blocks[0]).getByTestId("db-grid")).toBeInTheDocument();
    expect(within(blocks[0]).getByTestId("db-result-summary")).toHaveTextContent("3 rows · 12 ms");
    // 2: an affected count and the server's notice alongside it.
    expect(within(blocks[1]).getByTestId("db-result-affected")).toHaveTextContent(
      "42 rows affected · 5 ms",
    );
    expect(within(blocks[1]).getByTestId("db-result-notice")).toHaveTextContent(
      "1 row was skipped by a trigger.",
    );
    // 3: the syntax error — in the list, beside the others, carrying its statement.
    expect(within(blocks[2]).getByTestId("db-result-message")).toHaveTextContent(
      'syntax error at or near "SELET"',
    );
    expect(blocks[2]).toHaveTextContent("SELET 1");
  });

  it("does NOT treat a failed statement as a global error state", () => {
    render(<DbConsole {...base} results={[MESSAGE_RESULT]} />);
    // A `message` result is a normal outcome: no alert, no error strip, and
    // the idle placeholder is gone because something DID run.
    expect(screen.queryByTestId("db-console-error")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByTestId("db-console-idle")).toBeNull();
    expect(screen.getByTestId("db-result-message")).toBeInTheDocument();
  });

  it("numbers the results only when there is more than one", () => {
    render(<DbConsole {...base} results={[TRACKS_RESULT]} />);
    expect(document.querySelector(".db-result__index")).toBeNull();
    cleanup();
    render(<DbConsole {...base} results={[TRACKS_RESULT, MESSAGE_RESULT]} />);
    expect(
      Array.from(document.querySelectorAll(".db-result__index")).map((e) => e.textContent),
    ).toEqual(["1", "2"]);
  });

  it("says so when a message result carries no text", () => {
    render(<DbConsole {...base} results={[{ ...MESSAGE_RESULT, notice: null }]} />);
    expect(screen.getByTestId("db-result-message")).toHaveTextContent(
      "The server returned a message with no text.",
    );
    // The notice is the message body on a message result, so it is not repeated.
    expect(screen.queryByTestId("db-result-notice")).toBeNull();
  });

  it("passes truncation through to the grid, loudly", () => {
    render(<DbConsole {...base} results={[TRUNCATED_RESULT]} />);
    expect(screen.getByTestId("db-result-summary")).toHaveTextContent(
      "first 500 rows of more · 88 ms",
    );
    expect(screen.getByTestId("db-grid-truncated")).toHaveTextContent(
      "Showing the first 500 rows of more",
    );
  });

  it("renders a zero-row result as a grid that says so", () => {
    render(<DbConsole {...base} results={[EMPTY_RESULT]} />);
    expect(screen.getByTestId("db-result-summary")).toHaveTextContent("0 rows · 3 ms");
    expect(screen.getByTestId("db-grid-empty")).toBeInTheDocument();
  });
});

describe("DbConsole — a failed CALL is the other thing entirely", () => {
  it("prints the sentence it was handed, as an alert", () => {
    render(<DbConsole {...base} error={dbFailure("timeout")} />);
    const alert = screen.getByTestId("db-console-error");
    expect(alert).toHaveAttribute("role", "alert");
    // The sentence comes from `../dbErrors.ts`, the app's one error mapper. This file used
    // to expect a SECOND copy's wording ("ran past this connection's timeout and was
    // stopped") — the two tables had already drifted on this very code while both suites
    // were green, which is why the duplicate is gone.
    expect(alert).toHaveTextContent("The database did not answer within this connection's timeout.");
    // No results, and no "nothing has run yet" either — something ran and failed.
    expect(screen.queryByTestId("db-console-idle")).toBeNull();
  });

  it("keeps earlier results visible beneath the error", () => {
    // A script that produced two results and then had its session dropped must not
    // lose the two results.
    render(
      <DbConsole {...base} error={dbFailure("not-found")} results={[TRACKS_RESULT, AFFECTED_RESULT]} />,
    );
    expect(screen.getByTestId("db-console-error")).toHaveTextContent(
      "That connection or session no longer exists — reload the panel and open it again.",
    );
    expect(screen.getAllByTestId("db-result")).toHaveLength(2);
  });

  it("prints a statement failure's OWN sentence, never a connection diagnosis", () => {
    // The original bug, at this seam: SQL typed into a MongoDB console. What must reach
    // the screen is the sentence Rust wrote — naming the shape a command document takes —
    // and NOT `invalid-config`'s advice about a host and port that were both fine.
    const failure = describeDbFailure(
      'invalid-statement: That is not a MongoDB command document. A command is one JSON object ' +
        'whose FIRST key is the command name, e.g. {"find": "tracks", "limit": 10}.',
    );
    render(<DbConsole {...base} error={failure} />);
    const alert = screen.getByTestId("db-console-error");
    expect(alert).toHaveTextContent('e.g. {"find": "tracks", "limit": 10}');
    expect(alert.textContent).not.toContain("check the host");
  });
});
