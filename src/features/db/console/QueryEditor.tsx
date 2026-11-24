/**
 * QueryEditor — the CodeMirror 6 half of the DB console.
 *
 * ── Highlighting: real SQL colour, zero new dependencies ─────────────────────
 * Colour comes from the **Shiki → CM6 decoration** path the file editor already
 * ships: `shikiField` + `applyShikiHighlight`, re-run on a 50 ms
 * debounce after the last keystroke. So the console's SQL is *the same palette* as a
 * `.sql` file in the editor — which matters more than it sounds, because two
 * different SQL palettes in one app reads as a bug — and nothing was added to
 * `package.json`.
 *
 * `@codemirror/lang-sql` is **not** used and is not needed for colour. What it would
 * buy is a syntax *tree*: bracket/quote auto-close, smart indent, and schema-aware
 * completion from the connection tree. That is a real want, but it is a
 * dependency decision and not this component's to make unilaterally — see the
 * recommendation in the handover report. Note also that statement-under-cursor does
 * **not** need a parser: the lexical splitter in `guard.rs`, mirrored in
 * `statements.ts`, computes statement boundaries lexically.
 *
 * ── ⌘⏎ sends TEXT, not just a mode (🔴 a fixed bug) ─────────────────────────
 * This binding used to call `onRun("statement")` — a mode and nothing else — and the
 * store then sent the **whole buffer**, which Rust refused as multi-statement. The
 * mode said "one statement" and the payload said "all of them", and the console's own
 * tooltip had been promising "runs the statement under the cursor" the whole time with
 * nothing anywhere computing that. So the editor now decides what to run, because it
 * is the only place that knows the caret and the selection, and passes the text up:
 * a selection wins verbatim; otherwise `textToRun` picks the statement / the line /
 * the whole buffer by engine family. `⇧⌘⏎` still sends the whole buffer.
 *
 * `ref` exposes the same computation to `DbConsole`'s toolbar, so the **Run button**
 * and ⌘⏎ cannot disagree about what "Run" means — a button whose own tooltip
 * describes a different action than the button performs is the bug above, again.
 *
 * ── Why the keymap lives in CM6 and not on a container ───────────────────────
 * A focused `contenteditable` swallows macOS key equivalents, so a binding
 * that must work while the editor has focus has to be a CM6 keymap at
 * `Prec.highest`, not a React `onKeyDown` further up. `DbConsole` keeps a container
 * handler as well, for when focus is on the toolbar — it defers to this one by
 * checking `defaultPrevented`, so ⌘⏎ can never run a statement twice.
 *
 * ── Controlled, but not re-created ───────────────────────────────────────────
 * `text`/`onTextChange` make this look like a controlled input, and it behaves like
 * one, but the view is built **once**: an external `text` change is diffed against
 * the live document and dispatched as an edit, so the caret, undo history and scroll
 * survive. Rebuilding the view per render would throw all three away on every
 * keystroke.
 */

import { Prec, type Extension } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, placeholder } from "@codemirror/view";
import { bracketMatching } from "@codemirror/language";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { useEffect, useImperativeHandle, useLayoutEffect, useRef } from "react";

import { applyShikiHighlight, shikiField } from "../../editor/highlight";
import { THEME_DARK } from "../../editor/shiki";
import { editorChromeTheme } from "../../editor/theme";
import type { DbRunMode } from "../types";
import { textToRun } from "./statements";
import "./console.css";

/**
 * Re-tokenise this long after the last keystroke. Mirrors `EditorRegistry`'s
 * `REHIGHLIGHT_MS` deliberately — the same number, for the same reason (typing must
 * not run Shiki per character) — rather than importing a private constant from a
 * module this component does not otherwise depend on.
 */
const REHIGHLIGHT_MS = 50;

/**
 * What ⌘⏎ would run for this view right now.
 *
 * Both the document and the selection are read off the SAME `EditorState`, on purpose: taking
 * the text from the `text` prop and the range from the view would slice one snapshot with the
 * other's offsets, and the two are momentarily out of step on every keystroke.
 */
function runTextOf(view: EditorView, queryLanguage: "sql" | "json" | "commandline"): string {
  const range = view.state.selection.main;
  return textToRun(queryLanguage, view.state.doc.toString(), range.from, range.to);
}

/**
 * What a caller outside the editor can ask it, imperatively.
 *
 * Exactly one question, and it exists because the answer is only knowable *here*: the caret and
 * the selection live in the CM6 state, and `DbConsole`'s Run button has to send the same text
 * ⌘⏎ would. Reporting every selection change upward as a prop instead would re-render the whole
 * console on each arrow key to answer a question asked only on click.
 */
export interface QueryEditorHandle {
  /** The text ⌘⏎ would run right now, given the caret/selection and the engine family. */
  runText: () => string;
}

export interface QueryEditorProps {
  text: string;
  onTextChange: (text: string) => void;
  /** Shiki grammar id, or null for plaintext (`shikiIdFor`). */
  shikiId: string | null;
  /** `EngineSpec.queryLanguage` — decides what ⌘⏎ runs when nothing is selected. */
  queryLanguage: "sql" | "json" | "commandline";
  /**
   * Run `text` in `mode`. **The text is the payload, the mode is the permission** — Rust still
   * needs the mode for `multi_statement_refusal`, and it still splits what it is given.
   */
  onRun: (mode: DbRunMode, text: string) => void;
  /** Lets `DbConsole`'s toolbar ask what ⌘⏎ would run. See {@link QueryEditorHandle}. */
  ref?: React.Ref<QueryEditorHandle>;
  /** Script mode is opt-in per connection. When false, ⇧⌘⏎ does nothing. */
  allowScript: boolean;
  /** The accessible name of the editable surface. */
  ariaLabel: string;
  /**
   * Ghost text shown while the buffer is empty — **what this engine expects, by example**.
   *
   * 🔴 Without it, nothing on screen says a MongoDB console wants a JSON command document,
   * and an empty editor in a tab labelled with a database invites SQL.
   *
   * A placeholder rather than **seeding the buffer**, and the difference matters: seeded text is
   * real text, so ⌘⏎ would run a statement the user never typed — against a database, possibly a
   * production one. Ghost text teaches the shape and cannot be executed.
   */
  placeholderText?: string;
}

/**
 * `ref` is destructured OUT of `props`, and that is not a style choice: `react-hooks/refs`
 * treats a props object holding a ref as ref-tainted, and then rejects the two existing
 * `useEffect` deps arrays below (`[props.text]`, `[shikiId, props.text]`) as "cannot access
 * refs during render". Separating it at the parameter keeps the rule at `error`, where it
 * belongs — it caught a real defect in `useTerminal.ts`.
 */
export function QueryEditor({ ref, ...props }: QueryEditorProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  /**
   * The latest props, for the CM6 extensions — which are built once, so a handler
   * that closed over the first render's `onRun` would call a stale callback forever.
   * Seeded with `useRef(props)` and refreshed in an effect rather than during
   * render: a render-phase ref write is impure and `react-hooks/refs` rejects it
   * (that rule caught a real defect in `useTerminal.ts` and stays at error).
   */
  const latest = useRef(props);
  useEffect(() => {
    latest.current = props;
  });

  // `[]` is safe and NOT stale: both refs are stable, and the handle reads them at call time.
  useImperativeHandle(
    ref,
    () => ({ runText: () => runTextOf(viewRef.current as EditorView, latest.current.queryLanguage) }),
    [],
  );

  useLayoutEffect(() => {
    const extensions: Extension[] = [
      editorChromeTheme, // the file editor's chrome, so the two surfaces match
      lineNumbers(),
      bracketMatching(),
      history(),
      // Prec.highest: ahead of defaultKeymap, and ahead of anything CM6 adds later.
      Prec.highest(
        keymap.of([
          {
            key: "Mod-Enter",
            preventDefault: true,
            run: (view) => {
              // The TEXT, decided here from the caret/selection — see the header. Passing
              // only the mode is the bug the header describes.
              latest.current.onRun("statement", runTextOf(view, latest.current.queryLanguage));
              return true;
            },
          },
          {
            key: "Shift-Mod-Enter",
            preventDefault: true,
            run: (view) => {
              // Swallowed rather than downgraded to `statement`: a user who asked
              // for the script must not silently get one statement instead.
              // The whole buffer, deliberately — Script means the script, not the selection.
              if (latest.current.allowScript) {
                latest.current.onRun("script", view.state.doc.toString());
              }
              return true;
            },
          },
        ]),
      ),
      keymap.of([...historyKeymap, ...defaultKeymap]),
      shikiField,
      EditorView.contentAttributes.of({ "aria-label": latest.current.ariaLabel }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) latest.current.onTextChange(update.state.doc.toString());
      }),
    ];
    if (latest.current.placeholderText !== undefined) {
      // Read once, like every other extension here: the console's expected input is a property of
      // its engine, and an engine does not change under a live console.
      extensions.push(placeholder(latest.current.placeholderText));
    }
    const view = new EditorView({
      doc: latest.current.text,
      extensions,
      parent: hostRef.current as HTMLDivElement,
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  // An external text change (a saved query loaded, the store resetting the console)
  // becomes an edit, not a rebuild. Typing lands here too and is a no-op: the
  // document already holds what the prop is telling us.
  useEffect(() => {
    const view = viewRef.current as EditorView;
    const current = view.state.doc.toString();
    if (current === props.text) return;
    view.dispatch({ changes: { from: 0, to: current.length, insert: props.text } });
  }, [props.text]);

  // Colour, debounced. `applyShikiHighlight` is already total — a missing grammar or
  // a tokenizer throw leaves the plaintext render alone — so there is no failure
  // path to handle here beyond "no grammar for this language".
  const shikiId = props.shikiId;
  useEffect(() => {
    if (shikiId === null) return;
    const view = viewRef.current as EditorView;
    const timer = setTimeout(() => {
      void applyShikiHighlight(view, shikiId, THEME_DARK);
    }, REHIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [shikiId, props.text]);

  return <div className="db-query" data-testid="db-query-editor" ref={hostRef} />;
}
