/**
 * Agent Village — the data layer: every Claude Code agent on this machine as a
 * {@link VillageAgent}, whichever side of the IDE it runs on.
 *
 *   - IDE agents come straight from the store (`agents` + `rootAgentIds`) — no new
 *     listener; the bridge already keeps the forest live.
 *   - Which tool an IDE agent is using comes from the Agent Logs stream: its `tool`
 *     lines carry the (sub-)agent's own id and a `"<Tool>: <summary>"` text, and only
 *     the tool NAME is kept (never its arguments — a Bash command can carry a secret).
 *     The same lines are COUNTED per agent (`toolCalls`): each is a model round-trip,
 *     which the LANs show as a packet (they move only when agents
 *     communicate).
 *   - External agents come from the Rust `list_external_agents` scan, polled while the
 *     village is on screen. Their calls are counted best-effort (`countExternalCalls`).
 *   - Each agent's LANGUAGE (the City's neon sign): the files its tool calls
 *     named, voted by extension through `projectLanguages.json` — the very table Rust tallies
 *     external transcripts with. An IDE agent's votes come from the same Agent Logs `tool` lines
 *     (`"Edit: /a/b.rs"` → rust), seeded once from the stream's ring (`logstream_snapshot`) so an
 *     agent that worked before the Village opened has its language at once; its whole tree (the
 *     root and every sub-agent) carries the tree's winner, as an external session does. No
 *     project folder is ever read (a cwd under ~/Documents would raise a macOS permission
 *     prompt), and only the id is kept — never a path.
 *
 * The pure mappers are exported for the engine, the panel and their tests; the hook is
 * the only thing with side effects.
 */

import { useEffect, useMemo, useState } from "react";

import { useAppStore } from "../../app/store";
import type { AgentNode } from "../../app/types";
import { logstreamSnapshot, onLogstreamLines } from "../agentlogs/logstreamIpc";
import type { LogLine } from "../agentlogs/agentLogsTypes";
import projectLanguages from "./projectLanguages.json";
import { externalErrorCode, listExternalAgents } from "./villageIpc";
import type { ExternalAgentsReport, VillageActivity, VillageAgent } from "./villageTypes";

/** Tools that only look things up — the character reads instead of typing. */
const READING_TOOLS = new Set([
  "Read",
  "Grep",
  "Glob",
  "LS",
  "WebFetch",
  "WebSearch",
  "NotebookRead",
]);

/** What a RUNNING agent's character does, given its current tool (null = none known yet). */
export function activityForTool(tool: string | null): "typing" | "reading" | "thinking" {
  if (tool === null) return "thinking";
  return READING_TOOLS.has(tool) ? "reading" : "typing";
}

/**
 * The house key: a folder's basename. Both origins use the basename so one folder is one
 * house (Rust sends external folders as basenames already — privacy). Handles
 * either separator and a trailing one; a root path (`/`) keeps itself rather than
 * becoming an unnamed house.
 */
export function folderOf(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter((p) => p !== "");
  return parts.length > 0 ? parts[parts.length - 1] : cwd;
}

/**
 * The tool NAME of an Agent Logs `tool` line — `"Edit: /a/b.ts"` → `"Edit"`, a bare
 * `"TodoWrite"` → itself. Null for an empty text. Everything after the name is dropped.
 */
export function toolFromLogText(text: string): string | null {
  const head = text.split(":", 1)[0].trim().split(/\s+/, 1)[0];
  return head === "" ? null : head;
}

// ───────────────────────────── languages (the City's neon signs) ─────────────────────────────

/** Extension (lowercase, no dot) → the language it votes for: the table Rust reads too. */
const EXTENSIONS: ReadonlyMap<string, string> = new Map(Object.entries(projectLanguages.extensions));

/**
 * The language a path's extension votes for, or null (no extension, a dotfile, a directory, or a
 * language that does not vote — Markdown, TOML, JSON…). Either separator, any case. The twin of
 * Rust's `language_of_path` (external_agents/language.rs), case for case.
 */
export function languageOfPath(path: string): string | null {
  const name = path.split(/[\\/]/).pop() as string;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null; // `.rs` is a dotfile named "rs", not a Rust file
  return EXTENSIONS.get(name.slice(dot + 1).toLowerCase()) ?? null;
}

/**
 * The tools whose Agent Logs line names the file they worked on (`"Edit: /a/b.rs"` — Rust's
 * `summarize_tool_use`). A Grep / Glob line carries its PATTERN, not a path, so it never votes here.
 */
const FILE_TOOLS = new Set(["Read", "Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** The language an Agent Logs `tool` line's file votes for, or null. */
export function languageOfLogText(text: string): string | null {
  const tool = toolFromLogText(text);
  if (tool === null || !FILE_TOOLS.has(tool)) return null;
  return languageOfPath(text.slice(text.indexOf(": ") + 2));
}

/**
 * The fresh `tool` lines of agents `known` to the fleet in one batch: only lines past `afterId` —
 * the stream's ids are monotonic per app run, so this is the Agent Logs store's own dedupe (a
 * replayed line, or a duplicate inside the batch, is never seen twice). Returns them in id order
 * and the highest id seen.
 */
function freshToolLines(
  lines: readonly LogLine[],
  afterId: number,
  known: (agentId: string) => boolean,
): { fresh: (LogLine & { agentId: string })[]; lastId: number } {
  const fresh: (LogLine & { agentId: string })[] = [];
  let last = afterId;
  for (const line of [...lines].sort((a, b) => a.id - b.id)) {
    if (line.id <= last) continue;
    last = line.id;
    if (line.kind !== "tool" || line.agentId === null || !known(line.agentId)) continue;
    fresh.push(line as LogLine & { agentId: string });
  }
  return { fresh, lastId: last };
}

/** Votes per agent, per language. */
export type LanguageVotes = Record<string, Record<string, number>>;

/**
 * Each known agent's language votes in one batch of log lines, past `afterId` (the dedupe of
 * `countToolLines`, on a cursor of its own). Returns the votes and the highest id seen.
 */
export function countLanguages(
  lines: readonly LogLine[],
  afterId: number,
  known: (agentId: string) => boolean,
): { votes: LanguageVotes; lastId: number } {
  const { fresh, lastId } = freshToolLines(lines, afterId, known);
  const votes: LanguageVotes = {};
  for (const line of fresh) {
    const lang = languageOfLogText(line.text);
    if (lang === null) continue;
    const own = (votes[line.agentId] ??= {});
    own[lang] = (own[lang] ?? 0) + 1;
  }
  return { votes, lastId };
}

/** `a` plus `b`, as a new object (neither is changed). */
function addVotes(a: Readonly<LanguageVotes>, b: Readonly<LanguageVotes>): LanguageVotes {
  const out: LanguageVotes = { ...a };
  for (const [id, own] of Object.entries(b)) {
    const sum = { ...out[id] };
    for (const [lang, n] of Object.entries(own)) sum[lang] = (sum[lang] ?? 0) + n;
    out[id] = sum;
  }
  return out;
}

/** The most-voted language; a tie goes to the first id in code-unit order (`planCity`'s and Rust's rule). */
function winner(votes: Readonly<Record<string, number>>): string | null {
  let best: string | null = null;
  let most = 0;
  for (const [lang, n] of Object.entries(votes))
    if (n > most || (n === most && lang < (best as string))) {
      best = lang;
      most = n;
    }
  return best;
}

/**
 * Each IDE agent's language: its TREE's winner — the root's votes plus every sub-agent's — on the
 * root and every agent under it, exactly as an external session's language is its transcript's and
 * all its sidecars' (a sub-agent that only Greps still works on the Rust project). A tree with no
 * vote is absent. Forest order and cycle-safety as `fromIdeAgents`.
 */
export function treeLanguages(
  agents: Record<string, AgentNode>,
  rootIds: string[],
  votes: Readonly<LanguageVotes>,
): Record<string, string> {
  const out: Record<string, string> = {};
  const seen = new Set<string>();
  for (const root of rootIds) {
    const tree: string[] = [];
    const total: Record<string, number> = {};
    const visit = (id: string): void => {
      const node = agents[id];
      if (!node || seen.has(id)) return;
      seen.add(id);
      tree.push(id);
      for (const [lang, n] of Object.entries(votes[id] ?? {})) total[lang] = (total[lang] ?? 0) + n;
      for (const child of node.childIds) visit(child);
    };
    visit(root);
    const lang = winner(total);
    if (lang !== null) for (const id of tree) out[id] = lang;
  }
  return out;
}

/** Store status → village activity. A running agent's activity is decided by its tool. */
function ideActivity(node: AgentNode, tool: string | null): VillageActivity {
  switch (node.status) {
    case "running":
      return activityForTool(tool);
    case "waiting_input":
      return "waiting";
    case "idle":
      return "idle";
    case "done":
      return "done";
    case "error":
      return "error";
  }
}

/**
 * The IDE's fleet as village agents, in forest order (each root, then its sub-agents
 * depth-first) — the same order as the rail, and stable across renders.
 *
 * Dismissed agents need no filter: `dismissAgent` removes them from the forest, and the
 * tombstone list only stops late telemetry re-creating them. A child id missing from
 * `agents` (a race mid-snapshot) is skipped, as is a cycle, defensively. `languages` =
 * `treeLanguages`; an agent it has no entry for has `language: null` (unknown).
 */
export function fromIdeAgents(
  agents: Record<string, AgentNode>,
  rootIds: string[],
  lastTool: Record<string, string | undefined>,
  calls: Readonly<Record<string, number>>,
  languages: Readonly<Record<string, string>> = {},
): VillageAgent[] {
  const out: VillageAgent[] = [];
  const seen = new Set<string>();
  const visit = (id: string, parentKey: string | null): void => {
    const node = agents[id];
    if (!node || seen.has(id)) return;
    seen.add(id);
    const tool = lastTool[id] ?? null;
    out.push({
      key: id,
      parentKey,
      origin: "ide",
      title: node.customTitle ?? node.title,
      folder: folderOf(node.cwd),
      activity: ideActivity(node, tool),
      tool,
      ideAgentId: id,
      lastActivityAt: node.lastActivityAt,
      // Counted from the moment the Village subscribed: an agent with no line yet has made none SEEN.
      toolCalls: calls[id] ?? 0,
      language: languages[id] ?? null,
    });
    for (const child of node.childIds) visit(child, id);
  };
  for (const id of rootIds) visit(id, null);
  return out;
}

/**
 * The external scan as village agents. Keys are namespaced so they can never collide with an
 * AgentId. `calls` = `countExternalCalls` over this scan; an agent it has no count for has
 * `toolCalls` absent (unknown).
 */
export function fromExternal(
  report: ExternalAgentsReport,
  calls: Readonly<Record<string, ExternalCallCount>>,
): VillageAgent[] {
  return report.agents.map((a) => ({
    key: `ext:${a.key}`,
    parentKey: a.parentKey === null ? null : `ext:${a.parentKey}`,
    origin: "external",
    title: a.title,
    folder: a.folder,
    // Rust only sends sessions a live process claims (or, with no process table, all).
    activity: a.activity === "running" ? activityForTool(a.tool) : a.activity,
    tool: a.tool,
    ideAgentId: null,
    lastActivityAt: a.lastActivityMs,
    host: a.host,
    toolCalls: calls[a.key]?.calls,
    language: a.language,
  }));
}

/** What the external call count keeps per agent (by wire key) from one scan to the next. */
export interface ExternalCallCount {
  /** The agent's `lastActivityMs` in the last scan. */
  lastMs: number;
  /** Calls counted since its first scan. */
  calls: number;
}

/**
 * Sub-agent launches (the launch group of Rust's `never_blocks`). While a parent waits on one,
 * its `lastActivityMs` moves with its SUB-AGENTS' writes — Rust dates a session by its newest
 * file, sub-agents' included — which is their traffic, counted on their own rows; the launch
 * itself shows on the LAN as the sub-agent's task.
 */
const LAUNCH_TOOLS = new Set(["Agent", "Task", "Workflow"]);

/**
 * External agents' tool calls — BEST EFFORT. The scan carries no tool lines, only each agent's
 * pending tool and when its transcript last changed, so a scan in which `lastActivityMs`
 * advanced while a tool (not a sub-agent launch) is pending counts ONE call. Several calls
 * between two polls therefore show as one, and a call made and answered between two polls (no
 * tool pending at either) as none. An agent's first scan starts it at 0; one missing from a scan
 * is forgotten, and starts at 0 again if it comes back.
 */
export function countExternalCalls(
  prev: Readonly<Record<string, ExternalCallCount>>,
  report: ExternalAgentsReport,
): Record<string, ExternalCallCount> {
  const out: Record<string, ExternalCallCount> = {};
  for (const a of report.agents) {
    const p = prev[a.key];
    const call = p !== undefined && a.lastActivityMs > p.lastMs && a.tool !== null && !LAUNCH_TOOLS.has(a.tool);
    out[a.key] = { lastMs: a.lastActivityMs, calls: (p?.calls ?? 0) + (call ? 1 : 0) };
  }
  return out;
}

/**
 * IDE agents first (in the order given — forest order), then external ones, parents
 * before children, siblings by key: Rust's scan order is a directory walk, which is not a
 * promise, and a village whose characters reshuffle on every poll would teleport them.
 * A duplicate key keeps its first occurrence; an external agent whose parent is not in
 * the scan is placed as a root.
 */
export function mergeAgents(ide: VillageAgent[], ext: VillageAgent[]): VillageAgent[] {
  const out: VillageAgent[] = [];
  const seen = new Set<string>();
  const push = (a: VillageAgent): void => {
    if (seen.has(a.key)) return;
    seen.add(a.key);
    out.push(a);
  };
  for (const a of ide) push(a);

  const byKey = (x: VillageAgent, y: VillageAgent) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0);
  const keys = new Set(ext.map((a) => a.key));
  const children = new Map<string, VillageAgent[]>();
  const roots: VillageAgent[] = [];
  for (const a of ext) {
    if (a.parentKey !== null && keys.has(a.parentKey) && a.parentKey !== a.key) {
      const list = children.get(a.parentKey) ?? [];
      list.push(a);
      children.set(a.parentKey, list);
    } else {
      roots.push(a);
    }
  }
  const visit = (a: VillageAgent): void => {
    if (seen.has(a.key)) return;
    push(a);
    for (const c of (children.get(a.key) ?? []).sort(byKey)) visit(c);
  };
  for (const r of roots.sort(byKey)) visit(r);
  return out;
}

/**
 * The tool calls per agent in one batch of log lines: every `tool` line of an agent `known` to
 * the fleet, counting only lines past `afterId` — the stream's ids are monotonic per app run, so
 * this is the Agent Logs store's own dedupe (a replayed line, or a duplicate inside the batch, is
 * never counted twice). Returns the counts and the highest id seen.
 */
export function countToolLines(
  lines: readonly LogLine[],
  afterId: number,
  known: (agentId: string) => boolean,
): { counts: Record<string, number>; lastId: number } {
  const { fresh, lastId } = freshToolLines(lines, afterId, known);
  const counts: Record<string, number> = {};
  for (const line of fresh) counts[line.agentId] = (counts[line.agentId] ?? 0) + 1;
  return { counts, lastId };
}

/** The newest tool name per agent in one batch of log lines (later lines win). */
function latestTools(lines: LogLine[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of lines) {
    if (line.kind !== "tool" || line.agentId === null) continue;
    const tool = toolFromLogText(line.text);
    if (tool !== null) out[line.agentId] = tool;
  }
  return out;
}

/** A turn that is over: its last tool must not carry into the next turn's first moments. */
const FINISHED = new Set(["idle", "done", "error"]);

/** Drop the tools of agents whose turn has ended. Returns `prev` itself when nothing changed. */
function pruneTools(
  prev: Record<string, string>,
  agents: Record<string, AgentNode>,
): Record<string, string> {
  let next: Record<string, string> | null = null;
  for (const id of Object.keys(prev)) {
    const node = agents[id];
    if (node && FINISHED.has(node.status)) {
      next ??= { ...prev };
      delete next[id];
    }
  }
  return next ?? prev;
}

export interface UseVillageAgentsOptions {
  /** Poll `list_external_agents` (only while mounted and the document is visible). */
  includeExternal: boolean;
  /** Poll interval in ms. Default 3000 (the `procs_list` precedent). */
  pollMs?: number;
}

export interface VillageAgentsState {
  agents: VillageAgent[];
  /** The code of the last failed external scan, or null. The last good scan stays on screen. */
  externalError: string | null;
  /** `scannedAtMs` of the last good external scan, or null before the first. */
  lastScanAt: number | null;
}

/**
 * Every agent on this machine, live. Reads the store for IDE agents, follows the Agent
 * Logs stream for their tools, and polls the external scan while `includeExternal` is on
 * and the window is visible. All listeners and timers are released on unmount, and a
 * scan that resolves after unmount is dropped. Never throws: a failed scan becomes
 * `externalError`; a log stream that cannot be subscribed to leaves tools unknown, so
 * running agents show as "thinking".
 */
export function useVillageAgents(opts: UseVillageAgentsOptions): VillageAgentsState {
  const { includeExternal, pollMs = 3000 } = opts;
  const agents = useAppStore((s) => s.agents);
  const rootIds = useAppStore((s) => s.rootAgentIds);
  const [tools, setTools] = useState<Record<string, string>>({});
  const [calls, setCalls] = useState<Record<string, number>>({});
  const [votes, setVotes] = useState<LanguageVotes>({});
  const [scan, setScan] = useState<{
    report: ExternalAgentsReport;
    calls: Record<string, ExternalCallCount>;
  } | null>(null);
  const [externalError, setExternalError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    let lastId = -Infinity;
    // Languages read the ring's HISTORY too: subscribe, take the snapshot, then the batches that
    // arrived in between (the Agent Logs store's `connect`); the cursor drops any overlap.
    let langId = -Infinity;
    let early: LogLine[][] | null = [];
    const tallyLanguages = (lines: readonly LogLine[]): void => {
      const fleet: Record<string, AgentNode> = useAppStore.getState().agents;
      const seen = countLanguages(lines, langId, (id) => fleet[id] !== undefined);
      langId = seen.lastId;
      if (Object.keys(seen.votes).length > 0) setVotes((prev) => addVotes(prev, seen.votes));
    };
    const flushEarly = (): void => {
      const held = early as LogLine[][];
      early = null;
      for (const batch of held) tallyLanguages(batch);
    };
    onLogstreamLines((lines) => {
      if (early) early.push(lines);
      else tallyLanguages(lines);
      const fleet: Record<string, AgentNode> = useAppStore.getState().agents;
      // Every tool line is a call that HAPPENED, so it counts even for an agent whose turn has
      // already ended (the transcript tail trails the hooks) — only its TOOL is history by then.
      // A line of an agent the fleet does not hold (dismissed, or never ours) is not counted.
      const seen = countToolLines(lines, lastId, (id) => fleet[id] !== undefined);
      lastId = seen.lastId;
      if (Object.keys(seen.counts).length > 0) {
        setCalls((prev) => {
          const next = { ...prev };
          for (const [id, n] of Object.entries(seen.counts)) next[id] = (next[id] ?? 0) + n;
          return next;
        });
      }
      const latest = latestTools(lines);
      // A tool line can trail the hook-driven status by the transcript tail's poll; one
      // for an agent whose turn already ended is history, not what it is doing now.
      for (const id of Object.keys(latest)) {
        const node = fleet[id];
        if (node && FINISHED.has(node.status)) delete latest[id];
      }
      if (Object.keys(latest).length > 0) setTools((prev) => ({ ...prev, ...latest }));
    }).then(
      (un) => {
        if (disposed) {
          un();
          return;
        }
        unlisten = un;
        // The history seeds the languages; without it (a failed snapshot) they start from the stream.
        logstreamSnapshot().then((snap) => {
          tallyLanguages(snap);
          flushEarly();
        }, flushEarly);
      },
      () => {
        // No stream (e.g. a backend without the logstream module): tools and languages stay unknown.
      },
    );
    const unsubscribe = useAppStore.subscribe((s) =>
      setTools((prev) => pruneTools(prev, s.agents)),
    );
    return () => {
      disposed = true;
      unlisten?.();
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!includeExternal) return;
    let disposed = false;
    let inFlight = false;
    const tick = (): void => {
      if (inFlight || document.visibilityState !== "visible") return;
      inFlight = true;
      listExternalAgents().then(
        (r) => {
          inFlight = false;
          if (disposed) return;
          setScan((prev) => ({ report: r, calls: countExternalCalls(prev?.calls ?? {}, r) }));
          setExternalError(null);
        },
        (e: unknown) => {
          inFlight = false;
          if (!disposed) setExternalError(externalErrorCode(e));
        },
      );
    };
    tick();
    const timer = setInterval(tick, pollMs);
    const onVisibility = (): void => tick();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      disposed = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      // Switched off (or re-polled): forget the last scan, its call counts and its error, so
      // switching back on starts from the first FRESH scan — never a report of unknown age that
      // would spawn characters for long-ended sessions, nor a stale error in the HUD.
      setScan(null);
      setExternalError(null);
    };
  }, [includeExternal, pollMs]);

  const merged = useMemo(() => {
    const ide = fromIdeAgents(agents, rootIds, tools, calls, treeLanguages(agents, rootIds, votes));
    const ext = includeExternal && scan ? fromExternal(scan.report, scan.calls) : [];
    return mergeAgents(ide, ext);
  }, [agents, rootIds, tools, calls, votes, includeExternal, scan]);

  return {
    agents: merged,
    externalError: includeExternal ? externalError : null,
    lastScanAt: scan ? scan.report.scannedAtMs : null,
  };
}
