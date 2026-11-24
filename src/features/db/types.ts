/**
 * Database client — the wire contract.
 *
 * ── Why this file exists before any implementation ───────────────────────────
 * The shared wire contract, exactly like `src/features/usage/usageTypes.ts`. That
 * seam earned its keep the hard way: the usage feature's entire data source was
 * ripped out and replaced (a Keychain + HTTP fetch became a CLI shell-out)
 * and **not one line of the frontend changed**, because the contract sat between
 * them. A database client has more moving parts, so the contract is written first
 * and both sides code against it.
 *
 * Rust mirrors these with `#[serde(rename_all = "camelCase")]`, and `#[serde(default)]`
 * on every field added after the first release — the `SavedRequest` protocol-tail rule,
 * so an older persisted file still loads.
 *
 * ── The two invariants worth stating at the top ──────────────────────────────
 * 1. **No secret ever appears in this contract.** `passwordRef` is `""` or a
 *    `{{VAR}}` reference into the Vault; `url` has already had its credentials
 *    split out; a CA certificate crosses as a *summary*, never as PEM. Secrets are
 *    resolved in Rust at connect time and never cross the IPC boundary.
 *    That is stricter than the API client, and it matters: the webview can reach
 *    ~58 commands, so anything it can read is anything an XSS could read.
 * 2. **`null` is SQL NULL; `""` is the empty string.** Every value arrives as
 *    `string | null` and the distinction is structural, not a convention — which is
 *    what lets the whole feature render every column type with zero type-mapping
 *    dependencies.
 */

/** The driver family behind an engine — what the Rust side switches on. */
export type DbFamily = "postgres" | "mysql" | "clickhouse" | "mongodb" | "redis" | "dynamodb";

/**
 * A user-selectable engine. Note that some entries are presets, not drivers:
 * **Aurora** is wire-compatible with its upstream, and a Redis-compatible
 * key-value store is served by the `valkey` preset — a DynamoDB-style
 * key-value store is a genuinely different shape and is tracked separately.
 */
export type DbEngineId =
  | "postgres"
  | "mysql"
  | "aurora-postgres"
  | "aurora-mysql"
  | "clickhouse"
  | "mongodb"
  | "redis"
  | "valkey"
  /**
   * The KVS entry, which means DynamoDB.
   *
   * The one engine with **no connection string** (`urlSchemes` is `[]`, `url` is always `null`), no
   * databases or schemas (a region contains tables), PartiQL instead of SQL, and read-only that is
   * an **IAM** property rather than anything this app can send — so `serverEnforcedReadOnly` is
   * `false` and the badge must not imply a boundary. Signed with AWS SigV4 by hand over the
   * `reqwest` already in the tree, decided on measured dependency weight (the AWS SDK is
   * +38 packages, `aws-sigv4` +15, hand-rolled 0).
   */
  | "dynamodb";

export type SslMode = "disable" | "prefer" | "require" | "verify-ca" | "verify-full";

/** How long a password may be retained (mirrors JetBrains' "Save: Forever"). */
export type SavePassword = "forever" | "session" | "never";

/**
 * What the UI hands to `db_connection_upsert`: everything except the three fields Rust
 * owns. Without it the dialog was forced to invent `id: ""`,
 * `createdAt: 0`, `updatedAt: 0` for a new connection, and sentinel values that mean
 * "the server will fix this" are how a `0` timestamp eventually reaches a UI.
 */
export type DbConnectionDraft = Omit<DbConnection, "id" | "createdAt" | "updatedAt"> & {
  /**
   * WHICH query parameter a pasted URL carried the password in — a **paste hint**, and the
   * only field here that is not a property of the connection.
   *
   * It is on the draft and on `DbConnectionInput`, and deliberately NOT on `DbConnection`:
   * once saved, the placement is carried by the stored `url` itself (`?password={{VAR}}`),
   * so persisting it separately would be a second source of truth that can disagree with
   * the string. Rust reads it as a gap-filler only — a URL that still carries its own
   * parameter wins.
   *
   * Why it has to exist at all: `db_url_parse` strips the credential and **discards the
   * value**, so between the paste and the save there is no `?password=` in the string and
   * nothing else remembers there ever was one. Without this field the `{{VAR}}` landed in
   * the `user:password@` userinfo, silently changing the shape of the string the user
   * pasted — against the rule that `?password=` stays part of the path.
   */
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
  /**
   * The TCP port, or **`null` for "the driver's default"**.
   *
   * 🔴 Optional, and this fixed a real bug rather than being a nicety. It used to be a required
   * `number`, the dialog pre-filled the descriptor's default, and so a port was *always* stored
   * and always emitted into the built connection string. A pasted Atlas URI came out as
   * `mongodb://…:27017/` — a port nobody typed, and for `mongodb+srv` a port is not merely
   * redundant but **invalid**: SRV resolves host and port from DNS, so the URI must not carry one.
   *
   * Backward compatible on disk: Rust reads this as `Option<u16>` with `#[serde(default)]`, so an
   * existing record's number still loads and an absent one becomes `None`.
   */
  port: number | null;
  /** Database / catalog / Redis db index as a string / "". */
  database: string;
  user: string;
  /** **NEVER a secret** — `""` or a `{{VAR}}` Vault reference. */
  passwordRef: string;
  savePassword: SavePassword;
  /**
   * Raw URL override; wins over host/port/database/user when non-null (as JetBrains
   * labels it: *"Overrides settings above"*). Credentials are split out on save and
   * on paste, so this may contain `{{VAR}}` but never a password — that split
   * is the likeliest place this feature could leak a production credential, which is
   * why it is server-side and not a UI courtesy.
   */
  url: string | null;
  /**
   * `mongodb+srv://` — DNS seed-list discovery, which is how MongoDB Atlas is reached.
   *
   * 🔴 Without this field Atlas **could not be connected to at all**: `srv` existed only as a
   * transient field inside Rust's URL parser, so pasting an Atlas URI parsed correctly, filled the
   * form, and then lost the one bit that made it work; the saved record built a plain single-host
   * `mongodb://host:port`, which Atlas does not answer.
   *
   * Implies TLS and forbids a port. Only meaningful for the MongoDB family; other engines ignore it.
   */
  srv: boolean;
  sslMode: SslMode;
  /**
   * Read-only projection of the pinned CA: enough to show the user *which* certificate
   * is in force, and nothing they could exfiltrate. Rust holds the PEM.
   */
  caSummary: { subjects: string[]; count: number; sha256: string } | null;
  /**
   * ⚠️ **There is deliberately NO `caPath` field, and that is a known gap, not an
   * oversight.** Private-CA support is *not implemented on either side*:
   * `ResolvedConfig.ca_pem` exists in Rust and is wired to sqlx's
   * `ssl_root_cert_from_pem`, but nothing populates it, and neither `DbConnection` nor
   * `DbConnectionInput` has a `ca_path` in Rust.
   *
   * A `caPath: string | null` WAS once declared here to close that gap, and made
   * it worse: TypeScript then promised a capability the backend had no field to receive,
   * so every caller dutifully sent `caPath: null` and serde silently dropped it. A typed
   * lie is worse than an absence, because the plumbing reads as finished — which is the
   * exact complaint the comment it replaced was making about `ca_pem`.
   *
   * Re-adding it must land on BOTH sides in one commit, with a
   * TLS-enabled fixture to prove the handshake: a private-CA path that cannot be verified
   * end to end is the same lie with more code. `verify-ca`/`verify-full` against a
   * PUBLIC CA are unaffected and work today.
   */
  /** Per-engine extras (`replicaSet`, `authSource`, `readPreference`, …), keys
   *  validated against the engine descriptor so a typo cannot reach a driver. */
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

/**
 * A query the user saved. Keyed to its connection, so double-clicking a database can list them
 * after a restart — an explicit requirement.
 *
 * ⚠️ **Matches `src-tauri/src/db/queries.rs`, which an earlier version of this type did not.**
 * It declared `text`, `createdAt` and `updatedAt`; Rust sends `sql`, `createdAtMs` and
 * `updatedAtMs`. Nothing caught it because no code had read a `SavedQuery` yet — the field names
 * were written when the backend was still a plan, and a contract nobody has exercised is a
 * hypothesis, not an agreement. Coding to the old shape yielded saved queries whose SQL was
 * `undefined`, which is a failure that arrives as silence.
 */
export interface SavedQuery {
  id: string;
  connectionId: string;
  name: string;
  sql: string;
  createdAtMs: number;
  updatedAtMs: number;
}

/**
 * One tree level's hand-arranged order, exactly as `tree_order.rs` serialises it (tables can
 * be moved into any order the user chooses).
 *
 * `parentKey` is the frontend's own `nodeKey(ref)` string — Rust stores it opaquely rather than
 * re-deriving it, because a second implementation of that identity would be free to disagree
 * with the first. `keys` are child LABELS (table names), which are unique among siblings.
 */
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

/**
 * One statement's outcome. A script yields one of these per statement, so a syntax
 * error in statement 3 still shows the results of statements 1 and 2 — the reason a
 * database error resolves as a `message` result instead of rejecting the call
 * (the `http_send`/`grpc_send` contract: a 500 is a *response*, not an exception).
 */
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
  /**
   * Which cells are **absent** rather than null — when the data has more states than the
   * contract, the output must say so.
   *
   * A cell has two states and two engines have three: a MongoDB document and a DynamoDB item can
   * *omit* a field entirely, which is a different fact from holding null. Those engines used to
   * report the loss in `notice` and let the grid paint NULL, which is the app asserting something
   * the data does not say.
   *
   * So `absent[row][col] === true` marks a missing field. Same shape as `rows`. **Absent from the
   * wire entirely** for the six engines that cannot produce the state (a SQL row is a fixed tuple),
   * which is why it is optional rather than `boolean[][] | null`.
   *
   * Rendering needed nothing new: `renderCell(undefined)` has always produced a `missing` display
   * distinct from `null`, so the mask's only job is to turn a masked cell into `undefined`.
   */
  absent?: boolean[][];
}

/* ────────────────────────── the lazy tree ──────────────────────────
 * Deliberately shaped like `read_dir`/`FsEntry`: one level per call, the parent
 * addressed by an opaque ref. The Files tree already proves this pattern against a
 * 100k-entry repo, and it means a database with 10k tables costs one page, not a
 * recursive walk. */

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
  /**
   * ⚠️ **`nodeRef`, not `ref`** — matches `src-tauri/src/db/tree.rs`. The old
   * name here would have produced a tree of `undefined` labels.
   *
   * 🔴 **It is NOT a unique node identity.** `DbNode::column` deliberately borrows its table's ref
   * (a column has nothing fetchable below it), so every column of a 40-column table arrives with
   * the *same* `nodeRef`. A consumer keying React rows or an expansion map by it renders one
   * column and silently drops thirty-nine. Key rows by ref **plus label**. This is documented at
   * Rust's `column` constructor too, which is not where a frontend author looks.
   */
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

/* ───────────────────── the engine registry, as the UI sees it ─────────────────────
 * One descriptor per engine drives the whole dialog, so the requirement of a form
 * that is accurate for each engine is data rather than a pile of conditionals —
 * a Mongo form grows `replicaSet`/`readPreference`, a Redis form has no `user`. Same
 * shape as the LSP registry + its frontend mirror (`lsp/languages.ts`). */

/**
 * What control renders a descriptor field.
 *
 * ⚠️ There is deliberately **no `"password"`** kind. Every field described by a
 * `DbFieldSpec` lands in `DbConnection.options`, which is **persisted to disk**, so a
 * password-kind extra field would write a credential into a plaintext file — the exact
 * failure that keeping every secret out of the connection file exists to prevent. The one
 * real password is the top-level one, and it is
 * not an `options` key at all: it travels out of band and lives in the Vault.
 * (Removed after the dialog implementation had to defensively refuse it —
 * a type that invites the mistake is a worse defence than a type that cannot express it.)
 */
export type DbFieldKind = "text" | "number" | "select" | "checkbox";

export interface DbFieldSpec {
  /** Key into `DbConnection.options`, or a top-level field name. */
  key: string;
  label: string;
  kind: DbFieldKind;
  placeholder: string | null;
  /** For `select`. */
  choices: string[] | null;
  /**
   * Pre-filled value, `""` for none. The Rust descriptor already knows that Mongo's
   * `authSource` is `admin`; without this the UI could not offer it, and a fresh Mongo
   * form was invalid until the user typed a value the registry already had.
   */
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
  /**
   * Defaults for the per-connection guardrails.
   *
   * ⚠️ `readOnly` is deliberately **absent**. A NEW connection is read-only
   * unconditionally, and letting an engine descriptor say `false` would make the single
   * most important safety default weakenable by data — the implementation had to
   * override it to stay correct, which is the signal that it should not be expressible.
   * An engine that cannot *enforce* read-only server-side declares that through
   * `serverEnforcedReadOnly`, which changes what the UI promises, not what it defaults to.
   */
  defaults: {
    rowLimit: number;
    timeoutMs: number;
    allowMultiStatement: boolean;
    sslMode: SslMode;
  };
  /**
   * Whether **server-enforced** read-only exists for this engine. False means the
   * read-only flag is a client-side speed bump only, and the UI must say so rather
   * than implying a guarantee it cannot make.
   */
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
  /** True iff the pasted string carried a password. The value is NOT returned —
   *  it goes straight to the Vault, and this flag exists so the UI can say so. */
  hadPassword: boolean;
  /**
   * WHICH query parameter carried the password (`"password"`, `"pwd"`, …), or `null` when
   * it came from the `user:password@` userinfo instead.
   *
   * ⚠️ The rule — `?password=` stays part of the path, as in every
   * database system — is honoured on the path that sends a raw
   * string as `url`, but the **paste** path used to lose it: `parse` strips the parameter, the
   * dialog rebuilds from fields, and the `{{VAR}}` came back in the userinfo instead. That
   * silently moves a credential to a different place in the string, which is exactly the
   * concern the old (over-cautious) refusal was built around. Carrying the name here is
   * what lets the dialog put it back where the user typed it.
   *
   * Honest caveat, measured in sqlx-postgres 0.9's `options/parse.rs`: drivers honour only
   * the exact lowercase `password`, logging `ignoring unrecognized connect parameter` for
   * anything else. So a `?pwd=` round-trips faithfully and still will not authenticate —
   * a property of the pasted string, not of our handling. Renaming it to `password` to
   * "fix" that would change what the string means, so we do not.
   */
  /**
   * `mongodb+srv://` — the scheme the pasted string actually used.
   *
   * Mirrors Rust's `ParsedUrl.srv`. Without it the dialog would have to sniff
   * `mongodb+srv` back out of `ParsedUrl.url` — UI guesswork about a structural fact, which is
   * exactly what this contract already refuses for `sslMode`.
   */
  srv: boolean;
  passwordParam: string | null;
  /**
   * The TLS mode the string asked for, or `null` when it said nothing.
   *
   * ⚠️ The most important of these fields. Without it a
   * pasted `?sslmode=verify-full` arrived as an ordinary entry in `options` while the SSL
   * control kept reading `prefer` — a **silent security divergence**, where the form
   * claims one TLS posture and the connection uses another. The implementation had to
   * guess by sniffing `options` for a `sslmode` key, which is UI guesswork about a
   * security setting; parsing it is the server's job and it belongs in the contract.
   */
  sslMode: SslMode | null;
  /**
   * The string rewritten with credentials removed, ready to display. Saves the dialog a
   * round trip back through `db_url_build` just to render what the parser already had.
   */
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

/**
 * What a successful `db_open` returns — the session **and what answered**.
 *
 * 🔴 A performance fix rather than a nicety. Opening a connection used
 * to cost **two complete dials**: `db_test_connection` (dial, probe, close) purely to learn the
 * server version, then `db_open` (dial again). Two DNS lookups, two TLS handshakes, two
 * authentications, the first thrown away. Invisible against a local Postgres; against a remote
 * MongoDB Atlas cluster it roughly doubled the time to open.
 *
 * Test Connection remains its own command: it answers a question about an *unsaved draft* in the
 * dialog, where there is no session to open.
 */
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

/**
 * Stable error codes from the db commands, in the stable wire style (`"<code>"` or
 * `"<code>: <detail>"`, detail always redacted). The panel must be able to say
 * something TRUE and specific, and inventing a cause is never an option.
 */
export type DbErrorCode =
  /** No such connection / session id. */
  | "not-found"
  /** The config is invalid before we ever dial (missing host, bad port, unknown option). */
  | "invalid-config"
  /**
   * The **statement** cannot be run — it does not parse, it is empty, or the server refused it as
   * malformed. The connection is fine.
   *
   * 🔴 Exists to fix a misattribution. `invalid-config` used to carry both "your
   * settings are wrong" and "your statement is wrong", and since this file's job is to let the UI
   * map a code to one true sentence, the two collapsed into the *settings* sentence: SQL typed
   * into a MongoDB console produced *"check the host, the port, and the settings this engine
   * requires"* — about a connection that had just connected. Two problems with different fixes
   * cannot share a code.
   *
   * For this code — and only this code — the rejection's **detail is rendered verbatim** rather
   * than replaced by a sentence of ours (`dbErrors.ts`'s `DETAIL_IS_THE_ANSWER`): Rust's message
   * is written for the person who typed the statement and names the shape it wanted, which is
   * more than a code can carry. Where an engine parses before dialling, it should prefer a
   * `message` **result** to a rejection entirely — a syntax error is an outcome, not an exception.
   */
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
