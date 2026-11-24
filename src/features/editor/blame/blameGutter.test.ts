/**
 * `blameGutter` — the DOM half of the annotate view, under jsdom.
 *
 * The popover controller is plain DOM + timers, so its show/hide rules are fully
 * assertable here: the ~150 ms hover delay, the leave-before-it-fires cancel,
 * the marker→popover travel grace, and the Esc/scroll dismissal. The gutter
 * extension itself is smoke-tested against a real EditorView (CM6 constructs
 * under jsdom); pixel-true gutter geometry lives in the browser tier
 * (`blameGutter.browser.test.tsx`).
 */

import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BlamePopoverModel } from "./blame";
import {
  BlamePopover,
  blameSupport,
  hideBlame,
  POPOVER_HIDE_MS,
  POPOVER_SHOW_MS,
  showBlame,
} from "./blameGutter";
import type { FileBlame } from "./blameIpc";

const MODEL: BlamePopoverModel = {
  hash: "8f3a2c1d9e0b7a6f5c4d3e2b1a0f9e8d7c6b5a49",
  author: "Max Turing <max@example.com>",
  date: "May 27, 2026, 3:41:22 PM",
  path: "src/a.ts",
  message: "feat: blame\n\nIntelliJ-style annotate.",
};

const popoverEl = (): HTMLElement | null =>
  document.querySelector<HTMLElement>(".blame-popover");

describe("BlamePopover", () => {
  let popover: BlamePopover;
  let anchor: HTMLElement;

  beforeEach(() => {
    vi.useFakeTimers();
    popover = new BlamePopover();
    anchor = document.body.appendChild(document.createElement("span"));
  });
  afterEach(() => {
    popover.hide();
    anchor.remove();
    vi.useRealTimers();
  });

  it("shows after the hover delay — not immediately — with the full commit", () => {
    popover.scheduleShow(anchor, MODEL);
    expect(popoverEl()).toBeNull(); // still within the delay

    vi.advanceTimersByTime(POPOVER_SHOW_MS);
    const el = popoverEl();
    expect(el).not.toBeNull();
    expect(el!.getAttribute("role")).toBe("tooltip");
    expect(el!.querySelector(".blame-popover__hash")!.textContent).toBe(
      `commit ${MODEL.hash}`,
    );
    const meta = [...el!.querySelectorAll(".blame-popover__meta")].map((m) => m.textContent);
    expect(meta).toEqual([
      "Author: Max Turing <max@example.com>",
      "Date: May 27, 2026, 3:41:22 PM",
      "Path: src/a.ts",
    ]);
    // The FULL message, in a pre-wrap block, set as TEXT (markup must not run).
    expect(el!.querySelector("pre.blame-popover__message")!.textContent).toBe(MODEL.message);
  });

  it("renders a malicious commit message as text, not as markup", () => {
    popover.scheduleShow(anchor, { ...MODEL, message: '<img src=x onerror="boom()">' });
    vi.advanceTimersByTime(POPOVER_SHOW_MS);
    expect(popoverEl()!.querySelector("img")).toBeNull();
    expect(popoverEl()!.textContent).toContain('<img src=x onerror="boom()">');
  });

  it("a leave BEFORE the delay elapses cancels the pending show", () => {
    popover.scheduleShow(anchor, MODEL);
    popover.scheduleHide(); // mouse swept off the marker at ~half the delay
    vi.advanceTimersByTime(POPOVER_SHOW_MS * 10);
    expect(popoverEl()).toBeNull();
  });

  it("survives the marker→popover travel (keepOpen cancels the grace hide)", () => {
    popover.scheduleShow(anchor, MODEL);
    vi.advanceTimersByTime(POPOVER_SHOW_MS);

    popover.scheduleHide(); // left the marker…
    popover.keepOpen(); // …and entered the popover within the grace period
    vi.advanceTimersByTime(POPOVER_HIDE_MS * 10);
    expect(popoverEl()).not.toBeNull(); // still up

    popover.scheduleHide(); // now left the popover too
    vi.advanceTimersByTime(POPOVER_HIDE_MS);
    expect(popoverEl()).toBeNull();
  });

  it("wires those two rules to the popover's own mouseenter/mouseleave", () => {
    popover.scheduleShow(anchor, MODEL);
    vi.advanceTimersByTime(POPOVER_SHOW_MS);
    const el = popoverEl()!;

    popover.scheduleHide(); // left the marker
    el.dispatchEvent(new MouseEvent("mouseenter")); // pointer arrived on the popover
    vi.advanceTimersByTime(POPOVER_HIDE_MS * 10);
    expect(popoverEl()).not.toBeNull();

    el.dispatchEvent(new MouseEvent("mouseleave"));
    vi.advanceTimersByTime(POPOVER_HIDE_MS);
    expect(popoverEl()).toBeNull();
  });

  it("dismisses on Escape", () => {
    popover.scheduleShow(anchor, MODEL);
    vi.advanceTimersByTime(POPOVER_SHOW_MS);
    expect(popoverEl()).not.toBeNull();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(popoverEl()).toBeNull();
    // …and the document listeners are gone: a later Escape must not throw.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  });

  it("ignores other keys", () => {
    popover.scheduleShow(anchor, MODEL);
    vi.advanceTimersByTime(POPOVER_SHOW_MS);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    expect(popoverEl()).not.toBeNull();
  });

  it("dismisses on any scroll (capture-phase, so inner scrollers count)", () => {
    popover.scheduleShow(anchor, MODEL);
    vi.advanceTimersByTime(POPOVER_SHOW_MS);
    expect(popoverEl()).not.toBeNull();

    const scroller = document.body.appendChild(document.createElement("div"));
    scroller.dispatchEvent(new Event("scroll", { bubbles: false }));
    expect(popoverEl()).toBeNull();
    scroller.remove();
  });

  it("keeps at most one popover: a second show replaces the first", () => {
    popover.scheduleShow(anchor, MODEL);
    vi.advanceTimersByTime(POPOVER_SHOW_MS);

    popover.scheduleShow(anchor, { ...MODEL, hash: "second" });
    vi.advanceTimersByTime(POPOVER_SHOW_MS);

    const els = document.querySelectorAll(".blame-popover");
    expect(els).toHaveLength(1);
    expect(els[0].querySelector(".blame-popover__hash")!.textContent).toBe("commit second");
  });

  it("hide() is safe when nothing is showing", () => {
    expect(() => popover.hide()).not.toThrow();
  });
});

describe("showBlame / hideBlame (compartment seam)", () => {
  const BLAME: FileBlame = {
    relPath: "src/a.ts",
    commits: [
      {
        id: "8f3a2c1d9e0b7a6f5c4d3e2b1a0f9e8d7c6b5a49",
        author: "Max Turing",
        email: "max@example.com",
        timeMs: new Date(2026, 4, 27, 12).getTime(),
        summary: "feat: blame",
        message: "feat: blame\n",
      },
    ],
    lines: [0, 0], // deliberately SHORTER than the 3-line doc — the clamp path
  };

  let view: EditorView;
  beforeEach(() => {
    view = new EditorView({ doc: "one\ntwo\nthree", extensions: [blameSupport] });
    document.body.appendChild(view.dom);
  });
  afterEach(() => {
    view.destroy();
  });

  it("adds the gutter on show and removes it on hide, without recreating the view", () => {
    expect(view.dom.querySelector(".cm-blame-gutter")).toBeNull();

    showBlame(view, BLAME);
    expect(view.dom.querySelector(".cm-blame-gutter")).not.toBeNull();

    hideBlame(view);
    expect(view.dom.querySelector(".cm-blame-gutter")).toBeNull();
  });

  it("does not crash on a blame shorter than the document (clamped)", () => {
    expect(() => showBlame(view, BLAME)).not.toThrow();
    // Line 3 has no blame entry → it renders like an uncommitted line if the
    // marker is materialized (jsdom may not lay out the viewport; the label
    // itself is pinned by blame.test.ts and the browser tier).
  });

  it("does not crash on a blame LONGER than the document (clamped)", () => {
    const long: FileBlame = { ...BLAME, lines: [0, 0, 0, 0, 0, 0, 0, 0] };
    expect(() => showBlame(view, long)).not.toThrow();
  });

  it("no-ops on a null view (editor not created yet / already disposed)", () => {
    expect(() => showBlame(null, BLAME)).not.toThrow();
    expect(() => hideBlame(null)).not.toThrow();
  });
});
