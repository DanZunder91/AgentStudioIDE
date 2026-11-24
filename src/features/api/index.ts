/**
 * Public surface of the API client feature (M6).
 *
 * `<ApiRequestView/>` renders one request tab (keyed by requestId); the titlebar
 * `<ApiRequestButton/>` opens a new one. The IPC wrapper + wire types are exported
 * for the bridge and for tests.
 */

export { ApiRequestView } from "./ApiRequestView";
export { ApiRequestButton } from "./ApiRequestButton";
export { VaultPanel } from "./VaultPanel";
export { HistoryPanel } from "./HistoryPanel";
// The saved-request library rail + the Cmd/Ctrl+S save flow.
export { CollectionsPanel } from "./CollectionsPanel";
export { SaveRequestDialog } from "./SaveRequestDialog";
export { SaveRequestShortcut } from "./SaveRequestShortcut";
export { WsConsole } from "./WsConsole";
export { GrpcConsole } from "./GrpcConsole";
export { isCurlCommand, parseCurl, tokenizeCurl } from "./curlParse";
export type { ParsedCurl, ParsedHeader } from "./curlParse";
export { executeHttpRequest, executeGrpcRequest } from "./execute";
// A/B compare: the split view, the dual-send path, and the pure
// key-sorter (reusable beyond compare).
export { CompareBar, ComparePanel } from "./ComparePanel";
export { executeCompareRequest } from "./compareExecute";
export { sortJsonKeys } from "./jsonSort";
export { sendHttp } from "./httpIpc";
export type { HttpHeader, HttpRequest, HttpResponse } from "./httpIpc";
// The WebSocket console IPC + its wire event type.
export { wsClose, wsConnect, wsSend } from "./wsIpc";
export type { WsEvent } from "./wsIpc";
// The gRPC (native tonic) IPC + its wire types.
export { grpcReflect, grpcSend } from "./grpcIpc";
export type {
  GrpcMetadata,
  GrpcMethodInfo,
  GrpcRequest,
  GrpcResponse,
  GrpcSchema,
  GrpcServiceInfo,
} from "./grpcIpc";
// The durable store IPC + `{{var}}` substitution helpers + wire types.
export { loadApiStore, saveApiStore } from "./apiStoreIpc";
export type {
  ApiStore,
  EnvVar,
  Environment,
  SavedRequest,
} from "./apiStoreIpc";
export { activeVars, substituteVars } from "./substitute";
// M6 follow-on: request history IPC + wire types.
export { loadApiHistory, saveApiHistory } from "./historyIpc";
export type { HistoryEntry, HistoryStore } from "./historyIpc";
// Navigable history: the pure shaping behind the
// panel — newest-first day buckets, the recent/grouped split, and the search
// filter. Pure and clock-injected, so the panel and any future consumer
// (a command palette, an export) can never disagree about what "Yesterday" means.
export {
  dayKey,
  dayLabel,
  matchesQuery,
  partitionHistory,
  searchHistory,
  timeLabel,
} from "./historyGroup";
export type { DayGroup } from "./historyGroup";
// Request sequences: a list of requests run in order,
// carrying captured values forward. The runner and the pure path extractor are
// exported for tests and for any future consumer (a CLI runner, a saved flow).
export { SequenceView } from "./SequenceView";
export { SequenceButton } from "./SequenceButton";
export { executeSequence, executeSequenceStep } from "./sequenceExecute";
export { extractPath } from "./extractPath";
export type { Extracted } from "./extractPath";
