/**
 * Helpers for the real-browser tier: drive the app's DnD gesture and read back
 * REAL pixel geometry.
 *
 * Everything here is deliberately measurement-based. Under jsdom these helpers
 * would all report 0 and every caller would be vacuously green — which is why
 * they live in a `-browser` file and are only imported by `*.browser.test.tsx`.
 */

import { act } from "@testing-library/react";

import { getTerminal } from "../features/terminal";
import { useAppStore } from "../app/store";
import type { PaneId, TabId, TerminalId } from "../app/types";
import { TAB_DND_MIME } from "../components/TabBar";

/** Where on the target pane's body the tab is dropped. */
export type Edge = "left" | "right" | "top" | "bottom";

/**
 * A point inside `rect` that `zoneFor()` resolves to `edge`.
 *
 * `zoneFor` calls an edge when the nearest normalized edge distance is <=
 * EDGE_RATIO (0.25), so 10% in from the chosen side is comfortably inside the
 * band while the orthogonal axis sits at the midpoint (0.5) and cannot win the
 * "nearest" contest.
 */
export function pointOnEdge(rect: DOMRect, edge: Edge): { clientX: number; clientY: number } {
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  switch (edge) {
    case "left":
      return { clientX: rect.left + rect.width * 0.1, clientY: cy };
    case "right":
      return { clientX: rect.left + rect.width * 0.9, clientY: cy };
    case "top":
      return { clientX: cx, clientY: rect.top + rect.height * 0.1 };
    case "bottom":
      return { clientX: cx, clientY: rect.top + rect.height * 0.9 };
  }
}

/**
 * A drag in progress, so a test can inspect the preview BETWEEN the dragover
 * and the drop — which is the only moment the preview exists, and therefore the
 * only moment its correctness is observable.
 *
 * Uses real `DragEvent`s carrying one real `DataTransfer` across the whole
 * gesture — exactly as the browser threads it through a native drag — so the
 * component's `setData`/`types`/`getData` path is the one under test rather
 * than a hand-rolled stand-in. React's root-level delegation picks these up.
 *
 * Note the browser's own rule, which the components are built around: during
 * `dragover` the drag data store is in **protected mode**, so `getData()`
 * returns `""` and only `types` is readable. These helpers reproduce that
 * faithfully by threading one real `DataTransfer` through, rather than a stub
 * that would happily hand `getData()` back early and hide the constraint.
 */
export class DragGesture {
  readonly dataTransfer = new DataTransfer();
  constructor(private readonly source: HTMLElement) {}

  async start(): Promise<this> {
    await act(async () => {
      this.source.dispatchEvent(
        new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: this.dataTransfer }),
      );
    });
    return this;
  }

  async over(target: HTMLElement, edge: Edge): Promise<this> {
    const at = pointOnEdge(target.getBoundingClientRect(), edge);
    await act(async () => {
      target.dispatchEvent(
        new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: this.dataTransfer, ...at }),
      );
    });
    return this;
  }

  async drop(target: HTMLElement, edge: Edge): Promise<this> {
    const at = pointOnEdge(target.getBoundingClientRect(), edge);
    await act(async () => {
      target.dispatchEvent(
        new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: this.dataTransfer, ...at }),
      );
    });
    await act(async () => {
      this.source.dispatchEvent(
        new DragEvent("dragend", { bubbles: true, cancelable: true, dataTransfer: this.dataTransfer }),
      );
    });
    return this;
  }
}

/** The whole gesture, for tests that only care about the result. */
export async function dragTabToEdge(tab: HTMLElement, targetBody: HTMLElement, edge: Edge): Promise<void> {
  const g = await new DragGesture(tab).start();
  await g.over(targetBody, edge);
  await g.drop(targetBody, edge);
}

/** The live drop-preview overlay, if one is shown. */
export function dropPreview(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-testid='drop-zone']");
}

/** The MIME the tab strip publishes — re-exported so tests assert on the real one. */
export { TAB_DND_MIME };

/** Every rendered leaf pane, in DOM order. */
export function panes(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(".pane")];
}

/** The `.pane` element whose tab strip holds `tabId`. */
export function paneOfTab(tabId: TabId): HTMLElement {
  const title = useAppStore.getState().tabs[tabId]?.title;
  for (const pane of panes()) {
    for (const tab of pane.querySelectorAll<HTMLElement>(".pane-tab")) {
      if (tab.title === title) return pane;
    }
  }
  throw new Error(`no rendered pane holds tab ${tabId} (${title})`);
}

/** The draggable tab element for `tabId`. */
export function tabElement(tabId: TabId): HTMLElement {
  const title = useAppStore.getState().tabs[tabId]?.title;
  const found = [...document.querySelectorAll<HTMLElement>(".pane-tab")].find((t) => t.title === title);
  if (!found) throw new Error(`no rendered tab for ${tabId} (${title})`);
  return found;
}

/** The pane body — the box `zoneFor()` hit-tests against. */
export function bodyOf(pane: HTMLElement): HTMLElement {
  const body = pane.querySelector<HTMLElement>(".pane__body");
  if (!body) throw new Error("pane has no body");
  return body;
}

/** The `.split-view` element allotment renders for the root split, if any. */
export function rootSplitView(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".center .split-view");
}

export interface Geometry {
  width: number;
  height: number;
  left: number;
  top: number;
}

export const geometryOf = (el: Element): Geometry => {
  const r = el.getBoundingClientRect();
  return { width: r.width, height: r.height, left: r.left, top: r.top };
};

/** `{ cols, rows }` of the live xterm behind a terminal id. */
export function terminalSize(terminalId: TerminalId): { cols: number; rows: number } {
  const term = getTerminal(terminalId);
  if (!term) throw new Error(`no live terminal ${terminalId}`);
  return { cols: term.cols, rows: term.rows };
}

/** The TerminalId a tab points at. */
export function terminalIdOfTab(tabId: TabId): TerminalId {
  const ref = useAppStore.getState().tabs[tabId]?.ref;
  if (!ref || (ref.kind !== "terminal" && ref.kind !== "agent-terminal")) {
    throw new Error(`tab ${tabId} has no terminal`);
  }
  return ref.terminalId;
}

/** Leaf pane ids in visual order, straight from the store. */
export function leafPaneIds(): PaneId[] {
  const walk = (n: ReturnType<typeof useAppStore.getState>["layout"]): PaneId[] =>
    n.type === "leaf" ? [n.id] : n.children.flatMap(walk);
  return walk(useAppStore.getState().layout);
}
