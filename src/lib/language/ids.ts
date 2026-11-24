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
