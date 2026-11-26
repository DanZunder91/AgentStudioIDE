/** In the coverage gate: every `? :` arm in tables.ts and every `if` in detect.ts must be hit. */

import { describe, expect, it } from 'vitest';

import {
  detectLanguage,
  detectByFirstLine,
  LANGUAGE_LABELS,
  AMBIGUOUS_EXTENSIONS,
  EXTENSIONS,
} from './index';
// Wave 3 drives EVERY table row through the pipeline, so it needs the tables the
// barrel does not re-export.
import {
  COMPOUND_EXTENSIONS,
  EXACT_FILENAMES,
  FILENAME_PREFIXES,
  SHEBANG_INTERPRETERS,
} from './tables';
import type { LanguageId } from './index';

describe('detectLanguage — exact filenames (stage 1a)', () => {
  it('resolves well-known exact basenames', () => {
    expect(detectLanguage('Dockerfile')).toBe('dockerfile');
    expect(detectLanguage('Makefile')).toBe('makefile');
    expect(detectLanguage('CMakeLists.txt')).toBe('cmake');
    expect(detectLanguage('go.mod')).toBe('go-module');
    expect(detectLanguage('go.sum')).toBe('go-checksums');
    expect(detectLanguage('Cargo.toml')).toBe('toml');
    expect(detectLanguage('package.json')).toBe('json');
    expect(detectLanguage('tsconfig.json')).toBe('jsonc');
    expect(detectLanguage('.gitignore')).toBe('gitignore');
    expect(detectLanguage('.gitattributes')).toBe('git-attributes');
    expect(detectLanguage('.env')).toBe('dotenv');
    expect(detectLanguage('Rakefile')).toBe('ruby');
    expect(detectLanguage('nginx.conf')).toBe('nginx');
  });

  it('matches basenames case-insensitively', () => {
    expect(detectLanguage('DOCKERFILE')).toBe('dockerfile');
    expect(detectLanguage('MAKEFILE')).toBe('makefile');
  });

  it('uses only the last path segment', () => {
    expect(detectLanguage('/abs/path/to/Dockerfile')).toBe('dockerfile');
    expect(detectLanguage('C:\\win\\path\\Makefile')).toBe('makefile');
    expect(detectLanguage('src/app/main.py')).toBe('python');
  });
});

describe('detectLanguage — filename prefixes (stage 1b)', () => {
  it('matches prefix rules in order', () => {
    expect(detectLanguage('Dockerfile.prod')).toBe('dockerfile');
    expect(detectLanguage('Dockerfile.dev')).toBe('dockerfile');
    expect(detectLanguage('.env.local')).toBe('dotenv');
    expect(detectLanguage('.env.production')).toBe('dotenv');
    expect(detectLanguage('tsconfig.build.json')).toBe('jsonc');
    expect(detectLanguage('docker-compose.yml')).toBe('yaml');
    expect(detectLanguage('docker-compose.override.yml')).toBe('yaml');
  });
});

describe('detectLanguage — compound extensions (stage 2a)', () => {
  it('matches the longest multi-dot suffix before the single extension', () => {
    expect(detectLanguage('foo.d.ts')).toBe('typescript');
    expect(detectLanguage('foo.d.mts')).toBe('typescript');
    expect(detectLanguage('foo.d.cts')).toBe('typescript');
    expect(detectLanguage('kernel.cu.h')).toBe('cpp');
    expect(detectLanguage('home.blade.php')).toBe('php');
    expect(detectLanguage('x.module.css')).toBe('css');
    expect(detectLanguage('x.module.scss')).toBe('scss');
    expect(detectLanguage('y.stories.tsx')).toBe('tsx');
    expect(detectLanguage('y.stories.ts')).toBe('typescript');
  });
});

describe('detectLanguage — unambiguous extensions (stage 2b)', () => {
  it('covers the DoD required cases', () => {
    expect(detectLanguage('main.rs')).toBe('rust'); // via ambiguous default (no firstLine)
    expect(detectLanguage('Main.kt')).toBe('kotlin');
    expect(detectLanguage('query.sql')).toBe('sql');
    expect(detectLanguage('vec.cpp')).toBe('cpp');
    expect(detectLanguage('App.java')).toBe('java');
    expect(detectLanguage('data.json')).toBe('json');
    expect(detectLanguage('README.md')).toBe('markdown');
    expect(detectLanguage('index.html')).toBe('html');
    expect(detectLanguage('styles.css')).toBe('css');
    expect(detectLanguage('app.js')).toBe('javascript');
    expect(detectLanguage('app.ts')).toBe('typescript'); // ambiguous default
    expect(detectLanguage('main.py')).toBe('python');
  });

  it('covers a broad spread across the EXTENSIONS table', () => {
    expect(detectLanguage('server.go')).toBe('go');
    expect(detectLanguage('model.rb')).toBe('ruby');
    expect(detectLanguage('index.php')).toBe('php');
    expect(detectLanguage('init.lua')).toBe('lua');
    expect(detectLanguage('View.swift')).toBe('swift');
    expect(detectLanguage('config.yaml')).toBe('yaml');
    expect(detectLanguage('config.yml')).toBe('yaml');
    expect(detectLanguage('Cargo.toml.example.toml')).toBe('toml');
    expect(detectLanguage('run.sh')).toBe('shell');
    expect(detectLanguage('build.zig')).toBe('zig');
    expect(detectLanguage('App.tsx')).toBe('tsx');
    expect(detectLanguage('mod.jsx')).toBe('jsx');
    expect(detectLanguage('shader.frag')).toBe('glsl');
    expect(detectLanguage('cpu.v.example.sv')).toBe('verilog');
    expect(detectLanguage('note.diff')).toBe('diff');
  });
});

/** Every ambiguous extension: its default with no firstLine, and each resolver arm. */
describe('detectLanguage — ambiguous extensions: defaults (no firstLine)', () => {
  const defaults: Array<[string, LanguageId]> = [
    ['a.h', 'c'],
    ['a.m', 'objective-c'],
    ['a.ts', 'typescript'],
    ['a.r', 'r'],
    ['a.pl', 'perl'],
    ['a.pm', 'perl'],
    ['a.v', 'verilog'],
    ['a.es', 'javascript'],
    ['a.fs', 'fsharp'],
    ['a.rs', 'rust'],
    ['a.cls', 'tex'],
  ];
  it.each(defaults)('%s -> %s', (name, id) => {
    expect(detectLanguage(name)).toBe(id);
  });

  it('every AMBIGUOUS_EXTENSIONS default is a real LanguageId with a label', () => {
    for (const rule of Object.values(AMBIGUOUS_EXTENSIONS)) {
      expect(LANGUAGE_LABELS[rule.default]).toBeTypeOf('string');
    }
  });
});

describe('detectLanguage — .h resolver arms', () => {
  it('objective-c on @interface / #import <Foundation/…>', () => {
    expect(detectLanguage('a.h', '@interface Foo : NSObject')).toBe('objective-c');
    expect(detectLanguage('a.h', '#import <Foundation/Foundation.h>')).toBe('objective-c');
  });
  it('cpp on C++ markers', () => {
    expect(detectLanguage('a.h', 'template <class T> struct S {};')).toBe('cpp');
    expect(detectLanguage('a.h', 'namespace foo {')).toBe('cpp');
    expect(detectLanguage('a.h', 'class Widget {')).toBe('cpp');
  });
  it('c when neither Objective-C nor C++ markers match', () => {
    expect(detectLanguage('a.h', 'int add(int a, int b);')).toBe('c');
  });
});

describe('detectLanguage — .m resolver arms', () => {
  it('objective-c on @interface / #import', () => {
    expect(detectLanguage('a.m', '@implementation Foo')).toBe('objective-c');
    expect(detectLanguage('a.m', '#import "Foo.h"')).toBe('objective-c');
  });
  it('matlab on % comment / function / classdef', () => {
    expect(detectLanguage('a.m', '% MATLAB comment')).toBe('matlab');
    expect(detectLanguage('a.m', 'function y = f(x)')).toBe('matlab');
    expect(detectLanguage('a.m', 'classdef MyClass')).toBe('matlab');
  });
  it('mercury on :- module', () => {
    expect(detectLanguage('a.m', ':- module foo.')).toBe('mercury');
  });
  it('mathematica on (* … *)', () => {
    expect(detectLanguage('a.m', '(* Wolfram comment *)')).toBe('mathematica');
  });
  it('objective-c fallback when nothing matches', () => {
    expect(detectLanguage('a.m', 'x = 5;')).toBe('objective-c');
  });
});

describe('detectLanguage — .ts resolver arms', () => {
  it('xml on <?xml or <TS', () => {
    expect(detectLanguage('a.ts', '<?xml version="1.0"?>')).toBe('xml');
    expect(detectLanguage('a.ts', '<TS version="2.1">')).toBe('xml');
  });
  it('typescript otherwise', () => {
    expect(detectLanguage('a.ts', 'const x: number = 1;')).toBe('typescript');
  });
});

describe('detectLanguage — .r resolver arms', () => {
  it('rebol on REBOL header', () => {
    expect(detectLanguage('a.r', 'REBOL [Title: "x"]')).toBe('rebol');
  });
  it('r otherwise', () => {
    expect(detectLanguage('a.r', 'x <- c(1, 2, 3)')).toBe('r');
  });
});

describe('detectLanguage — .pl resolver arms', () => {
  it('raku on use v6 / unit module', () => {
    expect(detectLanguage('a.pl', 'use v6;')).toBe('raku');
    expect(detectLanguage('a.pl', 'unit module Foo;')).toBe('raku');
  });
  it('prolog on a :- clause with no Perl markers', () => {
    expect(detectLanguage('a.pl', 'parent(tom, bob) :- true.')).toBe('prolog');
  });
  it('perl when a :- coexists with a $/@ Perl marker', () => {
    expect(detectLanguage('a.pl', 'print "$x :- y";')).toBe('perl');
  });
  it('perl when there is no :- clause at all', () => {
    expect(detectLanguage('a.pl', 'print "hello world";')).toBe('perl');
  });
});

describe('detectLanguage — .pm resolver arms', () => {
  it('raku on use v6 / unit module', () => {
    expect(detectLanguage('a.pm', 'use v6;')).toBe('raku');
    expect(detectLanguage('a.pm', 'unit module Foo;')).toBe('raku');
  });
  it('perl otherwise', () => {
    expect(detectLanguage('a.pm', 'package Foo;')).toBe('perl');
  });
});

describe('detectLanguage — .v resolver arms', () => {
  it('coq on Require/Proof/Qed/Inductive', () => {
    expect(detectLanguage('a.v', 'Require Import Coq.Lists.List.')).toBe('coq');
  });
  it('vlang on module main / fn', () => {
    expect(detectLanguage('a.v', 'fn main() {')).toBe('vlang');
    expect(detectLanguage('a.v', 'module main')).toBe('vlang');
  });
  it('verilog otherwise', () => {
    expect(detectLanguage('a.v', 'module counter(input clk);')).toBe('verilog');
  });
});

describe('detectLanguage — .es resolver arms', () => {
  it('erlang on -module( or %%', () => {
    expect(detectLanguage('a.es', '-module(foo).')).toBe('erlang');
    expect(detectLanguage('a.es', '%% erlang comment')).toBe('erlang');
  });
  it('javascript otherwise', () => {
    expect(detectLanguage('a.es', 'export const x = 1;')).toBe('javascript');
  });
});

describe('detectLanguage — .fs resolver arms', () => {
  it('plaintext for the Forth branch (never an unsupported id)', () => {
    expect(detectLanguage('a.fs', ': square dup * ;')).toBe('plaintext');
  });
  it('glsl on #version', () => {
    expect(detectLanguage('a.fs', '#version 330 core')).toBe('glsl');
  });
  it('fsharp otherwise', () => {
    expect(detectLanguage('a.fs', 'let x = 5')).toBe('fsharp');
  });
});

describe('detectLanguage — .rs resolver arms', () => {
  it('xml when the file starts with <?xml (RenderScript-style)', () => {
    expect(detectLanguage('a.rs', '<?xml version="1.0"?>')).toBe('xml');
  });
  it('rust otherwise', () => {
    expect(detectLanguage('a.rs', 'fn main() {}')).toBe('rust');
  });
});

describe('detectLanguage — .cls resolver arms', () => {
  it('apex on a public/global class', () => {
    expect(detectLanguage('a.cls', 'public class MyController {')).toBe('apex');
    expect(detectLanguage('a.cls', 'global class Batch {')).toBe('apex');
  });
  it('tex on \\NeedsTeXFormat / \\ProvidesClass', () => {
    expect(detectLanguage('a.cls', '\\NeedsTeXFormat{LaTeX2e}')).toBe('tex');
    expect(detectLanguage('a.cls', '\\ProvidesClass{article}')).toBe('tex');
  });
  it('tex fallback otherwise', () => {
    expect(detectLanguage('a.cls', '% just a comment')).toBe('tex');
  });
});

describe('detectByFirstLine — shebang stage', () => {
  it('env-aware with version stripping', () => {
    expect(detectByFirstLine('#!/usr/bin/env python3')).toBe('python');
    expect(detectByFirstLine('#!/usr/bin/env python3.11')).toBe('python');
  });
  it('direct interpreters', () => {
    expect(detectByFirstLine('#!/bin/bash')).toBe('shell');
    expect(detectByFirstLine('#!/usr/bin/node')).toBe('javascript');
    expect(detectByFirstLine('#!/usr/bin/env deno')).toBe('typescript');
    expect(detectByFirstLine('#!/usr/bin/perl')).toBe('perl');
    expect(detectByFirstLine('#!/usr/bin/env ruby')).toBe('ruby');
    expect(detectByFirstLine('  #!/bin/sh')).toBe('shell'); // leading whitespace trimmed
  });
  it('unknown interpreter falls through to null', () => {
    expect(detectByFirstLine('#!/usr/bin/env weirdlang')).toBeNull();
  });
  it('env with no command yields null (no interpreter token)', () => {
    expect(detectByFirstLine('#!/usr/bin/env')).toBeNull();
  });
  it('a bare #! yields null', () => {
    expect(detectByFirstLine('#!')).toBeNull();
  });
});

describe('detectByFirstLine — markup declarations', () => {
  it('recognizes the non-shebang first-line markers', () => {
    expect(detectByFirstLine('<?php echo 1;')).toBe('php');
    expect(detectByFirstLine('<?xml version="1.0"?>')).toBe('xml');
    expect(detectByFirstLine('<!DOCTYPE html>')).toBe('html');
    expect(detectByFirstLine('%YAML 1.2')).toBe('yaml');
  });
  it('returns null when no marker matches', () => {
    expect(detectByFirstLine('just some plain text')).toBeNull();
    expect(detectByFirstLine('')).toBeNull();
  });
});

describe('detectLanguage — shebang / first-line stage (extensionless files)', () => {
  it('resolves extensionless scripts via shebang', () => {
    expect(detectLanguage('build', '#!/usr/bin/env python3')).toBe('python');
    expect(detectLanguage('run', '#!/bin/bash')).toBe('shell');
    expect(detectLanguage('cli', '#!/usr/bin/node')).toBe('javascript');
  });
  it('resolves extensionless markup files via first line', () => {
    expect(detectLanguage('page', '<?php echo 1;')).toBe('php');
    expect(detectLanguage('feed', '<?xml version="1.0"?>')).toBe('xml');
  });
  it('falls through to plaintext when content matches nothing', () => {
    expect(detectLanguage('build', '#!/usr/bin/env weirdlang')).toBe('plaintext');
    expect(detectLanguage('notes', 'nothing special here')).toBe('plaintext');
  });
  it('extensionless file with no firstLine is plaintext', () => {
    expect(detectLanguage('randomfile')).toBe('plaintext');
  });
});

describe('detectLanguage — default fallthrough (stage 4)', () => {
  it('unknown extension is plaintext', () => {
    expect(detectLanguage('foo.zzz')).toBe('plaintext');
    expect(detectLanguage('archive.qwerty')).toBe('plaintext');
  });
  it('empty / dotless name is plaintext', () => {
    expect(detectLanguage('')).toBe('plaintext');
    expect(detectLanguage('LICENSE')).toBe('plaintext');
  });
  it('an unknown extension with an unrelated first line is still plaintext', () => {
    expect(detectLanguage('foo.zzz', 'const x = 1;')).toBe('plaintext');
  });
});

describe('table integrity', () => {
  it('every EXTENSIONS value is a labelled LanguageId', () => {
    for (const id of Object.values(EXTENSIONS)) {
      expect(LANGUAGE_LABELS[id]).toBeTypeOf('string');
    }
  });
});

/** ── Mutation-hardening ── The near-misses each regex exists to REJECT: only these catch a
 * loosened anchor, a dropped `\b` or a widened quantifier (no `^` in the `.m` resolver makes
 * `y % z` MATLAB). Each assertion kills at least one mutant. */
describe('resolver near-misses — the inputs each regex exists to REJECT', () => {
  it('.m: a modulo operator is not a MATLAB comment (the ^ anchor)', () => {
    expect(detectLanguage('a.m', 'int x = y % z;')).toBe('objective-c');
    // …but a genuinely leading %, after indentation, still is (the \s* is real).
    expect(detectLanguage('a.m', '   % leading comment')).toBe('matlab');
  });

  it('.m: `functionality` is not `function` (the \\b)', () => {
    expect(detectLanguage('a.m', 'functionality = 1;')).toBe('objective-c');
  });

  it('.m: `(a * b)` is not Mathematica\'s `(*` (adjacency)', () => {
    // `\(\*` requires the star to touch the paren; a spaced multiplication must
    // not trip it. (`foo(*bar)` DOES read as Mathematica — an inherent limit of
    // the heuristic, shared with GitHub Linguist.)
    expect(detectLanguage('a.m', 'y = (a * b);')).toBe('objective-c');
  });

  it('.h: `@interfaceFoo` is not `@interface` (the \\b)', () => {
    expect(detectLanguage('a.h', '@interfaceFoo')).toBe('c');
  });

  it('.h: only the three Apple umbrella frameworks imply Objective-C', () => {
    // The alternation is the point: importing your own header is plain C.
    expect(detectLanguage('a.h', '#import <MyLib/MyLib.h>')).toBe('c');
    // …and the optional space really is optional (`\s*`, not `\s+`).
    expect(detectLanguage('a.h', '#import<Foundation/Foundation.h>')).toBe('objective-c');
  });

  it('.h: C++ markers need their separators (`class\\s+\\w`, `namespace\\s`)', () => {
    expect(detectLanguage('a.h', 'int classroom;')).toBe('c');
    expect(detectLanguage('a.h', 'int namespaced;')).toBe('c');
    // A single colon is not the `::` scope operator.
    expect(detectLanguage('a.h', 'int a = b ? c : d;')).toBe('c');
    // `template<` with no space still counts (`\s*`).
    expect(detectLanguage('a.h', 'template<class T> struct S {};')).toBe('cpp');
  });

  it('.v: `Required` is not Coq\'s `Require` (the \\b)', () => {
    expect(detectLanguage('a.v', '// Required signals')).toBe('verilog');
  });

  it('.v: an `fn` mid-line is not a V function (the ^ anchor)', () => {
    expect(detectLanguage('a.v', '// call fn here')).toBe('verilog');
  });

  it('.v: `module mainbus;` is Verilog, not V (regression)', () => {
    // Fixed: `module\s+main` had no trailing \b, so any Verilog
    // module whose name merely STARTS with "main" was misread as V.
    expect(detectLanguage('a.v', 'module mainbus;')).toBe('verilog');
    // The real V declaration still resolves.
    expect(detectLanguage('a.v', 'module main')).toBe('vlang');
  });

  it('.es: a trailing `%%` is not an Erlang comment header (the ^ anchor)', () => {
    expect(detectLanguage('a.es', 'x = 1; %% trailing')).toBe('javascript');
  });

  it('.fs: `:foo` is not a Forth definition; `#versionable` is not `#version`', () => {
    // `^:\s` — the colon must be followed by whitespace.
    expect(detectLanguage('a.fs', ':foo')).toBe('fsharp');
    // `^#version\b` — the \b keeps a longer word out.
    expect(detectLanguage('a.fs', '#versionable')).toBe('fsharp');
  });

  it('.ts: `<TSX>` is not Qt\'s `<TS>`; a quoted `<?xml` is not a declaration', () => {
    expect(detectLanguage('a.ts', '<TSX>')).toBe('typescript');
    expect(detectLanguage('a.ts', 'const x = "<?xml";')).toBe('typescript');
  });

  it('.r: `REBOLUTION` is not `REBOL` (the \\b), but case does not matter (the /i)', () => {
    expect(detectLanguage('a.r', 'REBOLUTION <- 1')).toBe('r');
    expect(detectLanguage('a.r', 'rebol []')).toBe('rebol');
  });

  it('.rs: a commented `<?xml` is not an XML declaration (the ^ anchor)', () => {
    expect(detectLanguage('a.rs', '// <?xml')).toBe('rust');
  });

  it('.cls: Apex needs `public class` with a real separator', () => {
    expect(detectLanguage('a.cls', 'publicclass Foo')).toBe('tex');
    expect(detectLanguage('a.cls', 'public classes = 1')).toBe('tex');
    expect(detectLanguage('a.cls', 'public class Foo {')).toBe('apex');
  });

  it('.pl: `reuse` mid-line is not a leading `use` (the ^ anchor)', () => {
    // The prolog arm is `:-` AND NOT (a Perl sigil OR a leading `use`). If the
    // `^` on that second alternative is lost, "reuse" vetoes prolog.
    expect(detectLanguage('a.pl', 'foo(X) :- reuse(X).')).toBe('prolog');
  });

  it('.pm: `use v60` is not `use v6` (the \\b)', () => {
    expect(detectLanguage('a.pm', 'use v60;')).toBe('perl');
    expect(detectLanguage('a.pm', 'use v6.d;')).toBe('raku');
  });
});

/** Self-referential on purpose: proves each row is reachable with the right precedence and key
 * normalization, but cannot catch a wrong VALUE; the golden snapshot below pins values. */
describe('table routing — every row is reachable through detectLanguage', () => {
  it('EXACT_FILENAMES: each basename resolves to its declared id', () => {
    for (const [name, id] of Object.entries(EXACT_FILENAMES)) {
      expect(detectLanguage(name), name).toBe(id);
      // Case-insensitively too — the table is keyed lowercase but real files
      // are not (`Dockerfile`, `Makefile`, `Gemfile`).
      expect(detectLanguage(name.toUpperCase()), name.toUpperCase()).toBe(id);
    }
  });

  it('FILENAME_PREFIXES: each prefix rule resolves to its declared id', () => {
    for (const [prefix, id] of FILENAME_PREFIXES) {
      // `x` after the prefix keeps it a prefix match and not an exact-name hit.
      expect(detectLanguage(`${prefix}x`), `${prefix}x`).toBe(id);
    }
    // `docker-compose` with NO extension is the only witness that isolates that
    // rule: with a `.yml` on the end the extension table answers 'yaml' anyway,
    // which is why deleting the rule survived mutation testing.
    expect(detectLanguage('docker-compose')).toBe('yaml');
  });

  it('EXTENSIONS: each extension resolves to its declared id', () => {
    for (const [ext, id] of Object.entries(EXTENSIONS)) {
      expect(detectLanguage(`file.${ext}`), `file.${ext}`).toBe(id);
    }
  });

  it('COMPOUND_EXTENSIONS: each multi-dot suffix resolves to its declared id', () => {
    for (const [suffix, id] of Object.entries(COMPOUND_EXTENSIONS)) {
      expect(detectLanguage(`file.${suffix}`), `file.${suffix}`).toBe(id);
    }
  });

  it('SHEBANG_INTERPRETERS: each interpreter resolves to its declared id', () => {
    for (const [interp, id] of Object.entries(SHEBANG_INTERPRETERS)) {
      expect(detectByFirstLine(`#!/usr/bin/env ${interp}`), interp).toBe(id);
      expect(detectByFirstLine(`#!/usr/bin/${interp}`), interp).toBe(id);
    }
  });

  it('`perl6` means Raku, not Perl (regression)', () => {
    // Exact match must win over version-stripping, or `perl6` becomes `perl` and the raku row is
    // unreachable.
    expect(detectByFirstLine('#!/usr/bin/env perl6')).toBe('raku');
    expect(detectByFirstLine('#!/usr/bin/perl6')).toBe('raku');
    // Version-stripping still applies to everything that is a real version.
    expect(detectByFirstLine('#!/usr/bin/env python3.11')).toBe('python');
    expect(detectByFirstLine('#!/usr/bin/env php8')).toBe('php');
    expect(detectByFirstLine('#!/usr/bin/env node22')).toBe('javascript');
    // …and plain `perl` is still Perl.
    expect(detectByFirstLine('#!/usr/bin/perl')).toBe('perl');
  });
});

/** Golden snapshot of pure table data: any row change fails and names the row. A narrow exception
 * (snapshots are not a habit here): read the diff before `npx vitest run -u <this file>`. A
 * MISSING snapshot fails `vitest run`, so a new row cannot slip in un-pinned. */
describe('table data — golden snapshot of every row value', () => {
  it('EXACT_FILENAMES', () => {
    expect(EXACT_FILENAMES).toMatchSnapshot();
  });
  it('FILENAME_PREFIXES', () => {
    expect(FILENAME_PREFIXES).toMatchSnapshot();
  });
  it('EXTENSIONS', () => {
    expect(EXTENSIONS).toMatchSnapshot();
  });
  it('COMPOUND_EXTENSIONS', () => {
    expect(COMPOUND_EXTENSIONS).toMatchSnapshot();
  });
  it('SHEBANG_INTERPRETERS', () => {
    expect(SHEBANG_INTERPRETERS).toMatchSnapshot();
  });
  it('AMBIGUOUS_EXTENSIONS defaults', () => {
    // The `resolve` functions are not serializable (and are pinned by the
    // arm-by-arm + near-miss tests above); the defaults are plain data.
    const defaults = Object.fromEntries(
      Object.entries(AMBIGUOUS_EXTENSIONS).map(([ext, rule]) => [ext, rule.default]),
    );
    expect(defaults).toMatchSnapshot();
  });
  it('LANGUAGE_LABELS', () => {
    expect(LANGUAGE_LABELS).toMatchSnapshot();
  });
});

/** `Record<LanguageId, string>` enforces completeness, not contents: `''` type-checks, and these
 * labels are user-facing. */
describe('LANGUAGE_LABELS — the user-facing display names', () => {
  it('no label is empty or untrimmed', () => {
    for (const [id, label] of Object.entries(LANGUAGE_LABELS)) {
      expect(label, id).not.toBe('');
      expect(label, id).toBe(label.trim());
    }
  });

  it('labels are unique — two languages never present the same name', () => {
    const labels = Object.values(LANGUAGE_LABELS);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('pins the labels whose casing is the whole point', () => {
    // Vendor-cased names a well-meaning edit would "correct" and break.
    expect(LANGUAGE_LABELS.javascript).toBe('JavaScript');
    expect(LANGUAGE_LABELS.typescript).toBe('TypeScript');
    expect(LANGUAGE_LABELS.cpp).toBe('C++');
    expect(LANGUAGE_LABELS.csharp).toBe('C#');
    expect(LANGUAGE_LABELS.fsharp).toBe('F#');
    expect(LANGUAGE_LABELS['objective-c']).toBe('Objective-C');
    expect(LANGUAGE_LABELS.matlab).toBe('MATLAB');
    expect(LANGUAGE_LABELS.cobol).toBe('COBOL');
    expect(LANGUAGE_LABELS.plaintext).toBe('Plain Text');
    // 'vlang' is the id; 'V' is the language's actual name.
    expect(LANGUAGE_LABELS.vlang).toBe('V');
  });
});
