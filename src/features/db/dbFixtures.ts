/**
 * Hand-written `EngineSpec` fixtures for the connection dialog's tests.
 *
 * ── Why these are hand-written and live in the repo ──────────────────────────
 * The real descriptors are Rust's (`db::engines::spec_for`) and arrive over
 * `db_engines()`. Testing the dialog against *those* would make the frontend tests
 * hostage to the backend, and — more importantly — it would fall into a known trap:
 * a test whose expectation comes from the same table the code reads proves plumbing,
 * never content. So these fixtures are
 * **inputs**, and every expectation in the tests is written out literally beside it.
 *
 * They are shaped like the real thing but they are NOT a mirror of it and must never
 * become one: if a value here matters to production, it is in the wrong file.
 *
 * Postgres and MongoDB are the pair whose connection forms differ most
 * (Mongo grows `authSource`/`replicaSet`/`readPreference`); Redis covers
 * `supportsUser: false` and the engine where read-only is *not* server-enforced; and
 * `AWKWARD_ENGINE` exists to prove the dialog copes with the descriptor shapes that
 * would otherwise crash or mislead it — `databaseLabel: null`, no SSL modes at all,
 * and a `select` with no choices.
 *
 * Two shapes that used to live here are now **unrepresentable**, which is the better
 * outcome: a `kind: "password"` extra field (it would have persisted a credential to
 * disk) and a `defaults.readOnly: false` (it would have let data weaken the read-only
 * safety default). Both were removed from `types.ts` after the implementation
 * had to defend against them — the defences went with them.
 */

import type { EngineSpec } from "./types";

export const POSTGRES_ENGINE: EngineSpec = {
  id: "postgres",
  family: "postgres",
  label: "PostgreSQL",
  defaultPort: 5432,
  urlSchemes: ["postgresql", "postgres"],
  databaseLabel: "Database",
  supportsUser: true,
  sslModes: ["disable", "prefer", "require", "verify-ca", "verify-full"],
  extraFields: [
    {
      key: "applicationName",
      label: "Application name",
      kind: "text",
      placeholder: "Agent Studio",
      choices: null,
      default: "Agent Studio",
      required: false,
      hint: "Appears in pg_stat_activity, so a runaway query is traceable back to this app.",
    },
    {
      key: "searchPath",
      label: "Search path",
      kind: "text",
      placeholder: "public",
      choices: null,
      default: "",
      required: false,
      hint: null,
    },
    {
      key: "connectTimeout",
      label: "Connect timeout (s)",
      kind: "number",
      placeholder: "10",
      choices: null,
      default: "",
      required: false,
      hint: null,
    },
  ],
  defaults: {
    rowLimit: 500,
    timeoutMs: 30_000,
    allowMultiStatement: false,
    sslMode: "prefer",
  },
  serverEnforcedReadOnly: true,
  queryLanguage: "sql",
};

export const MONGODB_ENGINE: EngineSpec = {
  id: "mongodb",
  family: "mongodb",
  label: "MongoDB",
  defaultPort: 27017,
  urlSchemes: ["mongodb", "mongodb+srv"],
  databaseLabel: "Database",
  supportsUser: true,
  sslModes: ["disable", "require", "verify-full"],
  extraFields: [
    {
      key: "authSource",
      label: "Auth source",
      kind: "text",
      placeholder: "admin",
      choices: null,
      // Required AND defaulted — the exact combination `default` was added for.
      default: "admin",
      required: true,
      hint: "The database that holds the user — usually `admin`, not the one you query.",
    },
    {
      key: "replicaSet",
      label: "Replica set",
      kind: "text",
      placeholder: "atlas-abc123-shard-0",
      choices: null,
      default: "",
      required: false,
      hint: null,
    },
    {
      key: "readPreference",
      label: "Read preference",
      kind: "select",
      placeholder: null,
      choices: ["primary", "primaryPreferred", "secondary", "secondaryPreferred", "nearest"],
      default: "primary",
      required: false,
      hint: "Reading from a secondary keeps analytical queries off the primary.",
    },
    {
      key: "directConnection",
      label: "Direct connection",
      kind: "checkbox",
      placeholder: null,
      choices: null,
      default: "",
      required: false,
      hint: "Talk to exactly this host instead of discovering the replica set.",
    },
  ],
  defaults: {
    rowLimit: 500,
    timeoutMs: 30_000,
    allowMultiStatement: false,
    sslMode: "require",
  },
  serverEnforcedReadOnly: false,
  queryLanguage: "json",
};

export const REDIS_ENGINE: EngineSpec = {
  id: "redis",
  family: "redis",
  label: "Redis",
  defaultPort: 6379,
  urlSchemes: ["redis", "rediss"],
  databaseLabel: "Database index",
  supportsUser: false,
  sslModes: ["disable", "require"],
  extraFields: [
    {
      key: "clientName",
      label: "Client name",
      kind: "text",
      placeholder: "agent-studio",
      choices: null,
      default: "",
      required: false,
      hint: null,
    },
  ],
  defaults: {
    rowLimit: 500,
    timeoutMs: 10_000,
    allowMultiStatement: false,
    sslMode: "disable",
  },
  serverEnforcedReadOnly: false,
  queryLanguage: "commandline",
};

/**
 * Deliberately awkward. Every property here is one the dialog has to cope with rather
 * than assume away, so it is a fixture and never a template.
 */
export const AWKWARD_ENGINE: EngineSpec = {
  id: "clickhouse",
  family: "clickhouse",
  label: "Awkward Fixture",
  defaultPort: 8123,
  urlSchemes: ["clickhouse"],
  // No database concept at all → the database field must disappear.
  databaseLabel: null,
  supportsUser: true,
  // No TLS choices → an empty select must not be offered.
  sslModes: [],
  extraFields: [
    {
      // A select with nothing to select → must not be validated against `[]`.
      key: "mode",
      label: "Mode",
      kind: "select",
      placeholder: null,
      choices: null,
      default: "",
      required: false,
      hint: null,
    },
  ],
  defaults: {
    rowLimit: 500,
    timeoutMs: 30_000,
    allowMultiStatement: true,
    sslMode: "disable",
  },
  serverEnforcedReadOnly: false,
  queryLanguage: "sql",
};

/** The list a dialog is normally handed in tests. */
export const TEST_ENGINES: EngineSpec[] = [POSTGRES_ENGINE, MONGODB_ENGINE, REDIS_ENGINE];
