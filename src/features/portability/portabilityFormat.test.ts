/**
 * Tests for `portabilityFormat` — every decision and every sentence the config-bundle dialogs
 * make.
 *
 * ── Every expectation is written out ─────────────────────────────────────────
 * Nothing below reads its expected value from `portabilityFormat.ts` or from
 * `portabilityFixtures.ts`. The fixtures are inputs; the strings are typed
 * here by hand. That is the difference between "the formatter agrees with itself" and
 * "the formatter produces this sentence".
 *
 * ── The copy is tested as behaviour, not as a snapshot ───────────────────────
 * For the two sentences the design depends on — the passphrase truth and the unverified
 * provenance note — the assertions pin the *clauses that carry the meaning* and, just as
 * importantly, assert the reassuring vocabulary is ABSENT. A snapshot would notice an
 * edit; only a negative assertion notices someone quietly making the copy comfortable,
 * which is the failure mode the passphrase copy is guarding against.
 */

import { describe, expect, it } from "vitest";

import {
  ACTION_CHOICES,
  DEFAULT_EXPORT_MODE,
  IMPORT_READ_ONLY_HINT,
  IMPORT_READ_ONLY_LABEL,
  HOSTS_INTRO,
  HOSTS_NONE,
  KDF_NOTE,
  KIND_ORDER,
  MODE_CHOICES,
  OVERWRITE_HINT,
  OVERWRITE_LABEL,
  PASSPHRASE_ADVICE,
  PASSPHRASE_TRUTH,
  PICK_FILE_NOTE,
  REDACTED_HEADER_NOTE,
  SEALED_LOCKED_NOTE,
  UNVERIFIED_NOTE,
  WITHHELD_INTRO,
  WITHHELD_NONE,
  actionLabel,
  describeChange,
  describeCounts,
  describeResult,
  describeSecretValues,
  describeSelection,
  effectiveAction,
  exportBlockedReason,
  formatMegabytes,
  formatTimestamp,
  groupPlanItems,
  hostsSummary,
  initialSelection,
  itemDomId,
  joinClauses,
  kindLabel,
  modeBlurb,
  needsPassphrase,
  overrideActions,
  passphraseState,
  plural,
  provenanceSentence,
  selectionCounts,
  toExportOptions,
  toggleId,
  variableSummary,
  withheldVariableNames,
  type ExportSource,
} from "./portabilityFormat";
import {
  BARE_PLAN,
  EMPTY_EXPORT_SOURCE,
  LOCKED_PLAN,
  MIXED_RESULT,
  NOTHING_TO_DO_PLAN,
  NO_CHANGE_RESULT,
  RICH_PLAN,
  SEALED_HEADER,
  STRUCTURE_HEADER,
  TEST_EXPORT_SOURCE,
  UNLABELLED_HEADER,
} from "./portabilityFixtures";
import type { BundleCounts, BundleMode, ImportCounts, ImportItem } from "./types";

/** A tiny helper for count literals, so a test only writes the fields it cares about. */
function counts(over: Partial<BundleCounts> = {}): BundleCounts {
  return {
    dbConnections: 0,
    dbQueries: 0,
    apiRequests: 0,
    environments: 0,
    referencedVariables: 0,
    secretValues: 0,
    ...over,
  };
}

/** The import-result flavour: five real fields, no `referencedVariables`. See `ImportCounts`. */
function importCounts(over: Partial<ImportCounts> = {}): ImportCounts {
  return {
    dbConnections: 0,
    dbQueries: 0,
    apiRequests: 0,
    environments: 0,
    variables: 0,
    ...over,
  };
}

/* ═══════════════════════════ the default mode ════════════════════════════ */

describe("the mode choice", () => {
  it("defaults to structure — the safe mode", () => {
    expect(DEFAULT_EXPORT_MODE).toBe("structure");
  });

  it("offers exactly two modes, structure first, and never a plaintext-secrets mode", () => {
    expect(MODE_CHOICES.map((c) => c.value)).toEqual(["structure", "sealed"]);
  });

  it("says of structure mode that values stay behind and the file is safe to paste", () => {
    const blurb = modeBlurb("structure");
    expect(blurb).toContain("every secret value stays on this machine");
    expect(blurb).toContain("Safe to paste in Slack");
    expect(blurb).toContain("the recipient supplies their own passwords");
  });

  it("says of sealed mode that the secrets are inside and the passphrase travels apart", () => {
    const blurb = modeBlurb("sealed");
    expect(blurb).toContain("with your secret values inside");
    expect(blurb).toContain("a passphrase you send separately");
    expect(blurb).toContain("Anyone who has both the file and the passphrase has your credentials");
  });

  it("returns an empty blurb for a mode it does not know, rather than throwing", () => {
    // A third mode cannot exist today (`BundleMode` is a two-member union, and a mode that
    // writes secrets in the clear is ruled out), so this is the total-function guarantee,
    // exercised by force.
    expect(modeBlurb("plaintext" as BundleMode)).toBe("");
  });
});

/* ═══════════════════════════ the passphrase ══════════════════════════════ */

describe("the passphrase copy — the most important text in this feature", () => {
  it("says the guessing is offline and unlimited", () => {
    expect(PASSPHRASE_TRUTH).toContain("Encryption does not make a weak passphrase safe");
    expect(PASSPHRASE_TRUTH).toContain("guess at the passphrase offline");
    expect(PASSPHRASE_TRUTH).toContain("nothing here to slow them down or lock them out");
  });

  it("never reassures: no cipher names, no strength adjectives, no iteration count", () => {
    // The failure mode this copy exists to prevent is a dialog that implies encryption
    // alone is enough. These words are how that implication gets made.
    for (const banned of [
      "secure",
      "military",
      "unbreakable",
      "uncrackable",
      "AES",
      "600,000",
      "600000",
    ]) {
      expect(PASSPHRASE_TRUTH.toLowerCase()).not.toContain(banned.toLowerCase());
      expect(PASSPHRASE_ADVICE.toLowerCase()).not.toContain(banned.toLowerCase());
    }
  });

  it("tells the user to send the passphrase through another channel", () => {
    expect(PASSPHRASE_ADVICE).toContain("several random words");
    expect(PASSPHRASE_ADVICE).toContain("different channel than the file");
  });

  it("states the KDF limitation without hard-coding an iteration count", () => {
    expect(KDF_NOTE).toContain("PBKDF2-HMAC-SHA256");
    expect(KDF_NOTE).toContain("weaker against GPU cracking");
    expect(KDF_NOTE).toContain("the passphrase, not the algorithm");
    // The only digits allowed are the ones inside the algorithm's name. An iteration
    // count here would be a second copy of a number that lives in Rust and travels
    // inside the file — free to drift, and meaningless to the reader either way.
    expect(KDF_NOTE.replace("PBKDF2-HMAC-SHA256", "")).not.toMatch(/[0-9]/);
  });
});

describe("passphraseState", () => {
  it("says nothing at all while the box is still empty", () => {
    expect(passphraseState("", "")).toEqual({ ok: false, message: null });
  });

  it("counts up to the 12-character floor instead of scoring strength", () => {
    expect(passphraseState("short", "short")).toEqual({
      ok: false,
      message: "At least 12 characters — 7 more to go.",
    });
    expect(passphraseState("elevenchars", "")).toEqual({
      ok: false,
      message: "At least 12 characters — 1 more to go.",
    });
  });

  it("rejects a mismatch once the length is satisfied", () => {
    expect(passphraseState("correct horse battery", "correct horse batteru")).toEqual({
      ok: false,
      message: "The two passphrases do not match.",
    });
  });

  it("accepts a matching pair at exactly twelve characters — the floor is inclusive", () => {
    expect("twelvechars!".length).toBe(12);
    expect(passphraseState("twelvechars!", "twelvechars!")).toEqual({ ok: true, message: null });
  });
});

/* ═══════════════════════════ selection & counts ══════════════════════════ */

describe("selection", () => {
  it("starts with everything ticked", () => {
    expect(initialSelection(TEST_EXPORT_SOURCE)).toEqual({
      dbConnectionIds: ["conn-warehouse", "conn-cache", "conn-scratch"],
      apiRequestIds: ["req-charge", "req-health"],
      environmentIds: ["env-staging", "env-local"],
    });
  });

  it("starts empty when there is nothing to export", () => {
    expect(initialSelection(EMPTY_EXPORT_SOURCE)).toEqual({
      dbConnectionIds: [],
      apiRequestIds: [],
      environmentIds: [],
    });
  });

  it("toggles an id in and out, preserving order", () => {
    expect(toggleId(["a", "b", "c"], "b")).toEqual(["a", "c"]);
    expect(toggleId(["a", "c"], "b")).toEqual(["a", "c", "b"]);
  });
});

describe("selectionCounts", () => {
  it("counts what is ticked and dedupes a variable named in two environments", () => {
    // SHARED_TOKEN is in both environments; PG_PASSWORD, UNSET_WEBHOOK, ALPHA_KEY once
    // each — four distinct names, three of which have a value somewhere.
    expect(selectionCounts(TEST_EXPORT_SOURCE, initialSelection(TEST_EXPORT_SOURCE))).toEqual({
      dbConnections: 3,
      apiRequests: 2,
      environments: 2,
      variables: 4,
      variablesWithValue: 3,
    });
  });

  it("counts only the ticked environments' variables", () => {
    expect(
      selectionCounts(TEST_EXPORT_SOURCE, {
        dbConnectionIds: ["conn-cache"],
        apiRequestIds: [],
        environmentIds: ["env-local"],
      }),
    ).toEqual({
      dbConnections: 1,
      apiRequests: 0,
      environments: 1,
      variables: 2,
      variablesWithValue: 1,
    });
  });

  it("treats a variable as carrying a value when ANY environment holds one", () => {
    // Order matters to the fold, so this source puts the EMPTY copy first — the case
    // `TEST_EXPORT_SOURCE` cannot reach, because there staging (which has the value)
    // comes first.
    const emptyFirst: ExportSource = {
      dbConnections: [],
      apiRequests: [],
      environments: [
        { id: "a", name: "a", variables: [{ key: "TOKEN", hasValue: false }] },
        { id: "b", name: "b", variables: [{ key: "TOKEN", hasValue: true }] },
      ],
    };
    const all = initialSelection(emptyFirst);
    expect(selectionCounts(emptyFirst, all).variables).toBe(1);
    expect(selectionCounts(emptyFirst, all).variablesWithValue).toBe(1);
  });

  it("ignores ids that are no longer in the source", () => {
    expect(
      selectionCounts(TEST_EXPORT_SOURCE, {
        dbConnectionIds: ["conn-deleted-while-open"],
        apiRequestIds: ["req-deleted"],
        environmentIds: ["env-deleted"],
      }),
    ).toEqual({
      dbConnections: 0,
      apiRequests: 0,
      environments: 0,
      variables: 0,
      variablesWithValue: 0,
    });
  });
});

describe("plural and joinClauses", () => {
  it("uses the singular for exactly one", () => {
    expect(plural(1, "variable", "variables")).toBe("1 variable");
    expect(plural(0, "variable", "variables")).toBe("0 variables");
    expect(plural(2, "variable", "variables")).toBe("2 variables");
  });

  it("reads as a sentence at every length", () => {
    expect(joinClauses([])).toBe("");
    expect(joinClauses(["one thing"])).toBe("one thing");
    expect(joinClauses(["a", "b"])).toBe("a and b");
    expect(joinClauses(["a", "b", "c"])).toBe("a, b and c");
  });
});

describe("describeSelection", () => {
  it("names each kind and the variables it references", () => {
    expect(describeSelection(selectionCounts(TEST_EXPORT_SOURCE, initialSelection(TEST_EXPORT_SOURCE)))).toBe(
      "3 database connections, 2 requests and 2 environments, referencing 4 variables.",
    );
  });

  it("uses singulars and drops the variables clause when there are none", () => {
    expect(
      describeSelection({
        dbConnections: 1,
        apiRequests: 0,
        environments: 0,
        variables: 0,
        variablesWithValue: 0,
      }),
    ).toBe("1 database connection.");
  });

  it("uses the singular for one environment and one variable", () => {
    expect(
      describeSelection({
        dbConnections: 0,
        apiRequests: 1,
        environments: 1,
        variables: 1,
        variablesWithValue: 1,
      }),
    ).toBe("1 request and 1 environment, referencing 1 variable.");
  });

  it("says so when nothing is ticked", () => {
    expect(
      describeSelection({
        dbConnections: 0,
        apiRequests: 0,
        environments: 0,
        variables: 0,
        variablesWithValue: 0,
      }),
    ).toBe("This bundle would be empty.");
  });
});

/* ═══════════════════════ what structure mode withholds ═══════════════════ */

describe("withheldVariableNames — the preventable support complaint", () => {
  it("lists, sorted, only the names whose value this machine actually holds", () => {
    // UNSET_WEBHOOK has no value, so nothing about it is being withheld; SHARED_TOKEN
    // appears once despite being in two environments.
    expect(withheldVariableNames(TEST_EXPORT_SOURCE, initialSelection(TEST_EXPORT_SOURCE))).toEqual([
      "ALPHA_KEY",
      "PG_PASSWORD",
      "SHARED_TOKEN",
    ]);
  });

  it("skips environments that are not ticked", () => {
    expect(
      withheldVariableNames(TEST_EXPORT_SOURCE, {
        dbConnectionIds: [],
        apiRequestIds: [],
        environmentIds: ["env-local"],
      }),
    ).toEqual(["ALPHA_KEY"]);
  });

  it("is empty when no ticked environment holds a value", () => {
    expect(
      withheldVariableNames(TEST_EXPORT_SOURCE, {
        dbConnectionIds: ["conn-cache"],
        apiRequestIds: [],
        environmentIds: [],
      }),
    ).toEqual([]);
  });

  it("has copy that tells the recipient they must supply each one", () => {
    expect(WITHHELD_INTRO).toContain("NOT in the file");
    expect(WITHHELD_INTRO).toContain("supply each one before this config works");
    expect(WITHHELD_NONE).toContain("Nothing is being withheld");
    expect(REDACTED_HEADER_NOTE).toContain("{{REDACTED — supply this value}}");
    expect(REDACTED_HEADER_NOTE).toContain("fails loudly");
  });
});

/* ═══════════════════════════ the export gate ════════════════════════════ */

describe("exportBlockedReason", () => {
  const full = selectionCounts(TEST_EXPORT_SOURCE, initialSelection(TEST_EXPORT_SOURCE));
  const none = selectionCounts(TEST_EXPORT_SOURCE, {
    dbConnectionIds: [],
    apiRequestIds: [],
    environmentIds: [],
  });

  it("blocks an empty bundle in either mode", () => {
    expect(exportBlockedReason("structure", none, "", "")).toBe(
      "Choose at least one thing to include.",
    );
    expect(exportBlockedReason("sealed", none, "a long enough passphrase", "a long enough passphrase")).toBe(
      "Choose at least one thing to include.",
    );
  });

  it("allows a structure export with no passphrase at all", () => {
    expect(exportBlockedReason("structure", full, "", "")).toBeNull();
  });

  it("asks for a passphrase in sealed mode", () => {
    expect(exportBlockedReason("sealed", full, "", "")).toBe(
      "Enter a passphrase to seal this bundle.",
    );
  });

  it("blocks a sealed export below the 12-character floor", () => {
    expect(exportBlockedReason("sealed", full, "tooshort", "tooshort")).toBe(
      "At least 12 characters — 4 more to go.",
    );
  });

  it("blocks a sealed export whose confirmation does not match", () => {
    expect(exportBlockedReason("sealed", full, "correct horse battery", "typo horse battery")).toBe(
      "The two passphrases do not match.",
    );
  });

  it("allows a sealed export once the pair is long and matching", () => {
    expect(exportBlockedReason("sealed", full, "correct horse battery", "correct horse battery")).toBeNull();
  });
});

describe("toExportOptions", () => {
  const selection = {
    dbConnectionIds: ["conn-cache"],
    apiRequestIds: [],
    environmentIds: ["env-local"],
  };

  it("always sends explicit id arrays, because an absent array means 'all'", () => {
    const options = toExportOptions("structure", "  Team staging  ", selection, "");
    expect(options).toEqual({
      mode: "structure",
      label: "Team staging",
      dbConnectionIds: ["conn-cache"],
      apiRequestIds: [],
      environmentIds: ["env-local"],
    });
    expect("passphrase" in options).toBe(false);
  });

  it("carries the passphrase only in sealed mode", () => {
    expect(toExportOptions("sealed", "prod", selection, "correct horse battery")).toEqual({
      mode: "sealed",
      label: "prod",
      dbConnectionIds: ["conn-cache"],
      apiRequestIds: [],
      environmentIds: ["env-local"],
      passphrase: "correct horse battery",
    });
  });

  it("copies the id arrays rather than aliasing the caller's state", () => {
    const options = toExportOptions("structure", "", selection, "");
    expect(options.dbConnectionIds).not.toBe(selection.dbConnectionIds);
  });
});

/* ═══════════════════════════ describing a bundle ═════════════════════════ */

describe("formatTimestamp", () => {
  it("renders UTC, not the machine's locale", () => {
    expect(formatTimestamp(Date.UTC(2026, 6, 28, 9, 15, 0))).toBe("2026-07-28 09:15 UTC");
    expect(formatTimestamp(0)).toBe("1970-01-01 00:00 UTC");
  });
});

describe("provenanceSentence — a claim, phrased as a claim", () => {
  it("reports what the file says, and quotes its self-chosen label", () => {
    expect(provenanceSentence(STRUCTURE_HEADER)).toBe(
      'This file says it was exported by Agent Studio 0.1.0 on 2026-07-28 09:15 UTC and calls itself "Team staging DB + API".',
    );
  });

  it("omits the label clause entirely when the label is blank", () => {
    expect(provenanceSentence(UNLABELLED_HEADER)).toBe(
      "This file says it was exported by Agent Studio 0.1.0 on 2026-07-28 09:15 UTC.",
    );
  });

  it("never claims the file is verified, signed or trusted", () => {
    for (const header of [STRUCTURE_HEADER, SEALED_HEADER, UNLABELLED_HEADER]) {
      const sentence = provenanceSentence(header).toLowerCase();
      for (const banned of ["verified", "signed", "authentic", "trusted"]) {
        expect(sentence).not.toContain(banned);
      }
    }
  });

  it("has an unverified note that names the reason: no signature", () => {
    expect(UNVERIFIED_NOTE).toContain("Nothing here is verified");
    expect(UNVERIFIED_NOTE).toContain("no signature");
    expect(UNVERIFIED_NOTE).toContain("only a claim");
  });
});

describe("describeCounts / describeChange / describeSecretValues", () => {
  it("names the four content kinds, in a fixed order, with singulars", () => {
    expect(describeCounts(STRUCTURE_HEADER.counts)).toBe(
      "2 database connections, 3 saved queries, 4 requests and 1 environment",
    );
    expect(describeCounts(counts({ dbConnections: 1, dbQueries: 1 }))).toBe(
      "1 database connection and 1 saved query",
    );
  });

  it("says 'nothing' rather than an empty string", () => {
    expect(describeCounts(counts())).toBe("nothing");
    expect(describeChange(importCounts())).toBe("nothing");
  });

  it("leaves referenced variables out of the content description", () => {
    expect(describeCounts(counts({ referencedVariables: 5 }))).toBe("nothing");
  });

  it("includes variables when describing what an import CHANGED", () => {
    // `ImportCounts.variables` = variables WRITTEN. Reading `BundleCounts.referencedVariables`
    // here (which the first version did) made the receipt claim an import had written variables
    // when the number only counted names the file mentioned.
    expect(describeChange(importCounts({ apiRequests: 2, variables: 1 }))).toBe(
      "2 requests and 1 variable",
    );
    expect(describeChange(importCounts({ variables: 3 }))).toBe("3 variables");
  });

  it("reports whether the file carries values, from the header alone", () => {
    expect(describeSecretValues(STRUCTURE_HEADER.counts)).toBe("It carries no secret values.");
    expect(describeSecretValues(SEALED_HEADER.counts)).toBe("It carries 3 secret values.");
    expect(describeSecretValues(counts({ secretValues: 1 }))).toBe("It carries 1 secret value.");
  });
});

describe("the locked-bundle and file-picking copy", () => {
  it("says the header is unverified and the contents unreadable", () => {
    expect(SEALED_LOCKED_NOTE).toContain("cannot be listed until it is unlocked");
    expect(SEALED_LOCKED_NOTE).toContain("unencrypted header, which nothing verifies");
  });

  it("derives the size ceiling from MAX_BUNDLE_BYTES", () => {
    expect(formatMegabytes(8 * 1024 * 1024)).toBe("8 MB");
    expect(formatMegabytes(1024 * 1024)).toBe("1 MB");
    expect(PICK_FILE_NOTE).toContain("Nothing is written until you say so.");
    expect(PICK_FILE_NOTE).toContain("Up to 8 MB.");
  });
});

/* ═══════════════════════════ the import review ═══════════════════════════ */

describe("hostsSummary", () => {
  it("introduces the list, or says there is nothing to introduce", () => {
    expect(hostsSummary(["api.example.com"])).toBe(
      "Everything in this bundle would talk to these hosts:",
    );
    expect(hostsSummary([])).toBe("Nothing in this bundle contacts a host.");
    expect(HOSTS_INTRO).toContain("would talk to these hosts");
    expect(HOSTS_NONE).toBe("Nothing in this bundle contacts a host.");
  });
});

describe("variableSummary — the exfiltration risk, without alarm", () => {
  it("pairs 'your value' with 'their host' in one sentence", () => {
    expect(variableSummary(RICH_PLAN)).toEqual({
      total: 3,
      alreadyHeld: 2,
      message:
        "Reads 3 variables. You already have a value for 2 of them, so an imported request can read your value and send it to any host listed above.",
    });
  });

  it("says plainly when the machine holds none of them", () => {
    expect(variableSummary(NOTHING_TO_DO_PLAN)).toEqual({
      total: 1,
      alreadyHeld: 0,
      message: "Reads 1 variable. You do not have a value for any of them yet.",
    });
  });

  it("says so when the bundle references nothing", () => {
    expect(variableSummary(BARE_PLAN)).toEqual({
      total: 0,
      alreadyHeld: 0,
      message: "This bundle does not reference any variables.",
    });
  });

  it("does not editorialise — no alarm words", () => {
    for (const plan of [RICH_PLAN, NOTHING_TO_DO_PLAN, BARE_PLAN]) {
      const message = variableSummary(plan).message.toLowerCase();
      for (const banned of ["danger", "warning", "malicious", "attack", "!"]) {
        expect(message).not.toContain(banned);
      }
    }
  });
});

describe("needsPassphrase", () => {
  it("is derived from the plan, never from an error string", () => {
    expect(needsPassphrase(LOCKED_PLAN)).toBe(true);
    expect(needsPassphrase(RICH_PLAN)).toBe(false);
  });
});

describe("grouping and per-item actions", () => {
  it("names every kind", () => {
    expect(KIND_ORDER).toEqual([
      "dbConnection",
      "dbQuery",
      "apiRequest",
      "environment",
      "variable",
    ]);
    expect(kindLabel("dbConnection")).toBe("Database connections");
    expect(kindLabel("dbQuery")).toBe("Saved queries");
    expect(kindLabel("apiRequest")).toBe("API requests");
    expect(kindLabel("environment")).toBe("Environments");
    expect(kindLabel("variable")).toBe("Variables");
  });

  it("groups into a fixed order and drops the kinds that are absent", () => {
    const groups = groupPlanItems(RICH_PLAN.items);
    expect(groups.map((g) => g.kind)).toEqual([
      "dbConnection",
      "dbQuery",
      "apiRequest",
      "environment",
      "variable",
    ]);
    expect(groups[0].items.map((i) => i.id)).toEqual(["conn-warehouse", "conn-analytics"]);
    expect(groupPlanItems(BARE_PLAN.items).map((g) => g.label)).toEqual(["Saved queries"]);
    expect(groupPlanItems([])).toEqual([]);
  });

  it("offers all three actions, labelled", () => {
    expect(ACTION_CHOICES).toEqual(["create", "update", "skip"]);
    expect(actionLabel("create")).toBe("Create");
    expect(actionLabel("update")).toBe("Update");
    expect(actionLabel("skip")).toBe("Skip");
  });

  it("falls back to the plan's own action when the user has not overridden it", () => {
    const item: ImportItem = {
      kind: "dbConnection",
      id: "conn-warehouse",
      label: "warehouse",
      action: "update",
      reason: "exists",
    };
    expect(effectiveAction(item, {})).toBe("update");
    expect(effectiveAction(item, { "conn-warehouse": "skip" })).toBe("skip");
  });

  it("sends back only the choices that actually differ from the plan", () => {
    expect(
      overrideActions(RICH_PLAN.items, {
        // Same as the plan's default → must NOT be sent; an echo would be
        // indistinguishable from a decision.
        "conn-warehouse": "update",
        // A real override.
        "conn-analytics": "skip",
        // An id that is not in this plan at all → ignored.
        "conn-from-another-file": "create",
      }),
    ).toEqual({ "conn-analytics": "skip" });
  });

  it("sends an empty record when nothing was touched", () => {
    expect(overrideActions(RICH_PLAN.items, {})).toEqual({});
  });

  it("keys a row on kind AND id, because the two share an id space", () => {
    expect(
      itemDomId({
        kind: "variable",
        id: "PROD_STRIPE_KEY",
        label: "PROD_STRIPE_KEY",
        action: "skip",
        reason: "held",
      }),
    ).toBe("portability-item-variable-PROD_STRIPE_KEY");
  });
});

describe("the overwrite switch and the read-only guardrail", () => {
  it("labels the switch by what turning it ON does", () => {
    expect(OVERWRITE_LABEL).toBe("Let incoming values replace secrets I already have");
    expect(OVERWRITE_HINT).toContain("Off: variables you already have a value for keep your value");
    expect(OVERWRITE_HINT).toContain("On: the bundle's value replaces yours");
    expect(OVERWRITE_HINT).toContain("very hard to trace back to an import");
  });

  it("describes the read-only toggle in BOTH positions, and says what OFF costs", () => {
    // This used to assert a sentence claiming connections arrive read-only
    // "whatever the file says" — true when the value was forced, and false now that the checkbox
    // beside it can switch it off. Copy that describes a behaviour the UI no longer has is worse
    // than no copy.
    expect(IMPORT_READ_ONLY_LABEL).toBe("Import connections as read-only");
    expect(IMPORT_READ_ONLY_HINT).toContain("On (default)");
    expect(IMPORT_READ_ONLY_HINT).toContain("Off:");
    // The consequence has to be named, or "off" reads as a preference rather than a risk.
    expect(IMPORT_READ_ONLY_HINT).toContain("DELETE");
    // What must NOT come back is the *claim* that read-only is unconditional. Note the new copy
    // legitimately says a connection "keeps whatever the file says" — that is the OFF position
    // described accurately, so forbidding the phrase outright would fail against correct copy.
    // The forbidden thing is the old promise, not the words in it.
    expect(IMPORT_READ_ONLY_HINT).not.toContain("read-only whatever the file says");
  });
});

describe("describeResult", () => {
  it("reads as one sentence across created, updated and skipped", () => {
    expect(describeResult(MIXED_RESULT)).toBe(
      "Created 1 database connection, 1 saved query, 1 request and 2 variables, updated 1 environment and skipped 1 variable.",
    );
  });

  it("says nothing changed rather than printing three empty clauses", () => {
    expect(describeResult(NO_CHANGE_RESULT)).toBe("Nothing was changed.");
  });

  it("omits the clauses that did not happen", () => {
    expect(
      describeResult({
        created: importCounts(),
        updated: importCounts({ apiRequests: 2 }),
        skipped: importCounts(),
        notices: [],
      }),
    ).toBe("updated 2 requests.");
  });
});
