/** Hand-written EngineSpec INPUTS, never a mirror of Rust's db::engines::spec_for: tests write
 * expectations literally. Postgres/MongoDB differ most; Redis has no user and no server-side
 * read-only; AWKWARD_ENGINE has a null databaseLabel, no SSL modes and a choiceless select. */

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

/** Awkward on purpose: a fixture, never a template. */
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
