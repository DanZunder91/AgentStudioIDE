/** Must follow WebView2's user agent, never the test machine (jsdom says `win32` on Windows). */

import { afterEach, describe, expect, it, vi } from "vitest";

import { isWindowsPlatform } from "./platform";

const as = (ua: string) => vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ua);

afterEach(() => vi.restoreAllMocks());

describe("isWindowsPlatform", () => {
  it("is true in WebView2 on Windows (x64 and ARM64 both say Windows NT)", () => {
    as("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Edg/131.0.0.0");
    expect(isWindowsPlatform()).toBe(true);
  });

  it("is false on macOS and Linux", () => {
    as("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15");
    expect(isWindowsPlatform()).toBe(false);
    as("Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/605.1.15");
    expect(isWindowsPlatform()).toBe(false);
  });

  it("is false under jsdom's own agent, even on a Windows dev box (`win32`)", () => {
    as("Mozilla/5.0 (win32) AppleWebKit/537.36 (KHTML, like Gecko) jsdom/26.1.0");
    expect(isWindowsPlatform()).toBe(false);
  });
});
