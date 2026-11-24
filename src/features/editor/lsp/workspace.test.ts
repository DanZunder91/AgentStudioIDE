/**
 * `AgentStudioWorkspace.displayFile` — where cross-file go-to-definition lands — and tab
 * tear-off: a definition in a file another OS window holds brings THAT window forward, and
 * this window must not build its own buffer for the file just to hand the LSP client a view
 * (a second copy of a file the other window is the writer of).
 *
 * The registry is mocked at its module boundary; the store and its open router are real.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const registry = vi.hoisted(() => ({
  getView: vi.fn((): object | null => null),
  whenViewReady: vi.fn(async (): Promise<object | null> => ({ view: true })),
}));
vi.mock("../EditorRegistry", () => registry);

import type { LSPClient } from "@codemirror/lsp-client";

import { routeOpensElsewhere, useAppStore } from "../../../app/store";
import { resetStore } from "../../../test/store-harness";
import { AgentStudioWorkspace } from "./workspace";

const workspace = () => new AgentStudioWorkspace({} as LSPClient);
const editorPaths = () =>
  Object.values(useAppStore.getState().tabs).flatMap((t) => (t.ref.kind === "editor" ? [t.ref.path] : []));

describe("AgentStudioWorkspace.displayFile", () => {
  beforeEach(() => resetStore());
  afterEach(() => vi.clearAllMocks());

  it("opens the file here and resolves its view", async () => {
    await expect(workspace().displayFile("file:///w/src/lib.rs")).resolves.toEqual({ view: true });
    expect(editorPaths()).toEqual(["/w/src/lib.rs"]);
    expect(registry.whenViewReady).toHaveBeenCalledWith("/w/src/lib.rs");
  });

  it("a file another window holds: no tab, no buffer here — the client gets no view", async () => {
    const off = routeOpensElsewhere(() => true);
    try {
      await expect(workspace().displayFile("file:///w/src/lib.rs")).resolves.toBeNull();
    } finally {
      off();
    }
    expect(editorPaths()).toEqual([]);
    expect(registry.whenViewReady).not.toHaveBeenCalled();
  });
});
