/** `./shiki` is faked so token shapes land at hand-checkable offsets; CodeMirror is real because
 * `RangeSetBuilder` throws on a broken position walk. An off-by-one there mis-colors silently. */

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { makeView, stubGeometry } from "./find/cmTestKit";

/* ── The fake tokenizer ── */
const shikiMock = vi.hoisted(() => ({
  ensureLang: vi.fn<(id: string) => Promise<boolean>>(() => Promise.resolve(true)),
  codeToTokens: vi.fn(),
}));

vi.mock("./shiki", () => ({
  ensureLang: shikiMock.ensureLang,
  highlighter: () => Promise.resolve({ codeToTokens: shikiMock.codeToTokens }),
  THEME_DARK: "tokyo-night",
  THEME_LIGHT: "github-light",
}));

const { applyShikiHighlight, shikiField } = await import("./highlight");

/** A Shiki-shaped token. `color` absent = "no color", the uncolored case. */
type Token = { content: string; color?: string };

/** Make `codeToTokens` return this token grid (outer array = lines). */
function tokenize(lines: Token[][]): void {
  shikiMock.codeToTokens.mockReturnValue({ tokens: lines });
}

interface Span {
  from: number;
  to: number;
  color: string | undefined;
  /** The Decoration instance itself, so cache identity can be asserted. */
  mark: unknown;
}

/** The decorations currently in the field, as plain comparable spans. */
function spansOf(view: EditorView): Span[] {
  const out: Span[] = [];
  const iter = view.state.field(shikiField).iter();
  while (iter.value) {
    const style = (iter.value.spec as { attributes?: Record<string, string> }).attributes?.style;
    out.push({
      from: iter.from,
      to: iter.to,
      color: style?.replace("color:", ""),
      mark: iter.value,
    });
    iter.next();
  }
  return out;
}

/** Mount a view carrying the field under test. */
function mount(doc: string, attached = true) {
  const harness = makeView(doc, [shikiField]);
  if (!attached) harness.view.dom.remove();
  return harness;
}

beforeAll(stubGeometry);

beforeEach(() => {
  shikiMock.ensureLang.mockReset();
  shikiMock.ensureLang.mockResolvedValue(true);
  shikiMock.codeToTokens.mockReset();
});

describe("applyShikiHighlight — the byte-position walk", () => {
  it("colors a single line at exact offsets", async () => {
    const { view, destroy } = mount("let x = 1");
    tokenize([
      [
        { content: "let", color: "#ff0000" },
        { content: " x = 1", color: "#00ff00" },
      ],
    ]);

    await applyShikiHighlight(view, "typescript", "tokyo-night");

    expect(spansOf(view).map(({ from, to, color }) => ({ from, to, color }))).toEqual([
      { from: 0, to: 3, color: "#ff0000" },
      { from: 3, to: 9, color: "#00ff00" },
    ]);
    destroy();
  });

  it("accounts for the newline Shiki drops between lines", async () => {
    // "ab\ncd": Shiki reports the two lines WITHOUT their separator, so the walk
    // must add 1 per line boundary. Drop that `pos += 1` and the second line's
    // span slides to 2..4 — colouring the newline and the wrong character.
    const { view, destroy } = mount("ab\ncd");
    tokenize([[{ content: "ab", color: "#111111" }], [{ content: "cd", color: "#222222" }]]);

    await applyShikiHighlight(view, "typescript", "tokyo-night");

    expect(spansOf(view).map(({ from, to }) => [from, to])).toEqual([
      [0, 2],
      [3, 5],
    ]);
    destroy();
  });

  it("keeps offsets aligned across MANY lines — drift compounds", async () => {
    // Four lines of one char each: "a\nb\nc\nd". Every line boundary adds 1, so
    // the spans land on 0,2,4,6. A single missing increment would be invisible
    // on line 2 and obvious by line 4 — assert the whole run.
    const { view, destroy } = mount("a\nb\nc\nd");
    tokenize([
      [{ content: "a", color: "#1" }],
      [{ content: "b", color: "#2" }],
      [{ content: "c", color: "#3" }],
      [{ content: "d", color: "#4" }],
    ]);

    await applyShikiHighlight(view, "typescript", "tokyo-night");

    expect(spansOf(view).map(({ from, to }) => [from, to])).toEqual([
      [0, 1],
      [2, 3],
      [4, 5],
      [6, 7],
    ]);
    destroy();
  });

  it("advances past an UNCOLORED token without decorating it", async () => {
    // Whitespace and punctuation routinely come back with no color. Such a token
    // must still move `pos` — skipping the advance would shift everything after
    // it left by its length.
    const { view, destroy } = mount("if (x)");
    tokenize([
      [
        { content: "if", color: "#aa0000" },
        { content: " " }, // no color
        { content: "(x)", color: "#00aa00" },
      ],
    ]);

    await applyShikiHighlight(view, "typescript", "tokyo-night");

    expect(spansOf(view).map(({ from, to, color }) => ({ from, to, color }))).toEqual([
      { from: 0, to: 2, color: "#aa0000" },
      { from: 3, to: 6, color: "#00aa00" }, // 3, not 2 — the space was counted
    ]);
    destroy();
  });

  it("survives a ZERO-LENGTH colored token — CM6 rejects empty marks", async () => {
    // `end > pos` is load-bearing: an empty mark (from === to) makes CodeMirror throw, and grammars
    // emit empty tokens for zero-width matches.
    const { view, destroy } = mount("ab");
    tokenize([
      [
        { content: "", color: "#ff0000" }, // the poison pill
        { content: "ab", color: "#00ff00" },
      ],
    ]);

    await expect(applyShikiHighlight(view, "typescript", "tokyo-night")).resolves.toBeUndefined();

    // The empty token contributed nothing; the real one still landed.
    expect(spansOf(view).map(({ from, to, color }) => ({ from, to, color }))).toEqual([
      { from: 0, to: 2, color: "#00ff00" },
    ]);
    destroy();
  });

  it("reuses ONE Decoration per color (the mark cache)", async () => {
    // The cache exists so a 5000-line file allocates ~20 marks, not ~50000.
    // Identity is the only way to observe it.
    const { view, destroy } = mount("aabb");
    tokenize([
      [
        { content: "aa", color: "#abcdef" },
        { content: "bb", color: "#abcdef" },
      ],
    ]);

    await applyShikiHighlight(view, "typescript", "tokyo-night");

    const spans = spansOf(view);
    expect(spans).toHaveLength(2);
    expect(spans[0].mark).toBe(spans[1].mark);
    destroy();
  });

  it("does not colour past the end of the document", async () => {
    // A token stream longer than the doc (a stale tokenization racing an edit)
    // must not produce out-of-range decorations — CM6 throws on those.
    const { view, destroy } = mount("ab");
    tokenize([[{ content: "ab", color: "#111111" }]]);

    await applyShikiHighlight(view, "typescript", "tokyo-night");
    const spans = spansOf(view);

    expect(spans[spans.length - 1].to).toBeLessThanOrEqual(view.state.doc.length);
    destroy();
  });
});

describe("applyShikiHighlight — the forgiving degrade paths", () => {
  it("a grammar that will not load leaves the plaintext render untouched", async () => {
    shikiMock.ensureLang.mockResolvedValue(false);
    const { view, destroy } = mount("let x = 1");

    await applyShikiHighlight(view, "klingon", "tokyo-night");

    expect(spansOf(view)).toEqual([]);
    // Bailed before tokenizing at all — no wasted work on an unhighlightable file.
    expect(shikiMock.codeToTokens).not.toHaveBeenCalled();
    destroy();
  });

  it("a tokenizer that THROWS is swallowed — never into the editor", async () => {
    shikiMock.codeToTokens.mockImplementation(() => {
      throw new Error("grammar blew up");
    });
    const { view, destroy } = mount("let x = 1");

    await expect(applyShikiHighlight(view, "typescript", "tokyo-night")).resolves.toBeUndefined();
    expect(spansOf(view)).toEqual([]);
    destroy();
  });

  it("a FAILED re-highlight leaves the colors already on screen alone", async () => {
    // The catch returns without dispatching, so a transient failure keeps the existing colors; an
    // empty dispatch would flash the file to plain text. Other tests start uncolored and miss it.
    const { view, destroy } = mount("abcd");

    tokenize([[{ content: "abcd", color: "#111111" }]]);
    await applyShikiHighlight(view, "typescript", "tokyo-night");
    expect(spansOf(view)).toHaveLength(1);

    shikiMock.codeToTokens.mockImplementation(() => {
      throw new Error("grammar blew up mid-session");
    });
    await applyShikiHighlight(view, "typescript", "github-light");

    // Still coloured, and still the ORIGINAL colour.
    expect(spansOf(view).map(({ from, to, color }) => ({ from, to, color }))).toEqual([
      { from: 0, to: 4, color: "#111111" },
    ]);
    destroy();
  });

  it("skips the dispatch when the view was torn down while awaiting", async () => {
    // The grammar chunk is an async import, so the user can close the tab before
    // it resolves. Dispatching into a destroyed view is a CM6 error; the
    // `isConnected` check is what prevents it.
    const { view, destroy } = mount("ab", /* attached */ false);
    tokenize([[{ content: "ab", color: "#111111" }]]);

    await expect(applyShikiHighlight(view, "typescript", "tokyo-night")).resolves.toBeUndefined();
    expect(spansOf(view)).toEqual([]);
    destroy();
  });

  it("passes the requested language and theme straight through to Shiki", async () => {
    const { view, destroy } = mount("ab");
    tokenize([[{ content: "ab", color: "#111111" }]]);

    await applyShikiHighlight(view, "rust", "github-light");

    expect(shikiMock.ensureLang).toHaveBeenCalledWith("rust");
    expect(shikiMock.codeToTokens).toHaveBeenCalledWith("ab", {
      lang: "rust",
      theme: "github-light",
    });
    destroy();
  });
});

describe("shikiField — decorations survive doc changes", () => {
  it("remaps spans across an insertion BEFORE them", async () => {
    const { view, destroy } = mount("ab");
    tokenize([[{ content: "ab", color: "#111111" }]]);
    await applyShikiHighlight(view, "typescript", "tokyo-night");
    expect(spansOf(view).map(({ from, to }) => [from, to])).toEqual([[0, 2]]);

    // Insert two characters at the very start: the span must slide right by 2.
    // Without `deco.map(tr.changes)` it would stay at 0..2 and colour the new
    // text instead — the async-decorations bug the StateField design prevents.
    view.dispatch({ changes: { from: 0, insert: "XY" } });

    expect(spansOf(view).map(({ from, to }) => [from, to])).toEqual([[2, 4]]);
    destroy();
  });

  it("drops a span whose text is deleted", async () => {
    const { view, destroy } = mount("abcd");
    tokenize([
      [
        { content: "ab", color: "#111111" },
        { content: "cd", color: "#222222" },
      ],
    ]);
    await applyShikiHighlight(view, "typescript", "tokyo-night");
    expect(spansOf(view)).toHaveLength(2);

    view.dispatch({ changes: { from: 0, to: 2 } }); // delete "ab"

    const spans = spansOf(view);
    expect(spans).toHaveLength(1);
    expect([spans[0].from, spans[0].to]).toEqual([0, 2]); // "cd", now at the start
    destroy();
  });

  it("ignores effects that belong to someone else", async () => {
    // Other extensions dispatch their own effects (find, blame, LSP); a field that took any
    // effect's value would wipe the colors whenever an unrelated feature dispatched.
    const someoneElsesEffect = StateEffect.define<string>();
    const { view, destroy } = mount("abcd");

    tokenize([[{ content: "abcd", color: "#111111" }]]);
    await applyShikiHighlight(view, "typescript", "tokyo-night");
    const before = spansOf(view).map(({ from, to, color }) => ({ from, to, color }));
    expect(before).toHaveLength(1);

    view.dispatch({ effects: someoneElsesEffect.of("not mine") });

    expect(spansOf(view).map(({ from, to, color }) => ({ from, to, color }))).toEqual(before);
    destroy();
  });

  it("starts empty, so an un-highlighted buffer renders as plain text", async () => {
    const { view, destroy } = mount("let x = 1");
    expect(spansOf(view)).toEqual([]);
    destroy();
  });

  it("a second highlight REPLACES the first rather than accumulating", async () => {
    const { view, destroy } = mount("abcd");

    tokenize([[{ content: "abcd", color: "#111111" }]]);
    await applyShikiHighlight(view, "typescript", "tokyo-night");

    // Re-highlight (a theme switch) with a different split of the same text.
    tokenize([
      [
        { content: "ab", color: "#333333" },
        { content: "cd", color: "#444444" },
      ],
    ]);
    await applyShikiHighlight(view, "typescript", "github-light");

    // Two spans, not three: the effect assigns, it does not merge.
    expect(spansOf(view).map(({ from, to, color }) => ({ from, to, color }))).toEqual([
      { from: 0, to: 2, color: "#333333" },
      { from: 2, to: 4, color: "#444444" },
    ]);
    destroy();
  });
});
