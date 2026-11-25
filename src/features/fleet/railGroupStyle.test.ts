import { describe, expect, it } from "vitest";

import {
  DEFAULT_RAIL_GROUP_STYLE,
  parseRailGroupStyle,
  RAIL_GROUP_STYLE_OPTIONS,
  RAIL_GROUP_STYLES,
  railGroupStyleLabel,
} from "./railGroupStyle";

describe("railGroupStyle", () => {
  it("defaults to Framed card", () => {
    expect(DEFAULT_RAIL_GROUP_STYLE).toBe("card");
    expect(railGroupStyleLabel(DEFAULT_RAIL_GROUP_STYLE)).toBe("Framed card");
  });

  it("offers every style exactly once, in the order Settings lists them", () => {
    expect(RAIL_GROUP_STYLE_OPTIONS.map((o) => o.value)).toEqual([...RAIL_GROUP_STYLES]);
    expect(RAIL_GROUP_STYLE_OPTIONS.map((o) => o.label)).toEqual([
      "Framed card",
      "Inset well",
      "Labelled divider",
      "Pinned header bar",
    ]);
    for (const option of RAIL_GROUP_STYLE_OPTIONS) expect(option.hint.length).toBeGreaterThan(0);
  });

  it("parses each known style as itself", () => {
    for (const style of RAIL_GROUP_STYLES) expect(parseRailGroupStyle(style)).toBe(style);
  });

  it("parses anything else as the default, so an unknown value never leaves the rail unstyled", () => {
    for (const value of [undefined, null, "", "CARD", "orbit", 3, {}, ["card"]]) {
      expect(parseRailGroupStyle(value), JSON.stringify(value)).toBe("card");
    }
  });
});
