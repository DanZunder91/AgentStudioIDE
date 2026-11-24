/**
 * Structural contract check for the Agent Village's `village_weather` reply
 * (`villageTypes.ts` `WeatherWire`) — the TS half of `src-tauri/tests/contract_goldens/weather.rs`,
 * which WROTE `goldens/weather.json` from the real `weather::parse_forecast` over the recorded
 * Open-Meteo bodies in `src-tauri/tests/fixtures/weather/`.
 *
 * Both directions, the `wireShape.test.ts` way: the SHAPE table is typed
 * `Record<keyof WeatherWire, Json>` (a TS field without a row, or a row without a TS field, is a
 * compile error), and every golden object must carry EXACTLY those keys with those JSON types.
 * Every `kind` must be a spelling the TS union names. Expectations are written by hand.
 */

import { describe, expect, it } from "vitest";

import type { WeatherKind, WeatherWire } from "../../features/village/villageTypes";
import golden from "./goldens/weather.json";

type Json = "number" | "string" | "number|null";

const WIRE: Record<keyof WeatherWire, Json> = {
  kind: "string",
  intensity: "number",
  temperatureC: "number|null",
  wind: "number",
  sunriseMs: "number|null",
  sunsetMs: "number|null",
  place: "string",
  fetchedAtMs: "number",
};

/** Exhaustive: a union member missing here is a compile error. */
const KINDS: Record<WeatherKind, true> = {
  clear: true,
  cloudy: true,
  fog: true,
  drizzle: true,
  rain: true,
  snow: true,
  storm: true,
};

function jsonType(v: unknown): string {
  return v === null ? "null" : typeof v;
}

const scenarios = golden as unknown as Record<string, WeatherWire>;

describe("weather golden ↔ villageTypes", () => {
  it("covers the scenarios Rust writes", () => {
    expect(Object.keys(scenarios).sort()).toEqual(["clear", "fog", "rain", "snow", "sparse", "storm"]);
  });

  it("every report has exactly the TS keys, JSON types and a known kind", () => {
    for (const [name, w] of Object.entries(scenarios)) {
      const obj = w as unknown as Record<string, unknown>;
      expect(Object.keys(obj).sort(), `${name}: keys`).toEqual(Object.keys(WIRE).sort());
      for (const [key, want] of Object.entries(WIRE)) {
        expect(want.split("|"), `${name}.${key}`).toContain(jsonType(obj[key]));
      }
      expect(KINDS[w.kind], `${name}.kind = ${w.kind}`).toBe(true);
    }
  });

  it("keeps values in the ranges the renderer assumes", () => {
    for (const [name, w] of Object.entries(scenarios)) {
      expect(w.intensity, name).toBeGreaterThanOrEqual(0);
      expect(w.intensity, name).toBeLessThanOrEqual(1);
      expect(Math.abs(w.wind), name).toBeLessThanOrEqual(1);
      if (w.sunriseMs !== null && w.sunsetMs !== null) {
        expect(w.sunriseMs, name).toBeLessThan(w.sunsetMs);
        // Epoch MILLISECONDS, not seconds: after 2001 in ms.
        expect(w.sunriseMs, name).toBeGreaterThan(1e12);
      }
      expect(w.fetchedAtMs, name).toBeGreaterThan(1e12);
      expect(w.place, name).not.toContain("/");
    }
  });

  it("pins the hand-checked mapping", () => {
    expect(scenarios.rain).toMatchObject({ kind: "rain", place: "Vancouver", temperatureC: 12 });
    // A south-west wind blows the rain to the right.
    expect(scenarios.rain.wind).toBeGreaterThan(0);
    expect(scenarios.clear).toMatchObject({ kind: "clear", intensity: 0 });
    // An east wind blows to the left.
    expect(scenarios.clear.wind).toBeLessThan(0);
    expect(scenarios.storm).toMatchObject({ kind: "storm", intensity: 1, wind: 1, place: "New York" });
    expect(scenarios.snow.kind).toBe("snow");
    expect(scenarios.fog.kind).toBe("fog");
    expect(scenarios.sparse).toMatchObject({
      kind: "drizzle",
      temperatureC: null,
      wind: 0,
      sunriseMs: null,
      sunsetMs: null,
    });
  });
});
