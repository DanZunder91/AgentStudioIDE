/** Store coverage the component tests miss: protocol snapshot on save, restore on open (legacy
 * no-protocol → HTTP), save-name guard branches. `apiStoreIpc` is mocked (saves cross Tauri). */

import { beforeEach, describe, expect, it, vi } from "vitest";

const apiStoreIpc = vi.hoisted(() => ({
  loadApiStore: vi.fn(),
  saveApiStore: vi.fn(),
  readApiStore: vi.fn(),
  createApiFolder: vi.fn(),
  renameApiFolder: vi.fn(),
  deleteApiFolder: vi.fn(),
  reorderApiFolders: vi.fn(),
  moveRequestToFolder: vi.fn(),
}));
vi.mock("./apiStoreIpc", () => apiStoreIpc);

const layoutPrefsIpc = vi.hoisted(() => ({
  loadLayoutPrefs: vi.fn(),
  saveLayoutPrefs: vi.fn(),
  EMPTY_LAYOUT_PREFS: {
    folderOrder: [],
    collapsedFolders: [],
    collapsedRoots: [],
    focusFollowsAgent: false,
    collapsedApiFolders: [],
  },
}));
vi.mock("../../app/layoutPrefsIpc", () => layoutPrefsIpc);

import { useAppStore } from "../../app/store";
import { resetStore } from "../../test/store-harness";
import type { ApiStore, SavedRequest } from "./apiStoreIpc";

const api = () => useAppStore.getState().apiActions;

/** A store blob, defaulted to empty — folder tests only say what they care about. */
const store = (patch: Partial<ApiStore> = {}): ApiStore => ({
  collections: [],
  environments: [],
  activeEnvironmentId: null,
  folders: [],
  ...patch,
});

/** A saved request, defaulted — the protocol tail is irrelevant to grouping. */
const req = (id: string, folderId?: string): SavedRequest => ({
  id,
  name: `Request ${id}`,
  method: "GET",
  url: "https://api.test/x",
  headers: [],
  body: "",
  ...(folderId === undefined ? {} : { folderId }),
});

beforeEach(() => {
  resetStore();
  apiStoreIpc.saveApiStore.mockReset().mockResolvedValue(undefined);
  apiStoreIpc.loadApiStore.mockReset().mockResolvedValue(store());
  apiStoreIpc.readApiStore.mockReset().mockResolvedValue(store());
  apiStoreIpc.createApiFolder.mockReset().mockResolvedValue(store());
  apiStoreIpc.renameApiFolder.mockReset().mockResolvedValue(store());
  apiStoreIpc.deleteApiFolder.mockReset().mockResolvedValue(store());
  apiStoreIpc.reorderApiFolders.mockReset().mockResolvedValue(store());
  apiStoreIpc.moveRequestToFolder.mockReset().mockResolvedValue(store());
  layoutPrefsIpc.saveLayoutPrefs.mockReset().mockResolvedValue(undefined);
  layoutPrefsIpc.loadLayoutPrefs.mockReset().mockResolvedValue({
    ...layoutPrefsIpc.EMPTY_LAYOUT_PREFS,
  });
});

describe("saveRequestToCollection — protocol snapshot", () => {
  it("includes the gRPC tail only for a gRPC request", () => {
    const id = api().createApiRequest();
    useAppStore.setState((s) => {
      const r = s.apiRequests[id];
      r.protocol = "grpc";
      r.url = "localhost:50051";
      r.body = '{"m":1}';
      r.grpc.service = "echo.Echo";
      r.grpc.method = "Unary";
      r.grpc.plaintext = true;
    });
    api().saveRequestToCollection(id, "grpc call");
    const saved = useAppStore.getState().apiCollections[0];
    expect(saved.protocol).toBe("grpc");
    expect(saved.grpcService).toBe("echo.Echo");
    expect(saved.grpcMethod).toBe("Unary");
    expect(saved.plaintext).toBe(true);
    expect(apiStoreIpc.saveApiStore).toHaveBeenCalled();
  });

  it("omits the gRPC tail for an HTTP request", () => {
    const id = api().createApiRequest();
    api().saveRequestToCollection(id, "http call");
    const saved = useAppStore.getState().apiCollections[0];
    expect(saved.protocol).toBe("http");
    expect(saved.grpcService).toBeUndefined();
    expect(saved.grpcMethod).toBeUndefined();
    expect(saved.plaintext).toBeUndefined();
  });
});

describe("openSavedRequest", () => {
  it("returns null for an unknown id and opens no tab", () => {
    const before = Object.keys(useAppStore.getState().tabs).length;
    expect(api().openSavedRequest("nope")).toBeNull();
    expect(Object.keys(useAppStore.getState().tabs).length).toBe(before);
  });

  it("restores a gRPC save missing its tail using safe defaults", () => {
    // protocol "grpc" but no service/method/plaintext (a hand-edited or partial
    // entry) → the nullish fallbacks fill service/method "" and plaintext false.
    const partial: SavedRequest = {
      id: "g-partial",
      name: "Bare gRPC",
      method: "",
      url: "localhost:50051",
      headers: [],
      body: "",
      protocol: "grpc",
    };
    useAppStore.getState().apiActions.hydrateApiStore({
      collections: [partial],
      environments: [],
      activeEnvironmentId: null,
      folders: [],
    });
    const tabId = api().openSavedRequest("g-partial");
    const tab = useAppStore.getState().tabs[tabId!];
    const reqId = tab.ref.kind === "api-request" ? tab.ref.requestId : "";
    const req = useAppStore.getState().apiRequests[reqId];
    expect(req.protocol).toBe("grpc");
    expect(req.grpc.service).toBe("");
    expect(req.grpc.method).toBe("");
    expect(req.grpc.plaintext).toBe(false);
  });

  it("restores a legacy (no-protocol) saved request as HTTP", () => {
    const legacy: SavedRequest = {
      id: "legacy",
      name: "Old GET",
      method: "GET",
      url: "https://api.test/legacy",
      headers: [],
      body: "",
      // no protocol field — an entry saved before collections were protocol-aware
    };
    useAppStore.getState().apiActions.hydrateApiStore({
      collections: [legacy],
      environments: [],
      activeEnvironmentId: null,
      folders: [],
    });
    const tabId = api().openSavedRequest("legacy");
    expect(tabId).not.toBeNull();
    const tab = useAppStore.getState().tabs[tabId!];
    const reqId = tab.ref.kind === "api-request" ? tab.ref.requestId : "";
    expect(useAppStore.getState().apiRequests[reqId].protocol).toBe("http");
    expect(tab.customTitle).toBe("Old GET");
  });
});

describe("confirmSaveRequestName / cancelSaveRequestName — guards", () => {
  it("confirm with no pending prompt is a harmless no-op", () => {
    api().confirmSaveRequestName("whatever");
    expect(useAppStore.getState().apiCollections).toEqual([]);
    expect(useAppStore.getState().saveRequestPrompt).toBeNull();
  });

  it("confirm with an empty name clears the prompt without saving", () => {
    const id = api().createApiRequest();
    useAppStore.setState({ saveRequestPrompt: { requestId: id, tabId: id as never } });
    api().confirmSaveRequestName("   ");
    expect(useAppStore.getState().apiCollections).toEqual([]);
    expect(useAppStore.getState().saveRequestPrompt).toBeNull();
  });

  it("cancel clears a pending prompt", () => {
    const id = api().createApiRequest();
    useAppStore.setState({ saveRequestPrompt: { requestId: id, tabId: id as never } });
    api().cancelSaveRequestName();
    expect(useAppStore.getState().saveRequestPrompt).toBeNull();
  });
});

/* ═══════════════════════════ saved-request folders ═══════════════════════════ */

describe("folder actions — the commands", () => {
  it("createApiFolder trims, skips the round trip on a blank name, and hydrates the result", async () => {
    const made = store({ folders: [{ id: "f-1", name: "Widget", order: 0 }] });
    apiStoreIpc.createApiFolder.mockResolvedValue(made);

    await api().createApiFolder("  Widget  ");
    expect(apiStoreIpc.createApiFolder).toHaveBeenCalledWith("Widget");
    expect(useAppStore.getState().apiFolders).toEqual(made.folders);

    // A blank name never leaves the process: the answer is already known, and Rust
    // would only reject it after a write-lock round trip.
    apiStoreIpc.createApiFolder.mockClear();
    await api().createApiFolder("   ");
    expect(apiStoreIpc.createApiFolder).not.toHaveBeenCalled();
  });

  it("renameApiFolder trims and skips a blank name", async () => {
    const renamed = store({ folders: [{ id: "f-1", name: "Maestro", order: 0 }] });
    apiStoreIpc.renameApiFolder.mockResolvedValue(renamed);

    await api().renameApiFolder("f-1", "  Maestro  ");
    expect(apiStoreIpc.renameApiFolder).toHaveBeenCalledWith("f-1", "Maestro");
    expect(useAppStore.getState().apiFolders[0].name).toBe("Maestro");

    apiStoreIpc.renameApiFolder.mockClear();
    await api().renameApiFolder("f-1", " ");
    expect(apiStoreIpc.renameApiFolder).not.toHaveBeenCalled();
  });

  it("moveRequestToFolder passes the folder id through, and null for the root", async () => {
    await api().moveRequestToFolder("c-1", "f-1");
    expect(apiStoreIpc.moveRequestToFolder).toHaveBeenCalledWith("c-1", "f-1");
    await api().moveRequestToFolder("c-1", null);
    expect(apiStoreIpc.moveRequestToFolder).toHaveBeenLastCalledWith("c-1", null);
  });

  it("moveApiFolder sends the list `moveBefore` produced, not a hand-rolled one", async () => {
    api().hydrateApiStore(
      store({
        folders: [
          { id: "a", name: "A", order: 0 },
          { id: "b", name: "B", order: 1 },
          { id: "c", name: "C", order: 2 },
        ],
      }),
    );
    // Stand in for Rust: it applies the permutation and hands the store back in the new
    // order. Without this the second gesture below would run against a stale mirror and
    // the test would pass for the wrong reason.
    apiStoreIpc.reorderApiFolders.mockImplementation((ids: string[]) =>
      Promise.resolve(
        store({ folders: ids.map((id, i) => ({ id, name: id.toUpperCase(), order: i })) }),
      ),
    );
    // `moveBefore`'s contract: C lands right BEFORE A; asserted on the real primitive's output,
    // not a copy derived from the code under test.
    await api().moveApiFolder("c", "a");
    expect(apiStoreIpc.reorderApiFolders).toHaveBeenCalledWith(["c", "a", "b"]);

    // …and the mirror now reflects it, so the next gesture starts from c,a,b.
    expect(useAppStore.getState().apiFolders.map((f) => f.id)).toEqual(["c", "a", "b"]);

    // `null` means "to the end" — the other half of the primitive's contract.
    await api().moveApiFolder("a", null);
    expect(apiStoreIpc.reorderApiFolders).toHaveBeenLastCalledWith(["c", "b", "a"]);
  });

  it("🔴 deleting a folder keeps its saved requests — they come back to the root", async () => {
    api().hydrateApiStore(
      store({
        collections: [req("c-1", "f-1"), req("c-2", "f-1"), req("c-3")],
        folders: [{ id: "f-1", name: "Widget", order: 0 }],
      }),
    );
    // What Rust returns after `delete_folder`: no folder, all three requests, none filed.
    apiStoreIpc.deleteApiFolder.mockResolvedValue(
      store({ collections: [req("c-1"), req("c-2"), req("c-3")] }),
    );

    await api().deleteApiFolder("f-1");

    const s = useAppStore.getState();
    expect(s.apiFolders).toEqual([]);
    expect(s.apiCollections).toHaveLength(3);
    expect(s.apiCollections.every((c) => c.folderId === undefined)).toBe(true);
  });

  it("deleting a folder drops its collapse entry and re-persists the prefs", async () => {
    api().hydrateApiStore(store({ folders: [{ id: "f-1", name: "W", order: 0 }] }));
    api().toggleApiFolderCollapsed("f-1");
    expect(useAppStore.getState().collapsedApiFolders.has("f-1")).toBe(true);

    await api().deleteApiFolder("f-1");
    expect(useAppStore.getState().collapsedApiFolders.has("f-1")).toBe(false);
    // The last persist must not still be carrying the dead id.
    const last = layoutPrefsIpc.saveLayoutPrefs.mock.calls.at(-1)![0] as {
      collapsedApiFolders: string[];
    };
    expect(last.collapsedApiFolders).toEqual([]);
  });

  it("a failed command leaves the mirror exactly as it was", async () => {
    const seeded = store({ folders: [{ id: "f-1", name: "Widget", order: 0 }] });
    api().hydrateApiStore(seeded);
    // `null` is how the IPC wrapper says "the command failed" (it never throws into a
    // React event handler). The rail must keep showing what is really on disk.
    apiStoreIpc.createApiFolder.mockResolvedValue(null);
    apiStoreIpc.renameApiFolder.mockResolvedValue(null);
    apiStoreIpc.deleteApiFolder.mockResolvedValue(null);
    apiStoreIpc.moveRequestToFolder.mockResolvedValue(null);
    apiStoreIpc.reorderApiFolders.mockResolvedValue(null);

    await api().createApiFolder("Nope");
    await api().renameApiFolder("f-1", "Nope");
    await api().deleteApiFolder("f-1");
    await api().moveRequestToFolder("c-1", "f-1");
    await api().moveApiFolder("f-1", null);

    expect(useAppStore.getState().apiFolders).toEqual(seeded.folders);
  });
});

describe("collapse state — persisted in layout prefs, not in the Vault", () => {
  it("toggles on and off and persists each way", () => {
    api().toggleApiFolderCollapsed("f-1");
    expect(useAppStore.getState().collapsedApiFolders.has("f-1")).toBe(true);
    expect(
      (layoutPrefsIpc.saveLayoutPrefs.mock.calls.at(-1)![0] as { collapsedApiFolders: string[] })
        .collapsedApiFolders,
    ).toEqual(["f-1"]);

    api().toggleApiFolderCollapsed("f-1");
    expect(useAppStore.getState().collapsedApiFolders.has("f-1")).toBe(false);
    expect(
      (layoutPrefsIpc.saveLayoutPrefs.mock.calls.at(-1)![0] as { collapsedApiFolders: string[] })
        .collapsedApiFolders,
    ).toEqual([]);
  });

  it("is seeded from the persisted prefs, and an older prefs file (no key) is empty", () => {
    useAppStore.getState().workspaceActions.applyLayoutPrefs({
      folderOrder: [],
      collapsedFolders: [],
      collapsedRoots: [],
      collapsedApiFolders: ["f-1", "f-2"],
    });
    expect([...useAppStore.getState().collapsedApiFolders]).toEqual(["f-1", "f-2"]);

    useAppStore.getState().workspaceActions.applyLayoutPrefs({
      folderOrder: [],
      collapsedFolders: [],
      collapsedRoots: [],
      // …written by a build from before folders existed: the key is simply absent.
    });
    expect([...useAppStore.getState().collapsedApiFolders]).toEqual([]);
  });
});

describe("🔴 the blob save must carry the folders", () => {
  it("deleting a saved request does not take the folders with it", () => {
    api().hydrateApiStore(
      store({
        collections: [req("c-1"), req("c-2", "f-1")],
        folders: [{ id: "f-1", name: "Widget", order: 0 }],
      }),
    );
    api().deleteCollection("c-1");

    // `saveApiStore` REPLACES the file with this object. A missing `folders` key would
    // not error — it is `#[serde(default)]` in Rust — it would deserialize as `[]` and
    // silently delete every folder the user made, on an unrelated gesture.
    const written = apiStoreIpc.saveApiStore.mock.calls.at(-1)![0] as ApiStore;
    expect(written.folders).toEqual([{ id: "f-1", name: "Widget", order: 0 }]);
    expect(written.collections.map((c) => c.id)).toEqual(["c-2"]);
  });
});
