/**
 * QueryEditor tests.
 *
 * ── The seam: real CodeMirror, a fake tokenizer ──────────────────────────────
 * `@codemirror/*` is NOT mocked — the keymap, the update listener and the
 * controlled-document reconciliation are the things whose contract we have to
 * satisfy, and a mocked view would prove only that the test agrees with itself.
 * `../../editor/shiki` IS mocked, exactly as `highlight.test.ts` does it: Shiki is
 * third-party, we are not testing its tokenizer, and a fake token stream lets the
 * colour assertion name a concrete colour at a concrete offset.
 *
 * jsdom cannot lay CM6 out; nothing here needs it to (decoration ranges and keymaps
 * are state, not pixels). `cmTestKit.stubGeometry` supplies the two geometry APIs
 * CM6's measure cycle calls — see its header.
 */

import { cleanup, render } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { RangeSet } from "@codemirror/state";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { pressKey, stubGeometry } from "../../editor/find/cmTestKit";

/* ── the fake tokenizer ── */
const shikiMock = vi.hoisted(() => ({
  ensureLang: vi.fn<(id: string) => Promise<boolean>>(() => Promise.resolve(true)),
  codeToTokens: vi.fn(),
}));

vi.mock("../../editor/shiki", () => ({
  ensureLang: shikiMock.ensureLang,
  highlighter: () => Promise.resolve({ codeToTokens: shikiMock.codeToTokens }),
  THEME_DARK: "tokyo-night",
  THEME_LIGHT: "github-light",
}));

const { shikiField } = await import("../../editor/highlight");
const { QueryEditor } = await import("./QueryEditor");
type QueryEditorHandle = import("./QueryEditor").QueryEditorHandle;

beforeAll(() => stubGeometry());

afterEach(() => {
  cleanup();
  shikiMock.ensureLang.mockClear();
  shikiMock.codeToTokens.mockReset();
  vi.useRealTimers();
});

/** One Shiki-shaped line of tokens. */
function tokens(line: Array<{ content: string; color?: string }>) {
  return { tokens: [line] };
}

/**
 * The colour decorations currently in the view, as comparable spans. Asserted on the
 * STATE rather than on rendered `<span style>`s: jsdom has no layout, so CM6's
 * viewport measure paints nothing to query — and a decoration's range is the thing
 * the bridge actually computes.
 */
function spansOf(view: EditorView): Array<{ from: number; to: number; color?: string }> {
  const out: Array<{ from: number; to: number; color?: string }> = [];
  const iter = (view.state.field(shikiField) as RangeSet<never>).iter();
  while (iter.value) {
    const attrs = (iter.value as { spec?: { attributes?: Record<string, string> } }).spec
      ?.attributes;
    out.push({ from: iter.from, to: iter.to, color: attrs?.style.replace("color:", "") });
    iter.next();
  }
  return out;
}

/** The live view behind a rendered QueryEditor. */
function viewOf(): EditorView {
  const host = document.querySelector(".db-query") as HTMLElement;
  return EditorView.findFromDOM(host) as EditorView;
}

const base = {
  text: "SELECT 1",
  onTextChange: () => {},
  shikiId: null as string | null,
  queryLanguage: "sql" as "sql" | "json" | "commandline",
  onRun: () => {},
  allowScript: false,
  ariaLabel: "Query (PostgreSQL)",
};

/** Put the caret at `offset` (or select `[offset, head]`) in the live view. */
function select(offset: number, head: number = offset): void {
  viewOf().dispatch({ selection: { anchor: offset, head } });
}

/**
 * A sample buffer with mixed keyword case.
 * Line 2's `FRom` and the two commented-out lines are part of it, and they matter: the
 * comments are what a naive splitter turns into extra statements.
 */
const SAMPLE_BUFFER = [
  "SELECT * FROM widgets;",
  "SELECT * FRom booking;",
  "--SELECT * from op_history;",
  "--select * from staff_accounts;",
].join("\n");

describe("QueryEditor — the editable surface", () => {
  it("mounts a CodeMirror view holding the initial text, with an accessible name", () => {
    render(<QueryEditor {...base} />);
    const view = viewOf();
    expect(view.state.doc.toString()).toBe("SELECT 1");
    expect(view.contentDOM).toHaveAttribute("aria-label", "Query (PostgreSQL)");
    // Line numbers, like the file editor — a console without them cannot say
    // "syntax error at line 3".
    expect(document.querySelector(".cm-gutters")).not.toBeNull();
  });

  it("reports every edit through onTextChange", () => {
    const onTextChange = vi.fn();
    render(<QueryEditor {...base} onTextChange={onTextChange} />);
    viewOf().dispatch({ changes: { from: 8, insert: " + 1" } });
    expect(onTextChange).toHaveBeenCalledExactlyOnceWith("SELECT 1 + 1");
  });

  it("destroys its view on unmount", () => {
    const { unmount } = render(<QueryEditor {...base} />);
    const host = document.querySelector(".db-query") as HTMLElement;
    expect(host.querySelector(".cm-editor")).not.toBeNull();
    unmount();
    expect(EditorView.findFromDOM(host)).toBeNull();
  });
});

describe("QueryEditor — controlled, but not re-created", () => {
  it("applies an external text change as an EDIT, keeping the same view alive", () => {
    const { rerender } = render(<QueryEditor {...base} />);
    const before = viewOf();
    rerender(<QueryEditor {...base} text="SELECT 2" />);
    const after = viewOf();
    expect(after.state.doc.toString()).toBe("SELECT 2");
    // Same instance: the caret, undo history and scroll survive a saved query
    // being loaded into the console.
    expect(after).toBe(before);
  });

  it("does not dispatch when the prop merely echoes what the user just typed", () => {
    // The controlled-input loop: onTextChange fires, the store re-renders with the
    // same string, and a naive sync would dispatch a redundant full-document
    // replacement — resetting the selection on every keystroke.
    const onTextChange = vi.fn();
    const { rerender } = render(<QueryEditor {...base} onTextChange={onTextChange} />);
    viewOf().dispatch({ changes: { from: 8, insert: "0" } });
    expect(onTextChange).toHaveBeenCalledExactlyOnceWith("SELECT 10");

    onTextChange.mockClear();
    rerender(<QueryEditor {...base} text="SELECT 10" onTextChange={onTextChange} />);
    // A dispatch would have re-entered the update listener; silence proves none.
    expect(onTextChange).not.toHaveBeenCalled();
    expect(viewOf().state.doc.toString()).toBe("SELECT 10");
  });
});

describe("QueryEditor — the keymap lives in CodeMirror", () => {
  it("runs the statement under the cursor on Mod-Enter, and swallows the key", () => {
    // CM6 resolves `Mod` per platform (⌘ on macOS, Ctrl elsewhere) and jsdom reports
    // a non-Mac UA, so Ctrl is the modifier under test here. It is one binding, not
    // two: on a Mac the same keymap entry is ⌘⏎.
    const onRun = vi.fn();
    render(<QueryEditor {...base} onRun={onRun} />);
    const event = pressKey(viewOf().contentDOM, "Enter", { ctrl: true });
    // The TEXT, not only the mode — the whole of the selection bug.
    expect(onRun).toHaveBeenCalledExactlyOnceWith("statement", "SELECT 1");
    // preventDefault is what stops a newline being inserted AND what lets the
    // container-level handler in DbConsole know not to run it a second time.
    expect(event.defaultPrevented).toBe(true);
  });

  it("leaves ⌘⏎ alone on a non-Mac, so DbConsole's container handler can take it", () => {
    // Not a gap: `Mod` is Ctrl here, and the console's own keydown handler covers
    // the other modifier (and any focus outside the editor) — see DbConsole.test.
    const onRun = vi.fn();
    render(<QueryEditor {...base} onRun={onRun} />);
    const event = pressKey(viewOf().contentDOM, "Enter", { meta: true });
    expect(onRun).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("runs the whole script on Shift-Mod-Enter when the connection allows it", () => {
    const onRun = vi.fn();
    render(<QueryEditor {...base} onRun={onRun} allowScript text={SAMPLE_BUFFER} />);
    select(0);
    const event = pressKey(viewOf().contentDOM, "Enter", { ctrl: true, shift: true });
    // The WHOLE buffer, with the caret parked on line 1: Script means the script.
    expect(onRun).toHaveBeenCalledExactlyOnceWith("script", SAMPLE_BUFFER);
    expect(event.defaultPrevented).toBe(true);
  });

  it("does NOT downgrade Shift-Mod-Enter to a single statement when script mode is off", () => {
    // A user who asked for the script must not silently get one statement.
    // The keystroke is still swallowed, so it cannot insert a newline either.
    const onRun = vi.fn();
    render(<QueryEditor {...base} onRun={onRun} allowScript={false} />);
    const event = pressKey(viewOf().contentDOM, "Enter", { ctrl: true, shift: true });
    expect(onRun).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it("calls the LATEST onRun, not the one from the first render", () => {
    // The extensions are built once, so a handler closing over the first render's
    // props would call a stale callback for the life of the console.
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<QueryEditor {...base} onRun={first} />);
    rerender(<QueryEditor {...base} onRun={second} />);
    pressKey(viewOf().contentDOM, "Enter", { ctrl: true });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledExactlyOnceWith("statement", "SELECT 1");
  });

  it("leaves a plain Enter to CodeMirror, so the editor is still an editor", () => {
    const onRun = vi.fn();
    render(<QueryEditor {...base} onRun={onRun} />);
    pressKey(viewOf().contentDOM, "Enter");
    expect(onRun).not.toHaveBeenCalled();
  });
});

/* ═══════════════ 🔴 what ⌘⏎ actually SENDS ═══════════════ */

describe("QueryEditor — the text ⌘⏎ sends", () => {
  it("🔴 runs ONLY line 1 with the caret on line 1 — the sample buffer", () => {
    // The bug: four lines, ⌘⏎, and "That statement was blocked before it ran — this
    // connection is read-only, or it does not allow multiple statements." Because the whole
    // buffer went over the wire and Rust counted two statements in it.
    const onRun = vi.fn();
    render(<QueryEditor {...base} text={SAMPLE_BUFFER} onRun={onRun} />);
    select(5); // inside "SELECT" on line 1
    pressKey(viewOf().contentDOM, "Enter", { ctrl: true });
    expect(onRun).toHaveBeenCalledExactlyOnceWith("statement", "SELECT * FROM widgets");
  });

  it("🔴 runs ONLY line 2 with the caret on line 2", () => {
    const onRun = vi.fn();
    render(<QueryEditor {...base} text={SAMPLE_BUFFER} onRun={onRun} />);
    select(SAMPLE_BUFFER.indexOf("FRom"));
    pressKey(viewOf().contentDOM, "Enter", { ctrl: true });
    // The typo preserved: the editor sends what is written, never a cleaned-up version.
    expect(onRun).toHaveBeenCalledExactlyOnceWith("statement", "SELECT * FRom booking");
  });

  it("🔴 runs EXACTLY the selection — the two highlighted commented-out lines", () => {
    const onRun = vi.fn();
    render(<QueryEditor {...base} text={SAMPLE_BUFFER} onRun={onRun} />);
    select(SAMPLE_BUFFER.indexOf("--SELECT"), SAMPLE_BUFFER.length);
    pressKey(viewOf().contentDOM, "Enter", { ctrl: true });
    // Verbatim, comments and all. The server answering "There is nothing to run." is the
    // correct outcome; silently running something else because the selection *looks* inert
    // would mean ⌘⏎ ran text other than what is highlighted on screen.
    expect(onRun).toHaveBeenCalledExactlyOnceWith(
      "statement",
      "--SELECT * from op_history;\n--select * from staff_accounts;",
    );
  });

  it("sends the whole buffer for a json engine, wherever the caret is", () => {
    // A Mongo command document is ONE object; splitting it on `;` would be answering a
    // question SQL asks and JSON does not.
    const doc = '{"find": "tracks",\n "filter": {"note": "a;b"},\n "limit": 10}';
    const onRun = vi.fn();
    render(<QueryEditor {...base} queryLanguage="json" text={doc} onRun={onRun} />);
    select(doc.indexOf("filter"));
    pressKey(viewOf().contentDOM, "Enter", { ctrl: true });
    expect(onRun).toHaveBeenCalledExactlyOnceWith("statement", doc);
  });

  it("sends the caret's LINE for a commandline engine", () => {
    const doc = "GET user:1\nHGETALL session:9\nTTL user:1";
    const onRun = vi.fn();
    render(<QueryEditor {...base} queryLanguage="commandline" text={doc} onRun={onRun} />);
    select(doc.indexOf("HGETALL") + 3);
    pressKey(viewOf().contentDOM, "Enter", { ctrl: true });
    expect(onRun).toHaveBeenCalledExactlyOnceWith("statement", "HGETALL session:9");
  });

  it("answers the same question through its ref, for the toolbar's Run button", () => {
    // The button is not in the editor, so it cannot see the caret. This handle is how it
    // sends the same text ⌘⏎ would — see DbConsole.test.tsx for the wired claim.
    const handle = { current: null as QueryEditorHandle | null };
    render(<QueryEditor {...base} text={SAMPLE_BUFFER} ref={handle} />);
    select(SAMPLE_BUFFER.indexOf("FRom"));
    expect(handle.current?.runText()).toBe("SELECT * FRom booking");
    select(SAMPLE_BUFFER.indexOf("--SELECT"), SAMPLE_BUFFER.length);
    expect(handle.current?.runText()).toBe(
      "--SELECT * from op_history;\n--select * from staff_accounts;",
    );
  });
});

describe("QueryEditor — highlighting, with no new dependency", () => {
  it("colours SQL through the file editor's own Shiki → CM6 path", async () => {
    shikiMock.codeToTokens.mockReturnValue(
      tokens([
        { content: "SELECT", color: "#bb9af7" },
        { content: " 1", color: "#ff9e64" },
      ]),
    );
    render(<QueryEditor {...base} shikiId="sql" />);

    await vi.waitFor(() => {
      // "SELECT" is 0..6 and " 1" is 6..8 — exact offsets, so a broken walk shows up
      // as a wrong range rather than as "some colour happened".
      expect(spansOf(viewOf())).toEqual([
        { from: 0, to: 6, color: "#bb9af7" },
        { from: 6, to: 8, color: "#ff9e64" },
      ]);
    });
    // The grammar asked for is the file editor's `sql`, so a `.sql` file and this
    // console are the same colours — not a second SQL palette.
    expect(shikiMock.ensureLang).toHaveBeenCalledWith("sql");
    expect(shikiMock.codeToTokens).toHaveBeenCalledWith("SELECT 1", {
      lang: "sql",
      theme: "tokyo-night",
    });
  });

  it("uses the json grammar for a MongoDB console", async () => {
    shikiMock.codeToTokens.mockReturnValue(tokens([{ content: '{"find":"t"}', color: "#7dcfff" }]));
    render(<QueryEditor {...base} text='{"find":"t"}' shikiId="json" />);
    await vi.waitFor(() => expect(shikiMock.ensureLang).toHaveBeenCalledWith("json"));
  });

  it("asks for no grammar at all for a command-line console", async () => {
    // Redis: Shiki has no `redis` grammar and `bash` would colour `#` as a comment
    // in a protocol that has none. So the editor stays plaintext, on purpose.
    render(<QueryEditor {...base} text="HGETALL user:1" shikiId={null} />);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(shikiMock.ensureLang).not.toHaveBeenCalled();
    expect(spansOf(viewOf())).toEqual([]);
  });

  it("re-tokenises on a 50 ms debounce, so a burst of typing runs Shiki once", () => {
    vi.useFakeTimers();
    shikiMock.codeToTokens.mockReturnValue(tokens([{ content: "S", color: "#bb9af7" }]));
    const { rerender } = render(<QueryEditor {...base} text="S" shikiId="sql" />);
    rerender(<QueryEditor {...base} text="SE" shikiId="sql" />);
    rerender(<QueryEditor {...base} text="SEL" shikiId="sql" />);
    // Nothing yet: each keystroke cancelled the previous timer.
    expect(shikiMock.ensureLang).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    expect(shikiMock.ensureLang).toHaveBeenCalledTimes(1);
  });

  it("survives a grammar that cannot be loaded, leaving plaintext behind", async () => {
    shikiMock.ensureLang.mockResolvedValueOnce(false);
    render(<QueryEditor {...base} shikiId="sql" />);
    await vi.waitFor(() => expect(shikiMock.ensureLang).toHaveBeenCalled());
    expect(shikiMock.codeToTokens).not.toHaveBeenCalled();
    // Still an editor, still holding the text.
    expect(viewOf().state.doc.toString()).toBe("SELECT 1");
  });
});
