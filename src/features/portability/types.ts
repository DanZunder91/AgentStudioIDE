/** Config-bundle wire contract, the source of truth (Rust `src-tauri/src/portability/` mirrors it).
 * `structure` (default) drops every secret value, `sealed` encrypts them; no mode ever writes them
 * in the clear. `app`/`label` are metadata, not a signature: a bundle is untrusted input. */

/* ─────────────────────────────── the bundle ─────────────────────────────── */

/** The file's discriminator. A JSON file without exactly this is not a bundle. */
export const BUNDLE_KIND = "agentstudio.bundle" as const;

/** The format version. Bumped only for a change a reader cannot absorb. */
export const BUNDLE_VERSION = 1 as const;

export type BundleMode = "structure" | "sealed";

/** Readable without decrypting, so the import dialog can describe a sealed file: counts and a
 * label, never names (`referencedVariables` lives inside the ciphertext). */
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

/** In the clear under `contents` in `structure` mode; the plaintext of `sealed.ciphertextB64` in
 * `sealed` mode. One shape, so the import path cannot drift between modes. */
export interface BundleContents {
  dbConnections: ExportedDbConnection[];
  dbQueries: ExportedDbQuery[];
  apiRequests: ExportedApiRequest[];
  environments: ExportedEnvironment[];
  /** Every `{{VAR}}` referenced, deduped and sorted; computed at export (the exporter knows which
   * references were live) and shown at import as the values to supply. */
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

/** Parameters are in the clear (a decryptor needs them) and recorded, not assumed, so the
 * iteration count can be raised without making older files unreadable. */
export interface SealedPayload {
  kdf: {
    /** `"pbkdf2-hmac-sha256"` — the only value version 1 defines. */
    algorithm: string;
    /** PBKDF2 rounds (600 000 at introduction, OWASP 2023). Weaker than Argon2id against GPUs;
     * chosen as `ring` is already the crypto provider. A weak passphrase is still the weak link. */
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
  /** AEAD additional data is the canonical header (`kind|version|mode|createdAtMs|label`), so a
   * ciphertext cannot be moved into a bundle that describes itself differently. */
  ciphertextB64: string;
}

/* ────────────────────────── the exported records ────────────────────────── */

/** No `createdAt`/`updatedAt` (the importer stamps its own) and no local filesystem paths. */
export interface ExportedDbConnection {
  id: string;
  name: string;
  engine: string;
  host: string;
  /** `null` = the engine's default. See `DbConnection.port` — a mandatory port is what invented
   *  the `:27017` that made an Atlas URI unreachable. */
  port: number | null;
  /** `mongodb+srv://` (DNS seed list). Must travel: without it the import rebuilds a plain
   * single-host `mongodb://host:27017` that cannot reach Atlas. */
  srv: boolean;
  database: string;
  user: string;
  /** `""` or a `{{VAR}}` name. **Never a value** — that is what `environments` is for. */
  passwordRef: string;
  sslMode: string;
  /** The sharer's setting, shown to the recipient; kept only when `forceReadOnly` is off. */
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
  /** Verbatim, including `Authorization`. A value may be a literal secret, not a `{{VAR}}`, so
   * `structure` mode must redact literal-looking secrets and say which (`REDACTED_PLACEHOLDER`). */
  headers: { name: string; value: string }[];
  body: string;
  protocol: string | null;
  grpcService: string | null;
  grpcMethod: string | null;
  plaintext: boolean | null;
}

/** `structure` mode: every `value` is `null` (not exported); `sealed`: the real value. `""`
 * means the variable genuinely holds an empty string. */
export interface ExportedEnvironment {
  id: string;
  name: string;
  variables: { key: string; value: string | null }[];
}

/** A visible marker, not `""`, so an imported request fails loudly instead of sending an empty
 * `Authorization` and getting a confusing 401. */
export const REDACTED_PLACEHOLDER = "{{REDACTED — supply this value}}" as const;

/* ────────────────────────── inspect, then import ────────────────────────── */

/** `portability_inspect`'s dry run; writes nothing. Matching is by `id` (a different item with the
 * same name gets a suffixed name). Lists per item the hosts contacted and variables read: an
 * import can read a secret already held and send it anywhere. No imported request auto-runs. */
export interface ImportPlan {
  header: BundleHeader;
  /** `false` only when the bundle is sealed and no passphrase was supplied (header + counts only).
   * A wrong passphrase rejects with `bad-passphrase` instead: one failure, one shape. */
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
  /** Plan-scoped, unique across kinds: `"<kind>:<native id>"`. Namespaced because
   * `ImportChoices.actions` keys on it alone, and native ids of different kinds can collide. */
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
  /** Defaults to false: taking someone else's value for a variable you use breaks a working
   * setup in a way that is hard to trace back to an import. */
  overwriteExistingSecrets: boolean;
  /** Defaults to `true`, as does Rust's `#[serde(default)]`: an absent field must not mean
   * writable. Off: each connection keeps what the bundle says; the import report records it. */
  forceReadOnly: boolean;
}

/** Not `BundleCounts`: its `referencedVariables` counts names mentioned, while an import result
 * needs the variables written. */
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
  /** No `dbQueryIds`: saved queries travel with their connection (`BundleCounts.dbQueries`). */
  /** Required and non-empty when `mode === "sealed"`; rejected otherwise. */
  passphrase?: string;
}

/** A hard floor enforced in Rust, not only in the dialog: `sealed` mode's value rests on it. */
export const MIN_PASSPHRASE_LENGTH = 12 as const;

/** Bundle size ceiling, so a hostile or accidental multi-hundred-MB file cannot hang the webview. */
export const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;

/* ───────────────────────────── the command surface ───────────────────────────── */

/** Bundle bytes never cross IPC: Rust reads/writes the file at a user-picked path, so sealed
 * plaintext never reaches the webview. `portability_export`/`_inspect`/`_import` reject with
 * `<code>[: detail]` strings using these codes. */
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

