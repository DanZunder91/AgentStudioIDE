/**
 * Cmd/Ctrl-hover "go-to-definition" underline (M5) — the standard IDE
 * affordance that ALSO fixes the flakiness.
 *
 * While the platform modifier is held and the mouse is over a symbol, we
 * debounced-query the LSP definition for the token at the MOUSE position. If a
 * definition resolves, we underline that token and show a pointer cursor; on
 * modifier release / mouse-leave / no-definition / blur we remove it. No modifier
 * held ⇒ nothing happens (no queries, no decoration).
 *
 * Because the underline only appears once rust-analyzer has actually resolved a
 * definition, it doubles as a readiness signal — you never click into the void
 * during the -32801 indexing window (a hover during indexing simply doesn't
 * underline; the explicit F12/click path still shows the "indexing…" indicator).
 *
 * Position math is the library's `LSPPlugin.toPosition` (UTF-16-aware), so
 * non-ASCII lines map correctly — the click/hover uses the mouse offset, not the
 * caret.
 */

import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin } from "@codemirror/view";
import { LSPPlugin } from "@codemirror/lsp-client";

/** Debounce hover queries so a moving mouse doesn't spam the server. */
const HOVER_DEBOUNCE_MS = 120;

interface LspLocation {
  uri: string;
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
}

const setUnderline = StateEffect.define<DecorationSet>();

/** Holds the single hover underline; remaps across edits. */
const underlineField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setUnderline)) deco = effect.value;
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const underlineMark = Decoration.mark({ class: "cm-lsp-underline" });

class HoverDefinition {
  private armed = false;
  private lastPos: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private current: { from: number; to: number } | null = null;

  constructor(private readonly view: EditorView) {}

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private remove(): void {
    this.clearTimer();
    if (this.current) {
      this.current = null;
      this.view.dispatch({ effects: setUnderline.of(Decoration.none) });
    }
  }

  private schedule(pos: number): void {
    this.lastPos = pos;
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.query(pos);
    }, HOVER_DEBOUNCE_MS);
  }

  private show(from: number, to: number): void {
    this.current = { from, to };
    this.view.dispatch({ effects: setUnderline.of(Decoration.set([underlineMark.range(from, to)])) });
  }

  private async query(pos: number): Promise<void> {
    if (!this.armed) return;
    const plugin = LSPPlugin.get(this.view);
    if (!plugin) return;
    const word = this.view.state.wordAt(pos);
    if (!word) {
      this.remove();
      return;
    }
    // Already underlining this token → nothing to do (avoids a re-query storm).
    if (this.current && this.current.from === word.from && this.current.to === word.to) return;

    try {
      const result = await plugin.client.request<unknown, LspLocation | LspLocation[] | null>(
        "textDocument/definition",
        { textDocument: { uri: plugin.uri }, position: plugin.toPosition(pos) },
      );
      if (!this.armed) return; // modifier released while the query was in flight
      const loc = Array.isArray(result) ? result[0] : result;
      if (loc) this.show(word.from, word.to);
      else this.remove();
    } catch {
      // -32801 (still indexing) or any error → no underline. The underline means
      // "ready"; a failed/indexing query calmly shows nothing.
      this.remove();
    }
  }

  onMouseMove(event: MouseEvent): void {
    this.armed = event.metaKey || event.ctrlKey;
    if (!this.armed) {
      this.remove();
      return;
    }
    const pos = this.view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos == null) {
      this.remove();
      return;
    }
    this.schedule(pos);
  }

  onKeyDown(event: KeyboardEvent): void {
    if (event.key === "Meta" || event.key === "Control" || event.metaKey || event.ctrlKey) {
      this.armed = true;
      if (this.lastPos != null) this.schedule(this.lastPos);
    }
  }

  onKeyUp(event: KeyboardEvent): void {
    if (!event.metaKey && !event.ctrlKey) {
      this.armed = false;
      this.remove();
    }
  }

  onBlurOrLeave(): void {
    this.armed = false;
    this.remove();
  }

  destroy(): void {
    this.clearTimer();
  }
}

const hoverPlugin = ViewPlugin.fromClass(HoverDefinition, {
  eventHandlers: {
    mousemove(event) {
      this.onMouseMove(event);
    },
    keydown(event) {
      this.onKeyDown(event);
    },
    keyup(event) {
      this.onKeyUp(event);
    },
    mouseleave() {
      this.onBlurOrLeave();
    },
    blur() {
      this.onBlurOrLeave();
    },
  },
});

/** The Cmd/Ctrl-hover underline extension (underline field + the tracking plugin). */
export const hoverDefinition: Extension = [underlineField, hoverPlugin];
