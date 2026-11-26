/** Editor chrome (caret, selection, gutter, active line) matched to the Tokyo Night tokens; the
 * native caret is otherwise invisible dark-on-dark. No `drawSelection()`, so `caret-color`
 * drives the caret; the `.cm-cursor` rules are a fallback. */

import { EditorView } from "@codemirror/view";

/* Tokyo Night palette (matches the Shiki `tokyo-night` theme painting tokens). */
const BG = "#1a1b26";
const FG = "#a9b1d6";
const CARET = "#c0caf5"; // bright lavender — clearly visible on the dark surface
const SELECTION = "rgba(122, 162, 247, 0.30)"; // translucent Tokyo Night blue
const GUTTER_FG = "#565f89";
const GUTTER_ACTIVE_FG = "#a9b1d6";
const ACTIVE_LINE = "rgba(41, 46, 66, 0.45)";
const MONO = 'var(--mono, ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace)';

export const editorChromeTheme = EditorView.theme(
  {
    "&": { backgroundColor: BG, color: FG, height: "100%" },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": { fontFamily: MONO, lineHeight: "1.5" },

    // Caret — native (caret-color) AND drawn (.cm-cursor) so it shows either way.
    ".cm-content": { caretColor: CARET },
    ".cm-cursor, .cm-cursor-primary": { borderLeftColor: CARET, borderLeftWidth: "2px" },
    "&.cm-focused .cm-cursor": { borderLeftColor: CARET },

    // Selection — drawn layer (if ever enabled) AND native ::selection.
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
      backgroundColor: SELECTION,
    },
    ".cm-content ::selection, .cm-line::selection": { backgroundColor: SELECTION },

    // Gutter + active line, matching the surface.
    ".cm-gutters": { backgroundColor: BG, color: GUTTER_FG, border: "none" },
    ".cm-activeLine": { backgroundColor: ACTIVE_LINE },
    ".cm-activeLineGutter": { backgroundColor: ACTIVE_LINE, color: GUTTER_ACTIVE_FG },
  },
  { dark: true },
);
