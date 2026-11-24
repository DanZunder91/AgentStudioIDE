/** terminalId (+ client) → the label the user sees as Source, and the pickers' rows. */

import { describe, expect, it } from "vitest";

import type { AgentId, AgentNode, Tab, TabId } from "../../app/types";
import {
  agentTerminalIds,
  API_CLIENT_KEY,
  groupedSourceItems,
  sourceGroupOf,
  hostItems,
  hostKey,
  isApiClient,
  isExternal,
  processItems,
  processKey,
  resolveSource,
  sourceIndex,
  sourceItems,
  sourceKey,
  sourceText,
  type SourceOf,
  UNATTRIBUTED_KEY,
  UNKNOWN_PROCESS_KEY,
} from "./networkSource";
import type { FlowClient } from "./networkTypes";

const tab = (id: string, ref: Tab["ref"], title: string, customTitle?: string | null): Tab =>
  ({ id: id as TabId, kind: ref.kind, title, customTitle, ref }) as Tab;
const agent = (id: string, title: string, customTitle: string | null = null): AgentNode =>
  ({ id: id as AgentId, title, customTitle }) as AgentNode;

const POSTMAN: FlowClient = { pid: 8080, name: "Postman", path: "/Applications/Postman.app/Contents/MacOS/Postman" };
const IDE: FlowClient = { pid: 733, name: "Agent Studio", path: "/Applications/Agent Studio.app/Contents/MacOS/Agent Studio" };
const src = (terminalId: string | null, client: FlowClient | null = null): SourceOf => ({ terminalId, client });

describe("sourceIndex + resolveSource", () => {
  const tabs = {
    t1: tab("t1", { kind: "terminal", terminalId: "term-plain" as never }, "zsh"),
    t2: tab("t2", { kind: "terminal", terminalId: "term-renamed" as never }, "zsh", "build shell"),
    t3: tab("t3", { kind: "agent-terminal", terminalId: "term-agent" as never, agentId: "a1" as never }, "tab title"),
    t4: tab("t4", { kind: "agent-terminal", terminalId: "term-named" as never, agentId: "a2" as never }, "x"),
    t5: tab("t5", { kind: "agent-terminal", terminalId: "term-orphan" as never, agentId: "gone" as never }, "orphan tab"),
    t6: tab("t6", { kind: "editor", path: "/x" }, "x.ts"),
  } as Record<TabId, Tab>;
  const agents = {
    a1: agent("a1", "claude — fix tests"),
    a2: agent("a2", "claude", "Reviewer"),
  } as Record<AgentId, AgentNode>;
  const idx = sourceIndex(tabs, agents);

  // The source-label rules, as a table: every row's expectation is written out by hand.
  it.each([
    ["term-plain", null, { kind: "named", text: "zsh" }],
    ["term-renamed", null, { kind: "named", text: "build shell" }],
    ["term-agent", null, { kind: "named", text: "claude — fix tests" }],
    ["term-named", null, { kind: "named", text: "Reviewer" }],
    ["term-orphan", null, { kind: "named", text: "orphan tab" }],
    ["01JABCDEFGHIJK", null, { kind: "gone", text: "closed terminal 01JABCDE" }],
    // A terminal-attributed flow keeps its terminal label whatever process made it.
    ["term-plain", POSTMAN, { kind: "named", text: "zsh" }],
    // The reserved id is the IDE's own API client — with or without a client (it always has one).
    ["ide-api-client", IDE, { kind: "api-client", text: "API client" }],
    ["ide-api-client", null, { kind: "api-client", text: "API client" }],
    // No userinfo, a resolved process: external · <name>, hover = path · pid.
    [null, POSTMAN, { kind: "external", text: "external · Postman", title: "/Applications/Postman.app/Contents/MacOS/Postman · pid 8080" }],
    // …and with no readable path the name stands in.
    [null, { pid: 9, name: "curl", path: null }, { kind: "external", text: "external · curl", title: "curl · pid 9" }],
    // Only null/null is unattributed.
    [null, null, { kind: "unattributed" }],
  ] as const)("terminalId %s, client %j → %j", (id, client, expected) =>
    expect(resolveSource(src(id, client as FlowClient | null), idx)).toEqual(expected),
  );

  it("indexes only terminal tabs", () => {
    expect(idx.size).toBe(5);
  });

  it("isExternal / isApiClient are the two predicates the rules hang on", () => {
    expect(isExternal(src(null, POSTMAN))).toBe(true);
    expect(isExternal(src(null))).toBe(false);
    expect(isExternal(src("t", POSTMAN))).toBe(false);
    expect(isApiClient(src("ide-api-client"))).toBe(true);
    expect(isApiClient(src("ide-api-client2"))).toBe(false);
  });
});

describe("source picker rows — keyed by terminal id (titles change as agents work)", () => {
  it("keys: the terminal id, never the title; the reserved rows cannot collide with any terminal", () => {
    expect(sourceKey(src("term-1"))).toBe("t:term-1");
    expect(sourceKey(src(null))).toBe(UNATTRIBUTED_KEY);
    expect(sourceKey(src("unattributed"))).not.toBe(sourceKey(src(null)));
    expect(sourceKey(src("ide-api-client", IDE))).toBe(API_CLIENT_KEY);
    expect(sourceKey(src("ide-api-client"))).toBe(API_CLIENT_KEY);
    expect(API_CLIENT_KEY).not.toBe(UNATTRIBUTED_KEY);
    // External: by NAME, so two Postman pids are one row; a terminal titled "ext:Postman" cannot collide.
    expect(sourceKey(src(null, POSTMAN))).toBe("ext:Postman");
    expect(sourceKey(src(null, { ...POSTMAN, pid: 1 }))).toBe("ext:Postman");
    expect(sourceKey(src("ext:Postman"))).toBe("t:ext:Postman");
    expect(sourceText({ kind: "unattributed" })).toBe("unattributed");
    expect(sourceText({ kind: "gone", text: "closed terminal abc" })).toBe("closed terminal abc");
    expect(sourceText({ kind: "api-client", text: "API client" })).toBe("API client");
    expect(sourceText({ kind: "external", text: "external · Postman", title: "x" })).toBe("external · Postman");
  });

  it("one row per TERMINAL: same-titled terminals are two rows told apart by a short id", () => {
    const index = new Map([["01JAAAAAAAAAAA", "zsh"], ["01JBBBBBBBBBBB", "zsh"], ["t3", "claude"]]);
    const flows = [
      src("01JAAAAAAAAAAA"),
      src("01JBBBBBBBBBBB"),
      src(null),
      src("t3"),
      src("01JAAAAAAAAAAA"),
    ];
    expect(sourceItems(flows, index)).toEqual([
      { id: "t:t3", label: "claude", count: 1 },
      { id: "\u0000unattributed", label: "unattributed", count: 1 },
      { id: "t:01JAAAAAAAAAAA", label: "zsh", sublabel: "#01JAAAAA", count: 2 },
      { id: "t:01JBBBBBBBBBBB", label: "zsh", sublabel: "#01JBBBBB", count: 1 },
    ]);
  });

  it("a row's label follows the CURRENT title, its key does not move", () => {
    const flows = [src("term-1")];
    const before = sourceItems(flows, new Map([["term-1", "claude"]]));
    const after = sourceItems(flows, new Map([["term-1", "claude · fixing the build"]]));
    expect(before).toEqual([{ id: "t:term-1", label: "claude", count: 1 }]);
    expect(after).toEqual([{ id: "t:term-1", label: "claude · fixing the build", count: 1 }]);
  });

  it("the API client is one reserved row with its sublabel; an external app is one row per name with its path", () => {
    const flows = [
      src("ide-api-client", IDE),
      src(null, POSTMAN),
      src(null, { ...POSTMAN, pid: 8081 }),
      src("ide-api-client", IDE),
      src(null, { pid: 1, name: "node", path: "/usr/bin/node" }),
      src(null, { pid: 2, name: "node", path: "/opt/node/bin/node" }),
      src(null),
    ];
    expect(sourceItems(flows, new Map())).toEqual([
      { id: API_CLIENT_KEY, label: "API client", sublabel: "the IDE's built-in API client", count: 2 },
      { id: "ext:node", label: "external · node", count: 2 }, // two paths → no sublabel
      { id: "ext:Postman", label: "external · Postman", sublabel: "/Applications/Postman.app/Contents/MacOS/Postman", count: 2 },
      { id: UNATTRIBUTED_KEY, label: "unattributed", count: 1 },
    ]);
  });
});

describe("process picker rows (FlowSummary.client)", () => {
  const c = (name: string, path: string | null = null, pid = 1) => ({ client: { name, path, pid } });

  it("keys by client name; an unresolved client is the reserved 'unknown' key", () => {
    expect(processKey(c("gazelle"))).toBe("gazelle");
    expect(processKey({ client: null })).toBe(UNKNOWN_PROCESS_KEY);
    expect(processKey(c("unknown"))).not.toBe(UNKNOWN_PROCESS_KEY);
  });

  it("one row per name (pids merge), 'unknown' for null, sorted, with counts; one path → sublabel", () => {
    const flows = [
      c("gazelle", "/work/gazelle/target/debug/gazelle", 11),
      c("node", "/usr/bin/node", 20),
      c("gazelle", "/work/gazelle/target/debug/gazelle", 12),
      { client: null },
      c("node", "/opt/node/bin/node", 21),
      c("curl"),
    ];
    expect(processItems(flows)).toEqual([
      { id: "curl", label: "curl", count: 1 },
      { id: "gazelle", label: "gazelle", sublabel: "/work/gazelle/target/debug/gazelle", count: 2 },
      { id: "node", label: "node", count: 2 },
      { id: UNKNOWN_PROCESS_KEY, label: "unknown", count: 1 },
    ]);
  });
});

describe("host picker rows", () => {
  it("keys by host, verbatim — the port is not part of it", () => {
    expect(hostKey({ host: "api.example.com" })).toBe("api.example.com");
    expect(hostKey({ host: "localhost" })).toBe("localhost");
  });

  it("one row per host with its count and the protocols seen, in wire order; sorted by name", () => {
    const flows = [
      { host: "localhost", proto: "http" as const },
      { host: "api.anthropic.com", proto: "tunnel" as const },
      { host: "localhost", proto: "grpc" as const },
      { host: "api.anthropic.com", proto: "https" as const },
      { host: "localhost", proto: "http" as const },
      { host: "ws.example.com", proto: "wss" as const },
    ];
    expect(hostItems(flows)).toEqual([
      { id: "api.anthropic.com", label: "api.anthropic.com", sublabel: "HTTPS, TUNNEL", count: 2 },
      { id: "localhost", label: "localhost", sublabel: "HTTP, gRPC", count: 3 },
      { id: "ws.example.com", label: "ws.example.com", sublabel: "WSS", count: 1 },
    ]);
  });
});

describe("the sidebar's source groups (Terminals / Agents / Other)", () => {
  const tabs = {
    t1: tab("t1", { kind: "terminal", terminalId: "term-gazelle" as never }, "gazelle"),
    t2: tab("t2", { kind: "agent-terminal", terminalId: "term-agent" as never, agentId: "a1" as never }, "tab"),
    t3: tab("t3", { kind: "editor", path: "/x" }, "x.ts"),
  } as Record<TabId, Tab>;
  const agents = { a1: agent("a1", "claude · gazelle") } as Record<AgentId, AgentNode>;

  it("an agent's terminal ids are the agent-terminal tabs' only", () => {
    expect([...agentTerminalIds(tabs)]).toEqual(["term-agent"]);
  });

  it.each([
    ["t:term-gazelle", "terminals"],
    ["t:term-agent", "agents"],
    ["t:term-closed", "terminals"],
    ["ext:Postman", "other"],
    [API_CLIENT_KEY, "other"],
    [UNATTRIBUTED_KEY, "other"],
  ])("%s → %s", (key, group) => {
    expect(sourceGroupOf(key, new Set(["term-agent"]))).toBe(group);
  });

  it("splits sourceItems into the three groups, each with its label and flow count", () => {
    const flows = [
      src("term-gazelle"), src("term-gazelle"), src("term-agent"), src("term-closed-1234"),
      src(null, POSTMAN), src("ide-api-client"), src(null),
    ];
    const g = groupedSourceItems(flows, tabs, agents);
    expect(g.terminals).toEqual([
      { id: "t:term-closed-1234", label: "closed terminal term-clo", count: 1 },
      { id: "t:term-gazelle", label: "gazelle", count: 2 },
    ]);
    expect(g.agents).toEqual([{ id: "t:term-agent", label: "claude · gazelle", count: 1 }]);
    expect(g.other.map((r) => [r.label, r.count])).toEqual([
      ["API client", 1],
      ["external · Postman", 1],
      ["unattributed", 1],
    ]);
  });
});
