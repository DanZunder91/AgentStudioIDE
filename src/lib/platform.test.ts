/**
 * platform — `os()` is the one OS answer every UI branch reads. It must follow the
 * webview's user agent and never the machine the tests run on: jsdom's own agent says
 * `win32` / `linux` / `darwin` after Node's `process.platform`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { os } from "./platform";

function as(userAgent: string, platform = ""): void {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent);
  vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
}

afterEach(() => vi.restoreAllMocks());

describe("os", () => {
  it("is macos in WKWebView (Intel and Apple Silicon both say Intel Mac OS X)", () => {
    as("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)", "MacIntel");
    expect(os()).toBe("macos");
  });

  it("is macos from navigator.platform alone, as isMac() always read it", () => {
    as("Mozilla/5.0 AppleWebKit/605.1.15", "MacIntel");
    expect(os()).toBe("macos");
  });

  it("keeps iPhone/iPad in the ⌘ bucket, as isMac() always had them", () => {
    as("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)", "iPad");
    expect(os()).toBe("macos");
  });

  it("is windows in WebView2, x64 and ARM64 alike", () => {
    as("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Edg/131.0.0.0", "Win32");
    expect(os()).toBe("windows");
    as("Mozilla/5.0 (Windows NT 10.0; ARM64) AppleWebKit/537.36 Edg/131.0.0.0", "Win32");
    expect(os()).toBe("windows");
  });

  it("is linux in WebKitGTK", () => {
    as("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)", "Linux x86_64");
    expect(os()).toBe("linux");
    as("Mozilla/5.0 (X11; Ubuntu) AppleWebKit/605.1.15");
    expect(os()).toBe("linux");
  });

  it("never follows jsdom's own agent: win32 / linux / darwin hosts are all 'other'", () => {
    for (const host of ["win32", "linux", "darwin"]) {
      as(`Mozilla/5.0 (${host}) AppleWebKit/537.36 (KHTML, like Gecko) jsdom/26.1.0`);
      expect(os()).toBe("other");
    }
  });
});
