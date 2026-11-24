# Vendored pixel art — Pixel Agents subset

A curated subset of the pixel-art PNGs from [Pixel Agents](https://github.com/pixel-agents-hq/pixel-agents)
(MIT — see `LICENSE` in this directory, the verbatim upstream text, Copyright (c) 2026 Pablo De Lucca).
Used by the Agent Village tab (`src/features/village/render/`). Only the **art** is vendored: the
village engine and renderer are our own implementation, not a copy of upstream code.

## Pinned upstream

| | |
|---|---|
| Version | **v1.4.1-1-gd1e007a** (one commit past the `v1.4.1` tag, which is `3537e140c2094761beae748592aeb92ece8edfdd`; that commit, #428, only bumps an e2e dependency in `package.json`/`package-lock.json` — the art is byte-identical) |
| Commit | `d1e007a9fdf3003c252d2973abe1999ae59aec33` — re-vendor from THIS commit |
| Repo | <https://github.com/pixel-agents-hq/pixel-agents> |
| Upstream path | `webview-ui/public/assets/` |

## What is here (all copied **unmodified**)

- `characters/char_0.png` … `char_5.png` — six 112×96 character sheets: 7 columns × 3 rows of
  16×32 frames (rows down / up / right; left is the right row mirrored at draw time; columns
  0-2 walk, 3-4 type, 5-6 read). Recolouring (hue shift) happens at runtime, in memory.
- `floors/floor_0.png` … `floor_8.png` — nine 16×16 grayscale floor patterns, colourised at
  runtime.
- `walls/wall_0.png` — 64×128 grayscale wall auto-tile: a 4×4 grid of 16×32 pieces indexed by a
  4-bit neighbour mask (N=1, E=2, S=4, W=8), colourised at runtime.
- `furniture/` — only the pieces the renderer draws, flattened out of upstream's per-item folders
  (`furniture/<ITEM>/<FILE>.png`; the `manifest.json` files are not vendored — sizes are pinned in
  `src/features/village/render/sprites.ts`):
  - `DESK/DESK_FRONT.png` (48×32), `SMALL_TABLE/SMALL_TABLE_FRONT.png` (32×32)
  - `TABLE_FRONT/TABLE_FRONT.png` (48×64; upstream footprint 3×4 with one background row — drawn
    as the sub-agents' 3×3 team table, its top row of art rising over the chairs above it)
  - `PC/PC_FRONT_OFF.png`, `PC/PC_FRONT_ON_1..3.png` (16×32, the "on" animation)
  - `WOODEN_CHAIR/WOODEN_CHAIR_FRONT|BACK|SIDE.png` (16×32; side faces right, mirrored for left)
  - `PLANT/PLANT.png` (16×32), `BOOKSHELF/BOOKSHELF.png` (32×16), `BIN/BIN.png` (16×16),
    `COFFEE/COFFEE.png` (16×16), `SOFA/SOFA_FRONT|BACK.png` (32×16)
- `LICENSE` — upstream's MIT license, verbatim.

## Credits

- **Characters** are derived (by the Pixel Agents author) from **"MetroCity – Free Topdown
  Character Pack" by JIK-A-4** (<https://jik-a-4.itch.io/metrocity-free-topdown-character-pack>),
  released under **CC0 1.0** — no attribution required, credited here gladly.
- Floors, walls and furniture are the "original, open-source" set Pixel Agents introduced in
  v1.1.0 (#117) to replace a proprietary tileset; they are covered by the repository's MIT
  license. (Upstream issue #355 asks for an explicit art-licence statement; re-check it on the
  next re-vendor.)

## Deliberately out of scope

- **Pets** (`pets/claudio`, `pets/gitcat`) — contributed art with no explicit licence and a
  brand association; not vendored.
- **Carpets**, the other furniture items, `default-layout-1.json`, and the FS Pixel Sans font
  (no licence file upstream).
- Anything from **Donarg's "Office Interior Tileset"** — a paid third-party pack upstream only
  recommends; it is not redistributable and is not in this repo.
- The sub-agents' **laptops** and the outdoor art — grass, path, water, plaza, tree, fountain, lamp, sign, campfire, speech bubbles
  and origin markers — are **our own procedural pixel art** in `src/features/village/render/`.

## Re-vendoring

1. Clone upstream OUTSIDE the repo (a temp dir) at the new tag, note the full commit.
2. Copy the same files over this tree (flatten `furniture/<ITEM>/X.png` → `furniture/X.png`);
   check every PNG's size against `FURNITURE_SIZE` / `CHAR_SHEET` / `WALL_SHEET` in
   `src/features/village/render/sprites.ts`. Copy `LICENSE` if it changed.
3. Update the version/commit here and in `VENDORED_ASSETS` (`scripts/attribution.mjs`), then
   `npm run attribution` to regenerate `THIRD-PARTY-NOTICES.txt` (never edit that file by hand —
   it is generated).
4. `npx vitest run --config vitest.browser.config.ts src/features/village/render/render.browser.test.tsx`
   — proves the PNGs still decode and draw in a real canvas.
