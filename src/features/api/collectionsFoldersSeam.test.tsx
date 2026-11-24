/**
 * 🔴 SEAM test — the Collections rail's folders, driven end to end.
 *
 * This is **not** a unit test and must not be turned into one. Everything below it is
 * real: the panel's DOM, its drag handlers, the store actions, `apiStoreIpc`'s typed
 * wrappers, and the `invoke()` argument shapes. The ONLY thing mocked is the outer
 * boundary — the Tauri IPC bridge itself, standing in for the Rust commands in
 * `src-tauri/src/api_store.rs`.
 *
 * It exists because that is exactly where this feature can be 100%-covered on both
 * sides and still not work. Two earlier defects had the same shape:
 * a fully-tested button passing `cwd: null` to a fully-tested command that rejects it,
 * and a fully-tested `db-console` tab with no `case` in `Pane.tsx`'s switch. Here the
 * joins that no unit test owns are:
 *   • the command NAMES (`api_folder_create`, `api_request_move`, …),
 *   • the ARGUMENT KEYS Tauri deserializes into the Rust signatures (`requestId` →
 *     `request_id`, `folderId` → `folder_id`, `ids`, `name`, `id`),
 *   • that `null` — not `""`, not `"root"` — is how "put it at the root" crosses,
 *   • and that what Rust returns re-hydrates the rail, rather than being dropped on
 *     the floor while the UI keeps showing a stale grouping.
 *
 * The Rust handlers below are deliberately *behavioural* stand-ins (they mutate a
 * store the way `api_store.rs` does) rather than constant returns, because a constant
 * return would let a wrong argument key pass unnoticed.
 *
 * FALSIFIED: each assertion here was watched go red before being trusted (a seam test never
 * seen red proves nothing).
 */

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Only the layout-prefs IPC is stubbed out — collapse state is a different file's
// concern (`layout-prefs.json`) and would otherwise need a second set of handlers to
// say nothing about the seam under test.
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

import { makeDataTransfer } from "../../test/dnd";
import { resetStore } from "../../test/store-harness";
import { installTauriMock, type TauriMock } from "../../test/tauri-mock";
import {
  API_FOLDER_DND_MIME,
  CollectionsPanel,
  REQUEST_DND_MIME,
  apiFolderIdType,
} from "./CollectionsPanel";
import type { ApiStore, SavedRequest } from "./apiStoreIpc";

/** Installed per test: `reset()` uninstalls the bridge, so it is re-installed here. */
let ipc: TauriMock;

/** The "file on disk" these handlers read and write, exactly as Rust does. */
let disk: ApiStore;

const req = (id: string, name: string): SavedRequest => ({
  id,
  name,
  method: "GET",
  url: `https://api.test/${id}`,
  headers: [],
  body: "",
  protocol: "http",
});

/**
 * The Rust commands, standing in for `api_store.rs`. Each handler does what its
 * Rust counterpart does — load, mutate, save, return the WHOLE store — reading the
 * SNAKE_CASE argument names Tauri produces from the camelCase the frontend sends.
 */
function installRustLane(): void {
  ipc.handle("api_store_load", () => disk);
  ipc.handle("api_store_save", (args) => {
    disk = args.store as ApiStore;
    return null;
  });
  ipc.handle("api_folder_create", (args) => {
    disk = {
      ...disk,
      folders: [
        ...disk.folders,
        { id: `f-${disk.folders.length + 1}`, name: args.name as string, order: disk.folders.length },
      ],
    };
    return disk;
  });
  ipc.handle("api_folder_rename", (args) => {
    disk = {
      ...disk,
      folders: disk.folders.map((f) =>
        f.id === args.id ? { ...f, name: args.name as string } : f,
      ),
    };
    return disk;
  });
  ipc.handle("api_folder_delete", (args) => {
    // The non-destructive delete, modelled: the folder goes, its requests come back.
    disk = {
      ...disk,
      folders: disk.folders.filter((f) => f.id !== args.id),
      collections: disk.collections.map(({ folderId, ...rest }) =>
        folderId === args.id ? rest : { ...rest, ...(folderId ? { folderId } : {}) },
      ),
    };
    return disk;
  });
  ipc.handle("api_folder_reorder", (args) => {
    const ids = args.ids as string[];
    disk = {
      ...disk,
      folders: ids.map((id, order) => ({
        ...disk.folders.find((f) => f.id === id)!,
        order,
      })),
    };
    return disk;
  });
  ipc.handle("api_request_move", (args) => {
    // 🔴 Reads `requestId`/`folderId` — the camelCase Tauri maps onto `request_id` /
    // `folder_id`. A frontend that sent `request`/`folder` would find nothing here,
    // exactly as Rust would fail to deserialize.
    const requestId = args.requestId as string;
    const folderId = args.folderId as string | null;
    disk = {
      ...disk,
      collections: disk.collections.map(({ folderId: was, ...rest }) => {
        if (rest.id !== requestId) return was ? { ...rest, folderId: was } : rest;
        return folderId === null ? rest : { ...rest, folderId };
      }),
    };
    return disk;
  });
}

beforeEach(() => {
  resetStore();
  ipc = installTauriMock();
  disk = {
    collections: [req("c-1", "History"), req("c-2", "CreateWidget"), req("c-3", "Booking")],
    environments: [{ id: "env-1", name: "live", variables: [{ key: "TOKEN", value: "sk-live" }] }],
    activeEnvironmentId: "env-1",
    folders: [],
  };
  installRustLane();
  layoutPrefsIpc.saveLayoutPrefs.mockReset().mockResolvedValue(undefined);
  layoutPrefsIpc.loadLayoutPrefs.mockReset().mockResolvedValue({
    ...layoutPrefsIpc.EMPTY_LAYOUT_PREFS,
  });
});
afterEach(() => {
  cleanup();
  ipc.reset();
});

/** Names of the rows inside a section, in order. */
const namesIn = (testId: string) =>
  within(screen.getByTestId(testId))
    .queryAllByTestId("collections-row")
    .map((li) => li.querySelector(".api-collection-row__name")?.textContent);

describe("Collections folders — the seam from the panel to the IPC edge", () => {
  it("🔴 create → drag a request in → the rail regroups, and the wire says what Rust reads", async () => {
    await act(async () => {
      render(<CollectionsPanel />);
    });
    // The three saved requests, all at the root — nothing migrated.
    expect(namesIn("collections-root")).toEqual(["History", "CreateWidget", "Booking"]);

    // ── create a folder ──────────────────────────────────────────────────────────
    act(() => {
      fireEvent.click(screen.getByText("+ New folder"));
    });
    const box = screen.getByLabelText("New folder name");
    act(() => {
      fireEvent.change(box, { target: { value: "Widget" } });
      fireEvent.keyDown(box, { key: "Enter" });
    });
    await act(async () => {});

    expect(ipc.lastCall("api_folder_create")).toEqual({ name: "Widget" });
    expect(screen.getByTestId("collections-folder")).toBeInTheDocument();

    // ── drag "CreateWidget" into it ──────────────────────────────────────────────
    const row = within(screen.getByTestId("collections-root"))
      .getAllByTestId("collections-row")
      .find((li) => li.textContent?.includes("CreateWidget"))!;
    const written = makeDataTransfer();
    act(() => {
      fireEvent.dragStart(row, { dataTransfer: written });
    });
    const dt = makeDataTransfer({ [REQUEST_DND_MIME]: written.getData(REQUEST_DND_MIME) });
    act(() => {
      fireEvent.dragOver(screen.getByTestId("collections-folder"), { dataTransfer: dt });
      fireEvent.drop(screen.getByTestId("collections-folder"), { dataTransfer: dt });
    });
    await act(async () => {});

    // The exact argument shape Tauri hands to `api_request_move(request_id, folder_id)`.
    expect(ipc.lastCall("api_request_move")).toEqual({
      requestId: "c-2",
      folderId: "f-1",
    });
    expect(namesIn("collections-folder-body")).toEqual(["CreateWidget"]);
    expect(namesIn("collections-root")).toEqual(["History", "Booking"]);
  });

  it("🔴 the grouping survives a restart — a fresh mount reads it back off the file", async () => {
    await act(async () => {
      render(<CollectionsPanel />);
    });
    act(() => {
      fireEvent.click(screen.getByText("+ New folder"));
    });
    const box = screen.getByLabelText("New folder name");
    act(() => {
      fireEvent.change(box, { target: { value: "Widget" } });
      fireEvent.keyDown(box, { key: "Enter" });
    });
    await act(async () => {});
    const dt = makeDataTransfer({ [REQUEST_DND_MIME]: "c-2" });
    act(() => {
      fireEvent.drop(screen.getByTestId("collections-folder"), { dataTransfer: dt });
    });
    await act(async () => {});

    // ── the restart: throw away every scrap of in-memory state and mount again ───
    cleanup();
    resetStore();
    await act(async () => {
      render(<CollectionsPanel />);
    });

    expect(screen.getByText("Widget")).toBeInTheDocument();
    expect(namesIn("collections-folder-body")).toEqual(["CreateWidget"]);
    expect(namesIn("collections-root")).toEqual(["History", "Booking"]);
  });

  it("🔴 deleting the folder keeps the request — it comes back to the root, on disk", async () => {
    disk = {
      ...disk,
      folders: [{ id: "f-1", name: "Widget", order: 0 }],
      collections: [{ ...req("c-2", "CreateWidget"), folderId: "f-1" }],
    };
    await act(async () => {
      render(<CollectionsPanel />);
    });
    expect(namesIn("collections-folder-body")).toEqual(["CreateWidget"]);

    act(() => {
      fireEvent.click(screen.getByLabelText("Delete folder Widget"));
    });
    await act(async () => {});

    expect(ipc.lastCall("api_folder_delete")).toEqual({ id: "f-1" });
    expect(namesIn("collections-root")).toEqual(["CreateWidget"]);
    // The file agrees — the request is still saved, just un-filed.
    expect(disk.collections).toHaveLength(1);
    expect(disk.collections[0].folderId).toBeUndefined();
  });

  it("dragging back out sends folderId: null, and Rust un-files it", async () => {
    disk = {
      ...disk,
      folders: [{ id: "f-1", name: "Widget", order: 0 }],
      collections: [{ ...req("c-2", "CreateWidget"), folderId: "f-1" }],
    };
    await act(async () => {
      render(<CollectionsPanel />);
    });
    const dt = makeDataTransfer({ [REQUEST_DND_MIME]: "c-2" });
    act(() => {
      fireEvent.drop(screen.getByTestId("collections-root"), { dataTransfer: dt });
    });
    await act(async () => {});

    // `null`, not `""` and not a missing key — `Option<String>` on the Rust side.
    expect(ipc.lastCall("api_request_move")).toEqual({ requestId: "c-2", folderId: null });
    expect(namesIn("collections-root")).toEqual(["CreateWidget"]);
  });

  it("renaming and reordering cross the wire with the keys Rust declares", async () => {
    disk = {
      ...disk,
      collections: [],
      folders: [
        { id: "f-1", name: "Widget", order: 0 },
        { id: "f-2", name: "Maestro", order: 1 },
      ],
    };
    await act(async () => {
      render(<CollectionsPanel />);
    });

    act(() => {
      fireEvent.click(screen.getByLabelText("Rename folder Widget"));
    });
    const box = screen.getByLabelText("Rename Widget");
    act(() => {
      fireEvent.change(box, { target: { value: "Widgets" } });
      fireEvent.keyDown(box, { key: "Enter" });
    });
    await act(async () => {});
    expect(ipc.lastCall("api_folder_rename")).toEqual({ id: "f-1", name: "Widgets" });
    expect(screen.getByText("Widgets")).toBeInTheDocument();

    // Drag Maestro above Widgets. `ids` is the whole permutation, which is what
    // `reorder_folders` requires — a partial list is refused there.
    const [widgets, maestro] = screen.getAllByTestId("collections-folder");
    const dt = makeDataTransfer({
      [API_FOLDER_DND_MIME]: "f-2",
      [apiFolderIdType("f-2")]: "",
    });
    act(() => {
      fireEvent.dragOver(widgets, { dataTransfer: dt });
      fireEvent.drop(widgets, { dataTransfer: dt });
    });
    await act(async () => {});
    expect(ipc.lastCall("api_folder_reorder")).toEqual({ ids: ["f-2", "f-1"] });
    expect(
      screen.getAllByTestId("collections-folder").map((li) => li.dataset.folderId),
    ).toEqual(["f-2", "f-1"]);
    expect(maestro).toBeInTheDocument();
  });

  it("🔴 a blob save carries the folders, so deleting a request cannot erase them", async () => {
    disk = {
      ...disk,
      folders: [{ id: "f-1", name: "Widget", order: 0 }],
      collections: [req("c-1", "History"), { ...req("c-2", "CreateWidget"), folderId: "f-1" }],
    };
    await act(async () => {
      render(<CollectionsPanel />);
    });

    act(() => {
      fireEvent.click(screen.getByLabelText("Delete History"));
    });
    await act(async () => {});

    // `api_store_save` REPLACES the file. The folder must still be in what was written,
    // or an unrelated delete silently destroys the user's grouping.
    const saved = ipc.lastCall("api_store_save")!.store as ApiStore;
    expect(saved.folders).toEqual([{ id: "f-1", name: "Widget", order: 0 }]);
    expect(saved.collections.map((c) => c.id)).toEqual(["c-2"]);
    // …and the environments (live tokens) went with it, untouched.
    expect(saved.environments[0].variables[0].value).toBe("sk-live");
  });
});
