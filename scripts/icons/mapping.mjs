/**
 * The hand-curated file-icon mapping — the SINGLE human-authored source the
 * generator (`scripts/icons/generate.mjs`) compiles into
 * `src/lib/fileIcons/iconMap.generated.ts` + `sprite.generated.ts`.
 *
 * Design: docs/design/file-icons.md (§2 vendored Material subset, §3 ladder,
 * §4 inline sprite); the icons are the Material Icon Theme (MIT).
 *
 * RULES (enforced by the generator, tested in generate.test.mjs):
 *  - Every VALUE is an icon id and must equal a vendored
 *    `src/assets/file-icons/svg/<id>.svg` basename.
 *  - Every KEY is pre-lowercased (the resolver lowercases at lookup time, so
 *    an uppercase key here would be dead).
 *  - `fileExtensions` keys carry NO leading dot; compound extensions such as
 *    "d.ts" are allowed (the resolver probes longest-dotted-suffix first).
 *  - `languageIds` keys must be members of the LanguageId union
 *    (src/lib/language/ids.ts). The table is deliberately PARTIAL: an id
 *    without a vendored icon falls through the ladder — do not vendor icons
 *    outside the curated scope just to fill it.
 *
 * CURATION SCOPE: Rust, Kotlin/JVM (Gradle + Maven), web
 * projects, and common infra. Every icon id below was verified against
 * upstream's own association source (`src/core/icons/fileIcons.ts` at the
 * pinned tag) — the id names are upstream's, not invented.
 *
 * Documented deviations from upstream's associations (never from its ids):
 *  - `cargo.toml` / `cargo.lock` / `rust-toolchain(.toml)` → "rust".
 *    Upstream v5.37.0 has NO cargo association at all (they would render as
 *    generic toml/lock). The Rust-first scope wants Cargo files
 *    instantly recognizable, so they get the Rust logo.
 *  - "gradle.kts" compound extension → "gradle". Upstream maps only the bare
 *    `gradle` extension, so `build.gradle.kts` falls to the Kotlin icon there;
 *    in a Gradle-first JVM tree the build files should read as Gradle.
 *  - `mvnw` / `mvnw.cmd` → "maven", by symmetry with upstream's own
 *    `gradlew` / `gradlew.bat` → "gradle".
 *  - `.env` → "tune" as an exact fileName (upstream reaches it via the `env`
 *    extension; our resolver treats `.env` as a bare basename).
 */

/** The pinned upstream release everything is vendored from. */
export const UPSTREAM = {
  repo: "https://github.com/material-extensions/vscode-material-icon-theme",
  tag: "v5.37.0",
  commit: "850c06c7fb7ea73d873a0ce2f966bbd20850946d",
};

export const MAPPING = {
  /** exact lowercased basename → icon id */
  fileNames: {
    // ── Rust ───────────────────────────────────────────────────────────────
    "cargo.toml": "rust",
    "cargo.lock": "rust",
    "rust-toolchain": "rust",
    "rust-toolchain.toml": "rust",

    // ── Kotlin / JVM: Maven + Gradle ───────────────────────────────────────
    "pom.xml": "maven",
    "maven.config": "maven",
    "jvm.config": "maven",
    "mvnw": "maven",
    "mvnw.cmd": "maven",
    "gradlew": "gradle",
    "gradlew.bat": "gradle",
    "gradle.properties": "gradle",
    "gradle-wrapper.properties": "gradle",

    // ── Web: package managers / runtimes ───────────────────────────────────
    "package.json": "nodejs",
    "package-lock.json": "nodejs",
    ".nvmrc": "nodejs",
    ".npmrc": "npm",
    "pnpm-lock.yaml": "pnpm",
    "pnpm-workspace.yaml": "pnpm",
    "yarn.lock": "yarn",
    ".yarnrc": "yarn",
    ".yarnrc.yml": "yarn",

    // ── Web: TypeScript project configs ────────────────────────────────────
    "tsconfig.json": "tsconfig",
    "tsconfig.app.json": "tsconfig",
    "tsconfig.base.json": "tsconfig",
    "tsconfig.build.json": "tsconfig",
    "tsconfig.eslint.json": "tsconfig",
    "tsconfig.e2e.json": "tsconfig",
    "tsconfig.lib.json": "tsconfig",
    "tsconfig.node.json": "tsconfig",
    "tsconfig.paths.json": "tsconfig",
    "tsconfig.spec.json": "tsconfig",
    "tsconfig.test.json": "tsconfig",
    "tsconfig.web.json": "tsconfig",
    "tsconfig.worker.json": "tsconfig",

    // ── Web: bundler / test-runner configs (upstream Ecmascript pattern) ───
    "vite.config.js": "vite",
    "vite.config.mjs": "vite",
    "vite.config.cjs": "vite",
    "vite.config.ts": "vite",
    "vite.config.mts": "vite",
    "vite.config.cts": "vite",
    "vitest.config.js": "vitest",
    "vitest.config.mjs": "vitest",
    "vitest.config.cjs": "vitest",
    "vitest.config.ts": "vitest",
    "vitest.config.mts": "vitest",
    "vitest.config.cts": "vitest",
    "vitest.workspace.js": "vitest",
    "vitest.workspace.mjs": "vitest",
    "vitest.workspace.cjs": "vitest",
    "vitest.workspace.ts": "vitest",
    "vitest.workspace.mts": "vitest",
    "vitest.workspace.cts": "vitest",

    // ── Web: linter / formatter configs ────────────────────────────────────
    ".eslintrc": "eslint",
    ".eslintrc.js": "eslint",
    ".eslintrc.cjs": "eslint",
    ".eslintrc.mjs": "eslint",
    ".eslintrc.ts": "eslint",
    ".eslintrc.json": "eslint",
    ".eslintrc.yaml": "eslint",
    ".eslintrc.yml": "eslint",
    ".eslintignore": "eslint",
    "eslint.config.js": "eslint",
    "eslint.config.mjs": "eslint",
    "eslint.config.cjs": "eslint",
    "eslint.config.ts": "eslint",
    ".prettierrc": "prettier",
    ".prettierrc.js": "prettier",
    ".prettierrc.cjs": "prettier",
    ".prettierrc.mjs": "prettier",
    ".prettierrc.json": "prettier",
    ".prettierrc.yaml": "prettier",
    ".prettierrc.yml": "prettier",
    ".prettierrc.toml": "prettier",
    ".prettierignore": "prettier",
    "prettier.config.js": "prettier",
    "prettier.config.mjs": "prettier",
    "prettier.config.cjs": "prettier",

    // ── Infra: Docker ──────────────────────────────────────────────────────
    "dockerfile": "docker",
    "containerfile": "docker",
    "docker-compose.yml": "docker",
    "docker-compose.yaml": "docker",
    "compose.yml": "docker",
    "compose.yaml": "docker",
    ".dockerignore": "docker",

    // ── Infra: git ─────────────────────────────────────────────────────────
    ".gitignore": "git",
    ".gitattributes": "git",
    ".gitmodules": "git",
    ".gitconfig": "git",

    // ── Infra: build / docs / env / editor ─────────────────────────────────
    "makefile": "makefile",
    "gnumakefile": "makefile",
    "readme": "readme",
    "readme.md": "readme",
    "readme.txt": "readme",
    "license": "license",
    "license.md": "license",
    "license.txt": "license",
    "licence": "license",
    "copying": "license",
    ".env": "tune",
    ".env.local": "tune",
    ".env.example": "tune",
    ".env.development": "tune",
    ".env.production": "tune",
    ".env.test": "tune",
    ".editorconfig": "editorconfig",
  },

  /** lowercased extension WITHOUT leading dot; compound ("d.ts") allowed */
  fileExtensions: {
    // ── Rust ───────────────────────────────────────────────────────────────
    rs: "rust",
    toml: "toml",

    // ── Kotlin / JVM ───────────────────────────────────────────────────────
    kt: "kotlin",
    kts: "kotlin",
    java: "java",
    jar: "jar",
    gradle: "gradle",
    "gradle.kts": "gradle",
    properties: "settings",
    xml: "xml",

    // ── Web: JS/TS family ──────────────────────────────────────────────────
    ts: "typescript",
    mts: "typescript",
    cts: "typescript",
    "d.ts": "typescript-def",
    "d.mts": "typescript-def",
    "d.cts": "typescript-def",
    tsx: "react_ts",
    jsx: "react",
    js: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    "test.ts": "test-ts",
    "spec.ts": "test-ts",
    "test.tsx": "test-jsx",
    "spec.tsx": "test-jsx",
    "test.jsx": "test-jsx",
    "spec.jsx": "test-jsx",
    "test.js": "test-js",
    "spec.js": "test-js",
    "tsconfig.json": "tsconfig",

    // ── Web: markup / styles / frameworks / data ───────────────────────────
    html: "html",
    htm: "html",
    css: "css",
    scss: "sass",
    sass: "sass",
    less: "less",
    svg: "svg",
    vue: "vue",
    svelte: "svelte",
    astro: "astro",
    json: "json",
    jsonc: "json",
    json5: "json",
    mdx: "mdx",

    // ── Infra / common ─────────────────────────────────────────────────────
    yml: "yaml",
    yaml: "yaml",
    md: "markdown",
    markdown: "markdown",
    sql: "database",
    proto: "proto",
    graphql: "graphql",
    gql: "graphql",
    sh: "console",
    bash: "console",
    zsh: "console",
    fish: "console",
    env: "tune",
    png: "image",
    jpg: "image",
    jpeg: "image",
    gif: "image",
    webp: "image",
    ico: "image",
    pdf: "pdf",
    zip: "zip",
    tar: "zip",
    gz: "zip",
    csv: "table",
    tsv: "table",
    txt: "document",
    lock: "lock",
    wasm: "webassembly",
  },

  /**
   * LanguageId (src/lib/language/ids.ts) → icon id. Partial by design: ids
   * outside the curated scope (python, go, cpp, …) fall through to the
   * extension tier / default. `plaintext` is deliberately absent so unknown
   * text files keep the generic file glyph instead of the .txt document icon.
   */
  languageIds: {
    javascript: "javascript",
    jsx: "react",
    typescript: "typescript",
    tsx: "react_ts",
    json: "json",
    jsonc: "json",
    json5: "json",
    html: "html",
    css: "css",
    scss: "sass",
    sass: "sass",
    less: "less",
    vue: "vue",
    svelte: "svelte",
    astro: "astro",
    xml: "xml",
    svg: "svg",
    rust: "rust",
    java: "java",
    kotlin: "kotlin",
    shell: "console",
    fish: "console",
    makefile: "makefile",
    dockerfile: "docker",
    yaml: "yaml",
    toml: "toml",
    ini: "settings",
    properties: "settings",
    dotenv: "tune",
    editorconfig: "editorconfig",
    sql: "database",
    graphql: "graphql",
    protobuf: "proto",
    csv: "table",
    tsv: "table",
    gitignore: "git",
    "git-config": "git",
    "git-attributes": "git",
    markdown: "markdown",
    mdx: "mdx",
  },

  /**
   * The total-function fallback (file-icons.md §3 tier 7). `file.svg` is
   * authored by us in the Material style with `fill="currentColor"` (§5:
   * structural glyphs inherit the tree's foreground token) — upstream v5.37.0
   * ships no `icons/file.svg` despite naming "file" its default.
   */
  defaultFile: "file",
};
