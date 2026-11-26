/** CM6 half of the DB console. Colour comes from the editor's Shiki decoration path (same palette,
 * no lang-sql). ⌘⏎ sends the TEXT textToRun picks; ref gives the Run button the same answer. Keymap
 * at Prec.highest (contenteditable swallows key equivalents). Built once; later text is diffed. */

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

/** Same as EditorRegistry's REHIGHLIGHT_MS: typing must not run Shiki per character. */
const REHIGHLIGHT_MS = 50;

/** Text and selection from the SAME EditorState: the prop and the view are briefly out of step. */
function runTextOf(view: EditorView, queryLanguage: "sql" | "json" | "commandline"): string {
  const range = view.state.selection.main;
  return textToRun(queryLanguage, view.state.doc.toString(), range.from, range.to);
}

/** Asked on click, so selection changes need not re-render the console through props. */
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
  /** The text is the payload, the mode the permission: Rust needs the mode for
   * multi_statement_refusal and still splits the text. */
  onRun: (mode: DbRunMode, text: string) => void;
  /** Lets `DbConsole`'s toolbar ask what ⌘⏎ would run. See {@link QueryEditorHandle}. */
  ref?: React.Ref<QueryEditorHandle>;
  /** Script mode is opt-in per connection. When false, ⇧⌘⏎ does nothing. */
  allowScript: boolean;
  /** The accessible name of the editable surface. */
  ariaLabel: string;
  /** Ghost text showing what this engine expects. Never seeded into the buffer: ⌘⏎ would then
   * run a statement the user never typed. */
  placeholderText?: string;
}

/** ref is destructured out of props: react-hooks/refs taints a props object holding a ref and
 * would reject the effect deps below. */
export function QueryEditor({ ref, ...props }: QueryEditorProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  /** Latest props for the once-built CM6 extensions (else a stale onRun). Refreshed in an
   * effect: a render-phase ref write is impure and react-hooks/refs rejects it. */
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
