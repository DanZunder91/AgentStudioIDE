# Editor Syntax Highlighting Engine

> Decision doc for **Agent Studio**'s in-app code editor (the "file editor/viewer"
> tab). The **hard requirement**: the editor must open a file in
> **any** programming language, detect the language, and apply correct syntax
> colors — Kotlin (`.kt`) and the long tail (Zig, etc.) are the discriminating
> cases, not the mainstream ones.
>
> Scope note: **CodeMirror 6** is the editor *component*. The obvious way to
> highlight in it is the `@codemirror/lang-*` packages; this doc chooses the
> **highlighting engine** specifically.
>
> Upstream facts as of July 2026 (see [Sources](#sources)). Toolchain: Node 22.20,
> Vite 6, React 19, CodeMirror 6.

---

## TL;DR — Recommendation

**Keep CodeMirror 6 as the editor. Adopt [Shiki](https://shiki.style/)
as the primary syntax-highlighting engine, layered onto CM6 via a
`ViewPlugin` + `Decoration` integration, using Shiki's pure-JS RegExp engine (no
WebAssembly, no web workers).** Optionally attach a Lezer `@codemirror/lang-*`
package for the handful of languages where structural editing (fold / auto-indent)
matters most — but that is an enhancement, not a v1 requirement.

Why, in one breath: the requirement is *correct colors for **any** language incl.
Kotlin and Zig*, editing is explicitly secondary, and bundle size /
WebKitGTK friendliness are constraints. Shiki is the only option that
gives **VS Code-grade highlighting for 200+ languages** (Kotlin **and** Zig
included) at **near-zero per-language effort**, ships as tiny lazy-loaded grammar
chunks, and — with the JS engine — needs **no wasm and no workers**, which is
exactly what the Linux WebKitGTK path wants. CM6's native Lezer packages simply do
not cover the discriminating cases (no Kotlin, no Zig grammar), and the
alternatives that do (Monaco, tree-sitter) are ruled out by bundle/worker/wasm
cost. The choice is captured in the decision record below.

---

## The requirement, restated as evaluation criteria

1. **Language coverage** — must include `.cpp`, `.java`, `.kt` (Kotlin), and the
   long tail: Go, Rust, Python, TS, Swift, Scala, Dart, C#, Ruby, PHP, shell, SQL,
   YAML/TOML/JSON, Markdown, HTML/CSS, **Zig**, Kotlin. Kotlin + Zig are the tell.
2. **Editing capability** (indent / fold / bracket-match) vs. pure highlighting.
3. **Bundle size + lazy-loading** grammars on demand.
4. **Large-file performance.**
5. **Theming** — dark "terminal" aesthetic + light/dark toggle.
6. **Effort to add a missing language.**
7. **Tauri / webview compatibility** — web-worker / wasm setup, WebKitGTK gotchas.
8. **Maintenance status + license.**

Weighting for *our* product: (1), (6), (5), (7) are heavily weighted (universal
correct colors is the hard requirement; editing is secondary). (2)
is a nice-to-have. (3), (4), (8) are gating constraints.

---

## The four options

| # | Option | What it is |
|---|--------|-----------|
| **A** | **CM6 native** — `@codemirror/lang-*` (Lezer) + `@codemirror/legacy-modes` (StreamLanguage / clike) | Highlighting via CM6's own incremental Lezer parsers, plus ported CM5 stream modes for the long tail. |
| **B** | **CM6 + Shiki** | CM6 for editing; **Shiki** (TextMate grammars, VS Code's engine) for highlighting via a decoration `ViewPlugin`. **← recommended** |
| **C** | **Monaco** | VS Code's editor component; Monarch grammars, ~90 built-in languages, web workers. |
| **D** | **tree-sitter** — `web-tree-sitter` + per-language wasm grammars, layered on CM6 | C parsers compiled to wasm; highlight queries mapped to CM decorations. |

---

## Comparison table (all 8 criteria)

| Criterion | A. CM6 native (Lezer + legacy) | **B. CM6 + Shiki** ⭐ | C. Monaco | D. tree-sitter on CM6 |
|---|---|---|---|---|
| **1. Coverage** | ~19 Lezer langs (full) + ~100 legacy stream modes. **Broad but has gaps.** | **200+ langs** (VS Code parity). **Widest.** | ~90 built-in Monarch langs. | Any lang with a wasm grammar (~40 common, then DIY). |
| **1a. Kotlin** | ⚠️ **Only** via `legacy-modes/mode/clike` — a coarse, generic C-like stream mode, not a real Kotlin grammar. | ✅ Real `kotlin` TextMate grammar (`.kt`,`.kts`). | ✅ `kotlin` Monarch grammar (built-in). | ⚠️ needs `tree-sitter-kotlin` wasm + queries (community, uneven). |
| **1b. Zig** | ❌ **No** official or legacy Zig mode — must author one. | ✅ `zig` TextMate grammar (built-in). | ❌ **Not** in basic-languages — must author a Monarch grammar. | ⚠️ `tree-sitter-zig` wasm exists; you build/host it + queries. |
| **1c. long tail** (Swift/Scala/Dart/C#/Ruby/Go/…) | Mixed: Go = full Lezer; Swift/Ruby/etc. = legacy stream; Scala/Dart/C# = clike (coarse). | ✅ All first-class TextMate grammars. | ✅ Most built-in; some (Zig, Nim, …) missing. | ⚠️ per-grammar hunt + build. |
| **2. Editing** (indent/fold/bracket) | ✅ **Best** on Lezer langs (syntax-aware fold, auto-indent, bracket-match); legacy modes give highlight + basic indent only. | ⚠️ Highlighting only. Keeps CM's *language-agnostic* bracket-match + auto-close + basic indent; **no** syntax-aware fold/auto-indent unless a Lezer lang is also attached. | ✅ Full IDE: fold, auto-indent, bracket, IntelliSense hooks. | ✅ AST enables fold + structural edit (but CM glue is DIY/immature). |
| **3. Bundle** | ✅ **Smallest.** CM core ~150–300 KB; each `lang-*` / legacy mode a few KB, lazy. | ✅ **Small.** CM core + Shiki `core`+`engine-javascript` (~tens of KB); each grammar a lazy ~10–50 KB chunk. | ❌ **Largest.** 2–5 MB+ (min+gz **>2 MB**); ~5–10 MB uncompressed. | ⚠️ CM small, but `web-tree-sitter` runtime + **one wasm per language** (100 KB–1 MB each). |
| **4. Large files** | ✅ Incremental Lezer re-parse; legacy modes line-based. Viewport render. | ⚠️ **Weak spot.** `codeToTokens` is O(n) per pass, CPU-bound → must **viewport-tokenize + debounce + gate** big files (see strategy). | ✅ Very good (workers, viewport). | ✅ Incremental re-parse; good. |
| **5. Theming** | ⚠️ CM themes (`one-dark`, thememirror). Highlight = ~12 generic tags; decent, not VS Code-rich. Light/dark = swap theme extension. | ✅ **Best.** Real **VS Code themes** (vitesse-dark, tokyo-night, one-dark-pro…) → nails "dark terminal"; **native dual light/dark** via CSS variables. | ✅ VS Code themes (it *is* VS Code). Light/dark built-in. | ⚠️ You map capture names → CSS yourself; DIY theming. |
| **6. Add a language** | ❌–⚠️ Write a **Lezer grammar** (hard) or a StreamLanguage (medium, coarse). | ✅ **Trivial** — already bundled; just lazy-import the grammar. Custom = drop in any `.tmLanguage.json`. | ⚠️ Write a **Monarch** grammar (medium). | ❌ Build a tree-sitter grammar to wasm + write highlight queries + CM glue (hard). |
| **7. Tauri / WebKit** | ✅ **Cleanest.** Pure JS, no wasm, no workers. | ✅ **Clean** with **JS engine** (`@shikijs/engine-javascript`): no wasm, no workers → ideal for WebKitGTK. (Oniguruma engine would add wasm — avoid it.) | ❌ **Painful.** Needs web workers; documented Tauri *"Could not create web worker(s)"* failures → main-thread fallback + UI freeze; needs `MonacoEnvironment.getWorker` + a Vite plugin. | ⚠️ Runs (WebKitGTK supports wasm) but heavier wasm init; asset-hosting + `locateFile` setup; no mature CM integration. |
| **8. Maint. + license** | ✅ CM6 by M. Haverbeke, very active. **MIT.** | ✅ CM6 **MIT** + Shiki (shikijs / Anthony Fu, v3, very active) **MIT**; grammars redistributed via `tm-grammars` (permissive, per-grammar upstream licenses). | ✅ Microsoft, active. **MIT.** | ✅ tree-sitter active. **MIT**; per-grammar licenses vary. |

⭐ = recommended. Legend: ✅ strong · ⚠️ caveat · ❌ weak/blocker.

### The decisive row is **coverage of the discriminating cases**

The requirements name Kotlin and point at the long tail (Zig) precisely because
that is where engines diverge:

- **Kotlin**: CM6 has **no** real Kotlin grammar — the best it offers is the
  generic `clike` stream mode, which colors braces/strings/keywords but does not
  understand Kotlin (string templates, `when`, coroutines syntax, `?.`, etc.).
  Shiki and Monaco both ship a real Kotlin grammar. Shiki's is the actual VS Code
  Kotlin grammar.
- **Zig**: CM6 native and Monaco basic-languages have **nothing** — you'd author a
  grammar. Shiki ships `zig` out of the box.

Only **Shiki** covers *both* discriminating cases first-class **and** the entire
long tail with zero per-language authoring. That is the whole ballgame for a
"works on projects in ANY language" requirement.

---

## Why not the others (short form)

- **A. CM6 native** — the lightest and best *editing*, and fine if we only cared
  about ~20 mainstream languages. But it structurally fails the hard requirement:
  no Kotlin grammar (only coarse clike), no Zig, and the "long tail" is a patchwork
  of uneven-quality stream modes. Adding each missing language means authoring a
  Lezer grammar — the highest-effort path of all four. We **keep** these packages
  as an *optional* editing-enhancement tier (§ mapping table), not the base engine.
- **C. Monaco** — rejected as the editor component already (CodeMirror is small
  enough to ship many instances; Monaco is not). For highlighting too: 2–5 MB+ bundle, per-instance RAM,
  **web-worker requirement that misbehaves under Tauri/WebKitGTK** (documented
  *"Could not create web worker"* → main-thread fallback → UI freeze), and it
  *still* lacks Zig. Wrong tool for a lightweight, many-instances, WebKitGTK app.
- **D. tree-sitter on CM6** — technically the richest (real AST → great highlight
  *and* structure), but: C-in-wasm, **no mature CM6 integration** (the CM/Lezer
  maintainers built Lezer *instead of* embedding tree-sitter precisely because C-in-
  browser is awkward), a wasm blob + highlight-query authoring **per language**, and
  asset-hosting friction. Highest integration risk for a v1. Park it as a future
  option if we ever want semantic/structural features.

---

## Final recommendation

**Adopt Option B: CodeMirror 6 (editor) + Shiki (highlighting), JS engine, via a
decoration `ViewPlugin`.** Concretely:

1. **Editor stays CodeMirror 6** — unchanged. We keep CM's editing core
   (viewport rendering, selection, bracket-match, auto-close brackets, basic
   indentation, search) — all language-agnostic and already justified.
2. **Highlighting engine = Shiki**, fine-grained bundle:
   `shiki/core` + `@shikijs/engine-javascript` (pure JS — **no wasm/worker**),
   with per-language grammars and themes **lazy-imported on demand**.
3. **Integration = a CM6 `ViewPlugin`** that tokenizes the **visible viewport**
   with Shiki and emits a `DecorationSet` of `Decoration.mark` spans. This pattern
   is proven in production (the Obsidian Shiki plugin ships exactly this; the
   `@cmshiki/*` and `uxiew/codemirror-shiki` packages also implement it) — we
   hand-roll a thin version for control over lazy-loading and large-file gating.
4. **Optional Lezer tier**: for a short high-value list (JS/TS, Python, Rust, JSON,
   Markdown, HTML, CSS) we *may* also attach the `@codemirror/lang-*` package to
   regain syntax-aware folding + auto-indent. If we do, Shiki still owns the
   *coloring* (attach the language for its `foldNodeProp`/`indentNodeProp` only, or
   accept a two-tier color story). **Deferred past v1** — not needed to satisfy the
   requirement, and single-engine coloring keeps visuals consistent.

### Consequences / track-offs we accept

- We **lose syntax-aware code folding and language-aware auto-indent** on
  Shiki-only languages (kept: bracket match, auto-close, basic indent, search).
  Acceptable because editing supports supervision, not a full IDE, and
  recoverable per-language via the optional Lezer tier.
- Shiki tokenization is **CPU-bound and O(n)**, so we **must** viewport-tokenize +
  debounce + gate large files (§ Large-file strategy). This is the one thing to
  implement carefully.
- The JS RegExp engine occasionally can't compile an exotic Oniguruma construct in
  a grammar; run it in **`forgiving`** mode so a bad pattern degrades that one rule
  rather than throwing. Mainstream grammars (incl. Kotlin, Zig) are unaffected.

---

## Does this change the editor?

**No — CodeMirror 6 remains the editor.** Only the highlighting differs from the
default CM6 approach ("map by file extension to the `@codemirror/lang-*` package").
The decision below refines the stack choice rather than replacing it.

### Decision record

> ## Editor highlighting engine: Shiki over CodeMirror 6
> **Status:** Accepted (refines the CodeMirror 6 stack choice).
>
> **Context:** The editor must open files in **any** language with correct syntax
> colors (Kotlin `.kt` and the long tail incl. Zig are the discriminating cases).
> CodeMirror 6's native Lezer packages cover only ~19 languages and have **no real
> Kotlin grammar and no Zig grammar**; `@codemirror/legacy-modes` fills the tail
> only with coarse, uneven stream modes. Monaco (2–5 MB+, web-worker requirement
> that misbehaves under Tauri/WebKitGTK) and tree-sitter (C-in-wasm, no mature CM
> integration, per-language wasm + query authoring) are both too heavy for a
> lightweight many-instances app on the WebKitGTK path.
>
> **Decision:** Keep **CodeMirror 6** as the editor. Use **Shiki**
> (TextMate grammars, VS Code's highlighter) as the highlighting engine, layered on
> CM6 via a decoration `ViewPlugin`, using Shiki's **pure-JS RegExp engine**
> (`@shikijs/engine-javascript`, `forgiving` mode) — **no WebAssembly, no web
> workers**. Grammars and themes are **lazy-imported per language** (Vite async
> chunks). Highlighting is **viewport-scoped, debounced, and gated on large files**.
> Optionally attach `@codemirror/lang-*` for a few languages to regain
> syntax-aware folding / auto-indent (deferred past v1).
>
> **Consequences:** Universal, VS Code-grade colors incl. Kotlin & Zig at near-zero
> per-language effort; tiny lazy bundle; WebKitGTK-friendly (no wasm/workers); real
> VS Code themes give the dark-terminal look + native light/dark. Cost: no
> syntax-aware fold/auto-indent on Shiki-only languages (acceptable: editing is secondary);
> Shiki tokenization is CPU-bound, mitigated by viewport + debounce + large-file
> gate. Replaces `@codemirror/lang-*` as the highlighting mechanism.

---

## Extension → grammar / package mapping (recommended engine)

Detection is **by filename first** (special files like `Dockerfile`, `Makefile`,
`CMakeLists.txt`, `.gitignore`), then **by extension**. The **Shiki lang id** is the
grammar to lazy-load. The **Lezer** column notes the optional `@codemirror/lang-*`
(or `legacy-modes`) package if we ever enable the editing tier for that language;
"—" = Shiki-only (still fully highlighted). This is the core of the language map;
Shiki bundles 200+ ids, so any not listed here is a one-line addition.

| Ext / filename | Shiki lang id | Optional Lezer editing pkg |
|---|---|---|
| `.js .mjs .cjs` | `javascript` | `@codemirror/lang-javascript` |
| `.jsx` | `jsx` | `@codemirror/lang-javascript` (jsx) |
| `.ts .mts .cts` | `typescript` | `@codemirror/lang-javascript` (ts) |
| `.tsx` | `tsx` | `@codemirror/lang-javascript` (ts+jsx) |
| `.py .pyi` | `python` | `@codemirror/lang-python` |
| `.rs` | `rust` | `@codemirror/lang-rust` |
| `.go` | `go` | `@codemirror/lang-go` |
| `.java` | `java` | `@codemirror/lang-java` |
| **`.kt .kts`** | **`kotlin`** | — (legacy `clike` only; coarse) |
| `.cpp .cc .cxx .hpp .hh .hxx` | `cpp` | `@codemirror/lang-cpp` |
| `.c .h` | `c` | `@codemirror/lang-cpp` |
| `.cs` | `csharp` | — (legacy `clike`) |
| `.swift` | `swift` | — (legacy `swift`) |
| `.scala .sc` | `scala` | — (legacy `clike`) |
| `.dart` | `dart` | — (legacy `clike`) |
| `.rb .rake .gemspec` | `ruby` | — (legacy `ruby`) |
| `.php` | `php` | `@codemirror/lang-php` |
| **`.zig`** | **`zig`** | — |
| `.sh .bash .zsh` | `bash` | — (legacy `shell`) |
| `.ps1 .psm1` | `powershell` | — (legacy `powershell`) |
| `.sql` | `sql` | `@codemirror/lang-sql` |
| `.yaml .yml` | `yaml` | `@codemirror/lang-yaml` |
| `.toml` + `Cargo.lock` | `toml` | — (legacy `toml`) |
| `.json .jsonc .json5` | `json` / `jsonc` / `json5` | `@codemirror/lang-json` |
| `.md .markdown` | `markdown` | `@codemirror/lang-markdown` |
| `.mdx` | `mdx` | — |
| `.html .htm` | `html` | `@codemirror/lang-html` |
| `.css` | `css` | `@codemirror/lang-css` |
| `.scss` | `scss` | `@codemirror/lang-sass` |
| `.less` | `less` | `@codemirror/lang-less` |
| `.xml .svg .xsd` | `xml` | `@codemirror/lang-xml` |
| `.vue` | `vue` | `@codemirror/lang-vue` (community) |
| `.svelte` | `svelte` | — (community) |
| `.astro` | `astro` | — |
| `.lua` | `lua` | — (legacy `lua`) |
| `.r .R` | `r` | — (legacy `r`) |
| `.jl` | `julia` | — (legacy `julia`) |
| `.hs` | `haskell` | — (legacy `haskell`) |
| `.ex .exs` | `elixir` | — |
| `.erl .hrl` | `erlang` | — (legacy `erlang`) |
| `.clj .cljs .cljc .edn` | `clojure` | — (legacy `clojure`) |
| `.pl .pm` | `perl` | — (legacy `perl`) |
| `.groovy .gradle` | `groovy` | — (legacy `groovy`) |
| `.nim` | `nim` | — |
| `.elm` | `elm` | — (legacy `elm`) |
| `.hcl .tf .tfvars` | `hcl` / `terraform` | — |
| `.proto` | `proto` | — (legacy `protobuf`) |
| `.graphql .gql` | `graphql` | — (community) |
| `.tsv .csv` | `csv` | — |
| `.ini .cfg .conf .properties` | `ini` | — (legacy `properties`) |
| `.diff .patch` | `diff` | — (legacy `diff`) |
| `.vim` | `viml` | — |
| `.prisma` | `prisma` | — |
| `Dockerfile .dockerfile` | `docker` | — (legacy `dockerfile`) |
| `Makefile .mk` | `make` | — |
| `CMakeLists.txt .cmake` | `cmake` | — (legacy `cmake`) |
| _(unknown)_ | `null` → plaintext | — |

That is 55+ mappings covering both discriminating cases (**Kotlin**, **Zig**) and
the full named long tail; any of Shiki's remaining ~150 ids is a one-row addition.

---

## Lazy-loading strategy

Goal: base bundle stays tiny; a grammar's cost is paid only when a file of that
language is opened, once per session.

**1. Base (eager, small):** create one shared highlighter with the JS engine and
**zero preloaded languages** and just the two themes we ship.

```ts
// src/features/editor/shiki.ts
import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
// Two themes shipped eagerly (dark-terminal default + light). Any VS Code theme works.
import tokyoNight from "@shikijs/themes/tokyo-night";   // dark "terminal" aesthetic
import githubLight from "@shikijs/themes/github-light";

let hlP: Promise<Awaited<ReturnType<typeof createHighlighterCore>>> | null = null;
export function highlighter() {
  return (hlP ??= createHighlighterCore({
    themes: [tokyoNight, githubLight],
    langs: [],                                   // nothing preloaded
    engine: createJavaScriptRegexEngine({ forgiving: true }), // no wasm; degrade bad rules
  }));
}

const loaded = new Set<string>();
export async function ensureLang(id: string): Promise<boolean> {
  if (id === "null" || loaded.has(id)) return loaded.has(id);
  const hl = await highlighter();
  try {
    // Dynamic import ⇒ Vite emits one async chunk per grammar (~10–50 KB).
    const grammar = await import(`@shikijs/langs/${id}`);
    await hl.loadLanguage(grammar.default);
    loaded.add(id);
    return true;
  } catch {
    return false;                                // unknown/failed ⇒ caller renders plaintext
  }
}
```

**2. On file open:** `id = detect(path)` (table above) → `await ensureLang(id)` →
mount/refresh the editor. Grammar chunks are cached by the browser and by
`loaded`, so re-opening a `.kt` file is instant.

**3. Themes:** loaded once (dark + light). Toggle by re-tokenizing with the active
theme, **or** emit dual-theme CSS variables (`--shiki-dark` / `--shiki-light`) and
flip a `data-theme` attribute on the editor root — Shiki supports both; the CSS-var
path avoids re-tokenizing on toggle.

**4. Large-file gate (perf, criterion 4):** before attaching Shiki, check size.

- `> ~2 MB` **or** any line `> ~10 000` chars → open **plaintext, read-only**, no
  Shiki (matches the CodeMirror large-file guard). Offer "open externally" for multi-hundred-MB files.
- Otherwise attach the ViewPlugin, but **tokenize only the visible viewport ranges**
  (plus a small margin) and **debounce** re-tokenization (~30–50 ms) on edits/scroll.
  Never tokenize the whole document per keystroke.

**5. Fallback:** unknown extension or a grammar that fails to load → plaintext
(still fully editable). Optional later: content-sniffing for extensionless files.

---

## Minimal React integration sketch

A thin CM6 `ViewPlugin` that colors the viewport from Shiki tokens, plus the React
tab that lazy-loads the grammar. (Wire disposal the same disciplined way as the
xterm hook.)

```ts
// src/features/editor/shikiHighlight.ts
import { ViewPlugin, Decoration, type DecorationSet, EditorView } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import { highlighter } from "./shiki";

const markCache = new Map<string, Decoration>();
const mark = (color: string) =>
  markCache.get(color) ??
  markCache.set(color, Decoration.mark({ attributes: { style: `color:${color}` } })).get(color)!;

/** Colors the visible viewport by tokenizing each visible line with Shiki. */
export function shikiHighlighting(langId: string, theme: string) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet = Decoration.none;
      constructor(view: EditorView) { void this.build(view); }
      update(u: { view: EditorView; docChanged: boolean; viewportChanged: boolean }) {
        if (u.docChanged || u.viewportChanged) void this.build(u.view); // debounce upstream
      }
      async build(view: EditorView) {
        const hl = await highlighter();
        const b = new RangeSetBuilder<Decoration>();
        for (const { from, to } of view.visibleRanges) {
          let pos = from;
          for (const lineNo of linesIn(view, from, to)) {
            const line = view.state.doc.line(lineNo);
            // Tokenize ONE line; grammar state across lines is approximated for
            // viewport speed. (For exact multi-line state, cache per-line stacks.)
            const { tokens } = hl.codeToTokens(line.text, { lang: langId as any, theme });
            let col = line.from;
            for (const tok of tokens.flat()) {
              const start = col, end = col + tok.content.length;
              if (tok.color) b.add(start, end, mark(tok.color));
              col = end;
            }
            pos = line.to;
          }
          void pos;
        }
        this.decorations = b.finish();
        view.update([]); // schedule a repaint with the new decorations
      }
    },
    { decorations: (v) => v.decorations },
  );
}
function* linesIn(view: EditorView, from: number, to: number) {
  const a = view.state.doc.lineAt(from).number, z = view.state.doc.lineAt(to).number;
  for (let n = a; n <= z; n++) yield n;
}
```

```tsx
// src/features/editor/EditorTab.tsx
import { useEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { bracketMatching } from "@codemirror/language";
import { closeBrackets } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { detectLang } from "./detect";           // filename/ext → Shiki id (mapping table)
import { ensureLang } from "./shiki";
import { shikiHighlighting } from "./shikiHighlight";

const TOO_BIG = 2_000_000;
export function EditorTab({ path, text, dark }: { path: string; text: string; dark: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let view: EditorView | undefined;
    (async () => {
      const id = detectLang(path);
      const big = text.length > TOO_BIG || /[^\n]{10000,}/.test(text);
      const themed = dark ? "tokyo-night" : "github-light";
      const ok = !big && id !== "null" && (await ensureLang(id));
      const exts = [
        lineNumbers(), history(), bracketMatching(), closeBrackets(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorState.readOnly.of(big),
        ...(ok ? [shikiHighlighting(id, themed)] : []),   // Shiki-only coloring
        // Optional editing tier: ...(lezerFor(id) ?? [])  // fold/auto-indent (deferred)
      ];
      view = new EditorView({
        parent: host.current!,
        state: EditorState.create({ doc: text, extensions: exts }),
      });
    })();
    return () => view?.destroy();            // dispose on unmount / tab close
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);
  return <div ref={host} className="editor-host" />;
}
```

Notes: the sketch prioritizes clarity over exactness — production hardening adds
(a) a real debounce around `build`, (b) per-line grammar-state caching for exact
multi-line tokens (string/comment spillover), and (c) theme toggle via cached
dual-theme decorations instead of remounting. The `@cmshiki/*` package can stand in
for this plugin if we prefer a dependency over the hand-roll.

---

## Dependencies to add (`package.json`)

| Package | Role | License |
|---|---|---|
| `shiki` (use `shiki/core`) | highlighter core | MIT |
| `@shikijs/engine-javascript` | **pure-JS** RegExp engine (no wasm) | MIT |
| `@shikijs/langs` | lazy per-language grammars (`@shikijs/langs/<id>`) | MIT (grammars: permissive upstream) |
| `@shikijs/themes` | VS Code themes (dark-terminal + light) | MIT |
| `codemirror` + `@codemirror/{view,state,commands,language,autocomplete}` | editor (already in the stack) | MIT |
| _(optional, editing tier)_ `@codemirror/lang-*`, `@codemirror/legacy-modes` | fold/auto-indent for select langs | MIT |

Everything MIT; all-JS; **no web workers, no wasm** on the recommended path — the
right shape for the Tauri/WebKitGTK constraint.

---

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Shiki O(n) tokenization janks large files | Viewport-only tokenization + debounce + hard size/line gate → plaintext read-only. |
| Multi-line token state (strings/comments) approximated per-line in the sketch | Cache per-line grammar stacks (what mature integrations do); or accept minor edge cases in v1. |
| JS RegExp engine can't compile an exotic grammar rule | `forgiving: true` degrades the offending rule, not the file; mainstream langs unaffected. |
| Theme toggle re-tokenizes | Emit dual-theme CSS variables and flip `data-theme` — no re-tokenize. |
| Grammar chunk fails to load offline | Grammars are bundled locally by Vite (not fetched at runtime); fallback = plaintext. |
| We later need syntax-aware fold/auto-indent | Attach the optional `@codemirror/lang-*` Lezer tier per language. |

**Verification gate:** benchmark viewport highlighting of Kotlin, Zig, and a 2 MB
file on the mid-range Ubuntu/WebKitGTK box used for the M1 terminal gate before
committing the editor past M4.

---

## Sources

- CodeMirror `language` / official lang packages — [github.com/codemirror/language](https://github.com/codemirror/language), [language-data](https://github.com/codemirror/language-data/blob/main/src/language-data.ts)
- CodeMirror `legacy-modes` (clike incl. kotlin/scala/dart/csharp; full mode list) — [github.com/codemirror/legacy-modes](https://github.com/codemirror/legacy-modes/blob/main/README.md)
- Lezer vs tree-sitter (why CM uses Lezer; C-in-browser awkwardness) — [discuss.CodeMirror: Question difference between Lezer and tree-sitter](https://discuss.codemirror.net/t/question-difference-between-lezer-and-tree-sitter/3115), [Lezer System Guide](https://lezer.codemirror.net/docs/guide/)
- Shiki — [shiki.style](https://shiki.style/), [Bundles](https://shiki.style/guide/bundles), [Best Performance](https://shiki.style/guide/best-performance), [RegExp Engines (JS vs Oniguruma)](https://shiki.style/guide/regex-engines), [Dual light/dark themes](https://shiki.style/guide/dual-themes), [Languages](https://shiki.style/languages)
- Shiki grammar coverage (Kotlin, Zig, Swift, Scala, Dart, C#, … via `tm-grammars`) — [shikijs/textmate-grammars-themes](https://github.com/shikijs/textmate-grammars-themes)
- Shiki + CodeMirror integration — [discuss.CodeMirror: Shiki integration](https://discuss.codemirror.net/t/shiki-integration-for-codemirror/9538), [uxiew/codemirror-shiki](https://github.com/uxiew/codemirror-shiki), [@cmshiki/editor (npm)](https://www.npmjs.com/package/@cmshiki/editor), [obsidian-shiki-plugin Cm6_ViewPlugin (production example)](https://github.com/mProjectsCode/obsidian-shiki-plugin/blob/master/src/codemirror/Cm6_ViewPlugin.ts)
- Monaco — [Language Support](https://deepwiki.com/thebaselab/monaco-editor-core/5-language-support), [ESM integration docs](https://github.com/microsoft/monaco-editor/blob/main/docs/integrate-esm.md), Tauri web-worker failure — [tauri-apps discussion #9595](https://github.com/orgs/tauri-apps/discussions/9595), Vite plugin — [vdesjs/vite-plugin-monaco-editor](https://github.com/vdesjs/vite-plugin-monaco-editor)
- Bundle-size comparison (Monaco 2–5 MB+ vs CM6 ~150–300 KB; Replit/Sourcegraph migrations) — [Sourcegraph: Migrating Monaco→CodeMirror](https://sourcegraph.com/blog/migrating-monaco-codemirror), [Monaco vs CodeMirror 6 vs Sandpack 2026 (PkgPulse)](https://www.pkgpulse.com/guides/monaco-editor-vs-codemirror-6-vs-sandpack-in-browser-2026)
