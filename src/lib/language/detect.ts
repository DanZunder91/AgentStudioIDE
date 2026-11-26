// src/lib/language/detect.ts
import type { LanguageId } from './ids';
import {
  EXACT_FILENAMES, FILENAME_PREFIXES, COMPOUND_EXTENSIONS,
  EXTENSIONS, AMBIGUOUS_EXTENSIONS, SHEBANG_INTERPRETERS,
} from './tables';

/** Last path/interpreter segment; `split` never yields an empty array, so no fallback is needed. */
function lastSegment(s: string): string {
  const parts = s.split(/[\\/]/);
  return parts[parts.length - 1];
}

/** Language from the basename for grammars and icons; 'plaintext' when nothing matches. Without
 * `firstLine` (file tree) ambiguous extensions take their default and shebangs are skipped; with
 * it (editor) it refines ambiguous extensions and resolves extensionless scripts. */
export function detectLanguage(path: string, firstLine?: string): LanguageId {
  const basename = lastSegment(path);
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
    let interp = lastSegment(tokens[0]);
    // `tokens[1]` really can be undefined (`#!/usr/bin/env` with no command), so
    // this fallback — unlike the ones above — is a live guard, not dead defense.
    if (interp === 'env') interp = lastSegment(tokens[1] ?? '');
    const lower = interp.toLowerCase();
    // EXACT name first: for some interpreters a trailing digit is part of the name (`perl6` is
    // Raku, not Perl 6.x); stripping the version first made the `perl6` row unreachable.
    const exact = SHEBANG_INTERPRETERS[lower];
    if (exact) return exact;
    // Otherwise a trailing version is noise: python3.11 -> python, php8 -> php.
    return SHEBANG_INTERPRETERS[lower.replace(/[0-9.]+$/, '')] ?? null;
  }
  if (/^<\?php\b/i.test(line)) return 'php';
  if (/^<\?xml\b/i.test(line)) return 'xml';
  if (/^<!doctype\s+html/i.test(line)) return 'html';
  if (/^%YAML\b/.test(line)) return 'yaml';
  return null;
}
