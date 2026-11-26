import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AUTO_OVERRIDE, type AmbienceOverride } from "./useVillageAmbience";
import { formatClock, phaseFromHour, VillageSkyChip, type VillageSkyChipProps } from "./VillageSkyChip";
import type { WeatherKind, WeatherWire } from "./villageTypes";

const AFTERNOON = new Date(2026, 9, 14, 16, 20);

const RAIN: WeatherWire = {
  kind: "rain",
  intensity: 0.7,
  temperatureC: 17.6,
  wind: 0,
  sunriseMs: null,
  sunsetMs: null,
  place: "Tokyo",
  fetchedAtMs: 1,
};

function setup(over: Partial<VillageSkyChipProps> = {}) {
  const setOverride = vi.fn<(o: AmbienceOverride) => void>();
  const props: VillageSkyChipProps = {
    weather: RAIN,
    weatherError: null,
    override: AUTO_OVERRIDE,
    setOverride,
    now: AFTERNOON,
    ...over,
  };
  const utils = render(<VillageSkyChip {...props} />);
  return { ...utils, setOverride, chip: screen.getByRole("button", { name: /16:20/ }) };
}

describe("VillageSkyChip — chip", () => {
  it("shows live weather, local time, phase, temperature and place", () => {
    const { chip } = setup();
    expect(chip).toHaveTextContent("Rain · 16:20 · Afternoon · 18°C · Tokyo");
    const root = screen.getByTestId("village-sky");
    expect(root).toHaveAttribute("data-weather", "rain");
    expect(root).toHaveAttribute("data-phase", "afternoon");
    expect(root).toHaveClass("village-sky");
    expect(root).not.toHaveClass("village-sky--override");
    expect(chip.querySelector("[data-icon]")).toHaveAttribute("data-icon", "rain");
    expect(chip).toHaveAttribute("aria-expanded", "false");
    expect(chip).not.toHaveAttribute("title");
  });

  it("prefers the resolved phase prop", () => {
    const { chip } = setup({ phase: "dusk", weather: { ...RAIN, kind: "clear" } });
    expect(chip).toHaveTextContent("Clear · 16:20 · Dusk");
    expect(chip.querySelector("[data-icon]")).toHaveAttribute("data-icon", "moon");
  });

  it("omits an unknown temperature and an empty place", () => {
    const { chip } = setup({ weather: { ...RAIN, temperatureC: null, place: "" } });
    expect(chip.textContent).toBe("Rain · 16:20 · Afternoon");
  });

  it("shows the override (and hides live temp/place) with the override hook", () => {
    const { chip } = setup({ override: { weather: "snow", phase: "night" } });
    expect(chip.textContent).toBe("Snow · 16:20 · Night");
    const root = screen.getByTestId("village-sky");
    expect(root).toHaveClass("village-sky--override");
    expect(root).toHaveAttribute("data-weather", "snow");
  });

  it("marks a time-only override as overridden too", () => {
    setup({ override: { weather: "auto", phase: "morning" } });
    expect(screen.getByTestId("village-sky")).toHaveClass("village-sky--override");
  });

  it("degrades to time only, coded, when live weather failed", () => {
    const { chip } = setup({ weather: null, weatherError: "offline" });
    expect(chip.textContent).toBe("16:20 · Afternoon · time only");
    expect(chip).toHaveAttribute("title", "Live weather unavailable (offline)");
    expect(screen.getByTestId("village-sky")).toHaveAttribute("data-weather", "none");
    expect(chip.querySelector("[data-icon]")).toHaveAttribute("data-icon", "clock");
  });

  it("shows just the time while the first report is loading", () => {
    const { chip } = setup({ weather: null });
    expect(chip.textContent).toBe("16:20 · Afternoon");
  });

  it("renders a distinct glyph per weather kind", () => {
    const expected: Record<WeatherKind, string> = {
      clear: "sun",
      cloudy: "cloud",
      fog: "fog",
      drizzle: "drizzle",
      rain: "rain",
      snow: "snow",
      storm: "storm",
    };
    for (const [kind, icon] of Object.entries(expected) as [WeatherKind, string][]) {
      const { unmount } = render(
        <VillageSkyChip
          weather={{ ...RAIN, kind }}
          weatherError={null}
          override={AUTO_OVERRIDE}
          setOverride={() => {}}
          now={AFTERNOON}
        />,
      );
      expect(screen.getByTestId("village-sky").querySelector("[data-icon]")).toHaveAttribute("data-icon", icon);
      unmount();
    }
  });
});

describe("VillageSkyChip — popover", () => {
  it("opens with both selectors, Live checked, and toggles closed", () => {
    const { chip } = setup();
    fireEvent.click(chip);
    expect(chip).toHaveAttribute("aria-expanded", "true");
    const dialog = screen.getByRole("dialog", { name: "Sky" });
    expect(chip).toHaveAttribute("aria-controls", dialog.id);
    const weather = screen.getByRole("radiogroup", { name: "Weather" });
    const time = screen.getByRole("radiogroup", { name: "Time" });
    expect([...weather.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
      "Live",
      "Clear",
      "Cloudy",
      "Rain",
      "Snow",
      "Storm",
      "Fog",
    ]);
    expect([...time.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
      "Live",
      "Morning",
      "Afternoon",
      "Evening",
      "Night",
    ]);
    expect(weather.querySelector('[aria-checked="true"]')).toHaveTextContent("Live");
    expect(time.querySelector('[aria-checked="true"]')).toHaveTextContent("Live");
    expect(screen.queryByTestId("village-sky-error")).toBeNull();
    fireEvent.click(chip);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("picks a weather and a time, keeping the other field", () => {
    const { chip, setOverride } = setup({ override: { weather: "auto", phase: "evening" } });
    fireEvent.click(chip);
    fireEvent.click(screen.getByRole("radio", { name: "Storm" }));
    expect(setOverride).toHaveBeenLastCalledWith({ weather: "storm", phase: "evening" });
    fireEvent.click(screen.getByRole("radio", { name: "Morning" }));
    expect(setOverride).toHaveBeenLastCalledWith({ weather: "auto", phase: "morning" });
    expect(screen.getByRole("radio", { name: "Evening" })).toHaveAttribute("aria-checked", "true");
  });

  it("shows the coded error inside the popover", () => {
    const { chip } = setup({ weather: null, weatherError: "no-place" });
    fireEvent.click(chip);
    expect(screen.getByTestId("village-sky-error")).toHaveTextContent(
      "Live weather unavailable (no-place) — showing time only",
    );
  });

  it("closes on Escape and on an outside pointerdown, not on an inside one", () => {
    const { chip } = setup();
    fireEvent.click(chip);
    fireEvent.keyDown(document, { key: "Enter" });
    fireEvent.pointerDown(screen.getByRole("dialog"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(chip);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("helpers", () => {
  it("phaseFromHour buckets the whole day", () => {
    const got = Array.from({ length: 24 }, (_, h) => phaseFromHour(h));
    expect(got).toEqual([
      "night", "night", "night", "night", "night",
      "dawn", "dawn",
      "morning", "morning", "morning", "morning",
      "noon", "noon",
      "afternoon", "afternoon", "afternoon", "afternoon",
      "evening", "evening",
      "dusk", "dusk",
      "night", "night", "night",
    ]);
  });

  it("formatClock is zero-padded 24 h local time", () => {
    expect(formatClock(new Date(2026, 0, 1, 7, 5))).toBe("07:05");
    expect(formatClock(AFTERNOON)).toBe("16:20");
  });
});
