# Vendored file-type icons — Material Icon Theme subset

A curated subset of the [Material Icon Theme](https://github.com/material-extensions/vscode-material-icon-theme)
SVG assets (MIT — see `LICENSE` in this directory, the verbatim upstream text).
Design in `docs/design/file-icons.md`.

## Pinned upstream

| | |
|---|---|
| Tag | **v5.37.0** |
| Commit | `850c06c7fb7ea73d873a0ce2f966bbd20850946d` |
| Repo | <https://github.com/material-extensions/vscode-material-icon-theme> |

## What is here

- `svg/*.svg` — 57 file-type icons, copied **unmodified** from the release's
  `icons/` directory, except:
  - `svg/file.svg` (the generic-file default) is **authored by us** in the
    Material style with `fill="currentColor"` (file-icons.md §5: structural
    glyphs inherit the tree's foreground token). Upstream v5.37.0 ships no
    `icons/file.svg` despite naming `file` its default icon.
- `LICENSE` — upstream's MIT license, verbatim.

Which icon answers which filename/extension/LanguageId is **not** encoded here —
that is the hand-curated single source `scripts/icons/mapping.mjs`, compiled by
`scripts/icons/generate.mjs` into `src/lib/fileIcons/{iconMap,sprite}.generated.ts`.
Every id used in the mapping was verified against upstream's own association
source (`src/core/icons/fileIcons.ts` at the pinned tag).

## Deliberately out of scope

- **Folder icons.** The workspace tree keeps its role-colored generic folder
  glyphs; per-folderName Material icons are a possible later addition.
- **`_light` variants.** The app is dark-only today, so the light-theme swap
  machinery (file-icons.md §5) is deferred; re-vendor the `*_light.svg` files
  when a light theme lands.

## Re-vendoring (version bump)

1. Pick the new release: `gh api repos/material-extensions/vscode-material-icon-theme/releases/latest`
2. Download + unpack it OUTSIDE the repo (a temp dir):
   `curl -sL https://api.github.com/repos/material-extensions/vscode-material-icon-theme/tarball/<TAG> | tar -xz -C <tmpdir>`
3. Copy the curated set over `svg/` (the vendored basenames are the id list in
   `SPRITE_ICON_IDS`): `for f in svg/*.svg; do cp <tmpdir>/<unpacked>/icons/$(basename $f) svg/; done`
   — but leave our authored `svg/file.svg` alone, and re-check each id still
   exists upstream. Copy the new `LICENSE` over `LICENSE` if it changed.
4. Update `UPSTREAM` (tag + commit) in `scripts/icons/mapping.mjs`, and this file.
5. `node scripts/icons/generate.mjs` — regenerates both TS artifacts; the
   generator re-runs the sanitization gate over every SVG.
6. `npx vitest run scripts/icons/generate.test.mjs` — the drift test now pins
   the new bytes.
