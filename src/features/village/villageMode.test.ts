/** Storage is only a convenience: a missing, corrupt or throwing store still gives a working tab */

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MODE_STORAGE_KEY, readStoredMode, useVillageMode } from "./villageMode";

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("readStoredMode", () => {
  it("is the village unless the viewer chose the city", () => {
    expect(readStoredMode()).toBe("village");
    window.localStorage.setItem(MODE_STORAGE_KEY, "city");
    expect(readStoredMode()).toBe("city");
    window.localStorage.setItem(MODE_STORAGE_KEY, "{garbage");
    expect(readStoredMode()).toBe("village");
  });

  it("falls back to the village when storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readStoredMode()).toBe("village");
  });
});

describe("useVillageMode", () => {
  it("starts from the stored choice and remembers a new one", () => {
    window.localStorage.setItem(MODE_STORAGE_KEY, "city");
    const { result } = renderHook(() => useVillageMode());
    expect(result.current[0]).toBe("city");
    act(() => result.current[1]("village"));
    expect(result.current[0]).toBe("village");
    expect(window.localStorage.getItem(MODE_STORAGE_KEY)).toBe("village");
  });

  it("still switches for this session when storage refuses the write", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    const { result } = renderHook(() => useVillageMode());
    act(() => result.current[1]("city"));
    expect(result.current[0]).toBe("city");
  });
});
