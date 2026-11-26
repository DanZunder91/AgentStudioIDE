/** Public surface of config bundles, deliberately narrow: the `<PortabilityDialogs/>` container,
 * not the dialogs (they stay presentational), plus IPC and errors for the store. */

export * from "./portabilityIpc";
export * from "./portabilityErrors";
// `export *`, not `export type *`: `types.ts` carries runtime constants the dialogs need
// (`MIN_PASSPHRASE_LENGTH`, `PORTABILITY_ERROR_CODES`, …).
export * from "./types";
export { PortabilityDialogs } from "./PortabilityDialogs";
