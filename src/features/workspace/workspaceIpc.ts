/**
 * Workspace IPC — typed wrapper for the filesystem half of the command surface.
 *
 * Kept feature-local so the wire types live next to their feature.
 */

import { invoke } from "@tauri-apps/api/core";

import type { FsEntry } from "../../app/types";

/**
 * `read_dir` — one directory level, lazily (called only when a folder expands).
 * Security-scoped in Rust to the workspace / recent roots; a path outside them
 * rejects, which the tree surfaces as a calm empty state rather than a crash.
 */
export function readDir(path: string): Promise<FsEntry[]> {
  return invoke<FsEntry[]>("read_dir", { path });
}

/**
 * `read_file` — the full text of one file, for the read-only editor (M4).
 * Same security scope as `read_dir`; Rust rejects a binary / oversized /
 * unreadable file, which the editor surfaces as a calm "can't preview" state.
 */
export function readFile(path: string): Promise<string> {
  return invoke<string>("read_file", { path });
}

/**
 * `write_file` — persist the editor buffer. Same security scope as
 * `read_dir`/`read_file`; Rust rejects a write outside the workspace / on an
 * unwritable path, which the editor surfaces inline while keeping the buffer.
 */
export function writeFile(path: string, content: string): Promise<void> {
  return invoke<void>("write_file", { path, content });
}

/**
 * `read_image_data_url` — a scoped image file as a `data:` URL, for inlining a
 * local image into the Markdown preview. SAME security scope as `read_file`
 * (recents ∪ workspace); Rust rejects out-of-scope / non-image / oversized paths,
 * which the preview treats as "leave the broken `<img>` alone" rather than a crash.
 */
export function readImageDataUrl(path: string): Promise<string> {
  return invoke<string>("read_image_data_url", { path });
}

/**
 * `create_directory` — make a new (empty) folder at `path` (the parent must be
 * in scope). Rust rejects an out-of-scope path or an already-existing name,
 * which the tree surfaces as a calm inline note.
 */
export function createDirectory(path: string): Promise<void> {
  return invoke<void>("create_directory", { path });
}

/**
 * `create_file` — make a new (empty) file at `path`. Same scope + already-exists
 * rules as `create_directory`; the tree opens the new file in the editor on
 * success and surfaces a rejection inline.
 */
export function createFile(path: string): Promise<void> {
  return invoke<void>("create_file", { path });
}

/**
 * `rename_path` — serves BOTH rename and move: `to` is the FULL destination path
 * (rename → `<parent-of-from>/<newName>`; move → `<destDir>/<basename-of-from>`).
 * Rust rejects a no-op, a move into the source's own subtree, a name collision,
 * or an out-of-scope endpoint — all surfaced calmly inline.
 */
export function renamePath(from: string, to: string): Promise<void> {
  return invoke<void>("rename_path", { from, to });
}

/**
 * `delete_path` — remove a file or folder (recursively) at `path`. Same security
 * scope as the reads; a rejection (permission / out-of-scope) is surfaced inline
 * rather than crashing the rail.
 */
export function deletePath(path: string): Promise<void> {
  return invoke<void>("delete_path", { path });
}

/**
 * Pure path helpers, separator-tolerant so a Windows (`\\`) and a POSIX (`/`) path
 * both round-trip. The absolute paths come from Rust with NATIVE separators, so
 * these preserve the separator style already present rather than normalising it.
 * Exported for unit tests — the tree joins/splits paths on every mutation.
 *
 * They are `lib/paths`' — the one path module — under the names the tree has always
 * used. `parentPath` is `dirname`: a first-level child (`/w`) yields the root `/`, and
 * `C:\w` yields `C:\` (this used to answer `C:`, which Windows reads as "the current
 * directory on drive C", not its root).
 */
export { basename, dirname as parentPath, joinPath } from "../../lib/paths";

/**
 * One file's on-disk identity — `(mtime, size)`, or `null` when it cannot be
 * stamped (gone, unreadable, out of scope).
 */
export interface FileStamp {
  mtimeMs: number | null;
  size: number;
}

/**
 * Stamp several files in one round trip — the open editors' change check.
 *
 * Batched because this is asked on a timer for every open editor, and N round
 * trips per tick would be N times the IPC for the same answer. NEVER throws: a
 * failed check must not surface to the user, it just means "no news this tick".
 * One answer per input, in order.
 */
export async function fileStamps(paths: string[]): Promise<(FileStamp | null)[]> {
  if (paths.length === 0) return [];
  try {
    return await invoke<(FileStamp | null)[]>("file_stamps", { paths });
  } catch {
    return paths.map(() => null);
  }
}
