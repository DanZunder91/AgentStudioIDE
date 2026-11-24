/**
 * Fake "agents outside the IDE" for the Agent Village E2E — what `list_external_agents`
 * (src-tauri/src/external_agents.rs) sees for a `claude` running in some other terminal:
 *
 *   1. a Claude-format transcript, `$HOME/.claude/projects/<cwd-slug>/<session>.jsonl` (+ sub-agent
 *      sidecars under `<session>/subagents/`), touched just now;
 *   2. a LIVE process whose argv[0] is `claude` and whose argv carries `--session-id <session>` —
 *      liveness is per session, and a transcript no live process claims is not shown at all.
 *      The process is `/bin/sh -c 'sleep …'` with argv0 = "claude": it does nothing, holds nothing.
 *
 * Two roots may share a folder (two `claude`s in one repo): one building, a floor each, in the City.
 *
 * The files a seeded agent's tool calls name (`OutsideAgentSpec.files`) are what makes its
 * project's LANGUAGE known — the City's neon sign: the scan votes by the
 * extensions of the files a session's `tool_use` inputs name (`external_agents/language.rs`, the
 * shared `projectLanguages.json`). No file is ever created at those paths: the app only reads the
 * transcript that names them, never the project (zero permission prompts).
 *
 * Every sub-agent is BACKGROUND-shaped, the way the real CLI (2.1.30x) launches every ordinary Agent
 * call: its `.meta.json` says `requestShape: "background"`, and the parent's launch `tool_result` comes
 * back AT ONCE ("Async agent launched…") — so that answer must not end it (it used to: the City showed
 * nobody working). It runs until its parent's queue gets its `<task-notification>` (`finish()`).
 *
 * Mid-run, `addSubagent` starts one more sub-agent under a seeded root — what a working agent does
 * when it fans out — and its handle's `finish()` ends it the way the CLI does: the sub-agent's final
 * reply, then the parent's `<task-notification>` (completed). The City's commute (a newcomer rides
 * from the Seats lounge to its desk, and back when it is done) is filmed off it.
 *
 * While seeded, every transcript is TOUCHED every {@link HEARTBEAT_MS} (what a working agent's
 * transcript does as it grows): `external_agents.rs` takes a sub-agent silent for 5 min as finished
 * (`SUBAGENT_STALE_MS`) and drops a session quiet for 10 (`DEFAULT_WINDOW_MINS`) — a recorded run
 * of the Village spec is longer than that, and its later stills would lose the big team.
 *
 * 🔴 `$HOME/.claude` is a real person's Claude Code config on any machine but a throwaway container
 * (the app and its tests must never write there). This module REFUSES to run unless `/.dockerenv`
 * exists, and it only ever creates and removes the project directories it names itself (prefix
 * `-tmp-e2e-outside-`).
 * The app under test only READS them — which is the product.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Every cwd lives under here (inside the container), so every project dir has one prefix. */
const OUTSIDE_ROOT = "/tmp/e2e-outside";

/** How often the seeded transcripts are touched — well inside the 5-min sub-agent staleness. */
export const HEARTBEAT_MS = 30_000;

export interface OutsideAgentSpec {
  /** The folder name — one Village house / one City building per folder (two roots in one folder: two floors). */
  folder: string;
  /** The transcript `slug` the Village shows as the agent's name (and the City as its floor's plate). Unique per spec. */
  slug: string;
  /** What the root agent is doing (its unanswered last tool, or idle). */
  doing: "read" | "subagents" | "idle";
  /** Sub-agent types to spawn under it (only with `doing: "subagents"`). */
  subagents?: string[];
  /**
   * Source files (relative to the agent's cwd) its tool calls name — what makes its project's
   * language known (see the module note). A "read" root is reading the first; sub-agent i works on
   * file i mod n (an Edit or a Read, in turn); an idle root read the first earlier in its turn (an
   * answered call). Absent: the old calls (a Grep with no path, a README.md) — no language.
   */
  files?: string[];
}

/** A seeded root session. */
export interface SeededSession {
  folder: string;
  slug: string;
  /** Its session id (the transcript's name, and what its live `claude` claims). */
  session: string;
}

/** A sub-agent started mid-run by {@link SeededOutside.addSubagent}. */
export interface NewSubagent {
  /** Its sidecar's agent id (`agent-<id>.jsonl`). */
  agentId: string;
  /**
   * End it the way the CLI does: its pending tool is answered and it replies, then its parent's queue
   * gets its `<task-notification>` (completed), stamped after that reply — the scan then reports it done.
   */
  finish: () => void;
}

export interface SeededOutside {
  /** How many root sessions were seeded (each a live "claude"). */
  roots: number;
  /** How many sub-agents were seeded under them, all of them mid-tool (running). */
  subagents: number;
  /**
   * How many seeded agents are mid-turn and so hold a Seats desk (`capacityModel.seatHolders`: not
   * idle / done): every root whose `doing` is not "idle", plus every sub-agent.
   */
  busy: number;
  sessions: SeededSession[];
  /**
   * Start one more sub-agent under the seeded root `slug`, mid-task: its `.meta.json` and sidecar
   * (each written aside and RENAMED into place, so a scan never sees half of one), and the root's
   * `Agent` call that launched it appended to the root's transcript. The app's external scan
   * (~3 s) picks it up; the heartbeat keeps it fresh like the others.
   */
  addSubagent: (slug: string, opts: { agentType: string; file: string }) => NewSubagent;
  cleanup: () => void;
}

/** Claude's project-dir naming: every non-alphanumeric character of the cwd becomes `-`. */
function projectDirName(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

function assertInContainer(): void {
  if (!fs.existsSync("/.dockerenv")) {
    throw new Error("outside-agents writes under $HOME/.claude — it runs ONLY in the Docker E2E container (scripts/e2e-linux.mjs)");
  }
}

const jsonl = (records: object[]): string => records.map((r) => JSON.stringify(r)).join("\n") + "\n";

/** Write `text` at `file` all at once: aside first (a name no scan matches), then renamed into place. */
function writeWhole(file: string, text: string): void {
  const aside = path.join(path.dirname(file), `.e2e-part-${path.basename(file)}`);
  fs.writeFileSync(aside, text);
  fs.renameSync(aside, file);
}

/** A sub-agent's pending tool call on `file` (absolute): an Edit for even `i`, a Read for odd. */
function fileCall(id: string, i: number, file: string): object {
  return i % 2 === 0
    ? { type: "tool_use", id, name: "Edit", input: { file_path: file, old_string: "e2e", new_string: "e2e" } }
    : { type: "tool_use", id, name: "Read", input: { file_path: file } };
}

/**
 * The parent's record answering background launches at once (the CLI's own wording: the launch is
 * acknowledged, the sub-agent runs on) — one `tool_result` per launch.
 */
function launchAcks(base: object, launches: { toolUseId: string; agentId: string }[]): object {
  return {
    ...base,
    timestamp: new Date().toISOString(),
    type: "user",
    message: {
      role: "user",
      content: launches.map((l) => ({
        type: "tool_result",
        tool_use_id: l.toolUseId,
        content: `Async agent launched successfully. agentId: ${l.agentId} (internal ID - do not mention to user).`,
      })),
    },
  };
}

/** Everything a sub-agent needs on disk: its BACKGROUND `.meta.json` and its running sidecar (user task + a pending tool call). */
function writeSubagent(
  subDir: string,
  base: object,
  sub: { agentId: string; agentType: string; toolUseId: string; call: object },
): string {
  writeWhole(
    path.join(subDir, `agent-${sub.agentId}.meta.json`),
    JSON.stringify({ agentType: sub.agentType, description: "e2e", toolUseId: sub.toolUseId, spawnDepth: 1, requestShape: "background" }),
  );
  const sidecar = path.join(subDir, `agent-${sub.agentId}.jsonl`);
  writeWhole(
    sidecar,
    jsonl([
      { ...base, agentId: sub.agentId, isSidechain: true, type: "user", message: { role: "user", content: "e2e sub-task" } },
      {
        ...base,
        agentId: sub.agentId,
        isSidechain: true,
        type: "assistant",
        message: { role: "assistant", model: "claude-opus-5", stop_reason: "tool_use", content: [sub.call] },
      },
    ]),
  );
  return sidecar;
}

/** Seed `specs` as live outside agents. Call `cleanup()` (kills the processes, removes the dirs). */
export function seedOutsideAgents(specs: readonly OutsideAgentSpec[]): SeededOutside {
  assertInContainer();
  const projects = path.join(os.homedir(), ".claude", "projects");
  const procs: ChildProcess[] = [];
  const dirs = new Set<string>();
  /** Every transcript written (root + sidecars), for the heartbeat. */
  const transcripts: string[] = [];
  const sessions: SeededSession[] = [];
  /** What `addSubagent` needs of each seeded root, by slug. */
  const roots = new Map<string, { cwd: string; base: object; subDir: string; root: string }>();

  for (const spec of specs) {
    const cwd = path.join(OUTSIDE_ROOT, spec.folder);
    fs.mkdirSync(cwd, { recursive: true });
    const session = randomUUID();
    const projectDir = path.join(projects, projectDirName(cwd));
    fs.mkdirSync(projectDir, { recursive: true });
    dirs.add(projectDir);

    // The live process FIRST: a session is only ever claimed by a process that exists.
    const proc = spawn("/bin/sh", ["-c", "sleep 1800; :", "--session-id", session], {
      argv0: "claude",
      cwd,
      stdio: "ignore",
      detached: false,
    });
    procs.push(proc);

    const now = new Date().toISOString();
    const base = { sessionId: session, cwd, gitBranch: "main", version: "2.1.212", timestamp: now, slug: spec.slug };
    const files = (spec.files ?? []).map((f) => path.join(cwd, f));
    const subDir = path.join(projectDir, session, "subagents");
    const root = path.join(projectDir, `${session}.jsonl`);
    const records: object[] = [
      { ...base, type: "user", message: { role: "user", content: "e2e: an agent running outside the IDE" } },
    ];
    if (spec.doing === "read") {
      records.push({
        ...base,
        type: "assistant",
        message: { role: "assistant", model: "claude-opus-5", stop_reason: "tool_use", content: [{ type: "tool_use", id: "toolu_read1", name: "Read", input: { file_path: files[0] ?? "README.md" } }] },
      });
    } else if (spec.doing === "subagents") {
      const subs = spec.subagents ?? ["Explore"];
      records.push({
        ...base,
        type: "assistant",
        message: {
          role: "assistant",
          model: "claude-opus-5",
          stop_reason: "tool_use",
          content: subs.map((t, i) => ({ type: "tool_use", id: `toolu_sub${i}`, name: "Agent", input: { description: "e2e", subagent_type: t } })),
        },
      });
      // Background launches answer at once; the sub-agents work on.
      records.push(launchAcks(base, subs.map((_t, i) => ({ toolUseId: `toolu_sub${i}`, agentId: `ae2e${i}` }))));
      fs.mkdirSync(subDir, { recursive: true });
      subs.forEach((agentType, i) => {
        const call = files.length > 0 ? fileCall(`toolu_g${i}`, i, files[i % files.length]) : { type: "tool_use", id: `toolu_g${i}`, name: "Grep", input: { pattern: "e2e" } };
        transcripts.push(writeSubagent(subDir, base, { agentId: `ae2e${i}`, agentType, toolUseId: `toolu_sub${i}`, call }));
      });
    } else {
      // Idle: the turn is over. With files, it read one of them on the way (an answered call).
      if (files.length > 0) {
        records.push(
          {
            ...base,
            type: "assistant",
            message: { role: "assistant", model: "claude-opus-5", stop_reason: "tool_use", content: [{ type: "tool_use", id: "toolu_read0", name: "Read", input: { file_path: files[0] } }] },
          },
          { ...base, type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_read0", content: "e2e" }] } },
        );
      }
      records.push({
        ...base,
        type: "assistant",
        message: { role: "assistant", model: "claude-opus-5", stop_reason: "end_turn", content: [{ type: "text", text: "done" }] },
      });
    }
    transcripts.push(root);
    fs.writeFileSync(root, jsonl(records));
    sessions.push({ folder: spec.folder, slug: spec.slug, session });
    roots.set(spec.slug, { cwd, base, subDir, root });
  }

  // The heartbeat: a live agent's transcript keeps changing. `unref` — it never holds the worker open.
  const heartbeat = setInterval(() => {
    const now = new Date();
    for (const t of transcripts) {
      try {
        fs.utimesSync(t, now, now);
      } catch {
        // Cleaned up under us: the next cleanup() clears the timer anyway.
      }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  let added = 0;
  const addSubagent = (slug: string, opts: { agentType: string; file: string }): NewSubagent => {
    const at = roots.get(slug);
    if (!at) throw new Error(`addSubagent: no seeded root "${slug}" (seeded: ${[...roots.keys()].join(", ")})`);
    const n = added++;
    const agentId = `ae2enew${n}`;
    const toolUseId = `toolu_new${n}`;
    const callId = `toolu_newg${n}`;
    // The root's turn launches it (its `Agent` call), as a fanning-out agent's transcript would say.
    fs.appendFileSync(
      at.root,
      jsonl([
        {
          ...at.base,
          timestamp: new Date().toISOString(),
          type: "assistant",
          message: { role: "assistant", model: "claude-opus-5", stop_reason: "tool_use", content: [{ type: "tool_use", id: toolUseId, name: "Agent", input: { description: "e2e", subagent_type: opts.agentType } }] },
        },
        launchAcks(at.base, [{ toolUseId, agentId }]),
      ]),
    );
    fs.mkdirSync(at.subDir, { recursive: true });
    const sidecar = writeSubagent(at.subDir, at.base, { agentId, agentType: opts.agentType, toolUseId, call: fileCall(callId, 0, path.join(at.cwd, opts.file)) });
    transcripts.push(sidecar);
    return {
      agentId,
      finish: () => {
        const replied = Date.now();
        fs.appendFileSync(
          sidecar,
          jsonl([
            { ...at.base, agentId, isSidechain: true, timestamp: new Date(replied).toISOString(), type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: callId, content: "e2e" }] } },
            {
              ...at.base,
              agentId,
              isSidechain: true,
              timestamp: new Date(replied).toISOString(),
              type: "assistant",
              message: { role: "assistant", model: "claude-opus-5", stop_reason: "end_turn", content: [{ type: "text", text: "e2e: sub-task done" }] },
            },
          ]),
        );
        // Then the parent hears of it — strictly after its last record, or it would read as resumed.
        fs.appendFileSync(
          at.root,
          jsonl([
            {
              ...at.base,
              timestamp: new Date(replied + 50).toISOString(),
              type: "queue-operation",
              operation: "enqueue",
              content: `<task-notification><task-id>${agentId}</task-id><tool-use-id>${toolUseId}</tool-use-id><status>completed</status><summary>Agent "e2e" completed</summary></task-notification>`,
            },
          ]),
        );
      },
    };
  };

  const subagents = specs.reduce((n, s) => n + (s.doing === "subagents" ? (s.subagents ?? ["Explore"]).length : 0), 0);
  return {
    roots: specs.length,
    subagents,
    busy: specs.filter((s) => s.doing !== "idle").length + subagents,
    sessions,
    addSubagent,
    cleanup: () => {
      clearInterval(heartbeat);
      for (const p of procs) p.kill("SIGKILL");
      for (const d of dirs) {
        // Belt and braces: only ever remove a directory this module named.
        if (path.basename(d).startsWith(projectDirName(OUTSIDE_ROOT) + "-")) fs.rmSync(d, { recursive: true, force: true });
      }
      fs.rmSync(OUTSIDE_ROOT, { recursive: true, force: true });
    },
  };
}
