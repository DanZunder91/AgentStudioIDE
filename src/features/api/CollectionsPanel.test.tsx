/** CollectionsPanel with `apiStoreIpc` mocked at the module boundary (load/persist cross Tauri). */

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import { fireDragLeave, makeDataTransfer } from "../../test/dnd";
import { useAppStore } from "../../app/store";
import { resetStore } from "../../test/store-harness";
import {
  API_FOLDER_DND_MIME,
  CollectionsPanel,
  REQUEST_DND_MIME,
  apiFolderIdType,
} from "./CollectionsPanel";
import type { ApiFolder, ApiStore, SavedRequest } from "./apiStoreIpc";

const httpReq: SavedRequest = {
  id: "c-http",
  name: "Get user",
  method: "POST",
  url: "https://api.test/user",
  headers: [{ name: "Authorization", value: "Bearer {{TOKEN}}" }],
  body: '{"q":1}',
  protocol: "http",
};
const wsReq: SavedRequest = {
  id: "c-ws",
  name: "Live feed",
  method: "GET",
  url: "wss://api.test/stream",
  headers: [],
  body: "",
  protocol: "ws",
};
const grpcReq: SavedRequest = {
  id: "c-grpc",
  name: "Echo unary",
  method: "",
  url: "localhost:50051",
  headers: [{ name: "authorization", value: "Bearer {{TOKEN}}" }],
  body: '{"msg":"hi"}',
  protocol: "grpc",
  grpcService: "echo.Echo",
  grpcMethod: "Unary",
  plaintext: true,
};

const store = (collections: SavedRequest[], folders: ApiFolder[] = []): ApiStore => ({
  collections,
  environments: [],
  activeEnvironmentId: null,
  folders,
});

/** `httpReq`, filed into a folder. */
const filed = (folderId: string): SavedRequest => ({ ...httpReq, folderId });

const WIDGET: ApiFolder = { id: "f-widget", name: "Widget", order: 0 };
const MAESTRO: ApiFolder = { id: "f-maestro", name: "Maestro", order: 1 };

beforeEach(() => {
  resetStore();
  apiStoreIpc.loadApiStore.mockReset().mockResolvedValue(store([]));
  apiStoreIpc.saveApiStore.mockReset().mockResolvedValue(undefined);
  apiStoreIpc.readApiStore.mockReset().mockResolvedValue(store([]));
  apiStoreIpc.createApiFolder.mockReset().mockResolvedValue(store([], [WIDGET]));
  apiStoreIpc.renameApiFolder.mockReset().mockResolvedValue(store([], [WIDGET]));
  apiStoreIpc.deleteApiFolder.mockReset().mockResolvedValue(store([httpReq]));
  apiStoreIpc.reorderApiFolders.mockReset().mockResolvedValue(store([], [MAESTRO, WIDGET]));
  apiStoreIpc.moveRequestToFolder
    .mockReset()
    .mockResolvedValue(store([filed(WIDGET.id)], [WIDGET]));
  layoutPrefsIpc.saveLayoutPrefs.mockReset().mockResolvedValue(undefined);
  layoutPrefsIpc.loadLayoutPrefs.mockReset().mockResolvedValue({
    ...layoutPrefsIpc.EMPTY_LAYOUT_PREFS,
  });
});
afterEach(() => cleanup());

describe("CollectionsPanel", () => {
  it("hydrates once on mount and shows the empty state when there are none", async () => {
    await act(async () => {
      render(<CollectionsPanel />);
    });
    expect(apiStoreIpc.loadApiStore).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().apiStoreLoaded).toBe(true);
    expect(screen.getByTestId("collections-empty")).toBeInTheDocument();
  });

  it("names the save chord with the platform's modifier — Ctrl on Windows, ⌘ on macOS", async () => {
    const ua = vi.spyOn(navigator, "userAgent", "get");
    ua.mockReturnValue("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(<CollectionsPanel />);
    });
    expect(screen.getByTestId("collections-empty")).toHaveTextContent("press Ctrl+S to save it here");
    expect(screen.getByTestId("collections-panel")).toHaveTextContent("save the active request with Ctrl+S");
    expect(screen.getByTestId("collections-panel")).not.toHaveTextContent("⌘");
    view.unmount();

    ua.mockReturnValue("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)");
    await act(async () => {
      render(<CollectionsPanel />);
    });
    expect(screen.getByTestId("collections-empty")).toHaveTextContent("press ⌘+S to save it here");
    expect(screen.getByTestId("collections-panel")).not.toHaveTextContent("Ctrl");
    ua.mockRestore();
  });

  it("skips the load when the store is already hydrated", async () => {
    act(() => {
      useAppStore.getState().apiActions.hydrateApiStore(store([httpReq]));
    });
    await act(async () => {
      render(<CollectionsPanel />);
    });
    expect(apiStoreIpc.loadApiStore).not.toHaveBeenCalled();
    expect(screen.getByTestId("collections-list")).toBeInTheDocument();
  });

  it("renders a protocol-aware badge + subtitle per saved request", async () => {
    // Row 4 is a LEGACY entry (no protocol, empty method) → the badge falls back to
    // "GET" and the class to api-proto--http.
    const legacyReq: SavedRequest = {
      id: "c-legacy",
      name: "Legacy",
      method: "",
      url: "https://api.test/legacy",
      headers: [],
      body: "",
    };
    apiStoreIpc.loadApiStore.mockResolvedValue(
      store([httpReq, wsReq, grpcReq, legacyReq]),
    );
    await act(async () => {
      render(<CollectionsPanel />);
    });
    const rows = screen.getAllByTestId("collections-row");
    expect(rows).toHaveLength(4);
    // HTTP → the method badge; WS → "WS"; gRPC → "gRPC"; legacy → "GET" fallback.
    expect(within(rows[0]).getByText("POST")).toBeInTheDocument();
    expect(within(rows[1]).getByText("WS")).toBeInTheDocument();
    expect(within(rows[2]).getByText("gRPC")).toBeInTheDocument();
    expect(within(rows[3]).getByText("GET")).toBeInTheDocument();
    expect(within(rows[3]).getByText("GET")).toHaveClass("api-proto--http");
    // gRPC subtitle carries service/method after the endpoint.
    expect(
      within(rows[2]).getByText("localhost:50051 · echo.Echo/Unary"),
    ).toBeInTheDocument();
  });

  it("opens a saved gRPC request in a new tab restored to the gRPC surface, titled by name", async () => {
    apiStoreIpc.loadApiStore.mockResolvedValue(store([grpcReq]));
    await act(async () => {
      render(<CollectionsPanel />);
    });
    act(() => {
      fireEvent.click(screen.getByText("Echo unary"));
    });

    const s = useAppStore.getState();
    // A new api-request tab opened, titled by the saved name.
    const tab = Object.values(s.tabs).find(
      (t) => t.ref.kind === "api-request",
    );
    expect(tab).toBeDefined();
    expect(tab!.customTitle).toBe("Echo unary");
    // …and the request was restored to gRPC with its selection + transport.
    const reqId = tab!.ref.kind === "api-request" ? tab!.ref.requestId : "";
    const req = s.apiRequests[reqId];
    expect(req.protocol).toBe("grpc");
    expect(req.grpc.service).toBe("echo.Echo");
    expect(req.grpc.method).toBe("Unary");
    expect(req.grpc.plaintext).toBe(true);
    expect(req.body).toBe('{"msg":"hi"}');
  });

  it("deletes a saved request", async () => {
    apiStoreIpc.loadApiStore.mockResolvedValue(store([httpReq]));
    await act(async () => {
      render(<CollectionsPanel />);
    });
    expect(screen.getByText("Get user")).toBeInTheDocument();
    act(() => {
      fireEvent.click(screen.getByLabelText("Delete Get user"));
    });
    expect(useAppStore.getState().apiCollections).toEqual([]);
    expect(screen.getByTestId("collections-empty")).toBeInTheDocument();
  });

  it("drops a late load after unmount (cancelled guard)", async () => {
    let resolve: (s: ApiStore) => void = () => {};
    apiStoreIpc.loadApiStore.mockReturnValue(
      new Promise<ApiStore>((r) => {
        resolve = r;
      }),
    );
    const { unmount } = render(<CollectionsPanel />);
    unmount();
    await act(async () => {
      resolve(store([httpReq]));
    });
    // The late resolve must not hydrate after unmount.
    expect(useAppStore.getState().apiStoreLoaded).toBe(false);
  });
});

/* ═══════════════════════════ saved-request folders ═══════════════════════════ */

describe("CollectionsPanel — folders", () => {
  /** Render with the store already hydrated (skips the mount load). */
  const renderWith = async (s: ApiStore) => {
    act(() => {
      useAppStore.getState().apiActions.hydrateApiStore(s);
    });
    await act(async () => {
      render(<CollectionsPanel />);
    });
  };

  it("🔴 shows a folder with its requests, and leaves un-filed ones on the root", async () => {
    // The rule: what already exists goes on the root. `wsReq` and `grpcReq`
    // carry no `folderId` — which is every request saved before folders existed.
    await renderWith(store([filed(WIDGET.id), wsReq, grpcReq], [WIDGET]));

    const folder = screen.getByTestId("collections-folder");
    expect(within(folder).getByText("Widget")).toBeInTheDocument();
    expect(within(folder).getByText("1")).toBeInTheDocument();
    expect(
      within(screen.getByTestId("collections-folder-body")).getAllByTestId(
        "collections-row",
      ),
    ).toHaveLength(1);

    const root = screen.getByTestId("collections-root");
    const rootNames = within(root)
      .getAllByTestId("collections-row")
      .map((li) => li.textContent);
    expect(rootNames).toHaveLength(2);
    expect(rootNames.join(" ")).toContain("Live feed");
    expect(rootNames.join(" ")).toContain("Echo unary");
    // …and the filed one is NOT duplicated at the root.
    expect(rootNames.join(" ")).not.toContain("Get user");
  });

  it("a request pointing at a folder that no longer exists still shows, at the root", async () => {
    // A saved request must never be invisible: "not in any section" is
    // indistinguishable from "deleted" to the person looking at the rail.
    await renderWith(store([filed("f-ghost")], [WIDGET]));
    expect(
      within(screen.getByTestId("collections-root")).getAllByTestId("collections-row"),
    ).toHaveLength(1);
  });

  it("collapses and expands a folder, and persists the disclosure", async () => {
    await renderWith(store([filed(WIDGET.id)], [WIDGET]));
    expect(screen.getByTestId("collections-folder-body")).toBeInTheDocument();

    act(() => {
      fireEvent.click(screen.getByLabelText("Collapse Widget"));
    });
    expect(screen.queryByTestId("collections-folder-body")).not.toBeInTheDocument();
    // Persisted in layout-prefs.json — NOT in api-store.json (the Vault).
    const written = layoutPrefsIpc.saveLayoutPrefs.mock.calls.at(-1)![0] as {
      collapsedApiFolders: string[];
    };
    expect(written.collapsedApiFolders).toEqual([WIDGET.id]);
    expect(apiStoreIpc.saveApiStore).not.toHaveBeenCalled();

    act(() => {
      fireEvent.click(screen.getByLabelText("Expand Widget"));
    });
    expect(screen.getByTestId("collections-folder-body")).toBeInTheDocument();
  });

  it("creates a folder from the header box, and Escape abandons it", async () => {
    await renderWith(store([httpReq]));

    act(() => {
      fireEvent.click(screen.getByText("+ New folder"));
    });
    const box = screen.getByLabelText("New folder name");
    act(() => {
      fireEvent.change(box, { target: { value: "Widget" } });
      fireEvent.keyDown(box, { key: "Enter" });
    });
    await act(async () => {});
    expect(apiStoreIpc.createApiFolder).toHaveBeenCalledWith("Widget");
    expect(screen.getByText("Widget")).toBeInTheDocument();

    apiStoreIpc.createApiFolder.mockClear();
    act(() => {
      fireEvent.click(screen.getByText("+ New folder"));
    });
    const second = screen.getByLabelText("New folder name");
    act(() => {
      fireEvent.change(second, { target: { value: "Abandoned" } });
      fireEvent.keyDown(second, { key: "Escape" });
    });
    expect(apiStoreIpc.createApiFolder).not.toHaveBeenCalled();
    expect(screen.getByText("+ New folder")).toBeInTheDocument();
  });

  it("renames a folder on Enter, and Escape leaves the name alone", async () => {
    apiStoreIpc.renameApiFolder.mockResolvedValue(
      store([], [{ ...WIDGET, name: "Maestro" }]),
    );
    await renderWith(store([], [WIDGET]));

    act(() => {
      fireEvent.click(screen.getByLabelText("Rename folder Widget"));
    });
    const box = screen.getByLabelText("Rename Widget");
    act(() => {
      fireEvent.change(box, { target: { value: "Maestro" } });
      fireEvent.keyDown(box, { key: "Escape" });
    });
    expect(apiStoreIpc.renameApiFolder).not.toHaveBeenCalled();

    act(() => {
      fireEvent.click(screen.getByLabelText("Rename folder Widget"));
    });
    const again = screen.getByLabelText("Rename Widget");
    act(() => {
      fireEvent.change(again, { target: { value: "Maestro" } });
      fireEvent.keyDown(again, { key: "Enter" });
    });
    await act(async () => {});
    expect(apiStoreIpc.renameApiFolder).toHaveBeenCalledWith(WIDGET.id, "Maestro");
    expect(screen.getByText("Maestro")).toBeInTheDocument();
  });

  it("commits a NEW folder on blur too (clicking away is not a cancel)", async () => {
    await renderWith(store([httpReq]));
    act(() => {
      fireEvent.click(screen.getByText("+ New folder"));
    });
    const box = screen.getByLabelText("New folder name");
    act(() => {
      fireEvent.change(box, { target: { value: "Widget" } });
      fireEvent.blur(box);
    });
    await act(async () => {});
    expect(apiStoreIpc.createApiFolder).toHaveBeenCalledWith("Widget");
  });

  it("commits a rename on blur (clicking away is not a cancel)", async () => {
    await renderWith(store([], [WIDGET]));
    act(() => {
      fireEvent.click(screen.getByLabelText("Rename folder Widget"));
    });
    const box = screen.getByLabelText("Rename Widget");
    act(() => {
      fireEvent.change(box, { target: { value: "Renamed" } });
      fireEvent.blur(box);
    });
    await act(async () => {});
    expect(apiStoreIpc.renameApiFolder).toHaveBeenCalledWith(WIDGET.id, "Renamed");
  });

  it("🔴 deleting a folder keeps its saved request — the row is still there, at the root", async () => {
    await renderWith(store([filed(WIDGET.id)], [WIDGET]));
    expect(screen.getByText("Get user")).toBeInTheDocument();

    act(() => {
      fireEvent.click(screen.getByLabelText("Delete folder Widget"));
    });
    await act(async () => {});

    expect(apiStoreIpc.deleteApiFolder).toHaveBeenCalledWith(WIDGET.id);
    expect(screen.queryByTestId("collections-folder")).not.toBeInTheDocument();
    // The request is STILL LISTED, now on the root. This is the assertion that would
    // fail if the delete ever became a cascade.
    expect(
      within(screen.getByTestId("collections-root")).getAllByTestId("collections-row"),
    ).toHaveLength(1);
    expect(screen.getByText("Get user")).toBeInTheDocument();
  });

  it("drags a saved request into a folder", async () => {
    await renderWith(store([httpReq], [WIDGET]));
    const row = within(screen.getByTestId("collections-root")).getByTestId(
      "collections-row",
    );
    // The row's own `dragStart` is what puts the id on the wire — asserted on a fresh,
    // empty transfer so this proves the handler wrote it rather than the fixture.
    const written = makeDataTransfer();
    act(() => {
      fireEvent.dragStart(row, { dataTransfer: written });
    });
    expect(written.getData(REQUEST_DND_MIME)).toBe(httpReq.id);

    // …and the drop is driven with a pre-populated transfer, because `makeDataTransfer`
    // snapshots `types` at construction (a real DataTransfer recomputes it on setData),
    // and `types` is exactly what the drop guard reads.
    const dt = makeDataTransfer({ [REQUEST_DND_MIME]: httpReq.id });
    const folder = screen.getByTestId("collections-folder");
    act(() => {
      fireEvent.dragOver(folder, { dataTransfer: dt });
      fireEvent.drop(folder, { dataTransfer: dt });
    });
    await act(async () => {});
    expect(apiStoreIpc.moveRequestToFolder).toHaveBeenCalledWith(httpReq.id, WIDGET.id);
    // …and the row moved: the folder body holds it, the root does not.
    expect(
      within(screen.getByTestId("collections-folder-body")).getAllByTestId(
        "collections-row",
      ),
    ).toHaveLength(1);
    expect(
      within(screen.getByTestId("collections-root")).queryAllByTestId("collections-row"),
    ).toHaveLength(0);
  });

  it("drags a request back out to the root", async () => {
    apiStoreIpc.moveRequestToFolder.mockResolvedValue(store([httpReq], [WIDGET]));
    await renderWith(store([filed(WIDGET.id)], [WIDGET]));

    const row = within(screen.getByTestId("collections-folder-body")).getByTestId(
      "collections-row",
    );
    const written = makeDataTransfer();
    act(() => {
      fireEvent.dragStart(row, { dataTransfer: written });
    });
    expect(written.getData(REQUEST_DND_MIME)).toBe(httpReq.id);

    const dt = makeDataTransfer({ [REQUEST_DND_MIME]: httpReq.id });
    act(() => {
      fireEvent.dragOver(screen.getByTestId("collections-root"), { dataTransfer: dt });
      fireEvent.drop(screen.getByTestId("collections-root"), { dataTransfer: dt });
    });
    await act(async () => {});
    // `null` — not the empty string, not "root". The wire contract is Option<String>.
    expect(apiStoreIpc.moveRequestToFolder).toHaveBeenCalledWith(httpReq.id, null);
  });

  it("reorders folders by dropping one on another, and refuses a self-drop", async () => {
    await renderWith(store([], [WIDGET, MAESTRO]));
    const [widget, maestro] = screen.getAllByTestId("collections-folder");

    // The header's `dragStart` writes BOTH the payload and the self-marker type — the
    // marker is the only thing a `dragover` can read (values are protected until drop),
    // so without it a folder could be dropped on itself.
    const written = makeDataTransfer();
    act(() => {
      fireEvent.dragStart(maestro.querySelector(".api-folder__head")!, {
        dataTransfer: written,
      });
    });
    expect(written.getData(API_FOLDER_DND_MIME)).toBe(MAESTRO.id);
    expect(written.types).toContain(apiFolderIdType(MAESTRO.id));

    // Drag Maestro onto Widget → Maestro lands before Widget.
    const dt = makeDataTransfer({
      [API_FOLDER_DND_MIME]: MAESTRO.id,
      [apiFolderIdType(MAESTRO.id)]: "",
    });
    act(() => {
      fireEvent.dragOver(widget, { dataTransfer: dt });
      fireEvent.drop(widget, { dataTransfer: dt });
    });
    await act(async () => {});
    expect(apiStoreIpc.reorderApiFolders).toHaveBeenCalledWith([MAESTRO.id, WIDGET.id]);

    // A folder dropped on ITSELF is a no-op — `moveBefore(list, x, x)` would otherwise
    // send it to the end, which is a reorder the user did not ask for. The self-marker
    // is what the guard reads; the payload alone would look like a legitimate drop.
    apiStoreIpc.reorderApiFolders.mockClear();
    act(() => {
      fireEvent.dragOver(maestro, { dataTransfer: dt });
      fireEvent.drop(maestro, { dataTransfer: dt });
    });
    await act(async () => {});
    expect(apiStoreIpc.reorderApiFolders).not.toHaveBeenCalled();
    expect(maestro.className).not.toContain("api-folder--drop");
  });

  it("ignores a drag that carries neither payload, and clears the highlight on leave", async () => {
    await renderWith(store([httpReq], [WIDGET]));
    const folder = screen.getByTestId("collections-folder");
    const junk = makeDataTransfer({ "text/plain": "not ours" });

    act(() => {
      fireEvent.dragOver(folder, { dataTransfer: junk });
      fireEvent.drop(folder, { dataTransfer: junk });
      fireEvent.dragOver(screen.getByTestId("collections-root"), { dataTransfer: junk });
      fireEvent.drop(screen.getByTestId("collections-root"), { dataTransfer: junk });
    });
    await act(async () => {});
    expect(apiStoreIpc.moveRequestToFolder).not.toHaveBeenCalled();
    expect(apiStoreIpc.reorderApiFolders).not.toHaveBeenCalled();
    expect(folder.className).not.toContain("api-folder--drop");

    // The highlight goes on for a real drag and comes off again when it leaves.
    const dt = makeDataTransfer({ [REQUEST_DND_MIME]: httpReq.id });
    act(() => {
      fireEvent.dragOver(folder, { dataTransfer: dt });
    });
    expect(folder.className).toContain("api-folder--drop");
    // `fireDragLeave`, not `fireEvent.dragLeave`: RTL's plain-Event fallback silently
    // DROPS `relatedTarget`, which would make the guard below see `null` and always take
    // the "really left" branch — green without ever exercising it (src/test/dnd.ts).
    act(() => {
      fireDragLeave(folder, document.body);
    });
    expect(folder.className).not.toContain("api-folder--drop");
    // A dragleave onto a CHILD of the row is not a leave (the row is still the target).
    act(() => {
      fireEvent.dragOver(folder, { dataTransfer: dt });
      fireDragLeave(folder, screen.getByTestId("collections-folder-body"));
    });
    expect(folder.className).toContain("api-folder--drop");
  });

  it("an empty folder says so, and the empty root invites a drop back", async () => {
    await renderWith(store([filed(WIDGET.id)], [WIDGET]));
    expect(screen.getByTestId("collections-root-hint")).toBeInTheDocument();

    await renderWith(store([], [WIDGET]));
    expect(screen.getAllByText("Empty — drag a saved request here.").length).toBeGreaterThan(0);
  });

  it("a folder alone is not the empty state — the panel must still render it", async () => {
    await renderWith(store([], [WIDGET]));
    expect(screen.queryByTestId("collections-empty")).not.toBeInTheDocument();
    expect(screen.getByTestId("collections-folders")).toBeInTheDocument();
  });

  it("shows the root drop highlight and clears it", async () => {
    await renderWith(store([httpReq], [WIDGET]));
    const root = screen.getByTestId("collections-root");
    const dt = makeDataTransfer({ [REQUEST_DND_MIME]: httpReq.id });
    act(() => {
      fireEvent.dragOver(root, { dataTransfer: dt });
    });
    expect(root.className).toContain("api-collections--drop");
    act(() => {
      fireEvent.dragLeave(root, { dataTransfer: dt });
    });
    expect(root.className).not.toContain("api-collections--drop");
  });
});

describe("CollectionsPanel — a drag whose payload type is present but EMPTY", () => {
  /** A `dataTransfer` type can carry an empty value (our `apiFolderIdType` marker); acting on ""
   * would file a request under `""` or reorder a missing folder. */
  const renderWith = async (s: ApiStore) => {
    act(() => {
      useAppStore.getState().apiActions.hydrateApiStore(s);
    });
    await act(async () => {
      render(<CollectionsPanel />);
    });
  };

  it("does nothing for an empty request id, on a folder and on the root", async () => {
    await renderWith(store([httpReq], [WIDGET]));
    const empty = makeDataTransfer({ [REQUEST_DND_MIME]: "" });
    act(() => {
      fireEvent.drop(screen.getByTestId("collections-folder"), { dataTransfer: empty });
      fireEvent.drop(screen.getByTestId("collections-root"), { dataTransfer: empty });
    });
    await act(async () => {});
    expect(apiStoreIpc.moveRequestToFolder).not.toHaveBeenCalled();
  });

  it("does nothing for an empty folder id", async () => {
    await renderWith(store([], [WIDGET, MAESTRO]));
    const empty = makeDataTransfer({ [API_FOLDER_DND_MIME]: "" });
    act(() => {
      fireEvent.drop(screen.getAllByTestId("collections-folder")[0], {
        dataTransfer: empty,
      });
    });
    await act(async () => {});
    expect(apiStoreIpc.reorderApiFolders).not.toHaveBeenCalled();
  });
});
