/**
 * FindKeysShortcut — bare Cmd/Ctrl+O → quick open, and a Cmd/Ctrl+F no focused
 * surface claimed → Find in Files.
 *
 * The store is REAL (the assertion is `findInFilesOpen` flipping), platform detection
 * is mocked so both modifier rules are drivable in jsdom, and the quick-open request
 * is observed as the window event `<FindFiles/>` listens for (its side of the contract
 * is pinned in `find/FindFiles.test.tsx`).
 */

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const platform = vi.hoisted(() => ({ isMac: vi.fn(() => false) }));
vi.mock("./shortcuts", () => platform);

import { useAppStore } from "../../app/store";
import { resetStore } from "../../test/store-harness";
import { OPEN_FIND_FILES_EVENT } from "../find/FindFiles";
import { bareFindKey, FindKeysShortcut } from "./FindKeysShortcut";

const base = { key: "", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };

/** Dispatch a keydown at `target` (bubbling to window); returns the event. */
function press(init: KeyboardEventInit, target: EventTarget = document.body): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
}

/** Let the post-dispatch fallback timer run. */
const flush = () => act(() => vi.runAllTimers());

const findOpen = () => useAppStore.getState().findInFilesOpen;

let openRequests = 0;
const onOpen = () => openRequests++;

/** Mount `html` into the body and return its first element. */
function mount(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.appendChild(host);
  return host.firstElementChild as HTMLElement;
}

beforeEach(() => {
  resetStore();
  platform.isMac.mockReturnValue(false);
  openRequests = 0;
  window.addEventListener(OPEN_FIND_FILES_EVENT, onOpen);
  vi.useFakeTimers();
});

afterEach(() => {
  window.removeEventListener(OPEN_FIND_FILES_EVENT, onOpen);
  vi.useRealTimers();
  cleanup();
  document.body.innerHTML = "";
});

describe("bareFindKey", () => {
  it("matches only the platform modifier, strictly", () => {
    expect(bareFindKey({ ...base, key: "f", ctrlKey: true }, false)).toBe("f");
    expect(bareFindKey({ ...base, key: "O", ctrlKey: true }, false)).toBe("o");
    expect(bareFindKey({ ...base, key: "f", metaKey: true }, true)).toBe("f");
    expect(bareFindKey({ ...base, key: "o", metaKey: true }, true)).toBe("o");
    // Two-sided: the OTHER platform's modifier is not ours (macOS Ctrl+F/O is readline's).
    expect(bareFindKey({ ...base, key: "f", ctrlKey: true }, true)).toBeNull();
    expect(bareFindKey({ ...base, key: "o", metaKey: true }, false)).toBeNull();
    expect(bareFindKey({ ...base, key: "f", ctrlKey: true, metaKey: true }, false)).toBeNull();
  });

  it("leaves Shift/Alt chords, other letters and unmodified keys alone", () => {
    expect(bareFindKey({ ...base, key: "F", ctrlKey: true, shiftKey: true }, false)).toBeNull();
    expect(bareFindKey({ ...base, key: "o", ctrlKey: true, altKey: true }, false)).toBeNull();
    expect(bareFindKey({ ...base, key: "p", ctrlKey: true }, false)).toBeNull();
    expect(bareFindKey({ ...base, key: "f" }, false)).toBeNull();
  });
});

describe("FindKeysShortcut — Mod+O → quick open", () => {
  it("asks <FindFiles/> to open and keeps the key off the WebView", () => {
    render(<FindKeysShortcut />);
    const e = press({ key: "o", ctrlKey: true });
    expect(openRequests).toBe(1);
    expect(e.defaultPrevented).toBe(true);
  });

  it("uses ⌘O on macOS, and opens even from a focused terminal there", () => {
    platform.isMac.mockReturnValue(true);
    render(<FindKeysShortcut />);
    const term = mount(`<div class="xterm"><textarea></textarea></div>`);
    press({ key: "o", metaKey: true }, term.querySelector("textarea")!);
    expect(openRequests).toBe(1);
    // macOS Ctrl+O stays with the shell.
    press({ key: "o", ctrlKey: true }, term.querySelector("textarea")!);
    expect(openRequests).toBe(1);
  });

  it("leaves Ctrl+O to the shell inside a terminal on Linux/Windows", () => {
    render(<FindKeysShortcut />);
    const term = mount(`<div class="xterm"><textarea></textarea></div>`);
    const e = press({ key: "o", ctrlKey: true }, term.querySelector("textarea")!);
    expect(openRequests).toBe(0);
    expect(e.defaultPrevented).toBe(false);
  });

  it("skips a key a focused surface already handled", () => {
    render(<FindKeysShortcut />);
    const owner = mount(`<div></div>`);
    owner.addEventListener("keydown", (ev) => ev.preventDefault());
    press({ key: "o", ctrlKey: true }, owner);
    expect(openRequests).toBe(0);
  });
});

describe("FindKeysShortcut — unclaimed Mod+F → Find in Files", () => {
  it("opens Find in Files when nothing with focus claims the key", () => {
    render(<FindKeysShortcut />);
    press({ key: "f", ctrlKey: true });
    expect(findOpen()).toBe(false); // decided after dispatch, not during it
    flush();
    expect(findOpen()).toBe(true);
    // An open, not a toggle: a second press keeps it up.
    press({ key: "f", ctrlKey: true });
    flush();
    expect(findOpen()).toBe(true);
  });

  it("yields to a surface that claims it LATER in the same dispatch (the preview's window listener)", () => {
    render(<FindKeysShortcut />);
    // Registered after the host's listener, so it runs after it — the ordering
    // that forced the post-dispatch decision.
    const late = (ev: KeyboardEvent) => ev.preventDefault();
    window.addEventListener("keydown", late);
    press({ key: "f", ctrlKey: true });
    flush();
    window.removeEventListener("keydown", late);
    expect(findOpen()).toBe(false);
  });

  it("yields to a surface that claimed it on the way up (editor / grid / response)", () => {
    render(<FindKeysShortcut />);
    const owner = mount(`<div></div>`);
    owner.addEventListener("keydown", (ev) => ev.preventDefault());
    press({ key: "f", ctrlKey: true }, owner);
    flush();
    expect(findOpen()).toBe(false);
  });

  it("never reaches over a text field the user is typing in", () => {
    render(<FindKeysShortcut />);
    const field = mount(`<input type="text" />`);
    press({ key: "f", ctrlKey: true }, field);
    flush();
    expect(findOpen()).toBe(false);
  });

  it("ignores macOS Ctrl+F (readline's) and fires on ⌘F", () => {
    platform.isMac.mockReturnValue(true);
    render(<FindKeysShortcut />);
    press({ key: "f", ctrlKey: true });
    flush();
    expect(findOpen()).toBe(false);
    press({ key: "f", metaKey: true });
    flush();
    expect(findOpen()).toBe(true);
  });

  it("ignores keys that are not its own, and drops a pending decision on unmount", () => {
    const { unmount } = render(<FindKeysShortcut />);
    press({ key: "p", ctrlKey: true });
    flush();
    expect(findOpen()).toBe(false);
    expect(openRequests).toBe(0);

    press({ key: "f", ctrlKey: true });
    unmount();
    flush();
    expect(findOpen()).toBe(false);
    // And the listener is gone.
    press({ key: "o", ctrlKey: true });
    expect(openRequests).toBe(0);
  });
});
