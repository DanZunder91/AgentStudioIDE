import { renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { asTerminalId } from "../../app/types";
import { launcherLabelOf } from "./agentLogsApps";
import { RenamedSourcesContext, renamedTerminalLabels, sourceLabel, terminalCustomTitles, useSourceLabel } from "./agentLogsTitles";

const term = (id: string) => ({ kind: "terminal" as const, terminalId: asTerminalId(id) });

const line = (source: string, terminalId: string | null, over: Partial<{ kind: "output" | "tool"; agentId: string | null }> = {}) => ({
  source,
  terminalId,
  kind: over.kind ?? ("output" as const),
  agentId: over.agentId ?? null,
});

describe("renamedTerminalLabels", () => {
  const tabs = {
    a: { ref: term("t1"), customTitle: "gazelle" },
    b: { ref: term("t2"), customTitle: null },
    c: { ref: term("t3"), customTitle: "   " },
  };

  it("labels a renamed terminal's source by its custom title (the gazelle case)", () => {
    const out = renamedTerminalLabels([line("bash · workspace", "t1")], tabs);
    expect([...out]).toEqual([["bash · workspace", "gazelle"]]);
  });

  it("leaves unrenamed, blank-renamed and unknown terminals alone", () => {
    const out = renamedTerminalLabels([line("bash · a", "t2"), line("bash · b", "t3"), line("bash · c", "t9"), line("x", null)], tabs);
    expect(out.size).toBe(0);
  });

  it("ignores agent and tool lines, even on a renamed terminal id", () => {
    const out = renamedTerminalLabels(
      [line("claude · w", "t1", { agentId: "ag1" }), line("tool", "t1", { kind: "tool" })],
      tabs,
    );
    expect(out.size).toBe(0);
  });

  it("a source shared by two terminals is not named after one of them (the Windows `powershell · Agent Studio` case)", () => {
    // t1 renamed "gazelle", t2 not: the shared row must not read "gazelle" for both.
    const out = renamedTerminalLabels([line("powershell · w", "t1"), line("powershell · w", "t2"), line("powershell · w", "t1")], tabs);
    expect(out.size).toBe(0);
    // …in either order, and also when both are renamed differently.
    expect(renamedTerminalLabels([line("ps", "t2"), line("ps", "t1")], tabs).size).toBe(0);
    const both = { a: { ref: term("t1"), customTitle: "one" }, b: { ref: term("t2"), customTitle: "two" } };
    expect(renamedTerminalLabels([line("ps", "t1"), line("ps", "t2")], both).size).toBe(0);
  });

  it("each terminal's own source wears its own tab title", () => {
    const both = { a: { ref: term("t1"), customTitle: "one" }, b: { ref: term("t2"), customTitle: "two" } };
    const out = renamedTerminalLabels([line("ps · w", "t1"), line("ps · w (2)", "t2")], both);
    expect([...out]).toEqual([
      ["ps · w", "one"],
      ["ps · w (2)", "two"],
    ]);
    // Two terminals that agree on a title still read as it.
    const same = { a: { ref: term("t1"), customTitle: "srv" }, b: { ref: term("t2"), customTitle: "srv" } };
    expect([...renamedTerminalLabels([line("ps", "t1"), line("ps", "t2")], same)]).toEqual([["ps", "srv"]]);
  });

  it("an agent-terminal tab never renames a source (its name lives on the agent)", () => {
    const out = renamedTerminalLabels([line("bash · w", "t1")], {
      x: { ref: { kind: "agent-terminal" as never, terminalId: "t1" } as never, customTitle: "nope" },
    });
    expect(out.size).toBe(0);
  });
});

describe("a server's `by …` tag never borrows another terminal's name", () => {
  it("started in the unrenamed terminal of two sharing a source → the source, not the renamed tab", () => {
    const tabs = { a: { ref: term("t1"), customTitle: "Renamed One" }, b: { ref: term("t2"), customTitle: null } };
    const lines = [line("powershell · Agent Studio", "t1"), line("powershell · Agent Studio", "t2")];
    const renamed = renamedTerminalLabels(lines, tabs);
    const app = { origin: "ide" as const, agentId: null, terminalId: "t2" };
    expect(launcherLabelOf(app, lines, renamed)).toBe("powershell · Agent Studio");
    // With its own source (what Rust now sends), each terminal's server is tagged by its own tab.
    const own = [line("powershell · Agent Studio", "t1"), line("powershell · Agent Studio (2)", "t2")];
    const ownRenamed = renamedTerminalLabels(own, tabs);
    expect(launcherLabelOf({ ...app, terminalId: "t1" }, own, ownRenamed)).toBe("Renamed One");
    expect(launcherLabelOf(app, own, ownRenamed)).toBe("powershell · Agent Studio (2)");
  });
});

describe("sourceLabel / useSourceLabel — one name for a source everywhere Logs shows it", () => {
  const renamed = new Map([["bash · workspace", "gazelle"]]);

  it("the renamed title, else the display name (a service's suffix dropped)", () => {
    expect(sourceLabel("bash · workspace", renamed)).toBe("gazelle");
    expect(sourceLabel("zsh", renamed)).toBe("zsh");
  });

  it("reads the provided map; with no provider, plain display names", () => {
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(RenamedSourcesContext.Provider, { value: renamed }, children);
    expect(renderHook(() => useSourceLabel(), { wrapper }).result.current("bash · workspace")).toBe("gazelle");
    expect(renderHook(() => useSourceLabel()).result.current("bash · workspace")).toBe("bash · workspace");
  });

  it("terminalCustomTitles keys by terminal id (what Network's app tags use)", () => {
    expect([...terminalCustomTitles({ a: { ref: term("t1"), customTitle: " gazelle " } })]).toEqual([["t1", "gazelle"]]);
  });
});
