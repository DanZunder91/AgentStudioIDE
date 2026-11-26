/** Cheat-sheet data, the single source of truth: every entry corresponds to a real handler.
 * Adding or changing a binding updates its row in the same commit, and vice versa. */

import { os } from "../../lib/platform";

/** True on macOS/iOS — where the platform modifier is ⌘ and Cmd+W is a native menu
 *  accelerator (so the tab-close binding must go through the app menu, not keydown).
 *  A thin wrapper over `lib/platform`'s `os()`, the one OS answer for the whole UI. */
export function isMac(): boolean {
  return os() === "macos";
}

/** For words a Windows user reads (File Explorer, winget); see `lib/platform`'s `os()`. */
export function isWindows(): boolean {
  return os() === "windows";
}

/** The platform modifier label: ⌘ on macOS, Ctrl elsewhere. */
export function modKey(): string {
  return isMac() ? "⌘" : "Ctrl";
}

/** `⌘S` on macOS, `Ctrl+S` elsewhere: a hardcoded `⌘S` is a key Windows keyboards lack. */
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

/** The platform modifier is resolved at call time, so one dataset renders ⌘ or Ctrl. */
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
        { keys: [mod, "Shift", "O"], description: "Find a file by name — quick open" },
        // Same quick open (FindKeysShortcut), on the current tab's workspace in its window.
        { keys: [mod, "O"], description: "Quick open too — the same finder, without the Shift" },
        // One binding, three surfaces: editor (editor/find/bufferSearch), terminal
        // (terminal/find), rendered preview (editor/previewFind). macOS Ctrl+F stays with readline.
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
        // One keystroke, three surfaces, so this row must not claim to be about files; the
        // surface-specific semantics live in each surface's own group.
        {
          keys: [mod, "S"],
          description:
            "Save whatever has focus — the current file, the active API request, or a database console's query",
        },
        // A CM6 keymap: a focused contenteditable absorbs the native Edit-menu key equivalent.
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
        // Repeated from Search: this is the group someone reading about the preview looks at.
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
