/** IntelliJ-style folder roles for the Files tree, from a folder NAME (some rows: its parent's
 * name), lowercased; never paths. Scoped to Rust, Kotlin and web, so no other ecosystems' rows.
 * Tables are private on purpose (the test pins each row); `fixtures` is too generic to color. */

export type FolderRole = "src" | "test" | "generated";

/** Test-code folders (green). `testdata` is a judgment call: best known from Go, but also an
 * unambiguous test-input dir in Rust and web repos. */
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

/** Build outputs / dependency caches (dim orange): never hand-edited, so de-emphasized like
 * IntelliJ's "excluded" roots. `vendor` is kept by choice: common in web monorepos. */
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

/** Role of folder `name` whose parent is NAMED `parentName` (not a path; omit when unknown), or
 * `null`. The tables are disjoint, so lookup order carries no precedence. */
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
