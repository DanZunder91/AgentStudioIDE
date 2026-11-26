/** Every agent on this machine as a {@link VillageAgent}: IDE ones from the store, external ones
 * from the Rust scan. Agent Logs yields tool NAMES only (a Bash command can carry a secret).
 * Language is voted by extension; no project folder is read (macOS would prompt), no path kept. */

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

/** House key: a folder's basename for both origins (Rust sends external ones as basenames, for
 * privacy). Either separator, trailing one ok; `/` keeps itself. */
export function folderOf(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter((p) => p !== "");
  return parts.length > 0 ? parts[parts.length - 1] : cwd;
}

/** Tool NAME of an Agent Logs `tool` line (`"Edit: /a/b.ts"` → `"Edit"`); null for empty text. */
export function toolFromLogText(text: string): string | null {
  const head = text.split(":", 1)[0].trim().split(/\s+/, 1)[0];
  return head === "" ? null : head;
}

// ───────────────────────────── languages (the City's neon signs) ─────────────────────────────

/** Extension (lowercase, no dot) → the language it votes for: the table Rust reads too. */
const EXTENSIONS: ReadonlyMap<string, string> = new Map(Object.entries(projectLanguages.extensions));

/** The language a path's extension votes for, or null (none, dotfile, dir, non-voting language).
 * Twin of Rust's `language_of_path` (external_agents/language.rs), case for case. */
export function languageOfPath(path: string): string | null {
  const name = path.split(/[\\/]/).pop() as string;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null; // `.rs` is a dotfile named "rs", not a Rust file
  return EXTENSIONS.get(name.slice(dot + 1).toLowerCase()) ?? null;
}

/** Tools whose line names a file (Rust's `summarize_tool_use`); Grep / Glob carry a pattern. */
const FILE_TOOLS = new Set(["Read", "Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** The language an Agent Logs `tool` line's file votes for, or null. */
export function languageOfLogText(text: string): string | null {
  const tool = toolFromLogText(text);
  if (tool === null || !FILE_TOOLS.has(tool)) return null;
  return languageOfPath(text.slice(text.indexOf(": ") + 2));
}

/** Fresh `tool` lines of `known` agents past `afterId` (ids are monotonic per app run: the Agent
 * Logs store's dedupe), in id order, plus the highest id seen. */
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

/** Each known agent's language votes past `afterId` (its own cursor), plus the highest id seen. */
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

/** Each IDE agent carries its TREE's winning language (root + every sub-agent), as an external
 * session does. A tree with no vote is absent; order and cycle-safety as `fromIdeAgents`. */
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

/** The IDE fleet in forest order (the rail's; stable). Dismissed agents are already gone from the
 * forest; a missing child id (mid-snapshot race) or a cycle is skipped. No `languages` entry: null
 * language. */
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

/** The external scan as village agents, keys namespaced so they never collide with an AgentId;
 * no `calls` entry leaves `toolCalls` absent (unknown). */
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

/** Sub-agent launches (Rust's `never_blocks` launch group): a waiting parent's `lastActivityMs`
 * moves with its sub-agents' writes, which are their traffic, not the parent's. */
const LAUNCH_TOOLS = new Set(["Agent", "Task", "Workflow"]);

/** External tool calls, BEST EFFORT: a scan where `lastActivityMs` advanced with a tool (not a
 * launch) pending counts ONE, so calls between polls may merge or vanish. A new or returning agent
 * starts at 0. */
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

/** IDE agents (forest order), then external ones parents first, siblings by key: Rust's walk
 * order is no promise and a reshuffle would teleport characters. First duplicate wins; orphans are
 * roots. */
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

/** Tool calls per `known` agent in one batch, only past `afterId` (ids are monotonic per app run:
 * the Agent Logs store's dedupe). Returns the counts and the highest id seen. */
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

/** Every agent, live; polls the external scan only while `includeExternal` and visible. Releases
 * everything on unmount and drops late scans. Never throws: a failed scan is `externalError`; no
 * log stream leaves tools unknown (agents show as "thinking"). */
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
