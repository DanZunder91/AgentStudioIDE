/** Contract: `ensureLang` degrades to `false`, never throws; memos never cache a failed load; the
 * engine stays pure-JS (WebKitGTK). `bundledLanguages` and engine construction are faked; themes
 * are real, since Shiki resolves them by name. Each test gets `freshModule()`. */

import { describe, expect, it, vi, beforeEach } from "vitest";

import githubLight from "@shikijs/themes/github-light";
import tokyoNight from "@shikijs/themes/tokyo-night";

/* ── The fakes: hoisted so `vi.mock`'s factories can close over them ── */
const shikiMock = vi.hoisted(() => {
  /** Stands in for `bundledLanguages`; tests add/remove grammar loaders per case. */
  const bundledLanguages: Record<string, () => Promise<{ default: unknown }>> = {};
  /** The highlighter's one method this module uses. */
  const loadLanguage = vi.fn<(grammar: unknown) => Promise<void>>(() => Promise.resolve());
  const createHighlighterCore = vi.fn((options: unknown) =>
    Promise.resolve({ loadLanguage, options }),
  );
  const createJavaScriptRegexEngine = vi.fn((options: unknown) => ({
    __kind: "js-regex-engine" as const,
    options,
  }));
  return { bundledLanguages, loadLanguage, createHighlighterCore, createJavaScriptRegexEngine };
});

vi.mock("shiki", () => ({ bundledLanguages: shikiMock.bundledLanguages }));
vi.mock("shiki/core", () => ({ createHighlighterCore: shikiMock.createHighlighterCore }));
vi.mock("shiki/engine/javascript", () => ({
  createJavaScriptRegexEngine: shikiMock.createJavaScriptRegexEngine,
}));

/** Re-evaluates `shiki.ts`'s module-level memos; the hoisted fakes survive, so their call history
 * is cleared separately. */
async function freshModule() {
  vi.resetModules();
  return await import("./shiki");
}

/** A loader that resolves to a grammar, shaped like a real `@shikijs/langs` chunk. */
function grammarLoader(name: string) {
  return vi.fn(() => Promise.resolve({ default: { name } }));
}

beforeEach(() => {
  shikiMock.createHighlighterCore.mockClear();
  shikiMock.createJavaScriptRegexEngine.mockClear();
  shikiMock.loadLanguage.mockReset();
  shikiMock.loadLanguage.mockResolvedValue(undefined);
  for (const id of Object.keys(shikiMock.bundledLanguages)) {
    delete shikiMock.bundledLanguages[id];
  }
});

describe("highlighter() — the ONE shared engine", () => {
  it("builds the core exactly once and hands back the SAME promise", async () => {
    const { highlighter } = await freshModule();

    const first = highlighter();
    const second = highlighter();

    // Identity, not equality: `??=` must memoize the *promise*, so two
    // concurrent callers await one construction rather than racing two.
    expect(second).toBe(first);
    await first;
    expect(shikiMock.createHighlighterCore).toHaveBeenCalledTimes(1);

    // Still one after the promise has settled — a memo that only holds while
    // in-flight would rebuild here.
    await highlighter();
    expect(shikiMock.createHighlighterCore).toHaveBeenCalledTimes(1);
  });

  it("asks for both themes, ZERO preloaded grammars, and the forgiving pure-JS engine", async () => {
    const { highlighter, THEME_DARK, THEME_LIGHT } = await freshModule();
    await highlighter();

    const options = shikiMock.createHighlighterCore.mock.calls[0][0] as {
      themes: { name: string }[];
      langs: unknown[];
      engine: { __kind: string; options: unknown };
    };

    // No grammar is preloaded — the whole point of the lazy `ensureLang` path.
    // If this ever becomes non-empty, the base bundle silently gains a grammar.
    expect(options.langs).toEqual([]);

    // The pure-JS RegExp engine, forgiving. A regression to Shiki's
    // default (WebAssembly) works on macOS and breaks on WebKitGTK.
    expect(shikiMock.createJavaScriptRegexEngine).toHaveBeenCalledWith({ forgiving: true });
    expect(options.engine.__kind).toBe("js-regex-engine");

    // The load-bearing invariant: the exported theme NAMES must match the theme
    // OBJECTS we hand Shiki, because `codeToTokens({ theme })` resolves by name.
    // Real theme JSON on both sides — mocking either would make this vacuous.
    expect(options.themes).toEqual([tokyoNight, githubLight]);
    expect(options.themes.map((t) => t.name)).toEqual([THEME_DARK, THEME_LIGHT]);
    expect(THEME_DARK).toBe("tokyo-night");
    expect(THEME_LIGHT).toBe("github-light");
  });
});

describe("ensureLang() — lazy grammar loading, forgiving on failure", () => {
  it("loads a known grammar, passing the chunk's DEFAULT export to Shiki", async () => {
    const loader = grammarLoader("rust");
    shikiMock.bundledLanguages.rust = loader;
    const { ensureLang } = await freshModule();

    await expect(ensureLang("rust")).resolves.toBe(true);
    expect(loader).toHaveBeenCalledTimes(1);
    // `grammar.default`, not the module record — handing Shiki the wrapper
    // yields a highlighter that loads nothing and colors nothing.
    expect(shikiMock.loadLanguage).toHaveBeenCalledWith({ name: "rust" });
  });

  it("memoizes per id: a second request re-imports NOTHING", async () => {
    const loader = grammarLoader("rust");
    shikiMock.bundledLanguages.rust = loader;
    const { ensureLang } = await freshModule();

    await ensureLang("rust");
    await expect(ensureLang("rust")).resolves.toBe(true);

    // The memo's entire purpose: without it every keystroke that re-runs the
    // highlight path re-awaits an async chunk and re-registers the grammar.
    expect(loader).toHaveBeenCalledTimes(1);
    expect(shikiMock.loadLanguage).toHaveBeenCalledTimes(1);
  });

  it("memoizes per id and not globally — loading one grammar does not mark another loaded", async () => {
    const rust = grammarLoader("rust");
    const python = grammarLoader("python");
    shikiMock.bundledLanguages.rust = rust;
    shikiMock.bundledLanguages.python = python;
    const { ensureLang } = await freshModule();

    await ensureLang("rust");
    await expect(ensureLang("python")).resolves.toBe(true);

    expect(python).toHaveBeenCalledTimes(1);
    expect(shikiMock.loadLanguage).toHaveBeenCalledTimes(2);
  });

  it("an unknown id answers false WITHOUT building the highlighter", async () => {
    const { ensureLang } = await freshModule();

    await expect(ensureLang("klingon")).resolves.toBe(false);

    // The unsupported-language bail-out must come before engine construction.
    expect(shikiMock.createHighlighterCore).not.toHaveBeenCalled();
    expect(shikiMock.loadLanguage).not.toHaveBeenCalled();
  });

  it("a chunk import that REJECTS degrades to false without throwing", async () => {
    shikiMock.bundledLanguages.rust = vi.fn(() => Promise.reject(new Error("chunk 404")));
    const { ensureLang } = await freshModule();

    // Resolves false — never rejects. A throw here would escape
    // `applyShikiHighlight` into the editor and blank the file.
    await expect(ensureLang("rust")).resolves.toBe(false);
    expect(shikiMock.loadLanguage).not.toHaveBeenCalled();
  });

  it("a grammar Shiki itself rejects degrades to false", async () => {
    shikiMock.bundledLanguages.rust = grammarLoader("rust");
    shikiMock.loadLanguage.mockRejectedValueOnce(new Error("malformed grammar"));
    const { ensureLang } = await freshModule();

    await expect(ensureLang("rust")).resolves.toBe(false);
  });

  it("does NOT cache a failure — a transient chunk error can be retried", async () => {
    let failing = true;
    shikiMock.bundledLanguages.rust = vi.fn(() =>
      failing
        ? Promise.reject(new Error("offline"))
        : Promise.resolve({ default: { name: "rust" } }),
    );
    const { ensureLang } = await freshModule();

    await expect(ensureLang("rust")).resolves.toBe(false);

    // `loaded.add` runs only on success, so a failed language genuinely retries.
    failing = false;
    await expect(ensureLang("rust")).resolves.toBe(true);
    expect(shikiMock.loadLanguage).toHaveBeenCalledWith({ name: "rust" });
  });

  it("shares the ONE highlighter across grammars", async () => {
    shikiMock.bundledLanguages.rust = grammarLoader("rust");
    shikiMock.bundledLanguages.python = grammarLoader("python");
    const { ensureLang, highlighter } = await freshModule();

    await ensureLang("rust");
    await ensureLang("python");
    await highlighter();

    // Two grammars and an explicit caller, one engine: `ensureLang` must go
    // through the same memo rather than constructing its own.
    expect(shikiMock.createHighlighterCore).toHaveBeenCalledTimes(1);
  });
});
