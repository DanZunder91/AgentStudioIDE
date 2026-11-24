/**
 * cmTestKit — jsdom harness for real-CM6 tests (test-only; imported exclusively
 * by test files — this directory's find suites and the editor's
 * CodeEditor.test.tsx — never by app code).
 *
 * CM6's EditorView runs fine in jsdom for state/panel/keymap logic, but its
 * async measure cycle calls geometry APIs jsdom does not implement
 * (`Range#getClientRects` / `Range#getBoundingClientRect` throw
 * "not implemented"). The stubs below give them the same answer a zero-layout
 * environment would give anyway: no rectangles. Anything that needs REAL
 * geometry (scroll position of a match, pixel layout of the bar) belongs in
 * the browser tier, not here.
 */

import { EditorState, EditorSelection } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/** Install the geometry stubs jsdom lacks. Call once per test file (beforeAll). */
export function stubGeometry(): void {
  const zeroRect: DOMRect = {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: 0,
    height: 0,
    toJSON: () => ({}),
  };
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => zeroRect;
  if (typeof Element.prototype.scrollIntoView !== "function") {
    Element.prototype.scrollIntoView = () => {};
  }
}

export interface Harness {
  view: EditorView;
  destroy(): void;
}

/** Mount a real EditorView (in document.body, so focus() works) with `extensions`. */
export function makeView(
  doc: string,
  extensions: Extension,
  selection?: { anchor: number; head?: number },
): Harness {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions,
      selection: selection
        ? EditorSelection.single(selection.anchor, selection.head ?? selection.anchor)
        : undefined,
    }),
    parent,
  });
  return {
    view,
    destroy() {
      view.destroy();
      parent.remove();
    },
  };
}

/** Dispatch a keydown the way the browser would (bubbling + cancelable). */
export function pressKey(
  target: EventTarget,
  key: string,
  mods: { ctrl?: boolean; shift?: boolean; meta?: boolean } = {},
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    ctrlKey: !!mods.ctrl,
    shiftKey: !!mods.shift,
    metaKey: !!mods.meta,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

/* Convenience accessors for the bar's pieces. */
export const barOf = (view: EditorView) => view.dom.querySelector<HTMLElement>(".find-bar");
export const inputOf = (view: EditorView) =>
  view.dom.querySelector<HTMLInputElement>(".find-bar__input");
export const countOf = (view: EditorView) =>
  view.dom.querySelector<HTMLElement>(".find-bar__count");
export const toggleOf = (view: EditorView, name: "Match case" | "Words" | "Regex") =>
  view.dom.querySelector<HTMLButtonElement>(`.find-bar__toggle[aria-label="${name}"]`);
export const navOf = (view: EditorView, name: "Previous match" | "Next match") =>
  view.dom.querySelector<HTMLButtonElement>(`.find-bar__nav[aria-label="${name}"]`);
export const closeBtnOf = (view: EditorView) =>
  view.dom.querySelector<HTMLButtonElement>(".find-bar__close");

/** Type into the bar's input like a user would (value + input event). */
export function typeQuery(view: EditorView, text: string): void {
  const input = inputOf(view);
  if (!input) throw new Error("find bar input not present");
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
