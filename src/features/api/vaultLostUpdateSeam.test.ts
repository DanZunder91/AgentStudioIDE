/**
 * 🔴 SEAM test — the `api-store.json` LOST UPDATE.
 *
 * ── The bug this file exists to keep fixed ──────────────────────────────────────
 * `api-store.json` has TWO writers:
 *   1. the webview, which holds a full in-memory mirror hydrated **once per app run**
 *      (`apiStoreLoaded` gates the panels' mount effect) and rewrites the WHOLE blob on
 *      any collection/Vault action (`persistApiStore` → `api_store_save`); and
 *   2. Rust, which writes the same file when a DB connection's password is saved
 *      `forever` — `db_connection_upsert` → `db::upsert` → `api_store::save`, because
 *      the DB client's Vault **is** this file (one secret store, not two).
 *
 * So: save a DB password, then delete a saved request. The blob save writes the
 * pre-password snapshot the webview has been holding since launch straight over the
 * file, and the password is gone — silently, with no error anywhere, and the user only
 * finds out the next time that connection fails to open.
 *
 * The fix is `refreshApiStore()`, awaited at the end of `upsertDbConnection`: re-read
 * the file Rust just wrote, so the mirror is current before anything can save it back.
 *
 * ── Why it has to be a seam test ────────────────────────────────────────────────
 * Both halves are individually correct and individually 100% covered. The bug lives in
 * the ORDER of two writes to one file across two features, which is precisely what no
 * unit test on either side can see. So the only thing mocked here is the Tauri bridge,
 * and behind it sits a `disk` object that both writers read and write for real.
 *
 * FALSIFIED: removing the `await get().apiActions.refreshApiStore()` line turns
 * the first test red.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

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
import { installTauriMock, type TauriMock } from "../../test/tauri-mock";
import type { DbConnectionDraft } from "../db/types";
import type { ApiStore } from "./apiStoreIpc";

let ipc: TauriMock;

/** The one file both writers write. */
let disk: ApiStore;

const TOKEN = "test-api-token";
const DB_PASSWORD = "hunter2";

const DRAFT: DbConnectionDraft = {
  name: "Maestro",
  engine: "postgres",
  family: "postgres",
  host: "127.0.0.1",
  port: 55432,
  database: "maestro",
  user: "ro",
  passwordRef: "",
  savePassword: "forever",
  url: null,
  srv: false,
  passwordParam: null,
  sslMode: "prefer",
  caSummary: null,
  options: {},
  readOnly: true,
  rowLimit: 500,
  timeoutMs: 30_000,
  allowMultiStatement: false,
};

beforeEach(() => {
  resetStore();
  ipc = installTauriMock();
  disk = {
    collections: [
      {
        id: "c-1",
        name: "History",
        method: "GET",
        url: "https://api.test/history",
        headers: [],
        body: "",
        protocol: "http",
      },
    ],
    environments: [
      { id: "env-1", name: "dev", variables: [{ key: "API_TOKEN", value: TOKEN }] },
    ],
    activeEnvironmentId: "env-1",
    folders: [],
  };

  ipc.handle("api_store_load", () => disk);
  ipc.handle("api_store_save", (args) => {
    disk = args.store as ApiStore;
    return null;
  });
  // What `db::upsert` does with `savePassword: "forever"`: mint a Vault variable in
  // `api-store.json` and persist the record with a `{{VAR}}` reference, never the value.
  ipc.handle("db_connection_upsert", (args) => {
    const input = args.input as { id: string | null; name: string };
    disk = {
      ...disk,
      environments: disk.environments.map((e) =>
        e.id === "env-1"
          ? {
              ...e,
              variables: [
                ...e.variables,
                { key: "MAESTRO_PASSWORD", value: args.password as string },
              ],
            }
          : e,
      ),
    };
    return {
      id: input.id ?? "conn-1",
      ...DRAFT,
      name: input.name,
      passwordRef: "{{MAESTRO_PASSWORD}}",
      createdAt: 1,
      updatedAt: 1,
    };
  });

  layoutPrefsIpc.saveLayoutPrefs.mockReset().mockResolvedValue(undefined);
  layoutPrefsIpc.loadLayoutPrefs.mockReset().mockResolvedValue({
    ...layoutPrefsIpc.EMPTY_LAYOUT_PREFS,
  });
});
afterEach(() => ipc.reset());

/** The Vault variable, read straight off the "file". */
const onDisk = (key: string) =>
  disk.environments[0].variables.find((v) => v.key === key)?.value;

describe("api-store.json has two writers — the mirror must not overwrite Rust", () => {
  it("🔴 a DB password saved by Rust survives the next collection edit", async () => {
    const api = () => useAppStore.getState().apiActions;
    const db = () => useAppStore.getState().dbActions;

    // The app has been running a while: the mirror was hydrated at launch.
    api().hydrateApiStore(disk);
    expect(useAppStore.getState().apiCollections).toHaveLength(1);

    // The user saves a DB connection with "remember the password". Rust writes the
    // Vault variable into `api-store.json` — a file the webview is mirroring.
    await db().upsertDbConnection(DRAFT, DB_PASSWORD, null);
    expect(onDisk("MAESTRO_PASSWORD")).toBe(DB_PASSWORD);

    // …then they delete a saved request, which rewrites the WHOLE blob from the mirror.
    api().deleteCollection("c-1");
    await Promise.resolve();

    // Both must be true: the delete happened, AND the password Rust wrote is still there.
    expect(disk.collections).toHaveLength(0);
    expect(onDisk("MAESTRO_PASSWORD")).toBe(DB_PASSWORD);
    // …and the API token that was already there is untouched either way.
    expect(onDisk("API_TOKEN")).toBe(TOKEN);
  });

  it("the re-read also makes the new Vault variable VISIBLE, without a restart", async () => {
    const api = () => useAppStore.getState().apiActions;
    api().hydrateApiStore(disk);
    expect(
      useAppStore.getState().apiEnvironments[0].variables.map((v) => v.key),
    ).toEqual(["API_TOKEN"]);

    await useAppStore.getState().dbActions.upsertDbConnection(DRAFT, DB_PASSWORD, null);

    // Before the fix this only appeared after quitting and reopening the app — the
    // Vault panel's load-once gate had already fired.
    expect(
      useAppStore.getState().apiEnvironments[0].variables.map((v) => v.key),
    ).toEqual(["API_TOKEN", "MAESTRO_PASSWORD"]);
  });

  it("a failed re-read leaves the mirror alone rather than blanking it", async () => {
    const api = () => useAppStore.getState().apiActions;
    api().hydrateApiStore(disk);
    // `api_store_load` starts failing (the bridge is gone, the command is missing).
    // `readApiStore` answers `null`, which must NOT be treated as "the file is empty":
    // hydrating an empty store here is how the blob save would then blank the file.
    ipc.handle("api_store_load", () => {
      throw new Error("bridge gone");
    });

    await api().refreshApiStore();

    expect(useAppStore.getState().apiCollections).toHaveLength(1);
    expect(useAppStore.getState().apiEnvironments[0].variables).toHaveLength(1);
  });
});
