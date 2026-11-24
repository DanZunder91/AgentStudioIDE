/**
 * engineFields — the pure logic behind the database client's connection dialog.
 *
 * ── Why this file exists ─────────────────────────────────────────────────────
 * The requirement is that the configuration form be accurate for each
 * database engine. That is a **data** problem, not a rendering problem, so every decision
 * about *which* fields a given engine shows, what they are called, whether they are
 * required, and what happens to them when the engine changes lives here — as pure
 * functions over an `EngineSpec` and a draft. `ConnectionDialog.tsx` renders the
 * list it is handed and owns no per-engine knowledge whatsoever: adding ClickHouse
 * means adding a descriptor in Rust, never editing JSX or this file.
 *
 * Everything here is DOM-free and IPC-free, so it is unit-testable without a
 * renderer — which is the point: the risky logic (validation, the engine-switch
 * preservation rule, secret redaction) is tested directly rather than through a
 * component.
 *
 * ── The secret rules, stated where the code enforces them ────────────────────
 * 1. **`DbDraft` has no password field, by construction.** The typed password lives
 *    in React state in the dialog and is passed as a *separate argument* to
 *    `onTest`/`onSave`. `toRecord()` therefore *cannot* emit a secret: there is
 *    nothing in its input to emit. `passwordRef` (`""` or `{{VAR}}`) is a reference,
 *    not a value (the connection file holds no secret), and is the only password-shaped
 *    thing the draft carries.
 * 2. **`redactSecret` is defence in depth, not the mechanism.** Rust is responsible
 *    for never emitting a password. This scrubs anyway — in both the
 *    literal and percent-encoded forms — because a URL preview and a driver error
 *    are exactly the two strings that have leaked credentials in every other tool.
 *
 * A third rule used to live here — "an engine descriptor may not ask for a secret in
 * `options`" — implemented as a defensive refusal of `DbFieldKind: "password"`. The
 * kind was removed from the contract instead, so the rule is now carried
 * by the type system rather than by code that could be deleted by accident. Same story
 * for `EngineSpec.defaults.readOnly`: `newDraft` used to override a descriptor that
 * said `false`, and now no descriptor can say it.
 */

import type {
  DbConnection,
  DbConnectionDraft,
  DbEngineId,
  DbFieldKind,
  DbFieldSpec,
  DbTestResult,
  EngineSpec,
  ParsedUrl,
  SavePassword,
  SslMode,
} from "./types";

/* ────────────────────────────── the draft ────────────────────────────────── */

/**
 * The dialog's working copy of a connection.
 *
 * Numeric fields are held as **text**, deliberately: a half-typed port ("54") and
 * an emptied one ("") are states a `number` cannot represent, and coercing them to
 * `0`/`NaN` mid-keystroke is how a form starts fighting its user. `toRecord`
 * does the single conversion, at save time, after `validateDraft` has agreed.
 *
 * Note what is absent. **No password** — see the header; that omission is the
 * enforcement mechanism, not an oversight. And **no `id`/`createdAt`/`updatedAt`**:
 * those belong to Rust (`DbConnectionDraft` omits them), so the dialog no longer
 * carries `""`/`0` sentinels for values it has no business inventing.
 */
export interface DbDraft {
  name: string;
  engine: DbEngineId;
  host: string;
  /**
   * The port as typed, **`""` for "the driver's default"** — and `""` is what a fresh draft
   * holds. It used to be pre-filled with `spec.defaultPort`, which is how an Atlas
   * URI ended up as `mongodb://…:27017/`: a port nobody typed, and one a `mongodb+srv`
   * URI may not carry at all. The descriptor's default is now a **placeholder**, so the box
   * shows `27017` in grey and stores nothing until someone types.
   */
  port: string;
  database: string;
  user: string;
  /** `""` or a `{{VAR}}` Vault reference. Never a value. */
  passwordRef: string;
  savePassword: SavePassword;
  /** A stored URL override, passed through verbatim — see `URL_OVERRIDE_NOTE`. */
  url: string | null;
  /** Which query parameter a pasted URL carried the password in — see `DbConnectionDraft`. */
  passwordParam: string | null;
  /** `mongodb+srv://` — DNS seed-list discovery (Atlas). See `DbConnection.srv`. */
  srv: boolean;
  sslMode: SslMode;
  options: Record<string, string>;
  readOnly: boolean;
  rowLimit: string;
  timeoutMs: string;
  allowMultiStatement: boolean;
  caSummary: DbConnection["caSummary"];
}

/* ───────────────────────────── field rows ────────────────────────────────── */

/** Where a row's value lives: a top-level `DbDraft` key, or `options[key]`. */
export type FieldScope = "connection" | "option";

/**
 * Which disclosure a row belongs to — the answer to the dialog showing too many confusing
 * things.
 *
 * **The split is data-driven, and it has to be**: `basic` is the fields you cannot connect
 * without, `advanced` is everything else, and the only thing that decides is the descriptor
 * (`DbFieldSpec.required`). A hardcoded per-engine list would be correct for six engines and
 * wrong for the seventh, and nobody would notice — the same argument that made the whole form
 * `engineFieldRows(spec, draft).map(...)` in the first place.
 *
 * So: the common connection fields are `basic`; a **required** extra is `basic` (a save that
 * blocks on a field hidden behind a collapsed section is a dead end); every optional extra and
 * the SSL select are `advanced`.
 */
export type FieldGroup = "basic" | "advanced";

/** One rendered form control. The dialog maps these 1:1 to inputs. */
export interface FieldRow {
  key: string;
  scope: FieldScope;
  group: FieldGroup;
  label: string;
  kind: DbFieldKind;
  placeholder: string | null;
  choices: string[] | null;
  required: boolean;
  /**
   * Rendered **under** the control, and reserved for what changes the meaning of the state the
   * user is looking at right now — currently only "this port is inert because the connection is
   * a DNS seed list". The descriptor's own prose is NOT here; it is `tip`.
   */
  hint: string | null;
  /**
   * The control's `title` — the descriptor's explanation, on hover.
   *
   * The dialog used to render every `DbFieldSpec.hint` as a paragraph under its field, which is
   * how eleven controls became eleven controls plus eleven sentences. The words were not the
   * problem; rendering all of them at once was. `title` keeps them one gesture away (and
   * assistive technology still announces it when there is no `aria-describedby`), so the form
   * reads as a form.
   */
  tip: string | null;
  /** True when the control is inert: the URL governs, or a port is invalid here. */
  disabled: boolean;
  /** Always a string, so every input is controlled and never flips to uncontrolled. */
  value: string;
}

export const MAX_PORT = 65535;
export const MAX_ROW_LIMIT = 100_000;
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 600_000;

/** What a redacted secret renders as. */
export const SECRET_MASK = "••••";

/** Client-side ceiling on Test Connection, so the pending state cannot hang. */
export const TEST_TIMEOUT_MS = 15_000;

/** The dialog's DOM id for a field, so errors and labels can point at it. */
export function fieldDomId(key: string): string {
  return `db-field-${key}`;
}

/* ──────────────────────────────── the connection type ────────────────────────────────────────
 * The dialog follows four rules (see `ConnectionDialog.tsx`): among them, the URL is editable,
 * no port nobody entered is added, and a URL, a user and a password are enough to connect.
 * Three of those four depend on this control: without it the dialog could show only a
 * `readOnly` box captioned "Derived from the fields above".
 *
 * ── Why ONE select and not a select plus an SRV checkbox ─────────────────────────────────────
 * The two shapes are not equivalent. A `Fields | URL only` select next to an `SRV` checkbox can
 * express **`URL only` + `SRV`**, which is a contradiction: in URL-only mode the string's own
 * scheme is what decides whether the connection is a DNS seed list, so the checkbox is either
 * ignored (a control that lies) or fights the string (a control that edits it behind your back).
 * A single select cannot represent the contradiction at all — the same reason `DbFieldKind` has
 * no `password` variant and `EngineSpec.defaults` has no `readOnly`: a state that must not exist
 * is best made unrepresentable rather than defended against.
 *
 * ── Why the mode is DERIVED rather than stored ───────────────────────────────────────────────
 * `DbConnection` already carries the two bits the mode is made of — `url` (non-null = it wins,
 * which is what Rust's `resolve_from_*`/`engine.rs` actually do) and `srv`. A third stored field
 * saying which of them is in charge could disagree with them, and then the dialog and the
 * connection would be describing different connections. So the mode is a *reading* of the draft,
 * and choosing a mode writes those same two bits. One consequence is deliberate and good:
 * **typing in the URL box moves the select to `URL only` by itself**, because a non-empty URL
 * genuinely is what connects. The control explains the override instead of hiding it. */

/** Where a connection's configuration comes from. Derived — see the note above. */
export type DbConnectMode = "fields" | "srv" | "url";

/**
 * The engine's DNS-seed-list scheme (`mongodb+srv`), or `null` for an engine that has none.
 *
 * Read off `EngineSpec.urlSchemes`, so SRV is offered exactly where the **descriptor** says it
 * exists. That is the difference between this and `if (engine === "mongodb")`: the day a second
 * engine grows a `+srv` scheme, its row in `engines.rs` is the whole change.
 */
export function srvScheme(spec: EngineSpec): string | null {
  return spec.urlSchemes.find((s) => s.endsWith("+srv")) ?? null;
}

/**
 * Whether this draft is a DNS seed list **on this engine** — the single place that decides.
 *
 * `draft.srv` alone is not enough: a saved Mongo connection re-opened under an engine with no
 * SRV scheme (an unrecognised engine falls back to the first offered one — `initialEngine`)
 * would otherwise claim a mode its driver has never heard of.
 */
export function isSrv(spec: EngineSpec, draft: DbDraft): boolean {
  return srvScheme(spec) !== null && draft.srv;
}

/** Which mode the draft is in. `url` wins because a non-empty `url` is what Rust connects with. */
export function connectMode(spec: EngineSpec, draft: DbDraft): DbConnectMode {
  // 🔴 An engine with no connection string can never be in `url` mode, whatever the draft says.
  // Without this guard a `url` left over from switching engines — the dialog keeps the draft when
  // you change the Driver dropdown — puts a schemeless engine into a mode whose every control is
  // inert, showing a `user@host/database` box and refusing to save with "Host is required".
  // DynamoDB (no DSN) used to hit exactly this, unnoticed because no test rendered its dialog.
  if (!hasConnectionString(spec)) return "fields";
  if (draft.url !== null) return "url";
  return isSrv(spec, draft) ? "srv" : "fields";
}

/**
 * Whether this engine is addressed by a DSN at all.
 *
 * The single test behind every "should the connection-string affordance exist" decision, so the
 * mode list, the mode guard and the dialog's section cannot disagree about it.
 */
export function hasConnectionString(spec: EngineSpec): boolean {
  return spec.urlSchemes.length > 0;
}

/**
 * The modes this engine offers. `SRV` appears only where the descriptor declares the scheme.
 *
 * Labels say what the mode *is*: a first option called "default" would tell a confused user
 * nothing at the moment they are looking for the reason a port appeared.
 */
export function connectModeChoices(
  spec: EngineSpec,
): ReadonlyArray<{ value: DbConnectMode; label: string }> {
  const out: Array<{ value: DbConnectMode; label: string }> = [
    { value: "fields", label: "Host and port" },
  ];
  if (srvScheme(spec) !== null) out.push({ value: "srv", label: "DNS seed list (SRV)" });
  // 🔴 Only where a connection string exists. Offering "URL only" for an engine that has no DSN
  // hands the user a mode that cannot work — see `connectMode`'s note.
  if (hasConnectionString(spec)) out.push({ value: "url", label: "URL only" });
  return out;
}

/**
 * Choose a mode. `seed` is the string `URL only` starts from — the derived preview, or the URL
 * the user had typed before they switched away, so a mode switch is never a silent delete.
 *
 * Leaving `URL only` sets `url` to `null` rather than `""`: `null` means "no override" and `""`
 * means "URL only, nothing typed yet". Both states are real and the difference is what makes
 * `connectMode` a total function over the draft instead of a guess.
 */
export function setConnectMode(draft: DbDraft, mode: DbConnectMode, seed: string | null): DbDraft {
  switch (mode) {
    case "url":
      return { ...draft, url: draft.url ?? seed ?? "" };
    case "srv":
      return { ...draft, url: null, srv: true };
    default:
      return { ...draft, url: null, srv: false };
  }
}

/**
 * What the URL box's text does to the draft. **Blank clears the override** rather than storing
 * `""`, so emptying the box hands the connection back to the fields — otherwise clearing it
 * would leave the user in URL-only mode with a blocking "a connection string is required".
 */
export function setUrlText(draft: DbDraft, text: string): DbDraft {
  return { ...draft, url: text.trim() === "" ? null : text };
}

/** The note under the URL box: what this string is, in one line. */
export const URL_OVERRIDE_NOTE =
  "Overrides the fields above — Agent Studio sends this string to the driver as-is. A password " +
  "typed above is substituted into its {{VAR}} reference.";

/** The same, for the derived direction. */
export const URL_DERIVED_NOTE =
  "Derived from the fields. Edit it to take over — a URL that is not empty is what connects.";

export function urlHint(mode: DbConnectMode): string {
  return mode === "url" ? URL_OVERRIDE_NOTE : URL_DERIVED_NOTE;
}

/**
 * Said under the connection-type select in `URL only` mode.
 *
 * ⚠️ The old sentence was **false in a way that cost a connection**.
 * It read *"The fields below are kept for reference and are not used."* — true of host, port,
 * database and user, and flatly untrue of the **password**, which is exactly the field a
 * URL-only connection most often has to supply: `db_url_parse` strips a pasted credential and
 * never returns it, so {@link PASSWORD_MOVED_NOTICE} tells the user, a few centimetres lower
 * down, to type it into the Password field. One dialog, two sentences, contradicting each
 * other — and a user who believed the one at the top saved a connection with no
 * credential at all.
 *
 * So it now says which fields the string governs and which one it does not. Not "mostly not
 * used": a caveat a user has to reconstruct is the same failure in a politer voice.
 */
export const URL_MODE_NOTE =
  "The connection string decides the host, port, database and user — the fields below are " +
  "kept for reference. The Password field is still used: it fills the gap when the string " +
  "carries no credential of its own.";

/** Said under the connection-type select when the mode changes what the other controls mean. */
export function connectModeNote(spec: EngineSpec, mode: DbConnectMode): string | null {
  const srv = srvScheme(spec);
  if (srv !== null && mode === "srv") {
    return (
      `\`${srv}://\` resolves the hosts, the port and the replica set from DNS, so no port is ` +
      `sent. This is how MongoDB Atlas is reached.`
    );
  }
  if (mode === "url") return URL_MODE_NOTE;
  return null;
}

/**
 * Why the port box is inert for a DNS seed list, or `null`.
 *
 * It says **invalid**, not "unnecessary", because that is the fact: `mongodb+srv://host:27017/`
 * is rejected by the driver, which is why `DbConnection.port` had to become nullable rather than
 * merely defaulting well.
 */
export function srvPortHint(spec: EngineSpec, draft: DbDraft): string | null {
  const srv = srvScheme(spec);
  return srv !== null && draft.srv
    ? `A \`${srv}://\` URI must not carry a port — DNS supplies it.`
    : null;
}

/** Why the port box may be left empty. A `title`, not a rendered line — the placeholder shows it. */
export function portTip(spec: EngineSpec): string {
  return `Leave empty for ${spec.defaultPort}, this engine's default.`;
}

/**
 * The full form for an engine: the common fields, then the descriptor's extras **in
 * declared order**. Five shapes are engine-driven rather than conditional:
 *   - `databaseLabel: null` hides the database field (and renames it otherwise);
 *   - `supportsUser: false` hides the user field (Redis, pre-ACL);
 *   - `sslModes: []` hides the SSL select instead of offering an empty one;
 *   - `defaultPort` is the port's **placeholder**, never its value;
 *   - `DbFieldSpec.required` decides whether an extra is basic or advanced (`FieldGroup`).
 *
 * Two things the mode decides, and nothing else in this file:
 *   - in `url` mode every control except **Name** is inert — the string governs, and a field
 *     that silently stops mattering is a UX trap. Name is ours, not the URL's;
 *   - in `srv` mode the port is inert and says why.
 */
export function engineFieldRows(spec: EngineSpec, draft: DbDraft): FieldRow[] {
  const mode = connectMode(spec, draft);
  const inert = mode === "url";
  const rows: FieldRow[] = [
    {
      key: "name",
      scope: "connection",
      group: "basic",
      label: "Name",
      kind: "text",
      placeholder: "Production (read-only)",
      choices: null,
      required: true,
      hint: null,
      tip: null,
      disabled: false,
      value: draft.name,
    },
    {
      key: "host",
      scope: "connection",
      group: "basic",
      label: "Host",
      kind: "text",
      placeholder: "localhost",
      choices: null,
      required: true,
      hint: null,
      tip: null,
      disabled: inert,
      value: draft.host,
    },
  ];

  rows.push({
      key: "port",
      scope: "connection",
      group: "basic",
      label: "Port",
      kind: "number",
      // The descriptor's default, as a PLACEHOLDER. See `DbDraft.port`: pre-filling it is what
      // put `:27017` into an Atlas URI that must not have one.
      placeholder: String(spec.defaultPort),
      choices: null,
      required: false,
      hint: srvPortHint(spec, draft),
      tip: portTip(spec),
      disabled: inert || isSrv(spec, draft),
      value: draft.port,
  });

  if (spec.databaseLabel !== null) {
    rows.push({
      key: "database",
      scope: "connection",
      group: "basic",
      label: spec.databaseLabel,
      kind: "text",
      placeholder: null,
      choices: null,
      required: false,
      hint: null,
      tip: null,
      disabled: inert,
      value: draft.database,
    });
  }

  if (spec.supportsUser) {
    rows.push({
      key: "user",
      scope: "connection",
      group: "basic",
      label: "User",
      kind: "text",
      placeholder: null,
      choices: null,
      required: false,
      hint: null,
      tip: null,
      disabled: inert,
      value: draft.user,
    });
  }

  if (spec.sslModes.length > 0) {
    rows.push({
      key: "sslMode",
      scope: "connection",
      group: "advanced",
      label: "SSL mode",
      kind: "select",
      placeholder: null,
      choices: spec.sslModes,
      required: false,
      hint: null,
      tip: "How much of the server's certificate is verified.",
      disabled: inert,
      value: draft.sslMode,
    });
  }

  for (const f of spec.extraFields) {
    rows.push({
      key: f.key,
      scope: "option",
      group: f.required ? "basic" : "advanced",
      label: f.label,
      kind: f.kind,
      placeholder: f.placeholder,
      choices: f.choices,
      required: f.required,
      hint: null,
      // The descriptor's prose becomes a tooltip. Eleven fields with eleven paragraphs under
      // them is what made the dialog confusing.
      tip: f.hint,
      disabled: inert,
      value: draft.options[f.key] ?? "",
    });
  }

  return rows;
}

/**
 * Whether the Advanced section must open on its own: something in it is not what a fresh draft
 * for this engine would hold.
 *
 * A user editing a saved connection must not have to hunt for the setting they set — a collapsed
 * section that hides a `verify-full` they chose, or a `searchPath` they typed, is the same class
 * of failure as a field that silently stops mattering. Compared against the **descriptor's** own
 * defaults, so it stays data-driven: nothing here knows what a `searchPath` is.
 */
export function advancedIsDirty(spec: EngineSpec, draft: DbDraft): boolean {
  if (spec.sslModes.length > 0 && draft.sslMode !== spec.defaults.sslMode) return true;
  return spec.extraFields.some(
    (f) => !f.required && (draft.options[f.key] ?? "") !== f.default,
  );
}

/**
 * Apply a row's new value to the draft. The `default` arm is `sslMode` rather than a
 * no-op bail-out on purpose: the connection-scoped key set is **closed** and produced
 * only by `engineFieldRows` above, so an unreachable `default` would be dead code
 * pretending to be a guard.
 */
export function setRowValue(draft: DbDraft, row: FieldRow, value: string): DbDraft {
  if (row.scope === "option") {
    return { ...draft, options: { ...draft.options, [row.key]: value } };
  }
  switch (row.key) {
    case "name":
      return { ...draft, name: value };
    case "host":
      return { ...draft, host: value };
    case "port":
      return { ...draft, port: value };
    case "database":
      return { ...draft, database: value };
    case "user":
      return { ...draft, user: value };
    default:
      return { ...draft, sslMode: value as SslMode };
  }
}

/** Drop an unrecognised option key the user chose to remove. */
export function removeOption(draft: DbDraft, key: string): DbDraft {
  const options = { ...draft.options };
  delete options[key];
  return { ...draft, options };
}

/* ─────────────────────────── draft construction ──────────────────────────── */

/**
 * The descriptor's own values for option keys the record does not already carry.
 *
 * A key that IS present is left alone even when its value is `""` — the user having
 * cleared `authSource` is a decision, and re-filling it on the next render would be the
 * form arguing with them. Which is why this seeds at draft construction and at an
 * engine switch, and never per render.
 */
function seedDefaults(spec: EngineSpec, existing: Record<string, string>): Record<string, string> {
  const out = { ...existing };
  for (const f of spec.extraFields) {
    if (f.default !== "" && !(f.key in out)) out[f.key] = f.default;
  }
  return out;
}

/**
 * A draft for `initial` (or a blank one when `initial` is null).
 *
 * **`readOnly` starts `true` for a new connection.** The rule is unconditional — "read-only
 * defaults to true on every new connection" — and this dialog will not render an
 * unchecked read-only box for a brand-new connection to a production database. It used
 * to have to override a descriptor that said otherwise; `EngineSpec` can no longer say
 * it. An *existing* connection keeps whatever the user deliberately saved.
 *
 * Option defaults are **seeded as real values**, not merely displayed: the alternative
 * (show `admin`, store `""`) would send the driver nothing while the form claimed
 * otherwise, and would leave a required-and-defaulted field permanently "invalid".
 *
 * **The port is the exception, and it is the whole point.** `spec.defaultPort` is NOT seeded
 * here: a seeded default is indistinguishable from a value the user chose, so it was persisted
 * and emitted into every connection string — a port nobody had entered. It is a placeholder
 * in `engineFieldRows` instead, and a `null` port on the record means "whatever the driver's
 * default is".
 */
export function newDraft(spec: EngineSpec, initial: Partial<DbConnection> | null): DbDraft {
  const d = initial ?? {};
  return {
    name: d.name ?? "",
    engine: spec.id,
    host: d.host ?? "",
    port: String(d.port ?? ""),
    database: d.database ?? "",
    user: d.user ?? "",
    passwordRef: d.passwordRef ?? "",
    savePassword: d.savePassword ?? "forever",
    url: d.url ?? null,
    // Always null, and `Partial<DbConnection>` correctly has no such key to read: a SAVED
    // connection's placement is carried by its own `url`, and the hint only exists between
    // a paste and the save that follows it.
    passwordParam: null,
    srv: d.srv ?? false,
    sslMode: d.sslMode ?? spec.defaults.sslMode,
    options: seedDefaults(spec, d.options ?? {}),
    readOnly: d.readOnly ?? true,
    rowLimit: String(d.rowLimit ?? spec.defaults.rowLimit),
    timeoutMs: String(d.timeoutMs ?? spec.defaults.timeoutMs),
    allowMultiStatement: d.allowMultiStatement ?? spec.defaults.allowMultiStatement,
    caSummary: d.caSummary ?? null,
  };
}

/**
 * Whether the dialog is editing a saved connection or creating one. Derived from
 * `initial` rather than from the draft, because the draft no longer carries an `id` —
 * that is Rust's to mint (`DbConnectionDraft`).
 */
export function isExisting(initial: Partial<DbConnection> | null): boolean {
  return (initial?.id ?? "") !== "";
}

/**
 * Which engine a dialog opens with: the one `initial` names, else the first offered.
 * `null` means the caller handed us no engines at all — the dialog says so rather
 * than rendering a form that cannot describe anything.
 */
export function initialEngine(
  engines: EngineSpec[],
  initial: Partial<DbConnection> | null,
): EngineSpec | null {
  if (engines.length === 0) return null;
  return engines.find((e) => e.id === initial?.engine) ?? engines[0];
}

/**
 * The one thing `newDraft` cannot say for itself: a saved connection naming an engine
 * this build does not offer opened as something else. Silently retyping a Mongo
 * connection as Postgres would be exactly the kind of quiet substitution this feature
 * cannot afford.
 */
export function initialNotices(
  spec: EngineSpec,
  initial: Partial<DbConnection> | null,
): string[] {
  if (initial?.engine !== undefined && initial.engine !== spec.id) {
    return [
      `This connection names the engine "${initial.engine}", which this build does not offer. ` +
        `It opened as ${spec.label} — check every field before you save.`,
    ];
  }
  return [];
}

/**
 * The draft as a persistable record. `DbConnectionDraft` omits `id`/`createdAt`/
 * `updatedAt` — Rust mints and owns those — so this function has no sentinels to
 * invent and no timestamps to accidentally zero.
 *
 * Three honesty rules live here rather than in the component:
 *   - `family` comes from the descriptor, so the denormalised copy can never disagree
 *     with `engine`;
 *   - fields the engine does not define are written as `""`, so a `user` typed before
 *     switching to Redis is preserved in the *draft* (an accidental engine click costs
 *     nothing) but is never *persisted* as data the engine ignores. `srv` follows the same
 *     rule — an engine with no `+srv` scheme never stores the flag;
 *   - the guardrail numbers fall back to the descriptor default rather than `NaN`.
 *     `validateDraft` blocks the save first; this is what makes the fallback unreachable in
 *     practice instead of load-bearing. **The port does not fall back** — an unparseable or
 *     empty port is `null`, "the driver's default", because inventing one here is the bug.
 */
export function toRecord(spec: EngineSpec, draft: DbDraft): DbConnectionDraft {
  const srv = isSrv(spec, draft);
  return {
    name: draft.name.trim(),
    engine: spec.id,
    family: spec.family,
    host: draft.host.trim(),
    // `null` for SRV is not tidiness: a `mongodb+srv://` URI carrying a port is refused by the
    // driver, so the invalid pairing must be impossible to persist, not merely discouraged.
    port: srv ? null : wholeNumber(draft.port),
    database: spec.databaseLabel === null ? "" : draft.database.trim(),
    user: spec.supportsUser ? draft.user.trim() : "",
    passwordRef: draft.passwordRef,
    savePassword: draft.savePassword,
    // A blank box is NO override. Rust filters the same way (`upsert`'s
    // `.filter(|u| !u.trim().is_empty())`), and agreeing here keeps "URL only with nothing
    // typed" a validation error rather than an empty string that silently connects nowhere.
    url: draft.url === null || draft.url.trim() === "" ? null : draft.url.trim(),
    // `mongodb+srv` — carried, never inferred. See `DbConnection.srv`: it used to live only inside
    // Rust's parser, so an Atlas URI lost the one bit that made it reachable.
    srv,
    passwordParam: draft.passwordParam,
    sslMode: draft.sslMode,
    caSummary: draft.caSummary,
    options: { ...draft.options },
    readOnly: draft.readOnly,
    rowLimit: wholeNumber(draft.rowLimit) ?? spec.defaults.rowLimit,
    timeoutMs: wholeNumber(draft.timeoutMs) ?? spec.defaults.timeoutMs,
    allowMultiStatement: draft.allowMultiStatement,
  };
}

/* ──────────────────────────── validation ─────────────────────────────────── */

/**
 * `null` unless `text` is a plain non-negative whole number that survives as a safe
 * integer. Deliberately stricter than `Number()`: `"1e3"`, `"0x10"`, `" 5 "`-with-sign,
 * `"-1"` and `"12.0"` are all rejected, because a port the user cannot read back from
 * the box is a support ticket.
 */
export function wholeNumber(text: string): number | null {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : null;
}

export interface DraftErrors {
  /** key → message, keyed exactly as `FieldRow.key`. These BLOCK the save. */
  fields: Record<string, string>;
  /**
   * Things worth saying that must not block a save: an option key this engine does not
   * model — a vendor-supplied URL parameter we preserve rather than drop.
   */
  warnings: string[];
}

export function hasBlockingErrors(errors: DraftErrors): boolean {
  return Object.keys(errors.fields).length > 0;
}

/** Option keys present in the draft that this engine's descriptor does not declare. */
export function unmodelledOptionKeys(spec: EngineSpec, draft: DbDraft): string[] {
  const declared = new Set(spec.extraFields.map((f) => f.key));
  return Object.keys(draft.options)
    .filter((k) => !declared.has(k))
    .sort();
}

/** A descriptor's `select` choices, normalised — `null` and `[]` both mean "unconstrained". */
function choicesOf(f: DbFieldSpec | FieldRow): string[] {
  return f.choices ?? [];
}

/** Said when the mode is `URL only` and the box is empty. */
export const URL_REQUIRED_ERROR =
  "A connection string is required — or set Connection type back to Host and port.";

/** The port message, which now has to teach that empty is allowed. */
export function portError(spec: EngineSpec): string {
  return `Port must be a whole number from 1 to ${MAX_PORT}, or empty for ${spec.defaultPort}.`;
}

/**
 * Everything wrong with the draft, in one pure pass. Messages are the exact strings
 * the user reads and the tests assert — no interpolation of driver text, ever.
 *
 * A `required` field with a descriptor `default` is satisfied without special-casing,
 * because `newDraft`/`switchEngine` seed that default as a real value. Clearing such a
 * field is still an error: at that point the box the user is looking at really is empty.
 *
 * ── What the mode changes, and why ───────────────────────────────────────────────────────────
 * **`URL only` does not require a host, and an empty port is never an error.** Both used to be
 * mandatory, which is exactly why connecting with a URL, a user and a password demanded too
 * many other fields: given a complete Atlas URI, a user and a password, the form demanded a
 * host and a port that the URI already carried — and then sent the port anyway.
 * A field the connection does not use cannot be a precondition for saving it.
 *
 * The guardrails are validated in **both** modes, because they are ours and not the connection
 * string's, and the descriptor's extras are too: Rust's `engines::validate` checks them
 * whatever the mode, so skipping them here would only move the same refusal one round trip later.
 */
export function validateDraft(spec: EngineSpec, draft: DbDraft): DraftErrors {
  const fields: Record<string, string> = {};
  const warnings: string[] = [];

  if (draft.name.trim() === "") fields.name = "Name is required.";

  // `connectMode`'s `url` arm, spelled as the narrowing test rather than as a string compare:
  // the two agree by construction (a non-null `url` wins there too), and this way TypeScript
  // knows the string is present instead of needing a `?? ""` whose other half can never run.
  if (draft.url !== null) {
    if (draft.url.trim() === "") fields.url = URL_REQUIRED_ERROR;
  } else {
    if (draft.host.trim() === "") fields.host = "Host is required.";
    // Empty is legitimate — it means the driver's default (`DbConnection.port` is nullable).
    // Only a port that has been TYPED can be wrong.
    if (draft.port.trim() !== "") {
      const port = wholeNumber(draft.port);
      if (port === null || port < 1 || port > MAX_PORT) fields.port = portError(spec);
    }
  }

  for (const f of spec.extraFields) {
    const value = (draft.options[f.key] ?? "").trim();
    if (value === "") {
      if (f.required) fields[f.key] = `${f.label} is required.`;
      continue;
    }
    const choices = choicesOf(f);
    if (f.kind === "number" && wholeNumber(value) === null) {
      fields[f.key] = `${f.label} must be a whole number.`;
    } else if (f.kind === "select" && choices.length > 0 && !choices.includes(value)) {
      fields[f.key] = `${f.label} must be one of: ${choices.join(", ")}.`;
    }
  }

  const rowLimit = wholeNumber(draft.rowLimit);
  if (rowLimit === null || rowLimit < 1 || rowLimit > MAX_ROW_LIMIT) {
    fields.rowLimit = `Row limit must be a whole number from 1 to ${MAX_ROW_LIMIT}.`;
  }

  const timeout = wholeNumber(draft.timeoutMs);
  if (timeout === null || timeout < MIN_TIMEOUT_MS || timeout > MAX_TIMEOUT_MS) {
    fields.timeoutMs =
      `Timeout must be a whole number of milliseconds from ` +
      `${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS}.`;
  }

  for (const key of unmodelledOptionKeys(spec, draft)) {
    warnings.push(
      `${spec.label} does not model the setting \`${key}\`. It is passed to the driver ` +
        `unchanged, so the server may reject it — remove it if you did not mean to keep it.`,
    );
  }

  return { fields, warnings };
}

/** The first key in `order` that has an error, so a failed save can focus it. */
export function firstErrorKey(order: string[], fields: Record<string, string>): string | null {
  return order.find((k) => fields[k] !== undefined) ?? null;
}

/**
 * The DOM id a failed save should focus, or `""` when nothing matched.
 *
 * The "nothing matched" arm lives here rather than as an `if` in the component
 * deliberately: `order` is built from the rendered rows, so it is unreachable through
 * the UI, and an unreachable `if` in a component is a branch no test can honestly
 * cover. As a pure function it is one line to pin from both directions, and the caller
 * becomes branchless (`getElementById("")` is `null`, which its `?.` handles).
 */
export function firstErrorDomId(order: string[], fields: Record<string, string>): string {
  const key = firstErrorKey(order, fields);
  return key === null ? "" : fieldDomId(key);
}

/** How many fields block the save, and the sentence that announces it. */
export function errorSummary(errors: DraftErrors): string | null {
  const n = Object.keys(errors.fields).length;
  if (n === 0) return null;
  return `Fix ${n} field${n === 1 ? "" : "s"} before saving this connection.`;
}

/* ─────────────────────────── the engine switch ───────────────────────────── */

export interface EngineSwitch {
  draft: DbDraft;
  /** Option keys the new engine does not declare, dropped and named for the user. */
  droppedOptions: string[];
  /** True iff the draft was a DNS seed list and the new engine has no `+srv` scheme. */
  srvDropped: boolean;
  /** The SSL mode we had to abandon, or `null` when it survived. */
  sslModeReset: SslMode | null;
}

/**
 * Change engine without silently destroying input. The rules, all four deliberate:
 *
 * 1. **Common fields survive** — name, host, database, user, `savePassword`,
 *    `passwordRef`, the URL override, and the guardrails. Fields the new engine hides
 *    stay in the draft (so switching back restores them) and are dropped by
 *    `toRecord`, never persisted.
 * 2. **Options are filtered to the new engine's declared keys**, and the rest are
 *    returned so the UI can *name* them. Keeping them would mean posting `replicaSet`
 *    at PostgreSQL; dropping them silently is the thing this function exists to avoid.
 *    The target's own defaults are then seeded, so switching to Mongo arrives with
 *    `authSource=admin` rather than an empty required field.
 * 3. **The port is carried across verbatim, always.** There used to be a rule here — "the port
 *    moves to the new engine's default if it still holds the old one's" — and a notice to
 *    explain it. Both are **gone**, because the only reason they existed was that the box was
 *    pre-filled: a value in it could be the descriptor's rather than the user's, so the code had
 *    to guess which. Now an empty box means "the default" and a value means the user typed it,
 *    and neither needs moving. A rule you no longer need is better than a rule you explain.
 *    Deleting it also deleted this function's `from` parameter: nothing else ever read it.
 * 4. **`readOnly` is carried across untouched**, in both directions: it is the user's
 *    explicit decision about this connection, and a driver change is not a reason to
 *    revisit it. This used to read `draft.readOnly || to.defaults.readOnly` to stop a
 *    descriptor weakening it; `EngineSpec` can no longer express that, so the guarantee
 *    is structural now. The SSL mode is not so lucky — an engine that does not offer
 *    `verify-full` forces a change — so that one is reported (`sslModeReset`), because
 *    silently lowering TLS verification is a security regression the user must see.
 */
export function switchEngine(draft: DbDraft, to: EngineSpec): EngineSwitch {
  const declared = new Set(to.extraFields.map((f) => f.key));
  const options: Record<string, string> = {};
  const dropped: string[] = [];
  for (const key of Object.keys(draft.options).sort()) {
    if (declared.has(key)) options[key] = draft.options[key];
    else dropped.push(key);
  }

  const sslKept = to.sslModes.includes(draft.sslMode);
  // The flag survives only where the target engine can act on it; otherwise it is dropped and
  // *named*, for the same reason `sslModeReset` is — a connection type that silently changed is
  // a connection that silently goes somewhere else.
  const srvKept = srvScheme(to) !== null && draft.srv;

  return {
    draft: {
      ...draft,
      engine: to.id,
      port: draft.port,
      srv: srvKept,
      options: seedDefaults(to, options),
      sslMode: sslKept ? draft.sslMode : to.defaults.sslMode,
      readOnly: draft.readOnly,
      rowLimit: draft.rowLimit,
      timeoutMs: draft.timeoutMs,
    },
    droppedOptions: dropped,
    srvDropped: draft.srv && !srvKept,
    sslModeReset: sslKept ? null : draft.sslMode,
  };
}

/** The sentences a switch owes the user. Empty is never returned — a switch always says something. */
export function describeEngineSwitch(sw: EngineSwitch, to: EngineSpec): string[] {
  // 🔴 Name what the TARGET engine actually has. This read "Name, host, user and the guardrails"
  // unconditionally, so it promised a **user** field to Redis, which has `supportsUser: false` and
  // therefore never drew one.
  const carried = ["Name", "host"];
  if (to.supportsUser) carried.push("user");
  const out = [
    `Switched to ${to.label}. ${carried.join(", ")} and the guardrails were kept.`,
  ];
  if (sw.srvDropped) {
    out.push(
      `${to.label} has no DNS seed list (SRV) mode, so the connection type is now Host and port.`,
    );
  }
  if (sw.droppedOptions.length > 0) {
    const n = sw.droppedOptions.length;
    out.push(
      `Removed ${n} setting${n === 1 ? "" : "s"} ${to.label} does not use: ` +
        `${sw.droppedOptions.join(", ")}.`,
    );
  }
  if (sw.sslModeReset !== null) {
    out.push(
      `${to.label} does not offer SSL mode "${sw.sslModeReset}", so it is now ` +
        `"${sw.draft.sslMode}". Check it before you connect.`,
    );
  }
  return out;
}

/* ───────────────────────────── URL handling ──────────────────────────────── */

/**
 * Replace every occurrence of `secret` with `SECRET_MASK`, in both its literal and
 * percent-encoded forms.
 *
 * The encoded form is the one that matters and the one a naive scrub misses: Rust
 * builds URLs with `Url::set_password`, so `p@ss:w/rd#1` reaches a string as
 * `p%40ss%3Aw%2Frd%231`. This is **not** a URL parser and does not pretend to catch
 * every encoding — it is the last line of defence behind a backend that is supposed
 * to never emit a password at all. An empty secret scrubs nothing, so an
 * untouched password field cannot mask arbitrary text.
 */
export function redactSecret(text: string, secret: string): string {
  if (secret === "") return text;
  let out = text;
  for (const form of new Set([secret, encodeURIComponent(secret)])) {
    out = out.split(form).join(SECRET_MASK);
  }
  return out;
}

export interface ImportReport {
  draft: DbDraft;
  notices: string[];
  /** The credential-stripped string to display, straight from the parser. */
  url: string;
}

/* ──────────────── the credential parameter, and where it may live ─────────────────
 * `?password=` stays part of the path, because every database system follows that
 * convention. Rust honours it on the SAVE
 * path (`upsert` re-renders the reference into the very parameter the value came out
 * of). The PASTE path lost it, and the two helpers below are what put it back. */

/**
 * Whether `url`'s query string carries a parameter named exactly `name`.
 *
 * A deliberately small read, not a URL parser — parsing connection strings stays in Rust.
 * It answers one question about a string **Rust just produced**, whose credential
 * parameter Rust writes with its name unencoded, so a literal key comparison is exact for
 * every name `is_credential_param` can match.
 */
function hasQueryParam(url: string, name: string): boolean {
  const q = url.indexOf("?");
  if (q === -1) return false;
  return url
    .slice(q + 1)
    .split("&")
    .some((pair) => pair.split("=")[0] === name);
}

/**
 * `url` with `name=value` appended.
 *
 * Appended **last**, which is not arbitrary: `url.rs`'s renderer emits the credential
 * parameter last, after the SSL parameters and the sorted options, so a string built here
 * and the string Rust writes back on save are the same string rather than a permutation.
 * The value is a `{{VAR}}` reference and is written **verbatim** — `{`/`}` are not RFC 3986
 * characters, Rust writes them verbatim for the same reason, and
 * `?password=%7B%7BPG_PASSWORD%7D%7D` shows a human nothing.
 */
function withQueryParam(url: string, name: string, value: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}${name}=${value}`;
}

/** What {@link importUrlOverride} decided: the draft's new `url`, and whether the
 *  credential parameter survived into it. */
export interface UrlImport {
  /** The value for `DbDraft.url` — `null` meaning "no stored override". */
  url: string | null;
  /** The credential parameter we kept in `url`, or `null` (there was none, or we could not). */
  keptParam: string | null;
}

/**
 * What a paste does to the draft's stored `url`.
 *
 * ── 🔴 The old rule was the bug ─────────────────────────────────────────────────────────────
 * This function used to keep a pasted URL **only when it carried a credential *query
 * parameter***, on the reasoning that the fields can express everything else so an override
 * would be a footgun. The reasoning had a hole big enough to lose a connection through: a
 * pasted Atlas URI whose password was in the **userinfo** hit case 1, and the entire
 * string — including its `mongodb+srv` scheme — was thrown away. What connected was rebuilt from
 * the fields as `mongodb://…:27017/`, which Atlas does not answer. The dialog had discarded the
 * one thing the user actually supplied and substituted something it invented.
 *
 * **A pasted URL is what the user asked for. It is kept, as the override.** That is also what
 * makes the string the single description of the connection: Rust's `resolve_from_*` hands a
 * non-empty `url` straight to the driver, so keeping it means what connects is what was pasted,
 * character for character. The user can hand it back to the fields at any time — clear the box,
 * or set Connection type to Host and port.
 *
 * The credential split is unchanged and non-negotiable (a raw URL may carry a password):
 * `db_url_parse` has already stripped the password out of `parsed.url` before this runs, so
 * what is stored can contain a `{{VAR}}` and never a value. The four cases below decide only **where the reference goes**:
 *
 * 1. **No credential parameter** (`passwordParam === null`: the userinfo carried it, or nothing
 *    did). Keep the string as the parser rendered it — `db_url_build`/`upsert` put the reference
 *    back in the userinfo, which is where this string carried it.
 * 2. **The parameter survived the parse**, because the pasted string carried a `{{VAR}}`
 *    rather than a value: Rust already re-rendered it in place, so take its string as-is.
 * 3. **A real value was taken out and the draft has no reference yet** — the ordinary fresh
 *    paste. Nothing can be written into the parameter *here*: the value is not returned to
 *    this window (by design) and the Vault variable's name is minted by Rust at save time.
 *    The parameter is still kept — it travels as `draft.passwordParam` and Rust puts the
 *    reference into it when it mints the name (`DbConnectionInput::password_param`).
 * 4. **A real value was taken out and the draft HAS a reference** — editing a saved
 *    connection. The reference goes back into the parameter, under its own name, rather than
 *    into the `user:password@` userinfo, which would move the credential.
 *
 * The one string that stores nothing is an **empty** one: a parser that could not render the URL
 * has not told us anything to keep, and `url: ""` would read as "URL only, nothing typed".
 */
export function importUrlOverride(parsed: ParsedUrl, passwordRef: string): UrlImport {
  if (parsed.url.trim() === "") return { url: null, keptParam: null };
  const param = parsed.passwordParam;
  // 🔴 KEEP the pasted string, even when no credential PARAMETER was involved.
  //
  // This line used to return `{ url: null }` — discarding the paste whenever the password lived in
  // the `user:pass@` userinfo rather than in a `?password=` parameter. That is how MongoDB Atlas
  // became unreachable: a pasted `mongodb+srv://…` URL was thrown away, only the
  // fields survived, and `srv` was not among them — so it rebuilt as `mongodb://host:27017`, which
  // Atlas does not answer. A paste is the user asking for *that string*; keeping it is the whole
  // point of an override field ("Overrides settings above").
  if (param === null) return { url: parsed.url, keptParam: null };
  if (hasQueryParam(parsed.url, param)) return { url: parsed.url, keptParam: param };
  if (passwordRef === "") return { url: parsed.url, keptParam: null };
  return { url: withQueryParam(parsed.url, param, passwordRef), keptParam: param };
}

/**
 * Whether `url`'s `user:password@` userinfo carries something other than a `{{VAR}}` reference.
 *
 * **This is a hint, not a parser** — parsing connection strings stays in Rust, and Rust is
 * what actually removes the credential: `upsert` runs `split_url_credentials` on whatever the
 * client sends, Vaults the value and persists the string with a `{{VAR}}` in its place. So a
 * literal password typed here is never written to disk, and this function's only job is to
 * **say so before the user presses Save**, because a password silently rewritten is exactly as
 * confusing as a port silently added.
 *
 * It reads only the userinfo, and only the shape `scheme://user:secret@host`. A `?password=`
 * parameter is left to `driverPasswordParamCaveat` and to Rust, and a string this misses is
 * still split server-side — the cost of a miss is a missing sentence, never a leak.
 */
export function urlHasLiteralPassword(url: string): boolean {
  const scheme = url.indexOf("://");
  if (scheme === -1) return false;
  const authority = url.slice(scheme + 3).split("/")[0];
  const at = authority.lastIndexOf("@");
  if (at === -1) return false;
  const userinfo = authority.slice(0, at);
  const colon = userinfo.indexOf(":");
  if (colon === -1) return false;
  const secret = userinfo.slice(colon + 1);
  return secret !== "" && !/^\{\{[^{}]+\}\}$/.test(secret);
}

/** Said when the URL box holds a literal password, naming the position and never the value. */
export const URL_LITERAL_PASSWORD_NOTICE =
  "This string carries a password in its `user:password@` part. Press Import to take it out " +
  "now; otherwise it moves to the Vault when you save and a {{VAR}} reference takes its place. " +
  "The connection record never stores the value.";

/**
 * Said when the credential parameter was kept under its own name.
 *
 * It also states the consequence, because there is one: the connection now stores a string,
 * and a stored string overrides the fields. A guardrail the user cannot see is not one.
 */
export function passwordParamKeptNotice(param: string): string {
  return (
    `That URL keeps the password in the \`${param}\` parameter, and it stays there — the ` +
    `{{VAR}} reference goes back into \`${param}=\`, not into the \`user:password@\` part. ` +
    `The connection now stores this string, which overrides the fields above when it connects.`
  );
}

/**
 * Said when the parameter is kept but cannot be *shown* yet: a real value in a credential
 * parameter, on a draft with no `{{VAR}}` of its own.
 *
 * The sentence names the outcome, not the mechanism. It used to say the parameter "cannot be
 * kept" and that the password would go into `user:password@` instead — which was **true when
 * it was written** and is now false: `DbConnectionInput.password_param` carries the placement
 * to Rust, which writes the reference into that parameter as it mints the Vault name. A
 * notice that describes the old behaviour is worse than none, because the user checks the
 * saved string against it.
 */
export function passwordParamUnplacedNotice(param: string): string {
  return (
    `That URL carried the password in the \`${param}\` parameter, and it stays there. The ` +
    `{{VAR}} reference name is created when you save, so \`${param}=\` looks empty until ` +
    `then — after saving, the stored string reads \`${param}={{VAR}}\`, not ` +
    `\`user:password@\`.`
  );
}

/**
 * The caveat for a credential parameter that is not the exact lowercase `password`, or
 * `null` for one that is.
 *
 * **Measured**, not assumed: sqlx-postgres 0.9's `options/parse.rs` matches the connect
 * parameters it understands exactly, and logs `ignoring unrecognized connect parameter` for
 * everything else — libpq behaves the same way. So `?pwd=` round-trips through this app
 * faithfully and *still will not authenticate*. That is a property of the pasted string,
 * not of our handling of it, which is why the parameter is **not** renamed to `password` to
 * "fix" it: renaming it would change what the string says. Telling the user is the only
 * honest move — the alternative is an auth failure whose cause is invisible.
 */
export function driverPasswordParamCaveat(param: string): string | null {
  if (param === "password") return null;
  return (
    `Drivers read only the exact lowercase \`password\` parameter — PostgreSQL and MySQL ` +
    `both log "ignoring unrecognized connect parameter" for anything else — so \`${param}=\` ` +
    `is kept exactly as you pasted it and will still not authenticate. Rename it to ` +
    `\`password\` in the string if that is what you meant; Agent Studio will not rename it for ` +
    `you, because that would change what the string says.`
  );
}

/**
 * Fold a `ParsedUrl` into the draft and *say what happened*. A paste that changes six
 * fields must report six fields — the alternative is a user hunting for where
 * their password went, which is precisely what `hadPassword` exists to prevent.
 *
 * The TLS mode comes from `parsed.sslMode`, a field Rust parses and the UI only reads.
 * (It used to be sniffed out of `options` by matching a `sslmode` key — UI guesswork
 * about a security setting, and the reason the contract grew the field.) A mode this
 * engine does not offer is **not** silently applied: the select would go blank and the
 * record would carry something the driver rejects, so it is reported instead.
 *
 * Query parameters Rust could not consume are split against the descriptor: declared
 * keys become engine settings, the rest are kept verbatim as pass-through and named in
 * a notice. Nothing is dropped.
 *
 * The pasted string is **kept as the override** — see {@link importUrlOverride} for why that
 * changed and what it fixes.
 *
 * ⚠️ `srv` is read off the parser's own scheme prefix, because **`ParsedUrl` has no `srv`
 * field**. That is a contract gap, not a preference: Rust's `UrlParts` has carried `srv` since
 * `url.rs` was written (it round-trips an Atlas URI correctly, per its own
 * `srv_ness_survives_a_split_and_a_re_render` test) and simply does not surface it here, so the
 * dialog has to re-derive from the string what the parser already knew. The read is narrow — a
 * literal prefix on a string Rust just produced, the same standing this file's `hasQueryParam`
 * has — and the honest fix is one field on `ParsedUrl` plus one line in `db_url_parse`.
 */
export function applyParsedUrl(draft: DbDraft, parsed: ParsedUrl, spec: EngineSpec): ImportReport {
  const declared = new Set(spec.extraFields.map((f) => f.key));
  const next: DbDraft = { ...draft, options: { ...draft.options } };
  const imported = importUrlOverride(parsed, draft.passwordRef);
  next.url = imported.url;
  const srv = srvScheme(spec);
  let srvNotice: string | null = null;
  if (srv !== null) {
    // The paste is the new intent in both directions: a plain `mongodb://` string turns SRV OFF
    // as surely as a `mongodb+srv://` one turns it on.
    next.srv = parsed.url.startsWith(`${srv}://`);
    if (next.srv) {
      srvNotice =
        `That URL is a DNS seed list (\`${srv}://\`), so the port stays empty — DNS supplies ` +
        `the hosts and the port.`;
    }
  }
  // The placement travels as a FIELD as well as (sometimes) inside `url`. On a fresh paste
  // the string has had its `?password=` stripped and there is no reference to put back yet,
  // so this hint is the only thing that survives to tell Rust where the credential belongs.
  next.passwordParam = parsed.passwordParam;
  const set: string[] = [];
  const kept: string[] = [];
  const notices: string[] = [];

  if (parsed.host !== "") {
    next.host = parsed.host;
    set.push("host");
  }
  if (parsed.port !== null) {
    next.port = String(parsed.port);
    set.push("port");
  }
  if (parsed.database !== "" && spec.databaseLabel !== null) {
    next.database = parsed.database;
    set.push(spec.databaseLabel.toLowerCase());
  }
  if (parsed.user !== "" && spec.supportsUser) {
    next.user = parsed.user;
    set.push("user");
  }

  let sslRefused: SslMode | null = null;
  if (parsed.sslMode !== null) {
    if (spec.sslModes.includes(parsed.sslMode)) {
      next.sslMode = parsed.sslMode;
      set.push("SSL mode");
    } else {
      sslRefused = parsed.sslMode;
    }
  }

  for (const [key, value] of Object.entries(parsed.options).sort(([a], [b]) => (a < b ? -1 : 1))) {
    next.options[key] = value;
    if (declared.has(key)) set.push(key);
    else kept.push(`${key}=${value}`);
  }

  if (set.length > 0) notices.push(`Set ${set.join(", ")} from that URL.`);
  if (srvNotice !== null) notices.push(srvNotice);
  if (parsed.hadPassword) notices.push(PASSWORD_MOVED_NOTICE);
  if (parsed.passwordParam !== null) {
    notices.push(
      imported.keptParam !== null
        ? passwordParamKeptNotice(parsed.passwordParam)
        : passwordParamUnplacedNotice(parsed.passwordParam),
    );
    const caveat = driverPasswordParamCaveat(parsed.passwordParam);
    if (caveat !== null) notices.push(caveat);
  }
  if (sslRefused !== null) {
    notices.push(
      `That URL asks for SSL mode "${sslRefused}", which ${spec.label} does not offer — ` +
        `it is still "${next.sslMode}". Check it before you connect.`,
    );
  }
  if (kept.length > 0) {
    const n = kept.length;
    notices.push(
      `Kept ${n} parameter${n === 1 ? "" : "s"} ${spec.label} does not model, ` +
        `to pass through unchanged: ${kept.join(", ")}.`,
    );
  }
  if (parsed.engine !== null && parsed.engine !== spec.id) {
    notices.push(
      `That looks like a "${parsed.engine}" URL, but the driver here is ${spec.label}. ` +
        `Change the driver above if that is wrong — nothing was switched for you.`,
    );
  }
  return { draft: next, notices, url: parsed.url };
}

/**
 * The engine's canonical URI scheme with its separator (`"mongodb://"`), or `""` for a
 * descriptor that lists none. The import affordance says which shape it expects, so the
 * prompt is engine-accurate rather than generic — the one thing the dialog uses
 * `urlSchemes` for. Building and parsing the string itself stays in Rust.
 */
export function canonicalScheme(spec: EngineSpec): string {
  return spec.urlSchemes.length === 0 ? "" : `${spec.urlSchemes[0]}://`;
}

/**
 * Said whenever `ParsedUrl.hadPassword` is true. Asserted verbatim in the tests.
 *
 * ⚠️ The old wording is worth recording because it was the more
 * dangerous kind of wrong. It read *"It was taken out of the URL and **stored separately** —
 * the connection record keeps only a {{VAR}} reference to it"*, which describes the SAVE
 * path (`db_connection_upsert`, which really does Vault the value). The PASTE path does no
 * such thing: `db_url_parse` is pure — it strips the password and **discards it**, never
 * returning it to the webview, which is exactly the property that keeps a `:s3cret@` out of
 * React state. So the old sentence told the user their password was safely stored at the
 * moment it had in fact just been thrown away, and the failure it produced was an auth
 * error one save later with nothing on screen to explain it.
 */
export const PASSWORD_MOVED_NOTICE =
  "That URL carried a password. It was stripped before the string reached this window and " +
  "was NOT kept, so type it into the Password field — otherwise this connection saves " +
  "without one. What you type goes to the Vault under a {{VAR}} name, and the connection " +
  "record keeps only that reference, never the value.";

/** Said after a successful copy, so nobody wonders what landed on the clipboard. */
export const URL_COPIED_NOTICE =
  "Connection string copied. It carries a {{VAR}} reference, never the password.";

/* ──────────────────────────── Test Connection ────────────────────────────── */

/** The result a test that never came back resolves to, so the pending state cannot hang. */
export function timeoutResult(ms: number): DbTestResult {
  return {
    ok: false,
    serverVersion: null,
    latencyMs: null,
    error: `The test did not finish within ${Math.round(ms / 1000)} s. The server may be unreachable, or a firewall may be dropping the connection.`,
  };
}

/**
 * `p`, but never pending forever. Three layers of timeout exist in Rust; this
 * is the fourth, in the UI, because the failure this guards against is *the IPC call
 * itself* never settling — at which point no server-side timeout can help and a
 * spinner would spin until the app is restarted.
 */
export async function raceTestTimeout(p: Promise<DbTestResult>, ms: number): Promise<DbTestResult> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<DbTestResult>((resolve) => {
    handle = setTimeout(() => resolve(timeoutResult(ms)), ms);
  });
  try {
    return await Promise.race([p, timer]);
  } finally {
    clearTimeout(handle);
  }
}

/** Said when a connection fails and the mapper had nothing at all to report. */
export const TEST_FAILED_FALLBACK =
  "The connection failed, and the driver gave no reason. Check the host, the port and the network.";

/**
 * What Test Connection renders. Success shows the **server version and the latency** —
 * the only two things that prove a real round trip happened rather than a socket
 * opening. Failure shows Rust's mapped, redacted message and nothing else: a raw
 * driver string here is a usability failure and a leak risk, so the typed
 * password is scrubbed on the way out too.
 */
export function describeTestResult(
  result: DbTestResult,
  secret: string,
): { ok: boolean; text: string } {
  if (!result.ok) {
    return { ok: false, text: redactSecret(result.error ?? TEST_FAILED_FALLBACK, secret) };
  }
  const who = result.serverVersion ?? "Connected";
  const text = result.latencyMs === null ? who : `${who} · ${result.latencyMs} ms`;
  return { ok: true, text };
}

/* ──────────────────────────── guardrail copy ─────────────────────────────── */

/**
 * What read-only actually buys on this engine. For Postgres/MySQL/ClickHouse it is a
 * server-enforced boundary; for Mongo/Redis it is our own in-process command filter,
 * and saying otherwise would turn a guardrail into a false sense of safety.
 */
export function readOnlyNote(spec: EngineSpec): string {
  return spec.serverEnforcedReadOnly
    ? `${spec.label} enforces this at the server for the whole session — a write or a DDL statement fails at the database, not here.`
    : `${spec.label} has no server-side read-only mode, so Agent Studio filters commands in-process. That is a speed bump, not a guarantee: for a real boundary, connect as a read-only database user.`;
}

/**
 * The tooltip on a connection row's `[read-only]` badge in the rail panel.
 *
 * The badge exists because the guardrail must be visible **where you
 * choose the connection**, not only inside a dialog. And it says what the flag is *worth*,
 * for the same reason {@link readOnlyNote} does: on Mongo/Redis it is an in-process filter,
 * and a badge that implies a server boundary on an engine that has none is worse than no
 * badge.
 *
 * `spec === null` is a real state, not a defensive arm: a saved connection can name an
 * engine this build does not offer (`initialNotices` covers the same case in the dialog), and
 * then we genuinely do not know whether the server could enforce it. Saying so beats picking
 * the reassuring answer.
 */
export function readOnlyBadgeTitle(spec: EngineSpec | null): string {
  if (spec === null) {
    return (
      "Read-only. This build does not offer this connection's engine, so whether the server " +
      "can enforce it is unknown."
    );
  }
  return spec.serverEnforcedReadOnly
    ? `Read-only. ${spec.label} enforces this at the server for the whole session.`
    : `Read-only. ${spec.label} has no server-side read-only mode, so this is a client-side speed bump, not a guarantee — for a real boundary, connect as a read-only database user.`;
}

/** Shown, loudly, when the user turns the guardrail off. */
export const READ_ONLY_OFF_WARNING =
  "Read-only is OFF. This connection can UPDATE, DELETE and DROP — including from an agent's query.";

/* ─────────────────────────── password retention ──────────────────────────── */

export const SAVE_PASSWORD_CHOICES: ReadonlyArray<{ value: SavePassword; label: string }> = [
  { value: "forever", label: "Forever" },
  { value: "session", label: "Until I quit" },
  { value: "never", label: "Never" },
];

/** What each retention choice actually does — the "Save:" control, explained. */
export function savePasswordHint(value: SavePassword): string {
  switch (value) {
    case "forever":
      return "Kept in the Vault under a {{VAR}} name. The connection record stores the reference, never the value.";
    case "session":
      return "Held in memory until Agent Studio quits. Never written to disk.";
    default:
      return "Not kept at all — you are asked for it on every connect.";
  }
}

/* ────────────────────────────── misc ─────────────────────────────────────── */

/**
 * A rejected IPC call's message. Tauri rejects with a **string**, not an `Error`, so
 * both shapes are real and neither may render as `[object Object]`.
 */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Which element `Tab` must wrap to, or `null` when the browser's own order is already
 * correct. Pure so the trap's edges — an empty dialog, focus that has escaped the
 * dialog entirely, both ends in both directions — are tested as data rather than by
 * wrestling jsdom's focus model.
 */
export function tabWrapTarget(
  nodes: HTMLElement[],
  active: Element | null,
  shift: boolean,
): HTMLElement | null {
  if (nodes.length === 0) return null;
  const idx = nodes.findIndex((n) => n === active);
  if (idx === -1) return shift ? nodes[nodes.length - 1] : nodes[0];
  const next = shift ? idx - 1 : idx + 1;
  if (next >= 0 && next < nodes.length) return null;
  return shift ? nodes[nodes.length - 1] : nodes[0];
}
