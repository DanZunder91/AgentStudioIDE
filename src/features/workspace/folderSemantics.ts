/**
 * folderSemantics — IntelliJ-style semantic folder roles for the Files tree.
 *
 * Pure, table-driven: a folder NAME (plus, for the context-dependent rows, its
 * PARENT's name) maps to a role the tree colors by — `src` (blue), `test`
 * (green), `generated` (dim orange, IntelliJ's "excluded" feel) — or `null` for
 * a plain folder. Comparison is lowercase on both name and parent; paths never
 * enter this module (the tree passes `basename(parentPath(entry.path))`).
 *
 * SCOPE: designed for **Rust, Kotlin (Gradle/Maven) and
 * web (JS/TS)** projects. Other ecosystems are deliberately out of scope
 * until the scope is widened; rows no supported project produces would be
 * unreviewed dead data, which is why there are no Python rows
 * (`__pycache__`, `.venv`) "just in case".
 *
 * The tables are deliberately PRIVATE (an exported table invites
 * self-referential tests); `folderSemantics.test.ts` pins every row with
 * explicit literal assertions instead.
 *
 * Rust convention note: `src/`, `tests/`, `benches/` and `target/` are all
 * covered by the rows below — no Rust-specific rows are needed.
 *
 * Deliberate omission: `fixtures` is NOT a test row. It is too generic — a
 * `src/fixtures` of app data vs. a test-data `fixtures/` is ambiguous, and a
 * wrong green is worse than no color.
 */

export type FolderRole = "src" | "test" | "generated";

/** Test-code folders (green): `test(s)`/`spec(s)` (generic + Rust `tests`),
 *  Jest's `__tests__`, e2e suites, Android's `androidTest` source set, Rust's
 *  `benches`. `testdata` is kept although it is best known from Go: it also
 *  appears as a conventional test-input dir in Rust and web repos, and it is
 *  unambiguous — flagged as a judgment call, easy to drop if it proves
 *  wrong. */
const TEST_DIRS = new Set([
  "test",
  "tests",
  "__tests__",
  "spec",
  "specs",
  "e2e",
  "androidtest",
  "benches",
  "testdata",
]);

/** Build outputs / dependency caches (dim orange): never hand-edited, so the
 *  tree de-emphasizes them the way IntelliJ marks "excluded" roots. Rust:
 *  `target`; Gradle: `build`, `.gradle`, `out` (IDEA's output dir); web:
 *  `node_modules`, `dist`, `.next`, `coverage`. `vendor` is kept by choice:
 *  vendored dependencies are common in web monorepos (and beyond), and the
 *  dir is never hand-edited wherever it appears. */
const GENERATED_DIRS = new Set([
  "target",
  "build",
  "dist",
  "out",
  "node_modules",
  "vendor",
  "coverage",
  ".gradle",
  ".next",
]);

/** JVM source-set children (Maven/Gradle layout): `src/main/kotlin` etc. Their
 *  role comes from the PARENT — `main` → src, `test` → test; anywhere else
 *  they are plain folders (a top-level `java/` says nothing). */
const JVM_SOURCE_SET_CHILDREN = new Set(["java", "kotlin", "scala", "groovy", "resources"]);

/**
 * The role of a folder named `name` whose parent folder is named `parentName`
 * (pass the parent's NAME, not its path; omit/null when unknown), or `null`
 * for a plain folder. The literal tables above are disjoint, so lookup order
 * carries no precedence semantics.
 */
export function folderRole(name: string, parentName?: string | null): FolderRole | null {
  const n = name.toLowerCase();
  const parent = parentName == null ? null : parentName.toLowerCase();
  if (TEST_DIRS.has(n)) return "test";
  if (GENERATED_DIRS.has(n)) return "generated";
  // `src` is source anywhere; so is Gradle's `buildSrc` (a build-logic source
  // module); `main` is source only as a src/main source-set level (a
  // top-level `main/` is just a name).
  if (n === "src" || n === "buildsrc") return "src";
  if (n === "main" && parent === "src") return "src";
  if (JVM_SOURCE_SET_CHILDREN.has(n)) {
    if (parent === "main") return "src";
    if (parent === "test") return "test";
  }
  return null;
}
