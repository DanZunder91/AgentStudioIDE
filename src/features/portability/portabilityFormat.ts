/** Every decision and sentence of the config-bundle dialogs, pure so tests need no render.
 * The copy is code: what users learn about passphrases and unsigned bundles lives only in these
 * sentences, so they are named constants tested against their literal text. */

import {
  MAX_BUNDLE_BYTES,
  MIN_PASSPHRASE_LENGTH,
  REDACTED_PLACEHOLDER,
  type BundleCounts,
  type BundleHeader,
  type BundleMode,
  type ExportOptions,
  type ImportAction,
  type ImportCounts,
  type ImportItem,
  type ImportPlan,
  type ImportResult,
} from "./types";

/* ═════════════════════════════ what the export dialog is given ═══════════════ */

/** One selectable record. `detail` is a dim second line: `"postgres · db.internal:5432"`. */
export interface ExportSelectable {
  id: string;
  name: string;
  detail: string | null;
}

/** `hasValue` keeps the structure-mode "left out" list truthful: a never-filled variable has no
 * value to withhold. */
export interface ExportEnvironmentSummary {
  id: string;
  name: string;
  variables: { key: string; hasValue: boolean }[];
}

/** Everything on this machine that could go into a bundle. */
export interface ExportSource {
  dbConnections: ExportSelectable[];
  apiRequests: ExportSelectable[];
  environments: ExportEnvironmentSummary[];
}

/** Which ids the user ticked. Always explicit arrays — see `toExportOptions`. */
export interface ExportSelection {
  dbConnectionIds: string[];
  apiRequestIds: string[];
  environmentIds: string[];
}

/* ═════════════════════════════ the mode choice ═══════════════════════════════ */

/** The safe mode is the default (a `sealed` default ships live credentials in the common case);
 * a named constant with its own test, not a `useState` literal. */
export const DEFAULT_EXPORT_MODE: BundleMode = "structure";

export interface ModeChoice {
  value: BundleMode;
  /** The radio's own label. */
  title: string;
  /** One sentence that makes the difference concrete. */
  blurb: string;
}

/** Structure first: reading order is a default too. Blurbs name consequences, not mechanisms
 * ("AES-256-GCM" reassures in the wrong direction). */
export const MODE_CHOICES: ModeChoice[] = [
  {
    value: "structure",
    title: "Structure only — no secret values",
    blurb:
      "Connections, requests and variable names travel; every secret value stays on this " +
      "machine. Safe to paste in Slack or attach to a ticket — the recipient supplies their " +
      "own passwords.",
  },
  {
    value: "sealed",
    title: "Sealed — includes your secret values",
    blurb:
      "The same contents with your secret values inside, encrypted with a passphrase you " +
      "send separately. Anyone who has both the file and the passphrase has your credentials.",
  },
];

/** The blurb for one mode. Exposed so a summary line can restate it without the radios. */
export function modeBlurb(mode: BundleMode): string {
  const found = MODE_CHOICES.find((c) => c.value === mode);
  // Unreachable via the UI (the radios only ever emit a `BundleMode`), but a total
  // function is cheaper than a non-null assertion that a future third mode would break.
  return found === undefined ? "" : found.blurb;
}

/* ═════════════════════════════ the passphrase ════════════════════════════════ */

/** The attack is offline (PBKDF2, GPU cracking), so a weak passphrase is fatal; this says so
 * instead of showing a padlock. Never "military-grade", "secure", or a cipher name. */
export const PASSPHRASE_TRUTH =
  "Encryption does not make a weak passphrase safe. Whoever ends up with this file can " +
  "guess at the passphrase offline, as fast as their hardware allows, for as long as they " +
  "like — there is nothing here to slow them down or lock them out. A short or guessable " +
  "passphrase is the only thing between them and these values.";

export const PASSPHRASE_ADVICE =
  "Use several random words rather than one clever word, and send the passphrase through a " +
  "different channel than the file — a passphrase pasted under the attachment protects nothing.";

/** No iteration count: it lives in Rust and travels in the file; a copy here would drift. */
export const KDF_NOTE =
  "The file records how its key was derived (PBKDF2-HMAC-SHA256), so a recipient can judge " +
  "what they were sent. It is deliberately slow, but weaker against GPU cracking than newer " +
  "schemes — which is why the passphrase, not the algorithm, is what protects these values.";

export interface PassphraseState {
  /** Whether this pair is good enough to seal with. */
  ok: boolean;
  /** What to show under the fields, or `null` when there is nothing useful to say. */
  message: string | null;
}

/** Not a strength meter: `MIN_PASSPHRASE_LENGTH` is a hard floor Rust enforces too, and a meter
 * implies clearing a bar makes it safe. An empty box says nothing (Export is already disabled). */
export function passphraseState(passphrase: string, confirm: string): PassphraseState {
  if (passphrase === "") return { ok: false, message: null };
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    const missing = MIN_PASSPHRASE_LENGTH - passphrase.length;
    return {
      ok: false,
      message: `At least ${MIN_PASSPHRASE_LENGTH} characters — ${missing} more to go.`,
    };
  }
  if (confirm !== passphrase) return { ok: false, message: "The two passphrases do not match." };
  return { ok: true, message: null };
}

/* ═════════════════════════════ selection & counts ════════════════════════════ */

/** Everything ticked. The dialog opens on this: an export of nothing is never the intent. */
export function initialSelection(source: ExportSource): ExportSelection {
  return {
    dbConnectionIds: source.dbConnections.map((c) => c.id),
    apiRequestIds: source.apiRequests.map((r) => r.id),
    environmentIds: source.environments.map((e) => e.id),
  };
}

/** Add or remove one id, order-preserving. */
export function toggleId(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
}

export interface SelectionCounts {
  dbConnections: number;
  apiRequests: number;
  environments: number;
  /** Distinct variable names across the selected environments. */
  variables: number;
  /** How many of those have a value on this machine — i.e. how much `sealed` would carry. */
  variablesWithValue: number;
}

/** Ignores ids not in `source`: a connection dropped while the dialog is open must not inflate
 * the count. */
export function selectionCounts(source: ExportSource, selection: ExportSelection): SelectionCounts {
  const envs = source.environments.filter((e) => selection.environmentIds.includes(e.id));
  const seen = new Map<string, boolean>();
  for (const env of envs) {
    for (const v of env.variables) {
      // A variable named in two environments is one variable; it counts as carrying a
      // value if EITHER copy has one, because either copy is enough to travel.
      seen.set(v.key, (seen.get(v.key) ?? false) || v.hasValue);
    }
  }
  return {
    dbConnections: source.dbConnections.filter((c) => selection.dbConnectionIds.includes(c.id))
      .length,
    apiRequests: source.apiRequests.filter((r) => selection.apiRequestIds.includes(r.id)).length,
    environments: envs.length,
    variables: seen.size,
    variablesWithValue: [...seen.values()].filter((has) => has).length,
  };
}

/** `3` → `"3 connections"`, `1` → `"1 connection"`. */
export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Exported so the `[]` arm is testable: every caller guards the empty case itself. */
export function joinClauses(parts: string[]): string {
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** The one-line "this bundle will contain…" summary. Empty selection says so plainly. */
export function describeSelection(counts: SelectionCounts): string {
  const parts: string[] = [];
  if (counts.dbConnections > 0) {
    parts.push(plural(counts.dbConnections, "database connection", "database connections"));
  }
  if (counts.apiRequests > 0) parts.push(plural(counts.apiRequests, "request", "requests"));
  if (counts.environments > 0) {
    parts.push(plural(counts.environments, "environment", "environments"));
  }
  if (parts.length === 0) return "This bundle would be empty.";
  const variables =
    counts.variables === 0
      ? ""
      : `, referencing ${plural(counts.variables, "variable", "variables")}`;
  return `${joinClauses(parts)}${variables}.`;
}

/* ═════════════════════════════ what structure mode leaves behind ═════════════ */

export const WITHHELD_INTRO =
  "These values are NOT in the file. The recipient has to supply each one before this " +
  "config works:";

/** Its own sentence: "nothing left out" and "not checked" look the same as an absent list. */
export const WITHHELD_NONE =
  "Nothing is being withheld — none of the selected environments holds a value on this machine.";

/** What a literal secret typed straight into a header becomes on the way out. */
export const REDACTED_HEADER_NOTE =
  `A header that holds a literal secret rather than a {{VAR}} reference is replaced with ` +
  `"${REDACTED_PLACEHOLDER}", so an imported request fails loudly instead of quietly sending ` +
  `an empty credential.`;

/** Names whose values stay behind in `structure` mode, sorted: tells the sharer up front why the
 * recipient's requests would 401. */
export function withheldVariableNames(
  source: ExportSource,
  selection: ExportSelection,
): string[] {
  const names = new Set<string>();
  for (const env of source.environments) {
    if (!selection.environmentIds.includes(env.id)) continue;
    for (const v of env.variables) {
      if (v.hasValue) names.add(v.key);
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

/* ═════════════════════════════ the export call ═══════════════════════════════ */

/** A reason, not a boolean: a disabled button must never be a dead end. */
export function exportBlockedReason(
  mode: BundleMode,
  counts: SelectionCounts,
  passphrase: string,
  confirm: string,
): string | null {
  if (counts.dbConnections + counts.apiRequests + counts.environments === 0) {
    return "Choose at least one thing to include.";
  }
  if (mode !== "sealed") return null;
  if (passphrase === "") return "Enter a passphrase to seal this bundle.";
  const state = passphraseState(passphrase, confirm);
  return state.ok ? null : state.message;
}

/** Id arrays are always explicit (`types.ts` reads absence as "include all"); `passphrase` is
 * omitted outside `sealed`, where the contract rejects it (even `""`). */
export function toExportOptions(
  mode: BundleMode,
  label: string,
  selection: ExportSelection,
  passphrase: string,
): ExportOptions {
  const base: ExportOptions = {
    mode,
    label: label.trim(),
    dbConnectionIds: [...selection.dbConnectionIds],
    apiRequestIds: [...selection.apiRequestIds],
    environmentIds: [...selection.environmentIds],
  };
  return mode === "sealed" ? { ...base, passphrase } : base;
}

/* ═════════════════════════════ describing a bundle ═══════════════════════════ */

/** `"2025-07-28 08:00 UTC"`: UTC on purpose (locale formats vary by machine; it is forensic). */
export function formatTimestamp(ms: number): string {
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** Reported speech only: nothing is signed, so "verified" would be a lie told for the attacker. */
export function provenanceSentence(header: BundleHeader): string {
  const named = header.label.trim() === "" ? "" : ` and calls itself "${header.label.trim()}"`;
  return (
    `This file says it was exported by ${header.app} on ${formatTimestamp(header.createdAtMs)}` +
    `${named}.`
  );
}

/** The other half of the sentence above, kept separate so it can be styled as a warning. */
export const UNVERIFIED_NOTE =
  "Nothing here is verified. A bundle is a plain JSON file with no signature, so everything " +
  "it says about itself is only a claim — trust it exactly as much as you trust wherever you " +
  "got the file.";

/** The four content kinds as clauses; structural, so `BundleCounts` and `ImportCounts` share it. */
function contentClauses(counts: {
  dbConnections: number;
  dbQueries: number;
  apiRequests: number;
  environments: number;
}): string[] {
  const parts: string[] = [];
  if (counts.dbConnections > 0) {
    parts.push(plural(counts.dbConnections, "database connection", "database connections"));
  }
  if (counts.dbQueries > 0) parts.push(plural(counts.dbQueries, "saved query", "saved queries"));
  if (counts.apiRequests > 0) parts.push(plural(counts.apiRequests, "request", "requests"));
  if (counts.environments > 0) {
    parts.push(plural(counts.environments, "environment", "environments"));
  }
  return parts;
}

/** The four content kinds only: `referencedVariables` counts names the contents refer to, which
 * belongs in the variables block. */
export function describeCounts(counts: BundleCounts): string {
  const parts = contentClauses(counts);
  return parts.length === 0 ? "nothing" : joinClauses(parts);
}

/** For an `ImportResult`, where variables are written items. Takes `ImportCounts`: a header's
 * `referencedVariables` counts names a file mentions, not variables written. */
export function describeChange(counts: ImportCounts): string {
  const parts = contentClauses(counts);
  if (counts.variables > 0) {
    parts.push(plural(counts.variables, "variable", "variables"));
  }
  return parts.length === 0 ? "nothing" : joinClauses(parts);
}

/** From the header alone, so readable for a sealed bundle without the passphrase (the bounded
 * disclosure `BundleCounts` exists for). */
export function describeSecretValues(counts: BundleCounts): string {
  if (counts.secretValues === 0) return "It carries no secret values.";
  return `It carries ${plural(counts.secretValues, "secret value", "secret values")}.`;
}

/** Shown while a sealed bundle is still locked. */
export const SEALED_LOCKED_NOTE =
  "This bundle is sealed, so its contents cannot be listed until it is unlocked. The counts " +
  "above come from the file's unencrypted header, which nothing verifies.";

/** The size ceiling, derived from the constant so the two can never disagree. */
export function formatMegabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

export const PICK_FILE_NOTE =
  "Choose a bundle file to review. Nothing is written until you say so. " +
  `Up to ${formatMegabytes(MAX_BUNDLE_BYTES)}.`;

/* ═════════════════════════════ the import review ═════════════════════════════ */

export const HOSTS_INTRO = "Everything in this bundle would talk to these hosts:";
export const HOSTS_NONE = "Nothing in this bundle contacts a host.";

/** `"Contacts 2 hosts:"` / the none-case sentence. */
export function hostsSummary(hosts: string[]): string {
  return hosts.length === 0 ? HOSTS_NONE : HOSTS_INTRO;
}

export interface VariableSummary {
  total: number;
  /** How many this machine already has a value for. */
  alreadyHeld: number;
  message: string;
}

/** The exfiltration risk, stated once without alarm: "your value" + "their host" in one sentence.
 * Intent is undecidable, and a dialog that cries wolf gets clicked through. */
export function variableSummary(plan: ImportPlan): VariableSummary {
  const total = plan.variables.length;
  const alreadyHeld = plan.variables.filter((v) => v.haveLocally).length;
  if (total === 0) {
    return { total, alreadyHeld, message: "This bundle does not reference any variables." };
  }
  const reads = `Reads ${plural(total, "variable", "variables")}.`;
  const tail =
    alreadyHeld === 0
      ? " You do not have a value for any of them yet."
      : ` You already have a value for ${alreadyHeld} of them, so an imported request can read ` +
        `your value and send it to any host listed above.`;
  return { total, alreadyHeld, message: `${reads}${tail}` };
}

/** `true` when this bundle still needs a passphrase before its contents can be listed. */
export function needsPassphrase(plan: ImportPlan): boolean {
  return !plan.unsealed;
}

export const KIND_ORDER: ImportItem["kind"][] = [
  "dbConnection",
  "dbQuery",
  "apiRequest",
  "environment",
  "variable",
];

/** Heading for a group of items. */
export function kindLabel(kind: ImportItem["kind"]): string {
  switch (kind) {
    case "dbConnection":
      return "Database connections";
    case "dbQuery":
      return "Saved queries";
    case "apiRequest":
      return "API requests";
    case "environment":
      return "Environments";
    case "variable":
      return "Variables";
  }
}

export interface ItemGroup {
  kind: ImportItem["kind"];
  label: string;
  items: ImportItem[];
}

/** Fixed `KIND_ORDER`, empty groups dropped: a list that reshuffles cannot be scanned. */
export function groupPlanItems(items: ImportItem[]): ItemGroup[] {
  return KIND_ORDER.map((kind) => ({
    kind,
    label: kindLabel(kind),
    items: items.filter((i) => i.kind === kind),
  })).filter((g) => g.items.length > 0);
}

export const ACTION_CHOICES: ImportAction[] = ["create", "update", "skip"];

export function actionLabel(action: ImportAction): string {
  switch (action) {
    case "create":
      return "Create";
    case "update":
      return "Update";
    case "skip":
      return "Skip";
  }
}

/** The user's override if set, else the plan's default. */
export function effectiveAction(
  item: ImportItem,
  overrides: Record<string, ImportAction>,
): ImportAction {
  return overrides[item.id] ?? item.action;
}

/** Only entries differing from the plan's default: an override must not look like an echo. */
export function overrideActions(
  items: ImportItem[],
  overrides: Record<string, ImportAction>,
): Record<string, ImportAction> {
  const out: Record<string, ImportAction> = {};
  for (const item of items) {
    const chosen = overrides[item.id];
    if (chosen !== undefined && chosen !== item.action) out[item.id] = chosen;
  }
  return out;
}

export const OVERWRITE_LABEL = "Let incoming values replace secrets I already have";

/** Describes both positions: the default is the one almost everyone keeps. */
export const OVERWRITE_HINT =
  "Off: variables you already have a value for keep your value and the bundle's value is " +
  "ignored. On: the bundle's value replaces yours wherever it carries one — which is how a " +
  "working setup breaks in a way that is very hard to trace back to an import.";

/** Read-only is enforced but optional: the default stands, and the importer gets the decision. */
export const IMPORT_READ_ONLY_LABEL = "Import connections as read-only";

/** Both positions, and why the default is on: re-enabling is one click, and an unintended `DELETE`
 * is not recoverable. */
export const IMPORT_READ_ONLY_HINT =
  "On (default): connections arrive read-only, because you did not make the sharer's decision — " +
  "a connection that has just landed is new on this machine. Off: each connection keeps whatever " +
  "the file says, so a read-write one can DELETE and UPDATE against the server as soon as it is " +
  "imported. You can change either afterwards in the connection dialog.";

/** The final "here is what happened" line. */
export function describeResult(result: ImportResult): string {
  const parts: string[] = [];
  const created = describeChange(result.created);
  const updated = describeChange(result.updated);
  const skipped = describeChange(result.skipped);
  if (created !== "nothing") parts.push(`Created ${created}`);
  if (updated !== "nothing") parts.push(`updated ${updated}`);
  if (skipped !== "nothing") parts.push(`skipped ${skipped}`);
  return parts.length === 0 ? "Nothing was changed." : `${joinClauses(parts)}.`;
}

/** DOM id / React key for one item row. Kinds share the id space, so both parts matter. */
export function itemDomId(item: ImportItem): string {
  return `portability-item-${item.kind}-${item.id}`;
}
