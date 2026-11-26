import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installTauriMock, type TauriMock } from "../../test/tauri-mock";
import {
  AMBIENCE_STORAGE_KEY,
  AUTO_OVERRIDE,
  CLOCK_TICK_MS,
  localTimeZone,
  readStoredOverride,
  useVillageAmbience,
  WEATHER_REFRESH_MS,
} from "./useVillageAmbience";
import type { WeatherWire } from "./villageTypes";

const RAIN: WeatherWire = {
  kind: "rain",
  intensity: 0.7,
  temperatureC: 18,
  wind: 0.2,
  sunriseMs: null,
  sunsetMs: null,
  place: "Tokyo",
  fetchedAtMs: 1,
};

function setHidden(hidden: boolean) {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (hidden ? "hidden" : "visible"),
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

/** Let the invoke promise chain settle inside act. */
async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

describe("useVillageAmbience", () => {
  let ipc: TauriMock;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(new Date(2026, 9, 14, 16, 20, 0));
    ipc = installTauriMock();
    window.localStorage.clear();
    setHidden(false);
  });
  afterEach(() => {
    ipc.reset();
    vi.useRealTimers();
    vi.restoreAllMocks();
    window.localStorage.clear();
    setHidden(false);
  });

  it("fetches on mount with the Intl time zone and exposes the report", async () => {
    ipc.handle("village_weather", () => RAIN);
    const { result, unmount } = renderHook(() => useVillageAmbience());
    expect(result.current.weather).toBeNull();
    await flush();
    expect(result.current.weather).toEqual(RAIN);
    expect(result.current.weatherError).toBeNull();
    expect(ipc.lastCall("village_weather")).toStrictEqual({ timeZone: localTimeZone() });
    expect(result.current.override).toEqual(AUTO_OVERRIDE);
    unmount();
  });

  it("polls every 10 minutes only while visible, and refetches on return only when stale", async () => {
    ipc.handle("village_weather", () => RAIN);
    const { unmount } = renderHook(() => useVillageAmbience());
    await flush();
    expect(ipc.calls("village_weather")).toHaveLength(1);

    act(() => vi.advanceTimersByTime(WEATHER_REFRESH_MS));
    await flush();
    expect(ipc.calls("village_weather")).toHaveLength(2);

    act(() => setHidden(true));
    act(() => vi.advanceTimersByTime(WEATHER_REFRESH_MS));
    await flush();
    expect(ipc.calls("village_weather")).toHaveLength(2); // hidden: no poll

    act(() => setHidden(false)); // stale (>= 10 min since last attempt) → refetch
    await flush();
    expect(ipc.calls("village_weather")).toHaveLength(3);

    act(() => setHidden(true));
    act(() => setHidden(false)); // fresh → no refetch
    await flush();
    expect(ipc.calls("village_weather")).toHaveLength(3);
    unmount();
  });

  it("ticks the clock every 30 s and on becoming visible", () => {
    ipc.handle("village_weather", () => RAIN);
    const { result, unmount } = renderHook(() => useVillageAmbience());
    const start = result.current.now.getTime();
    act(() => vi.advanceTimersByTime(CLOCK_TICK_MS));
    expect(result.current.now.getTime()).toBe(start + CLOCK_TICK_MS);
    vi.setSystemTime(start + 5 * CLOCK_TICK_MS);
    act(() => setHidden(false));
    expect(result.current.now.getTime()).toBe(start + 5 * CLOCK_TICK_MS);
    unmount();
  });

  it("codes an error and keeps the last good report; a success clears it", async () => {
    let fail = true;
    ipc.handle("village_weather", () => {
      if (fail) throw "offline: no route to host /secret";
      return RAIN;
    });
    const { result, unmount } = renderHook(() => useVillageAmbience());
    await flush();
    expect(result.current.weather).toBeNull();
    expect(result.current.weatherError).toBe("offline");

    fail = false;
    act(() => vi.advanceTimersByTime(WEATHER_REFRESH_MS));
    await flush();
    expect(result.current.weather).toEqual(RAIN);
    expect(result.current.weatherError).toBeNull();

    fail = true;
    act(() => vi.advanceTimersByTime(WEATHER_REFRESH_MS));
    await flush();
    expect(result.current.weather).toEqual(RAIN);
    expect(result.current.weatherError).toBe("offline");
    unmount();
  });

  it("ignores results that land after unmount and clears its timers", async () => {
    let resolve!: (w: WeatherWire) => void;
    let reject!: (e: unknown) => void;
    let n = 0;
    ipc.handle("village_weather", () => {
      n += 1;
      return new Promise<WeatherWire>((res, rej) => {
        resolve = res;
        reject = rej;
      });
    });
    const errSpy = vi.spyOn(console, "error");
    const a = renderHook(() => useVillageAmbience());
    await flush();
    a.unmount();
    resolve(RAIN);
    await flush();
    expect(a.result.current.weather).toBeNull();

    const b = renderHook(() => useVillageAmbience());
    await flush();
    b.unmount();
    reject("offline");
    await flush();
    expect(b.result.current.weatherError).toBeNull();

    const before = n;
    act(() => vi.advanceTimersByTime(3 * WEATHER_REFRESH_MS));
    setHidden(false);
    await flush();
    expect(n).toBe(before); // no interval or listener survived unmount
    expect(errSpy).not.toHaveBeenCalled();
  });

  it("persists the override and restores it on the next mount", () => {
    ipc.handle("village_weather", () => RAIN);
    const a = renderHook(() => useVillageAmbience());
    act(() => a.result.current.setOverride({ weather: "snow", phase: "night" }));
    expect(a.result.current.override).toEqual({ weather: "snow", phase: "night" });
    expect(JSON.parse(window.localStorage.getItem(AMBIENCE_STORAGE_KEY) as string)).toEqual({
      weather: "snow",
      phase: "night",
    });
    a.unmount();
    const b = renderHook(() => useVillageAmbience());
    expect(b.result.current.override).toEqual({ weather: "snow", phase: "night" });
    b.unmount();
  });

  it("still applies the override when storage throws on write", () => {
    ipc.handle("village_weather", () => RAIN);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceeded");
    });
    const { result, unmount } = renderHook(() => useVillageAmbience());
    act(() => result.current.setOverride({ weather: "clear", phase: "auto" }));
    expect(result.current.override).toEqual({ weather: "clear", phase: "auto" });
    unmount();
  });
});

describe("readStoredOverride", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it("is auto when nothing is stored", () => {
    expect(readStoredOverride()).toEqual(AUTO_OVERRIDE);
  });

  it("is auto for corrupt JSON, non-objects and null", () => {
    for (const raw of ["{nope", "42", "null", '"rain"']) {
      window.localStorage.setItem(AMBIENCE_STORAGE_KEY, raw);
      expect(readStoredOverride()).toEqual(AUTO_OVERRIDE);
    }
  });

  it("keeps valid fields and resets unknown ones to auto", () => {
    window.localStorage.setItem(AMBIENCE_STORAGE_KEY, JSON.stringify({ weather: "storm", phase: "teatime" }));
    expect(readStoredOverride()).toEqual({ weather: "storm", phase: "auto" });
    window.localStorage.setItem(AMBIENCE_STORAGE_KEY, JSON.stringify({ weather: "hail", phase: "dawn" }));
    expect(readStoredOverride()).toEqual({ weather: "auto", phase: "dawn" });
    window.localStorage.setItem(AMBIENCE_STORAGE_KEY, JSON.stringify({ weather: "auto", phase: "auto" }));
    expect(readStoredOverride()).toEqual(AUTO_OVERRIDE);
  });

  it("is auto when storage itself throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(readStoredOverride()).toEqual(AUTO_OVERRIDE);
  });
});

describe("localTimeZone", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the Intl zone", () => {
    expect(localTimeZone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it("falls back to UTC for an empty zone or a throwing Intl", () => {
    const fake = { resolvedOptions: () => ({ timeZone: "" }) } as unknown as Intl.DateTimeFormat;
    vi.spyOn(Intl, "DateTimeFormat").mockReturnValueOnce(fake);
    expect(localTimeZone()).toBe("UTC");
    vi.spyOn(Intl, "DateTimeFormat").mockImplementationOnce(() => {
      throw new RangeError("no Intl");
    });
    expect(localTimeZone()).toBe("UTC");
  });
});
