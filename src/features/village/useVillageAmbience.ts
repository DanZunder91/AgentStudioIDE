/** Sky data: live weather (`village_weather`) every {@link WEATHER_REFRESH_MS} only while mounted
 * and visible, a {@link CLOCK_TICK_MS} clock, and the per-viewer override (wrapped storage). Errors
 * keep the last good report and surface as a code, never the raw string. */

import { useCallback, useEffect, useRef, useState } from "react";

import { externalErrorCode, villageWeather } from "./villageIpc";
import type { DayPhase, PhaseOverride, WeatherKind, WeatherOverride, WeatherWire } from "./villageTypes";

export const WEATHER_REFRESH_MS = 10 * 60 * 1000;
export const CLOCK_TICK_MS = 30 * 1000;
export const AMBIENCE_STORAGE_KEY = "agentstudio.village.ambience";

export interface AmbienceOverride {
  weather: WeatherOverride;
  phase: PhaseOverride;
}

export const AUTO_OVERRIDE: AmbienceOverride = { weather: "auto", phase: "auto" };

export interface VillageAmbienceState {
  weather: WeatherWire | null;
  weatherError: string | null;
  override: AmbienceOverride;
  setOverride: (o: AmbienceOverride) => void;
  now: Date;
}

const WEATHER_KINDS: readonly WeatherKind[] = ["clear", "cloudy", "fog", "drizzle", "rain", "snow", "storm"];
const DAY_PHASES: readonly DayPhase[] = ["night", "dawn", "morning", "noon", "afternoon", "evening", "dusk"];

function isWeatherOverride(v: unknown): v is WeatherOverride {
  return v === "auto" || (WEATHER_KINDS as readonly unknown[]).includes(v);
}

function isPhaseOverride(v: unknown): v is PhaseOverride {
  return v === "auto" || (DAY_PHASES as readonly unknown[]).includes(v);
}

/** Read the persisted override; anything missing, corrupt or unreadable is "auto". */
export function readStoredOverride(): AmbienceOverride {
  try {
    const raw = window.localStorage.getItem(AMBIENCE_STORAGE_KEY);
    if (raw === null) return AUTO_OVERRIDE;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return AUTO_OVERRIDE;
    const { weather, phase } = parsed as { weather?: unknown; phase?: unknown };
    return {
      weather: isWeatherOverride(weather) ? weather : "auto",
      phase: isPhaseOverride(phase) ? phase : "auto",
    };
  } catch {
    return AUTO_OVERRIDE;
  }
}

function writeStoredOverride(o: AmbienceOverride): void {
  try {
    window.localStorage.setItem(AMBIENCE_STORAGE_KEY, JSON.stringify(o));
  } catch {
    // Private window / blocked storage: the override still applies for this session.
  }
}

/** The viewer's IANA time zone (`"Asia/Tokyo"`); `"UTC"` if Intl cannot say. */
export function localTimeZone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz || "UTC";
  } catch {
    return "UTC";
  }
}

function documentVisible(): boolean {
  return document.visibilityState !== "hidden";
}

export function useVillageAmbience(): VillageAmbienceState {
  const [weather, setWeather] = useState<WeatherWire | null>(null);
  const [weatherError, setWeatherError] = useState<string | null>(null);
  const [override, setOverrideState] = useState<AmbienceOverride>(readStoredOverride);
  const [now, setNow] = useState<Date>(() => new Date());
  const lastAttemptMs = useRef(0);

  useEffect(() => {
    let alive = true;
    const timeZone = localTimeZone();

    const fetchWeather = () => {
      lastAttemptMs.current = Date.now();
      villageWeather(timeZone).then(
        (report) => {
          if (!alive) return;
          setWeather(report);
          setWeatherError(null);
        },
        (err: unknown) => {
          if (!alive) return;
          setWeatherError(externalErrorCode(err));
        },
      );
    };

    fetchWeather();
    const poll = window.setInterval(() => {
      if (documentVisible()) fetchWeather();
    }, WEATHER_REFRESH_MS);
    const clock = window.setInterval(() => setNow(new Date()), CLOCK_TICK_MS);
    const onVisibility = () => {
      if (!documentVisible()) return;
      setNow(new Date());
      if (Date.now() - lastAttemptMs.current >= WEATHER_REFRESH_MS) fetchWeather();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      alive = false;
      window.clearInterval(poll);
      window.clearInterval(clock);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  const setOverride = useCallback((o: AmbienceOverride) => {
    setOverrideState(o);
    writeStoredOverride(o);
  }, []);

  return { weather, weatherError, override, setOverride, now };
}
