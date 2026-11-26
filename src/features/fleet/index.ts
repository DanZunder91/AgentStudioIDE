/** Fleet feature surface (ARCHITECTURE §4): `<LeftRail/>` wires itself; the rest is for the
 * bridge and tests. */

export { LeftRail } from "./LeftRail";
export { AgentTree } from "./AgentTree";
export { AgentRow } from "./AgentRow";
export { AgentStatusPill } from "./AgentStatusPill";
export { flattenFleet, selectFleetRows, resetFleetRowsCache } from "./flatten";
export type { FleetRow } from "./flatten";
export { fleetSnapshot, spawnAgent } from "./fleetIpc";
export type { FleetSnapshot, SpawnAgentOptions } from "./fleetIpc";
