/**
 * `extractPath` — the capture half of a request sequence.
 *
 * The reasons are tested as hard as the values, and that is the point of the
 * module: `substituteVars` turns an unresolved `{{VAR}}` into the empty string
 * silently (`substitute.test.ts:21`), so a capture that fails without saying why
 * would send `Authorization: Bearer ` and leave the user debugging a 401 in their
 * own API. Every `found: false` here has to name where the walk stopped.
 */

import { describe, expect, it } from "vitest";

import { extractPath } from "./extractPath";

/** A response body shaped like a real auth reply. */
const BODY = {
  data: { jwt: "eyJhbGciOiJIUzI1", expiresIn: 3600, admin: false, nested: { deep: "x" } },
  items: [{ id: "a1" }, { id: "b2" }],
  empty: [],
  nothing: null,
};

describe("extractPath — finding a value", () => {
  it("walks a dotted path to a string", () => {
    expect(extractPath(BODY, "data.jwt")).toEqual({ found: true, value: "eyJhbGciOiJIUzI1" });
  });

  it("accepts a leading body. prefix, because that is what the editor shows", () => {
    // Same answer either way — the prefix is a convenience, not a second meaning.
    expect(extractPath(BODY, "body.data.jwt")).toEqual(extractPath(BODY, "data.jwt"));
  });

  it("still reaches a field genuinely NAMED body", () => {
    // Two-sided against the prefix rule above: stripping must not make a real
    // `body` field unreachable.
    expect(extractPath({ body: { token: "t" } }, "body.body.token")).toEqual({
      found: true,
      value: "t",
    });
  });

  it("indexes arrays, alone and mixed with keys", () => {
    expect(extractPath(BODY, "items[0].id")).toEqual({ found: true, value: "a1" });
    expect(extractPath(BODY, "items[1].id")).toEqual({ found: true, value: "b2" });
    expect(extractPath([{ v: 9 }], "[0].v")).toEqual({ found: true, value: "9" });
  });

  it("stringifies a number and a boolean predictably", () => {
    // These are legitimate captures — an id, a flag — and they end up in a URL
    // or a header, so they must become the text the user would have typed.
    expect(extractPath(BODY, "data.expiresIn")).toEqual({ found: true, value: "3600" });
    expect(extractPath(BODY, "data.admin")).toEqual({ found: true, value: "false" });
  });

  it("reaches an arbitrarily deep key", () => {
    expect(extractPath(BODY, "data.nested.deep")).toEqual({ found: true, value: "x" });
  });
});

describe("extractPath — refusing, with a reason that names where it stopped", () => {
  it("says which key was missing, and where", () => {
    const r = extractPath(BODY, "data.refresh");
    expect(r.found).toBe(false);
    expect(r).toMatchObject({ reason: expect.stringContaining("refresh") });
    // The reason must locate the failure, not just name the key.
    expect(r).toMatchObject({ reason: expect.stringContaining("data") });
  });

  it("names the response body itself when the FIRST key is missing", () => {
    expect(extractPath(BODY, "token")).toEqual({
      found: false,
      reason: 'the response body has no "token"',
    });
  });

  it("refuses null rather than letting it become an empty credential", () => {
    // The whole reason this module exists: a captured null must not silently
    // become "" and get sent as `Bearer `.
    expect(extractPath(BODY, "nothing")).toEqual({ found: false, reason: '"nothing" is null' });
  });

  it("refuses an object or an array — a capture is a single value", () => {
    expect(extractPath(BODY, "data")).toMatchObject({
      found: false,
      reason: expect.stringContaining("an object"),
    });
    expect(extractPath(BODY, "items")).toMatchObject({
      found: false,
      reason: expect.stringContaining("an array"),
    });
  });

  it("reports an out-of-range index WITH the real length", () => {
    expect(extractPath(BODY, "items[5].id")).toEqual({
      found: false,
      reason: '"items" has 2 items, so [5] is out of range',
    });
    expect(extractPath(BODY, "empty[0]")).toEqual({
      found: false,
      reason: '"empty" has 0 items, so [0] is out of range',
    });
  });

  it("uses the singular for a one-item array", () => {
    expect(extractPath({ xs: [1] }, "xs[3]")).toEqual({
      found: false,
      reason: '"xs" has 1 item, so [3] is out of range',
    });
  });

  it("says so when a path indexes something that is not an array", () => {
    expect(extractPath(BODY, "data[0]")).toEqual({
      found: false,
      reason: '"data" is an object, not an array',
    });
  });

  it("says so when a path keys into a scalar", () => {
    expect(extractPath(BODY, "data.jwt.length")).toMatchObject({
      found: false,
      reason: expect.stringContaining("a string"),
    });
  });

  it("walks into null mid-path and says which segment was null", () => {
    expect(extractPath({ a: null }, "a.b")).toEqual({ found: false, reason: '"a" is null' });
  });

  it("rejects a malformed path as a typo rather than matching nothing", () => {
    for (const bad of ["", "   ", ".", "a.", ".a", "a..b", "a[", "a[x]", "a[-1]", "a]", "a[0]b"]) {
      const r = extractPath(BODY, bad);
      expect(r.found, `"${bad}" must be refused`).toBe(false);
      expect(r).toMatchObject({ reason: expect.stringContaining("not a valid path") });
    }
  });

  it("refuses a key that EXISTS but holds undefined", () => {
    // `JSON.parse` never produces undefined, but this is exported and typed
    // `unknown`, so a non-JSON caller can reach it — and it must not become "".
    expect(extractPath({ a: undefined }, "a")).toEqual({ found: false, reason: '"a" is missing' });
  });

  it("handles a null or undefined ROOT without throwing", () => {
    // A 204 with no body parses to nothing; the capture must fail calmly.
    expect(extractPath(null, "a")).toEqual({ found: false, reason: "the response body is null" });
    expect(extractPath(undefined, "a")).toEqual({
      found: false,
      reason: "the response body is missing",
    });
  });
});
