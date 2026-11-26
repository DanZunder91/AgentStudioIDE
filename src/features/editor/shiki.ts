/** One lazy shared highlighter on Shiki's pure-JS RegExp engine (no WASM or workers: WebKitGTK),
 * `forgiving` so a bad rule degrades alone. Grammars load per language as async chunks; two
 * themes ship eagerly. */

import { bundledLanguages, type BundledLanguage } from "shiki";
import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import githubLight from "@shikijs/themes/github-light";
import tokyoNight from "@shikijs/themes/tokyo-night";

/** Dark "terminal" default (VS Code's Tokyo Night); light companion for a toggle. */
export const THEME_DARK = "tokyo-night";
export const THEME_LIGHT = "github-light";

let highlighterPromise: Promise<HighlighterCore> | null = null;

/** The shared highlighter (JS engine, both themes, zero preloaded grammars). */
export function highlighter(): Promise<HighlighterCore> {
  return (highlighterPromise ??= createHighlighterCore({
    themes: [tokyoNight, githubLight],
    langs: [],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  }));
}

const loaded = new Set<string>();

/** Load a grammar on first use; false (render plaintext) for an unknown id or failed import. */
export async function ensureLang(shikiId: string): Promise<boolean> {
  if (loaded.has(shikiId)) return true;
  // `bundledLanguages` loaders use static `import()` specifiers Vite splits into one chunk each;
  // a template-string import could not be analyzed.
  const loadGrammar = bundledLanguages[shikiId as BundledLanguage];
  if (!loadGrammar) return false;
  const hl = await highlighter();
  try {
    const grammar = await loadGrammar();
    await hl.loadLanguage(grammar.default);
    loaded.add(shikiId);
    return true;
  } catch {
    return false;
  }
}
