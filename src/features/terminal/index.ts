/** Public surface (ARCHITECTURE §4): <TerminalView/> is the UI; the registry owns instance
 * lifetime, so call dispose() when a tab closes for good (unmount only detaches). */

export { TerminalView } from "./TerminalView";
export type { TerminalViewProps } from "./TerminalView";

export { useTerminal } from "./useTerminal";
export type { UseTerminalOptions } from "./useTerminal";

export {
  attach,
  configureTerminal,
  detach,
  dispose,
  disposeAll,
  ensureTerminal,
  focusTerminal,
  getRendererKind,
  getTerminal,
  getTerminalMeta,
  hasTerminal,
  serializeTerminal,
  setDefaultTerminalCwd,
} from "./TerminalRegistry";
export type { TerminalSpawnOptions } from "./TerminalRegistry";

export { getRendererPreference, setRendererPreference } from "./renderer";
export type { RendererKind, RendererPreference } from "./renderer";
