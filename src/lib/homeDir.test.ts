import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const tauriPath = vi.hoisted(() => ({ homeDir: vi.fn<() => Promise<string>>() }));
vi.mock("@tauri-apps/api/path", () => tauriPath);

import { loadHomeDir, resetHomeDirForTests, useHomeDir } from "./homeDir";

beforeEach(() => {
  resetHomeDirForTests();
  tauriPath.homeDir.mockReset();
});

describe("loadHomeDir", () => {
  it("asks Tauri once, however many callers", async () => {
    tauriPath.homeDir.mockResolvedValue("C:\\Users\\me");
    const [a, b] = await Promise.all([loadHomeDir(), loadHomeDir()]);
    expect(a).toBe("C:\\Users\\me");
    expect(b).toBe("C:\\Users\\me");
    expect(await loadHomeDir()).toBe("C:\\Users\\me");
    expect(tauriPath.homeDir).toHaveBeenCalledTimes(1);
  });

  it("is null when Tauri cannot answer", async () => {
    tauriPath.homeDir.mockRejectedValue(new Error("no Tauri"));
    expect(await loadHomeDir()).toBeNull();
  });
});

describe("useHomeDir", () => {
  it("is null until known, then the home folder", async () => {
    tauriPath.homeDir.mockResolvedValue("/Users/me");
    const { result } = renderHook(() => useHomeDir());
    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current).toBe("/Users/me"));
  });

  it("starts with the cached answer in a component mounted later (no second fetch)", async () => {
    tauriPath.homeDir.mockResolvedValue("/Users/me");
    await loadHomeDir();
    const { result } = renderHook(() => useHomeDir());
    expect(result.current).toBe("/Users/me");
    expect(tauriPath.homeDir).toHaveBeenCalledTimes(1);
  });

  it("stays null when Tauri cannot answer", async () => {
    tauriPath.homeDir.mockRejectedValue(new Error("no Tauri"));
    const { result } = renderHook(() => useHomeDir());
    await loadHomeDir();
    expect(result.current).toBeNull();
  });

  it("drops an answer that lands after the component unmounted", async () => {
    let resolve!: (h: string) => void;
    tauriPath.homeDir.mockReturnValue(new Promise<string>((r) => (resolve = r)));
    const { result, unmount } = renderHook(() => useHomeDir());
    unmount();
    resolve("/Users/me");
    expect(await loadHomeDir()).toBe("/Users/me");
    expect(result.current).toBeNull();
  });
});
