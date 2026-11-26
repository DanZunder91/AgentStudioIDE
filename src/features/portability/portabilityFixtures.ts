/** Hand-written inputs, never expectations: tests spell their strings out. `TEST_EXPORT_SOURCE`:
 * `SHARED_TOKEN` in two envs (one valued) and a valueless `UNSET_WEBHOOK`, which must not be
 * listed as withheld. `SEALED_HEADER` has non-zero `secretValues`. */

import type { BundleHeader, ImportPlan, ImportResult } from "./types";
import type { ExportSource } from "./portabilityFormat";

/* ─────────────────────────────── export side ─────────────────────────────── */

export const TEST_EXPORT_SOURCE: ExportSource = {
  dbConnections: [
    { id: "conn-warehouse", name: "warehouse (staging)", detail: "postgres · db.staging:5432" },
    { id: "conn-cache", name: "session cache", detail: "redis · cache.staging:6379" },
    // No detail line at all — the store does not always have one to give.
    { id: "conn-scratch", name: "scratch", detail: null },
  ],
  apiRequests: [
    { id: "req-charge", name: "Create charge", detail: "POST https://api.example.com/v1/charges" },
    { id: "req-health", name: "Health", detail: "GET https://api.example.com/healthz" },
  ],
  environments: [
    {
      id: "env-staging",
      name: "staging",
      variables: [
        { key: "PG_PASSWORD", hasValue: true },
        { key: "SHARED_TOKEN", hasValue: true },
        { key: "UNSET_WEBHOOK", hasValue: false },
      ],
    },
    {
      id: "env-local",
      name: "local",
      variables: [
        { key: "ALPHA_KEY", hasValue: true },
        // The same name as in `env-staging`, but empty here: one variable, and it does
        // carry a value overall, because one copy of it does.
        { key: "SHARED_TOKEN", hasValue: false },
      ],
    },
  ],
};

/** A source with nothing in it — the dialog must still open and say why it cannot export. */
export const EMPTY_EXPORT_SOURCE: ExportSource = {
  dbConnections: [],
  apiRequests: [],
  environments: [],
};

/* ─────────────────────────────── headers ─────────────────────────────── */

/** 2026-07-28 09:15:00 UTC. */
const CREATED_AT = Date.UTC(2026, 6, 28, 9, 15, 0);

export const STRUCTURE_HEADER: BundleHeader = {
  kind: "agentstudio.bundle",
  version: 1,
  mode: "structure",
  createdAtMs: CREATED_AT,
  app: "Agent Studio 0.1.0",
  label: "Team staging DB + API",
  counts: {
    dbConnections: 2,
    dbQueries: 3,
    apiRequests: 4,
    environments: 1,
    referencedVariables: 5,
    secretValues: 0,
  },
};

export const SEALED_HEADER: BundleHeader = {
  kind: "agentstudio.bundle",
  version: 1,
  mode: "sealed",
  createdAtMs: CREATED_AT,
  app: "Agent Studio 0.1.0",
  label: "prod, sealed",
  counts: {
    dbConnections: 1,
    dbQueries: 0,
    apiRequests: 2,
    environments: 1,
    referencedVariables: 3,
    secretValues: 3,
  },
};

/** No label at all — the provenance sentence must not grow an empty quoted string. */
export const UNLABELLED_HEADER: BundleHeader = {
  kind: "agentstudio.bundle",
  version: 1,
  mode: "structure",
  createdAtMs: CREATED_AT,
  app: "Agent Studio 0.1.0",
  label: "   ",
  counts: {
    dbConnections: 0,
    dbQueries: 0,
    apiRequests: 0,
    environments: 0,
    referencedVariables: 0,
    secretValues: 0,
  },
};

/* ─────────────────────────────── import plans ─────────────────────────────── */

/** A sealed bundle nobody has unlocked yet: header readable, contents not. */
export const LOCKED_PLAN: ImportPlan = {
  header: SEALED_HEADER,
  unsealed: false,
  items: [],
  hosts: [],
  variables: [],
  notices: [],
};

/** One item of every kind, every default action, and both variable states. */
export const RICH_PLAN: ImportPlan = {
  header: STRUCTURE_HEADER,
  unsealed: true,
  items: [
    {
      kind: "dbConnection",
      id: "conn-warehouse",
      label: "warehouse (staging)",
      action: "update",
      reason: "a connection with this id already exists",
    },
    {
      kind: "dbConnection",
      id: "conn-analytics",
      label: "analytics",
      action: "create",
      reason: "no connection with this id exists here",
    },
    {
      kind: "dbQuery",
      id: "query-top-accounts",
      label: "top accounts",
      action: "create",
      reason: "no saved query with this id exists here",
    },
    {
      kind: "apiRequest",
      id: "req-charge",
      label: "Create charge",
      action: "create",
      reason: "no request with this id exists here",
    },
    {
      kind: "environment",
      id: "env-staging",
      label: "staging",
      action: "update",
      reason: "an environment with this id already exists",
    },
    {
      kind: "variable",
      id: "PROD_STRIPE_KEY",
      label: "PROD_STRIPE_KEY",
      action: "skip",
      reason: "you already have a value for this variable",
    },
  ],
  hosts: ["api.example.com", "db.staging"],
  variables: [
    { name: "PG_PASSWORD", haveLocally: false, bundleHasValue: false },
    { name: "PROD_STRIPE_KEY", haveLocally: true, bundleHasValue: true },
    { name: "SHARED_TOKEN", haveLocally: true, bundleHasValue: false },
  ],
  notices: [
    "A header on “Create charge” looked like a literal secret and was redacted.",
    "One connection named an engine this build does not have (cockroach) and was skipped.",
  ],
};

/** A structure bundle that references nothing and contacts nobody. */
export const BARE_PLAN: ImportPlan = {
  header: UNLABELLED_HEADER,
  unsealed: true,
  items: [
    {
      kind: "dbQuery",
      id: "query-orphan",
      label: "orphan query",
      action: "skip",
      reason: "its connection is not in this bundle",
    },
  ],
  hosts: [],
  variables: [],
  notices: [],
};

/** A plan with no items at all — a bundle that would change nothing. */
export const NOTHING_TO_DO_PLAN: ImportPlan = {
  header: STRUCTURE_HEADER,
  unsealed: true,
  items: [],
  hosts: ["api.example.com"],
  variables: [{ name: "ALPHA_KEY", haveLocally: false, bundleHasValue: false }],
  notices: [],
};

/* ─────────────────────────────── results ─────────────────────────────── */

export const MIXED_RESULT: ImportResult = {
  created: {
    dbConnections: 1,
    dbQueries: 1,
    apiRequests: 1,
    environments: 0,
    variables: 2,
  },
  updated: {
    dbConnections: 0,
    dbQueries: 0,
    apiRequests: 0,
    environments: 1,
    variables: 0,
  },
  skipped: {
    dbConnections: 0,
    dbQueries: 0,
    apiRequests: 0,
    environments: 0,
    variables: 1,
  },
  notices: [
    "“warehouse (staging)” was imported read-only.",
    "“analytics” already existed under that name, so it was saved as “analytics (imported)”.",
  ],
};

/** An all-zero `ImportCounts` — an import counts variables WRITTEN, not names referenced. */
const ZERO = {
  dbConnections: 0,
  dbQueries: 0,
  apiRequests: 0,
  environments: 0,
  variables: 0,
};

/** Everything was skipped by choice: a real outcome, and the one most likely to confuse. */
export const NO_CHANGE_RESULT: ImportResult = {
  created: { ...ZERO },
  updated: { ...ZERO },
  skipped: { ...ZERO },
  notices: [],
};
