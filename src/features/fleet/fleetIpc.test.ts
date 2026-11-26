/** The wrappers' own marshalling and `fleetSnapshot` (mocked out in `bridge.ts`); `spawnAgent` is
 * driven in `features/terminal/agentSpawn.test.ts`. Command name and arg shape are the contract. */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { asAgentId } from "../../app/types";
import { channelIdOf, installTauriMock, type TauriMock } from "../../test/tauri-mock";
import {
  agentResumeSession,
  defaultWorkspace,
  ensureAgentHooks,
  fleetSnapshot,
  pinAgent,
  pinnedAgents,
  pushRecentProject,
  recentProjects,
  restoredAgents,
  spawnAgent,
  subagentActivity,
  unpinAgent,
} from "./fleetIpc";

describe("fleetIpc", () => {
  let ipc: TauriMock;

  beforeEach(() => {
    ipc = installTauriMock();
  });

  afterEach(() => {
    ipc.reset();
  });

  describe("recentProjects / pushRecentProject", () => {
    it("recent_projects returns the paths Rust sent", async () => {
      ipc.handle("recent_projects", () => ["/w/gazelle", "/w/api"]);
      await expect(recentProjects()).resolves.toEqual(["/w/gazelle", "/w/api"]);
      expect(ipc.lastCall("recent_projects")).toEqual({});
    });

    it("push_recent_project sends the path", async () => {
      ipc.handle("push_recent_project", () => null);
      await pushRecentProject("/w/gazelle");
      expect(ipc.lastCall("push_recent_project")).toEqual({ path: "/w/gazelle" });
    });

    it("propagates a push failure to the caller", async () => {
      ipc.handle("push_recent_project", () => {
        throw new Error("disk full");
      });
      await expect(pushRecentProject("/w/x")).rejects.toThrow(/disk full/);
    });
  });

  describe("agentResumeSession", () => {
    it("asks Rust for the finished agent's session by agent id only", async () => {
      ipc.handle("agent_resume_session", () => "sess-9");
      await expect(agentResumeSession(asAgentId("a1"))).resolves.toBe("sess-9");
      expect(ipc.lastCall("agent_resume_session")).toEqual({ agentId: "a1" });
    });
  });

  describe("ensureAgentHooks", () => {
    it("ensure_agent_hooks sends the root", async () => {
      ipc.handle("ensure_agent_hooks", () => null);
      await ensureAgentHooks("/w/gazelle");
      expect(ipc.lastCall("ensure_agent_hooks")).toEqual({ root: "/w/gazelle" });
    });

    it("propagates a failure to the caller (the UI swallows it best-effort)", async () => {
      ipc.handle("ensure_agent_hooks", () => {
        throw new Error("supervisor is down");
      });
      await expect(ensureAgentHooks("/w/x")).rejects.toThrow(/supervisor is down/);
    });
  });

  describe("subagentActivity", () => {
    const kid = asAgentId("01J0KID000000000000000000");

    it("invokes subagent_activity keyed by agentId and returns the transcript", async () => {
      const entries = [
        { role: "user", text: "explore the repo", timestamp: 1 },
        { role: "assistant", text: "reading files", tool: "Read", timestamp: 2 },
      ];
      ipc.handle("subagent_activity", () => entries);

      await expect(subagentActivity(kid)).resolves.toEqual(entries);
      expect(ipc.lastCall("subagent_activity")).toEqual({ agentId: kid });
    });

    it("propagates a failure rather than resolving an empty transcript", async () => {
      // An empty array would render the calm "waiting" state and hide that the
      // read actually failed.
      ipc.handle("subagent_activity", () => {
        throw new Error("no such agent");
      });

      await expect(subagentActivity(kid)).rejects.toThrow(/no such agent/);
    });
  });

  describe("fleetSnapshot", () => {
    it("invokes fleet_snapshot and returns the fleet as Rust sent it", async () => {
      const snapshot = {
        agents: [{ id: "a1", parentId: null, title: "root" }],
        terminals: [{ id: "a1", kind: "agent-terminal", title: "claude" }],
      };
      ipc.handle("fleet_snapshot", () => snapshot);

      await expect(fleetSnapshot()).resolves.toEqual(snapshot);
      expect(ipc.calls("fleet_snapshot")).toHaveLength(1);
    });

    it("passes an args object, not undefined", async () => {
      // Tauri's arg deserializer wants an object; `invoke(cmd)` with no payload
      // is a different call shape.
      ipc.handle("fleet_snapshot", () => ({ agents: [], terminals: [] }));
      await fleetSnapshot();

      expect(ipc.lastCall("fleet_snapshot")).toEqual({});
    });

    it("propagates a snapshot failure rather than resolving empty", async () => {
      // A silently-empty fleet would paint an empty rail and look like "no
      // agents running" instead of "we could not ask".
      ipc.handle("fleet_snapshot", () => {
        throw new Error("supervisor is down");
      });

      await expect(fleetSnapshot()).rejects.toThrow(/supervisor is down/);
    });
  });

  describe("agent pinning", () => {
    const root = asAgentId("01J0ROOT00000000000000000");

    it("pin_agent sends the agentId", async () => {
      ipc.handle("pin_agent", () => null);
      await pinAgent(root);
      expect(ipc.lastCall("pin_agent")).toEqual({ agentId: root });
    });

    it("unpin_agent sends the agentId", async () => {
      ipc.handle("unpin_agent", () => null);
      await unpinAgent(root);
      expect(ipc.lastCall("unpin_agent")).toEqual({ agentId: root });
    });

    it("pin_agent SWALLOWS a failure (best-effort — a dropped save is not fatal)", async () => {
      ipc.handle("pin_agent", () => {
        throw new Error("disk full");
      });
      // Unlike the propagating wrappers above, the pin effects mirror
      // `saveApiStore`: the store write is authoritative for the session, so a
      // failed persist resolves rather than rejecting.
      await expect(pinAgent(root)).resolves.toBeUndefined();
    });

    it("unpin_agent SWALLOWS a failure too", async () => {
      ipc.handle("unpin_agent", () => {
        throw new Error("supervisor down");
      });
      await expect(unpinAgent(root)).resolves.toBeUndefined();
    });

    it("pinned_agents returns the registry Rust sent, keyed by agentId", async () => {
      const views = [
        { agentId: root, cwd: "/w/gazelle", title: "orchestrator" },
      ];
      ipc.handle("pinned_agents", () => views);

      await expect(pinnedAgents()).resolves.toEqual(views);
      expect(ipc.lastCall("pinned_agents")).toEqual({});
    });

    it("pinned_agents NEVER throws — a failure yields [] so boot survives", async () => {
      // A silently-empty list is the RIGHT degrade here (unlike fleetSnapshot):
      // boot must never fail on the pin registry, and "no pins restored" is a
      // safe, non-destructive fallback.
      ipc.handle("pinned_agents", () => {
        throw new Error("no registry");
      });
      await expect(pinnedAgents()).resolves.toEqual([]);
    });

    it("restored_agents returns the markers Rust sent, with no args", async () => {
      const views = [
        { agentId: root, outcome: "resumed", wasWorking: true },
        { agentId: asAgentId("gone"), outcome: "dormant", wasWorking: null },
      ];
      ipc.handle("restored_agents", () => views);

      await expect(restoredAgents()).resolves.toEqual(views);
      expect(ipc.lastCall("restored_agents")).toEqual({});
    });

    it("restored_agents NEVER throws — a failure yields [] (a missing marker, not a broken boot)", async () => {
      ipc.handle("restored_agents", () => {
        throw new Error("supervisor down");
      });
      await expect(restoredAgents()).resolves.toEqual([]);
    });
  });

  describe("defaultWorkspace", () => {
    it("invokes default_workspace and returns the absolute path", async () => {
      ipc.handle("default_workspace", () => "/Users/me/projects/gazelle");

      await expect(defaultWorkspace()).resolves.toBe("/Users/me/projects/gazelle");
      expect(ipc.lastCall("default_workspace")).toEqual({});
    });

    it("propagates a failure rather than resolving a bogus path", async () => {
      ipc.handle("default_workspace", () => {
        throw new Error("no home dir");
      });

      await expect(defaultWorkspace()).rejects.toThrow(/no home dir/);
    });
  });

  describe("spawnAgent", () => {
    const base = {
      agentId: asAgentId("01J0AGENT0000000000000000"),
      runtime: "claude-code",
      cwd: "/projects/proj",
      rows: 24,
      cols: 80,
    };

    it("invokes agent_spawn with the ARCHITECTURE §2.4 argument names", async () => {
      ipc.handle("agent_spawn", (args) => ({ id: args.agentId, status: "live" }));
      const channel = { __TAURI_TO_IPC_KEY__: () => "__CHANNEL__:7", id: 7 };

      await spawnAgent({ ...base, onOutput: channel });

      const args = ipc.lastCall("agent_spawn")!;
      expect(args.agentId).toBe(base.agentId);
      expect(args.runtime).toBe(base.runtime);
      expect(args.cwd).toBe(base.cwd);
      expect(args.rows).toBe(24);
      expect(args.cols).toBe(80);
      expect(channelIdOf(args.onOutput)).toBe(7);
    });

    it("defaults prompt to null so serde reads it as None", async () => {
      ipc.handle("agent_spawn", () => ({ id: base.agentId }));
      await spawnAgent({ ...base, onOutput: {} });

      // null, not undefined: an omitted key would be dropped by JSON.stringify.
      expect(ipc.lastCall("agent_spawn")!.prompt).toBeNull();
    });

    it("forwards an explicit prompt — M3 seeds an agent with its task", async () => {
      ipc.handle("agent_spawn", () => ({ id: base.agentId }));
      await spawnAgent({ ...base, prompt: "Pull latest changes", onOutput: {} });

      expect(ipc.lastCall("agent_spawn")!.prompt).toBe("Pull latest changes");
    });

    it("defaults resumeSessionId to null so serde reads it as None", async () => {
      ipc.handle("agent_spawn", () => ({ id: base.agentId }));
      await spawnAgent({ ...base, onOutput: {} });

      // null, not undefined: an omitted key would be dropped by JSON.stringify.
      expect(ipc.lastCall("agent_spawn")!.resumeSessionId).toBeNull();
    });

    it("forwards resumeSessionId — the Recover-session path", async () => {
      ipc.handle("agent_spawn", () => ({ id: base.agentId }));
      await spawnAgent({ ...base, resumeSessionId: "sess-42", onOutput: {} });

      expect(ipc.lastCall("agent_spawn")!.resumeSessionId).toBe("sess-42");
    });

    it("never sends presetId — Rust's arg is `prompt` and serde ignores the rest", async () => {
      // Rust reads `prompt` and serde drops unknown keys silently, so pin the field name.
      ipc.handle("agent_spawn", () => ({ id: base.agentId }));
      await spawnAgent({ ...base, prompt: "seed", onOutput: {} });

      expect(ipc.lastCall("agent_spawn")).not.toHaveProperty("presetId");
    });

    it("names a runtime, never a program", async () => {
      ipc.handle("agent_spawn", () => ({ id: base.agentId }));
      await spawnAgent({ ...base, onOutput: {} });

      const args = ipc.lastCall("agent_spawn")!;
      expect(args).not.toHaveProperty("program");
      expect(args).not.toHaveProperty("args");
    });

    it("propagates a spawn failure to the caller", async () => {
      ipc.handle("agent_spawn", () => {
        throw new Error("unknown runtime");
      });

      await expect(spawnAgent({ ...base, onOutput: {} })).rejects.toThrow(/unknown runtime/);
    });
  });
});
