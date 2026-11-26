/** What the public repo may contain: Markdown only via an allowlist mirrored in .gitignore, which
 * stops an accidental `git add`; this test stops a forced one. Literal expectations only. */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Every path git tracks (the index), NUL-separated so odd file names survive. */
function tracked() {
  return execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
}

const isMarkdown = (p) => /\.(md|markdown|mdx)$/i.test(p);

describe("repository hygiene", () => {
  it("only the README and the published technical docs are tracked Markdown", () => {
    expect(tracked().filter(isMarkdown).sort()).toEqual([
      "README.md",
      "docker/db-fixtures/README.md",
      "docs/design/ARCHITECTURE.md",
      "docs/design/agent-restart-restore.md",
      "docs/design/code-intelligence.md",
      "docs/design/csp.md",
      "docs/design/e2e-flow-catalog.md",
      "docs/design/editor-syntax-highlighting.md",
      "docs/design/file-icons.md",
      "docs/design/language-detection.md",
      "docs/design/sql-to-mongo.md",
      "docs/design/tab-tearoff.md",
      "docs/design/testing-strategy.md",
      "e2e/README.md",
      "src-tauri/vendor/portable-pty/UPSTREAM-PATCH.md",
      "src/assets/file-icons/README.md",
      "src/assets/pixel-agents/README.md",
    ]);
  });

  it(".gitignore publishes exactly the same Markdown files the test allows", () => {
    const allowed = readFileSync(path.join(root, ".gitignore"), "utf8")
      .split("\n")
      .filter((l) => l.startsWith("!/") && isMarkdown(l))
      .map((l) => l.slice(2))
      .sort();
    expect(allowed).toEqual(tracked().filter(isMarkdown).sort());
  });

  it("the private notes folder is not tracked at all", () => {
    expect(tracked().filter((p) => p.startsWith(".claude/private/"))).toEqual([]);
  });

  it("recognises every Markdown spelling it guards against", () => {
    expect(["a.md", "B.MD", "c.markdown", "d.mdx", "README.md"].filter(isMarkdown)).toHaveLength(5);
    expect(["md", "a.mdown.txt", "notes.txt", "LICENSE"].filter(isMarkdown)).toEqual([]);
  });
});
