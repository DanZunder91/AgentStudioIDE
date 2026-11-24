/**
 * `browserIpc` — the wire contract for "Open in Browser".
 *
 * Two things here are load-bearing beyond the ordinary marshalling:
 *
 *  1. **The cache is what makes the menu safe.** `ContextMenu` measures and
 *     clamps on `[x, y, anchor]` and focuses on `[activeIndex, openSub]`, so a
 *     submenu that grows after it opens is never re-measured and never gains a
 *     focus ring. The list must therefore be readable SYNCHRONOUSLY when the
 *     items are built — these tests pin that `cachedBrowsers()` is null until
 *     the prime resolves, and that a failed prime leaves it null rather than
 *     poisoning it.
 *  2. **`browserId` is sent as null, never dropped.** Serde reads the NAME; an
 *     omitted key is silently ignored, which would surface as "why does picking
 *     Firefox open Chrome?" — the same trap `fleetIpc`'s `prompt` documents.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installTauriMock, type TauriMock } from "../../test/tauri-mock";
import {
  cachedBrowsers,
  listBrowsers,
  openInBrowser,
  primeBrowsers,
  resetBrowserCache,
  type BrowserChoice,
} from "./browserIpc";

const CHROME: BrowserChoice = { id: "com.google.Chrome", name: "Google Chrome", isDefault: true };
const SAFARI: BrowserChoice = { id: "com.apple.Safari", name: "Safari", isDefault: false };

describe("browserIpc", () => {
  let ipc: TauriMock;

  beforeEach(() => {
    ipc = installTauriMock();
    resetBrowserCache();
  });

  afterEach(() => {
    ipc.reset();
    resetBrowserCache();
  });

  describe("listBrowsers", () => {
    it("invokes `list_browsers` with no arguments and passes the list through", async () => {
      ipc.handle("list_browsers", () => [CHROME, SAFARI]);
      await expect(listBrowsers()).resolves.toEqual([CHROME, SAFARI]);
      expect(ipc.calls("list_browsers")).toHaveLength(1);
    });

    it("passes a rejection through untouched", async () => {
      ipc.handle("list_browsers", () => {
        throw new Error("unknown: lsregister exploded");
      });
      await expect(listBrowsers()).rejects.toThrow("unknown: lsregister exploded");
    });
  });

  describe("openInBrowser", () => {
    it("sends the path and the chosen browser id", async () => {
      ipc.handle("open_in_browser", () => null);
      await openInBrowser("/w/site/index.html", "com.apple.Safari");
      expect(ipc.calls("open_in_browser")[0].args).toEqual({
        path: "/w/site/index.html",
        browserId: "com.apple.Safari",
      });
    });

    it("sends browserId as NULL when none is chosen, not as a missing key", async () => {
      // An omitted key is dropped by the serializer; Rust would then see a
      // deserialization error rather than `None`. The name IS the contract.
      ipc.handle("open_in_browser", () => null);
      await openInBrowser("/w/site/index.html");
      const { args } = ipc.calls("open_in_browser")[0];
      expect(args).toEqual({ path: "/w/site/index.html", browserId: null });
      expect("browserId" in args).toBe(true);
    });

    it("passes Rust's coded rejection through untouched", async () => {
      ipc.handle("open_in_browser", () => {
        throw new Error("out-of-scope: /etc/passwd");
      });
      await expect(openInBrowser("/etc/passwd")).rejects.toThrow("out-of-scope: /etc/passwd");
    });
  });

  describe("the session-long cache", () => {
    it("is null before anything primes it, so the menu shows the default leaf", () => {
      expect(cachedBrowsers()).toBeNull();
    });

    it("holds the list once the prime resolves", async () => {
      ipc.handle("list_browsers", () => [CHROME, SAFARI]);
      await primeBrowsers();
      expect(cachedBrowsers()).toEqual([CHROME, SAFARI]);
    });

    it("fires ONE invoke for concurrent primes, and joins them to one answer", async () => {
      ipc.handle("list_browsers", () => [CHROME]);
      const [a, b, c] = await Promise.all([primeBrowsers(), primeBrowsers(), primeBrowsers()]);
      expect(ipc.calls("list_browsers")).toHaveLength(1);
      expect([a, b, c]).toEqual([[CHROME], [CHROME], [CHROME]]);
    });

    it("does not re-invoke once primed", async () => {
      ipc.handle("list_browsers", () => [CHROME]);
      await primeBrowsers();
      await expect(primeBrowsers()).resolves.toEqual([CHROME]);
      expect(ipc.calls("list_browsers")).toHaveLength(1);
    });

    it("fails SOFT: a rejected prime resolves empty and leaves the cache retryable", async () => {
      let attempt = 0;
      ipc.handle("list_browsers", () => {
        attempt += 1;
        if (attempt === 1) throw new Error("unknown: no LaunchServices");
        return [SAFARI];
      });

      // Enumeration failing must never break the gesture — the "system default"
      // leaf still works, so this resolves rather than rejecting.
      await expect(primeBrowsers()).resolves.toEqual([]);
      expect(cachedBrowsers()).toBeNull();

      // ...and because the failure was not cached, a later prime can succeed.
      await expect(primeBrowsers()).resolves.toEqual([SAFARI]);
      expect(cachedBrowsers()).toEqual([SAFARI]);
      expect(ipc.calls("list_browsers")).toHaveLength(2);
    });

    it("caches an EMPTY list as a real answer, not as a failure", async () => {
      // An OS we have not taught to enumerate returns []; that is an answer, and
      // re-asking on every right-click would be pointless IPC.
      ipc.handle("list_browsers", () => []);
      await primeBrowsers();
      expect(cachedBrowsers()).toEqual([]);
      await primeBrowsers();
      expect(ipc.calls("list_browsers")).toHaveLength(1);
    });
  });
});
