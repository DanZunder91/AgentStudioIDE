/**
 * xterm theme, derived from the app's CSS custom properties.
 *
 * ARCHITECTURE §4 ("Theming"): xterm and CM6 themes are derived from the same
 * tokens via `getComputedStyle`, so all three surfaces stay in lockstep on a
 * theme switch. The tokens live in `src/App.css` `:root` — read, never edited
 * from here. The literals below are fallbacks for when the stylesheet has not
 * applied yet (or in a non-DOM context).
 */

import type { ITheme } from "@xterm/xterm";

const FALLBACK_BG = "#0d1117"; // --bg-app
const FALLBACK_FG = "#c9d1d9"; // --text
const FALLBACK_ACCENT = "#3b82f6"; // --accent
const FALLBACK_DIM = "#8b949e"; // --text-dim
const FALLBACK_MONO =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

function cssVar(name: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  try {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
  } catch {
    return fallback;
  }
}

/** The monospace stack, taken from `--mono`. */
export function terminalFontFamily(): string {
  return cssVar("--mono", FALLBACK_MONO);
}

export const TERMINAL_FONT_SIZE = 13;
export const TERMINAL_LINE_HEIGHT = 1.3;

/**
 * Bound scrollback: memory is roughly scrollback x cols x cell x terminals,
 * and a fan-out fleet multiplies it.
 */
export const TERMINAL_SCROLLBACK = 5000;

/** Build the xterm theme from the current CSS tokens. Call per terminal. */
export function terminalTheme(): ITheme {
  const bg = cssVar("--bg-app", FALLBACK_BG);
  const fg = cssVar("--text", FALLBACK_FG);
  const accent = cssVar("--accent", FALLBACK_ACCENT);
  const dim = cssVar("--text-dim", FALLBACK_DIM);

  return {
    background: bg,
    foreground: fg,
    cursor: accent,
    cursorAccent: bg,
    selectionBackground: "rgba(59, 130, 246, 0.30)",
    selectionInactiveBackground: "rgba(139, 148, 158, 0.20)",

    // 16-colour ANSI palette matched to the GitHub-dark aesthetic of App.css.
    black: "#484f58",
    red: "#ff7b72",
    green: "#3fb950",
    yellow: "#d29922",
    blue: "#58a6ff",
    magenta: "#bc8cff",
    cyan: "#39c5cf",
    white: dim,
    brightBlack: "#6e7681",
    brightRed: "#ffa198",
    brightGreen: "#56d364",
    brightYellow: "#e3b341",
    brightBlue: "#79c0ff",
    brightMagenta: "#d2a8ff",
    brightCyan: "#56d4dd",
    brightWhite: "#f0f6fc",
  };
}
