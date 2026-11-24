/**
 * `useVillageAmbience` — the DATA side of the village sky (weather and
 * time of day that follow the user's local conditions — rain when it rains, afternoon in the afternoon).
 *
 * It owns three things and nothing else:
 *   - the LIVE weather report (`village_weather`), fetched on mount and every
 *     {@link WEATHER_REFRESH_MS} while the tab is mounted AND the document is visible — a
 *     hidden window does not poll a weather service for a sky nobody sees. Coming back to a
 *     visible window refetches only when the last attempt is stale;
 *   - the local clock `now`, ticked every {@link CLOCK_TICK_MS} (phase changes are minutes
 *     apart, so a 30 s tick is plenty and keeps React work negligible);
 *   - the HUD override ({@link AmbienceOverride}), persisted per viewer under
 *     {@link AMBIENCE_STORAGE_KEY}. Storage is a convenience: every access is wrapped, and a
 *     throwing / empty / corrupt store simply means "auto".
 *
 * Turning that into an {@link Ambience} (phase, grade, particles) is the engine's job — this
 * hook stays pure plumbing so the sky maths is unit-tested without React.
 *
 * Errors keep the last good report (a stale sky beats a blank one) and surface as a CODE
 * (`externalErrorCode`), never the raw string — the HUD shows "time only" gracefully.
 */

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
