/**
 * `portabilityIpc` — the bundle wire. Thin wrappers, so the command **name**, the
 * **argument shape** and the **rejection passthrough** are the whole contract — and all three
 * fail as silence rather than as an error.
 *
 * Why every argument is asserted BY NAME: Tauri deserialises a command's arguments by key
 * (`src_path` in Rust ⇄ `srcPath` in JS). A renamed or misspelled key does not throw — serde
 * fills the field from its default, or the command rejects about a field the caller never
 * mentioned. `passphrase` is the one that matters most here: if that key went missing, a
 * sealed bundle would inspect as "still sealed" forever and look like a wrong passphrase.
 *
 * Every expectation is written LITERALLY rather than derived from the wrapper's own input:
 * an assertion computed from the value under test can only catch plumbing, never a wrong
 * name.
 *
 * The picker is mocked at the module boundary, the way `WorkspaceTree.test.tsx` mocks the
 * folder picker — it is the one part of this feature jsdom cannot drive, which is exactly why
 * it lives in this module and nowhere else.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dialog = vi.hoisted(() => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => dialog);

import { installTauriMock, type TauriMock } from "../../test/tauri-mock";
import {
  bundleFileName,
  importChoices,
  pickBundleDestination,
  pickBundleSource,
  portabilityExport,
  portabilityImport,
  portabilityInspect,
} from "./portabilityIpc";
import type {
  BundleHeader,
  ExportOptions,
  ImportPlan,
  ImportResult,
} from "./types";

/** Zero of everything — the counts shape, spelled out so a test can vary one field. */
const NO_COUNTS = {
  dbConnections: 0,
  dbQueries: 0,
  apiRequests: 0,
  environments: 0,
  referencedVariables: 0,
  secretValues: 0,
};

const HEADER: BundleHeader = {
  kind: "agentstudio.bundle",
  version: 1,
  mode: "structure",
  createdAtMs: 1_783_000_000_000,
  app: "Agent Studio 0.1.0",
  label: "Team staging DB + API",
  counts: { ...NO_COUNTS, dbConnections: 2, referencedVariables: 3 },
};

const PLAN: ImportPlan = {
  header: HEADER,
  unsealed: true,
  items: [
    {
      kind: "dbConnection",
      id: "c1",
      label: "Prod Postgres",
      action: "create",
      reason: "nothing with this id exists here",
    },
  ],
  hosts: ["db.internal"],
  variables: [{ name: "PG_PASSWORD", haveLocally: false, bundleHasValue: false }],
  notices: [],
};

/** An all-zero `ImportCounts` — an import counts variables WRITTEN, not names referenced. */
const NO_IMPORT_COUNTS = {
  dbConnections: 0,
  dbQueries: 0,
  apiRequests: 0,
  environments: 0,
  variables: 0,
};

const RESULT: ImportResult = {
  created: { ...NO_IMPORT_COUNTS, dbConnections: 1 },
  updated: { ...NO_IMPORT_COUNTS },
  skipped: { ...NO_IMPORT_COUNTS },
  notices: ["Imported connections are read-only on this machine."],
};

describe("portabilityIpc — command names and argument shapes", () => {
  let ipc: TauriMock;

  beforeEach(() => {
    ipc = installTauriMock();
    dialog.open.mockReset();
    dialog.save.mockReset();
  });
  afterEach(() => {
    ipc.reset();
  });

  it("portabilityExport sends `options` and `destPath`, and returns the header Rust wrote", async () => {
    ipc.handle("portability_export", () => HEADER);
    const options: ExportOptions = {
      mode: "structure",
      label: "Team staging DB + API",
      dbConnectionIds: ["c1"],
    };

    const header = await portabilityExport(options, "/Users/me/bundle.json");

    expect(ipc.lastCall("portability_export")).toEqual({
      options: {
        mode: "structure",
        label: "Team staging DB + API",
        dbConnectionIds: ["c1"],
      },
      destPath: "/Users/me/bundle.json",
    });
    expect(header).toEqual(HEADER);
  });

  it("portabilityExport carries a sealing passphrase inside `options`, and nowhere else", async () => {
    ipc.handle("portability_export", () => ({ ...HEADER, mode: "sealed" as const }));

    await portabilityExport(
      { mode: "sealed", label: "sealed share", passphrase: "correct horse battery" },
      "/tmp/sealed.json",
    );

    // The passphrase is a field OF options — not a fourth argument, not a sibling key. If it
    // were promoted to the top level, Rust's `ExportOptions` would deserialise without it and
    // seal with an empty passphrase, or reject `weak-passphrase` on a strong one.
    expect(ipc.lastCall("portability_export")).toEqual({
      options: {
        mode: "sealed",
        label: "sealed share",
        passphrase: "correct horse battery",
      },
      destPath: "/tmp/sealed.json",
    });
  });

  it("portabilityInspect sends `srcPath` and an explicitly null `passphrase`", async () => {
    ipc.handle("portability_inspect", () => PLAN);

    const plan = await portabilityInspect("/Users/me/bundle.json", null);

    // `passphrase` is PRESENT and null, never omitted: a missing key is what serde fills from
    // a default, which is the same silence as a typo in the name.
    expect(ipc.lastCall("portability_inspect")).toEqual({
      srcPath: "/Users/me/bundle.json",
      passphrase: null,
    });
    expect(Object.keys(ipc.lastCall("portability_inspect") ?? {}).sort()).toEqual([
      "passphrase",
      "srcPath",
    ]);
    expect(plan).toEqual(PLAN);
  });

  it("portabilityInspect sends the passphrase verbatim on the second, unsealing call", async () => {
    ipc.handle("portability_inspect", () => PLAN);

    await portabilityInspect("/tmp/sealed.json", "  spaces matter  ");

    // Not trimmed, not normalised: a passphrase is bytes, and helpfully tidying it here would
    // make a bundle sealed by this app impossible to open by any other reader.
    expect(ipc.lastCall("portability_inspect")).toEqual({
      srcPath: "/tmp/sealed.json",
      passphrase: "  spaces matter  ",
    });
  });

  it("portabilityImport sends `srcPath`, `passphrase` and `choices`", async () => {
    ipc.handle("portability_import", () => RESULT);

    const result = await portabilityImport("/tmp/sealed.json", "correct horse battery", {
      actions: { c1: "skip" },
      overwriteExistingSecrets: false,
      forceReadOnly: true,
    });

    expect(ipc.lastCall("portability_import")).toEqual({
      srcPath: "/tmp/sealed.json",
      passphrase: "correct horse battery",
      choices: { actions: { c1: "skip" }, overwriteExistingSecrets: false, forceReadOnly: true },
    });
    expect(result).toEqual(RESULT);
  });

  it("passes a rejection through as the stable wire string, unwrapped", async () => {
    ipc.handle("portability_inspect", () => {
      throw "not-a-bundle: kind was \"exported-config\"";
    });

    // The exact string, not an Error and not a mapped sentence: `parsePortabilityError` reads
    // the code out of the head, which only works if nothing here reshapes it.
    await expect(portabilityInspect("/tmp/whatever.json", null)).rejects.toBe(
      'not-a-bundle: kind was "exported-config"',
    );
  });

  it("does not swallow an export failure into a resolved value", async () => {
    ipc.handle("portability_export", () => {
      throw "weak-passphrase";
    });

    await expect(
      portabilityExport({ mode: "sealed", label: "x", passphrase: "short" }, "/tmp/a.json"),
    ).rejects.toBe("weak-passphrase");
  });
});

describe("importChoices", () => {
  it("carries the overrides and the flag, and COPIES the map", () => {
    const overrides: Record<string, "create" | "update" | "skip"> = { c1: "skip" };

    const choices = importChoices(overrides, false);
    // Mutating the caller's map afterwards must not change what was sent.
    overrides.c1 = "create";

    // `forceReadOnly` defaults to TRUE when the caller omits it — the safe value has to be what
    // appears when nobody said anything (Rust's serde default agrees).
    expect(choices).toEqual({
      actions: { c1: "skip" },
      overwriteExistingSecrets: false,
      forceReadOnly: true,
    });
    expect(importChoices({}, false, false).forceReadOnly).toBe(false);
    expect(choices.actions).not.toBe(overrides);
  });

  it("passes the overwrite flag through in both positions", () => {
    expect(importChoices({}, true)).toEqual({ actions: {}, overwriteExistingSecrets: true, forceReadOnly: true });
    expect(importChoices({}, false)).toEqual({ actions: {}, overwriteExistingSecrets: false, forceReadOnly: true });
  });
});

describe("bundleFileName", () => {
  it("slugifies the label", () => {
    expect(bundleFileName("Team staging DB + API")).toBe("team-staging-db-api.json");
  });

  it("collapses runs of punctuation and trims the edges", () => {
    expect(bundleFileName("  ///Prod?? & Staging!  ")).toBe("prod-staging.json");
  });

  it("falls back to a name rather than producing a dotfile", () => {
    // `".json"` is a hidden, nameless file in most file managers — the one output that would
    // be actively confusing in a save dialog.
    expect(bundleFileName("")).toBe("agentstudio-bundle.json");
    expect(bundleFileName("!!!")).toBe("agentstudio-bundle.json");
  });

  it("truncates a long label and leaves no dangling separator", () => {
    expect(bundleFileName("a".repeat(80))).toBe(`${"a".repeat(48)}.json`);
    // The 49th character is the space, so the cut lands exactly on a separator.
    expect(bundleFileName(`${"b".repeat(48)} tail`)).toBe(`${"b".repeat(48)}.json`);
  });

  it("asciifies, losing accents — the label itself still travels intact in the bundle", () => {
    expect(bundleFileName("Équipe staging")).toBe("quipe-staging.json");
  });
});

describe("the file picker", () => {
  beforeEach(() => {
    dialog.open.mockReset();
    dialog.save.mockReset();
  });

  it("pickBundleDestination asks for a .json save path, defaulting to the label's slug", async () => {
    dialog.save.mockResolvedValue("/Users/me/team-staging-db-api.json");

    const path = await pickBundleDestination("Team staging DB + API");

    expect(dialog.save).toHaveBeenCalledWith({
      title: "Export config bundle",
      defaultPath: "team-staging-db-api.json",
      filters: [{ name: "Agent Studio bundle", extensions: ["json"] }],
    });
    expect(path).toBe("/Users/me/team-staging-db-api.json");
  });

  it("pickBundleDestination reports a cancel as null", async () => {
    dialog.save.mockResolvedValue(null);
    expect(await pickBundleDestination("anything")).toBeNull();
  });

  it("pickBundleSource asks for ONE existing .json file", async () => {
    dialog.open.mockResolvedValue("/Users/me/from-a-colleague.json");

    const path = await pickBundleSource();

    expect(dialog.open).toHaveBeenCalledWith({
      title: "Import config bundle",
      directory: false,
      multiple: false,
      filters: [{ name: "Agent Studio bundle", extensions: ["json"] }],
    });
    expect(path).toBe("/Users/me/from-a-colleague.json");
  });

  it("pickBundleSource reports a cancel as null", async () => {
    dialog.open.mockResolvedValue(null);
    expect(await pickBundleSource()).toBeNull();
  });

  it("pickBundleSource refuses an array, rather than importing a path-shaped list", async () => {
    // `multiple: false` is asked for, but the plugin's return type admits an array and a
    // future option change would silently produce one. `["a.json"]` as a path would reach
    // Rust as a stringified array and fail as `io`, blaming the file.
    dialog.open.mockResolvedValue(["/a.json", "/b.json"]);
    expect(await pickBundleSource()).toBeNull();
  });
});
