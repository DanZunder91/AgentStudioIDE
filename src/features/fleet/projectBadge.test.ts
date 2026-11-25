import { describe, expect, it } from "vitest";

import { PROJECT_COLORS, projectColor, projectMonogram } from "./projectBadge";

describe("projectMonogram", () => {
  it.each([
    ["AgentStudioIDE", "AS"],
    ["docs-site", "DS"],
    ["api_gateway", "AG"],
    ["my.project", "MP"],
    ["two words", "TW"],
    ["to3D", "T3"],
    ["v2api", "V2"],
    ["gazelle", "GA"],
    ["x", "X"],
    ["ünicode-tool", "ÜT"],
  ])("%s → %s", (name, expected) => {
    expect(projectMonogram(name)).toBe(expected);
  });

  it("never returns an empty badge", () => {
    expect(projectMonogram("")).toBe("?");
    expect(projectMonogram("---")).toBe("?");
  });
});

describe("projectColor", () => {
  it("is stable for a path and always one of the palette's colours", () => {
    for (const path of ["/w/a", "/Users/me/AgentStudioIDE", "C:\\code\\docs-site"]) {
      expect(projectColor(path)).toBe(projectColor(path));
      expect(PROJECT_COLORS).toContain(projectColor(path));
    }
  });

  it("spreads different projects across the palette rather than giving them all one colour", () => {
    const paths = Array.from({ length: 60 }, (_, i) => `/w/project-${i}`);
    const used = new Set(paths.map(projectColor));
    expect(used.size).toBe(PROJECT_COLORS.length);
  });
});
