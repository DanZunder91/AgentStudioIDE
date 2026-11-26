/** Pure logic behind the connection dialog: which fields an engine shows and how they behave is
 * data from `EngineSpec`, so the dialog owns no per-engine knowledge. `DbDraft` has no password
 * field by construction; `redactSecret` is defence in depth (Rust must never emit one). */

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

/** Numbers are held as text so half-typed or empty values are representable; `toRecord`
 * converts after `validateDraft`. No password and no Rust-owned id/timestamps, by design. */
export interface DbDraft {
  name: string;
  engine: DbEngineId;
  host: string;
  /** As typed; `""` means the driver's default. `spec.defaultPort` is only a placeholder, so no
   * untyped port reaches the connection string. */
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

/** Decided by the descriptor: common and required fields are `basic` (a save must not block on a
 * hidden field); optional extras and the SSL select are `advanced`. */
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
  /** Under the control, only for what changes the current state's meaning (an inert SRV port);
   * the descriptor's prose goes in `tip`. */
  hint: string | null;
  /** The descriptor's explanation as the control's `title`, one hover away rather than a paragraph
   * under every field. */
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

/* Connection type: one select, not a select plus an SRV checkbox, so "URL only + SRV" can't be
 * expressed. The mode is derived from `url` and `srv`, never stored, so typing in the URL box
 * switches it to URL only by itself. */

/** Where a connection's configuration comes from. Derived — see the note above. */
export type DbConnectMode = "fields" | "srv" | "url";

/** Read off `urlSchemes`, so SRV is offered wherever the descriptor declares a `+srv` scheme. */
export function srvScheme(spec: EngineSpec): string | null {
  return spec.urlSchemes.find((s) => s.endsWith("+srv")) ?? null;
}

/** `draft.srv` alone is not enough: the engine may have no SRV scheme (e.g. after a fallback). */
export function isSrv(spec: EngineSpec, draft: DbDraft): boolean {
  return srvScheme(spec) !== null && draft.srv;
}

/** Which mode the draft is in. `url` wins because a non-empty `url` is what Rust connects with. */
export function connectMode(spec: EngineSpec, draft: DbDraft): DbConnectMode {
  // No connection string means never `url` mode: a `url` left over from an engine switch would
  // otherwise make every control inert and block the save.
  if (!hasConnectionString(spec)) return "fields";
  if (draft.url !== null) return "url";
  return isSrv(spec, draft) ? "srv" : "fields";
}

/** The single test for whether a connection-string affordance exists, so callers agree. */
export function hasConnectionString(spec: EngineSpec): boolean {
  return spec.urlSchemes.length > 0;
}

/** `SRV` appears only where the descriptor declares the scheme; labels say what each mode is. */
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

/** `seed` restores the URL so a switch never silently deletes it. Leaving URL mode sets `url` to
 * `null` (no override); `""` means URL mode with nothing typed. */
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

/** Blank clears the override (`null`), handing the connection back to the fields rather than
 * leaving URL mode with a blocking "required" error. */
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

/** Must name the password as NOT governed by the string: a pasted credential is stripped, and a
 * note implying no field matters led to saving a connection with no credential. */
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

/** Says *invalid*, not unnecessary: the driver rejects a port on `mongodb+srv://`. */
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

/** Common fields, then the descriptor's extras in declared order; the shape comes from the
 * descriptor (database label, user, SSL modes, placeholder port, groups). In `url` mode all but
 * Name are inert; in `srv` mode the port is inert and says why. */
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

/** Opens Advanced when anything there differs from the descriptor's fresh-draft defaults, so a
 * saved setting is never hidden. */
export function advancedIsDirty(spec: EngineSpec, draft: DbDraft): boolean {
  if (spec.sslModes.length > 0 && draft.sslMode !== spec.defaults.sslMode) return true;
  return spec.extraFields.some(
    (f) => !f.required && (draft.options[f.key] ?? "") !== f.default,
  );
}

/** The `default` arm is `sslMode`: the connection key set is closed (from `engineFieldRows`), so
 * a no-op default would be dead code. */
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

/** Only for absent keys: a key cleared to `""` is a user decision. Hence seeded at draft creation
 * and engine switch, never per render. */
function seedDefaults(spec: EngineSpec, existing: Record<string, string>): Record<string, string> {
  const out = { ...existing };
  for (const f of spec.extraFields) {
    if (f.default !== "" && !(f.key in out)) out[f.key] = f.default;
  }
  return out;
}

/** A new connection starts `readOnly: true` unconditionally. Option defaults are seeded as real
 * values; the port is NOT (a seeded port is indistinguishable from a typed one), so it stays a
 * placeholder and `null` means the driver's default. */
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

/** From `initial`, since the draft carries no `id` (Rust mints it). */
export function isExisting(initial: Partial<DbConnection> | null): boolean {
  return (initial?.id ?? "") !== "";
}

/** The engine `initial` names, else the first; `null` when no engines were given at all. */
export function initialEngine(
  engines: EngineSpec[],
  initial: Partial<DbConnection> | null,
): EngineSpec | null {
  if (engines.length === 0) return null;
  return engines.find((e) => e.id === initial?.engine) ?? engines[0];
}

/** Flags a saved connection whose engine this build doesn't offer, rather than silently retyping
 * it. */
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

/** `family` comes from the descriptor; fields the engine doesn't define (and `srv` without a
 * `+srv` scheme) persist as empty; guardrail numbers fall back to the descriptor default. An
 * unparseable or empty port is `null`, never invented. */
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

/** Plain non-negative safe integers only; stricter than `Number()` (no "1e3", "0x10", "12.0"). */
export function wholeNumber(text: string): number | null {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : null;
}

export interface DraftErrors {
  /** key → message, keyed exactly as `FieldRow.key`. These BLOCK the save. */
  fields: Record<string, string>;
  /** Non-blocking notes, e.g. an option key this engine doesn't model (kept, not dropped). */
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

/** Messages are exact user-facing strings, never driver text. URL mode needs no host and an empty
 * port is never an error; guardrails and extras are checked in both modes, as Rust does. */
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

/** `""` when nothing matched (unreachable via the UI), so the caller stays branchless. */
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

/** Common fields survive (hidden ones stay in the draft, unpersisted); options are filtered to
 * the new engine with the rest reported; port and `readOnly` carry over untouched. A forced SSL
 * change is reported (`sslModeReset`): silently weakening TLS verification must be seen. */
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

/** Masks literal and percent-encoded forms (Rust's `set_password` encodes). Last-line defence,
 * not a URL parser; an empty secret scrubs nothing. */
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

/* `?password=` stays where it was pasted. Rust keeps it on save; the helpers below keep it on
 * paste. */

/** A literal key match, not a URL parser: exact for the unencoded names Rust writes. */
function hasQueryParam(url: string, name: string): boolean {
  const q = url.indexOf("?");
  if (q === -1) return false;
  return url
    .slice(q + 1)
    .split("&")
    .some((pair) => pair.split("=")[0] === name);
}

/** Appended last, as `url.rs` renders it, so the string matches Rust's; the `{{VAR}}` value is
 * written verbatim, as Rust does. */
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

/** A pasted URL is kept as the override, so what connects is what was pasted. The password is
 * already stripped; `passwordParam` only decides where the `{{VAR}}` reference goes. An empty
 * rendered string stores nothing (`""` would mean URL mode, nothing typed). */
export function importUrlOverride(parsed: ParsedUrl, passwordRef: string): UrlImport {
  if (parsed.url.trim() === "") return { url: null, keptParam: null };
  const param = parsed.passwordParam;
  // Keep the pasted string even when the userinfo carried the password: discarding it lost the
  // `mongodb+srv` scheme and rebuilt an Atlas URI it cannot answer.
  if (param === null) return { url: parsed.url, keptParam: null };
  if (hasQueryParam(parsed.url, param)) return { url: parsed.url, keptParam: param };
  if (passwordRef === "") return { url: parsed.url, keptParam: null };
  return { url: withQueryParam(parsed.url, param, passwordRef), keptParam: param };
}

/** A hint, not a parser: Rust's `upsert` splits and Vaults a literal password anyway; this only
 * warns before Save. Reads only `scheme://user:secret@host`; a miss costs a sentence, never a
 * leak. */
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

/** Also states the consequence: a stored string overrides the fields. */
export function passwordParamKeptNotice(param: string): string {
  return (
    `That URL keeps the password in the \`${param}\` parameter, and it stays there — the ` +
    `{{VAR}} reference goes back into \`${param}=\`, not into the \`user:password@\` part. ` +
    `The connection now stores this string, which overrides the fields above when it connects.`
  );
}

/** A real value in a credential param, no `{{VAR}}` yet: Rust places the reference in that param
 * when it mints the Vault name (`password_param`). */
export function passwordParamUnplacedNotice(param: string): string {
  return (
    `That URL carried the password in the \`${param}\` parameter, and it stays there. The ` +
    `{{VAR}} reference name is created when you save, so \`${param}=\` looks empty until ` +
    `then — after saving, the stored string reads \`${param}={{VAR}}\`, not ` +
    `\`user:password@\`.`
  );
}

/** Drivers honour only the exact lowercase `password` (measured: sqlx-postgres 0.9, libpq), so
 * `?pwd=` won't authenticate. Not renamed, which would change the string; the user is told. */
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

/** Folds a `ParsedUrl` into the draft and reports every change. An SSL mode the engine doesn't
 * offer is reported, not applied; unconsumed params become declared options or pass-through, never
 * dropped. `srv` is read off the scheme prefix. */
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

/** The first `urlSchemes` entry with `://`, or `""`; the import prompt shows it. */
export function canonicalScheme(spec: EngineSpec): string {
  return spec.urlSchemes.length === 0 ? "" : `${spec.urlSchemes[0]}://`;
}

/** `db_url_parse` discards the stripped password, so this must not claim it was stored.
 * Asserted verbatim in the tests. */
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

/** The IPC call itself may never settle, where Rust's timeouts cannot help. */
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

/** Success shows version and latency (proof of a round trip); failure shows only Rust's
 * mapped, redacted message, with the typed password scrubbed too. */
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

/** Server-enforced on Postgres/MySQL/ClickHouse; an in-process filter on Mongo/Redis, and the
 * note must say so. */
export function readOnlyNote(spec: EngineSpec): string {
  return spec.serverEnforcedReadOnly
    ? `${spec.label} enforces this at the server for the whole session — a write or a DDL statement fails at the database, not here.`
    : `${spec.label} has no server-side read-only mode, so Agent Studio filters commands in-process. That is a speed bump, not a guarantee: for a real boundary, connect as a read-only database user.`;
}

/** Says what the flag is worth on this engine. `spec === null` is real (a saved engine this build
 * doesn't offer): then it says enforcement is unknown. */
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

/** Tauri rejects with a string, not an `Error`; neither may render as `[object Object]`. */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** `null` when the browser's order is right; pure so the trap's edges are tested as data. */
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
