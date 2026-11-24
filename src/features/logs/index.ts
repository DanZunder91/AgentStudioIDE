/** Diagnostics log — public surface. */
export { LogsButton } from "./LogsButton";
export { LogsPanel } from "./LogsPanel";
export {
  useLogStore,
  filterEntries,
  formatTime,
  formatEntry,
  logAgentEvent,
  logInfo,
  logEvent,
  logWarn,
  logError,
  LOG_CAP,
} from "./logStore";
export type { LogEntry, LogLevel, LevelFilter } from "./logStore";
