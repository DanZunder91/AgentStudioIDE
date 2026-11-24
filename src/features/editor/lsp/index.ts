/**
 * Code intelligence (LSP) — public surface (M5).
 *
 * `EditorRegistry` calls `ensureClient` + `definitionNavigation` to wire the LSP
 * client into a Rust editor. The rest is exported for the bridge and for tests.
 */

export { ensureClient, resetClients } from "./client";
export { definitionNavigation, goToDefinitionAt } from "./definition";
export { findUsagesAt } from "./references";
export { makeConnection } from "./transport";
export { pathFromUri, uriFromPath } from "./uri";
export { lspStart, lspSend, lspStop } from "./lspIpc";
export type { LspServerMeta } from "./lspIpc";
export { AgentStudioWorkspace } from "./workspace";
