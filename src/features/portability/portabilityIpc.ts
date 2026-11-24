/**
 * portabilityIpc — the ONE `invoke` seam for shareable config bundles.
 *
 * Feature-local (not `app/ipc.ts`), like `dbIpc.ts`, `usageIpc.ts` and `fleetIpc.ts`, so the
 * wire types live next to their feature.
 *
 * ── The rule these wrappers follow: they do not swallow ──────────────────────
 * Every rejection is passed through untouched, exactly as `dbIpc`'s are. The caller turns
 * the raw string into a code via `parsePortabilityError`, which only works if the string
 * arrives unmodified. Rust rejects with the stable `"<code>"` / `"<code>: <detail>"` wire
 * string (the app-wide shape; the codes are `PORTABILITY_ERROR_CODES` in `types.ts`), never
 * with an `Error`.
 *
 * ── Every argument is named on the wire ──────────────────────────────────────
 * Tauri deserialises a command's arguments **by key** (`src_path` in Rust ⇄ `srcPath` in
 * JS). A misspelled or missing key does not throw: serde fills the field from its default,
 * or rejects about a field the caller never mentioned. So `passphrase: null` is always
 * *present*, never omitted — a missing key fails as silence, which is the failure mode the
 * tests spell every name out to prevent.
 *
 * ── 🔴 Bundle bytes never cross this boundary, and a passphrase is never state ─
 * `types.ts` §"the command surface" is the rule: Rust reads and writes the file itself,
 * given a path the user picked; the webview only ever sees a header, a plan, or a result. In
 * `sealed` mode the plaintext holds live secrets, and a design where the webview assembles
 * or receives that string puts it in the renderer heap, in any devtools session, and in
 * whatever a future crash reporter captures.
 *
 * The passphrase is the same rule one step further in: it is an **argument** on all three
 * calls and it is never stored, never cached in a module variable here, and never logged.
 * There is deliberately no `rememberPassphrase`, no module-level `lastPassphrase`, and no
 * default parameter that could make one appear by accident — an inspect + an import are two
 * calls, and the dialog passes the string it already holds to each of them.
 *
 * ── The picker is here, once, on purpose ─────────────────────────────────────
 * `@tauri-apps/plugin-dialog` is wrapped in this module rather than called from a component
 * for two reasons: it keeps a plugin import out of the UI (the same call `WorkspaceTree` and
 * `LeftRail` make for the folder picker), and it is the ONE part of this feature a jsdom test
 * cannot exercise for real. Isolating it is what leaves everything else testable.
 */

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

/**
 * `portability_export` — write a bundle to `destPath` and return the header Rust put in it.
 *
 * `options` carries the sealing passphrase for `mode: "sealed"` (`types.ts`: required and
 * non-empty then, rejected otherwise), so this object is **transient by contract**: it comes
 * from the dialog's own draft, travels straight to Rust, and is never held anywhere on the
 * JS side. Rust enforces `MIN_PASSPHRASE_LENGTH` itself and rejects `weak-passphrase` — the
 * dialog's own check is a courtesy, not the boundary.
 *
 * Returns a header, not the bundle: the counts in it are what the "exported" summary renders,
 * and they are Rust's measurement of what it actually wrote rather than the UI's guess.
 */
export function portabilityExport(
  options: ExportOptions,
  destPath: string,
): Promise<BundleHeader> {
  return invoke<BundleHeader>("portability_export", { options, destPath });
}

/**
 * `portability_inspect` — a **dry run**. Writes nothing, either time it is called.
 *
 * Callable twice for a sealed bundle by design: once with `passphrase: null` to read the
 * header and describe the file, then again with the passphrase to unseal it and produce the
 * full plan. Because nothing is written, a wrong passphrase costs a retry and nothing else —
 * which is what lets the store treat a failed unseal as non-sticky.
 */
export function portabilityInspect(
  srcPath: string,
  passphrase: string | null,
): Promise<ImportPlan> {
  return invoke<ImportPlan>("portability_inspect", { srcPath, passphrase });
}

/**
 * `portability_import` — apply the plan, with the user's per-item choices.
 *
 * The passphrase is supplied **again** rather than carried over from the inspect: this is the
 * whole point of not holding it. Rust re-reads and re-opens the file, so the two calls are
 * independent and no secret has to live between them.
 */
export function portabilityImport(
  srcPath: string,
  passphrase: string | null,
  choices: ImportChoices,
): Promise<ImportResult> {
  return invoke<ImportResult>("portability_import", { srcPath, passphrase, choices });
}

/**
 * The user's decisions as the wire wants them.
 *
 * A builder rather than an object literal at the call site, mirroring `dbIpc`'s
 * `connectionInput`: `actions` is **copied**, so the store's own override map can never be
 * handed to `invoke` by reference and then mutated while a call is in flight.
 *
 * Only *overrides* belong in `actions` — `types.ts` says "absent means use the plan's
 * default", so resolving every item's default into this map would turn a later change in
 * Rust's default into a silent no-op.
 */
export function importChoices(
  actions: Record<string, ImportAction>,
  overwriteExistingSecrets: boolean,
  /**
   * Whether imported connections are made read-only. **Defaults to `true`**, matching Rust's serde
   * default — a caller that omits it must get the safe value, not `undefined` narrowed to
   * `false` (read-only on import is a default, not a forced value).
   */
  forceReadOnly = true,
): ImportChoices {
  return { actions: { ...actions }, overwriteExistingSecrets, forceReadOnly };
}

/* ──────────────────────────────── the file picker ─────────────────────────── */

/**
 * What the native picker shows in its file-type row. A bundle is JSON, and the
 * filter exists so an *import* cannot easily be pointed at a `.sql` or a `.png` — a
 * `not-a-bundle` rejection is a fine backstop but a poor first experience.
 */
const BUNDLE_FILTER = { name: "Agent Studio bundle", extensions: ["json"] };

/**
 * A default filename derived from the bundle's label: `"Team staging DB + API"` →
 * `"team-staging-db-api.json"`.
 *
 * ASCII-slugified, which loses accents (`"Équipe"` → `"quipe"`). That is a deliberate
 * track for a *suggested* filename the user can edit in the picker before saving; the label
 * itself travels inside the bundle untouched, so nothing is lost from the artefact. An empty
 * or entirely punctuation label falls back to a name rather than producing `".json"`, which
 * most file managers treat as a hidden file with no name.
 */
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

/**
 * Ask the user where to write a bundle. `null` when they cancelled.
 *
 * `typeof path === "string"` rather than `!== null`, the same normalisation
 * `WorkspaceTree`/`LeftRail` use on `open`: it collapses every "no path" answer the plugin
 * can give into one, so a caller cannot accidentally treat `undefined` as a destination.
 */
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
