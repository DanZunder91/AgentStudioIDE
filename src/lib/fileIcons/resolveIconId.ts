// docs/design/file-icons.md §3, FILES ONLY: exact name → compound extension, longest first (it
// encodes role: .d.ts vs .ts) → detector language → last extension → default. Deferred on purpose:
// the directory branch (folders keep `FolderIcon` + folderSemantics) and light-theme variants.

import { detectLanguage } from '../language';
import { ICON_MAP, type IconMap } from './iconMap.generated';

/** Basename (not a path) → icon id; total: every input, "" included, lands on `map.defaultFile`.
 * Case-insensitive (the map's keys are pre-lowercased); `map` is injectable for tests. */
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
    // No dot left: a single extension, tier 6's job; probing it here would invert the §3 order.
    // Also keeps "foo." and ".gitignore" from an empty or bogus compound probe.
    if (!suffix.includes('.')) break;
    const compound = map.fileExtensions[suffix];
    if (compound) return compound;
  }

  // Tier 5: the detector has fused the ambiguous cases (extensionless "makefile", `.h` as cpp);
  // languageIds is partial, so unmapped ids fall through.
  const byLanguage = map.languageIds[detectLanguage(lower)];
  if (byLanguage) return byLanguage;

  // Tier 6. A dotfile (`lastDot === 0`) probes its whole trailing name, a harmless miss; the guard
  // only excludes a trailing-dot name's empty suffix.
  const lastDot = lower.lastIndexOf('.');
  if (lastDot !== -1 && lastDot !== lower.length - 1) {
    const single = map.fileExtensions[lower.slice(lastDot + 1)];
    if (single) return single;
  }

  // Tier 7 — total-function default.
  return map.defaultFile;
}
