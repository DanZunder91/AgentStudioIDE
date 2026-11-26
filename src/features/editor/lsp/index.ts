/** LSP public surface; `EditorRegistry` wires `ensureClient` + `definitionNavigation`. */

export { ensureClient, resetClients } from "./client";
export { definitionNavigation, goToDefinitionAt } from "./definition";
export { findUsagesAt } from "./references";
export { makeConnection } from "./transport";
export { pathFromUri, uriFromPath } from "./uri";
export { lspStart, lspSend, lspStop } from "./lspIpc";
export type { LspServerMeta } from "./lspIpc";
export { AgentStudioWorkspace } from "./workspace";
