/**
 * The tear-off contract's pure half: a tab's cross-window identity (`tabKey`), which kinds
 * may leave a window (`canTearOff`), and the terminals a main-window reload must skip
 * (`heldTerminalIds`). The Rust half of `tabKey` is pinned against the same golden in
 * `src/test/contract/tearoff.contract.test.ts`.
 */

import { describe, expect, it } from "vitest";

import { asAgentId, asTabId, asTerminalId, type Tab, type TabKind } from "../types";
import { canTearOff, heldTerminalIds, tabKey, TEAROFF_KINDS, type TornTab } from "./contract";

const tab = (ref: Tab["ref"]): Tab => ({ id: asTabId("t"), kind: ref.kind, title: "x", ref });

describe("tabKey", () => {
  it("keys terminals by their PTY — plain and agent terminals share the space", () => {
    expect(tabKey({ kind: "terminal", terminalId: asTerminalId("T1") })).toBe("terminal:T1");
    expect(
      tabKey({ kind: "agent-terminal", terminalId: asTerminalId("A1"), agentId: asAgentId("A1") }),
    ).toBe("terminal:A1");
  });

  it("keys an editor and a diff of the same file apart", () => {
    expect(tabKey({ kind: "editor", path: "/w/a.ts" })).toBe("editor:/w/a.ts");
    expect(tabKey({ kind: "diff", path: "/w/a.ts" })).toBe("diff:/w/a.ts");
  });

  it("keys the singletons by their kind", () => {
    expect(tabKey({ kind: "metrics", cwd: "/w" })).toBe("metrics");
    expect(tabKey({ kind: "agent-logs" })).toBe("agent-logs");
    expect(tabKey({ kind: "network" })).toBe("network");
    expect(tabKey({ kind: "village" })).toBe("village");
  });

  it("gives a wire TornTab the same key as the store ref it describes", () => {
    const torn: TornTab = { kind: "terminal", terminalId: "T9", title: "sh", customTitle: null };
    expect(tabKey(torn)).toBe(tabKey({ kind: "terminal", terminalId: asTerminalId("T9") }));
  });
});

describe("canTearOff", () => {
  it("lets exactly the cheap-to-recreate kinds leave a window", () => {
    // Every TabKind, with its verdict — a new kind is a compile error here until decided.
    const verdict: Record<TabKind, boolean> = {
      terminal: true,
      "agent-terminal": true,
      editor: true,
      diff: true,
      metrics: true,
      "agent-logs": true,
      network: true,
      village: true,
      // A live response / captured bearer tokens / a live DB session / a per-store
      // singleton picker or poller: tab-tearoff.md §3.
      "api-request": false,
      sequence: false,
      "db-console": false,
      "session-picker": false,
      "agent-activity": false,
    };
    for (const [kind, movable] of Object.entries(verdict)) {
      expect(TEAROFF_KINDS.has(kind as TabKind), kind).toBe(movable);
    }
    expect(canTearOff(tab({ kind: "editor", path: "/w/a.ts" }))).toBe(true);
    expect(canTearOff(tab({ kind: "api-request", requestId: "r1" }))).toBe(false);
  });

  it("is false for a tab that is not there", () => {
    expect(canTearOff(undefined)).toBe(false);
  });
});

describe("heldTerminalIds", () => {
  it("collects the terminals every detached window holds, and nothing else", () => {
    const ids = heldTerminalIds([
      { label: "tearoff-1", keys: ["terminal:T1", "editor:/w/a.ts", "village"] },
      { label: "tearoff-2", keys: ["terminal:A7", "diff:/w/terminal:x"] },
    ]);
    expect([...ids].sort()).toEqual(["A7", "T1"]);
  });

  it("is empty when nobody holds anything", () => {
    expect(heldTerminalIds([]).size).toBe(0);
  });
});
