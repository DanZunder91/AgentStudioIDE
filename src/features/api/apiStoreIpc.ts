/**
 * apiStoreIpc — typed wrapper for the API client's DURABLE store.
 *
 * Collections (saved requests) and environments (which hold live tokens) persist
 * ONLY under the OS app-data dir, handled by the Rust `api_store_load` /
 * `api_store_save` commands — reachable by no git operation (the hard secret-safety rule).
 * These types are the EXACT wire contract those commands implement, mirrored by their
 * serde structs; they live here (not in `app/types.ts`) so the wire types stay next to
 * their feature, exactly as `httpIpc` keeps the HTTP wire types local.
 *
 * Secret-safety: a saved collection stores request text with any `{{VAR}}`
 * placeholders LITERAL — the resolved secret only ever exists on the wire (see
 * `substitute.ts` + the send path). The token itself lives only in an
 * `Environment`, which persists only here.
 *
 * Both calls are best-effort from the UI's point of view: `loadApiStore` NEVER
 * throws (a missing/failed backend yields an empty store, so the UI still opens),
 * and `saveApiStore` swallows its failure (a transient write error must not break
 * the request the user is composing — the Rust store is the source of truth).
 */

import { invoke } from "@tauri-apps/api/core";
import type { HttpHeader } from "./httpIpc";

/**
 * A request saved into a collection. `headers` reuses the send command's on-wire
 * `HttpHeader` (name/value only — no enabled/id row scaffolding), and every text
 * field keeps its `{{VAR}}` placeholders literal, never a resolved secret.
 *
 * Protocol-aware: a collection holds HTTP, WebSocket, and gRPC requests.
 * The shared fields cover HTTP + WS; the optional tail carries only what gRPC needs.
 * These optional fields are absent (not `null`) on an HTTP save — the Rust side's
 * `skip_serializing_if` keeps the wire clean and legacy HTTP-only files still load.
 *   • HTTP — `method`/`url`/`headers`/`body`; `protocol` "http" or absent.
 *   • WS   — `url` is the socket URL, `headers` the connect headers; `protocol` "ws".
 *   • gRPC — `url` is the endpoint, `body` the request message, `headers` the
 *     metadata, plus `grpcService`/`grpcMethod`/`plaintext`; `protocol` "grpc".
 */
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
  /**
   * The folder this request is filed under; ABSENT means the root. Absent (not
   * `null`) because Rust `skip_serializing_if`s it, which is what keeps every
   * request saved before folders existed at the root with no migration — the
   * rule that existing requests stay at the root.
   */
  folderId?: string;
}

/**
 * A folder grouping saved requests. Flat (a folder holds requests, never folders)
 * and ordered: `order` is the display rank Rust stamps, and `ApiStore.folders`
 * arrives **already in display order**, so nothing on this side re-sorts it. That is
 * deliberate — one ordering, owned by `api_store.rs`, means there is no second sort
 * here to drift out of agreement with the file.
 */
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

/**
 * `api_store_load` — read the durable store, or `null` if the read itself failed.
 *
 * The `null` is the whole point and is NOT the same as an empty store: a caller that
 * re-hydrates its in-memory mirror must be able to tell "the file is empty" from "I
 * could not read the file". Hydrating an empty store on a transient failure would
 * blank the mirror, and the next blob save would then write that blank over the
 * user's real file — the exact lost-update shape this store already had one of.
 */
export async function readApiStore(): Promise<ApiStore | null> {
  try {
    return await invoke<ApiStore>("api_store_load");
  } catch {
    return null;
  }
}

/**
 * `api_store_load` — hydrate the durable store. NEVER throws: any failure (no
 * backend, a corrupt file the Rust side could not parse) yields a FRESH empty
 * store, so opening the API client can never fail on persistence. A new object
 * each call — callers mutate their copy, so a shared reference would be a bug.
 *
 * This is the BOOT read (the panels' mount effect), where an empty store is the
 * right fallback: there is nothing in memory yet to lose. Use `readApiStore` when
 * re-reading over state that already exists.
 */
export async function loadApiStore(): Promise<ApiStore> {
  return (await readApiStore()) ?? emptyApiStore();
}

/* ─────────────────────────── folders: the commands ─────────────────────────────── */

/**
 * Every folder command returns the WHOLE updated store, and this is the one place
 * that shape is invoked.
 *
 * Rust re-reads `api-store.json` inside each command (`api_store::edit_store`), so a
 * folder gesture cannot overwrite a Vault password written by `db_connection_upsert`
 * in between. Returning the whole store is the other half of that: the caller
 * re-hydrates its mirror from the file's true post-write contents on every gesture,
 * instead of letting it drift for the rest of the app run.
 *
 * `null` on failure — the same "could not do it" the callers already branch on, so a
 * rejected gesture leaves the rail exactly as it was rather than throwing into a
 * React event handler where nothing would catch it.
 */
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

/**
 * `api_folder_delete` — remove a folder. Its requests are **returned to the root**,
 * never deleted (`api_store::delete_folder`).
 */
export function deleteApiFolder(id: string): Promise<ApiStore | null> {
  return folderCommand("api_folder_delete", { id });
}

/**
 * `api_folder_reorder` — set the display order to `ids`, which must be a permutation
 * of the stored folder ids. Callers build it with the shared `moveBefore`.
 */
export function reorderApiFolders(ids: string[]): Promise<ApiStore | null> {
  return folderCommand("api_folder_reorder", { ids });
}

/**
 * `api_request_move` — file a saved request under `folderId`, or at the root when it
 * is `null`.
 */
export function moveRequestToFolder(
  requestId: string,
  folderId: string | null,
): Promise<ApiStore | null> {
  return folderCommand("api_request_move", { requestId, folderId });
}

/**
 * `api_store_save` — persist the durable store. Best-effort: a transient write
 * failure is swallowed rather than surfaced, so composing a request never breaks
 * on a save. The store crosses the boundary in memory only; the Rust side writes
 * it to the app-data dir, never the workspace/repo.
 */
export async function saveApiStore(store: ApiStore): Promise<void> {
  try {
    await invoke("api_store_save", { store });
  } catch {
    // Intentionally ignored — see the docblock. The Rust store is the source of
    // truth; a dropped save is re-issued by the next mutation.
  }
}
