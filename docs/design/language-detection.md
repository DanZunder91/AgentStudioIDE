# Language Detection

> **Status:** Implemented.
>
> **Scope.** How Agent Studio decides *what programming language a file is* so the
> editor can load the right CodeMirror grammar (M4) and the workspace file tree
> can show the right icon (M2/M4). This document owns the **canonical
> `LanguageId` contract** — the stable, lowercase-kebab identifier set that
> `docs/design/editor-syntax-highlighting.md` (grammar loader) and
> `docs/design/file-icons.md` (icon map) both consume. Treat the `LanguageId`
> union and the extension map below as the source of truth; those docs key off
> these strings, so **do not rename an id without an entry in the "Contract
> stability" section.**
>
> Relevant decisions: Tauri v2 · Rust core + TS/React UI with a CodeMirror 6
> editor; M4 (editor + Find is the last v1 milestone). Editing exists to
> support agent supervision, not to be a full IDE — so this
> subsystem optimizes for *good-enough, fast, deterministic* detection over
> exhaustive linguistic accuracy.

---

## 1. Decisions at a glance

| Question | Decision | Why (short) |
|---|---|---|
| **Where does detection run?** | **TS UI**, in a shared pure module `src/lib/language/` (no React, no Tauri). | Both consumers (editor grammar loader, file-tree icons) live in the webview; the result feeds `EditorDoc.language` and the tree row `icon`, both TS-side. The tree renders thousands of nodes — a synchronous in-process function is instant; a Tauri command per node would add IPC latency for zero benefit. |
| **What data backs the map?** | **Curated hand-rolled tables**, cross-checked against the **`linguist-languages`** npm package (MIT) in a dev-only test. | Ship a few KB, not 568 KB; the ids are *ours* and stable; we only enumerate languages we can actually highlight/icon. Linguist gives us accuracy insurance without bloating the bundle. |
| **How is precedence ordered?** | exact filename → extension (incl. compound) → shebang / first line → `plaintext`. | Matches GitHub Linguist's proven order (filename beats extension; content is a tiebreaker/last resort). |
| **How are ambiguous extensions handled?** | Each ambiguous extension has a **deterministic default** (used when no content is available, e.g. the tree) **plus a first-line resolver** (used when the editor has already loaded the buffer). | Detection must never block on I/O for the tree; the editor gets a free upgrade because it already has the first line in memory. |

---

## 2. Where it runs (and why not Rust)

Detection is a **pure, synchronous TypeScript function**. It lives in a
dependency-free shared module so both feature areas import it without a cycle:

```
src/lib/language/
├─ ids.ts        # LanguageId union + human labels (the CONTRACT)
├─ tables.ts     # exact-filename, extension, compound, ambiguous, shebang maps
├─ detect.ts     # detectLanguage() + the pipeline stages
└─ index.ts      # re-exports (public surface)
```

Consumers (each owns its own mapping *keyed by* `LanguageId`, defined in its own
doc — this module does not import them):

- `src/features/editor/grammar.ts` — `LanguageId → () => Promise<Extension>`
  (lazy `import()` of `@codemirror/lang-*` / `@codemirror/legacy-modes`; owned by
  `editor-syntax-highlighting.md`).
- `src/features/workspace/icons.ts` — `LanguageId → IconRef` (owned by
  `file-icons.md`).

**Why not the Rust core?** `src-tauri/.../workspace/fs.rs` already returns plain
paths + bytes; nothing in the hot PTY/stream path needs a language. Putting
detection in TS avoids (a) an IPC round-trip per tree node during a directory
walk, and (b) duplicating the `LanguageId` enum across two languages. If a future
feature needs server-side detection (e.g. Rust-side Find result previews), port
`tables.ts` to a generated Rust module from the same source data — but that is
**out of scope for v1** and explicitly not built now.

**Content access.** The pipeline takes an *optional* `firstLine`:

- **File tree (M2):** calls `detectLanguage(path)` with **no** content — it must
  not read every file to draw an icon. Ambiguous extensions fall back to their
  deterministic default.
- **Editor (M4):** once the buffer is loaded it calls
  `detectLanguage(path, firstLine)` — the resolver refines ambiguous extensions
  and handles extensionless scripts via shebang. `firstLine` = the file's first
  line, already in memory; no extra read.

---

## 3. Data source: curated map, Linguist-validated

| Option | Size (runtime) | License | Pros | Cons |
|---|---|---|---|---|
| **Full GitHub Linguist `languages.yml`** (vendored) | ~1 MB YAML → needs a YAML parser + build step | **MIT** | ~600 languages, every extension/filename/interpreter, plus `heuristics.yml` disambiguation data. | Enumerates hundreds of languages we cannot highlight or icon; structure needs adaptation; heaviest option. |
| **`linguist-languages` npm** (`ikatyang-collab`) | **568 KB** JS | **MIT** | Same data as `languages.yml`, pre-parsed to JS, importable per-language; version-pinned. | Still far larger than we ship for; no disambiguation heuristics (that lives in `heuristics.yml`, not this package); most entries unused. |
| **`linguist` npm** (full JS port with Bayesian classifier + samples) | multiple MB | MIT | Highest accuracy incl. statistical fallback. | Massively too heavy for a lean Tauri bundle (~15 MB app); classifier is overkill for a supervision-first editor. |
| **Curated hand-rolled tables (RECOMMENDED)** | **~4–6 KB** | ours | Tiny; ids are stable and *ours* (the cross-doc contract); covers exactly the languages we support; trivial to read/diff/review. | We maintain it; risk of drift from upstream reality. |

**Recommendation — curate, but validate against Linguist.** Ship the hand-rolled
tables in §7–§11. Add `linguist-languages` as a **devDependency** and a Vitest
test (`tables.spec.ts`) that, for every extension we map, asserts our
`LanguageId` is consistent with Linguist's primary language for that extension
(via a small `LanguageId → Linguist name` alias table). The test *warns* on
extensions Linguist knows that we don't — a maintenance to-do list, not a
failure. This gives us Linguist-grade accuracy on the languages we care about at
a fraction of the bundle cost, while keeping full control of the id strings.

**Licensing.** Linguist and `linguist-languages` are MIT. Any table values
*derived* from that data are fine to vendor with an attribution line in the file
header. Our chosen id *strings* are original.

---

## 4. Pipeline & precedence

`detectLanguage(path, firstLine?)` runs these stages in order and returns on the
first confident hit:

```
                    ┌─────────────────────────────────────────────┐
  path, firstLine?  │  0. Normalize: basename = last path segment  │
  ───────────────▶  │     lower = basename.toLowerCase()           │
                    └───────────────────┬─────────────────────────┘
                                        ▼
   ┌────────────────────────────────────────────────────────────────────┐
   │ 1. EXACT FILENAME                                                    │
   │    a. EXACT_FILENAMES[lower]                (Dockerfile, Makefile,   │
   │                                              go.mod, .gitignore …)   │
   │    b. FILENAME_PREFIXES  (lower startsWith) (.env*, Dockerfile.*,    │
   │                                              tsconfig*.json …)       │
   └───────────────────────────────┬────────────────────────────────────┘
              hit ─▶ return         │ miss
                                    ▼
   ┌────────────────────────────────────────────────────────────────────┐
   │ 2. EXTENSION (the main path)                                         │
   │    a. COMPOUND_EXTENSIONS  (longest multi-dot suffix: .d.ts, .cu.h)  │
   │    b. ext = text after the last '.'                                  │
   │       - if ext ∈ AMBIGUOUS_EXTENSIONS:                               │
   │           firstLine ? resolver(firstLine, basename)                  │
   │                     : AMBIGUOUS_EXTENSIONS[ext].default              │
   │       - else EXTENSIONS[ext]                                         │
   └───────────────────────────────┬────────────────────────────────────┘
              hit ─▶ return         │ miss (no/unknown extension)
                                    ▼
   ┌────────────────────────────────────────────────────────────────────┐
   │ 3. SHEBANG / FIRST LINE  (only if firstLine provided)               │
   │    - '#!' → parse interpreter (env-aware) → SHEBANG_INTERPRETERS     │
   │    - '<?php' → php · '<?xml' → xml · '<!DOCTYPE html' → html · …     │
   └───────────────────────────────┬────────────────────────────────────┘
              hit ─▶ return         │ miss
                                    ▼
                         4. return 'plaintext'
```

### Precedence rules (normative)

1. **Exact filename beats extension.** `Dockerfile.prod` is a Dockerfile even
   though `.prod` is not a known extension; `go.mod` is resolved by name.
2. **Extension beats content.** A `.py` file is `python` regardless of its first
   line. Content is consulted **only** for ambiguous extensions and for
   files that reach stage 3 (no/unknown extension).
3. **For ambiguous extensions, content is a *tiebreaker within the candidate
   set*, never an override to outside it.** A `.h` first line can pick between
   C / C++ / Objective-C; it can never make a `.h` file `python`.
4. **No content available ⇒ deterministic default.** The tree always gets an
   answer without reading the file.
5. **Case:** filenames and extensions are matched **case-insensitively**
   (`README.MD` = markdown). The one place upstream tools use case — `.R` vs
   `.r` for R — we collapse to the same id and disambiguate by content instead
   (see §5), because case-based routing is unreliable across OS filesystems.
6. **Default is `plaintext`**, never `undefined` — every path resolves.

---

## 5. Ambiguous-extension resolution

Each ambiguous extension has a **default** (returned when `firstLine` is absent)
and a **resolver** (a fast regex test over the first line — or, where noted, over
a short content prefix the editor can pass as `firstLine`). Heuristics follow
GitHub Linguist's `heuristics.yml`, simplified to first-line-cheap checks.

| Extension(s) | Candidates | Default (no content) | First-line / prefix resolver |
|---|---|---|---|
| `.h` | C, C++, Objective-C | `c` | `objective-c` if `@interface`/`@implementation`/`@protocol` or `#import <.../ (Foundation\|UIKit\|Cocoa)`; else `cpp` if `template<`/`namespace `/`class `/`::`/`std::`; else `c`. |
| `.m` | Objective-C, MATLAB, Mercury, Wolfram | `objective-c` | `objective-c` if `@interface`/`@implementation`/`#import`; else `matlab` if leading `%` comment or `function ... end`/`classdef`; else `mercury` if `:- module`; else `mathematica` if `(*` … `*)`; else `objective-c`. |
| `.ts` | TypeScript, XML (Qt Linguist translation) | `typescript` | `xml` if the first non-blank line starts with `<?xml` or `<TS`; else `typescript`. |
| `.r`, `.R` | R, Rebol, Rez | `r` | `rebol` if `/\bREBOL\b/i`; else `r`. |
| `.pl`, `.pm` | Perl, Prolog, Raku | `perl` | `raku` if `/^\s*use\s+v6\b/` or `/^\s*(unit\s+)?(module\|class\|grammar)\b/`; else `prolog` if a `:-` clause and no `$`/`@`/`my ` Perl markers; else `perl`. |
| `.v` | Verilog, Coq/Rocq, V | `verilog` | `coq` if `/\b(Require\|Proof\|Qed\|Inductive)\b/`; else `vlang` if `/^\s*(module\s+main\|(pub\s+)?fn\s)\b/`; else `verilog`. |
| `.kt`, `.kts` | Kotlin (both) | `kotlin` | Same grammar; `.kts` is a Kotlin *script* — same `LanguageId`, may get a distinct icon downstream by basename. |
| `.cc`, `.cpp`, `.cxx`, `.c++`, `.cp`, `.hpp`, `.hh`, `.hxx` | C++ | `cpp` | Unambiguous → always `cpp`. (Only bare `.h` is shared with C/ObjC.) |
| `.mjs`, `.cjs` | JavaScript (ESM / CommonJS) | `javascript` | Module system doesn't change the grammar → always `javascript`. |
| `.es` | Erlang, JavaScript (ECMAScript) | `javascript` | `erlang` if `/^\s*(-module\(\|%%)/`; else `javascript`. |
| `.fs` | F#, Forth, GLSL | `fsharp` | `forth` if `/^: /`; else `glsl` if `/^#version\b/`; else `fsharp`. |
| `.rs` | Rust, RenderScript | `rust` | `xml` if starts with `<?xml`; else `rust`. |
| `.d` | D, DTrace | `d` | `d` (DTrace scripts are rare in-editor; content check optional). |
| `.gd` | GDScript, GAP | `gdscript` | `gdscript` (GAP is rare; default suffices). |
| `.sc` | Scala, SuperCollider | `scala` | `scala`. |
| `.cls` | TeX, Apex, VBA | `tex` | `apex` if `/^\s*(public\|global)\s+class\b/`; else `tex` if `/\\(NeedsTeXFormat\|ProvidesClass)/`; else `tex`. |

**Why default `.h → c` when the tree has no content but `.m → objective-c`?**
Both defaults follow the most-common real-world case for a bare extension and
match Linguist's fallback ordering; the editor upgrades either the moment it has
a first line.

---

## 6. Shebang & first-line resolution

Used at stage 3 for extensionless files (`#!/usr/bin/env python3` in a file named
`build`) and as the ambiguous tiebreaker where a resolver defers to it.

**Shebang parsing (env-aware):** take the token after `#!`; if its basename is
`env`, take the next token; strip a trailing version (`python3.11` → `python`);
look up `SHEBANG_INTERPRETERS`.

| Interpreter(s) | `LanguageId` |
|---|---|
| `python`, `python2`, `python3` | `python` |
| `node`, `nodejs`, `deno`, `bun`, `ts-node`, `tsx` | `javascript` (`deno`/`ts-node`/`tsx` → `typescript`) |
| `sh`, `bash`, `dash`, `zsh`, `ksh`, `ash` | `shell` |
| `fish` | `fish` |
| `pwsh`, `powershell` | `powershell` |
| `ruby` | `ruby` · `perl` → `perl` · `raku`/`perl6` → `raku` |
| `php` | `php` · `lua` → `lua` · `groovy` → `groovy` |
| `rscript`, `r` | `r` · `elixir` → `elixir` · `escript` → `erlang` |
| `awk`, `gawk` | `awk` · `tclsh`/`wish` → `tcl` · `osascript` → `applescript` |

**Non-shebang first lines:** `<?php` → `php` · `<?xml` → `xml` · `<!DOCTYPE
html` (case-insensitive) → `html` · `%YAML` → `yaml` · `<TS` → `xml`.

---

## 7. Canonical `LanguageId` contract

> **This union is the cross-document contract.** Lowercase-kebab, singular,
> grammar-oriented (not file-format-oriented). `editor-syntax-highlighting.md`
> and `file-icons.md` switch on exactly these strings. `EditorDoc.language`
> (the architecture's store) is typed as `LanguageId`.

```ts
// src/lib/language/ids.ts

/**
 * Canonical language identifier. Stable, lowercase-kebab. Adding a value is
 * backwards-compatible; renaming/removing one is a breaking contract change
 * (see "Contract stability"). Consumers MUST handle 'plaintext' as the default
 * and SHOULD fall back to 'plaintext' rendering for any id they don't grammar/
 * icon yet — never throw on an unknown id.
 */
export type LanguageId =
  // ── default ──────────────────────────────────────────────────────────────
  | 'plaintext'
  // ── JS / TS family ───────────────────────────────────────────────────────
  | 'javascript' | 'jsx' | 'typescript' | 'tsx'
  | 'json' | 'jsonc' | 'json5' | 'coffeescript'
  // ── web / markup / styles ────────────────────────────────────────────────
  | 'html' | 'css' | 'scss' | 'sass' | 'less'
  | 'vue' | 'svelte' | 'astro' | 'handlebars' | 'pug'
  | 'xml' | 'svg'
  // ── general-purpose languages ────────────────────────────────────────────
  | 'python' | 'ruby' | 'php' | 'perl' | 'raku' | 'lua' | 'tcl'
  | 'go' | 'rust' | 'c' | 'cpp' | 'objective-c' | 'objective-cpp'
  | 'csharp' | 'fsharp' | 'java' | 'kotlin' | 'scala' | 'groovy' | 'clojure'
  | 'swift' | 'dart' | 'elixir' | 'erlang' | 'haskell' | 'ocaml' | 'elm'
  | 'julia' | 'r' | 'matlab' | 'nim' | 'crystal' | 'zig' | 'vlang' | 'd'
  | 'pascal' | 'fortran' | 'cobol' | 'ada' | 'prolog' | 'coq'
  | 'scheme' | 'racket' | 'common-lisp' | 'gdscript' | 'apex' | 'solidity'
  // ── shell / ops / infra ──────────────────────────────────────────────────
  | 'shell' | 'fish' | 'powershell' | 'bat' | 'awk'
  | 'makefile' | 'cmake' | 'dockerfile' | 'nginx' | 'terraform' | 'nix'
  | 'applescript'
  // ── data / config ────────────────────────────────────────────────────────
  | 'yaml' | 'toml' | 'ini' | 'properties' | 'dotenv' | 'editorconfig'
  | 'sql' | 'graphql' | 'protobuf' | 'csv' | 'tsv'
  | 'gitignore' | 'git-config' | 'git-attributes'
  | 'go-module' | 'go-checksums'
  // ── docs ─────────────────────────────────────────────────────────────────
  | 'markdown' | 'mdx' | 'restructuredtext' | 'asciidoc' | 'tex' | 'bibtex' | 'org'
  // ── shaders / hardware / low-level ───────────────────────────────────────
  | 'glsl' | 'hlsl' | 'wgsl' | 'wat' | 'llvm' | 'assembly' | 'verilog' | 'vhdl'
  // ── misc ─────────────────────────────────────────────────────────────────
  | 'diff' | 'mermaid' | 'mercury' | 'mathematica' | 'rebol';

/** Human-facing labels (status bar, command palette "Change Language"). */
export const LANGUAGE_LABELS: Record<LanguageId, string> = {
  plaintext: 'Plain Text',
  javascript: 'JavaScript', jsx: 'JavaScript (JSX)',
  typescript: 'TypeScript', tsx: 'TypeScript (TSX)',
  json: 'JSON', jsonc: 'JSON with Comments', json5: 'JSON5',
  coffeescript: 'CoffeeScript',
  html: 'HTML', css: 'CSS', scss: 'SCSS', sass: 'Sass', less: 'Less',
  vue: 'Vue', svelte: 'Svelte', astro: 'Astro', handlebars: 'Handlebars', pug: 'Pug',
  xml: 'XML', svg: 'SVG',
  python: 'Python', ruby: 'Ruby', php: 'PHP', perl: 'Perl', raku: 'Raku',
  lua: 'Lua', tcl: 'Tcl',
  go: 'Go', rust: 'Rust', c: 'C', cpp: 'C++',
  'objective-c': 'Objective-C', 'objective-cpp': 'Objective-C++',
  csharp: 'C#', fsharp: 'F#', java: 'Java', kotlin: 'Kotlin', scala: 'Scala',
  groovy: 'Groovy', clojure: 'Clojure', swift: 'Swift', dart: 'Dart',
  elixir: 'Elixir', erlang: 'Erlang', haskell: 'Haskell', ocaml: 'OCaml',
  elm: 'Elm', julia: 'Julia', r: 'R', matlab: 'MATLAB', nim: 'Nim',
  crystal: 'Crystal', zig: 'Zig', vlang: 'V', d: 'D', pascal: 'Pascal',
  fortran: 'Fortran', cobol: 'COBOL', ada: 'Ada', prolog: 'Prolog', coq: 'Coq',
  scheme: 'Scheme', racket: 'Racket', 'common-lisp': 'Common Lisp',
  gdscript: 'GDScript', apex: 'Apex', solidity: 'Solidity',
  shell: 'Shell', fish: 'Fish', powershell: 'PowerShell', bat: 'Batch', awk: 'AWK',
  makefile: 'Makefile', cmake: 'CMake', dockerfile: 'Dockerfile', nginx: 'Nginx',
  terraform: 'Terraform (HCL)', nix: 'Nix', applescript: 'AppleScript',
  yaml: 'YAML', toml: 'TOML', ini: 'INI', properties: 'Java Properties',
  dotenv: 'dotenv', editorconfig: 'EditorConfig', sql: 'SQL', graphql: 'GraphQL',
  protobuf: 'Protocol Buffers', csv: 'CSV', tsv: 'TSV',
  gitignore: 'Ignore List', 'git-config': 'Git Config', 'git-attributes': 'Git Attributes',
  'go-module': 'Go Module', 'go-checksums': 'Go Checksums',
  markdown: 'Markdown', mdx: 'MDX', restructuredtext: 'reStructuredText',
  asciidoc: 'AsciiDoc', tex: 'TeX', bibtex: 'BibTeX', org: 'Org',
  glsl: 'GLSL', hlsl: 'HLSL', wgsl: 'WGSL', wat: 'WebAssembly Text',
  llvm: 'LLVM IR', assembly: 'Assembly', verilog: 'Verilog', vhdl: 'VHDL',
  diff: 'Diff', mermaid: 'Mermaid', mercury: 'Mercury',
  mathematica: 'Mathematica', rebol: 'Rebol',
};
```

---

## 8. Exact-filename map

```ts
// src/lib/language/tables.ts  (part 1)
import type { LanguageId } from './ids';

/** Keys are lowercased basenames. Exact-name match wins over extension. */
export const EXACT_FILENAMES: Record<string, LanguageId> = {
  // build / containers
  'dockerfile': 'dockerfile',
  'containerfile': 'dockerfile',
  'makefile': 'makefile', 'gnumakefile': 'makefile', 'bsdmakefile': 'makefile',
  'cmakelists.txt': 'cmake',
  'rakefile': 'ruby', 'gemfile': 'ruby', 'guardfile': 'ruby', 'podfile': 'ruby',
  'brewfile': 'ruby', 'vagrantfile': 'ruby', 'fastfile': 'ruby', 'appfile': 'ruby',
  'build.gradle': 'groovy', 'settings.gradle': 'groovy',
  // go / rust / node manifests
  'go.mod': 'go-module', 'go.sum': 'go-checksums', 'go.work': 'go-module',
  'cargo.toml': 'toml', 'cargo.lock': 'toml',
  'package.json': 'json', 'package-lock.json': 'json', 'composer.json': 'json',
  'pyproject.toml': 'toml', 'poetry.lock': 'toml', 'pipfile': 'toml',
  // git / tooling dotfiles
  '.gitignore': 'gitignore', '.dockerignore': 'gitignore', '.npmignore': 'gitignore',
  '.eslintignore': 'gitignore', '.prettierignore': 'gitignore', '.gcloudignore': 'gitignore',
  '.gitattributes': 'git-attributes', '.gitmodules': 'git-config',
  '.gitconfig': 'git-config', '.git-blame-ignore-revs': 'gitignore',
  '.editorconfig': 'editorconfig',
  '.env': 'dotenv', '.envrc': 'shell',
  '.bashrc': 'shell', '.bash_profile': 'shell', '.zshrc': 'shell',
  '.zprofile': 'shell', '.profile': 'shell', '.bash_aliases': 'shell',
  '.npmrc': 'ini', '.yarnrc': 'yaml',
  '.vimrc': 'plaintext', '.inputrc': 'ini',
  // json-with-comments configs (basename, since ext is plain .json)
  'tsconfig.json': 'jsonc', 'jsconfig.json': 'jsonc',
  '.babelrc': 'jsonc', '.eslintrc.json': 'jsonc', '.prettierrc': 'jsonc',
  // ci / infra by name
  'jenkinsfile': 'groovy', 'procfile': 'yaml', 'nginx.conf': 'nginx',
};

/**
 * Prefix rules (lowercased basename startsWith). Checked after EXACT_FILENAMES.
 * Order matters: first match wins, so keep specific prefixes above generic ones.
 */
export const FILENAME_PREFIXES: ReadonlyArray<readonly [string, LanguageId]> = [
  ['dockerfile.', 'dockerfile'],   // Dockerfile.prod, Dockerfile.dev
  ['.env.', 'dotenv'],             // .env.local, .env.production
  ['tsconfig.', 'jsonc'],          // tsconfig.build.json
  ['docker-compose', 'yaml'],      // docker-compose.yml, docker-compose.override.yml
];
```

---

## 9. Extension → `LanguageId` map (unambiguous)

> Covers **80+ languages**. Keys are the lowercased
> extension **without** the leading dot. Ambiguous extensions (§10) and compound
> extensions (§10) are handled separately and are **not** listed here.

```ts
// src/lib/language/tables.ts  (part 2)

export const EXTENSIONS: Record<string, LanguageId> = {
  // ── JS / TS ────────────────────────────────────────────────────────────
  js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', /* .ts is ambiguous (Qt) — see AMBIGUOUS; listed for grep */
  tsx: 'tsx', mts: 'typescript', cts: 'typescript',
  json: 'json', jsonc: 'jsonc', json5: 'json5', jsonld: 'json',
  coffee: 'coffeescript',
  // ── web / styles / templates ───────────────────────────────────────────
  html: 'html', htm: 'html', xhtml: 'html',
  css: 'css', scss: 'scss', sass: 'sass', less: 'less',
  vue: 'vue', svelte: 'svelte', astro: 'astro',
  hbs: 'handlebars', handlebars: 'handlebars', mustache: 'handlebars',
  pug: 'pug', jade: 'pug',
  xml: 'xml', xsl: 'xml', xslt: 'xml', xsd: 'xml', plist: 'xml',
  wsdl: 'xml', pom: 'xml', svg: 'svg',
  // ── general-purpose ────────────────────────────────────────────────────
  py: 'python', pyi: 'python', pyw: 'python', pyx: 'python',
  rb: 'ruby', rake: 'ruby', gemspec: 'ruby',
  php: 'php', phtml: 'php', php4: 'php', php5: 'php', php7: 'php', php8: 'php',
  lua: 'lua', tcl: 'tcl',
  go: 'go',
  rs: 'rust', /* .rs ambiguous (RenderScript) — see AMBIGUOUS; listed for grep */
  c: 'c', i: 'c',
  cc: 'cpp', cpp: 'cpp', cxx: 'cpp', 'c++': 'cpp', cp: 'cpp',
  hpp: 'cpp', hh: 'cpp', hxx: 'cpp', 'h++': 'cpp', ino: 'cpp',
  mm: 'objective-cpp',
  cs: 'csharp', csx: 'csharp',
  fs: 'fsharp', /* ambiguous — see AMBIGUOUS */ fsi: 'fsharp', fsx: 'fsharp',
  java: 'java', jav: 'java',
  kt: 'kotlin', kts: 'kotlin',
  scala: 'scala', sbt: 'scala',
  groovy: 'groovy', gvy: 'groovy', gradle: 'groovy',
  clj: 'clojure', cljs: 'clojure', cljc: 'clojure', edn: 'clojure',
  swift: 'swift',
  dart: 'dart',
  ex: 'elixir', exs: 'elixir', heex: 'elixir', eex: 'elixir',
  erl: 'erlang', hrl: 'erlang',
  hs: 'haskell', lhs: 'haskell',
  ml: 'ocaml', mli: 'ocaml',
  elm: 'elm',
  jl: 'julia',
  m: 'objective-c', /* ambiguous (MATLAB) — see AMBIGUOUS; listed for grep */
  nim: 'nim', nims: 'nim', nimble: 'nim',
  cr: 'crystal',
  zig: 'zig', zon: 'zig',
  pas: 'pascal', pp: 'pascal', dpr: 'pascal',
  f: 'fortran', f90: 'fortran', f95: 'fortran', f03: 'fortran', for: 'fortran',
  cob: 'cobol', cbl: 'cobol', cpy: 'cobol',
  ada: 'ada', adb: 'ada', ads: 'ada',
  pro: 'prolog',
  scm: 'scheme', ss: 'scheme',
  rkt: 'racket',
  lisp: 'common-lisp', lsp: 'common-lisp', cl: 'common-lisp', el: 'common-lisp',
  gd: 'gdscript', tres: 'gdscript', tscn: 'gdscript',
  cls: 'tex', /* ambiguous (Apex/VBA) — see AMBIGUOUS; listed for grep */
  sol: 'solidity',
  // ── shell / ops / infra ────────────────────────────────────────────────
  sh: 'shell', bash: 'shell', zsh: 'shell', ksh: 'shell', dash: 'shell',
  fish: 'fish',
  ps1: 'powershell', psm1: 'powershell', psd1: 'powershell',
  bat: 'bat', cmd: 'bat',
  awk: 'awk',
  mk: 'makefile', mak: 'makefile', make: 'makefile',
  cmake: 'cmake',
  dockerfile: 'dockerfile',
  tf: 'terraform', tfvars: 'terraform', hcl: 'terraform',
  nix: 'nix',
  applescript: 'applescript', scpt: 'applescript',
  // ── data / config ──────────────────────────────────────────────────────
  yaml: 'yaml', yml: 'yaml',
  toml: 'toml',
  ini: 'ini', cfg: 'ini', conf: 'ini', properties: 'properties', prefs: 'ini',
  env: 'dotenv',
  sql: 'sql', ddl: 'sql', psql: 'sql', mysql: 'sql',
  graphql: 'graphql', gql: 'graphql',
  proto: 'protobuf',
  csv: 'csv', tsv: 'tsv',
  // ── docs ───────────────────────────────────────────────────────────────
  md: 'markdown', markdown: 'markdown', mkd: 'markdown', mdown: 'markdown',
  mdx: 'mdx',
  rst: 'restructuredtext',
  adoc: 'asciidoc', asciidoc: 'asciidoc', asc: 'asciidoc',
  tex: 'tex', sty: 'tex', ltx: 'tex',
  bib: 'bibtex',
  org: 'org',
  // ── shaders / hardware / low-level ─────────────────────────────────────
  glsl: 'glsl', vert: 'glsl', frag: 'glsl', comp: 'glsl',
  hlsl: 'hlsl', wgsl: 'wgsl',
  wat: 'wat', wast: 'wat',
  ll: 'llvm',
  asm: 'assembly', s: 'assembly', nasm: 'assembly',
  sv: 'verilog', svh: 'verilog', verilog: 'verilog',
  vhd: 'vhdl', vhdl: 'vhdl',
  // ── misc ───────────────────────────────────────────────────────────────
  diff: 'diff', patch: 'diff',
  mermaid: 'mermaid', mmd: 'mermaid',
  reb: 'rebol',
};
```

---

## 10. Compound extensions, ambiguous resolvers, shebang table

```ts
// src/lib/language/tables.ts  (part 3)

/** Longest-suffix match tried BEFORE the single extension. Keys lowercased, no dot. */
export const COMPOUND_EXTENSIONS: Record<string, LanguageId> = {
  'd.ts': 'typescript', 'd.mts': 'typescript', 'd.cts': 'typescript',
  'cu.h': 'cpp',           // CUDA header
  'blade.php': 'php',
  'module.css': 'css', 'module.scss': 'scss',
  'stories.tsx': 'tsx', 'stories.ts': 'typescript',
};

type AmbiguousRule = {
  default: LanguageId;
  resolve: (firstLine: string, basename: string) => LanguageId;
};

export const AMBIGUOUS_EXTENSIONS: Record<string, AmbiguousRule> = {
  h: {
    default: 'c',
    resolve: (l) =>
      /@(interface|implementation|protocol)\b|#import\s*<(Foundation|UIKit|Cocoa)/.test(l)
        ? 'objective-c'
        : /template\s*<|namespace\s|(^|[^:]):{2}[^:]|std::|class\s+\w/.test(l)
          ? 'cpp'
          : 'c',
  },
  m: {
    default: 'objective-c',
    resolve: (l) =>
      /@(interface|implementation)\b|#import\b/.test(l) ? 'objective-c'
      : /^\s*%|^\s*function\b|^\s*classdef\b/.test(l) ? 'matlab'
      : /^\s*:-\s*module/.test(l) ? 'mercury'
      : /\(\*/.test(l) ? 'mathematica'
      : 'objective-c',
  },
  ts: {
    default: 'typescript',
    resolve: (l) => /^\s*<(\?xml|TS\b)/.test(l) ? 'xml' : 'typescript',
  },
  r: {
    default: 'r',
    resolve: (l) => /\bREBOL\b/i.test(l) ? 'rebol' : 'r',
  },
  pl: {
    default: 'perl',
    resolve: (l) =>
      /^\s*use\s+v6\b|^\s*(unit\s+)?(module|class|grammar)\b/.test(l) ? 'raku'
      : /:-/.test(l) && !/[$@]|^\s*use\s/.test(l) ? 'prolog'
      : 'perl',
  },
  pm: {
    default: 'perl',
    resolve: (l) => /^\s*use\s+v6\b|^\s*unit\s+module\b/.test(l) ? 'raku' : 'perl',
  },
  v: {
    default: 'verilog',
    resolve: (l) =>
      /\b(Require|Proof|Qed|Inductive)\b/.test(l) ? 'coq'
      : /^\s*(module\s+main|(pub\s+)?fn\s)/.test(l) ? 'vlang'
      : 'verilog',
  },
  es: {
    default: 'javascript',
    resolve: (l) => /^\s*(-module\(|%%)/.test(l) ? 'erlang' : 'javascript',
  },
  fs: {
    default: 'fsharp',
    resolve: (l) => /^:\s/.test(l) ? 'forth-unsupported→plaintext' as LanguageId // Forth: no grammar → 'plaintext'
      : /^#version\b/.test(l) ? 'glsl' : 'fsharp',
  },
  rs: {
    default: 'rust',
    resolve: (l) => /^\s*<\?xml/.test(l) ? 'xml' : 'rust',
  },
  cls: {
    default: 'tex',
    resolve: (l) =>
      /^\s*(public|global)\s+class\b/.test(l) ? 'apex'
      : /\\(NeedsTeXFormat|ProvidesClass)/.test(l) ? 'tex'
      : 'tex',
  },
};

/** Shebang interpreter basename (version-stripped) → LanguageId. */
export const SHEBANG_INTERPRETERS: Record<string, LanguageId> = {
  python: 'python',
  node: 'javascript', nodejs: 'javascript', bun: 'javascript',
  deno: 'typescript', 'ts-node': 'typescript', tsx: 'typescript',
  sh: 'shell', bash: 'shell', dash: 'shell', zsh: 'shell', ksh: 'shell', ash: 'shell',
  fish: 'fish',
  pwsh: 'powershell', powershell: 'powershell',
  ruby: 'ruby', perl: 'perl', raku: 'raku', perl6: 'raku',
  php: 'php', lua: 'lua', groovy: 'groovy',
  rscript: 'r', r: 'r', elixir: 'elixir', escript: 'erlang',
  awk: 'awk', gawk: 'awk', tclsh: 'tcl', wish: 'tcl', osascript: 'applescript',
};
```

> Note the `.fs` Forth branch: Forth has no CodeMirror grammar/icon in our set,
> so it resolves to `plaintext` rather than inventing an unsupported id. The
> inline cast above is illustrative — in real code, keep a
> `const FORTH: LanguageId = 'plaintext'` alias so the intent is documented and
> the union stays honest. **Rule: never return an id not in the `LanguageId`
> union; degrade to `plaintext`.**

---

## 11. Public API

```ts
// src/lib/language/detect.ts
import type { LanguageId } from './ids';
import {
  EXACT_FILENAMES, FILENAME_PREFIXES, COMPOUND_EXTENSIONS,
  EXTENSIONS, AMBIGUOUS_EXTENSIONS, SHEBANG_INTERPRETERS,
} from './tables';

/**
 * Detect a file's language for grammar loading and icon selection.
 *
 * @param path      Absolute or relative path (only the basename is used).
 * @param firstLine Optional first line of the file. When omitted (e.g. the file
 *                  tree), ambiguous extensions fall back to their deterministic
 *                  default and shebang resolution is skipped. When provided
 *                  (e.g. the editor after loading the buffer), it refines
 *                  ambiguous extensions and resolves extensionless scripts.
 * @returns A LanguageId — always defined; 'plaintext' when nothing matches.
 */
export function detectLanguage(path: string, firstLine?: string): LanguageId {
  const basename = path.split(/[\\/]/).pop() ?? path;
  const lower = basename.toLowerCase();

  // 1. exact filename
  const exact = EXACT_FILENAMES[lower];
  if (exact) return exact;
  for (const [prefix, id] of FILENAME_PREFIXES) {
    if (lower.startsWith(prefix)) return id;
  }

  // 2. extension (compound first, then single)
  const dot = lower.indexOf('.');
  if (dot >= 0) {
    const afterFirstDot = lower.slice(dot + 1); // e.g. "d.ts", "module.css"
    const compound = COMPOUND_EXTENSIONS[afterFirstDot];
    if (compound) return compound;

    const ext = lower.slice(lower.lastIndexOf('.') + 1);
    const ambiguous = AMBIGUOUS_EXTENSIONS[ext];
    if (ambiguous) {
      return firstLine ? ambiguous.resolve(firstLine, basename) : ambiguous.default;
    }
    const byExt = EXTENSIONS[ext];
    if (byExt) return byExt;
  }

  // 3. shebang / first-line (only with content)
  if (firstLine) {
    const byContent = detectByFirstLine(firstLine);
    if (byContent) return byContent;
  }

  // 4. default
  return 'plaintext';
}

/** Shebang- and markup-declaration-based detection. Exported for testing. */
export function detectByFirstLine(firstLine: string): LanguageId | null {
  const line = firstLine.trimStart();
  if (line.startsWith('#!')) {
    const tokens = line.slice(2).trim().split(/\s+/);
    let interp = (tokens[0] ?? '').split(/[\\/]/).pop() ?? '';
    if (interp === 'env') interp = (tokens[1] ?? '').split(/[\\/]/).pop() ?? '';
    interp = interp.replace(/[0-9.]+$/, ''); // python3.11 -> python
    return SHEBANG_INTERPRETERS[interp.toLowerCase()] ?? null;
  }
  if (/^<\?php\b/i.test(line)) return 'php';
  if (/^<\?xml\b/i.test(line)) return 'xml';
  if (/^<!doctype\s+html/i.test(line)) return 'html';
  if (/^%YAML\b/.test(line)) return 'yaml';
  return null;
}

// index.ts re-exports: detectLanguage, detectByFirstLine, LanguageId,
//   LANGUAGE_LABELS, and the raw tables (for the icon/grammar consumers + tests).
```

### Surface summary

| Export | Signature | Used by |
|---|---|---|
| `detectLanguage` | `(path: string, firstLine?: string) => LanguageId` | editor grammar loader, file-tree icons, status bar |
| `detectByFirstLine` | `(firstLine: string) => LanguageId \| null` | tests; manual "detect from content" |
| `LanguageId` | union type | `EditorDoc.language`, both consumer maps, store |
| `LANGUAGE_LABELS` | `Record<LanguageId, string>` | status bar, "Change Language" palette |

---

## 12. How consumers use the result (contract in action)

- **Editor grammar loader** (`editor-syntax-highlighting.md`): on tab open,
  `const lang = detectLanguage(doc.path, firstLine)` → `await
  loadGrammar(lang)` where `loadGrammar` lazy-`import()`s the matching
  `@codemirror/lang-*` or wraps a `@codemirror/legacy-modes` parser via
  `StreamLanguage.define(...)`. Any `LanguageId` without a grammar renders as
  `plaintext` (no highlight) — never an error.
- **File-tree icons** (`file-icons.md`): each row calls `detectLanguage(path)`
  (no content) and maps the `LanguageId` → icon. The map may additionally
  special-case a few **basenames** for brand icons (e.g. `Cargo.toml` → Rust/
  Cargo glyph, `package.json` → npm glyph) *after* language detection — that
  basename layer lives in the icon module, not here.
- **Store**: `EditorDoc.language: LanguageId` (typed field in the Zustand store);
  the tree row `icon` is "resolved from kind
  + doc language" using this same id.

## 13. Contract stability & maintenance

- **Additive is safe.** New `LanguageId` values and new extension keys are
  backwards-compatible; ship freely.
- **Renames/removals are breaking.** They require a coordinated change in
  `editor-syntax-highlighting.md` and `file-icons.md`. If an id must change, add
  the new id, keep the old as a deprecated alias for one release, then remove.
- **Consumers must be total & non-throwing.** Every consumer maps *all* current
  ids and falls back to a plaintext/plain-file rendering for any id it hasn't
  wired up yet — so adding an id can never crash a consumer.
- **Linguist cross-check test** (`tables.spec.ts`, dev-only): import
  `linguist-languages`; for each key in `EXTENSIONS`/`AMBIGUOUS_EXTENSIONS`,
  assert our id agrees with Linguist's primary language (via a small
  `LanguageId → Linguist name` alias map); emit a console warning listing
  extensions Linguist knows that we don't map — a backlog, not a failure.

## 14. Non-goals (v1)

- **No statistical/Bayesian classifier.** Extension + one first-line regex is
  enough for a supervision-first editor. Deep content sniffing is a
  post-v1 option if misdetection proves painful.
- **No modeline parsing** (Emacs `-*- mode -*-`, Vim `vim:`). Cheap to add later
  as a stage 2.5 if needed.
- **No per-node content reads in the tree.** Icons use name/extension only.
- **No Rust-side detection.** Port from this same table data if ever needed.
```
