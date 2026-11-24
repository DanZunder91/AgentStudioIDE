/**
 * portabilityFormat — every decision and every sentence the share-a-config dialogs
 * make, with no DOM in sight.
 *
 * ── Why this file exists ─────────────────────────────────────────────────────
 * The interesting parts of this feature are not React. They are: *which* mode is the
 * default, *when* the Export button is allowed to be enabled, *what* a structure-only
 * bundle leaves behind, and *how honestly* an import describes a file nobody signed.
 * Each of those is a pure function of data, so each one is pinned by a test that needs
 * no render, no fake timers, and no `screen`. The dialogs are then thin: they read
 * these values and lay them out.
 *
 * ── The copy is code ─────────────────────────────────────────────────────────
 * The passphrase is the weak link of a sealed bundle, and a bundle proves nothing about
 * its author. Neither statement is enforceable in Rust — the only
 * place a user ever learns them is the sentence they read. So the sentences live here
 * as named constants with tests against their literal text, exactly like a validation
 * rule. Changing one is a deliberate act with a red test, not a drive-by edit.
 *
 * ── Literal expectations ─────────────────────────────────────────────────────
 * Nothing here reads its own expectation from the data it formats. The tests spell out
 * the strings; `portabilityFixtures.ts` holds inputs only.
 */

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

/**
 * An environment, plus the one bit the export dialog needs that a name cannot give it:
 * whether this machine actually **holds a value** for each variable.
 *
 * That flag is what makes the structure-mode "left out" list truthful. A variable the
 * sharer never filled in has no value to withhold, and listing it as withheld would
 * teach the recipient to look for something that was never there.
 */
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

/**
 * The default, named once so the dialog cannot disagree with the design.
 *
 * The safe mode is the default. This is the single most consequential
 * line in the feature — a default of `sealed` would mean the common case ships live
 * credentials — so it is a constant with its own test rather than an initial-state
 * literal buried in a `useState`.
 */
export const DEFAULT_EXPORT_MODE: BundleMode = "structure";

export interface ModeChoice {
  value: BundleMode;
  /** The radio's own label. */
  title: string;
  /** One sentence that makes the difference concrete. */
  blurb: string;
}

/**
 * Structure first, deliberately: reading order is a default too.
 *
 * The blurbs name the *consequence*, not the mechanism. "Safe to paste in Slack" and
 * "your secret values travel inside it" are things a person can act on; "AES-256-GCM"
 * is not, and reassures in the wrong direction.
 */
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

/**
 * 🔴 The most important text in this feature.
 *
 * The format's stated limitation is that PBKDF2 is weaker than Argon2id against GPU
 * cracking and that a weak passphrase remains the weak link. A dialog that shows a
 * padlock and the word "encrypted" tells the user the opposite of that. So this says
 * the mechanism out loud: the attack is **offline**, which is the fact that makes a
 * short passphrase fatal here in a way it is not on a login form with rate limiting.
 *
 * It deliberately does NOT say "military-grade", "secure", or name a cipher.
 */
export const PASSPHRASE_TRUTH =
  "Encryption does not make a weak passphrase safe. Whoever ends up with this file can " +
  "guess at the passphrase offline, as fast as their hardware allows, for as long as they " +
  "like — there is nothing here to slow them down or lock them out. A short or guessable " +
  "passphrase is the only thing between them and these values.";

/**
 * The practical follow-through. Advice without a mechanism is decoration; each clause
 * here removes a specific failure we can name.
 */
export const PASSPHRASE_ADVICE =
  "Use several random words rather than one clever word, and send the passphrase through a " +
  "different channel than the file — a passphrase pasted under the attachment protects nothing.";

/**
 * The honest note about the key derivation, without a number in it.
 *
 * The iteration count lives in Rust and travels inside the file; repeating it here
 * would be a second copy free to drift. What the user needs
 * is the *shape* of the guarantee, and that does not change when the count is raised.
 */
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

/**
 * Judge the passphrase pair. Not a strength meter — `MIN_PASSPHRASE_LENGTH` is a hard
 * floor that Rust enforces too, and a meter would imply that clearing a
 * bar makes the value safe. The message counts *up to* the floor rather than scoring
 * past it, on purpose.
 *
 * An empty box says nothing: nagging someone who has not started typing is noise, and
 * the Export button is already disabled to carry that information.
 */
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

/**
 * Count what is ticked, ignoring ids that are not in `source`.
 *
 * The filter is not paranoia: the selection is held across a re-render, and a store
 * that drops a connection while the dialog is open would otherwise inflate the count
 * and promise the recipient something the bundle cannot contain.
 */
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

/**
 * Join with commas and a final "and", so a summary reads as a sentence rather than a
 * comma-separated log line. Exported because every caller below guards the empty case
 * itself, which would otherwise leave the `[]` arm of this function unreachable — and an
 * untestable line is a line nobody can be sure about.
 */
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

/**
 * The sentence for a structure export that withholds nothing.
 *
 * Worth its own string rather than hiding the block: "nothing was left out" and "we did
 * not check" look identical when the answer is an absent list.
 */
export const WITHHELD_NONE =
  "Nothing is being withheld — none of the selected environments holds a value on this machine.";

/** What a literal secret typed straight into a header becomes on the way out. */
export const REDACTED_HEADER_NOTE =
  `A header that holds a literal secret rather than a {{VAR}} reference is replaced with ` +
  `"${REDACTED_PLACEHOLDER}", so an imported request fails loudly instead of quietly sending ` +
  `an empty credential.`;

/**
 * The variable names whose **values** stay behind in `structure` mode, sorted.
 *
 * This is the entire fix for the likeliest support complaint in this feature: someone
 * shares a config, the recipient's requests 401, and neither of them knows why. One
 * list at export time turns that into a checklist.
 */
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

/**
 * Why Export is disabled, or `null` when it is not.
 *
 * A reason rather than a boolean, so a disabled button is never a dead end the user has
 * to guess at — the same rule the connection dialog's error summary follows.
 */
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

/**
 * Build the wire options.
 *
 * Two contract details are load-bearing. The id arrays are always **explicit**, never
 * omitted: `types.ts` reads an absent array as "include all", so relying on absence
 * would silently export the things the user just un-ticked. And `passphrase` is omitted
 * entirely outside `sealed` mode, because the contract says it is *rejected* there —
 * sending `passphrase: ""` would be an error, not a no-op.
 */
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

/**
 * `1753689600000` → `"2025-07-28 08:00 UTC"`.
 *
 * UTC and ISO-ish on purpose: a locale-formatted date is a test that fails on somebody
 * else's machine, and a bundle's timestamp is a forensic detail, not prose.
 */
export function formatTimestamp(ms: number): string {
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/**
 * 🔴 What the file *claims*, phrased as a claim.
 *
 * There is no signing, so "verified export from Alice" would be a lie the
 * UI tells on the attacker's behalf. Every verb here is reported speech.
 */
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

/** The four content kinds, as clauses. Shared by the header and the result summaries. */
/// Takes only the four fields both count types share, structurally — so one implementation serves
/// `BundleCounts` (what a file holds) and `ImportCounts` (what an import wrote) without either
/// needing to know about the other's extra fields.
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

/**
 * `"2 database connections, 1 request and 1 environment"`, or `"nothing"`.
 *
 * The four content kinds only. `referencedVariables` is deliberately left out here: in a
 * `BundleHeader` it counts names the contents *refer to*, which is a different statement
 * from "this file contains N things" and belongs in the variables block.
 */
export function describeCounts(counts: BundleCounts): string {
  const parts = contentClauses(counts);
  return parts.length === 0 ? "nothing" : joinClauses(parts);
}

/**
 * Like `describeCounts`, but for an `ImportResult`, where variables *are* items that got
 * written.
 *
 * Takes `ImportCounts`, not `BundleCounts`. The first version took the latter and read
 * `referencedVariables` as "variables written" — which it is not; it counts distinct names a
 * *file* mentions. The receipt therefore said "3 variables" for an import that wrote none. Two
 * meanings needed two types, and `types.ts` now has both.
 */
export function describeChange(counts: ImportCounts): string {
  const parts = contentClauses(counts);
  if (counts.variables > 0) {
    parts.push(plural(counts.variables, "variable", "variables"));
  }
  return parts.length === 0 ? "nothing" : joinClauses(parts);
}

/**
 * Whether the file carries values, from the header alone.
 *
 * Readable for a sealed bundle without the passphrase — that bounded disclosure is
 * exactly what `BundleCounts` is for, and it is what lets someone decide whether a file
 * they were sent by accident matters.
 */
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

/**
 * 🔴 The exfiltration risk, stated once, without alarm.
 *
 * An imported request may read `{{PROD_STRIPE_KEY}}` — which the recipient
 * may well hold — while pointing anywhere. Intent is not decidable, so the honest move
 * is to put the two halves ("your value" + "their host") in one sentence and let the
 * person judge. No exclamation marks, no red, no blocking: this is information, and a
 * dialog that cries wolf gets clicked through.
 */
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

/**
 * Group the plan into stable, named sections in `KIND_ORDER`, dropping empty ones.
 *
 * Fixed order rather than order-of-appearance: the review screen is something a person
 * scans for one thing, and a list that reshuffles between two files of the same shape
 * cannot be scanned.
 */
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

/**
 * The effective action for one item: the user's override if they set one, else the
 * plan's own default.
 */
export function effectiveAction(
  item: ImportItem,
  overrides: Record<string, ImportAction>,
): ImportAction {
  return overrides[item.id] ?? item.action;
}

/**
 * Reduce the UI's overrides to what the contract wants: only the entries that actually
 * differ from the plan's default.
 *
 * Sending every item back would work, but it would make an override indistinguishable
 * from an echo — and the contract's "absent means use the plan's default" then carries
 * no information for a backend that wants to re-plan.
 */
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

/**
 * What the switch does, in both positions.
 *
 * A label that only describes the "on" state leaves the default's behaviour implied,
 * and the default is the one almost everyone keeps.
 */
export const OVERWRITE_HINT =
  "Off: variables you already have a value for keep your value and the bundle's value is " +
  "ignored. On: the bundle's value replaces yours wherever it carries one — which is how a " +
  "working setup breaks in a way that is very hard to trace back to an import.";

/**
 * The read-only toggle's label.
 *
 * ⚠️ Replaces `FORCED_READ_ONLY_NOTE`, which was a flat *statement* about connections arriving
 * read-only no matter what the bundle said — accurate while the value was forced, and a lie
 * the moment it became **enforced but optional**. The reasoning
 * still justifies the default; the person on the review screen now gets the decision. Copy that
 * describes a forced behaviour would be describing something the checkbox beside it can switch off.
 */
export const IMPORT_READ_ONLY_LABEL = "Import connections as read-only";

/**
 * What the toggle does in **both** positions, and why the default leans the way it does.
 *
 * The asymmetry is the argument, and it is worth stating rather than implying: turning it back on is
 * one click, and a `DELETE` you did not mean to be able to run is not recoverable.
 */
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
