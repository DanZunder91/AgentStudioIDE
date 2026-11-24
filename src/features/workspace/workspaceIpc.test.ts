/**
 * `workspaceIpc` — the filesystem half of the command surface, at the wire.
 *
 * A thin wrapper, and thin wrappers are exactly where the command *name* and the
 * arg *shape* are the whole contract: get either wrong and Rust rejects the call
 * at runtime with types none the wiser. `read_dir`'s real exercise is driven
 * through `<WorkspaceTree>`; this pins the marshalling.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installTauriMock, type TauriMock } from "../../test/tauri-mock";
import {
  basename,
  createDirectory,
  createFile,
  deletePath,
  fileStamps,
  joinPath,
  parentPath,
  readDir,
  readFile,
  readImageDataUrl,
  renamePath,
  writeFile,
} from "./workspaceIpc";

describe("workspaceIpc", () => {
  let ipc: TauriMock;

  beforeEach(() => {
    ipc = installTauriMock();
  });

  afterEach(() => {
    ipc.reset();
  });

  describe("readDir", () => {
    it("invokes read_dir with the path and returns the entries Rust sent", async () => {
      const entries = [
        { name: "src", path: "/w/src", isDir: true },
        { name: "README.md", path: "/w/README.md", isDir: false },
      ];
      ipc.handle("read_dir", () => entries);

      await expect(readDir("/w")).resolves.toEqual(entries);
      expect(ipc.lastCall("read_dir")).toEqual({ path: "/w" });
    });

    it("propagates a scope rejection to the caller (a path outside the workspace)", async () => {
      // Rust is security-scoped; the tree turns this Err into a calm empty state,
      // so the wrapper must surface it rather than swallow it into an empty list.
      ipc.handle("read_dir", () => {
        throw new Error("path outside workspace");
      });

      await expect(readDir("/etc")).rejects.toThrow(/outside workspace/);
    });
  });

  describe("readFile", () => {
    it("invokes read_file with the path and returns the text", async () => {
      ipc.handle("read_file", () => "fn main() {}\n");

      await expect(readFile("/w/src/main.rs")).resolves.toBe("fn main() {}\n");
      expect(ipc.lastCall("read_file")).toEqual({ path: "/w/src/main.rs" });
    });

    it("propagates a rejection (binary / oversized / unreadable) to the caller", async () => {
      // The editor turns this Err into a calm "can't preview" state.
      ipc.handle("read_file", () => {
        throw new Error("not valid UTF-8");
      });

      await expect(readFile("/w/logo.png")).rejects.toThrow(/UTF-8/);
    });
  });

  describe("writeFile", () => {
    it("invokes write_file with the path AND content", async () => {
      ipc.handle("write_file", () => null); // Rust `Ok(())` → null on the wire

      await expect(writeFile("/w/notes.md", "# hi\n")).resolves.toBeNull();
      expect(ipc.lastCall("write_file")).toEqual({ path: "/w/notes.md", content: "# hi\n" });
    });

    it("propagates a write rejection (permission / out-of-scope) to the caller", async () => {
      // The editor keeps the buffer + dirty and surfaces this inline.
      ipc.handle("write_file", () => {
        throw new Error("permission denied");
      });

      await expect(writeFile("/w/ro.txt", "x")).rejects.toThrow(/permission denied/);
    });
  });

  describe("readImageDataUrl", () => {
    it("invokes read_image_data_url with the path and returns the data URL", async () => {
      ipc.handle("read_image_data_url", () => "data:image/png;base64,AAAA");

      await expect(readImageDataUrl("/w/docs/logo.png")).resolves.toBe(
        "data:image/png;base64,AAAA",
      );
      expect(ipc.lastCall("read_image_data_url")).toEqual({ path: "/w/docs/logo.png" });
    });

    it("propagates a rejection (out-of-scope / unsupported / oversized) to the caller", async () => {
      // The Markdown preview turns this Err into "leave the broken <img> alone".
      ipc.handle("read_image_data_url", () => {
        throw new Error("unsupported image type");
      });

      await expect(readImageDataUrl("/w/docs/notes.txt")).rejects.toThrow(/unsupported/);
    });
  });

  describe("createDirectory", () => {
    it("invokes create_directory with the path", async () => {
      ipc.handle("create_directory", () => null);

      await expect(createDirectory("/w/newdir")).resolves.toBeNull();
      expect(ipc.lastCall("create_directory")).toEqual({ path: "/w/newdir" });
    });

    it("propagates an already-exists / out-of-scope rejection", async () => {
      ipc.handle("create_directory", () => {
        throw new Error("already exists");
      });

      await expect(createDirectory("/w/dup")).rejects.toThrow(/already exists/);
    });
  });

  describe("createFile", () => {
    it("invokes create_file with the path", async () => {
      ipc.handle("create_file", () => null);

      await expect(createFile("/w/new.ts")).resolves.toBeNull();
      expect(ipc.lastCall("create_file")).toEqual({ path: "/w/new.ts" });
    });

    it("propagates a rejection to the caller", async () => {
      ipc.handle("create_file", () => {
        throw new Error("permission denied");
      });

      await expect(createFile("/w/ro.ts")).rejects.toThrow(/permission denied/);
    });
  });

  describe("renamePath", () => {
    it("invokes rename_path with BOTH from and to", async () => {
      ipc.handle("rename_path", () => null);

      await expect(renamePath("/w/old.ts", "/w/new.ts")).resolves.toBeNull();
      expect(ipc.lastCall("rename_path")).toEqual({ from: "/w/old.ts", to: "/w/new.ts" });
    });

    it("propagates a rejection (collision / into own subtree) to the caller", async () => {
      ipc.handle("rename_path", () => {
        throw new Error("target exists");
      });

      await expect(renamePath("/w/a", "/w/b")).rejects.toThrow(/target exists/);
    });
  });

  describe("deletePath", () => {
    it("invokes delete_path with the path", async () => {
      ipc.handle("delete_path", () => null);

      await expect(deletePath("/w/gone.ts")).resolves.toBeNull();
      expect(ipc.lastCall("delete_path")).toEqual({ path: "/w/gone.ts" });
    });

    it("propagates a rejection to the caller", async () => {
      ipc.handle("delete_path", () => {
        throw new Error("permission denied");
      });

      await expect(deletePath("/w/locked")).rejects.toThrow(/permission denied/);
    });
  });

  describe("path helpers", () => {
    describe("joinPath", () => {
      it("joins with POSIX separators", () => {
        expect(joinPath("/w", "a.ts")).toBe("/w/a.ts");
      });

      it("joins with Windows separators, preserving the style", () => {
        expect(joinPath("C:\\Users\\me", "a.ts")).toBe("C:\\Users\\me\\a.ts");
      });

      it("collapses a trailing separator on the dir", () => {
        expect(joinPath("/w/", "a.ts")).toBe("/w/a.ts");
        expect(joinPath("C:\\Users\\", "a.ts")).toBe("C:\\Users\\a.ts");
      });

      it("joins under the POSIX root", () => {
        expect(joinPath("/", "a.ts")).toBe("/a.ts");
      });
    });

    describe("parentPath", () => {
      it("returns the parent of a POSIX path", () => {
        expect(parentPath("/w/src/main.rs")).toBe("/w/src");
      });

      it("returns the parent of a Windows path, preserving the style", () => {
        expect(parentPath("C:\\Users\\me\\a.ts")).toBe("C:\\Users\\me");
      });

      it("tolerates a trailing separator", () => {
        expect(parentPath("/w/src/")).toBe("/w");
      });

      it("yields the POSIX root for a first-level child", () => {
        expect(parentPath("/w")).toBe("/");
      });

      it("yields the DRIVE ROOT for a first-level Windows child — `C:\\`, never `C:`", () => {
        // `C:` alone is the current directory on drive C, a different folder.
        expect(parentPath("C:\\w")).toBe("C:\\");
        expect(parentPath("C:\\")).toBe("C:\\");
      });

      it("a bare name has no parent", () => {
        expect(parentPath("w")).toBe("");
      });
    });

    describe("basename", () => {
      it("returns the last POSIX segment", () => {
        expect(basename("/w/src/main.rs")).toBe("main.rs");
      });

      it("returns the last Windows segment", () => {
        expect(basename("C:\\Users\\me\\a.ts")).toBe("a.ts");
      });

      it("tolerates a trailing separator", () => {
        expect(basename("/w/src/")).toBe("src");
      });

      it("yields '' for a separator-only path", () => {
        expect(basename("/")).toBe("");
      });
    });
  });
});

describe("fileStamps", () => {
  it("asks for nothing when there is nothing to ask about", async () => {
    // The watcher ticks even with no editors open; that must cost no IPC.
    const ipc = installTauriMock();
    await expect(fileStamps([])).resolves.toEqual([]);
    expect(ipc.calls("file_stamps")).toHaveLength(0);
    ipc.reset();
  });

  it("NEVER throws — a failed check is 'no news', not an error the user sees", async () => {
    const ipc = installTauriMock();
    ipc.handle("file_stamps", () => {
      throw new Error("out-of-scope");
    });
    // One null per input, so the caller can still zip the answers positionally.
    await expect(fileStamps(["/w/a.ts", "/w/b.ts"])).resolves.toEqual([null, null]);
    ipc.reset();
  });

  it("passes the paths through and returns Rust's answer in order", async () => {
    const ipc = installTauriMock();
    const answer = [{ mtimeMs: 1, size: 2 }, null];
    ipc.handle("file_stamps", () => answer);
    await expect(fileStamps(["/w/a.ts", "/w/gone.ts"])).resolves.toEqual(answer);
    expect(ipc.lastCall("file_stamps")).toEqual({ paths: ["/w/a.ts", "/w/gone.ts"] });
    ipc.reset();
  });
});

