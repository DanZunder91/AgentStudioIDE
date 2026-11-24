// src/lib/language/index.ts
//
// Public surface of the language-detection module. Both consumers (the editor
// grammar loader and the workspace file-tree icons) import from here, keyed by
// LanguageId. See docs/design/language-detection.md §11.

export { detectLanguage, detectByFirstLine } from './detect';
export { LANGUAGE_LABELS } from './ids';
export type { LanguageId } from './ids';

// Raw tables re-exported for the icon/grammar consumers and tests.
export {
  EXACT_FILENAMES,
  FILENAME_PREFIXES,
  EXTENSIONS,
  COMPOUND_EXTENSIONS,
  AMBIGUOUS_EXTENSIONS,
  SHEBANG_INTERPRETERS,
} from './tables';
export type { AmbiguousRule } from './tables';
