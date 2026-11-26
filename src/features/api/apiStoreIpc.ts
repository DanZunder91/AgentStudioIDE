/** Typed wrapper for the API client's DURABLE store: persisted only under the OS app-data dir by
 * Rust (`api_store_load`/`api_store_save`), out of any git reach. Wire types mirror the serde
 * structs. Saved requests keep `{{VAR}}` literal; secrets live only in an `Environment`. */

import { invoke } from "@tauri-apps/api/core";
import type { HttpHeader } from "./httpIpc";

/** A saved HTTP, WS or gRPC request (`protocol` absent = "http"); text fields keep `{{VAR}}`
 * literal. Optional fields are absent (not `null`) on an HTTP save: Rust's `skip_serializing_if`
 * keeps the wire clean and legacy HTTP-only files loading. */
export interface SavedRequest {
  id: string;
  name: string;
  method: string;
  url: string;
  headers: HttpHeader[];
  body: string;
  /** "http" (or absent, for legacy files) / "ws" / "grpc". */
  protocol?: "http" | "ws" | "grpc";
  /** gRPC only: the picked service FQN. */
  grpcService?: string;
  /** gRPC only: the picked method name. */
  grpcMethod?: string;
  /** gRPC only: h2c (no TLS) when true. */
  plaintext?: boolean;
  /** Folder this request is filed under; ABSENT (not `null`, Rust skips it) means the root, which
   * keeps requests saved before folders existed at the root without a migration. */
  folderId?: string;
}

/** A flat folder of saved requests. `ApiStore.folders` arrives in display order (`order` is
 * stamped by `api_store.rs`), so nothing here re-sorts it: one ordering, one owner. */
export interface ApiFolder {
  id: string;
  name: string;
  order: number;
}

/** One environment variable — the token store. Persists ONLY in the app-data dir. */
export interface EnvVar {
  key: string;
  value: string;
}

/** A named set of variables the send path substitutes into a request. */
export interface Environment {
  id: string;
  name: string;
  variables: EnvVar[];
}

/** The whole durable store: collections + folders + environments + the active env pointer. */
export interface ApiStore {
  collections: SavedRequest[];
  environments: Environment[];
  activeEnvironmentId: string | null;
  /** Saved-request folders, already in display order (see `ApiFolder`). */
  folders: ApiFolder[];
}

/** A fresh empty store. A function, not a constant: callers mutate their copy. */
export function emptyApiStore(): ApiStore {
  return { collections: [], environments: [], activeEnvironmentId: null, folders: [] };
}

/** `api_store_load`, or `null` if the read failed. Not an empty store: hydrating empty on a
 * transient failure would blank the mirror and the next save would overwrite the real file. */
export async function readApiStore(): Promise<ApiStore | null> {
  try {
    return await invoke<ApiStore>("api_store_load");
  } catch {
    return null;
  }
}

/** BOOT read: never throws; any failure yields a fresh empty store (a new object per call, as
 * callers mutate it). Use `readApiStore` when re-reading over existing state. */
export async function loadApiStore(): Promise<ApiStore> {
  return (await readApiStore()) ?? emptyApiStore();
}

/* ─────────────────────────── folders: the commands ─────────────────────────────── */

/** Folder commands return the WHOLE store: Rust re-reads the file per command
 * (`api_store::edit_store`) and the caller re-hydrates from it, so nothing drifts or clobbers a
 * Vault write. `null` on failure, leaving the rail as it was instead of throwing into React. */
async function folderCommand(
  cmd: string,
  args: Record<string, unknown>,
): Promise<ApiStore | null> {
  try {
    return await invoke<ApiStore>(cmd, args);
  } catch {
    return null;
  }
}

/** `api_folder_create` — add a folder named `name` (Rust mints the id and the rank). */
export function createApiFolder(name: string): Promise<ApiStore | null> {
  return folderCommand("api_folder_create", { name });
}

/** `api_folder_rename` — rename a folder. A blank name is refused by Rust. */
export function renameApiFolder(id: string, name: string): Promise<ApiStore | null> {
  return folderCommand("api_folder_rename", { id, name });
}

/** `api_folder_delete`: its requests return to the root (`api_store::delete_folder`). */
export function deleteApiFolder(id: string): Promise<ApiStore | null> {
  return folderCommand("api_folder_delete", { id });
}

/** `api_folder_reorder`: `ids` must be a permutation of the stored folder ids (`moveBefore`). */
export function reorderApiFolders(ids: string[]): Promise<ApiStore | null> {
  return folderCommand("api_folder_reorder", { ids });
}

/** `api_request_move`: file a saved request under `folderId`, or at the root when `null`. */
export function moveRequestToFolder(
  requestId: string,
  folderId: string | null,
): Promise<ApiStore | null> {
  return folderCommand("api_request_move", { requestId, folderId });
}

/** `api_store_save`, best-effort: a write failure is swallowed so composing never breaks. Rust
 * writes to the app-data dir, never the workspace/repo. */
export async function saveApiStore(store: ApiStore): Promise<void> {
  try {
    await invoke("api_store_save", { store });
  } catch {
    // Intentionally ignored — see the docblock. The Rust store is the source of
    // truth; a dropped save is re-issued by the next mutation.
  }
}
