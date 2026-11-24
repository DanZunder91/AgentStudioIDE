/**
 * Tests for the database client's connection-dialog logic.
 *
 * ── Expectations are never read from the table under test ───────────────────
 * `engineFieldRows` is a function *over a data table*, which is exactly the shape that
 * invites the trap: `expect(rows.map(r => r.key)).toEqual([...common, ...spec.extraFields.map(f => f.key)])`
 * reads its expectation from the same descriptor the code reads, passes forever, and
 * cannot fail on a wrong value. So every expectation below is **written out literally**
 * — the fixtures are inputs only. Renaming `readPreference` in `dbFixtures.ts` must
 * break a test here, and it does.
 *
 * Everything in `engineFields.ts` is DOM-free, so this file needs no renderer: the
 * risky logic (validation messages, the engine-switch preservation rule, secret
 * redaction, the focus-trap arithmetic) is pinned directly rather than through a
 * component that could mask it.
 */

import { describe, expect, it, vi } from "vitest";

import {
  AWKWARD_ENGINE,
  MONGODB_ENGINE,
  POSTGRES_ENGINE,
  REDIS_ENGINE,
  TEST_ENGINES,
} from "./dbFixtures";
import {
  canonicalScheme,
  PASSWORD_MOVED_NOTICE,
  URL_DERIVED_NOTE,
  URL_LITERAL_PASSWORD_NOTICE,
  URL_OVERRIDE_NOTE,
  URL_REQUIRED_ERROR,
  advancedIsDirty,
  connectMode,
  connectModeChoices,
  connectModeNote,
  driverPasswordParamCaveat,
  importUrlOverride,
  isSrv,
  passwordParamKeptNotice,
  passwordParamUnplacedNotice,
  portError,
  portTip,
  readOnlyBadgeTitle,
  SAVE_PASSWORD_CHOICES,
  SECRET_MASK,
  TEST_FAILED_FALLBACK,
  applyParsedUrl,
  describeEngineSwitch,
  setConnectMode,
  setUrlText,
  srvPortHint,
  srvScheme,
  urlHasLiteralPassword,
  urlHint,
  describeTestResult,
  engineFieldRows,
  errorMessage,
  errorSummary,
  fieldDomId,
  firstErrorDomId,
  firstErrorKey,
  hasBlockingErrors,
  initialEngine,
  initialNotices,
  newDraft,
  raceTestTimeout,
  readOnlyNote,
  redactSecret,
  removeOption,
  savePasswordHint,
  setRowValue,
  switchEngine,
  tabWrapTarget,
  timeoutResult,
  toRecord,
  unmodelledOptionKeys,
  validateDraft,
  wholeNumber,
  type DbDraft,
} from "./engineFields";
import type { DbTestResult, EngineSpec, ParsedUrl } from "./types";

/** A draft for `spec` with the fields a test cares about overridden. */
function draftFor(spec: EngineSpec, over: Partial<DbDraft> = {}): DbDraft {
  return { ...newDraft(spec, null), name: "Prod", host: "db.internal", ...over };
}

const keysOf = (spec: EngineSpec, draft: DbDraft = draftFor(spec)): string[] =>
  engineFieldRows(spec, draft).map((r) => r.key);

/* ═══════════════════════ the per-engine field list ═══════════════════════ */

describe("engineFieldRows", () => {
  it("renders PostgreSQL's common fields then its extras, in that order", () => {
    // Literal, NOT derived from POSTGRES_ENGINE.extraFields.
    expect(keysOf(POSTGRES_ENGINE)).toEqual([
      "name",
      "host",
      "port",
      "database",
      "user",
      "sslMode",
      "applicationName",
      "searchPath",
      "connectTimeout",
    ]);
  });

  it("grows a different form for MongoDB from the same code path", () => {
    expect(keysOf(MONGODB_ENGINE)).toEqual([
      "name",
      "host",
      "port",
      "database",
      "user",
      "sslMode",
      "authSource",
      "replicaSet",
      "readPreference",
      "directConnection",
    ]);
  });

  it("hides the user field when the engine does not authenticate with one", () => {
    expect(keysOf(REDIS_ENGINE)).toEqual([
      "name",
      "host",
      "port",
      "database",
      "sslMode",
      "clientName",
    ]);
    expect(keysOf(REDIS_ENGINE)).not.toContain("user");
  });

  it("renames the database field from the descriptor", () => {
    const row = engineFieldRows(REDIS_ENGINE, draftFor(REDIS_ENGINE)).find(
      (r) => r.key === "database",
    );
    expect(row?.label).toBe("Database index");
  });

  it("hides the database field entirely when databaseLabel is null", () => {
    expect(keysOf(AWKWARD_ENGINE)).not.toContain("database");
  });

  it("hides the SSL select rather than offering an empty one", () => {
    expect(keysOf(AWKWARD_ENGINE)).not.toContain("sslMode");
    expect(keysOf(AWKWARD_ENGINE)).toEqual(["name", "host", "port", "user", "mode"]);
  });

  it("offers exactly the engine's SSL modes as the select's choices", () => {
    const rows = engineFieldRows(POSTGRES_ENGINE, draftFor(POSTGRES_ENGINE));
    const ssl = rows.find((r) => r.key === "sslMode");
    expect(ssl?.kind).toBe("select");
    expect(ssl?.choices).toEqual(["disable", "prefer", "require", "verify-ca", "verify-full"]);
    expect(engineFieldRows(REDIS_ENGINE, draftFor(REDIS_ENGINE)).find((r) => r.key === "sslMode")
      ?.choices).toEqual(["disable", "require"]);
  });

  it("carries the descriptor's label, kind, placeholder, requiredness and hint onto the row", () => {
    const rows = engineFieldRows(MONGODB_ENGINE, draftFor(MONGODB_ENGINE));
    const authSource = rows.find((r) => r.key === "authSource");
    expect(authSource).toMatchObject({
      scope: "option",
      label: "Auth source",
      kind: "text",
      placeholder: "admin",
      required: true,
      tip: "The database that holds the user — usually `admin`, not the one you query.",
    });
    const readPreference = rows.find((r) => r.key === "readPreference");
    expect(readPreference?.kind).toBe("select");
    expect(readPreference?.choices).toEqual([
      "primary",
      "primaryPreferred",
      "secondary",
      "secondaryPreferred",
      "nearest",
    ]);
    expect(rows.find((r) => r.key === "directConnection")?.kind).toBe("checkbox");
  });

  it("takes an option row's value from the draft, and empty string when unset", () => {
    const draft = draftFor(MONGODB_ENGINE, { options: { replicaSet: "rs0" } });
    const rows = engineFieldRows(MONGODB_ENGINE, draft);
    expect(rows.find((r) => r.key === "replicaSet")?.value).toBe("rs0");
    expect(rows.find((r) => r.key === "authSource")?.value).toBe("");
  });

  /* ── the port, which must NOT arrive pre-filled ── */

  it("shows the descriptor's default port as a PLACEHOLDER and never as a value", () => {
    // 🔴 The bug: the box used to open holding `5432`, which was then persisted and emitted
    // into every string. An Atlas URI got `:27017` the user never typed, and a
    // `mongodb+srv://` URI may not carry a port at all.
    const port = (spec: EngineSpec) =>
      engineFieldRows(spec, newDraft(spec, null)).find((r) => r.key === "port");
    expect(port(POSTGRES_ENGINE)?.value).toBe("");
    expect(port(POSTGRES_ENGINE)?.placeholder).toBe("5432");
    expect(port(MONGODB_ENGINE)?.value).toBe("");
    expect(port(MONGODB_ENGINE)?.placeholder).toBe("27017");
    // And it is no longer `required`: empty means "the driver's default".
    expect(port(POSTGRES_ENGINE)?.required).toBe(false);
    expect(port(POSTGRES_ENGINE)?.tip).toBe("Leave empty for 5432, this engine's default.");
  });

  it("disables the port and calls it INVALID — not merely unnecessary — for a DNS seed list", () => {
    const rows = engineFieldRows(MONGODB_ENGINE, draftFor(MONGODB_ENGINE, { srv: true }));
    const port = rows.find((r) => r.key === "port");
    expect(port?.disabled).toBe(true);
    expect(port?.hint).toBe("A `mongodb+srv://` URI must not carry a port — DNS supplies it.");
    // Nothing else is disabled: SRV is about the port, not about the form.
    expect(rows.filter((r) => r.disabled).map((r) => r.key)).toEqual(["port"]);
  });

  it("makes every control but Name inert in URL-only mode", () => {
    // The fields are read-only echoes. A field that silently stops mattering is the trap;
    // an inert one that says the URL governs is the fix. Name is ours, not the URL's.
    const rows = engineFieldRows(
      POSTGRES_ENGINE,
      draftFor(POSTGRES_ENGINE, { url: "postgresql://ro@h/db" }),
    );
    expect(rows.filter((r) => !r.disabled).map((r) => r.key)).toEqual(["name"]);
  });

  /* ── progressive disclosure: which rows are basic, which advanced ── */

  it("splits the form on the DESCRIPTOR's requiredness, not on a per-engine list", () => {
    const groups = (spec: EngineSpec) =>
      engineFieldRows(spec, draftFor(spec)).map((r) => [r.key, r.group]);
    expect(groups(POSTGRES_ENGINE)).toEqual([
      ["name", "basic"],
      ["host", "basic"],
      ["port", "basic"],
      ["database", "basic"],
      ["user", "basic"],
      ["sslMode", "advanced"],
      ["applicationName", "advanced"],
      ["searchPath", "advanced"],
      ["connectTimeout", "advanced"],
    ]);
    // Mongo's `authSource` is `required: true`, so it stays visible — a save that blocks on a
    // field hidden behind a collapsed section is a dead end.
    expect(groups(MONGODB_ENGINE)).toEqual([
      ["name", "basic"],
      ["host", "basic"],
      ["port", "basic"],
      ["database", "basic"],
      ["user", "basic"],
      ["sslMode", "advanced"],
      ["authSource", "basic"],
      ["replicaSet", "advanced"],
      ["readPreference", "advanced"],
      ["directConnection", "advanced"],
    ]);
  });

  it("carries the descriptor's prose as a TOOLTIP, and renders no hint under the field", () => {
    // Eleven controls with eleven paragraphs under them is what made the dialog confusing.
    const rows = engineFieldRows(MONGODB_ENGINE, draftFor(MONGODB_ENGINE));
    const authSource = rows.find((r) => r.key === "authSource");
    expect(authSource?.tip).toBe(
      "The database that holds the user — usually `admin`, not the one you query.",
    );
    expect(authSource?.hint).toBeNull();
    // A descriptor that has no prose gets no tooltip either.
    expect(rows.find((r) => r.key === "replicaSet")?.tip).toBeNull();
  });

  it("marks the common rows connection-scoped and reads their values from the draft", () => {
    const draft = draftFor(POSTGRES_ENGINE, {
      name: "Maestro",
      host: "h1",
      port: "6543",
      database: "maestro",
      user: "ro",
      sslMode: "verify-full",
    });
    const rows = engineFieldRows(POSTGRES_ENGINE, draft);
    expect(rows.filter((r) => r.scope === "connection").map((r) => [r.key, r.value])).toEqual([
      ["name", "Maestro"],
      ["host", "h1"],
      ["port", "6543"],
      ["database", "maestro"],
      ["user", "ro"],
      ["sslMode", "verify-full"],
    ]);
  });
});

/* ═══════════════════════════ the connection type ═════════════════════════
 * The control the dialog used to lack. Every expectation is a literal — the SRV scheme is
 * read off `urlSchemes`, so a fixture-derived expectation would agree with itself. */

describe("srvScheme / isSrv", () => {
  it("finds the DNS-seed-list scheme where the DESCRIPTOR declares one", () => {
    expect(srvScheme(MONGODB_ENGINE)).toBe("mongodb+srv");
    expect(srvScheme(POSTGRES_ENGINE)).toBeNull();
    expect(srvScheme(REDIS_ENGINE)).toBeNull();
  });

  it("refuses to call a draft SRV on an engine whose driver has never heard of it", () => {
    // A saved Mongo record re-opened under an engine this build offers instead (`initialEngine`
    // falls back to the first one) must not claim a mode its driver cannot use.
    expect(isSrv(MONGODB_ENGINE, draftFor(MONGODB_ENGINE, { srv: true }))).toBe(true);
    expect(isSrv(POSTGRES_ENGINE, draftFor(POSTGRES_ENGINE, { srv: true }))).toBe(false);
    expect(isSrv(MONGODB_ENGINE, draftFor(MONGODB_ENGINE, { srv: false }))).toBe(false);
  });
});

describe("connectMode", () => {
  it("reads the mode off the draft — a non-empty URL is what connects", () => {
    expect(connectMode(POSTGRES_ENGINE, draftFor(POSTGRES_ENGINE))).toBe("fields");
    expect(connectMode(MONGODB_ENGINE, draftFor(MONGODB_ENGINE, { srv: true }))).toBe("srv");
    expect(
      connectMode(POSTGRES_ENGINE, draftFor(POSTGRES_ENGINE, { url: "postgresql://h/db" })),
    ).toBe("url");
    // A URL beats the SRV flag, because Rust's `resolve_from_*` hands a non-empty `url`
    // straight to the driver whatever else the record says.
    expect(
      connectMode(MONGODB_ENGINE, draftFor(MONGODB_ENGINE, { srv: true, url: "mongodb://h/d" })),
    ).toBe("url");
    // `""` is URL-only-with-nothing-typed, a real state; `null` is "no override".
    expect(connectMode(POSTGRES_ENGINE, draftFor(POSTGRES_ENGINE, { url: "" }))).toBe("url");
  });
});

describe("connectModeChoices", () => {
  it("offers SRV only where the descriptor declares the scheme", () => {
    expect(connectModeChoices(POSTGRES_ENGINE).map((c) => [c.value, c.label])).toEqual([
      ["fields", "Host and port"],
      ["url", "URL only"],
    ]);
    expect(connectModeChoices(MONGODB_ENGINE).map((c) => [c.value, c.label])).toEqual([
      ["fields", "Host and port"],
      ["srv", "DNS seed list (SRV)"],
      ["url", "URL only"],
    ]);
  });
});

describe("setConnectMode", () => {
  const d = draftFor(MONGODB_ENGINE);

  it("seeds URL-only from the string it is taking over from", () => {
    expect(setConnectMode(d, "url", "mongodb://h:27017/db").url).toBe("mongodb://h:27017/db");
    // Nothing to seed from → an empty box, which `validateDraft` then blocks on. An
    // authoritative field that opens empty must at least say so.
    expect(setConnectMode(d, "url", null).url).toBe("");
    // A URL already in hand is never overwritten by the seed.
    expect(setConnectMode({ ...d, url: "mine" }, "url", "theirs").url).toBe("mine");
  });

  it("sets and clears the SRV flag, and drops the override in both field modes", () => {
    const srv = setConnectMode({ ...d, url: "mongodb://h/db" }, "srv", null);
    expect([srv.srv, srv.url]).toEqual([true, null]);
    const fields = setConnectMode(srv, "fields", null);
    expect([fields.srv, fields.url]).toEqual([false, null]);
  });
});

describe("setUrlText", () => {
  it("stores what was typed, and treats a blank box as NO override", () => {
    // Emptying the box hands the connection back to the fields. Storing `""` instead would
    // strand the user in URL-only mode with a blocking "a connection string is required".
    expect(setUrlText(draftFor(POSTGRES_ENGINE), "postgresql://h/db").url).toBe(
      "postgresql://h/db",
    );
    expect(setUrlText(draftFor(POSTGRES_ENGINE, { url: "postgresql://h/db" }), "").url).toBeNull();
    expect(setUrlText(draftFor(POSTGRES_ENGINE, { url: "x" }), "   ").url).toBeNull();
  });
});

describe("urlHint / connectModeNote / srvPortHint / portTip", () => {
  it("says which direction the string flows", () => {
    expect(urlHint("url")).toBe(URL_OVERRIDE_NOTE);
    expect(urlHint("fields")).toBe(URL_DERIVED_NOTE);
    expect(urlHint("srv")).toBe(URL_DERIVED_NOTE);
    expect(URL_OVERRIDE_NOTE).toContain("Overrides the fields above");
    expect(URL_DERIVED_NOTE).toContain("Edit it to take over");
  });

  it("explains what a mode changes about the other controls, and nothing when it changes nothing", () => {
    expect(connectModeNote(MONGODB_ENGINE, "srv")).toBe(
      "`mongodb+srv://` resolves the hosts, the port and the replica set from DNS, so no port " +
        "is sent. This is how MongoDB Atlas is reached.",
    );
    // 🔴 This used to be "The fields below are kept for reference and are not
    // used." — false for the Password field, which a URL-only connection usually HAS to fill
    // in (the parser strips a pasted credential and does not give it back). The literal is
    // spelled out rather than compared against the constant on purpose: a test that reads its
    // expectation from the source it is checking cannot fail on a wrong sentence.
    expect(connectModeNote(POSTGRES_ENGINE, "url")).toBe(
      "The connection string decides the host, port, database and user — the fields below are " +
        "kept for reference. The Password field is still used: it fills the gap when the " +
        "string carries no credential of its own.",
    );
    // And the retracted claim is gone, in those words and in substance.
    expect(connectModeNote(POSTGRES_ENGINE, "url")).not.toContain("are not used");
    expect(connectModeNote(POSTGRES_ENGINE, "fields")).toBeNull();
    // An engine with no SRV scheme cannot be in SRV mode, and says nothing if asked.
    expect(connectModeNote(POSTGRES_ENGINE, "srv")).toBeNull();
  });

  it("names the port's two states in the fewest words that are still true", () => {
    expect(srvPortHint(MONGODB_ENGINE, draftFor(MONGODB_ENGINE, { srv: true }))).toBe(
      "A `mongodb+srv://` URI must not carry a port — DNS supplies it.",
    );
    expect(srvPortHint(MONGODB_ENGINE, draftFor(MONGODB_ENGINE))).toBeNull();
    expect(srvPortHint(POSTGRES_ENGINE, draftFor(POSTGRES_ENGINE, { srv: true }))).toBeNull();
    expect(portTip(MONGODB_ENGINE)).toBe("Leave empty for 27017, this engine's default.");
  });
});

describe("advancedIsDirty", () => {
  it("is quiet for a fresh draft — the disclosure starts closed", () => {
    for (const spec of [...TEST_ENGINES, AWKWARD_ENGINE]) {
      expect(advancedIsDirty(spec, newDraft(spec, null))).toBe(false);
    }
  });

  it("opens itself for a saved connection whose advanced settings are not the defaults", () => {
    // The requirement: a user editing a saved connection must not have to hunt for the setting
    // they set. Both kinds of advanced value count.
    expect(
      advancedIsDirty(POSTGRES_ENGINE, newDraft(POSTGRES_ENGINE, { options: { searchPath: "reporting" } })),
    ).toBe(true);
    expect(
      advancedIsDirty(POSTGRES_ENGINE, newDraft(POSTGRES_ENGINE, { sslMode: "verify-full" })),
    ).toBe(true);
  });

  it("does not count a REQUIRED extra, because that one is never hidden", () => {
    expect(
      advancedIsDirty(MONGODB_ENGINE, newDraft(MONGODB_ENGINE, { options: { authSource: "reporting" } })),
    ).toBe(false);
  });

  it("ignores the SSL mode on an engine that offers none", () => {
    // `AWKWARD_ENGINE.sslModes` is `[]`, so there is no SSL row to reveal — and its
    // `defaults.sslMode` is not something the user could have chosen.
    expect(advancedIsDirty(AWKWARD_ENGINE, draftFor(AWKWARD_ENGINE, { sslMode: "verify-full" }))).toBe(
      false,
    );
  });
});

describe("setRowValue", () => {
  const rows = engineFieldRows(POSTGRES_ENGINE, draftFor(POSTGRES_ENGINE));
  const row = (key: string) => rows.find((r) => r.key === key)!;

  it("writes each connection-scoped field", () => {
    const d = draftFor(POSTGRES_ENGINE);
    expect(setRowValue(d, row("name"), "X").name).toBe("X");
    expect(setRowValue(d, row("host"), "X").host).toBe("X");
    expect(setRowValue(d, row("port"), "1").port).toBe("1");
    expect(setRowValue(d, row("database"), "X").database).toBe("X");
    expect(setRowValue(d, row("user"), "X").user).toBe("X");
    expect(setRowValue(d, row("sslMode"), "require").sslMode).toBe("require");
  });

  it("writes an option-scoped field without disturbing its siblings", () => {
    const d = draftFor(POSTGRES_ENGINE, { options: { searchPath: "public" } });
    const next = setRowValue(d, row("applicationName"), "Agent Studio");
    expect(next.options).toEqual({ searchPath: "public", applicationName: "Agent Studio" });
    expect(d.options).toEqual({ searchPath: "public" }); // input not mutated
  });
});

describe("removeOption", () => {
  it("drops exactly the named key", () => {
    const d = draftFor(POSTGRES_ENGINE, { options: { a: "1", b: "2" } });
    expect(removeOption(d, "a").options).toEqual({ b: "2" });
  });
});

/* ═══════════════════════════ draft construction ══════════════════════════ */

describe("newDraft", () => {
  it("seeds a blank draft from the descriptor's defaults", () => {
    const d = newDraft(POSTGRES_ENGINE, null);
    expect(d).toEqual({
      name: "",
      // A blank draft has no paste hint — there has been no paste.
      passwordParam: null,
      // And no SRV: DNS seed-list discovery is a deliberate choice, never a default.
      srv: false,
      engine: "postgres",
      host: "",
      // 🔴 EMPTY, not "5432". A seeded default is indistinguishable from a value the user
      // chose, so it was persisted and emitted — a port nobody entered.
      port: "",
      database: "",
      user: "",
      passwordRef: "",
      savePassword: "forever",
      url: null,
      sslMode: "prefer",
      options: { applicationName: "Agent Studio" },
      readOnly: true,
      rowLimit: "500",
      timeoutMs: "30000",
      allowMultiStatement: false,
      caSummary: null,
    });
  });

  it("mints no id and no timestamps — those are Rust's", () => {
    // The sentinels (`id: ""`, `createdAt: 0`) are gone with `DbConnectionDraft`.
    const d = newDraft(POSTGRES_ENGINE, null);
    expect(Object.keys(d)).not.toContain("id");
    expect(Object.keys(d)).not.toContain("createdAt");
    expect(Object.keys(d)).not.toContain("updatedAt");
  });

  it("starts read-only ON for every engine offered, and nothing in the descriptor can say otherwise", () => {
    // Read-only by default is unconditional for a NEW connection. `EngineSpec.defaults` has no
    // `readOnly` key at all, so this is no longer an override — it is unrepresentable.
    for (const spec of [...TEST_ENGINES, AWKWARD_ENGINE]) {
      expect(newDraft(spec, null).readOnly).toBe(true);
      expect(Object.keys(spec.defaults)).not.toContain("readOnly");
    }
  });

  it("keeps an existing connection's own read-only choice", () => {
    expect(newDraft(POSTGRES_ENGINE, { id: "01J", readOnly: false }).readOnly).toBe(false);
  });

  it("prefills from an existing connection, numbers as text", () => {
    const d = newDraft(MONGODB_ENGINE, {
      id: "01J",
      name: "Mongo Maestro",
      host: "cluster0.abcde.mongodb.net",
      port: 27018,
      database: "master-api",
      user: "catalog_ro",
      passwordRef: "{{MONGO_MAESTRO_PASSWORD}}",
      savePassword: "session",
      url: "mongodb+srv://catalog_ro:{{MONGO_MAESTRO_PASSWORD}}@cluster0/master-api",
      sslMode: "verify-full",
      options: { replicaSet: "rs0" },
      rowLimit: 1000,
      timeoutMs: 5000,
      allowMultiStatement: true,
      caSummary: { subjects: ["Amazon RDS"], count: 2, sha256: "abcdef0123456789" },
    });
    expect(d.port).toBe("27018");
    expect(d.rowLimit).toBe("1000");
    expect(d.timeoutMs).toBe("5000");
    expect(d.savePassword).toBe("session");
    expect(d.passwordRef).toBe("{{MONGO_MAESTRO_PASSWORD}}");
    // The record's own `replicaSet` survives; `authSource` and `readPreference` are
    // seeded from the descriptor because the record did not carry them.
    expect(d.options).toEqual({ replicaSet: "rs0", authSource: "admin", readPreference: "primary" });
    expect(d.caSummary).toEqual({ subjects: ["Amazon RDS"], count: 2, sha256: "abcdef0123456789" });
    expect(d.allowMultiStatement).toBe(true);
  });

  it("copies options rather than aliasing the caller's object", () => {
    const options = { replicaSet: "rs0" };
    const d = newDraft(MONGODB_ENGINE, { options });
    d.options.replicaSet = "changed";
    expect(options.replicaSet).toBe("rs0");
  });

  it("seeds the descriptor's defaults, and never argues with a value the record has", () => {
    expect(newDraft(MONGODB_ENGINE, null).options).toEqual({
      authSource: "admin",
      readPreference: "primary",
    });
    // A key the record carries wins — INCLUDING when the user deliberately emptied it.
    expect(
      newDraft(MONGODB_ENGINE, { options: { authSource: "reporting", readPreference: "" } }).options,
    ).toEqual({ authSource: "reporting", readPreference: "" });
    // `default: ""` seeds nothing at all, so `searchPath` never appears unasked.
    expect(newDraft(POSTGRES_ENGINE, null).options).toEqual({ applicationName: "Agent Studio" });
  });

  it("shows a seeded default in the rendered row, so the form and the draft agree", () => {
    const rows = engineFieldRows(MONGODB_ENGINE, newDraft(MONGODB_ENGINE, null));
    expect(rows.find((r) => r.key === "authSource")?.value).toBe("admin");
  });

  it("counts a seeded default as satisfying `required`, but an emptied field as not", () => {
    // The bug this fixes: a form that displays `admin` while calling itself invalid.
    const fresh = draftFor(MONGODB_ENGINE);
    expect(validateDraft(MONGODB_ENGINE, fresh).fields).toEqual({});
    expect(toRecord(MONGODB_ENGINE, fresh).options.authSource).toBe("admin");
    // Clearing it is a decision, and then the box really is empty.
    const cleared = draftFor(MONGODB_ENGINE, { options: { authSource: "" } });
    expect(validateDraft(MONGODB_ENGINE, cleared).fields.authSource).toBe("Auth source is required.");
  });
});

describe("initialEngine", () => {
  it("picks the engine the connection names", () => {
    expect(initialEngine(TEST_ENGINES, { engine: "redis" })?.label).toBe("Redis");
  });
  it("falls back to the first offered engine", () => {
    expect(initialEngine(TEST_ENGINES, null)?.label).toBe("PostgreSQL");
    expect(initialEngine(TEST_ENGINES, { engine: "clickhouse" })?.label).toBe("PostgreSQL");
  });
  it("returns null when there are no engines at all", () => {
    expect(initialEngine([], null)).toBeNull();
  });
});

describe("initialNotices", () => {
  it("says so when the saved engine is not offered by this build", () => {
    expect(initialNotices(POSTGRES_ENGINE, { engine: "clickhouse" })).toEqual([
      'This connection names the engine "clickhouse", which this build does not offer. ' +
        "It opened as PostgreSQL — check every field before you save.",
    ]);
  });
  it("says nothing when the engine matches, or when there is no connection", () => {
    expect(initialNotices(POSTGRES_ENGINE, { engine: "postgres" })).toEqual([]);
    expect(initialNotices(POSTGRES_ENGINE, null)).toEqual([]);
    expect(initialNotices(POSTGRES_ENGINE, { name: "x" })).toEqual([]);
  });
});

/* ═══════════════════════════ draft → connection ══════════════════════════ */

describe("toConnection", () => {
  it("denormalises family from the descriptor and parses the numbers", () => {
    const conn = toRecord(
      POSTGRES_ENGINE,
      draftFor(POSTGRES_ENGINE, { name: "  Prod  ", host: " db.internal ", port: "6543" }),
    );
    expect(conn.family).toBe("postgres");
    expect(conn.engine).toBe("postgres");
    expect(conn.name).toBe("Prod");
    expect(conn.host).toBe("db.internal");
    expect(conn.port).toBe(6543);
    expect(conn.rowLimit).toBe(500);
    expect(conn.timeoutMs).toBe(30000);
  });

  it("falls back to the descriptor's GUARDRAIL numbers when the text will not parse", () => {
    const conn = toRecord(
      POSTGRES_ENGINE,
      draftFor(POSTGRES_ENGINE, { port: "abc", rowLimit: "", timeoutMs: "1e4" }),
    );
    // But NOT the port: `null` means "the driver's default", and inventing one here is the
    // whole bug. `validateDraft` blocks the save on "abc" first.
    expect(conn.port).toBeNull();
    expect(conn.rowLimit).toBe(500);
    expect(conn.timeoutMs).toBe(30000);
  });

  it("sends `port: null` for an empty box rather than the descriptor's default", () => {
    expect(toRecord(POSTGRES_ENGINE, draftFor(POSTGRES_ENGINE, { port: "" })).port).toBeNull();
    expect(toRecord(POSTGRES_ENGINE, draftFor(POSTGRES_ENGINE, { port: "6543" })).port).toBe(6543);
  });

  it("makes the invalid SRV pairing impossible to persist", () => {
    // A `mongodb+srv://` URI carrying a port is REFUSED by the driver, so a record must not be
    // able to hold both — even if a legacy record (or a stray edit) does.
    const draft = draftFor(MONGODB_ENGINE, { srv: true, port: "27017" });
    const conn = toRecord(MONGODB_ENGINE, draft);
    expect(conn.port).toBeNull();
    expect(conn.srv).toBe(true);
  });

  it("never persists the SRV flag for an engine that ignores it", () => {
    // Same rule as `user` on Redis: the draft keeps it (an accidental engine click costs
    // nothing), the record does not.
    const draft = draftFor(POSTGRES_ENGINE, { srv: true, port: "5432" });
    expect(toRecord(POSTGRES_ENGINE, draft).srv).toBe(false);
    expect(toRecord(POSTGRES_ENGINE, draft).port).toBe(5432);
  });

  it("treats a blank URL box as NO override, exactly as Rust's upsert does", () => {
    // `upsert` filters with `.filter(|u| !u.trim().is_empty())`; disagreeing here would persist
    // an empty override that connects nowhere.
    expect(toRecord(POSTGRES_ENGINE, draftFor(POSTGRES_ENGINE, { url: "" })).url).toBeNull();
    expect(toRecord(POSTGRES_ENGINE, draftFor(POSTGRES_ENGINE, { url: "  " })).url).toBeNull();
    expect(
      toRecord(POSTGRES_ENGINE, draftFor(POSTGRES_ENGINE, { url: " postgresql://h/db " })).url,
    ).toBe("postgresql://h/db");
  });

  it("never persists a field the engine does not define", () => {
    // The draft keeps them (so switching back restores the typing); the RECORD does not.
    const draft = draftFor(REDIS_ENGINE, { user: "typed-before-switching", database: "3" });
    expect(toRecord(REDIS_ENGINE, draft).user).toBe("");
    expect(toRecord(REDIS_ENGINE, draft).database).toBe("3");
    expect(toRecord(AWKWARD_ENGINE, draftFor(AWKWARD_ENGINE, { database: "x" })).database).toBe(
      "",
    );
  });

  it("carries no password, only a reference", () => {
    const draft = draftFor(POSTGRES_ENGINE, { passwordRef: "{{PG_PROD_PASSWORD}}" });
    const conn = toRecord(POSTGRES_ENGINE, draft);
    expect(conn.passwordRef).toBe("{{PG_PROD_PASSWORD}}");
    expect(Object.keys(conn)).not.toContain("password");
    // There is no input to this function that could hold one.
    expect(Object.keys(draft)).not.toContain("password");
  });

  it("emits no id and no timestamps — Rust owns them", () => {
    const keys = Object.keys(toRecord(POSTGRES_ENGINE, draftFor(POSTGRES_ENGINE)));
    expect(keys).not.toContain("id");
    expect(keys).not.toContain("createdAt");
    expect(keys).not.toContain("updatedAt");
  });
});

/* ═══════════════════════════════ validation ══════════════════════════════ */

describe("wholeNumber", () => {
  it("accepts a plain non-negative integer and rejects everything else", () => {
    expect(wholeNumber("0")).toBe(0);
    expect(wholeNumber(" 42 ")).toBe(42);
    expect(wholeNumber("")).toBeNull();
    expect(wholeNumber("-1")).toBeNull();
    expect(wholeNumber("1.5")).toBeNull();
    expect(wholeNumber("1e3")).toBeNull();
    expect(wholeNumber("0x10")).toBeNull();
    expect(wholeNumber("abc")).toBeNull();
    expect(wholeNumber("99999999999999999999")).toBeNull(); // beyond a safe integer
  });
});

describe("validateDraft", () => {
  it("is silent on a complete PostgreSQL draft", () => {
    const errors = validateDraft(POSTGRES_ENGINE, draftFor(POSTGRES_ENGINE));
    expect(errors).toEqual({ fields: {}, warnings: [] });
    expect(hasBlockingErrors(errors)).toBe(false);
  });

  it("names the missing required common fields, verbatim", () => {
    const errors = validateDraft(
      POSTGRES_ENGINE,
      draftFor(POSTGRES_ENGINE, { name: "   ", host: "" }),
    );
    expect(errors.fields.name).toBe("Name is required.");
    expect(errors.fields.host).toBe("Host is required.");
    expect(hasBlockingErrors(errors)).toBe(true);
  });

  it("rejects a port that is not a port, and ACCEPTS an empty one", () => {
    const msg = "Port must be a whole number from 1 to 65535, or empty for 5432.";
    expect(portError(POSTGRES_ENGINE)).toBe(msg);
    for (const port of ["abc", "0", "65536", "-1", "5432.0"]) {
      expect(validateDraft(POSTGRES_ENGINE, draftFor(POSTGRES_ENGINE, { port })).fields.port).toBe(
        msg,
      );
    }
    expect(
      validateDraft(POSTGRES_ENGINE, draftFor(POSTGRES_ENGINE, { port: "65535" })).fields.port,
    ).toBeUndefined();
    // 🔴 Empty is LEGITIMATE now — it means the driver's default. It used to be the one thing
    // that forced a value into the box.
    for (const port of ["", "   "]) {
      expect(
        validateDraft(POSTGRES_ENGINE, draftFor(POSTGRES_ENGINE, { port })).fields.port,
      ).toBeUndefined();
    }
    // And the message names the engine's own default, so "or empty" is actionable.
    expect(portError(MONGODB_ENGINE)).toBe(
      "Port must be a whole number from 1 to 65535, or empty for 27017.",
    );
  });

  it("asks URL-only mode for a URL, and for nothing else the string already carries", () => {
    // 🔴 Connecting with a URL, a user and a password used to demand too many other fields.
    // Given a complete URI, the form demanded a host and a port that the URI already
    // carried — and then sent the port anyway.
    const urlOnly = draftFor(POSTGRES_ENGINE, { host: "", port: "", url: "postgresql://ro@h/db" });
    expect(validateDraft(POSTGRES_ENGINE, urlOnly).fields).toEqual({});

    // An empty authoritative box is the one thing it does ask for.
    const blank = draftFor(POSTGRES_ENGINE, { host: "", url: "" });
    expect(validateDraft(POSTGRES_ENGINE, blank).fields.url).toBe(URL_REQUIRED_ERROR);
    expect(URL_REQUIRED_ERROR).toContain("set Connection type back to Host and port");
    // …and it does NOT then also complain about the host it is not going to use.
    expect(validateDraft(POSTGRES_ENGINE, blank).fields.host).toBeUndefined();

    // The guardrails are still ours in URL-only mode, so they are still checked.
    expect(
      validateDraft(POSTGRES_ENGINE, { ...urlOnly, rowLimit: "0" }).fields.rowLimit,
    ).toBe("Row limit must be a whole number from 1 to 100000.");
    // And so are the descriptor's extras, because Rust's `engines::validate` checks them
    // whatever the mode — skipping them here would only move the refusal one round trip later.
    expect(
      validateDraft(MONGODB_ENGINE, {
        ...draftFor(MONGODB_ENGINE, { url: "mongodb://h/d" }),
        options: { authSource: "" },
      }).fields.authSource,
    ).toBe("Auth source is required.");
  });

  it("requires an extra field the descriptor marks required", () => {
    const errors = validateDraft(MONGODB_ENGINE, draftFor(MONGODB_ENGINE, { options: {} }));
    expect(errors.fields.authSource).toBe("Auth source is required.");
    expect(
      validateDraft(MONGODB_ENGINE, draftFor(MONGODB_ENGINE, { options: { authSource: "admin" } }))
        .fields.authSource,
    ).toBeUndefined();
  });

  it("rejects a non-numeric value in a number-kind extra field", () => {
    const draft = draftFor(POSTGRES_ENGINE, { options: { connectTimeout: "ten" } });
    expect(validateDraft(POSTGRES_ENGINE, draft).fields.connectTimeout).toBe(
      "Connect timeout (s) must be a whole number.",
    );
    const ok = draftFor(POSTGRES_ENGINE, { options: { connectTimeout: "10" } });
    expect(validateDraft(POSTGRES_ENGINE, ok).fields.connectTimeout).toBeUndefined();
  });

  it("rejects a select value outside the descriptor's choices, and lists them", () => {
    const draft = draftFor(MONGODB_ENGINE, {
      options: { authSource: "admin", readPreference: "whatever" },
    });
    expect(validateDraft(MONGODB_ENGINE, draft).fields.readPreference).toBe(
      "Read preference must be one of: primary, primaryPreferred, secondary, secondaryPreferred, nearest.",
    );
  });

  it("does not constrain a select whose descriptor offers no choices", () => {
    const draft = draftFor(AWKWARD_ENGINE, { options: { mode: "anything" } });
    expect(validateDraft(AWKWARD_ENGINE, draft).fields.mode).toBeUndefined();
  });

  it("warns — without blocking — about an option key the engine does not model", () => {
    const draft = draftFor(POSTGRES_ENGINE, {
      options: { target_session_attrs: "read-write" },
    });
    const errors = validateDraft(POSTGRES_ENGINE, draft);
    expect(errors.warnings).toEqual([
      "PostgreSQL does not model the setting `target_session_attrs`. It is passed to the " +
        "driver unchanged, so the server may reject it — remove it if you did not mean to keep it.",
    ]);
    // Not blocking: a vendor-supplied parameter must survive a round trip.
    expect(hasBlockingErrors(errors)).toBe(false);
  });

  it("bounds the row limit and the timeout", () => {
    const rowMsg = "Row limit must be a whole number from 1 to 100000.";
    const timeMsg = "Timeout must be a whole number of milliseconds from 1000 to 600000.";
    for (const rowLimit of ["0", "100001", "lots", ""]) {
      expect(
        validateDraft(POSTGRES_ENGINE, draftFor(POSTGRES_ENGINE, { rowLimit })).fields.rowLimit,
      ).toBe(rowMsg);
    }
    for (const timeoutMs of ["999", "600001", "soon", ""]) {
      expect(
        validateDraft(POSTGRES_ENGINE, draftFor(POSTGRES_ENGINE, { timeoutMs })).fields.timeoutMs,
      ).toBe(timeMsg);
    }
    const edge = draftFor(POSTGRES_ENGINE, { rowLimit: "100000", timeoutMs: "600000" });
    expect(validateDraft(POSTGRES_ENGINE, edge).fields).toEqual({});
  });
});

describe("unmodelledOptionKeys", () => {
  it("returns the undeclared keys, sorted", () => {
    const draft = draftFor(MONGODB_ENGINE, {
      options: { zeta: "1", replicaSet: "rs0", alpha: "2" },
    });
    expect(unmodelledOptionKeys(MONGODB_ENGINE, draft)).toEqual(["alpha", "zeta"]);
  });
});

describe("firstErrorKey / errorSummary", () => {
  it("finds the first errored key in the given order", () => {
    expect(firstErrorKey(["a", "b", "c"], { c: "x", b: "y" })).toBe("b");
    expect(firstErrorKey(["a"], {})).toBeNull();
  });
  it("turns it into a DOM id, and into nothing when there is no match", () => {
    expect(firstErrorDomId(["a", "b"], { b: "x" })).toBe("db-field-b");
    expect(firstErrorDomId(["a"], {})).toBe("");
  });
  it("counts the blocking fields in a sentence, singular and plural", () => {
    expect(errorSummary({ fields: {}, warnings: [] })).toBeNull();
    expect(errorSummary({ fields: { a: "x" }, warnings: [] })).toBe(
      "Fix 1 field before saving this connection.",
    );
    expect(errorSummary({ fields: { a: "x", b: "y" }, warnings: [] })).toBe(
      "Fix 2 fields before saving this connection.",
    );
  });
});

describe("fieldDomId", () => {
  it("namespaces a field's DOM id", () => {
    expect(fieldDomId("host")).toBe("db-field-host");
  });
});

/* ═════════════════════════════ engine switch ═════════════════════════════ */

describe("switchEngine", () => {
  it("keeps the common fields and drops only the options the new engine cannot use", () => {
    const draft = draftFor(MONGODB_ENGINE, {
      name: "Maestro",
      host: "cluster0",
      user: "catalog_ro",
      database: "master-api",
      passwordRef: "{{MONGO_MAESTRO_PASSWORD}}",
      savePassword: "session",
      options: { replicaSet: "rs0", readPreference: "nearest", authSource: "admin" },
    });
    const sw = switchEngine(draft, POSTGRES_ENGINE);
    expect(sw.draft.name).toBe("Maestro");
    expect(sw.draft.host).toBe("cluster0");
    expect(sw.draft.user).toBe("catalog_ro");
    expect(sw.draft.database).toBe("master-api");
    expect(sw.draft.passwordRef).toBe("{{MONGO_MAESTRO_PASSWORD}}");
    expect(sw.draft.savePassword).toBe("session");
    expect(sw.draft.engine).toBe("postgres");
    // Mongo's three are gone; PostgreSQL's own default arrives in their place.
    expect(sw.draft.options).toEqual({ applicationName: "Agent Studio" });
    expect(sw.droppedOptions).toEqual(["authSource", "readPreference", "replicaSet"]);
  });

  it("keeps an option key both engines declare", () => {
    // `clientName` is Redis-only; `searchPath` is Postgres-only. A key declared by the
    // TARGET survives regardless of where it came from.
    const draft = draftFor(REDIS_ENGINE, { options: { clientName: "x", searchPath: "public" } });
    const sw = switchEngine(draft, POSTGRES_ENGINE);
    expect(sw.draft.options).toEqual({ searchPath: "public", applicationName: "Agent Studio" });
    expect(sw.droppedOptions).toEqual(["clientName"]);
  });

  it("seeds the target engine's own defaults, so a required field is not left empty", () => {
    const sw = switchEngine(draftFor(POSTGRES_ENGINE, { options: {} }), MONGODB_ENGINE);
    expect(sw.draft.options).toEqual({ authSource: "admin", readPreference: "primary" });
    expect(validateDraft(MONGODB_ENGINE, sw.draft).fields).toEqual({});
  });

  it("carries the port across verbatim — there is no default to move any more", () => {
    // The old rule ("move it if it still holds the previous engine's default") existed only
    // because the box was pre-filled and the code had to guess whose value was in it. An empty
    // box now means "the default" and a value means the user typed it.
    expect(switchEngine(draftFor(POSTGRES_ENGINE), MONGODB_ENGINE).draft.port).toBe("");
    expect(switchEngine(draftFor(POSTGRES_ENGINE, { port: "6543" }), MONGODB_ENGINE).draft.port).toBe(
      "6543",
    );
    // Even a port that happens to equal the old engine's default is the user's, and survives.
    expect(switchEngine(draftFor(POSTGRES_ENGINE, { port: "5432" }), MONGODB_ENGINE).draft.port).toBe(
      "5432",
    );
  });

  it("drops the SRV flag — and NAMES it — when the new engine has no seed-list scheme", () => {
    const sw = switchEngine(draftFor(MONGODB_ENGINE, { srv: true }), POSTGRES_ENGINE);
    expect(sw.draft.srv).toBe(false);
    expect(sw.srvDropped).toBe(true);
  });

  it("keeps the SRV flag when the new engine declares the scheme, and reports nothing", () => {
    const twin: EngineSpec = { ...MONGODB_ENGINE, id: "aurora-mysql", label: "Mongo Twin" };
    const sw = switchEngine(draftFor(MONGODB_ENGINE, { srv: true }), twin);
    expect(sw.draft.srv).toBe(true);
    expect(sw.srvDropped).toBe(false);
    // And a draft that was never SRV cannot "lose" it.
    expect(switchEngine(draftFor(MONGODB_ENGINE), POSTGRES_ENGINE).srvDropped).toBe(false);
  });

  it("carries read-only across untouched, in both directions", () => {
    // It is the user's explicit decision about this connection, and no descriptor can
    // overrule it in either direction — `EngineSpec.defaults` has no `readOnly` key.
    for (const readOnly of [true, false]) {
      const sw = switchEngine(draftFor(POSTGRES_ENGINE, { readOnly }), AWKWARD_ENGINE);
      expect(sw.draft.readOnly).toBe(readOnly);
    }
    expect(Object.keys(AWKWARD_ENGINE.defaults)).not.toContain("readOnly");
  });

  it("keeps a URL override across an engine change", () => {
    // Rule 1: the override is the user's string. A driver change is not a reason to delete it.
    const sw = switchEngine(
      draftFor(POSTGRES_ENGINE, { url: "postgresql://ro@h/db" }),
      MONGODB_ENGINE,
    );
    expect(sw.draft.url).toBe("postgresql://ro@h/db");
  });

  it("keeps an SSL mode the new engine offers", () => {
    const sw = switchEngine(draftFor(POSTGRES_ENGINE, { sslMode: "verify-full" }), MONGODB_ENGINE);
    expect(sw.draft.sslMode).toBe("verify-full");
    expect(sw.sslModeReset).toBeNull();
  });

  it("reports an SSL mode it had to abandon", () => {
    const sw = switchEngine(draftFor(POSTGRES_ENGINE, { sslMode: "verify-ca" }), MONGODB_ENGINE);
    expect(sw.draft.sslMode).toBe("require");
    expect(sw.sslModeReset).toBe("verify-ca");
  });

  it("preserves the guardrail numbers verbatim", () => {
    const sw = switchEngine(
      draftFor(POSTGRES_ENGINE, { rowLimit: "42", timeoutMs: "4242" }),
      MONGODB_ENGINE,
    );
    expect([sw.draft.rowLimit, sw.draft.timeoutMs]).toEqual(["42", "4242"]);
  });
});

describe("describeEngineSwitch", () => {
  it("always says what was kept", () => {
    const sw = switchEngine(draftFor(POSTGRES_ENGINE, { port: "6543" }), POSTGRES_ENGINE);
    expect(describeEngineSwitch(sw, POSTGRES_ENGINE)).toEqual([
      "Switched to PostgreSQL. Name, host, user and the guardrails were kept.",
    ]);
  });

  it("names the lost connection type, the dropped settings and the SSL downgrade", () => {
    const draft = draftFor(MONGODB_ENGINE, {
      srv: true,
      sslMode: "verify-full",
      options: { replicaSet: "rs0", authSource: "admin" },
    });
    const sw = switchEngine(draft, REDIS_ENGINE);
    expect(describeEngineSwitch(sw, REDIS_ENGINE)).toEqual([
      // 🔴 No "user": Redis has `supportsUser: false`, so there is no user field on the form this
      // sentence describes. It used to say so anyway, because the summary was a fixed string.
      "Switched to Redis. Name, host and the guardrails were kept.",
      "Redis has no DNS seed list (SRV) mode, so the connection type is now Host and port.",
      "Removed 2 settings Redis does not use: authSource, replicaSet.",
      'Redis does not offer SSL mode "verify-full", so it is now "disable". Check it before you connect.',
    ]);
    // The port sentence is GONE, because the behaviour it explained is gone.
    expect(describeEngineSwitch(sw, REDIS_ENGINE).join(" ")).not.toContain("Port is now");
  });

  it("says setting, singular, when only one was dropped", () => {
    const draft = draftFor(POSTGRES_ENGINE, { options: { searchPath: "public" } });
    const sw = switchEngine(draft, REDIS_ENGINE);
    expect(describeEngineSwitch(sw, REDIS_ENGINE)).toContain(
      "Removed 1 setting Redis does not use: searchPath.",
    );
  });
});

/* ═══════════════════════════════ secrets ════════════════════════════════ */

describe("redactSecret", () => {
  it("scrubs a plain secret, every occurrence", () => {
    expect(redactSecret("a s3cret b s3cret", "s3cret")).toBe(`a ${SECRET_MASK} b ${SECRET_MASK}`);
  });

  it("scrubs the percent-encoded form too — the one a naive scrub misses", () => {
    const hostile = "p@ss:w/rd#1";
    const encoded = "p%40ss%3Aw%2Frd%231";
    const url = `postgresql://u:${encoded}@h:5432/db`;
    expect(redactSecret(url, hostile)).toBe(`postgresql://u:${SECRET_MASK}@h:5432/db`);
    expect(redactSecret(url, hostile)).not.toContain(encoded);
    expect(redactSecret(`literal ${hostile} here`, hostile)).toBe(`literal ${SECRET_MASK} here`);
  });

  it("scrubs nothing when no password has been typed", () => {
    expect(redactSecret("postgresql://u:{{PG}}@h/db", "")).toBe("postgresql://u:{{PG}}@h/db");
  });
});

/* ══════════════════════════════ URL import ══════════════════════════════ */

/** A `ParsedUrl` with nothing set; tests override only what they are about. */
function parsed(over: Partial<ParsedUrl> = {}): ParsedUrl {
  return {
    engine: null,
    family: null,
    host: "",
    port: null,
    database: "",
    user: "",
    hadPassword: false,
  srv: false,
    // Null = the credential came from the userinfo, which is the default shape these
    // helpers build. Tests that care about a query-string credential override it.
    passwordParam: null,
    sslMode: null,
    url: "",
    options: {},
    ...over,
  };
}

describe("applyParsedUrl", () => {
  it("sets every field it understood and says which", () => {
    const report = applyParsedUrl(
      draftFor(POSTGRES_ENGINE),
      parsed({ host: "db.prod", port: 6543, database: "maestro", user: "ro" }),
      POSTGRES_ENGINE,
    );
    expect(report.draft.host).toBe("db.prod");
    expect(report.draft.port).toBe("6543");
    expect(report.draft.database).toBe("maestro");
    expect(report.draft.user).toBe("ro");
    expect(report.notices).toEqual(["Set host, port, database, user from that URL."]);
  });

  it("says the password was taken out and stored separately", () => {
    const report = applyParsedUrl(
      draftFor(POSTGRES_ENGINE),
      parsed({ host: "h", hadPassword: true }),
      POSTGRES_ENGINE,
    );
    expect(report.notices).toContain(PASSWORD_MOVED_NOTICE);
    // The wording matters, and it used to be WRONG: it said the password
    // had been "stored separately", which describes the SAVE path. `db_url_parse` is pure
    // — it strips the value and DISCARDS it, so the old sentence told the user their
    // password was safe at the moment it had just been thrown away, and the failure showed
    // up as an auth error one save later with nothing on screen to explain it.
    expect(PASSWORD_MOVED_NOTICE).toContain("was NOT kept");
    expect(PASSWORD_MOVED_NOTICE).toContain("type it into the Password field");
    expect(PASSWORD_MOVED_NOTICE).not.toContain("stored separately");
  });

  it("changes nothing it was given nothing for", () => {
    const before = draftFor(POSTGRES_ENGINE);
    const report = applyParsedUrl(before, parsed(), POSTGRES_ENGINE);
    expect(report.draft).toEqual(before);
    expect(report.notices).toEqual([]);
  });

  it("skips fields the engine does not have", () => {
    const redis = applyParsedUrl(
      draftFor(REDIS_ENGINE),
      parsed({ host: "h", user: "someone" }),
      REDIS_ENGINE,
    );
    expect(redis.draft.user).toBe("");
    expect(redis.notices).toEqual(["Set host from that URL."]);

    const hostile = applyParsedUrl(
      draftFor(AWKWARD_ENGINE),
      parsed({ host: "h", database: "d" }),
      AWKWARD_ENGINE,
    );
    expect(hostile.draft.database).toBe("");
  });

  it("uses the engine's own name for the database field in its report", () => {
    const report = applyParsedUrl(
      draftFor(REDIS_ENGINE),
      parsed({ host: "h", database: "3" }),
      REDIS_ENGINE,
    );
    expect(report.notices).toEqual(["Set host, database index from that URL."]);
  });

  it("routes a declared query parameter into the engine's settings", () => {
    const report = applyParsedUrl(
      draftFor(MONGODB_ENGINE),
      parsed({ host: "h", options: { authSource: "admin" } }),
      MONGODB_ENGINE,
    );
    expect(report.draft.options).toEqual({ authSource: "admin", readPreference: "primary" });
    expect(report.notices).toEqual(["Set host, authSource from that URL."]);
  });

  it("keeps parameters it cannot model, rather than dropping them, and names them", () => {
    const report = applyParsedUrl(
      draftFor(POSTGRES_ENGINE),
      parsed({
        host: "h",
        options: { target_session_attrs: "read-write", zzz: "1" },
      }),
      POSTGRES_ENGINE,
    );
    expect(report.draft.options).toEqual({
      applicationName: "Agent Studio",
      target_session_attrs: "read-write",
      zzz: "1",
    });
    expect(report.notices).toEqual([
      "Set host from that URL.",
      "Kept 2 parameters PostgreSQL does not model, to pass through unchanged: " +
        "target_session_attrs=read-write, zzz=1.",
    ]);
  });

  it("reports the kept parameters in a stable order, whatever order they arrived in", () => {
    const report = applyParsedUrl(
      draftFor(POSTGRES_ENGINE),
      parsed({ host: "h", options: { zzz: "1", aaa: "2" } }),
      POSTGRES_ENGINE,
    );
    expect(report.notices).toContain(
      "Kept 2 parameters PostgreSQL does not model, to pass through unchanged: aaa=2, zzz=1.",
    );
  });

  it("says parameter, singular, for one", () => {
    const report = applyParsedUrl(
      draftFor(POSTGRES_ENGINE),
      parsed({ host: "h", options: { zzz: "1" } }),
      POSTGRES_ENGINE,
    );
    expect(report.notices).toContain(
      "Kept 1 parameter PostgreSQL does not model, to pass through unchanged: zzz=1.",
    );
  });

  it("reads the TLS mode the parser found, so the select cannot disagree with the URL", () => {
    // A form claiming `prefer` while the connection uses `verify-full` (or the reverse,
    // which silently weakens TLS) is the divergence `ParsedUrl.sslMode` was added for.
    const report = applyParsedUrl(
      draftFor(POSTGRES_ENGINE),
      parsed({ host: "h", sslMode: "verify-full" }),
      POSTGRES_ENGINE,
    );
    expect(report.draft.sslMode).toBe("verify-full");
    expect(report.notices).toEqual(["Set host, SSL mode from that URL."]);
  });

  it("leaves the current mode alone when the string said nothing about TLS", () => {
    const report = applyParsedUrl(
      draftFor(POSTGRES_ENGINE, { sslMode: "verify-ca" }),
      parsed({ host: "h", sslMode: null }),
      POSTGRES_ENGINE,
    );
    expect(report.draft.sslMode).toBe("verify-ca");
    expect(report.notices).toEqual(["Set host from that URL."]);
  });

  it("refuses a TLS mode this engine does not offer, and says so rather than pretending", () => {
    // Applying it would blank the select and persist a mode the driver rejects.
    const report = applyParsedUrl(
      draftFor(REDIS_ENGINE),
      parsed({ host: "h", sslMode: "verify-ca" }),
      REDIS_ENGINE,
    );
    expect(report.draft.sslMode).toBe("disable");
    expect(report.notices).toEqual([
      "Set host from that URL.",
      'That URL asks for SSL mode "verify-ca", which Redis does not offer — it is still ' +
        '"disable". Check it before you connect.',
    ]);
  });

  it("hands back the parser's credential-stripped string, so no rebuild is needed", () => {
    const report = applyParsedUrl(
      draftFor(POSTGRES_ENGINE),
      parsed({ host: "h", url: "postgresql://u:{{PG_PROD_PASSWORD}}@h:5432/db" }),
      POSTGRES_ENGINE,
    );
    expect(report.url).toBe("postgresql://u:{{PG_PROD_PASSWORD}}@h:5432/db");
  });

  it("points out an engine mismatch without switching anything", () => {
    const report = applyParsedUrl(
      draftFor(POSTGRES_ENGINE),
      parsed({ host: "h", engine: "mysql" }),
      POSTGRES_ENGINE,
    );
    expect(report.draft.engine).toBe("postgres");
    expect(report.notices).toContain(
      'That looks like a "mysql" URL, but the driver here is PostgreSQL. ' +
        "Change the driver above if that is wrong — nothing was switched for you.",
    );
  });

  it("says nothing about the engine when it agrees", () => {
    const report = applyParsedUrl(
      draftFor(POSTGRES_ENGINE),
      parsed({ host: "h", engine: "postgres" }),
      POSTGRES_ENGINE,
    );
    expect(report.notices).toEqual(["Set host from that URL."]);
  });
});

/* ══════════════ the credential parameter (`?password=`) survives a paste ══════════════
 * `?password=` stays part of the path, because every database system follows that
 * convention. Rust honoured it on the SAVE path; the
 * PASTE path lost it, and the `{{VAR}}` came back in the userinfo instead — silently moving
 * a credential to a different place in the string.
 *
 * Every expectation below is a LITERAL string. That is not stylistic here: the whole bug
 * was about *which position* a substring ends up in, and an expectation assembled from the
 * same pieces the code assembles would be blind to exactly that. */

describe("importUrlOverride", () => {
  it("🔴 KEEPS a pasted URL whose credential was in the userinfo — the Atlas bug", () => {
    // The regression this file exists to prevent. This case used to return `url: null`: the
    // rule was "keep the string only if it carried a credential query PARAMETER", so an Atlas
    // URI with `user:pw@` was discarded whole — `mongodb+srv` scheme and all — and what
    // connected was rebuilt from the fields as `mongodb://…:27017/`, which Atlas does not
    // answer. A pasted URL is what the user asked for.
    expect(
      importUrlOverride(
        parsed({
          url: "mongodb+srv://ro@cluster0.abcde.mongodb.net/maestro?authSource=admin",
          passwordParam: null,
          hadPassword: true,
        }),
        "",
      ),
    ).toEqual({
      url: "mongodb+srv://ro@cluster0.abcde.mongodb.net/maestro?authSource=admin",
      keptParam: null,
    });
  });

  it("REPLACES an override that already exists, so a stale string cannot survive a paste", () => {
    expect(
      importUrlOverride(
        parsed({ url: "postgresql://ro@new-host:5432/db", passwordParam: null }),
        "",
      ),
    ).toEqual({ url: "postgresql://ro@new-host:5432/db", keptParam: null });
  });

  it("stores nothing when the parser rendered no string at all", () => {
    // `url: ""` would read as "URL only, nothing typed" and block the save. Nothing to keep
    // is not the same as a mode change.
    expect(importUrlOverride(parsed({ url: "", passwordParam: "password" }), "")).toEqual({
      url: null,
      keptParam: null,
    });
  });

  it("takes the parser's string as-is when a {{VAR}} already survived in the parameter", () => {
    // `db_url_parse` re-renders a REFERENCE in place (only a real value is stripped), so
    // there is nothing to put back.
    expect(
      importUrlOverride(
        parsed({
          url: "postgresql://ro@h:5432/db?sslmode=prefer&password={{PG_PASSWORD}}",
          passwordParam: "password",
        }),
        "",
      ),
    ).toEqual({
      url: "postgresql://ro@h:5432/db?sslmode=prefer&password={{PG_PASSWORD}}",
      keptParam: "password",
    });
  });

  it("puts the draft's reference back into the parameter, LAST, matching Rust's renderer", () => {
    // `url.rs` emits the credential parameter after the SSL parameters and the sorted
    // options, so the string built here and the string Rust writes on save are the SAME
    // string rather than a permutation of it.
    expect(
      importUrlOverride(
        parsed({
          url: "postgresql://ro@h:5432/db?sslmode=verify-full",
          passwordParam: "password",
          hadPassword: true,
        }),
        "{{PG_PASSWORD}}",
      ),
    ).toEqual({
      url: "postgresql://ro@h:5432/db?sslmode=verify-full&password={{PG_PASSWORD}}",
      keptParam: "password",
    });
  });

  it("opens the query string with `?` when the stripped URL had none", () => {
    expect(
      importUrlOverride(
        parsed({ url: "postgresql://ro@h:5432/db", passwordParam: "pwd", hadPassword: true }),
        "{{PG_PASSWORD}}",
      ),
    ).toEqual({ url: "postgresql://ro@h:5432/db?pwd={{PG_PASSWORD}}", keptParam: "pwd" });
  });

  it("cannot keep the parameter when the draft has no reference yet, and says so by keptParam", () => {
    // The ordinary fresh paste. The value is not returned to this window (by design) and
    // the Vault variable's name is minted by Rust at save time, so there is genuinely
    // nothing to write into the parameter. `keptParam: null` is what drives the honest
    // notice instead of a silently reshaped string. The STRING is still kept.
    expect(
      importUrlOverride(
        parsed({
          url: "postgresql://ro@h:5432/db",
          passwordParam: "password",
          hadPassword: true,
        }),
        "",
      ),
    ).toEqual({ url: "postgresql://ro@h:5432/db", keptParam: null });
  });
});

describe("urlHasLiteralPassword", () => {
  it("spots a literal in the userinfo and ignores a {{VAR}} reference", () => {
    expect(urlHasLiteralPassword("postgresql://ro:hunter2@h:5432/db")).toBe(true);
    expect(urlHasLiteralPassword("postgresql://ro:{{PG_PASSWORD}}@h:5432/db")).toBe(false);
    // The `@` is found LAST, so a password containing one does not fool it.
    expect(urlHasLiteralPassword("mysql://ro:a@b@h/db")).toBe(true);
  });

  it("says no to every string that has no userinfo password to find", () => {
    expect(urlHasLiteralPassword("")).toBe(false);
    expect(urlHasLiteralPassword("db.internal:5432/maestro")).toBe(false); // no scheme
    expect(urlHasLiteralPassword("postgresql://h:5432/db")).toBe(false); // no `@`
    expect(urlHasLiteralPassword("postgresql://ro@h:5432/db")).toBe(false); // user only
    expect(urlHasLiteralPassword("postgresql://ro:@h:5432/db")).toBe(false); // empty password
    // A `:` in the PATH is not a userinfo separator — the authority stops at the first `/`.
    expect(urlHasLiteralPassword("clickhouse://h:8123/db:x")).toBe(false);
  });

  it("names the position and the outcome, never the value", () => {
    expect(URL_LITERAL_PASSWORD_NOTICE).toContain("`user:password@`");
    expect(URL_LITERAL_PASSWORD_NOTICE).toContain("moves to the Vault when you save");
    expect(URL_LITERAL_PASSWORD_NOTICE).toContain("never stores the value");
  });
});

describe("applyParsedUrl — the credential's position", () => {
  /** The draft of a SAVED connection: it already has a Vault reference. */
  const saved = (over: Partial<DbDraft> = {}): DbDraft =>
    draftFor(POSTGRES_ENGINE, { passwordRef: "{{PG_PASSWORD}}", ...over });

  it("keeps a pasted `?password=` in `password`, not in the userinfo, after the rebuild", () => {
    const report = applyParsedUrl(
      saved(),
      parsed({
        host: "db.internal",
        port: 5432,
        database: "maestro",
        user: "ro",
        hadPassword: true,
        passwordParam: "password",
        url: "postgresql://ro@db.internal:5432/maestro?sslmode=prefer",
      }),
      POSTGRES_ENGINE,
    );

    // THE assertion. `draft.url` is what `toRecord` sends to Rust and what the dialog's
    // URL box renders (`draft.url ?? built`), so setting it is what makes the derived
    // rebuild — which would have written `postgresql://ro:{{PG_PASSWORD}}@…` — irrelevant.
    expect(report.draft.url).toBe(
      "postgresql://ro@db.internal:5432/maestro?sslmode=prefer&password={{PG_PASSWORD}}",
    );
    // …and the reference is NOT in the userinfo. Stated separately and literally, because
    // "is in the query string" and "is not in the userinfo" are the two halves of "it did
    // not move", and a single `toBe` would let a future edit satisfy one without the other.
    expect(report.draft.url).not.toContain("ro:{{PG_PASSWORD}}@");
    expect(report.notices).toContain(passwordParamKeptNotice("password"));
    // No caveat for the one name every driver honours.
    expect(report.notices).not.toContain(driverPasswordParamCaveat("pwd"));
  });

  it("keeps a pasted `?pwd=` under ITS OWN name — and warns it will not authenticate", () => {
    const report = applyParsedUrl(
      saved(),
      parsed({
        host: "db.internal",
        hadPassword: true,
        passwordParam: "pwd",
        url: "postgresql://ro@db.internal:5432/maestro",
      }),
      POSTGRES_ENGINE,
    );

    // Kept as `pwd`, never normalised to `password`: renaming it would change what the
    // string SAYS, and this app does not rewrite the user's string to make it work.
    expect(report.draft.url).toBe(
      "postgresql://ro@db.internal:5432/maestro?pwd={{PG_PASSWORD}}",
    );
    expect(report.draft.url).not.toContain("password=");
    expect(report.notices).toContain(passwordParamKeptNotice("pwd"));
    // The measured caveat, surfaced rather than hidden: a faithful round trip that still
    // fails to authenticate is an auth error whose cause is otherwise invisible.
    expect(report.notices).toContain(
      "Drivers read only the exact lowercase `password` parameter — PostgreSQL and MySQL " +
        'both log "ignoring unrecognized connect parameter" for anything else — so `pwd=` ' +
        "is kept exactly as you pasted it and will still not authenticate. Rename it to " +
        "`password` in the string if that is what you meant; Agent Studio will not rename it " +
        "for you, because that would change what the string says.",
    );
  });

  it("🔴 KEEPS a userinfo-credential string as the override instead of throwing it away", () => {
    const report = applyParsedUrl(
      saved(),
      parsed({
        host: "db.internal",
        user: "ro",
        hadPassword: true,
        passwordParam: null,
        url: "postgresql://ro@db.internal:5432/maestro",
      }),
      POSTGRES_ENGINE,
    );

    // This used to be `expect(report.draft.url).toBeNull()` — the string was discarded because
    // its credential had not been in a query parameter. That is the Atlas bug: what connected
    // was rebuilt from the fields rather than being what the user pasted.
    expect(report.draft.url).toBe("postgresql://ro@db.internal:5432/maestro");
    // The reference goes back into the userinfo on save (`upsert`'s `render_with_ref`), which is
    // where this string carried it. Nothing moved.
    expect(report.draft.url).not.toContain("password=");
    // Neither of the parameter notices fires: there is no parameter to talk about.
    expect(report.notices).not.toContain(passwordParamKeptNotice("password"));
    expect(report.notices).not.toContain(passwordParamUnplacedNotice("password"));
    expect(report.notices).toContain(PASSWORD_MOVED_NOTICE);
  });

  it("🔴 keeps `mongodb+srv` — the one bit that made Atlas reachable at all", () => {
    // `DbConnection.srv` exists because pasting an Atlas URI parsed fine, filled
    // the form, and then lost the scheme: the record built a single-host `mongodb://host:port`,
    // which Atlas does not answer. Both halves are asserted — the flag AND the string.
    const report = applyParsedUrl(
      draftFor(MONGODB_ENGINE),
      parsed({
        engine: "mongodb",
        host: "cluster0.abcde.mongodb.net",
        database: "maestro",
        user: "catalog_ro",
        hadPassword: true,
        url: "mongodb+srv://catalog_ro@cluster0.abcde.mongodb.net/maestro?authSource=admin",
      }),
      MONGODB_ENGINE,
    );
    expect(report.draft.srv).toBe(true);
    expect(report.draft.url).toBe(
      "mongodb+srv://catalog_ro@cluster0.abcde.mongodb.net/maestro?authSource=admin",
    );
    // No port was pasted, so none is invented — and the record cannot carry one for an SRV URI.
    expect(report.draft.port).toBe("");
    expect(toRecord(MONGODB_ENGINE, report.draft).port).toBeNull();
    expect(report.notices).toContain(
      "That URL is a DNS seed list (`mongodb+srv://`), so the port stays empty — DNS supplies " +
        "the hosts and the port.",
    );
  });

  it("turns SRV back OFF for a plain string, and never touches it on an engine without it", () => {
    // The paste is the new intent in both directions.
    const off = applyParsedUrl(
      draftFor(MONGODB_ENGINE, { srv: true }),
      parsed({ host: "h", url: "mongodb://h:27017/d" }),
      MONGODB_ENGINE,
    );
    expect(off.draft.srv).toBe(false);
    expect(off.notices).not.toContain(
      "That URL is a DNS seed list (`mongodb+srv://`), so the port stays empty — DNS supplies " +
        "the hosts and the port.",
    );
    // PostgreSQL declares no `+srv` scheme, so a stale flag is left exactly as it was — this
    // function does not own that decision (`toRecord` refuses to persist it).
    const pg = applyParsedUrl(
      draftFor(POSTGRES_ENGINE, { srv: true }),
      parsed({ host: "h", url: "postgresql://h/d" }),
      POSTGRES_ENGINE,
    );
    expect(pg.draft.srv).toBe(true);
    expect(toRecord(POSTGRES_ENGINE, pg.draft).srv).toBe(false);
  });

  it("carries a fresh paste's parameter as a HINT, and says it survives the save", () => {
    // A brand-new connection: no `{{VAR}}` exists yet, because Rust mints it on save.
    const report = applyParsedUrl(
      draftFor(POSTGRES_ENGINE),
      parsed({
        host: "db.internal",
        hadPassword: true,
        passwordParam: "password",
        url: "postgresql://ro@db.internal:5432/maestro",
      }),
      POSTGRES_ENGINE,
    );

    expect(report.draft.url).toBe("postgresql://ro@db.internal:5432/maestro");
    expect(report.notices).toContain(passwordParamUnplacedNotice("password"));
    expect(report.notices).not.toContain(passwordParamKeptNotice("password"));
    // 🔴 The half that makes the `?password=` rule hold for the gesture a user
    // actually performs. The stripped string above has no parameter left, so this FIELD is
    // the only surviving evidence of where the credential belongs; Rust
    // (`DbConnectionInput::password_param`) writes the reference back into it at save time.
    // Without this the `{{VAR}}` landed in `user:password@` and the saved string described
    // the connection differently from how it was pasted.
    expect(report.draft.passwordParam).toBe("password");
  });

  it("a paste with the credential in the USERINFO leaves the hint null", () => {
    // The hint must not be set for every paste: a non-null value tells Rust "put it in a
    // parameter", and doing that to a `user:password@` string would move the credential.
    const report = applyParsedUrl(
      draftFor(POSTGRES_ENGINE),
      parsed({
        host: "db.internal",
        hadPassword: true,
        passwordParam: null,
        url: "postgresql://ro@db.internal:5432/maestro",
      }),
      POSTGRES_ENGINE,
    );
    expect(report.draft.passwordParam).toBeNull();
  });

  it("keeps a re-pasted reference string as a fixed point", () => {
    // Exactly what Rust stored last time comes back in. It must round-trip unchanged, or
    // saving twice would walk the credential across the string.
    const stored = "postgresql://ro@db.internal:5432/maestro?password={{PG_PASSWORD}}";
    const report = applyParsedUrl(
      saved({ url: stored }),
      parsed({
        host: "db.internal",
        user: "ro",
        database: "maestro",
        hadPassword: false,
        passwordParam: "password",
        url: stored,
      }),
      POSTGRES_ENGINE,
    );
    expect(report.draft.url).toBe(stored);
    expect(report.notices).toContain(passwordParamKeptNotice("password"));
    // Nothing about a password having been taken out — a `{{VAR}}` is not a secret.
    expect(report.notices).not.toContain(PASSWORD_MOVED_NOTICE);
  });
});

describe("driverPasswordParamCaveat", () => {
  it("is silent for the exact lowercase `password`", () => {
    expect(driverPasswordParamCaveat("password")).toBeNull();
  });

  it("warns for every other credential name the parser can hand back", () => {
    // `is_credential_param`'s list, sampled. Case matters: sqlx matches the parameter name
    // exactly, so `Password` is as unrecognised as `pwd`.
    for (const name of ["pwd", "passwd", "pass", "token", "api_key", "Password"]) {
      const caveat = driverPasswordParamCaveat(name);
      expect(caveat).not.toBeNull();
      expect(caveat).toContain(`\`${name}=\``);
      expect(caveat).toContain("will still not authenticate");
    }
  });
});

describe("readOnlyBadgeTitle", () => {
  it("promises a server boundary only where the engine has one", () => {
    expect(readOnlyBadgeTitle(POSTGRES_ENGINE)).toBe(
      "Read-only. PostgreSQL enforces this at the server for the whole session.",
    );
  });

  it("calls it a speed bump where it is one, and names the real fix", () => {
    // Redis has no server-side read-only mode, so the badge must not imply a boundary the
    // engine cannot keep — a control that pretends to be stronger than it is, is
    // worse than no control.
    expect(readOnlyBadgeTitle(REDIS_ENGINE)).toBe(
      "Read-only. Redis has no server-side read-only mode, so this is a client-side speed bump, not a guarantee — for a real boundary, connect as a read-only database user.",
    );
  });

  it("admits it does not know, for a connection whose engine this build lacks", () => {
    expect(readOnlyBadgeTitle(null)).toBe(
      "Read-only. This build does not offer this connection's engine, so whether the server can enforce it is unknown.",
    );
  });
});

/* ═════════════════════════════ Test Connection ═══════════════════════════ */

describe("raceTestTimeout", () => {
  it("returns the real result when it arrives in time", async () => {
    const ok: DbTestResult = { ok: true, serverVersion: "PostgreSQL 17.2", latencyMs: 34, error: null };
    await expect(raceTestTimeout(Promise.resolve(ok), 1000)).resolves.toEqual(ok);
  });

  it("resolves to a mapped timeout instead of hanging forever", async () => {
    vi.useFakeTimers();
    try {
      const never = new Promise<DbTestResult>(() => {});
      const race = raceTestTimeout(never, 15_000);
      await vi.advanceTimersByTimeAsync(15_000);
      await expect(race).resolves.toEqual(timeoutResult(15_000));
    } finally {
      vi.useRealTimers();
    }
  });

  it("names the ceiling in seconds", () => {
    expect(timeoutResult(15_000).error).toBe(
      "The test did not finish within 15 s. The server may be unreachable, or a firewall may be dropping the connection.",
    );
    expect(timeoutResult(15_000).ok).toBe(false);
  });
});

describe("describeTestResult", () => {
  it("shows the server version and the latency — the proof of a round trip", () => {
    expect(
      describeTestResult(
        { ok: true, serverVersion: "PostgreSQL 17.2", latencyMs: 34, error: null },
        "",
      ),
    ).toEqual({ ok: true, text: "PostgreSQL 17.2 · 34 ms" });
  });

  it("degrades honestly when the server gave no version or no latency", () => {
    expect(
      describeTestResult({ ok: true, serverVersion: "Redis 7.4", latencyMs: null, error: null }, ""),
    ).toEqual({ ok: true, text: "Redis 7.4" });
    expect(
      describeTestResult({ ok: true, serverVersion: null, latencyMs: 12, error: null }, ""),
    ).toEqual({ ok: true, text: "Connected · 12 ms" });
    expect(
      describeTestResult({ ok: true, serverVersion: null, latencyMs: null, error: null }, ""),
    ).toEqual({ ok: true, text: "Connected" });
  });

  it("shows the mapped error, and falls back rather than showing nothing", () => {
    expect(
      describeTestResult(
        { ok: false, serverVersion: null, latencyMs: null, error: "auth: the server rejected the credentials" },
        "",
      ),
    ).toEqual({ ok: false, text: "auth: the server rejected the credentials" });
    expect(
      describeTestResult({ ok: false, serverVersion: null, latencyMs: null, error: null }, ""),
    ).toEqual({ ok: false, text: TEST_FAILED_FALLBACK });
  });

  it("scrubs the typed password out of the error, in case a driver echoed it", () => {
    const out = describeTestResult(
      {
        ok: false,
        serverVersion: null,
        latencyMs: null,
        error: 'network: could not connect to "postgresql://u:p@ss:w/rd#1@h/db"',
      },
      "p@ss:w/rd#1",
    );
    expect(out.text).not.toContain("p@ss:w/rd#1");
    expect(out.text).toContain(SECRET_MASK);
  });
});

/* ════════════════════════════ guardrail copy ════════════════════════════ */

describe("readOnlyNote", () => {
  it("promises a server boundary only where one exists", () => {
    expect(readOnlyNote(POSTGRES_ENGINE)).toBe(
      "PostgreSQL enforces this at the server for the whole session — a write or a DDL statement fails at the database, not here.",
    );
  });

  it("calls itself a speed bump where the engine cannot enforce it", () => {
    const note = readOnlyNote(MONGODB_ENGINE);
    expect(note).toBe(
      "MongoDB has no server-side read-only mode, so Agent Studio filters commands in-process. That is a speed bump, not a guarantee: for a real boundary, connect as a read-only database user.",
    );
    expect(note).toContain("not a guarantee");
  });
});

describe("savePasswordHint", () => {
  it("explains each retention choice", () => {
    expect(savePasswordHint("forever")).toBe(
      "Kept in the Vault under a {{VAR}} name. The connection record stores the reference, never the value.",
    );
    expect(savePasswordHint("session")).toBe(
      "Held in memory until Agent Studio quits. Never written to disk.",
    );
    expect(savePasswordHint("never")).toBe("Not kept at all — you are asked for it on every connect.");
  });

  it("offers the three choices, in order", () => {
    expect(SAVE_PASSWORD_CHOICES.map((c) => [c.value, c.label])).toEqual([
      ["forever", "Forever"],
      ["session", "Until I quit"],
      ["never", "Never"],
    ]);
  });
});

/* ═══════════════════════════════ plumbing ═══════════════════════════════ */

describe("errorMessage", () => {
  it("reads an Error's message and a rejected string as itself", () => {
    expect(errorMessage(new Error("invalid-config: no host"))).toBe("invalid-config: no host");
    expect(errorMessage("not-found")).toBe("not-found");
  });
});

describe("tabWrapTarget", () => {
  const a = { id: "a" } as unknown as HTMLElement;
  const b = { id: "b" } as unknown as HTMLElement;
  const c = { id: "c" } as unknown as HTMLElement;

  it("does not interfere in the middle of the list", () => {
    expect(tabWrapTarget([a, b, c], b, false)).toBeNull();
    expect(tabWrapTarget([a, b, c], b, true)).toBeNull();
  });

  it("wraps forward off the end and backward off the start", () => {
    expect(tabWrapTarget([a, b, c], c, false)).toBe(a);
    expect(tabWrapTarget([a, b, c], a, true)).toBe(c);
  });

  it("pulls focus back in when it has escaped the dialog", () => {
    expect(tabWrapTarget([a, b, c], null, false)).toBe(a);
    expect(tabWrapTarget([a, b, c], null, true)).toBe(c);
  });

  it("has nothing to do when there is nothing focusable", () => {
    expect(tabWrapTarget([], a, false)).toBeNull();
  });
});

describe("canonicalScheme", () => {
  it("returns the first scheme with its separator", () => {
    // Literal expectations, never read from the descriptor.
    expect(canonicalScheme(POSTGRES_ENGINE)).toBe("postgresql://");
    expect(canonicalScheme(MONGODB_ENGINE)).toBe("mongodb://");
  });

  it("returns \"\" for a descriptor that lists no scheme", () => {
    // `urlSchemes` is a plain array in the contract, so "none" is expressible even
    // though every shipped descriptor has one. Without the guard the import prompt
    // would read "undefined://" — a fake scheme is worse than no prompt. Covering the
    // branch was prompted by a coverage measurement, not by review.
    const noScheme: EngineSpec = { ...POSTGRES_ENGINE, urlSchemes: [] };
    expect(canonicalScheme(noScheme)).toBe("");
  });
});

