/**
 * Shiki highlighter — the engine behind the editor's colors (M4).
 *
 * ONE shared highlighter, created lazily, with Shiki's **pure-JS RegExp engine**
 * (no WebAssembly, no web workers — a hard WebKitGTK constraint),
 * in `forgiving` mode so an exotic grammar rule degrades that one rule rather than
 * throwing. Grammars are **lazy-imported per language** (`@shikijs/langs/<id>`),
 * which Vite emits as a separate async chunk each — the base bundle preloads none.
 * Two themes ship eagerly: a dark "terminal" default + a light companion.
 */

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

/**
 * Ensure a grammar is loaded, lazily importing its async chunk on first use.
 * Returns false when the grammar can't be loaded (unknown id / import failure) —
 * the caller then renders plaintext instead of throwing.
 */
export async function ensureLang(shikiId: string): Promise<boolean> {
  if (loaded.has(shikiId)) return true;
  // Shiki's `bundledLanguages` map holds a per-grammar lazy loader with a STATIC
  // `import()` specifier, which Vite code-splits into one async chunk each — the
  // base bundle preloads none. (A raw `import(`@shikijs/langs/${id}`)` can't be
  // statically analyzed by Vite; this is the Vite-friendly equivalent.)
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
