// src/lib/fileIcons/resolveIconId.ts
//
// The §3 priority ladder of docs/design/file-icons.md — FILES BRANCH ONLY.
// Resolves a file's basename to a sprite symbol id (consumed as `#mi-<id>`).
//
// Ladder (most-specific → least-specific), tier numbers from the design doc:
//   3. exact lowercased basename        ("cargo.toml", "dockerfile", ".gitignore")
//   4. compound extension, LONGEST dotted suffix first ("test.d.ts" before "d.ts")
//   5. language id from the detector    (authoritative for ambiguous/extensionless
//      files — a shebang script, "makefile"; but compound extensions stay ABOVE
//      it because they encode file ROLE the language id can't: .d.ts vs .ts)
//   6. single (last) extension          ("kt", "zig", …)
//   7. the map's default                (total function — never a missing glyph)
//
// DEFERRED (deliberately — do not "complete" here):
// - The DIRECTORY branch (§3 tiers 1–2, `folderNames`/folder-open ids): folder
//   rows keep the existing monochrome `FolderIcon` plus the just-shipped
//   semantic role colors (folderSemantics). This slice covers FILE rows only.
// - The light-theme machinery (§5, `_light` variants / `iconMap.light`): the
//   app is dark-only today; revisit when a theme switch ships.

import { detectLanguage } from '../language';
import { ICON_MAP, type IconMap } from './iconMap.generated';

/**
 * Resolve a file's basename to its icon symbol id. Pure and total: every input
 * — including "" — lands on `map.defaultFile`. Matching is case-insensitive
 * (the generated map's keys are pre-lowercased at build time).
 *
 * @param name The file's basename, e.g. "Cargo.toml" (not a full path).
 * @param map  Injectable for tests; defaults to the generated table.
 */
export function resolveFileIconId(name: string, map: IconMap = ICON_MAP): string {
  const lower = name.toLowerCase();

  // Tier 3 — exact basename. Wins over everything: `Cargo.toml` is the Cargo
  // icon, not the generic TOML one; extensionless `Dockerfile` resolves here.
  const byName = map.fileNames[lower];
  if (byName) return byName;

  // Tier 4 — compound extensions, longest dotted suffix first. For
  // "a.test.d.ts" the probes are "test.d.ts" then "d.ts" (indexOf walks the
  // dots left→right, so suffixes only shrink). Map keys carry no leading dot.
  for (let i = lower.indexOf('.'); i !== -1; i = lower.indexOf('.', i + 1)) {
    const suffix = lower.slice(i + 1);
    // Once the suffix has no dot left it is a SINGLE extension — tier 6's job;
    // probing it here would hoist single extensions above the language tier
    // and invert the §3 ordering. This also stops a trailing-dot name ("foo.")
    // and a leading-dot basename (".gitignore" → "gitignore") from ever
    // producing an empty or bogus compound probe.
    if (!suffix.includes('.')) break;
    const compound = map.fileExtensions[suffix];
    if (compound) return compound;
  }

  // Tier 5 — the language detector (filename → extension → default). It has
  // already fused the ambiguous cases, so it is authoritative for files the
  // extension tiers can't see (extensionless "makefile", a `.h` decided as
  // cpp). The languageIds table is partial; unmapped ids fall through.
  const byLanguage = map.languageIds[detectLanguage(lower)];
  if (byLanguage) return byLanguage;

  // Tier 6 — bare last extension. `lastDot === 0` is a dotfile (".unknownrc"):
  // its "extension" is the whole trailing name — a harmless probe that misses
  // for unknown rc-files; the guard only excludes the empty suffix of a
  // trailing-dot name.
  const lastDot = lower.lastIndexOf('.');
  if (lastDot !== -1 && lastDot !== lower.length - 1) {
    const single = map.fileExtensions[lower.slice(lastDot + 1)];
    if (single) return single;
  }

  // Tier 7 — total-function default.
  return map.defaultFile;
}
