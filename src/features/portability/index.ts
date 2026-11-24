/**
 * The portability feature's public surface — shareable config bundles.
 *
 * A barrel for the same reason `features/db/index.ts` is one: whatever mounts the dialogs
 * should not have to know which file inside the feature they live in. Deliberately
 * **NARROW** — only what something outside `features/portability/**` legitimately needs.
 *
 * `portabilityIpc` and `portabilityErrors` are re-exported because the STORE imports them
 * (the portability slice's actions are the IPC's only caller), and `types.ts` because
 * everything speaks its shapes.
 *
 * What is exported is `<PortabilityDialogs/>` — the CONTAINER — and not the two dialogs
 * themselves. That is the narrow surface: `App.tsx` mounts one thing that decides which dialog
 * the store is asking for, and nothing outside this feature assembles fifteen props. The
 * dialogs stay presentational and reachable only through it, which is what keeps their tests
 * prop-driven.
 *
 * The seam between the dialogs and the store slice — two halves that never import each
 * other — is `PortabilityDialogs.test.tsx`, and it catches defects the two 100%-covered
 * halves cannot.
 */

export * from "./portabilityIpc";
export * from "./portabilityErrors";
// `export *`, not `export type *` (which is what `features/db/index.ts` uses): unlike
// `db/types.ts`, this contract carries RUNTIME constants the dialogs need —
// `MIN_PASSPHRASE_LENGTH`, `MAX_BUNDLE_BYTES`, `REDACTED_PLACEHOLDER`, `BUNDLE_KIND`,
// `BUNDLE_VERSION`, `PORTABILITY_ERROR_CODES` — and a type-only re-export would drop every
// one of them, leaving the dialog to hard-code the passphrase minimum next to the Rust that
// enforces a different one.
export * from "./types";
export { PortabilityDialogs } from "./PortabilityDialogs";
