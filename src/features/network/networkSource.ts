/** Who made the call: a flow's `terminalId` (proxy userinfo) → that terminal tab's title. Reserved
 * `ide-api-client` (set by Rust) is the IDE's API client; a null id with a resolved `client` is
 * `external · <name>`; only null/null is "unattributed". */

import type { AgentId, AgentNode, Tab, TabId } from "../../app/types";
import { protoLabel } from "./networkFormat";
import type { FlowClient, FlowProto, FlowSummary } from "./networkTypes";

/** The reserved `terminalId` Rust gives the IDE's own API-client flows. */
export const IDE_API_CLIENT_ID = "ide-api-client";

export const API_CLIENT_LABEL = "API client";
export const API_CLIENT_SUBLABEL = "the IDE's built-in API client";

export type SourceLabel =
  | { kind: "named"; text: string }
  | { kind: "unattributed" }
  | { kind: "gone"; text: string }
  | { kind: "api-client"; text: typeof API_CLIENT_LABEL }
  /** `title` is what a hover shows: the executable path (or name) and the pid. */
  | { kind: "external"; text: string; title: string };

/** The two fields a source is decided from. */
export type SourceOf = Pick<FlowSummary, "terminalId" | "client">;

export function sourceIndex(
  tabs: Record<TabId, Tab>,
  agents: Record<AgentId, AgentNode>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const tab of Object.values(tabs)) {
    const ref = tab.ref;
    if (ref.kind === "agent-terminal") {
      const agent = agents[ref.agentId] as AgentNode | undefined;
      out.set(ref.terminalId, agent ? (agent.customTitle ?? agent.title) : (tab.customTitle ?? tab.title));
    } else if (ref.kind === "terminal") {
      out.set(ref.terminalId, tab.customTitle ?? tab.title);
    }
  }
  return out;
}

/** A process that reached the proxy without the `t-<id>` userinfo, but was resolved. */
export function isExternal(f: SourceOf): f is SourceOf & { client: FlowClient } {
  return f.terminalId === null && f.client !== null;
}

export function isApiClient(f: Pick<FlowSummary, "terminalId">): boolean {
  return f.terminalId === IDE_API_CLIENT_ID;
}

export function externalText(client: Pick<FlowClient, "name">): string {
  return `external · ${client.name}`;
}

/** Precedence: reserved API-client id; resolved external process; null/null (`unattributed`); an
 * id with an open tab; an id with no open tab, said as a closed terminal rather than unknown. */
export function resolveSource(
  f: SourceOf,
  index: ReadonlyMap<string, string>,
  closed: ReadonlyMap<string, string> = NO_TITLES,
): SourceLabel {
  if (isApiClient(f)) return { kind: "api-client", text: API_CLIENT_LABEL };
  if (isExternal(f)) {
    return { kind: "external", text: externalText(f.client), title: `${f.client.path ?? f.client.name} · pid ${f.client.pid}` };
  }
  if (f.terminalId === null) return { kind: "unattributed" };
  const title = index.get(f.terminalId);
  if (title !== undefined) return { kind: "named", text: title };
  return { kind: "gone", text: goneText(f.terminalId, closed) };
}

const NO_TITLES: ReadonlyMap<string, string> = new Map();

/** A closed terminal by the title it last had (`gazelle (closed)`); the short id only when its
 * title was never seen (it closed before the IDE watched it, e.g. a previous run's flows). */
export function goneText(terminalId: string, closed: ReadonlyMap<string, string>): string {
  const title = closed.get(terminalId);
  return title === undefined || title.trim() === "" ? `closed terminal ${terminalId.slice(0, 8)}` : `${title} (closed)`;
}

/** The Source picker's reserved key for flows with no terminal — no `t:` key can equal it. */
export const UNATTRIBUTED_KEY = "\u0000unattributed";
/** The Source picker's reserved key for the IDE's own API client. */
export const API_CLIENT_KEY = "\u0000api-client";

/** Keyed by terminal id, never title: agents retitle terminals as they work, and a title key
 * stops matching. An external process is keyed by name (`ext:Postman`), like the Process picker. */
export function sourceKey(f: SourceOf): string {
  if (isApiClient(f)) return API_CLIENT_KEY;
  if (isExternal(f)) return `ext:${f.client.name}`;
  return f.terminalId === null ? UNATTRIBUTED_KEY : `t:${f.terminalId}`;
}

export function sourceText(label: SourceLabel): string {
  return label.kind === "unattributed" ? "unattributed" : label.text;
}

export interface PickerRow {
  id: string;
  label: string;
  sublabel?: string;
  count: number;
}

/** One row per terminal that made a call (by `sourceKey`), titled, with its flow count; same-title
 * terminals get a short-id sublabel. One reserved API-client row; one row per external name,
 * its executable path as sublabel when every flow came from one path. */
export function sourceItems(
  flows: readonly SourceOf[],
  index: ReadonlyMap<string, string>,
  closed: ReadonlyMap<string, string> = NO_TITLES,
): PickerRow[] {
  const rows = new Map<string, PickerRow & { terminalId: string | null; paths: Set<string> }>();
  for (const f of flows) {
    const id = sourceKey(f);
    let row = rows.get(id);
    if (!row) {
      row = { id, label: sourceText(resolveSource(f, index, closed)), count: 0, terminalId: f.terminalId, paths: new Set() };
      rows.set(id, row);
    }
    row.count += 1;
    if (isExternal(f) && f.client.path) row.paths.add(f.client.path);
  }
  const labels = new Map<string, number>();
  for (const r of rows.values()) labels.set(r.label, (labels.get(r.label) ?? 0) + 1);
  return [...rows.values()]
    .map(({ terminalId, paths, ...r }): PickerRow => {
      if (r.id === API_CLIENT_KEY) return { ...r, sublabel: API_CLIENT_SUBLABEL };
      if (r.id.startsWith("ext:")) return paths.size === 1 ? { ...r, sublabel: [...paths][0] } : r;
      return terminalId !== null && (labels.get(r.label) as number) > 1 ? { ...r, sublabel: `#${terminalId.slice(0, 8)}` } : r;
    })
    .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
}

/* ── the sidebar's source groups (Terminals / Agents / Other) ─────────────────────────── */

export type SourceGroup = "terminals" | "agents" | "other";

/** Which open terminal ids are an AGENT's terminal (the rest of the `t:` keys are plain terminals). */
export function agentTerminalIds(tabs: Record<TabId, Tab>): Set<string> {
  const out = new Set<string>();
  for (const tab of Object.values(tabs)) if (tab.ref.kind === "agent-terminal") out.add(tab.ref.terminalId);
  return out;
}

/** Mirrors the Logs sidebar's Terminals / Agents groups. A closed terminal (`t:` id, no tab) is
 * under Terminals: whether an agent ran in it is no longer knowable. Non-terminals go to Other. */
export function sourceGroupOf(key: string, agentIds: ReadonlySet<string>): SourceGroup {
  if (!key.startsWith("t:")) return "other";
  return agentIds.has(key.slice(2)) ? "agents" : "terminals";
}

/** `sourceItems`, split into the sidebar's three groups (each keeps `sourceItems`' order). */
export function groupedSourceItems(
  flows: readonly SourceOf[],
  tabs: Record<TabId, Tab>,
  agents: Record<AgentId, AgentNode>,
  closed: ReadonlyMap<string, string> = NO_TITLES,
): Record<SourceGroup, PickerRow[]> {
  const agentIds = agentTerminalIds(tabs);
  const out: Record<SourceGroup, PickerRow[]> = { terminals: [], agents: [], other: [] };
  for (const row of sourceItems(flows, sourceIndex(tabs, agents), closed)) out[sourceGroupOf(row.id, agentIds)].push(row);
  return out;
}

/* ── the Process picker (`FlowSummary.client`) ──────────────────────────────────────── */

/** The Process picker's reserved key for flows whose client could not be resolved. */
export const UNKNOWN_PROCESS_KEY = "\u0000unknown";

/** A flow's key in the Process picker: the client's executable name, or the reserved unknown. */
export function processKey(f: { client: { name: string } | null }): string {
  return f.client === null ? UNKNOWN_PROCESS_KEY : f.client.name;
}

/** One row per client name (any pid), `unknown` for unattributed flows, each with its flow count
 * and, when every flow of that name came from one executable, its path as the sublabel. */
export function processItems(
  flows: readonly { client: { name: string; path: string | null } | null }[],
): PickerRow[] {
  const rows = new Map<string, PickerRow & { paths: Set<string> }>();
  for (const f of flows) {
    const id = processKey(f);
    let row = rows.get(id);
    if (!row) {
      row = { id, label: f.client === null ? "unknown" : f.client.name, count: 0, paths: new Set() };
      rows.set(id, row);
    }
    row.count += 1;
    if (f.client?.path) row.paths.add(f.client.path);
  }
  return [...rows.values()]
    .map(({ paths, ...r }) => (paths.size === 1 ? { ...r, sublabel: [...paths][0] } : r))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/* ── the Host picker ────────────────────────────────────────────────────────────────── */

/** The order protocols are listed in a host row's sublabel — the wire enum's order. */
const PROTO_ORDER: readonly FlowProto[] = ["http", "https", "ws", "wss", "grpc", "tunnel", "bypass"];

/** A flow's key in the Host picker: its host, verbatim (the port is not part of it). */
export function hostKey(f: Pick<FlowSummary, "host">): string {
  return f.host;
}

/** One row per host with its flow count and the protocols seen as sublabel (`HTTPS, gRPC`), so a
 * tunnel-only host shows as such before it is picked. Sorted by name. */
export function hostItems(flows: readonly Pick<FlowSummary, "host" | "proto">[]): PickerRow[] {
  const rows = new Map<string, PickerRow & { protos: Set<FlowProto> }>();
  for (const f of flows) {
    const id = hostKey(f);
    let row = rows.get(id);
    if (!row) {
      row = { id, label: f.host, count: 0, protos: new Set() };
      rows.set(id, row);
    }
    row.count += 1;
    row.protos.add(f.proto);
  }
  return [...rows.values()]
    .map(({ protos, ...r }) => ({ ...r, sublabel: PROTO_ORDER.filter((p) => protos.has(p)).map(protoLabel).join(", ") }))
    .sort((a, b) => a.label.localeCompare(b.label));
}
