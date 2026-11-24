// src/lib/language/tables.ts
//
// Detection tables (exact filenames, filename prefixes, extensions, compound
// extensions, ambiguous-extension resolvers, and shebang interpreters).
//
// Data values are derived from GitHub Linguist (`languages.yml` /
// `heuristics.yml`) and the `linguist-languages` npm package, both MIT-licensed.
// The `LanguageId` id *strings* are original to this project. See
// docs/design/language-detection.md §§8–10 for the source of truth.

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
      // `main\b`: without the boundary, Verilog's `module mainbus;` — a perfectly
      // ordinary Verilog module whose name merely starts with "main" — was read as
      // V. (Found by mutation testing.)
      : /^\s*(module\s+main\b|(pub\s+)?fn\s)/.test(l) ? 'vlang'
      : 'verilog',
  },
  es: {
    default: 'javascript',
    resolve: (l) => /^\s*(-module\(|%%)/.test(l) ? 'erlang' : 'javascript',
  },
  fs: {
    default: 'fsharp',
    // Forth has no CodeMirror grammar/icon in our set, so it degrades to
    // 'plaintext' rather than inventing an unsupported id (§10 Rule: never
    // return an id outside the LanguageId union).
    resolve: (l) => /^:\s/.test(l) ? 'plaintext'
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

export type { AmbiguousRule };
