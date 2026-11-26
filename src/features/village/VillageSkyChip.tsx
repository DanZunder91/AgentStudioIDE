/** HUD sky chip ("Rain · 16:20 · Afternoon · 18°C · Tokyo") with an override popover; props only.
 * Glyphs are inline SVGs, never emoji (`components/icons.tsx`). No `phase`: the override, then the
 * local hour. Root carries EFFECTIVE `data-weather` / `data-phase` and `village-sky--override`. */

import { useEffect, useId, useRef, useState } from "react";

import type { AmbienceOverride } from "./useVillageAmbience";
import type { DayPhase, PhaseOverride, WeatherKind, WeatherOverride, WeatherWire } from "./villageTypes";

export interface VillageSkyChipProps {
  weather: WeatherWire | null;
  weatherError: string | null;
  override: AmbienceOverride;
  setOverride: (o: AmbienceOverride) => void;
  now: Date;
  /** The resolved phase (Ambience.phase). Optional — see the module note. */
  phase?: DayPhase;
}

export const WEATHER_LABEL: Record<WeatherKind, string> = {
  clear: "Clear",
  cloudy: "Cloudy",
  fog: "Fog",
  drizzle: "Drizzle",
  rain: "Rain",
  snow: "Snow",
  storm: "Storm",
};

export const PHASE_LABEL: Record<DayPhase, string> = {
  night: "Night",
  dawn: "Dawn",
  morning: "Morning",
  noon: "Noon",
  afternoon: "Afternoon",
  evening: "Evening",
  dusk: "Dusk",
};

const WEATHER_CHOICES: readonly WeatherOverride[] = ["auto", "clear", "cloudy", "rain", "snow", "storm", "fog"];
const PHASE_CHOICES: readonly PhaseOverride[] = ["auto", "morning", "afternoon", "evening", "night"];

/** Coarse fallback when the host does not pass the resolved phase. */
export function phaseFromHour(hour: number): DayPhase {
  if (hour < 5) return "night";
  if (hour < 7) return "dawn";
  if (hour < 11) return "morning";
  if (hour < 13) return "noon";
  if (hour < 17) return "afternoon";
  if (hour < 19) return "evening";
  if (hour < 21) return "dusk";
  return "night";
}

/** 24 h `HH:MM` in the viewer's LOCAL time — locale-independent, so tests are stable. */
export function formatClock(now: Date): string {
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

const DARK_PHASES: ReadonlySet<DayPhase> = new Set(["night", "dusk", "evening"]);

function glyphBase(name: string) {
  return {
    width: 12,
    height: 12,
    viewBox: "0 0 16 16",
    fill: "none" as const,
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "square" as const,
    "aria-hidden": true,
    focusable: false,
    "data-icon": name,
    className: "village-sky__glyph",
  };
}

const CLOUD = "M4 11h8a3 3 0 0 0 0-6 4 4 0 0 0-7.5 1A2.5 2.5 0 0 0 4 11z";

/** One pixel-ish glyph per weather kind; a clear sky after dark is a moon. */
export function WeatherGlyph({ kind, dark }: { kind: WeatherKind | null; dark: boolean }) {
  switch (kind) {
    case "clear":
      return dark ? (
        <svg {...glyphBase("moon")}>
          <path d="M10 2a6 6 0 1 0 4 10A5 5 0 0 1 10 2z" />
        </svg>
      ) : (
        <svg {...glyphBase("sun")}>
          <rect x="5" y="5" width="6" height="6" />
          <path d="M8 1v2M8 13v2M1 8h2M13 8h2" />
        </svg>
      );
    case "cloudy":
      return (
        <svg {...glyphBase("cloud")}>
          <path d={CLOUD} />
        </svg>
      );
    case "fog":
      return (
        <svg {...glyphBase("fog")}>
          <path d="M2 5h12M4 8h10M2 11h12" />
        </svg>
      );
    case "drizzle":
      return (
        <svg {...glyphBase("drizzle")}>
          <path d={CLOUD} transform="translate(0 -3)" />
          <path d="M5 11v1M9 12v1M12 11v1" />
        </svg>
      );
    case "rain":
      return (
        <svg {...glyphBase("rain")}>
          <path d={CLOUD} transform="translate(0 -3)" />
          <path d="M5 10l-1 4M9 10l-1 4M13 10l-1 4" />
        </svg>
      );
    case "snow":
      return (
        <svg {...glyphBase("snow")}>
          <path d="M8 2v12M3 5l10 6M3 11l10-6" />
        </svg>
      );
    case "storm":
      return (
        <svg {...glyphBase("storm")}>
          <path d={CLOUD} transform="translate(0 -3)" />
          <path d="M9 9l-2 3h3l-2 3" />
        </svg>
      );
    default:
      return (
        <svg {...glyphBase("clock")}>
          <rect x="2" y="2" width="12" height="12" />
          <path d="M8 5v3h3" />
        </svg>
      );
  }
}

export function VillageSkyChip({ weather, weatherError, override, setOverride, now, phase }: VillageSkyChipProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const popId = useId();

  const kind: WeatherKind | null = override.weather !== "auto" ? override.weather : (weather?.kind ?? null);
  const shownPhase: DayPhase = phase ?? (override.phase !== "auto" ? override.phase : phaseFromHour(now.getHours()));
  const overridden = override.weather !== "auto" || override.phase !== "auto";

  const parts: string[] = [];
  if (kind !== null) parts.push(WEATHER_LABEL[kind]);
  parts.push(formatClock(now), PHASE_LABEL[shownPhase]);
  if (override.weather === "auto" && weather !== null) {
    if (weather.temperatureC !== null) parts.push(`${Math.round(weather.temperatureC)}°C`);
    if (weather.place) parts.push(weather.place);
  }
  if (kind === null && weatherError !== null) parts.push("time only");

  useEffect(() => {
    if (!open) return;
    // Mounted while open (the popover is its child), so the ref is set.
    const root = rootRef.current as HTMLDivElement;
    const onDown = (e: PointerEvent) => {
      if (!root.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const className = overridden ? "village-sky village-sky--override" : "village-sky";

  return (
    <div
      ref={rootRef}
      className={className}
      data-testid="village-sky"
      data-weather={kind ?? "none"}
      data-phase={shownPhase}
    >
      <button
        type="button"
        className="village-sky__chip"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popId : undefined}
        title={weatherError !== null ? `Live weather unavailable (${weatherError})` : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        <WeatherGlyph kind={kind} dark={DARK_PHASES.has(shownPhase)} />
        <span className="village-sky__text">{parts.join(" · ")}</span>
      </button>
      {open && (
        <div id={popId} className="village-sky__pop" role="dialog" aria-label="Sky">
          <SkyGroup
            label="Weather"
            choices={WEATHER_CHOICES}
            value={override.weather}
            labelOf={(c) => (c === "auto" ? "Live" : WEATHER_LABEL[c])}
            onPick={(c) => setOverride({ ...override, weather: c })}
          />
          <SkyGroup
            label="Time"
            choices={PHASE_CHOICES}
            value={override.phase}
            labelOf={(c) => (c === "auto" ? "Live" : PHASE_LABEL[c])}
            onPick={(c) => setOverride({ ...override, phase: c })}
          />
          {weatherError !== null && (
            <div className="village-sky__err" role="status" data-testid="village-sky-error">
              Live weather unavailable ({weatherError}) — showing time only
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SkyGroup<T extends string>({
  label,
  choices,
  value,
  labelOf,
  onPick,
}: {
  label: string;
  choices: readonly T[];
  value: T;
  labelOf: (c: T) => string;
  onPick: (c: T) => void;
}) {
  return (
    <div className="village-sky__group">
      <span className="village-sky__label">{label}</span>
      <div className="village-sky__seg" role="radiogroup" aria-label={label}>
        {choices.map((c) => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={c === value}
            className="village-sky__opt"
            onClick={() => onPick(c)}
          >
            {labelOf(c)}
          </button>
        ))}
      </div>
    </div>
  );
}
