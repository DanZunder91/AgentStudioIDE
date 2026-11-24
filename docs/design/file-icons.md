# Agent Studio — File-Type Icon System

> How the right-rail **file tree** (`<FileTree>` / `<FileTreeNode>`) and the
> **editor tabs** (`<Tab>` / `<EditorView>`) render VS-Code-style per-language
> file icons so users instantly identify file types (`.cpp` / `.java` / `.kt` and
> friends must be visually distinct).
>
> Scope: which shippable icon set we adopt (**licensing is the deciding
> factor** — the icons must be safe to ship in a commercially licensed desktop app), plus
> the `<FileIcon>` selection algorithm, bundling strategy, and theming.
>
> Keys off the `LanguageId` + filename produced by
> [`language-detection.md`](./language-detection.md) and plugs into the UI types
> (`Tab`, `WorkspaceTreeNode`) and [`ARCHITECTURE.md`](./ARCHITECTURE.md).
> Constraints: the right-rail tree, dark/light theming, and the stack (Tauri v2 +
> React/TS, Vite-bundled local assets).

---

## 0. TL;DR

- **Adopt the [Material Icon Theme](https://github.com/material-extensions/vscode-material-icon-theme) icon assets.** MIT-licensed, full-color SVG, ~903 committed icons (633 file/language + 270 folder), covers Kotlin/Swift/Dart/Zig/Java/C++ and folder **open/closed** states, and is by far the most actively maintained option. **Safe to ship commercially.**
- **Do NOT vendor `vscode-icons`.** Its *code* is MIT but its **icon assets are CC BY-SA (ShareAlike)** — a copyleft asset license we should avoid baking into product chrome. Precise sources below.
- We **vendor a curated subset of the SVGs** (not the VS Code extension) and build **our own** `name → icon` mapping keyed off our `LanguageId` + filename, shipped as a single **inline SVG sprite** (eager, ~tens of KB brotli). Icon fonts are rejected (monochrome + build friction — the same reason we skip file-icons/atom).
- Most icons are full-color and theme-agnostic; a **minority need a light-theme variant** (Material ships 49 `_light` SVGs). Structural glyphs (default file/folder) use `currentColor`.

---

## 1. Candidate comparison

| Set | Coverage (Kotlin/Swift/Dart/Zig, folders) | Format | License (asset) — **source** | Size | Maintenance |
|---|---|---|---|---|---|
| **Material Icon Theme** ✅ | **Excellent.** Kotlin ✓ Swift ✓ Dart ✓ Zig ✓; per-**folderName** icons + generated **open/closed** states; maps by fileName + fileExtension + **languageId** | **Full-color SVG**, one file per icon | **MIT** (code *and* assets, one LICENSE, no asset carve-out) — [LICENSE](https://github.com/material-extensions/vscode-material-icon-theme/blob/main/LICENSE) | 903 SVG ≈ **693 KB** raw (curated subset far smaller; brotli ~tens of KB) | **Very active** — `material-extensions` org, v5.29.x, frequent releases |
| **vscode-icons** | Excellent, very broad; full-color; folders + open/closed | Full-color SVG | ⚠️ **Code MIT, but ICONS = Creative Commons ShareAlike (CC BY-SA); branded icons under their own copyright** — [README](https://github.com/vscode-icons/vscode-icons#readme), [code LICENSE](https://github.com/vscode-icons/vscode-icons/blob/master/LICENSE) | large | Active | 
| **Seti UI** (VS Code's built-in "Seti") | Moderate. Common langs ✓, but **thin on newer langs (Zig missing/weak)**; **generic single folder icon**, no per-folder / open-closed richness | Full-color SVG (stored as SVG strings in a JSON map) | **MIT** — [jesseweed/seti-ui](https://github.com/jesseweed/seti-ui), repackaged SVG [elviswolcott/seti-icons](https://github.com/elviswolcott/seti-icons) | small (~ a few hundred KB) | **Low velocity** — Atom-era; still takes occasional PRs (issues into 2024–25) but effectively maintenance-mode |
| **file-icons (Atom)** | ~929 glyphs, strong language coverage incl. niche | ⚠️ **Webfont (woff2), monochrome glyphs** tinted by CSS — not full-color logos | **Code MIT, but assets are a bundle of fonts:** FontAwesome 4.7 (**SIL OFL 1.1**), Font-Mfizz (**OFL**), Devicons, Octicons, DevOpicons, custom File-Icons font — [file-icons/atom](https://github.com/file-icons/atom), [extracted SVG/woff2](https://github.com/exuanbo/file-icons-js) | small (font) | Moderate; Atom is EOL, community-maintained |
| **Devicon** (supplement) | 1300+ **language/tool logos** (Kotlin/Swift/Dart/Zig ✓), full-color; **but not a file theme** — no generic-file icon, no extension/filename mapping, **no folders** | Full-color SVG | **MIT** — [devicons/devicon](https://github.com/devicons/devicon) | ~ (logos only) | Active | 

### Why the two "runner-up but rejected" verdicts matter

- **vscode-icons — the licensing dealbreaker.** The repo's `LICENSE` file is plain MIT (© Roberto Huertas), which is *only the code*. The README states verbatim: *"The icons are licensed under the Creative Commons - ShareAlike (CC BY-SA) license"* and *"Branded icons are licensed under their copyright license."* CC BY-SA is **copyleft on the artwork**: it demands attribution and requires that any **modified icons** be re-licensed under CC BY-SA. Shipping the *unmodified* icons in a commercial app with attribution is arguably permissible, but it drags a share-alike obligation and an attribution/tracking burden into our product chrome for no benefit over an MIT set. **Avoid.** ([source: README](https://github.com/vscode-icons/vscode-icons#readme))
- **file-icons/atom — format + license-surface.** All the bundled fonts are *permissive* (SIL OFL 1.1 / MIT), so it is technically shippable, but (a) it is a **monochrome webfont**, which undercuts the "instantly identify by a colored logo" goal and forces a font build step, and (b) it multiplies the license/NOTICE surface (5–6 upstream fonts to track). Not worth it when Material gives full-color MIT SVG.

### Trademark note (applies to **all** sets, not a differentiator)

Language/tool **logos** (Rust gear, Kotlin, Swift bird, etc.) may be **trademarks** independent of the asset's copyright license. Using them as small file-type indicators is descriptive/nominative use and is what every IDE does, but we should not imply endorsement and should keep a NOTICE file (see §7). This is orthogonal to the copyright license and does not change the recommendation.

---

## 2. Recommendation — **Material Icon Theme assets, MIT, vendored subset**

**Safe to ship** because:

1. **One MIT license covers both code and the SVG assets** — no CC-BY-SA / OFL / per-asset carve-out to reason about (the failure mode of vscode-icons and file-icons). Verified from the repo's single `LICENSE`.
2. **Best coverage for the requirement.** Confirmed present: `kotlin`, `swift`, `dart`, `zig`, `java`, `cpp`, `python`, plus 600+ others. Folder icons have **closed + open** states (open variants generated at build time by `src/scripts/svg/generateOpenFolderIcons.ts`).
3. **Its association model is exactly ours.** Material already maps icons by **exact fileName**, **fileExtension**, **languageId**, and **folderName** — the same tiers our `<FileIcon>` needs, so building our own mapping table from it is mechanical.
4. **Full-color SVG**, so `.cpp` vs `.java` vs `.kt` are distinguishable at a glance in both themes.
5. **Most actively maintained** of the field (frequent releases under the `material-extensions` org), so new languages keep arriving upstream and we can re-vendor.

We **do not** install the VS Code extension or ship its `package.json` icon-theme JSON. We **vendor a curated subset of the raw `icons/*.svg`** and generate our own typed mapping (§5, §7). This keeps the bundle to the ~150–250 icons our detector can actually produce plus folders and defaults, and decouples us from the extension's manifest format.

**Optional supplement:** `Devicon` (MIT) if we ever want a richer language-logo splash elsewhere (e.g. the new-agent runtime picker). Not needed for the file tree.

---

## 3. Selection algorithm

`<FileIcon>` resolves a node to a **sprite symbol id** with a pure, deterministic
priority ladder. Directories and files are separate branches; within files we go
**most-specific → least-specific**: exact filename → LanguageId/extension →
default.

```
resolveIconId(node): string
──────────────────────────────────────────────────────────────
if node.kind === 'dir':
  1. folderNames[basename.toLowerCase()]          e.g. "src", "node_modules", ".github", "test"
     → append "-open" when node.expanded, else the closed id
  2. else → node.expanded ? "folder-open" : "folder"     (generic default)

if node.kind === 'file':
  let base = node.name.toLowerCase()
  3. fileNames[base]                              exact basename: "cargo.toml", "dockerfile",
                                                  ".gitignore", "tsconfig.json", "makefile"
  4. compound extension (longest dotted suffix first):
     fileExtensions[".d.ts"], [".test.tsx"], [".stories.ts"], [".min.js"], [".tar.gz"] …
  5. languageId[node.languageId]                  ← from language-detection.md.
                                                  Catches extensionless / shebang / ambiguous
                                                  files the detector already resolved
                                                  (a `.h` decided as cpp; a script with no ext).
  6. single extension: fileExtensions[lastExt]    ".cpp" ".java" ".kt" ".swift" ".dart" ".zig" …
  7. else → "file"                                (generic default)
```

Notes / tie-breaks:

- **Exact filename wins over everything** so `Cargo.toml` gets the Cargo icon, not the generic TOML icon; `Dockerfile` (no extension) resolves at tier 3.
- **`LanguageId` sits *above* the bare single-extension** (tier 5 before tier 6) because the detector has already fused filename + shebang + content and is more authoritative for the ambiguous cases; but **compound extensions stay above it** (tier 4) because they encode file *role* the language id can't (`.d.ts` declaration vs `.ts`, `.test.ts` vs `.ts`). For the overwhelmingly common case (`.cpp`, `.kt`, …) tiers 5 and 6 agree — the ordering only matters at the edges.
- **Case-insensitive** basename/extension matching; store keys are pre-lowercased at build time.
- **Total function:** every path ends at `file` / `folder` / `folder-open`, so the tree never renders a missing glyph.
- **Cheap:** all tiers are `Record` hash lookups; no per-render iteration except the small fixed compound-suffix probe list. Wrap in `useMemo`/`React.memo` keyed on `(name, kind, languageId, expanded)`.

The lookup tables are generated (not hand-written) from the vendored Material set — see §7.

```ts
// icon-map.ts  (generated — do not edit by hand)
export interface IconMap {
  fileNames:      Record<string, string>;   // "cargo.toml"  -> "cargo"
  fileExtensions: Record<string, string>;   // "kt"|".d.ts"  -> "kotlin"|"typescript-def"
  languageIds:    Record<LanguageId, string>;// "cpp"        -> "cpp"
  folderNames:    Record<string, string>;   // "src"         -> "folder-src"  (open = +"-open")
  light:          Set<string>;              // ids that HAVE a "<id>_light" variant
  defaults:       { file: string; folder: string; folderOpen: string };
}
```

---

## 4. Bundling strategy — **inline SVG sprite, eager**

**Decision: one inline SVG sprite** (`<svg><symbol id="mi-rust">…</symbol>…</svg>`)
injected once into the DOM at app start; every icon is a
`<svg><use href="#mi-rust"/></svg>`.

Why, given a Vite-bundled Tauri app (assets served locally — no network):

| Option | Verdict |
|---|---|
| **Inline SVG sprite** ✅ | Single parse, DOM-reused via `<use>`, keeps full color, trivially themeable, no per-icon module overhead. ~150–250 curated icons ≈ tens of KB brotli. Eager-load: the file tree needs icons immediately and everywhere. |
| Per-file SVG (`import url from './rust.svg'`) | Works locally, but produces hundreds of tiny assets/modules and repeated DOM `<img>`/inline nodes; no reuse benefit; more build churn. Rejected. |
| SVG-as-React-components (`vite-plugin-svgr`) | Fine ergonomically but ships each icon as a JS module → larger JS, no `<use>` de-dupe. Rejected for the tree; acceptable only for a handful of one-off UI glyphs. |
| **Icon font** (the file-icons/atom model) | Rejected: monochrome only (kills color identification), extra font-build pipeline, FOUT, and the exact license-surface problem we're avoiding. |

**Lazy vs eager:** eager for the curated core sprite (small, universally used). If
we later vendor Material's *full* 900-icon set, split into `sprite-core.svg`
(top ~150 languages, eager) + a lazy-`import()`ed `sprite-extra.svg` fetched on
first miss. Not needed at current scope.

**Build:** SVGO-optimize each vendored icon (strip metadata, round paths) → assemble
into `sprite.svg` with a Vite build step; the same step emits `icon-map.ts` (§3).
Sprite + map are generated artifacts committed under `src/assets/file-icons/`.

---

## 5. Theming (light/dark)

The app has light/dark theming (`<html data-theme>`).

- **Brand/language icons are full-color and identity-bearing → keep them
  identical in both themes.** A Rust or Kotlin logo should look the same on light
  and dark; recoloring them per theme hurts recognition. This covers the vast
  majority of icons.
- **A minority (near-black / dark logos) vanish on light backgrounds.** Material
  solves this with **49 `_light` variants** (`opencode_light.svg`, etc.). Our
  resolver checks `iconMap.light.has(id)`: when `data-theme="light"` and a
  `_light` variant exists, swap `#mi-<id>` → `#mi-<id>_light`. This is the only
  place icons are theme-sensitive.
- **Structural / monochrome glyphs** (`default file`, `default folder`,
  `folder-open` chevron-less base) should be authored/overridden to use
  `fill="currentColor"` so they inherit the tree's foreground token in both
  themes and blend with selection/hover states.
- **State styling via CSS, not extra assets:** selection keeps the icon at full
  color (recognizability); git-ignored / greyed rows get `opacity: .55`; a
  `dirty` editor tab shows the store's dot affordance, not a
  recolored icon.

So: **most icons need no variant; a small `_light` subset does; defaults use
`currentColor`.**

---

## 6. `<FileIcon>` integration sketch

A single presentational component used by both the file tree and editor tabs.

```tsx
// FileIcon.tsx
import type { LanguageId } from './language-detection';   // from language-detection.md
import { resolveIconId } from './resolveIconId';          // implements §3 over the generated icon-map
import { useTheme } from '../app/useTheme';               // 'light' | 'dark' (data-theme)

export interface FileIconProps {
  name: string;               // basename: "main.cpp", "Cargo.toml", "src"
  kind: 'file' | 'dir';       // === WorkspaceTreeNode.kind
  languageId?: LanguageId;    // resolved by language-detection (files only)
  expanded?: boolean;         // dir open/closed state (from Workspace.expandedIds)
  className?: string;
}

export const FileIcon = React.memo(function FileIcon(
  { name, kind, languageId, expanded, className }: FileIconProps,
) {
  const theme = useTheme();
  const id = resolveIconId({ name, kind, languageId, expanded }); // §3 ladder → symbol id
  const themed = theme === 'light' && iconMap.light.has(id) ? `${id}_light` : id;
  return (
    <svg className={clsx('file-icon', className)} width={16} height={16} aria-hidden>
      <use href={`#mi-${themed}`} />
    </svg>
  );
});
```

**Wiring into existing components:**

- **`<FileTreeNode>`** — the primary consumer:
  ```tsx
  <FileIcon name={node.name} kind={node.kind}
            languageId={node.languageId}              // add to WorkspaceTreeNode (see below)
            expanded={workspace.expandedIds.has(node.id)} />
  ```
  This needs one additive field on `WorkspaceTreeNode`: an optional
  `languageId?: LanguageId`, populated by the language-detection pass when the
  Rust FS walker returns file nodes (cheap — filename-based; content sniffing only
  on demand). Until populated, tiers 3/4/6 still resolve icons from the filename
  alone, so the field is a pure enhancement.

- **Editor `<Tab>` and `<EditorView>` / `<PathBreadcrumb>`** — a `Tab` of
  `kind:'editor'` derives its icon from the referenced `EditorDoc`:
  ```tsx
  <FileIcon name={basename(doc.path)} kind="file" languageId={doc.language as LanguageId} />
  ```
  This **replaces the opaque `Tab.icon: string` "resolved from kind + doc
  language"** for editor tabs with a single
  source of truth. `EditorDoc.language` (CM6 language id) and our `LanguageId`
  should be the same vocabulary the language-detection design defines; if CM6 ids
  and `LanguageId` ever diverge, map through language-detection's table, not here.

- **Non-file tabs stay separate.** `agent-terminal` and `terminal` tabs are **not**
  file icons — they use a tiny fixed set of UI glyphs (an agent mark, a terminal
  glyph). Keep those as their own 2–3 symbols in the same sprite (or a small
  Codicons/Lucide-style set), selected by `Tab.kind`, **not** through the
  `<FileIcon>` language ladder. `<FileIcon>` owns only `kind:'file' | 'dir'`.

**Store impact:** minimal and additive — one optional `languageId` on
`WorkspaceTreeNode`; editor tabs stop precomputing `Tab.icon` and render
`<FileIcon>` from the doc. No new async, no store churn on the terminal byte path.

---

## 7. Vendoring, build pipeline & attribution

1. **Pin** a Material Icon Theme release; copy only the needed `icons/*.svg` into
   `src/assets/file-icons/svg/` (curated to our `LanguageId` set + common
   fileNames + folderNames + defaults; re-run `generateOpenFolderIcons` locally,
   or vendor closed folders and derive open variants in our build).
2. **Generate** `sprite.svg` + `icon-map.ts` via an SVGO + assemble script (§3, §4).
3. **NOTICE / licenses:** commit Material's MIT `LICENSE` text into a
   `THIRD_PARTY_LICENSES` (or `NOTICE`) file shipped with the app, crediting
   *Material Icon Theme (© Material Extensions, MIT)*. If we later add Devicon,
   append its MIT notice. This satisfies MIT's attribution clause and documents
   the trademark note from §1.
4. **Refresh cadence:** because upstream is very active, periodically re-vendor to
   pick up new languages; the generation script makes this a one-command bump.

---

## 8. Open questions / follow-ups

- **`WorkspaceTreeNode.languageId` ownership** — should the Rust FS walker attach
  it (filename-cheap) or should the UI derive it lazily via language-detection?
  Coordinate with `language-detection.md`; either works with the ladder in §3.
- **`LanguageId` ↔ CM6 language id** vocabulary alignment (EditorDoc.language).
  Should be one table owned by language-detection; `<FileIcon>` must not fork it.
- **UI-glyph set for non-file tabs / toolbar** (agent, terminal, split, close,
  git-status badges) — out of scope here; likely Codicons (MIT) or Lucide (ISC).
  Track with the UI components, not this doc.
- **git-status decoration** — `WorkspaceTreeNode.gitStatus` (modified/added/…) is
  a color/badge overlay on the row, composed *with* the file icon, not part of
  icon resolution.

### Sources

- Material Icon Theme — MIT (code + assets): <https://github.com/material-extensions/vscode-material-icon-theme/blob/main/LICENSE> · repo <https://github.com/material-extensions/vscode-material-icon-theme>
- vscode-icons — code MIT but **icons CC BY-SA**: README <https://github.com/vscode-icons/vscode-icons#readme> · code LICENSE <https://github.com/vscode-icons/vscode-icons/blob/master/LICENSE>
- Seti UI — MIT: <https://github.com/jesseweed/seti-ui> · SVG repackage <https://github.com/elviswolcott/seti-icons>
- file-icons (Atom) — code MIT, fonts SIL OFL 1.1 / MIT (FontAwesome 4.7, Font-Mfizz, Devicons, Octicons): <https://github.com/file-icons/atom> · extracted <https://github.com/exuanbo/file-icons-js> · FA4 font license <https://fontawesome.com/v4/license/>
- Devicon — MIT: <https://github.com/devicons/devicon>
