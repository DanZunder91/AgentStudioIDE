/**
 * The `portability` store slice — export, inspect-then-apply, and the choices in between.
 *
 * `portabilityIpc` is mocked at the module boundary the way `db.store.test.ts` mocks `dbIpc`:
 * every one of these actions IS an IPC call plus a reduction, and the point of the tests is
 * the pairing — that the effect happens in the WRAPPER and only the result lands in state.
 * The real `importChoices` builder is kept in the path (only the three commands
 * and the two pickers are stubbed), because what reaches `portability_import` is half of what
 * these tests are about.
 *
 * The two invariants worth more than any single assertion here:
 *
 * 1. 🔴 **No passphrase is ever in the store.** Asserted by serialising the WHOLE store and
 *    searching it, after both a sealed export and an unseal — not by inspecting the two fields
 *    known to be written. A field added later is caught by the same test.
 * 2. **A failed inspect latches nothing.** A wrong passphrase must be retryable without
 *    reopening the file, so the file, the plan and the user's per-item choices all
 *    have to survive a failure — and the error has to disappear the moment the retry starts.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const portabilityIpc = vi.hoisted(() => ({
  portabilityExport: vi.fn(),
  portabilityInspect: vi.fn(),
  portabilityImport: vi.fn(),
  pickBundleDestination: vi.fn(),
  pickBundleSource: vi.fn(),
}));
// Spread over the ACTUAL module so the real `importChoices` (and `bundleFileName`) stay in the
// path — the builder's copy-the-map behaviour is part of what `applyImport` promises.
vi.mock("./portabilityIpc", async (importActual) => {
  const actual = await importActual<typeof import("./portabilityIpc")>();
  return { ...actual, ...portabilityIpc };
});

// `applyImport` re-issues the DB load, because Rust has just rewritten `db-connections.json`
// under a slice whose load-once gate says it is current. Stubbed so that re-read is
// assertable rather than an accident of a missing mock.
const dbIpc = vi.hoisted(() => ({
  dbEngines: vi.fn(),
  dbConnectionsLoad: vi.fn(),
}));
vi.mock("../db/dbIpc", async (importActual) => {
  const actual = await importActual<typeof import("../db/dbIpc")>();
  return { ...actual, ...dbIpc };
});

import { useAppStore } from "../../app/store";
import { resetStore } from "../../test/store-harness";
import { describePortabilityError } from "./portabilityErrors";
import type { BundleHeader, ImportPlan, ImportResult } from "./types";

const actions = () => useAppStore.getState().portabilityActions;
const exportState = () => useAppStore.getState().portabilityExport;
const importState = () => useAppStore.getState().portabilityImport;

/** The whole store as text, for the "no secret anywhere in here" assertions. */
const wholeStore = () => JSON.stringify(useAppStore.getState());

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

const SEALED_HEADER: BundleHeader = { ...HEADER, mode: "sealed", label: "sealed share" };

const plan = (over: Partial<ImportPlan> = {}): ImportPlan => ({
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
    {
      kind: "environment",
      id: "e1",
      label: "staging",
      action: "update",
      reason: "an environment with this id already exists",
    },
  ],
  hosts: ["db.internal"],
  variables: [{ name: "PG_PASSWORD", haveLocally: true, bundleHasValue: false }],
  notices: [],
  ...over,
});

/** What a sealed bundle inspects to with no passphrase: a header, and nothing opened. */
const SEALED_PLAN: ImportPlan = plan({
  header: SEALED_HEADER,
  unsealed: false,
  items: [],
  hosts: [],
  variables: [],
  notices: ["This bundle is sealed. A passphrase is needed to read its contents."],
});

/** An all-zero `ImportCounts`. Distinct from `NO_COUNTS` (a `BundleCounts`) because an import
 *  result counts variables WRITTEN, not names referenced — see `ImportCounts`. */
const NO_IMPORT_COUNTS = {
  dbConnections: 0,
  dbQueries: 0,
  apiRequests: 0,
  environments: 0,
  variables: 0,
};

const RESULT: ImportResult = {
  created: { ...NO_IMPORT_COUNTS, dbConnections: 1 },
  updated: { ...NO_IMPORT_COUNTS, environments: 1 },
  skipped: { ...NO_IMPORT_COUNTS },
  notices: ["Imported connections are read-only on this machine."],
};

/** A promise a test resolves by hand, for asserting `busy` while a call is in flight. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  resetStore();
  for (const fn of [...Object.values(portabilityIpc), ...Object.values(dbIpc)]) fn.mockReset();
  dbIpc.dbEngines.mockResolvedValue([]);
  dbIpc.dbConnectionsLoad.mockResolvedValue({ connections: [], version: 1 });
});

/* ──────────────────────────────── boot state ──────────────────────────────── */

describe("the slice's boot state", () => {
  it("starts with no dialog, no export, and no import", () => {
    expect(useAppStore.getState().portabilityDialog).toBeNull();
    expect(exportState()).toEqual({ busy: false, error: null, done: null });
    expect(importState()).toEqual({
      srcPath: null,
      plan: null,
      busy: false,
      error: null,
      overrides: {},
      overwriteExistingSecrets: false,
      // `true`, and the boot state is where that default lives: a second copy
      // elsewhere is a second place it can be reset to the unsafe value.
      forceReadOnly: true,
      result: null,
    });
  });

  it("defaults `overwriteExistingSecrets` to FALSE — a security default, not a preference", () => {
    // `ImportChoices`: taking someone else's value for a variable you already
    // use is how a working setup breaks in a way nobody traces back to an import. Asserted
    // both on the boot state and on what actually reaches the wire, because a default that is
    // right in state and re-derived wrongly at the call site protects nobody.
    expect(importState().overwriteExistingSecrets).toBe(false);
  });
});

describe("the dialog", () => {
  it("opens export, opens import, and closes", () => {
    actions().openPortabilityDialog("export");
    expect(useAppStore.getState().portabilityDialog).toBe("export");
    actions().openPortabilityDialog("import");
    expect(useAppStore.getState().portabilityDialog).toBe("import");
    actions().closePortabilityDialog();
    expect(useAppStore.getState().portabilityDialog).toBeNull();
  });

  it("closing does not discard the import in progress", () => {
    // The dialog is a modal that can be dismissed by accident; a person's item-by-item review
    // of an untrusted config is not something to throw away on an outside click.
    portabilityIpc.pickBundleSource.mockResolvedValue("/tmp/b.json");
    portabilityIpc.portabilityInspect.mockResolvedValue(plan());
    return actions()
      .chooseImportFile()
      .then(() => {
        actions().openPortabilityDialog("import");
        actions().closePortabilityDialog();
        expect(importState().srcPath).toBe("/tmp/b.json");
        expect(importState().plan).toEqual(plan());
      });
  });
});

/* ───────────────────────────────── export ─────────────────────────────────── */

describe("exportBundle", () => {
  it("picks a destination, writes, and keeps the header Rust measured next to the path", async () => {
    portabilityIpc.pickBundleDestination.mockResolvedValue("/Users/me/bundle.json");
    portabilityIpc.portabilityExport.mockResolvedValue(HEADER);

    const header = await actions().exportBundle({
      mode: "structure",
      label: "Team staging DB + API",
    });

    // The picker is asked with the LABEL, which is what turns into the suggested filename.
    expect(portabilityIpc.pickBundleDestination).toHaveBeenCalledWith("Team staging DB + API");
    expect(portabilityIpc.portabilityExport).toHaveBeenCalledWith(
      { mode: "structure", label: "Team staging DB + API" },
      "/Users/me/bundle.json",
    );
    expect(header).toEqual(HEADER);
    expect(exportState()).toEqual({
      busy: false,
      error: null,
      done: { header: HEADER, path: "/Users/me/bundle.json" },
    });
  });

  it("is busy only while the write is in flight, never while the picker is open", async () => {
    const write = deferred<BundleHeader>();
    portabilityIpc.pickBundleDestination.mockResolvedValue("/tmp/b.json");
    portabilityIpc.portabilityExport.mockReturnValue(write.promise);

    const running = actions().exportBundle({ mode: "structure", label: "x" });
    // The picker already resolved (it is awaited first), so `busy` here is about the write.
    await Promise.resolve();
    expect(exportState().busy).toBe(true);

    write.resolve(HEADER);
    await running;
    expect(exportState().busy).toBe(false);
  });

  it("treats a cancelled picker as nothing happening — no call, no error, no summary", async () => {
    portabilityIpc.pickBundleDestination.mockResolvedValue(null);

    const header = await actions().exportBundle({ mode: "structure", label: "x" });

    expect(header).toBeNull();
    expect(portabilityIpc.portabilityExport).not.toHaveBeenCalled();
    // A cancel is not a failure. `error === null` is what lets a caller tell the two apart,
    // since both resolve `null`.
    expect(exportState()).toEqual({ busy: false, error: null, done: null });
  });

  it("maps a failure to ONE sentence and resolves null rather than rejecting", async () => {
    portabilityIpc.pickBundleDestination.mockResolvedValue("/tmp/b.json");
    portabilityIpc.portabilityExport.mockRejectedValue("weak-passphrase: 8 characters");

    const header = await actions().exportBundle({
      mode: "sealed",
      label: "x",
      passphrase: "tooshort",
    });

    expect(header).toBeNull();
    expect(exportState()).toEqual({
      busy: false,
      error: describePortabilityError("weak-passphrase"),
      done: null,
    });
    // Rust's own words never reach state — the detail is dropped with the code.
    expect(exportState().error).not.toContain("8 characters");
  });

  it("clears a previous failure when the next export starts", async () => {
    portabilityIpc.pickBundleDestination.mockResolvedValue("/tmp/b.json");
    portabilityIpc.portabilityExport.mockRejectedValueOnce("io");
    await actions().exportBundle({ mode: "structure", label: "x" });
    expect(exportState().error).not.toBeNull();

    portabilityIpc.portabilityExport.mockResolvedValue(HEADER);
    await actions().exportBundle({ mode: "structure", label: "x" });

    expect(exportState().error).toBeNull();
    expect(exportState().done).not.toBeNull();
  });

  it("🔴 puts NO sealing passphrase in the store — not in the export state, not anywhere", async () => {
    const PASSPHRASE = "correct-horse-battery-staple";
    portabilityIpc.pickBundleDestination.mockResolvedValue("/tmp/sealed.json");
    portabilityIpc.portabilityExport.mockResolvedValue(SEALED_HEADER);

    await actions().exportBundle({
      mode: "sealed",
      label: "sealed share",
      passphrase: PASSPHRASE,
    });

    // It reached the wire…
    expect(portabilityIpc.portabilityExport).toHaveBeenCalledWith(
      { mode: "sealed", label: "sealed share", passphrase: PASSPHRASE },
      "/tmp/sealed.json",
    );
    // …and it is nowhere in the store. The WHOLE store is searched, not the two fields known
    // to be written: this is the assertion that still holds when someone adds a field.
    expect(wholeStore()).not.toContain(PASSPHRASE);
    expect(exportState().done).toEqual({ header: SEALED_HEADER, path: "/tmp/sealed.json" });
  });
});

/* ─────────────────────────── inspect (step 1 and 2) ───────────────────────── */

describe("chooseImportFile", () => {
  it("picks a file and inspects it with NO passphrase", async () => {
    portabilityIpc.pickBundleSource.mockResolvedValue("/Users/me/from-a-colleague.json");
    portabilityIpc.portabilityInspect.mockResolvedValue(plan());

    await actions().chooseImportFile();

    expect(portabilityIpc.portabilityInspect).toHaveBeenCalledWith(
      "/Users/me/from-a-colleague.json",
      null,
    );
    expect(importState().srcPath).toBe("/Users/me/from-a-colleague.json");
    expect(importState().plan).toEqual(plan());
    expect(importState().busy).toBe(false);
    expect(importState().error).toBeNull();
  });

  it("treats a cancelled picker as nothing happening", async () => {
    portabilityIpc.pickBundleSource.mockResolvedValue(null);

    await actions().chooseImportFile();

    expect(portabilityIpc.portabilityInspect).not.toHaveBeenCalled();
    expect(importState().srcPath).toBeNull();
    expect(importState().error).toBeNull();
  });

  it("a NEW file discards the previous file's choices, plan and result", async () => {
    portabilityIpc.pickBundleSource.mockResolvedValue("/tmp/first.json");
    portabilityIpc.portabilityInspect.mockResolvedValue(plan());
    portabilityIpc.portabilityImport.mockResolvedValue(RESULT);
    await actions().chooseImportFile();
    actions().setImportAction("c1", "skip");
    actions().setOverwriteExistingSecrets(true);
    await actions().applyImport(null);
    expect(importState().result).toEqual(RESULT);

    portabilityIpc.pickBundleSource.mockResolvedValue("/tmp/second.json");
    portabilityIpc.portabilityInspect.mockResolvedValue(plan({ hosts: ["other.host"] }));
    await actions().chooseImportFile();

    // Choices were made about a DIFFERENT file; carrying them over would silently apply a
    // review the user never did — including the overwrite-secrets flag, which is the one
    // decision that must never be inherited.
    expect(importState().overrides).toEqual({});
    expect(importState().overwriteExistingSecrets).toBe(false);
    expect(importState().result).toBeNull();
    expect(importState().srcPath).toBe("/tmp/second.json");
    expect(importState().plan).toEqual(plan({ hosts: ["other.host"] }));
  });

  it("a sealed bundle with no passphrase is a described file, NOT an error", async () => {
    portabilityIpc.pickBundleSource.mockResolvedValue("/tmp/sealed.json");
    portabilityIpc.portabilityInspect.mockResolvedValue(SEALED_PLAN);

    await actions().chooseImportFile();

    // `unsealed: false` here is the normal state of step 1 — the header, the counts and the
    // label are exactly what lets the dialog describe the file before asking for anything.
    expect(importState().plan?.unsealed).toBe(false);
    expect(importState().error).toBeNull();
    expect(importState().plan?.header.mode).toBe("sealed");
  });
});

describe("inspectBundle / unsealImport", () => {
  beforeEach(async () => {
    portabilityIpc.pickBundleSource.mockResolvedValue("/tmp/sealed.json");
    portabilityIpc.portabilityInspect.mockResolvedValue(SEALED_PLAN);
    await actions().chooseImportFile();
    portabilityIpc.portabilityInspect.mockReset();
  });

  it("unseals with the passphrase and adopts the full plan", async () => {
    portabilityIpc.portabilityInspect.mockResolvedValue(plan({ header: SEALED_HEADER }));

    await actions().unsealImport("correct-horse-battery-staple");

    expect(portabilityIpc.portabilityInspect).toHaveBeenCalledWith(
      "/tmp/sealed.json",
      "correct-horse-battery-staple",
    );
    expect(importState().plan?.unsealed).toBe(true);
    expect(importState().plan?.items).toHaveLength(2);
    expect(importState().error).toBeNull();
  });

  it("🔴 puts NO passphrase in the store after an unseal", async () => {
    const PASSPHRASE = "correct-horse-battery-staple";
    portabilityIpc.portabilityInspect.mockResolvedValue(plan({ header: SEALED_HEADER }));

    await actions().unsealImport(PASSPHRASE);

    expect(portabilityIpc.portabilityInspect).toHaveBeenCalledWith("/tmp/sealed.json", PASSPHRASE);
    expect(wholeStore()).not.toContain(PASSPHRASE);
  });

  it("is busy while the inspect is in flight", async () => {
    const inspect = deferred<ImportPlan>();
    portabilityIpc.portabilityInspect.mockReturnValue(inspect.promise);

    const running = actions().unsealImport("x".repeat(12));
    expect(importState().busy).toBe(true);

    inspect.resolve(plan({ header: SEALED_HEADER }));
    await running;
    expect(importState().busy).toBe(false);
  });

  it("a REJECTED unseal keeps the file and the description, so the retry needs no reopen", async () => {
    portabilityIpc.portabilityInspect.mockRejectedValue("bad-passphrase: tag mismatch");

    await actions().unsealImport("wrong one");

    expect(importState().error).toBe(describePortabilityError("bad-passphrase"));
    // Nothing latched: the file is still chosen and the sealed description is still on screen.
    expect(importState().srcPath).toBe("/tmp/sealed.json");
    expect(importState().plan).toEqual(SEALED_PLAN);
    expect(importState().busy).toBe(false);
  });

  it("a RESOLVED-but-still-sealed plan after a passphrase is reported as a bad passphrase", async () => {
    // `ImportPlan.unsealed` is documented as `false` when the passphrase "was wrong", so Rust
    // may answer this way instead of rejecting. Without this arm the dialog would replace the
    // plan with an identical one, show no error, and look broken.
    portabilityIpc.portabilityInspect.mockResolvedValue(SEALED_PLAN);

    await actions().unsealImport("wrong one");

    expect(importState().error).toBe(describePortabilityError("bad-passphrase"));
    expect(importState().plan?.unsealed).toBe(false);
  });

  it("clears the error the moment a retry starts, and a successful retry leaves none", async () => {
    portabilityIpc.portabilityInspect.mockRejectedValueOnce("bad-passphrase");
    await actions().unsealImport("wrong one");
    expect(importState().error).not.toBeNull();

    const inspect = deferred<ImportPlan>();
    portabilityIpc.portabilityInspect.mockReturnValue(inspect.promise);
    const running = actions().unsealImport("right one");
    // The stale message is gone BEFORE the answer arrives — a spinner under "that passphrase
    // did not open the bundle" reads as a failure that is still happening.
    expect(importState().error).toBeNull();

    inspect.resolve(plan({ header: SEALED_HEADER }));
    await running;
    expect(importState().error).toBeNull();
    expect(importState().plan?.unsealed).toBe(true);
  });

  it("keeps the user's per-item choices across a re-inspect", async () => {
    actions().setImportAction("c1", "skip");
    portabilityIpc.portabilityInspect.mockResolvedValue(plan({ header: SEALED_HEADER }));

    await actions().unsealImport("right one");

    // Same file, so the choices made while reading its structure are still the user's.
    expect(importState().overrides).toEqual({ c1: "skip" });
  });

  it("unsealImport with no file chosen is a no-op, not a throw", async () => {
    resetStore();
    await actions().unsealImport("anything at all");
    expect(portabilityIpc.portabilityInspect).not.toHaveBeenCalled();
    expect(importState().error).toBeNull();
  });

  it("inspectBundle can be driven directly with a path, for a re-read of the same file", async () => {
    portabilityIpc.portabilityInspect.mockResolvedValue(plan());

    await actions().inspectBundle("/tmp/other.json", null);

    expect(portabilityIpc.portabilityInspect).toHaveBeenCalledWith("/tmp/other.json", null);
    expect(importState().srcPath).toBe("/tmp/other.json");
  });

  it("a re-inspect invalidates the previous apply's report", async () => {
    portabilityIpc.portabilityInspect.mockResolvedValue(plan({ header: SEALED_HEADER }));
    portabilityIpc.portabilityImport.mockResolvedValue(RESULT);
    await actions().unsealImport("right one");
    await actions().applyImport("right one");
    expect(importState().result).toEqual(RESULT);

    await actions().unsealImport("right one");

    // The report described a plan that has just been replaced; leaving it up would credit this
    // inspect with an import it did not do.
    expect(importState().result).toBeNull();
  });
});

/* ────────────────────────────── the choices ────────────────────────────────── */

describe("the per-item choices", () => {
  beforeEach(async () => {
    portabilityIpc.pickBundleSource.mockResolvedValue("/tmp/b.json");
    portabilityIpc.portabilityInspect.mockResolvedValue(plan());
    await actions().chooseImportFile();
  });

  it("records an override per item id", () => {
    actions().setImportAction("c1", "skip");
    actions().setImportAction("e1", "create");
    expect(importState().overrides).toEqual({ c1: "skip", e1: "create" });
  });

  it("replaces an override rather than accumulating", () => {
    actions().setImportAction("c1", "skip");
    actions().setImportAction("c1", "update");
    expect(importState().overrides).toEqual({ c1: "update" });
  });

  it("clears every override, going back to the plan's own defaults", () => {
    actions().setImportAction("c1", "skip");
    actions().clearImportActions();
    expect(importState().overrides).toEqual({});
    // The plan is untouched, which is what "back to the defaults" means: the defaults live in
    // the plan, not in a second copy here.
    expect(importState().plan?.items[0].action).toBe("create");
  });

  it("toggles the overwrite-existing-secrets flag both ways", () => {
    actions().setOverwriteExistingSecrets(true);
    expect(importState().overwriteExistingSecrets).toBe(true);
    actions().setOverwriteExistingSecrets(false);
    expect(importState().overwriteExistingSecrets).toBe(false);
  });
});

/* ─────────────────────────────── apply ────────────────────────────────────── */

describe("applyImport", () => {
  beforeEach(async () => {
    portabilityIpc.pickBundleSource.mockResolvedValue("/tmp/b.json");
    portabilityIpc.portabilityInspect.mockResolvedValue(plan());
    await actions().chooseImportFile();
  });

  it("sends the file, the passphrase and the choices, and keeps Rust's report", async () => {
    portabilityIpc.portabilityImport.mockResolvedValue(RESULT);
    actions().setImportAction("c1", "skip");

    const result = await actions().applyImport(null);

    expect(portabilityIpc.portabilityImport).toHaveBeenCalledWith("/tmp/b.json", null, {
      actions: { c1: "skip" },
      overwriteExistingSecrets: false,
      forceReadOnly: true,
    });
    expect(result).toEqual(RESULT);
    expect(importState().result).toEqual(RESULT);
    expect(importState().error).toBeNull();
    expect(importState().busy).toBe(false);
  });

  it("sends ONLY the overrides — an untouched item travels as absent, not as its default", async () => {
    portabilityIpc.portabilityImport.mockResolvedValue(RESULT);
    actions().setImportAction("c1", "skip");

    await actions().applyImport(null);

    // `types.ts`: "Absent means use the plan's default". Resolving every item's default into
    // this map would turn a later change in Rust's default into a silent no-op.
    const choices = portabilityIpc.portabilityImport.mock.calls[0][2] as {
      actions: Record<string, string>;
    };
    expect(Object.keys(choices.actions)).toEqual(["c1"]);
    expect(choices.actions.e1).toBeUndefined();
  });

  it("sends `overwriteExistingSecrets: false` by DEFAULT, and true only when asked", async () => {
    portabilityIpc.portabilityImport.mockResolvedValue(RESULT);

    await actions().applyImport(null);
    expect(portabilityIpc.portabilityImport).toHaveBeenLastCalledWith("/tmp/b.json", null, {
      actions: {},
      overwriteExistingSecrets: false,
      forceReadOnly: true,
    });

    actions().setOverwriteExistingSecrets(true);
    await actions().applyImport(null);
    expect(portabilityIpc.portabilityImport).toHaveBeenLastCalledWith("/tmp/b.json", null, {
      actions: {},
      overwriteExistingSecrets: true,
      forceReadOnly: true,
    });
  });

  it("passes a sealed bundle's passphrase as an argument, and stores none of it", async () => {
    const PASSPHRASE = "correct-horse-battery-staple";
    portabilityIpc.portabilityImport.mockResolvedValue(RESULT);

    await actions().applyImport(PASSPHRASE);

    expect(portabilityIpc.portabilityImport).toHaveBeenCalledWith(
      "/tmp/b.json",
      PASSPHRASE,
      { actions: {}, overwriteExistingSecrets: false, forceReadOnly: true },
    );
    expect(wholeStore()).not.toContain(PASSPHRASE);
  });

  it("is busy while the import is in flight", async () => {
    const apply = deferred<ImportResult>();
    portabilityIpc.portabilityImport.mockReturnValue(apply.promise);

    const running = actions().applyImport(null);
    expect(importState().busy).toBe(true);

    apply.resolve(RESULT);
    await running;
    expect(importState().busy).toBe(false);
  });

  it("maps a failure to one sentence, resolves null, and keeps the review intact", async () => {
    actions().setImportAction("c1", "skip");
    portabilityIpc.portabilityImport.mockRejectedValue("io: /tmp/b.json: permission denied");

    const result = await actions().applyImport(null);

    expect(result).toBeNull();
    expect(importState().error).toBe(describePortabilityError("io"));
    expect(importState().error).not.toContain("/tmp/b.json");
    // A failed apply is retryable — re-reviewing an untrusted config from scratch is not a
    // reasonable thing to ask twice.
    expect(importState().overrides).toEqual({ c1: "skip" });
    expect(importState().plan).toEqual(plan());
    expect(importState().result).toBeNull();
  });

  it("does nothing at all without a file", async () => {
    resetStore();
    expect(await actions().applyImport(null)).toBeNull();
    expect(portabilityIpc.portabilityImport).not.toHaveBeenCalled();
  });

  it("re-arms both load-once gates AND re-reads the DB store, so the import is visible", async () => {
    // The seam's failure mode, spelled out: Rust has just rewritten `db-connections.json`
    // and `api-store.json` underneath two slices whose gates say they are current, so without
    // this a successful import shows the user nothing until they restart.
    useAppStore.getState().dbActions.hydrateDbStore([], { connections: [], version: 1 });
    useAppStore.getState().apiActions.hydrateApiStore({
      collections: [],
      environments: [],
      activeEnvironmentId: null,
      folders: [],
    });
    expect(useAppStore.getState().dbLoaded).toBe(true);
    expect(useAppStore.getState().apiStoreLoaded).toBe(true);
    portabilityIpc.portabilityImport.mockResolvedValue(RESULT);

    await actions().applyImport(null);
    // The re-read is fire-and-forget in the wrapper; let it settle.
    await Promise.resolve();
    await Promise.resolve();

    // The API/Vault panels own their own loader (a component effect), so the re-armed flag is
    // all this slice can do for them.
    expect(useAppStore.getState().apiStoreLoaded).toBe(false);
    // The DB panel may be mounted right now, and its load runs on mount — so the gate is
    // re-armed AND the read is re-issued.
    expect(dbIpc.dbConnectionsLoad).toHaveBeenCalledTimes(1);
    expect(dbIpc.dbEngines).toHaveBeenCalledTimes(1);
  });

  it("does NOT disturb the load-once gates when the import failed", async () => {
    useAppStore.getState().dbActions.hydrateDbStore([], { connections: [], version: 1 });
    portabilityIpc.portabilityImport.mockRejectedValue("tampered");

    await actions().applyImport(null);

    // Nothing was written, so there is nothing to re-read — and re-reading would throw away a
    // loaded store to replace it with an identical one.
    expect(useAppStore.getState().dbLoaded).toBe(true);
    expect(dbIpc.dbConnectionsLoad).not.toHaveBeenCalled();
  });
});

describe("resetImport", () => {
  it("forgets the file, the plan, the choices and the report", async () => {
    portabilityIpc.pickBundleSource.mockResolvedValue("/tmp/b.json");
    portabilityIpc.portabilityInspect.mockResolvedValue(plan());
    portabilityIpc.portabilityImport.mockResolvedValue(RESULT);
    await actions().chooseImportFile();
    actions().setImportAction("c1", "skip");
    actions().setOverwriteExistingSecrets(true);
    actions().setImportForceReadOnly(false);
    await actions().applyImport(null);

    actions().resetImport();

    expect(importState()).toEqual({
      srcPath: null,
      plan: null,
      busy: false,
      error: null,
      overrides: {},
      // Back to the SAFE value — a "start over" that kept the overwrite flag on would be a
      // security default that erodes with use.
      overwriteExistingSecrets: false,
      // 🔴 Same property, and the test sets it to `false` above precisely so this line means
      // something: reset must restore read-only, not carry the last import's choice forward.
      forceReadOnly: true,
      result: null,
    });
  });
});
