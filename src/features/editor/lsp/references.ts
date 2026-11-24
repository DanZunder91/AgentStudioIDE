/**
 * Find usages (M5) — `textDocument/references` → the references panel.
 *
 * Cmd/Ctrl+Click on a symbol's DECLARATION (or Shift+F12 at the cursor) lists
 * every usage. Like go-to-definition, we wrap the raw request in a retry loop for
 * rust-analyzer's -32801 "content modified" (returned until indexing finishes,
 * ~5–9 s cold), then resolve each LSP location to a source line via the scoped
 * `read_file` so the panel shows the same light code context as Find-in-Files.
 */

import type { EditorView } from "@codemirror/view";
import { LSPPlugin } from "@codemirror/lsp-client";

import { useAppStore, type ReferenceHit } from "../../../app/store";
import { relativeTo } from "../../../lib/paths";
import { readFile } from "../../workspace/workspaceIpc";
import { pathFromUri } from "./uri";

interface LspPosition {
  line: number;
  character: number;
}
interface LspLocation {
  uri: string;
  range: { start: LspPosition; end: LspPosition };
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

async function requestReferences(
  plugin: LSPPlugin,
  languageId: string,
  pos: number,
): Promise<LspLocation[] | null> {
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await plugin.client.request<unknown, LspLocation[] | null>(
        "textDocument/references",
        {
          textDocument: { uri: plugin.uri },
          position: plugin.toPosition(pos),
          context: { includeDeclaration: true },
        },
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

/**
 * `display`: path relative to the workspace root when it is under it, else absolute.
 * Separator- and (Windows) case-agnostic: the old `root + "/"` prefix never matched a
 * `C:\repo\src\main.rs`, so on Windows every usage row showed its full path.
 */
export function displayPath(abs: string, root: string | null): string {
  const rel = root ? relativeTo(root, abs) : null;
  return rel ? rel : abs;
}

/**
 * Resolve LSP locations to panel rows, reading each file ONCE for its source
 * line. A location whose file is out of scope (a dependency, std) or unreadable
 * is dropped — its rows would have no context and the read is denied anyway.
 */
async function buildHits(locations: LspLocation[], root: string | null): Promise<ReferenceHit[]> {
  const linesByPath = new Map<string, string[] | null>();
  const hits: ReferenceHit[] = [];
  for (const loc of locations) {
    const path = pathFromUri(loc.uri);
    let lines = linesByPath.get(path);
    if (lines === undefined) {
      try {
        lines = (await readFile(path)).split("\n");
      } catch {
        lines = null; // out of scope / unreadable → skip this file's rows
      }
      linesByPath.set(path, lines);
    }
    if (!lines) continue;
    const { start, end } = loc.range;
    const lineText = lines[start.line] ?? "";
    const matchStart = Math.max(0, Math.min(start.character, lineText.length));
    const matchEnd =
      end.line === start.line
        ? Math.max(matchStart, Math.min(end.character, lineText.length))
        : lineText.length;
    hits.push({
      path,
      display: displayPath(path, root),
      line: start.line + 1, // LSP is 0-based; revealInEditor is 1-based
      col: start.character + 1,
      lineText,
      matchStart,
      matchEnd,
    });
  }
  return hits;
}

/** Find every usage of the symbol at `pos` and open the references panel. */
export function findUsagesAt(view: EditorView, languageId: string, pos: number): boolean {
  const plugin = LSPPlugin.get(view);
  if (!plugin) return false;
  plugin.client.sync(); // flush didChange so the server sees the current buffer
  const word = view.state.wordAt(pos);
  const symbol = word ? view.state.sliceDoc(word.from, word.to) : "symbol";
  const { setReferences } = useAppStore.getState().lspActions;
  setReferences({ symbol, hits: [], loading: true }); // open the panel in its loading state
  const root = useAppStore.getState().workspaceRoot;
  requestReferences(plugin, languageId, pos).then(
    async (locations) => {
      const hits = await buildHits(locations ?? [], root);
      setReferences({ symbol, hits, loading: false });
    },
    (err) => {
      setReferences({ symbol, hits: [], loading: false });
      plugin.reportError("Find usages failed", err);
    },
  );
  return true;
}
