/**
 * Share-a-config bundles — the wire contract.
 *
 * A JSON export and import covering database connections, API keys, and HTTP and gRPC requests
 * with their headers (including the password vault entries they use), so that a configuration can
 * be shared between people who use the app.
 *
 * This file is the **single source of truth** for that format. Rust's `src-tauri/src/portability/`
 * mirrors these shapes with `#[serde(rename_all = "camelCase")]`, and both frontend halves build
 * against it. It is the contract first, on purpose: the three sides agree here or they disagree in
 * a file people email to each other.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * THE CENTRAL DECISION: two modes, and the safe one is the default
 * ════════════════════════════════════════════════════════════════════════════════
 *
 * A file that carries production database passwords and API keys will be dropped into Slack,
 * attached to a ticket, and committed to a repo. That is not cynicism, it is what happens to
 * config exports. So:
 *
 * - **`structure` (the default)** — everything *except* secret values. A DB connection keeps its
 *   `passwordRef` (`{{PG_PASSWORD}}`); an environment keeps its variable **names** and drops every
 *   value. The recipient fills in their own. This file is safe to paste anywhere, and the export
 *   UI says so plainly.
 *
 * - **`sealed` (opt-in)** — the same contents *with* values, encrypted under a passphrase the
 *   sharer communicates out of band. The plaintext never touches disk.
 *
 * There is deliberately **no third mode that writes secret values in the clear.** Not behind a
 * flag, not behind a confirm. If someone truly needs that, they can decrypt a sealed bundle
 * themselves — the point is that this app never produces such a file, because the moment it can,
 * it is the path of least resistance and it will be the one used.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHAT A BUNDLE PROVES ABOUT ITS AUTHOR: nothing
 * ════════════════════════════════════════════════════════════════════════════════
 *
 * `app` and `label` are **informational metadata, not a signature.** There is no PKI here, so a
 * bundle claiming to come from a colleague proves nothing at all. The import UI must never present
 * provenance as verified, and `ImportPlan` exists precisely because an imported config is
 * untrusted input that a person should read before it lands.
 */

/* ─────────────────────────────── the bundle ─────────────────────────────── */

/** The file's discriminator. A JSON file without exactly this is not a bundle. */
export const BUNDLE_KIND = "agentstudio.bundle" as const;

/** The format version. Bumped only for a change a reader cannot absorb. */
export const BUNDLE_VERSION = 1 as const;

export type BundleMode = "structure" | "sealed";

/**
 * What a bundle says about itself **without** being decrypted.
 *
 * Everything here is readable from a sealed bundle too, which is what lets the import dialog
 * describe a file before asking for a passphrase. That is a deliberate, bounded disclosure:
 * counts and a label, never names. A sealed bundle that advertised `PROD_STRIPE_KEY` on the
 * outside would leak the shape of someone's infrastructure to anyone who received the file by
 * accident — so `referencedVariables` lives *inside* the ciphertext (see `BundleContents`).
 */
export interface BundleHeader {
  kind: typeof BUNDLE_KIND;
  version: number;
  mode: BundleMode;
  /** When it was exported. Informational — clocks lie and nothing verifies this. */
  createdAtMs: number;
  /** `"Agent Studio 0.1.0"`. Informational; NOT a compatibility gate on its own. */
  app: string;
  /** What the sharer called it: `"Team staging DB + API"`. May be empty. */
  label: string;
  /** How many of each thing, so the import dialog can describe a sealed file honestly. */
  counts: BundleCounts;
}

export interface BundleCounts {
  dbConnections: number;
  dbQueries: number;
  apiRequests: number;
  environments: number;
  /** Distinct `{{VAR}}` names the contents reference. A count only — see `BundleHeader`. */
  referencedVariables: number;
  /** How many of those actually carry a VALUE. `0` in `structure` mode, by construction. */
  secretValues: number;
}

/**
 * The payload. In `structure` mode this sits in the clear under `contents`; in `sealed` mode the
 * identical shape is the plaintext inside `sealed.ciphertextB64` and `contents` is absent.
 *
 * One shape for both modes is the point: the encryption is a wrapper, not a different format, so
 * the import path parses one thing and cannot drift between modes.
 */
export interface BundleContents {
  dbConnections: ExportedDbConnection[];
  dbQueries: ExportedDbQuery[];
  apiRequests: ExportedApiRequest[];
  environments: ExportedEnvironment[];
  /**
   * Every `{{VAR}}` name anything in this bundle refers to, deduplicated and sorted.
   *
   * Computed at export rather than derived at import, because the exporter knows which references
   * were live. It is what the import dialog turns into "you will need to supply: PG_PASSWORD,
   * STRIPE_KEY" — the difference between a config that works and one that fails on first use with
   * a `secret-missing` error nobody can explain.
   */
  referencedVariables: string[];
}

/** A whole bundle as it appears on disk. */
export interface Bundle extends BundleHeader {
  /** Present iff `mode === "structure"`. */
  contents?: BundleContents;
  /** Present iff `mode === "sealed"`. */
  sealed?: SealedPayload;
}

/* ─────────────────────────────── sealing ─────────────────────────────── */

/**
 * The encrypted payload and the parameters needed to open it.
 *
 * Every parameter is in the clear because a decryptor needs them — that is normal and not a leak.
 * They are **recorded rather than assumed** so the iteration count can be raised later without
 * making today's files unreadable.
 */
export interface SealedPayload {
  kdf: {
    /** `"pbkdf2-hmac-sha256"` — the only value version 1 defines. */
    algorithm: string;
    /**
     * PBKDF2 rounds. 600 000 at introduction (OWASP's 2023 guidance for PBKDF2-HMAC-SHA256).
     *
     * ⚠️ **Honest limitation, stated in the contract rather than buried:** PBKDF2 is markedly
     * weaker than Argon2id against GPU cracking. It is used because `ring` is already the whole
     * binary's crypto provider and Argon2 would be a new dependency; the iteration
     * count travels in the file so a reader can judge the strength of a bundle they were sent, and
     * so it can be raised without a format break. A weak passphrase is still the weak link.
     */
    iterations: number;
    /** Random per bundle, base64. */
    saltB64: string;
  };
  aead: {
    /** `"aes-256-gcm"` — the only value version 1 defines. */
    algorithm: string;
    /** Random per bundle, base64. Never reused: one bundle, one nonce, one key. */
    nonceB64: string;
  };
  /**
   * `BundleContents` as JSON, encrypted.
   *
   * The AEAD's additional data is the canonical header (`kind|version|mode|createdAtMs|label`), so
   * a ciphertext cannot be lifted into a bundle that describes itself differently — relabelling a
   * file as a smaller or friendlier export would otherwise be undetectable.
   */
  ciphertextB64: string;
}

/* ────────────────────────── the exported records ────────────────────────── */

/**
 * A DB connection, minus everything that is meaningless or dangerous on another machine.
 *
 * Deliberately **not** the full `DbConnection`: no `createdAt`/`updatedAt` (the importer stamps its
 * own), and no local filesystem paths — a path to a CA file on the sharer's laptop is not a thing
 * the recipient has.
 */
export interface ExportedDbConnection {
  id: string;
  name: string;
  engine: string;
  host: string;
  /** `null` = the engine's default. See `DbConnection.port` — a mandatory port is what invented
   *  the `:27017` that made an Atlas URI unreachable. */
  port: number | null;
  /**
   * `mongodb+srv://` — DNS seed-list discovery.
   *
   * 🔴 A bundle that dropped this would **re-create the unreachable-Atlas bug on the recipient's
   * machine**: they would import a connection that looks right, and it would rebuild as a plain
   * single-host `mongodb://host:27017`. Rust's `bundle.rs` already carries it; this mirror lagged.
   */
  srv: boolean;
  database: string;
  user: string;
  /** `""` or a `{{VAR}}` name. **Never a value** — that is what `environments` is for. */
  passwordRef: string;
  sslMode: string;
  /**
   * Carried for information, and **not honoured on import**: an imported connection is forced
   * read-only regardless (see `ImportPlan`). Present so the recipient can see what the sharer
   * intended, which is different from acting on it.
   */
  readOnly: boolean;
  rowLimit: number;
  timeoutMs: number;
  allowMultiStatement: boolean;
  /** A URL override, credential-split exactly as the store holds it (so `{{VAR}}`, never a value). */
  url: string | null;
  options: Record<string, string>;
}

/** A saved query. Travels with its connection's id so the two re-associate on import. */
export interface ExportedDbQuery {
  id: string;
  connectionId: string;
  name: string;
  sql: string;
}

/** An HTTP / WebSocket / gRPC request, headers and all. */
export interface ExportedApiRequest {
  id: string;
  name: string;
  method: string;
  url: string;
  /**
   * Headers verbatim, including `Authorization`.
   *
   * 🔴 A header value may be a literal secret rather than a `{{VAR}}` — the API client does not
   * force references — so **`structure` mode must redact literal-looking secrets in headers** and
   * say which ones it redacted. See `REDACTED_PLACEHOLDER`. Getting this wrong is the single most
   * likely way this feature leaks a credential, because a bearer token in a header does not look
   * like a password field to any code that is not looking for it.
   */
  headers: { name: string; value: string }[];
  body: string;
  protocol: string | null;
  grpcService: string | null;
  grpcMethod: string | null;
  plaintext: boolean | null;
}

/**
 * An environment. In `structure` mode every `value` is `null`; in `sealed` mode it is the real
 * value. `null` and `""` are distinguished: `null` means "not exported", `""` means the variable
 * genuinely holds an empty string.
 */
export interface ExportedEnvironment {
  id: string;
  name: string;
  variables: { key: string; value: string | null }[];
}

/**
 * What replaces a redacted header value in `structure` mode.
 *
 * A visible marker rather than an empty string, so an imported request fails loudly at send time
 * instead of silently sending `Authorization: ` and returning a confusing 401.
 */
export const REDACTED_PLACEHOLDER = "{{REDACTED — supply this value}}" as const;

/* ────────────────────────── inspect, then import ────────────────────────── */

/**
 * What `portability_inspect` returns: a **dry run**. Nothing is written by this call.
 *
 * An imported bundle is untrusted input, and the two risks worth showing a person are not
 * hypothetical:
 *
 * 1. **Overwriting their own config.** Matching is by `id`, so a re-import of an earlier export
 *    updates rather than duplicates — and a *different* item that happens to share a name is
 *    created under a suffixed name instead of silently merging.
 * 2. **Exfiltration through a reference they already hold.** An imported request can name
 *    `{{PROD_STRIPE_KEY}}` — which the recipient's Vault may well contain — and point at any host
 *    in the world. Nothing here can judge intent, so the plan lists, per item, **the hosts it will
 *    contact and the variables it will read**, and no imported request is ever auto-run.
 */
export interface ImportPlan {
  header: BundleHeader;
  /**
   * Whether `items`/`hosts`/`variables` are real.
   *
   * 🔴 **`false` means one thing only: the bundle is sealed and NO passphrase was supplied.** It
   * is the "describe this file before asking for a passphrase" case, and the header + counts are
   * the whole answer.
   *
   * A **wrong** passphrase is NOT this — it *rejects*, with `bad-passphrase`. Folding it in here
   * would make a failed unseal arrive as either a rejection or a resolved-but-empty plan, so every
   * caller would need both branches and the two paths would inevitably drift. One failure, one
   * shape.
   */
  unsealed: boolean;
  items: ImportItem[];
  /** Distinct hosts anything in the bundle would talk to, deduplicated and sorted. */
  hosts: string[];
  /** Every `{{VAR}}` the bundle references, and whether this machine already has a value for it. */
  variables: { name: string; haveLocally: boolean; bundleHasValue: boolean }[];
  /** Non-fatal notes: a skipped unknown engine, a redacted header, a clamped number. */
  notices: string[];
}

export type ImportAction = "create" | "update" | "skip";

export interface ImportItem {
  kind: "dbConnection" | "dbQuery" | "apiRequest" | "environment" | "variable";
  /**
   * A **plan-scoped key, unique across every kind** — Rust mints it as `"<kind>:<native id>"`
   * (`"dbConnection:01J…"`, `"variable:PG_PASSWORD"`).
   *
   * 🔴 It has to be namespaced because `ImportChoices.actions` keys on this alone. The native ids
   * are not from one space: a `variable`'s is its name, an `environment`'s is a uuid, a
   * `dbQuery`'s is a ULID. Nothing stopped a variable called `01J…` from colliding with a
   * connection of that id, and the consequence would be one item's "skip" silently applied to
   * another — a mis-routed override that no error would report.
   */
  id: string;
  label: string;
  /** What would happen by default. The user may override per item. */
  action: ImportAction;
  /** Why, in one sentence: `"a connection with this id already exists"`. */
  reason: string;
}

/** The user's decisions, sent back to `portability_import`. */
export interface ImportChoices {
  /** Per-item override, keyed by `ImportItem.id`. Absent means "use the plan's default". */
  actions: Record<string, ImportAction>;
  /**
   * Whether an incoming secret value may replace one this machine already has.
   *
   * Defaults to **false**: taking someone else's value for a variable you already use is how a
   * working setup breaks in a way that is very hard to trace back to an import.
   */
  overwriteExistingSecrets: boolean;
  /**
   * Whether imported DB connections are made read-only.
   *
   * 🔴 **Defaults to `true`, and Rust's `serde` default is `true` too** — deliberately, because the
   * struct is `#[serde(default)]` and an absent field would otherwise deserialise to `false`, i.e.
   * an older caller would silently import **writable** connections. The safe value has to be the one
   * that appears when nobody said anything.
   *
   * This was originally *forced*; it is now **enforced but optional.** The
   * original reasoning survives as justification for the default — a connection that has just
   * arrived is new *on this machine*, and the recipient did not make the sharer's choice —
   * but it does not justify taking the decision away from the person reading the review screen.
   *
   * With it **off**, each connection keeps whatever the bundle says; it does not force everything
   * writable. And either way the import report records what happened, so a writable import is never
   * silent.
   */
  forceReadOnly: boolean;
}

/**
 * What an import did to each kind of thing.
 *
 * ⚠️ Deliberately **not** `BundleCounts`, which it briefly was. `BundleCounts` describes a *file*
 * and its `referencedVariables` counts distinct `{{VAR}}` **names mentioned**; an import result
 * needs the number of variables **written**. Reusing one type made the receipt read
 * "3 variables" off a field that meant "3 names were referenced" — a wrong number in
 * user-facing copy, and the kind of thing that is invisible until someone checks it against
 * reality. Two meanings, two types.
 */
export interface ImportCounts {
  dbConnections: number;
  dbQueries: number;
  apiRequests: number;
  environments: number;
  /** Variables actually written into this machine's Vault. */
  variables: number;
}

/** What actually happened. Counts, not prose, so the UI can render its own summary. */
export interface ImportResult {
  created: ImportCounts;
  updated: ImportCounts;
  skipped: ImportCounts;
  /** Things the user should know: forced read-only, a name that was suffixed, a dropped field. */
  notices: string[];
}

/* ───────────────────────────── export options ───────────────────────────── */

export interface ExportOptions {
  mode: BundleMode;
  label: string;
  /** Which id sets to include. Empty array = include none of that kind; absent = include all. */
  dbConnectionIds?: string[];
  apiRequestIds?: string[];
  environmentIds?: string[];
  /**
   * There is deliberately no `dbQueryIds`. **Saved queries travel with their connection**: a
   * query's SQL names one server's tables, so exporting it without its connection produces
   * something the recipient cannot run, and exporting a connection while dropping its queries
   * silently discards the work that was meant to be shareable in the first place. Selecting a
   * connection therefore selects its queries, and `BundleCounts.dbQueries` reports how many came
   * along.
   */
  /** Required and non-empty when `mode === "sealed"`; rejected otherwise. */
  passphrase?: string;
}

/**
 * The floor on a sealing passphrase.
 *
 * Enforced in Rust, not only in the dialog: a short passphrase in front of 600 000 PBKDF2 rounds
 * is still a short passphrase, and the whole value of `sealed` mode rests on it. Not a strength
 * meter — a hard minimum, because a meter is advice and this is the one place advice is not enough.
 */
export const MIN_PASSPHRASE_LENGTH = 12 as const;

/** Bundle size ceiling, so a hostile or accidental multi-hundred-MB file cannot hang the webview. */
export const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;

/* ───────────────────────────── the command surface ───────────────────────────── */

/**
 * 🔴 **The bundle's bytes never cross the IPC boundary, in either direction.**
 *
 * Rust reads and writes the file itself, given a path the user picked with
 * `@tauri-apps/plugin-dialog`. The webview only ever sees a header, a plan, or a result.
 *
 * This is not tidiness. In `sealed` mode the plaintext contains live secrets, and a design where
 * the webview assembles or receives that string puts it in the renderer's heap, in any devtools
 * session, and in whatever a future crash reporter decides to capture. The file path is the only
 * thing that needs to travel, so it is the only thing that does — the same reasoning that keeps
 * `ResolvedConfig` in-process in the DB client.
 *
 * | Command | Args | Returns |
 * |---|---|---|
 * | `portability_export` | `{ options: ExportOptions, destPath: string }` | `BundleHeader` |
 * | `portability_inspect` | `{ srcPath: string, passphrase: string \| null }` | `ImportPlan` |
 * | `portability_import` | `{ srcPath, passphrase: string \| null, choices: ImportChoices }` | `ImportResult` |
 *
 * `portability_inspect` is callable **twice** for a sealed bundle: once with `passphrase: null` to
 * read the header and describe the file (resolving with `unsealed: false`), then again with the
 * passphrase to unseal and produce the full plan. It writes nothing either time, so a wrong
 * passphrase costs nothing but a retry — and a wrong passphrase **rejects** with `bad-passphrase`
 * rather than resolving with an empty plan (see `ImportPlan.unsealed`).
 *
 * Errors are the same `<code>[: detail]` string shape the rest of the app uses, with these codes:
 * `not-a-bundle` · `unsupported-version` · `too-large` · `bad-passphrase` · `tampered` ·
 * `weak-passphrase` · `io` · `unknown`.
 */
export const PORTABILITY_ERROR_CODES = [
  /** The file parsed as JSON but is not a bundle (wrong or missing `kind`). */
  "not-a-bundle",
  /** A `version` this build cannot read. Named separately so the message can say "upgrade". */
  "unsupported-version",
  /** Over `MAX_BUNDLE_BYTES`. */
  "too-large",
  /** Wrong passphrase — indistinguishable from tampering to AES-GCM, but *usually* this. */
  "bad-passphrase",
  /** The AEAD tag failed in a way that implicates the header binding, not the passphrase. */
  "tampered",
  /** Shorter than `MIN_PASSPHRASE_LENGTH`, refused at export. */
  "weak-passphrase",
  /** Could not read or write the file. */
  "io",
  "unknown",
] as const;

export type PortabilityErrorCode = (typeof PORTABILITY_ERROR_CODES)[number];

/* ────────────────── what the export dialog is choosing FROM ────────────────── */

/**
 * Deliberately NOT declared here. `ExportSource` / `ExportSelectable` /
 * `ExportEnvironmentSummary` live in `portabilityFormat.ts`, which is the module that renders and
 * tests them.
 *
 * They are not part of the bundle — they describe what is on *this* machine, so they never travel
 * and have no place in a wire contract. A second copy declared here (the export dialog needs a
 * `hasValue` flag per variable, and the contract is the reflexive place to reach for) was caught
 * by TypeScript immediately as incompatible with the first. One shape, one home.
 */

