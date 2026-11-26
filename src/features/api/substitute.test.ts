/** Secret safety rides on this: collections hold {{TOKEN}}, the value exists only on the wire.
 * A malformed lone `{{` must be left alone, not eaten. */

import { describe, expect, it } from "vitest";

import { activeVars, substituteVars } from "./substitute";
import type { Environment } from "./apiStoreIpc";

describe("substituteVars", () => {
  it("replaces a present key with its value", () => {
    expect(substituteVars("Bearer {{TOKEN}}", { TOKEN: "abc123" })).toBe("Bearer abc123");
  });

  it("replaces an unset key with the empty string (never the literal 'undefined')", () => {
    expect(substituteVars("Bearer {{TOKEN}}", {})).toBe("Bearer ");
    expect(substituteVars("Bearer {{TOKEN}}", { OTHER: "x" })).toBe("Bearer ");
  });

  it("trims whitespace inside the braces before the lookup", () => {
    expect(substituteVars("{{ TOKEN }}", { TOKEN: "v" })).toBe("v");
    expect(substituteVars("{{\tHOST\t}}", { HOST: "api.test" })).toBe("api.test");
  });

  it("replaces every occurrence, across multiple distinct keys", () => {
    const out = substituteVars("https://{{HOST}}/{{PATH}}?k={{HOST}}", {
      HOST: "api.test",
      PATH: "things",
    });
    expect(out).toBe("https://api.test/things?k=api.test");
  });

  it("leaves a truly malformed lone `{{` (no closing braces) untouched", () => {
    expect(substituteVars("a {{ b", { b: "X" })).toBe("a {{ b");
    expect(substituteVars("only one brace }", {})).toBe("only one brace }");
    expect(substituteVars("{{unterminated", { unterminated: "X" })).toBe("{{unterminated");
  });

  it("returns text with no placeholders unchanged", () => {
    expect(substituteVars("plain text", { TOKEN: "x" })).toBe("plain text");
    expect(substituteVars("", { TOKEN: "x" })).toBe("");
  });

  it("resolves an empty-key placeholder to empty (no matching var)", () => {
    expect(substituteVars("x{{}}y", {})).toBe("xy");
  });
});

describe("activeVars", () => {
  const envs: Environment[] = [
    { id: "e1", name: "prod", variables: [{ key: "TOKEN", value: "secret" }, { key: "HOST", value: "api.test" }] },
    { id: "e2", name: "dev", variables: [] },
  ];

  it("builds the active environment's key→value map", () => {
    expect(activeVars({ apiEnvironments: envs, activeEnvironmentId: "e1" })).toEqual({
      TOKEN: "secret",
      HOST: "api.test",
    });
  });

  it("returns {} when no environment is active", () => {
    expect(activeVars({ apiEnvironments: envs, activeEnvironmentId: null })).toEqual({});
  });

  it("returns {} when the active id matches no environment", () => {
    expect(activeVars({ apiEnvironments: envs, activeEnvironmentId: "gone" })).toEqual({});
  });

  it("feeds substituteVars end-to-end (the on-wire splice)", () => {
    const vars = activeVars({ apiEnvironments: envs, activeEnvironmentId: "e1" });
    expect(substituteVars("https://{{HOST}}?t={{TOKEN}}", vars)).toBe("https://api.test?t=secret");
  });
});
