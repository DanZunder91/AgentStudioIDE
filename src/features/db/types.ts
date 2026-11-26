/** Database client wire contract; Rust mirrors it with `rename_all = "camelCase"` and
 * `#[serde(default)]` on every later field. No secret ever appears here (`passwordRef` is "" or a
 * `{{VAR}}`); `null` is SQL NULL and `""` is the empty string. */

/** The driver family behind an engine — what the Rust side switches on. */
export type DbFamily = "postgres" | "mysql" | "clickhouse" | "mongodb" | "redis" | "dynamodb";

/** Some entries are presets, not drivers: Aurora is wire-compatible with its upstream, and
 * `valkey` serves Redis-compatible stores. */
export type DbEngineId =
  | "postgres"
  | "mysql"
  | "aurora-postgres"
  | "aurora-mysql"
  | "clickhouse"
  | "mongodb"
  | "redis"
  | "valkey"
  /** DynamoDB: no connection string (`urlSchemes` is `[]`), no databases or schemas, PartiQL, and
   * read-only is an IAM property, so `serverEnforcedReadOnly` is false. SigV4 is hand-rolled over
   * `reqwest` to avoid the AWS SDK's dependency weight. */
  | "dynamodb";

export type SslMode = "disable" | "prefer" | "require" | "verify-ca" | "verify-full";

/** How long a password may be retained (mirrors JetBrains' "Save: Forever"). */
export type SavePassword = "forever" | "session" | "never";

/** All but the three Rust-owned fields, so a new connection needs no sentinel id or timestamps. */
export type DbConnectionDraft = Omit<DbConnection, "id" | "createdAt" | "updatedAt"> & {
  /** Paste hint: which query param carried the password, since `db_url_parse` discards it. Not on
   * `DbConnection` (the saved `url` carries the placement); Rust uses it only to fill a gap. */
  passwordParam: string | null;
};

/** A saved connection. Persisted in the app config dir — **never** the repo. */
export interface DbConnection {
  /** ULID, minted in Rust on first upsert. */
  id: string;
  name: string;
  engine: DbEngineId;
  /** Denormalised on save so a reader never needs the engine table. */
  family: DbFamily;
  host: string;
  /** `null` = the driver's default, so no untyped port is emitted (`mongodb+srv` forbids one). Rust
   * reads `Option<u16>` with `#[serde(default)]`, so older records still load. */
  port: number | null;
  /** Database / catalog / Redis db index as a string / "". */
  database: string;
  user: string;
  /** **NEVER a secret** — `""` or a `{{VAR}}` Vault reference. */
  passwordRef: string;
  savePassword: SavePassword;
  /** Raw URL override; wins over host/port/database/user. Credentials are split out server-side on
   * save and paste, so it may hold `{{VAR}}` but never a password. */
  url: string | null;
  /** `mongodb+srv://` (DNS seed list, how Atlas is reached). Implies TLS and forbids a port; only
   * the MongoDB family reads it. */
  srv: boolean;
  sslMode: SslMode;
  /** Which CA is in force, without anything exfiltratable; Rust holds the PEM. */
  caSummary: { subjects: string[]; count: number; sha256: string } | null;
  /** No `caPath` on purpose: private-CA support is unimplemented on both sides (`ca_pem` is never
   * populated). Add it to both sides in one commit, with a TLS fixture proving the handshake. */
  /** Per-engine extras; keys validated against the descriptor so a typo can't reach a driver. */
  options: Record<string, string>;

  /* ── guardrails, per connection. Defaults come from the descriptor. ── */
  /** Default **true**. This feature can run arbitrary SQL against production. */
  readOnly: boolean;
  /** Default 500, ceiling 100_000. */
  rowLimit: number;
  /** Default 30_000. */
  timeoutMs: number;
  /** Default **false** — multi-statement execution is opt-in. */
  allowMultiStatement: boolean;

  createdAt: number;
  updatedAt: number;
}

/** Keyed to its connection so a database lists them after a restart. Field names match
 * `src-tauri/src/db/queries.rs` (`sql`, `createdAtMs`, `updatedAtMs`). */
export interface SavedQuery {
  id: string;
  connectionId: string;
  name: string;
  sql: string;
  createdAtMs: number;
  updatedAtMs: number;
}

/** As `tree_order.rs` serialises it. `parentKey` is the frontend's `nodeKey(ref)`, opaque to
 * Rust; `keys` are child labels, unique among siblings. */
export interface DbLevelOrder {
  connectionId: string;
  parentKey: string;
  keys: string[];
}

/** How a column should RENDER. Drives presentation only — never parsing. */
export type DbCellKind =
  | "text"
  | "number"
  | "bool"
  | "json"
  | "binary"
  | "datetime"
  | "unknown";

export interface DbColumn {
  name: string;
  /** The server's own type name, shown verbatim (`varchar(64)`, `Nullable(UInt8)`). */
  typeName: string;
  kind: DbCellKind;
}

export type DbResultKind = "rows" | "affected" | "message";

/** One per statement, so an error in statement 3 still shows 1 and 2; a database error is a
 * `message` result, not a rejection. */
export interface DbResultSet {
  kind: DbResultKind;
  /** Which statement produced this. */
  statement: string;
  columns: DbColumn[];
  /** `null` = SQL NULL, `""` = the empty string — distinguished by construction. */
  rows: Array<Array<string | null>>;
  rowsAffected: number | null;
  /** True iff the row cap cut the result (we read cap+1 and saw the extra row) —
   *  measured, not inferred from `rows.length === rowLimit`. */
  truncated: boolean;
  rowLimit: number;
  durationMs: number;
  /** Server notices/warnings (Postgres NOTICE, MySQL warnings, ClickHouse stats). */
  notice: string | null;
  /** Marks fields a MongoDB document or DynamoDB item omits (not the same as null); same shape as
   * `rows`, and absent on the wire for SQL engines. A masked cell renders as `undefined`. */
  absent?: boolean[][];
}

/* The lazy tree, shaped like `read_dir`/`FsEntry`: one level per call, parent addressed by an
 * opaque ref, so 10k tables cost one page rather than a recursive walk. */

export type DbNodeRef =
  | { kind: "root" }
  | { kind: "database"; name: string }
  | { kind: "schema"; database: string; name: string }
  | {
      kind: "group";
      database: string;
      schema: string | null;
      group: "tables" | "views" | "collections" | "keys";
    }
  | { kind: "table"; database: string; schema: string | null; name: string }
  | { kind: "savedQueries" }
  // Added when Rust grew it: a saved query LEAF carries its id, because "open this one" cannot
  // work from a label — two saved queries may legitimately share a name.
  | { kind: "savedQuery"; id: string };

export interface DbNode {
  /** NOT a unique identity: columns borrow their table's ref, so key rows by ref plus label. */
  nodeRef: DbNodeRef;
  /** "master-api" */
  label: string;
  /** "collections (6)" / "varchar(64)" / "hash · 12 fields" */
  subLabel: string | null;
  kind:
    | "database"
    | "schema"
    | "group"
    | "table"
    | "view"
    | "collection"
    | "column"
    | "key"
    | "savedQuery";
  expandable: boolean;
}

/* The engine registry: one descriptor per engine drives the dialog, so per-engine forms are
 * data rather than conditionals. */

/** No `"password"` kind on purpose: these fields persist to disk in `options`, so it would write
 * a credential to a plaintext file. The real password travels out of band to the Vault. */
export type DbFieldKind = "text" | "number" | "select" | "checkbox";

export interface DbFieldSpec {
  /** Key into `DbConnection.options`, or a top-level field name. */
  key: string;
  label: string;
  kind: DbFieldKind;
  placeholder: string | null;
  /** For `select`. */
  choices: string[] | null;
  /** Pre-filled value, `""` for none (e.g. Mongo's `authSource` is `admin`). */
  default: string;
  required: boolean;
  /** Shown under the field — the *why*, not a restatement of the label. */
  hint: string | null;
}

export interface EngineSpec {
  id: DbEngineId;
  family: DbFamily;
  /** "PostgreSQL", "Amazon Aurora MySQL" */
  label: string;
  defaultPort: number;
  /** URI scheme(s) this engine's connection strings use; first is canonical. */
  urlSchemes: string[];
  /** Whether `database` is meaningful, and what to call it in the UI. */
  databaseLabel: string | null;
  /** Whether the engine authenticates with a user at all (Redis often does not). */
  supportsUser: boolean;
  sslModes: SslMode[];
  /** Engine-specific extras, rendered in order after the common fields. */
  extraFields: DbFieldSpec[];
  /** No `readOnly` on purpose: a new connection is always read-only, and that default must not be
   * weakenable by data. */
  defaults: {
    rowLimit: number;
    timeoutMs: number;
    allowMultiStatement: boolean;
    sslMode: SslMode;
  };
  /** False means read-only is a client-side speed bump only, and the UI must say so. */
  serverEnforcedReadOnly: boolean;
  /** What the editor's "Run" means here — SQL text, a JSON command document, or a
   *  command line — and therefore which highlighting the console uses. */
  queryLanguage: "sql" | "json" | "commandline";
}

/* ───────────────────────────── results of actions ───────────────────────────── */

export interface DbTestResult {
  ok: boolean;
  /** Server version string when reachable — the proof it really connected. */
  serverVersion: string | null;
  latencyMs: number | null;
  /** Present iff `ok` is false. Mapped + **redacted** — drivers echo connection
   *  strings (and therefore passwords) into their error text. */
  error: string | null;
}

/** Returned by `db_url_parse`. On failure the command rejects and the form is left
 *  untouched — a partially-filled form from a half-parsed string is worse than none. */
export interface ParsedUrl {
  engine: DbEngineId | null;
  family: DbFamily | null;
  host: string;
  port: number | null;
  database: string;
  user: string;
  /** True iff the pasted string carried a password. The value is NOT returned (parsing discards
   *  it), and this flag exists so the UI can say so. */
  hadPassword: boolean;
  /** Mirrors Rust's `ParsedUrl.srv`. */
  srv: boolean;
  /** The query param that held the password (`null` = userinfo), so `{{VAR}}` can go back there.
   * sqlx honours only a lowercase `password`; a `?pwd=` is kept as pasted anyway. */
  passwordParam: string | null;
  /** The TLS mode the string asked for, or `null`. Parsed server-side so a pasted
   * `?sslmode=verify-full` cannot diverge from what the SSL control shows. */
  sslMode: SslMode | null;
  /** Credentials removed, ready to display without a `db_url_build` round trip. */
  url: string;
  /** Query parameters we did not consume, preserved verbatim rather than dropped:
   *  `sslmode`, `authSource`, `replicaSet` and friends all change behaviour. */
  options: Record<string, string>;
}

export interface DeleteReport {
  /** Connection removed. */
  removed: boolean;
  /** Saved queries removed with it (cascade). */
  savedQueriesRemoved: number;
}

export interface DbConnectionStore {
  connections: DbConnection[];
  /** Bumped when the on-disk schema changes; a mismatch is a rebuild, not a guess. */
  version: number;
}

/** An opaque handle to an open session. Never a DSN, never a credential. */
export type DbSessionId = string;

/** The session plus what answered, so opening costs one dial, not two. Test Connection stays
 * separate: it checks an unsaved draft, with no session. */
export interface DbOpened {
  sessionId: DbSessionId;
  /** The server's own version string — proof a real round trip happened. */
  serverVersion: string;
  /** How long the whole open took (dial, handshake, auth and probe), in ms. */
  latencyMs: number;
}

/** How `db_query` treats the editor's text. `statement` = the one under the cursor
 *  (the default, and the safe one); `script` = every statement, opt-in per connection. */
export type DbRunMode = "statement" | "script";

/** Wire style `"<code>"` or `"<code>: <detail>"`, detail redacted; the UI maps each to a true
 * sentence. */
export type DbErrorCode =
  /** No such connection / session id. */
  | "not-found"
  /** The config is invalid before we ever dial (missing host, bad port, unknown option). */
  | "invalid-config"
  /** The statement can't run (unparsable, empty, refused as malformed); the connection is fine.
   * Only this code's detail is shown verbatim (`DETAIL_IS_THE_ANSWER` in `dbErrors.ts`). */
  | "invalid-statement"
  /** DNS / refused / unreachable. */
  | "network"
  /** TLS handshake or certificate verification failed. */
  | "tls"
  /** The server rejected the credentials. */
  | "auth"
  /** A `{{VAR}}` reference has nothing behind it in the Vault. */
  | "secret-missing"
  /** The statement was blocked by the read-only guard or the multi-statement guard. */
  | "blocked"
  /** Exceeded `timeoutMs`. */
  | "timeout"
  /** The user cancelled. */
  | "cancelled"
  /** Anything unclassified — so the UI never renders a raw driver string. */
  | "unknown";
