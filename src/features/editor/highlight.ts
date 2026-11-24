/**
 * Shiki → CodeMirror 6 decoration bridge (M4).
 *
 * The chosen integration is "Shiki tokens → CM6 `Decoration.mark` spans." The
 * design doc sketches it as a `ViewPlugin`; that sketch is explicitly illustrative
 * (its `view.update([])` repaint isn't a real API). The robust realization of the
 * SAME idea for asynchronously-computed decorations is a `StateField` fed by a
 * `StateEffect` — decorations survive doc changes via `.map`, and a single
 * `dispatch` applies them once the (async) grammar + tokenization finish.
 *
 * This is a READ-ONLY viewer with a hard size gate, so we tokenize the whole
 * document once on load rather than viewport-incrementally (the doc's
 * viewport+debounce is an editing-perf concern that does not apply here).
 */

import { RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";

import { ensureLang, highlighter } from "./shiki";

const setHighlight = StateEffect.define<DecorationSet>();

/** Holds the Shiki color decorations; remaps them across any doc change. */
export const shikiField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setHighlight)) deco = effect.value;
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const markCache = new Map<string, Decoration>();
function colorMark(color: string): Decoration {
  let mark = markCache.get(color);
  if (!mark) {
    mark = Decoration.mark({ attributes: { style: `color:${color}` } });
    markCache.set(color, mark);
  }
  return mark;
}

/**
 * Tokenize the (gated) document with Shiki and push its color spans onto `view`.
 * A failed grammar load or a tokenization error leaves the plaintext render
 * untouched — never throws into the editor.
 */
export async function applyShikiHighlight(
  view: EditorView,
  shikiId: string,
  theme: string,
): Promise<void> {
  if (!(await ensureLang(shikiId))) return;
  const hl = await highlighter();

  let tokenLines;
  try {
    tokenLines = hl.codeToTokens(view.state.doc.toString(), { lang: shikiId, theme }).tokens;
  } catch {
    return;
  }

  const builder = new RangeSetBuilder<Decoration>();
  let pos = 0;
  for (const line of tokenLines) {
    for (const token of line) {
      const end = pos + token.content.length;
      if (token.color && end > pos) builder.add(pos, end, colorMark(token.color));
      pos = end;
    }
    pos += 1; // the newline Shiki drops between lines
  }

  // The view may have been torn down while we awaited the grammar chunk.
  if (view.dom.isConnected) {
    view.dispatch({ effects: setHighlight.of(builder.finish()) });
  }
}
