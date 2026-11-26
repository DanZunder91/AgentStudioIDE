/** The one `invoke` seam for config bundles. Rejections pass through untouched; every argument key
 * is always present (Tauri reads by key; a missing one fails silently). Bundle bytes never cross:
 * Rust reads/writes the file. A passphrase is only ever an argument, never stored or logged. */

import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";

import type {
  BundleHeader,
  ExportOptions,
  ImportAction,
  ImportChoices,
  ImportPlan,
  ImportResult,
} from "./types";

/* ────────────────────────────── the three commands ────────────────────────── */

/** `options` may carry the sealing passphrase, so it is transient: never held on the JS side.
 * Rust enforces `MIN_PASSPHRASE_LENGTH` (the dialog's check is a courtesy). The returned
 * header's counts are Rust's measurement of what it wrote. */
export function portabilityExport(
  options: ExportOptions,
  destPath: string,
): Promise<BundleHeader> {
  return invoke<BundleHeader>("portability_export", { options, destPath });
}

/** A dry run that writes nothing: first with `passphrase: null` to read the header, then with the
 * passphrase to unseal, so a failed unseal is not sticky. */
export function portabilityInspect(
  srcPath: string,
  passphrase: string | null,
): Promise<ImportPlan> {
  return invoke<ImportPlan>("portability_inspect", { srcPath, passphrase });
}

/** The passphrase is supplied again, not carried over: Rust re-opens the file, so no secret has
 * to live between the two calls. */
export function portabilityImport(
  srcPath: string,
  passphrase: string | null,
  choices: ImportChoices,
): Promise<ImportResult> {
  return invoke<ImportResult>("portability_import", { srcPath, passphrase, choices });
}

/** `actions` is copied so the store's map is never mutated mid-call, and holds only overrides
 * (absent = the plan's default), so a later change to Rust's default is not silently lost. */
export function importChoices(
  actions: Record<string, ImportAction>,
  overwriteExistingSecrets: boolean,
  /** Defaults to `true`, matching Rust's serde default: an omitted value must be the safe one. */
  forceReadOnly = true,
): ImportChoices {
  return { actions: { ...actions }, overwriteExistingSecrets, forceReadOnly };
}

/* ──────────────────────────────── the file picker ─────────────────────────── */

/** A bundle is JSON; the filter keeps an import off a `.sql` or `.png` before `not-a-bundle`. */
const BUNDLE_FILTER = { name: "Agent Studio bundle", extensions: ["json"] };

/** ASCII slug of the label (`"Team staging DB + API"` → `"team-staging-db-api.json"`); accents are
 * lost, fine for an editable suggestion. An empty slug falls back to a name, never `".json"`. */
export function bundleFileName(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    // Truncated BEFORE the dashes are trimmed, so a cut that lands on a separator does not
    // leave one dangling at the end.
    .slice(0, 48)
    .replace(/^-+|-+$/g, "");
  return `${slug === "" ? "agentstudio-bundle" : slug}.json`;
}

/** `null` when cancelled; `typeof path === "string"` folds every "no path" answer into one. */
export async function pickBundleDestination(label: string): Promise<string | null> {
  const path = await save({
    title: "Export config bundle",
    defaultPath: bundleFileName(label),
    filters: [BUNDLE_FILTER],
  });
  return typeof path === "string" ? path : null;
}

/** Ask the user which bundle to read. `null` when they cancelled. */
export async function pickBundleSource(): Promise<string | null> {
  const path = await open({
    title: "Import config bundle",
    directory: false,
    multiple: false,
    filters: [BUNDLE_FILTER],
  });
  return typeof path === "string" ? path : null;
}
