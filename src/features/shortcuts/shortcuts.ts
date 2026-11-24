/**
 * The keyboard-shortcuts reference data (the cheat sheet of every shortcut).
 *
 * A SINGLE source of truth so the cheat sheet can never drift from what the app
 * actually binds. Every entry here corresponds to a real handler:
 *   • `Mod-s` / `F12` / `Shift-F12` — CodeMirror keymaps (`editor/EditorRegistry`,
 *     `editor/lsp/definition`).
 *   • `Mod+Shift+F` + Esc — the Find-in-Files overlay (`features/find`).
 *   • `Mod`+Click / `Mod`+hover — go-to-definition / find-usages + the underline
 *     affordance (`editor/lsp/definition`, `editor/lsp/hoverDefinition`).
 *   • `Mod+/` — this very overlay (`features/shortcuts/ShortcutsPanel`).
 *   • bare `Mod+O`, and a `Mod+F` no surface claimed — `features/shortcuts/FindKeysShortcut`.
 * If you add or change a binding, update it here in the same commit.
 */

import { os } from "../../lib/platform";

/** True on macOS/iOS — where the platform modifier is ⌘ and Cmd+W is a native menu
 *  accelerator (so the tab-close binding must go through the app menu, not keydown).
 *  A thin wrapper over `lib/platform`'s `os()`, the one OS answer for the whole UI. */
export function isMac(): boolean {
  return os() === "macos";
}

/**
 * True on Windows — for the words a Windows user reads (File Explorer, winget). A thin
 * wrapper over `lib/platform`'s `os()` (which documents why it matches `Windows`, never `Win`).
 */
export function isWindows(): boolean {
  return os() === "windows";
}

/** The platform modifier label: ⌘ on macOS, Ctrl elsewhere. */
export function modKey(): string {
  return isMac() ? "⌘" : "Ctrl";
}

/**
 * One modifier chord as a person writes it on this platform, for prose and tooltips:
 * `⌘S` on macOS, `Ctrl+S` on Windows and Linux. A hardcoded `⌘S` in a sentence is
 * a key a Windows keyboard does not have.
 */
export function modChord(keys: string): string {
  return isMac() ? `⌘${keys}` : `Ctrl+${keys}`;
}

export interface Shortcut {
  /** Display chips (already platform-resolved), e.g. ["⌘", "S"] or ["Shift", "F12"]. */
  keys: string[];
  /** What it does. */
  description: string;
}

export interface ShortcutGroup {
  title: string;
  shortcuts: Shortcut[];
}

/**
 * The grouped shortcuts, with the platform modifier resolved at call time (so the
 * same data renders ⌘ on macOS and Ctrl elsewhere).
 */
export function shortcutGroups(): ShortcutGroup[] {
  const mod = modKey();
  return [
    {
      title: "Code intelligence",
      shortcuts: [
        { keys: [mod, "Click"], description: "Go to definition — or, on a declaration, find its usages" },
        { keys: [mod, "Hover"], description: "Underline a symbol you can navigate to" },
        { keys: ["F12"], description: "Go to definition (at the cursor)" },
        { keys: ["Shift", "F12"], description: "Find usages (at the cursor)" },
      ],
    },
    {
      title: "Search",
      shortcuts: [
        { keys: [mod, "Shift", "F"], description: "Find in files — project-wide search" },
        // Was missing from this sheet since the overlay shipped — `FindFiles.tsx`
        // installs its own window listener, so nothing here dispatched it and
        // nothing caught the omission. The file's own contract (see the header)
        // is that a binding and its row move together.
        { keys: [mod, "Shift", "O"], description: "Find a file by name — quick open" },
        // Ctrl+F and Ctrl+O use the workspace of the window that is open.
        // Bare Mod+O had no binding
        // at all; now it is the same quick open (FindKeysShortcut). Both overlays
        // start on the workspace of the tab you are in, in whichever window.
        { keys: [mod, "O"], description: "Quick open too — the same finder, without the Shift" },
        // Local find. One binding, THREE surfaces — the CM6 keymap serves
        // the editor (editor/find/bufferSearch); a capture-phase host listener
        // serves the terminal (terminal/find); and the rendered Markdown
        // preview serves itself (editor/previewFind). On macOS
        // plain Ctrl+F stays with readline in the terminal.
        //
        // ⚠️ This row USED TO LIE. It said "the current file or terminal" while a
        // rendered preview answered the key with nothing at all — `bufferSearch`'s
        // keymap is a CodeMirror facet, i.e. a listener on `view.contentDOM`, and
        // in rendered mode CodeEditor hides that host with `display: none`, which
        // can hold no focus. Pressing the key showed it; the sheet said it
        // should work. Same-commit rule, both directions: a binding that
        // changes moves its row, and a row that promises something must have a
        // handler behind it.
        {
          keys: [mod, "F"],
          description: "Find in the current file, terminal, or rendered Markdown preview",
        },
        // The fallback half of the same key (FindKeysShortcut): only when NO surface
        // above claimed it — a village tab, an empty pane, a tree row, a tab header.
        {
          keys: [mod, "F"],
          description: "Anywhere without its own find — find in files, in this window's workspace",
        },
        { keys: ["F3"], description: "Next match in the file (Shift — previous)" },
      ],
    },
    {
      title: "Editing",
      shortcuts: [
        // ⚠️ ONE keystroke, three surfaces — so this row must not claim to be about files.
        // It used to read "Save the current file", which was already incomplete (the API
        // client's `saveActiveApiRequest` binds it too and was never listed
        // here) and became wrong when the DB console took it too. The honest general row
        // lives here, and the surface-specific SEMANTICS live in each surface's own group —
        // because "updates the query you opened, or asks for a name" is a sentence about
        // consoles, not about saving, and burying it in this row would hide it from anyone
        // reading the Database console section.
        {
          keys: [mod, "S"],
          description:
            "Save whatever has focus — the current file, the active API request, or a database console's query",
        },
        // The file editor used to have NO CodeMirror history at all,
        // so ⌘Z fell through to WebKit's own contenteditable undo — two steps deep
        // and wiped by every re-highlight. Now a real 500-deep history that survives
        // a save AND a tab close. The binding lives in a CM6 keymap because a focused
        // contenteditable absorbs the native Edit-menu key equivalent.
        { keys: [mod, "Z"], description: "Undo — survives saving the file, and closing and reopening its tab" },
        {
          keys: isMac() ? [mod, "Shift", "Z"] : [mod, "Y"],
          description: "Redo the edit you just undid",
        },
        { keys: ["Enter"], description: "Confirm an inline rename (tab / agent)" },
        {
          keys: ["F2"],
          description: "Rename the focused view in the view bar (double-click does it too)",
        },
      ],
    },
    {
      title: "Markdown preview",
      shortcuts: [
        // Real handlers in editor/MarkdownPreview (wheel/pointer) — the − / % / +
        // buttons in the editor bar drive the same store value.
        { keys: [mod, "Scroll"], description: "Zoom the rendered preview (anchored at the cursor)" },
        { keys: [mod, "Drag"], description: "Pan the zoomed preview" },
        // Search the RENDERED text, not the source. Listed here as
        // well as under Search because this is the group someone reading about
        // the preview looks at, and the row above it in Search is the general
        // one-binding-many-surfaces statement.
        {
          keys: [mod, "F"],
          description: "Search the rendered preview — highlights every match, ↑ / ↓ walk them",
        },
      ],
    },
    {
      title: "Database console",
      shortcuts: [
        { keys: [mod, "Enter"], description: "Run the statement under the cursor" },
        {
          keys: [mod, "Shift", "Enter"],
          description: "Run the whole buffer — only when the connection allows multiple statements",
        },
        {
          keys: [mod, "S"],
          description:
            "Save the query — updates the saved query you opened, or asks for a name to create one",
        },
      ],
    },
    {
      title: "Layout & general",
      shortcuts: [
        { keys: [mod, "W"], description: "Close the active tab" },
        { keys: ["Drag tab → edge"], description: "Split a pane (drop a tab on a pane edge)" },
        { keys: ["Esc"], description: "Close a panel or dialog · cancel a rename" },
        { keys: [mod, "/"], description: "Show this shortcuts reference" },
      ],
    },
  ];
}
