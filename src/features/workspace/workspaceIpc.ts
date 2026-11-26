/** Typed wrapper for the filesystem commands, feature-local so the wire types live with it. */

import { invoke } from "@tauri-apps/api/core";

import type { FsEntry } from "../../app/types";

/** One directory level, read lazily on expand. Scoped in Rust to workspace / recent roots; an
 * out-of-scope rejection shows as a calm empty state. */
export function readDir(path: string): Promise<FsEntry[]> {
  return invoke<FsEntry[]>("read_dir", { path });
}

/** A file's full text for the editor. Same scope as `read_dir`; Rust rejects binary, oversized or
 * unreadable files ("can't preview"). */
export function readFile(path: string): Promise<string> {
  return invoke<string>("read_file", { path });
}

/** Persists the editor buffer. Same scope; a rejected write is shown inline, buffer kept. */
export function writeFile(path: string, content: string): Promise<void> {
  return invoke<void>("write_file", { path, content });
}

/** A scoped image as a `data:` URL for the Markdown preview (same scope as `read_file`); on a
 * rejection the preview leaves the broken `<img>` alone. */
export function readImageDataUrl(path: string): Promise<string> {
  return invoke<string>("read_image_data_url", { path });
}

/** New empty folder (parent in scope); an out-of-scope or existing name rejects, shown inline. */
export function createDirectory(path: string): Promise<void> {
  return invoke<void>("create_directory", { path });
}

/** New empty file; same rules as `create_directory`. The tree opens it on success. */
export function createFile(path: string): Promise<void> {
  return invoke<void>("create_file", { path });
}

/** Rename AND move: `to` is the FULL destination path. Rust rejects a no-op, a move into its own
 * subtree, a collision or an out-of-scope endpoint. */
export function renamePath(from: string, to: string): Promise<void> {
  return invoke<void>("rename_path", { from, to });
}

/** Removes a file or folder recursively; same scope as the reads, a rejection is shown inline. */
export function deletePath(path: string): Promise<void> {
  return invoke<void>("delete_path", { path });
}

/** `lib/paths` under the tree's names; separator-tolerant, keeping Rust's native separators.
 * `parentPath` is `dirname`: `/w` → `/`, `C:\w` → `C:\` (bare `C:` means drive C's cwd). */
export { basename, dirname as parentPath, joinPath } from "../../lib/paths";

/** A file's on-disk identity `(mtime, size)`, or `null` when unstampable (gone, unreadable,
 * out of scope). */
export interface FileStamp {
  mtimeMs: number | null;
  size: number;
}

/** Stamps many files in one round trip (asked on a timer for every open editor). NEVER throws: a
 * failure means "no news this tick". One answer per input, in order. */
export async function fileStamps(paths: string[]): Promise<(FileStamp | null)[]> {
  if (paths.length === 0) return [];
  try {
    return await invoke<(FileStamp | null)[]>("file_stamps", { paths });
  } catch {
    return paths.map(() => null);
  }
}
