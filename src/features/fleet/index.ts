/**
 * Public surface of the fleet feature (ARCHITECTURE §4).
 *
 * React side: `<LeftRail/>` — mount it and it wires itself to the store.
 * Everything else here is for the bridge and for tests.
 */

export { LeftRail } from "./LeftRail";
export { AgentTree } from "./AgentTree";
export { AgentRow } from "./AgentRow";
export { AgentStatusPill } from "./AgentStatusPill";
export { flattenFleet, selectFleetRows, resetFleetRowsCache } from "./flatten";
export type { FleetRow } from "./flatten";
export { fleetSnapshot, spawnAgent } from "./fleetIpc";
export type { FleetSnapshot, SpawnAgentOptions } from "./fleetIpc";
