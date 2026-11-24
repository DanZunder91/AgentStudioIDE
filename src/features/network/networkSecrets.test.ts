/** The on-screen credential mask: which names count, and that it is display-only by design. */
import { describe, expect, it } from "vitest";

import { MASK, isSecretHeader, shownValue } from "./networkSecrets";

describe("isSecretHeader", () => {
  it.each([
    ["Authorization", true],
    ["proxy-authorization", true],
    ["Cookie", true],
    ["set-cookie", true],
    ["X-API-Key", true],
    ["api-key", true],
    ["x-auth-token", true],
    ["x-goog-api-key", true],
    ["x-csrf-token", true],
    ["x-ms-authorization-auxiliary", true],
    ["x-client-secret", true],
    ["x-db-password", true],
    ["x-apikey", true],
    // Named "key" but not credentials — a bare `key` match hid these before.
    ["sec-websocket-key", false],
    ["idempotency-key", false],
    ["content-type", false],
    ["accept", false],
  ])("%s → %s", (name, want) => expect(isSecretHeader(name)).toBe(want));
});

describe("shownValue", () => {
  it("masks a secret only while masking is on; other headers are never touched", () => {
    expect(shownValue("authorization", "Bearer x", true)).toBe(MASK);
    expect(shownValue("authorization", "Bearer x", false)).toBe("Bearer x");
    expect(shownValue("accept", "*/*", true)).toBe("*/*");
  });
});
