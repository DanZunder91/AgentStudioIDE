/**
 * Editor "chrome" theme (M4) — caret, selection, gutter, active line, surface.
 *
 * Shiki colors the TOKENS via CM6 decorations, but the editor's chrome is a
 * separate CM6 concern. Without theming, the native caret sits dark-on-dark
 * against the Tokyo Night background and is invisible (the cursor could not be
 * seen). This themes the chrome to match the Tokyo Night token palette so
 * the whole editor reads as one dark surface — in the default editable state AND
 * for read-only files.
 *
 * We do NOT use `drawSelection()`, so the caret is the browser-native one
 * (`caret-color` on `.cm-content`); the `.cm-cursor` rules are a belt-and-braces
 * fallback should a drawn cursor ever be added.
 */

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
