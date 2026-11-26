/** The role tables are private on purpose: each row is pinned here by an explicit literal (the
 * independent copy), so a drifted row fails by name. */

import { describe, expect, it } from "vitest";

import { folderRole } from "./folderSemantics";

describe("folderRole — Rust projects", () => {
  it("src → src; tests + benches → test; target → generated", () => {
    expect(folderRole("src")).toBe("src");
    expect(folderRole("tests")).toBe("test");
    expect(folderRole("benches")).toBe("test");
    expect(folderRole("target")).toBe("generated");
  });
});

describe("folderRole — Kotlin (Gradle/Maven) projects", () => {
  it("'main' is source ONLY directly under 'src' (the src/main source-set level)", () => {
    expect(folderRole("main", "src")).toBe("src");
    // Two-sided: the same name outside that context is a plain folder.
    expect(folderRole("main")).toBeNull();
    expect(folderRole("main", null)).toBeNull();
    expect(folderRole("main", "w")).toBeNull();
  });

  it.each(["java", "kotlin", "scala", "groovy", "resources"])(
    "source-set child '%s': src under 'main', test under 'test', plain elsewhere",
    (name) => {
      expect(folderRole(name, "main")).toBe("src");
      expect(folderRole(name, "test")).toBe("test");
      expect(folderRole(name)).toBeNull(); // no parent context → nothing
      expect(folderRole(name, "docs")).toBeNull();
    },
  );

  it("'test' (the src/test level) and 'androidTest' are test folders", () => {
    expect(folderRole("test")).toBe("test");
    expect(folderRole("test", "src")).toBe("test");
    expect(folderRole("androidtest")).toBe("test");
    expect(folderRole("androidTest")).toBe("test"); // the on-disk Android spelling
  });

  it("'buildSrc' is a source module (Gradle build logic), any casing", () => {
    expect(folderRole("buildSrc")).toBe("src");
    expect(folderRole("buildsrc")).toBe("src");
  });

  it("build outputs: build, .gradle, out → generated", () => {
    expect(folderRole("build")).toBe("generated");
    expect(folderRole(".gradle")).toBe("generated");
    expect(folderRole("out")).toBe("generated");
  });
});

describe("folderRole — web (JS/TS) projects", () => {
  it("src → src, with any parent — or none", () => {
    expect(folderRole("src", null)).toBe("src");
    expect(folderRole("src", "docs")).toBe("src");
  });

  it.each(["__tests__", "spec", "specs", "e2e"])("'%s' → test", (name) => {
    expect(folderRole(name)).toBe("test");
  });

  it.each(["node_modules", "dist", ".next", "coverage", "vendor"])(
    "'%s' → generated",
    (name) => {
      expect(folderRole(name)).toBe("generated");
    },
  );
});

describe("folderRole — case-insensitivity, scope, negatives", () => {
  it("compares the folder name lowercase", () => {
    expect(folderRole("SRC")).toBe("src");
    expect(folderRole("Tests")).toBe("test");
    expect(folderRole("DIST")).toBe("generated");
  });

  it("compares the parent name lowercase too", () => {
    expect(folderRole("java", "MAIN")).toBe("src");
    expect(folderRole("Main", "Src")).toBe("src");
  });

  it("out-of-scope ecosystems carry no role — the Python rows were DROPPED", () => {
    expect(folderRole("__pycache__")).toBeNull();
    expect(folderRole(".venv")).toBeNull();
  });

  it("'testdata' is kept (a conventional test-input dir beyond Go — see the module header)", () => {
    expect(folderRole("testdata")).toBe("test");
  });

  it("'fixtures' is deliberately NOT a test folder (too generic — see the module header)", () => {
    expect(folderRole("fixtures")).toBeNull();
  });

  it("plain folders carry no role", () => {
    expect(folderRole("docs")).toBeNull();
    expect(folderRole(".github")).toBeNull();
    expect(folderRole("lib")).toBeNull();
    expect(folderRole("components", "src")).toBeNull(); // parent context is not contagious
  });
});
