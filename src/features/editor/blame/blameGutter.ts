/**
 * Blame gutter — the CM6/DOM glue for the annotate view.
 *
 * Thin by design: every label/run/clamp decision is a pure function in
 * `blame.ts`; this file only (a) renders those labels as a `gutter()` placed
 * LEFT of the line numbers, and (b) owns the hover popover ("step on the name →
 * see the commit").
 *
 * The gutter lives in a module-level `Compartment` that `EditorRegistry`
 * includes (empty) in every view, so toggling blame is a `reconfigure` — the
 * view, its buffer, undo history, and scroll position are never recreated.
 *
 * Popover behavior:
 *  - mouseenter on a committed line's marker arms a ~150 ms show timer;
 *    mouseleave before it fires cancels it (a mouse sweeping down the gutter
 *    opens nothing).
 *  - once shown, leaving the marker starts a short grace timer so the pointer
 *    can travel INTO the popover (which cancels the hide); leaving the popover
 *    re-arms it. When neither is hovered, it hides.
 *  - Esc and any scroll dismiss immediately.
 */

import { Compartment, type Extension } from "@codemirror/state";
import { type EditorView, gutter, GutterMarker } from "@codemirror/view";

import {
  commitForLine,
  firstOfRunFlags,
  gutterLabel,
  popoverModel,
  type BlamePopoverModel,
} from "./blame";
import type { BlameCommit, FileBlame } from "./blameIpc";
import "./blame.css";

/** Hover delay before the popover shows (IntelliJ-ish "step on the name"). */
export const POPOVER_SHOW_MS = 150;
/** Grace period to travel from the marker into the popover before it hides. */
export const POPOVER_HIDE_MS = 120;

/**
 * The singleton commit popover. Plain DOM (appended to `document.body`), so it
 * is fully testable under jsdom without a CM6 view.
 */
export class BlamePopover {
  private el: HTMLDivElement | null = null;
  private showTimer: ReturnType<typeof setTimeout> | null = null;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") this.hide();
  };
  // Capture-phase, so an inner scroller's (non-bubbling) scroll still dismisses.
  private readonly onScroll = (): void => this.hide();

  /** Arm the show timer for `anchor`'s commit (mouseenter on a marker). */
  scheduleShow(anchor: HTMLElement, model: BlamePopoverModel): void {
    this.clearShowTimer();
    this.clearHideTimer();
    this.showTimer = setTimeout(() => {
      this.showTimer = null;
      this.show(anchor, model);
    }, POPOVER_SHOW_MS);
  }

  /** Mouseleave of the marker or the popover: cancel a pending show, or arm the
   *  grace hide if the popover is up. */
  scheduleHide(): void {
    this.clearShowTimer();
    if (!this.el) return;
    this.clearHideTimer();
    this.hideTimer = setTimeout(() => this.hide(), POPOVER_HIDE_MS);
  }

  /** Mouseenter on the popover itself — cancel the grace hide. */
  keepOpen(): void {
    this.clearHideTimer();
  }

  /** Dismiss immediately (Esc, scroll, blame toggled off, or grace elapsed). */
  hide(): void {
    this.clearShowTimer();
    this.clearHideTimer();
    if (!this.el) return;
    this.el.remove();
    this.el = null;
    document.removeEventListener("keydown", this.onKeyDown, true);
    document.removeEventListener("scroll", this.onScroll, true);
  }

  private clearShowTimer(): void {
    if (this.showTimer) {
      clearTimeout(this.showTimer);
      this.showTimer = null;
    }
  }

  private clearHideTimer(): void {
    if (this.hideTimer) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
  }

  private show(anchor: HTMLElement, model: BlamePopoverModel): void {
    this.hide(); // at most one popover; replaces any previous one

    const el = document.createElement("div");
    el.className = "blame-popover";
    el.setAttribute("role", "tooltip");
    el.dataset.testid = "blame-popover";

    // All content via textContent — a commit message must never inject markup.
    const hash = el.appendChild(document.createElement("div"));
    hash.className = "blame-popover__hash";
    hash.textContent = `commit ${model.hash}`;
    for (const [name, value] of [
      ["Author", model.author],
      ["Date", model.date],
      ["Path", model.path],
    ]) {
      const row = el.appendChild(document.createElement("div"));
      row.className = "blame-popover__meta";
      row.textContent = `${name}: ${value}`;
    }
    const message = el.appendChild(document.createElement("pre"));
    message.className = "blame-popover__message";
    message.textContent = model.message;

    el.addEventListener("mouseenter", () => this.keepOpen());
    el.addEventListener("mouseleave", () => this.scheduleHide());

    document.body.appendChild(el);
    this.el = el;
    document.addEventListener("keydown", this.onKeyDown, true);
    document.addEventListener("scroll", this.onScroll, true);

    // Position near the marker, clamped to the viewport. Under jsdom every rect
    // is 0×0, so this math is asserted for real in the browser tier.
    const rect = anchor.getBoundingClientRect();
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    const below = rect.bottom + 6;
    const top = below + height > window.innerHeight ? Math.max(8, rect.top - height - 6) : below;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }
}

/** The one popover shared by every editor (only one can be hovered at a time). */
export const blamePopover = new BlamePopover();

/** One line's gutter annotation: the label span + the hover wiring. */
class BlameMarker extends GutterMarker {
  constructor(
    private readonly label: string,
    private readonly commit: BlameCommit | null,
    private readonly relPath: string,
  ) {
    super();
  }

  override eq(other: BlameMarker): boolean {
    return this.label === other.label && this.commit === other.commit;
  }

  override toDOM(): Node {
    const span = document.createElement("span");
    span.className = this.commit ? "cm-blame-line" : "cm-blame-line cm-blame-line--none";
    span.textContent = this.label;
    if (this.commit) {
      const model = popoverModel(this.commit, this.relPath);
      span.addEventListener("mouseenter", () => blamePopover.scheduleShow(span, model));
      span.addEventListener("mouseleave", () => blamePopover.scheduleHide());
    }
    return span;
  }
}

/** The blame gutter for one `FileBlame` (exported for the browser-tier test). */
export function blameGutterExtension(blame: FileBlame): Extension {
  const flags = firstOfRunFlags(blame.lines);
  return gutter({
    class: "cm-blame-gutter",
    lineMarker(view, line) {
      const lineNumber = view.state.doc.lineAt(line.from).number;
      const commit = commitForLine(blame, lineNumber); // clamps a stale blame
      // A line beyond the blame has no flag — render it like an uncommitted one.
      return new BlameMarker(gutterLabel(commit, flags[lineNumber - 1] ?? true), commit, blame.relPath);
    },
    lineMarkerChange: () => false,
  });
}

/**
 * The toggle seam. `blameSupport` (the empty compartment) goes into every view
 * at creation — BEFORE `lineNumbers()`, which is what puts the blame column on
 * the LEFT of the numbers — and `showBlame`/`hideBlame` reconfigure it in place.
 */
const blameCompartment = new Compartment();
export const blameSupport: Extension = blameCompartment.of([]);

/** Render `blame` in `view`'s gutter (no-op on a not-yet-created view). */
export function showBlame(view: EditorView | null, blame: FileBlame): void {
  view?.dispatch({ effects: blameCompartment.reconfigure(blameGutterExtension(blame)) });
}

/** Remove the blame gutter (and any open popover). No-op on a null view. */
export function hideBlame(view: EditorView | null): void {
  blamePopover.hide();
  view?.dispatch({ effects: blameCompartment.reconfigure([]) });
}
