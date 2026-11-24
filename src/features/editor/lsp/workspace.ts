/**
 * The `@codemirror/lsp-client` Workspace host (M5).
 *
 * Maps the client's cross-file seam onto our editor:
 *   • `openFile`/`closeFile` → track the file + `didOpen`/`didClose`.
 *   • `syncFiles` → forward the plugin's accumulated edits as `didChange`.
 *   • `displayFile(uri)` → `openEditorTab(path)` + resolve the target view (the
 *     go-to-definition landing point for a symbol in another file).
 *   • `requestFile(uri)` → the scoped `read_file` (used by reference previews;
 *     kept behind the security scope so a server can't escape it).
 */

import { type ChangeSet, Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { LSPPlugin, Workspace, type WorkspaceFile } from "@codemirror/lsp-client";

/** `WorkspaceFileUpdate` — not exported by the lib, so mirror it structurally. */
interface FileUpdate {
  file: WorkspaceFile;
  prevDoc: Text;
  changes: ChangeSet;
}

import { TAB_ELSEWHERE, useAppStore } from "../../../app/store";
import { detectLanguage } from "../../../lib/language";
import { readFile } from "../../workspace/workspaceIpc";
import { getView, whenViewReady } from "../EditorRegistry";
import { pathFromUri } from "./uri";

class OpenFile implements WorkspaceFile {
  version = 1;
  doc: Text;
  constructor(
    readonly uri: string,
    readonly languageId: string,
    private view: EditorView | null,
  ) {
    this.doc = view ? view.state.doc : Text.empty;
  }
  getView(): EditorView | null {
    return this.view;
  }
}

export class AgentStudioWorkspace extends Workspace {
  files: WorkspaceFile[] = [];

  getFile(uri: string): WorkspaceFile | null {
    return this.files.find((f) => f.uri === uri) ?? null;
  }

  openFile(uri: string, languageId: string, view: EditorView): void {
    if (this.getFile(uri)) return; // one editor per file
    const file = new OpenFile(uri, languageId, view);
    this.files.push(file);
    this.client.didOpen(file);
  }

  closeFile(uri: string): void {
    const i = this.files.findIndex((f) => f.uri === uri);
    if (i < 0) return;
    this.files.splice(i, 1);
    this.client.didClose(uri);
  }

  syncFiles(): readonly FileUpdate[] {
    const updates: FileUpdate[] = [];
    for (const file of this.files) {
      const view = file.getView();
      if (!view) continue;
      const plugin = LSPPlugin.get(view);
      if (!plugin || plugin.unsyncedChanges.empty) continue;
      const changes = plugin.unsyncedChanges;
      const prevDoc = file.doc;
      (file as OpenFile).version += 1;
      (file as OpenFile).doc = view.state.doc;
      plugin.clear();
      updates.push({ file, prevDoc, changes });
    }
    return updates;
  }

  async displayFile(uri: string): Promise<EditorView | null> {
    const path = pathFromUri(uri);
    // Held by another OS window (tab tear-off): brought forward there, and no buffer here.
    if (useAppStore.getState().layoutActions.openEditorTab(path) === TAB_ELSEWHERE) return null;
    return getView(path) ?? whenViewReady(path);
  }

  async requestFile(uri: string): Promise<WorkspaceFile | null> {
    const open = this.getFile(uri);
    if (open) return open;
    const path = pathFromUri(uri);
    try {
      const text = await readFile(path);
      const file = new OpenFile(uri, detectLanguage(path), null);
      file.doc = Text.of(text.split("\n"));
      return file;
    } catch {
      return null; // out of scope / unreadable → the server just gets no file
    }
  }
}
