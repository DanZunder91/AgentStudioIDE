/**
 * Go-to-definition (M5) — Cmd/Ctrl+Click + F12.
 *
 * We do NOT reuse the library's `jumpToDefinition` command: it does not retry on
 * rust-analyzer's `-32801` "content modified" (returned until indexing finishes,
 * ~5–9 s cold), which would surface as a false "no definition." This wraps the
 * same `textDocument/definition` request with a retry loop that reflects the
 * indexing state, then navigates via the Workspace seam (`displayFile`).
 */

import { Prec, type Extension } from "@codemirror/state";
import { EditorView, keymap, type Command } from "@codemirror/view";
import { LSPPlugin } from "@codemirror/lsp-client";

import { useAppStore } from "../../../app/store";
import { hoverDefinition } from "./hoverDefinition";
import { findUsagesAt } from "./references";

interface LspPosition {
  line: number;
  character: number;
}
interface LspLocation {
  uri: string;
  range: { start: LspPosition; end: LspPosition };
}

/** Is `p` inside `range` (inclusive of both ends)? Both are LSP 0-based. */
function positionInRange(p: LspPosition, range: { start: LspPosition; end: LspPosition }): boolean {
  const afterStart =
    p.line > range.start.line || (p.line === range.start.line && p.character >= range.start.character);
  const beforeEnd =
    p.line < range.end.line || (p.line === range.end.line && p.character <= range.end.character);
  return afterStart && beforeEnd;
}

const MAX_RETRIES = 10;
const RETRY_MS = 1000;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** rust-analyzer returns -32801/-32802 (ContentModified) while still indexing. */
function isContentModified(err: unknown): boolean {
  const message = String((err as { message?: string })?.message ?? err ?? "");
  return /-3280[12]|content ?modified/i.test(message);
}

const setIndexing = (languageId: string, on: boolean) =>
  useAppStore.getState().lspActions.setLspIndexing(languageId, on);

async function requestDefinition(
  plugin: LSPPlugin,
  languageId: string,
  pos: number,
): Promise<LspLocation | LspLocation[] | null> {
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await plugin.client.request<unknown, LspLocation | LspLocation[] | null>(
        "textDocument/definition",
        { textDocument: { uri: plugin.uri }, position: plugin.toPosition(pos) },
      );
      setIndexing(languageId, false);
      return result;
    } catch (err) {
      if (isContentModified(err) && attempt < MAX_RETRIES) {
        setIndexing(languageId, true); // "indexing…", queue the retry
        await delay(RETRY_MS);
        continue;
      }
      setIndexing(languageId, false);
      throw err;
    }
  }
}

function navigate(plugin: LSPPlugin, result: LspLocation | LspLocation[] | null): void {
  const loc = Array.isArray(result) ? result[0] : result;
  if (!loc) return;
  const target =
    loc.uri === plugin.uri
      ? Promise.resolve(plugin.view)
      : plugin.client.workspace.displayFile(loc.uri);
  void target.then((view) => {
    if (!view) return;
    const anchor = plugin.fromPosition(loc.range.start, view.state.doc);
    view.dispatch({ selection: { anchor }, scrollIntoView: true, userEvent: "select.definition" });
  });
}

/**
 * Cmd/Ctrl+Click on a symbol at `pos` — the IntelliJ gesture:
 *   • on a USE → jump to the declaration;
 *   • on the DECLARATION itself (the definition resolves to where you clicked),
 *     or when there is no definition → list every usage (find-usages panel).
 * That is why clicking `fn search` shows "who calls it" rather than sitting still.
 */
export function goToDefinitionAt(view: EditorView, languageId: string, pos: number): boolean {
  const plugin = LSPPlugin.get(view);
  if (!plugin) return false;
  plugin.client.sync(); // flush didChange so the server sees the current buffer
  const clicked = plugin.toPosition(pos);
  requestDefinition(plugin, languageId, pos).then((result) => {
    const loc = Array.isArray(result) ? result[0] : result;
    if (loc && loc.uri === plugin.uri && positionInRange(clicked, loc.range)) {
      findUsagesAt(view, languageId, pos); // clicked the declaration → usages
    } else if (loc) {
      navigate(plugin, loc); // clicked a use → jump to the declaration
    } else {
      findUsagesAt(view, languageId, pos); // no definition → fall back to usages
    }
  }, (err) => plugin.reportError("Go to definition failed", err));
  return true;
}

/** F12 / Cmd-Click → go-to-definition; Shift+F12 → find usages (at the cursor). */
export function definitionNavigation(languageId: string): Extension {
  const atCursor: Command = (view) =>
    goToDefinitionAt(view, languageId, view.state.selection.main.head);
  const usagesAtCursor: Command = (view) =>
    findUsagesAt(view, languageId, view.state.selection.main.head);

  return [
    Prec.high(
      keymap.of([
        { key: "F12", run: atCursor },
        { key: "Shift-F12", run: usagesAtCursor },
      ]),
    ),
    // Cmd/Ctrl+Click navigates at the MOUSE position (not the caret).
    EditorView.domEventHandlers({
      mousedown(event, view) {
        if (!(event.metaKey || event.ctrlKey) || event.button !== 0) return false;
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos == null) return false;
        event.preventDefault();
        return goToDefinitionAt(view, languageId, pos);
      },
    }),
    // Cmd/Ctrl-hover underline — the affordance that shows a symbol is navigable.
    hoverDefinition,
  ];
}
