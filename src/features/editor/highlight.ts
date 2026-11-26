/** Shiki → CM6 decorations: a `StateField` fed by a `StateEffect`, so async results map through
 * doc changes. Read-only viewer with a size gate, so the whole doc is tokenized once on load. */

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

/** A failed grammar load or tokenization leaves the plaintext render as is; never throws. */
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
