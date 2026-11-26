/** README screenshots: the real <App/> against a mocked Tauri backend; not a test gate. Each `it`
 * writes a raw PNG to .out/; `node scripts/readme-media.mjs` optimizes them into docs/media/. */
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { page } from "vitest/browser";
import { afterEach, beforeEach, it } from "vitest";

import App from "../../src/App";
import { useAppStore } from "../../src/app/store";
import { asAgentId, asTerminalId, type AgentId, type AgentNode, type AgentStatus, type PaneId } from "../../src/app/types";
import { installE2EHarness, resetE2E, settle, teardownE2E, type E2EHarness } from "../../src/e2e/harness";
import type { ChannelDriver } from "../../src/test/tauri-mock";
import { POSTGRES_ENGINE } from "../../src/features/db/dbFixtures";
import { resetAgentLogsForTests } from "../../src/features/agentlogs/agentLogsStore";
import { openDetail, resetNetworkStore } from "../../src/features/network/networkStore";
import { useMetricsStore } from "../../src/features/metrics/metricsStore";
import { noteAgentExited } from "../../src/features/terminal/TerminalRegistry";
import { AGENT_SESSION, FILES, PAY, PAY_SESSION, SHELL_TESTS, TODO, TREE } from "./fixtures";
import * as X from "./panelFixtures";

const OUT = ".out";
let h: E2EHarness;
/** PTY channel per terminal/agent id, so a shot can stream bytes into a specific terminal. */
const ptyById = new Map<string, ChannelDriver>();

const now = Date.now();
let lspChannel: ChannelDriver | undefined;

function setupBackend(): void {
  ptyById.clear();
  const meta = (id: string, args: Record<string, unknown>, agent: boolean) => ({
    id: asTerminalId(id),
    kind: agent ? "agent-terminal" : "terminal",
    title: agent ? "claude" : "zsh",
    cwd: String(args.cwd ?? TODO),
    cols: Number(args.cols ?? 80),
    rows: Number(args.rows ?? 24),
    status: "live",
    ...(agent ? { agentId: asAgentId(id) } : {}),
  });
  h.ipc
    .handle("agent_spawn", (args) => {
      ptyById.set(String(args.agentId), h.ipc.channel().capture(args.onOutput));
      return meta(String(args.agentId), args, true);
    })
    .handle("terminal_open", (args) => {
      ptyById.set(String(args.terminalId), h.ipc.channel().capture(args.onOutput));
      return meta(String(args.terminalId), args, false);
    })
    .handle("terminal_reattach", (args) => {
      ptyById.set(String(args.terminalId), h.ipc.channel().capture(args.onOutput));
      return meta(String(args.terminalId), args, false);
    })
    .handle("read_dir", (args) => TREE[String(args.path)] ?? [])
    .handle("read_file", (args) => FILES[String(args.path)] ?? "\n")
    .handle("git_status", (args) => {
      const root = String(args.root);
      const changes =
        root === TODO
          ? [
              { path: `${TODO}/src/middleware/rateLimit.ts`, status: "added" },
              { path: `${TODO}/src/server.ts`, status: "modified" },
              { path: `${TODO}/tests/rateLimit.test.ts`, status: "untracked" },
            ]
          : root === PAY
            ? [{ path: `${PAY}/src/retry.rs`, status: "modified" }]
            : [];
      return { root, branch: root === TODO ? "feat/rate-limit" : "fix/retry-backoff", changes };
    })
    .handle("claude_usage", () => ({
      windows: [
        { key: "current-session", label: "Current session", usedPct: 34, resetsAtMs: now + 3 * 3600_000 },
        { key: "current-week-all-models", label: "All models", usedPct: 58, resetsAtMs: now + 4 * 86400_000 },
        { key: "current-week-opus", label: "Opus", usedPct: 81, resetsAtMs: now + 4 * 86400_000 },
      ],
      fetchedAtMs: now - 60_000,
    }))
    // A minimal in-page "language server": it answers every request with an empty result
    // (initialize → no capabilities), so the editor shows no install hint and no timeouts.
    .handle("lsp_start", (args) => {
      lspChannel = h.ipc.channel().capture(args.onMessage);
      return { serverId: "media-lsp", languageId: String(args.languageId), status: "running", serverName: "typescript-language-server" };
    })
    .handle("lsp_send", (args) => {
      const msg = JSON.parse(String(args.message)) as { id?: number | string; method?: string };
      if (msg.id !== undefined && msg.method !== undefined) {
        const result = msg.method === "initialize" ? { capabilities: {} } : null;
        setTimeout(() => lspChannel?.sendRaw(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })), 0);
      }
      return null;
    })
    .handle("api_store_load", () => X.API_STORE)
    .handle("logstream_snapshot", () => X.LOG_LINES)
    .handle("syslog_status", () => X.SYSLOG_STATUS)
    .handle("syslog_apps", () => [])
    .handle("procs_list", () => X.PROCS)
    .handle("netcap_snapshot", () => X.FLOWS)
    .handle("netcap_status", () => X.NETCAP_STATUS)
    .handle("netcap_flow", (args) => X.flowDetail(Number(args.id)))
    .handle("netmachine_status", () => ({ available: true, backend: "macos-nettop", reason: null, running: false, hasBytes: true }))
    .handle("db_engines", () => [POSTGRES_ENGINE])
    .handle("db_connections_load", () => ({ connections: [X.DB_CONN], version: 1 }))
    .handle("db_open", () => ({ sessionId: "sess-1", serverVersion: "PostgreSQL 17.2", latencyMs: 4 }))
    .handle("db_query", () => [X.DB_RESULT])
    .handle("db_children", (args) => X.dbChildren(args.node as { kind: string }))
    .handle("db_saved_queries", () => X.DB_SAVED)
    .handle("db_tree_order", () => [])
    .handle("claude_metrics", () => X.metricsReport())
    .handle("subagent_activity", () => [
      { role: "user", text: "Write vitest tests for src/middleware/rateLimit.ts.", timestamp: now - 90_000 },
      { role: "assistant", text: "Reading the middleware to enumerate the behaviours.", tool: "Read", timestamp: now - 80_000 },
      { role: "assistant", text: "Writing tests/rateLimit.test.ts with fake timers.", tool: "Write", timestamp: now - 40_000 },
      { role: "assistant", text: "Running npm test -- rateLimit", tool: "Bash", timestamp: now - 10_000 },
    ]);
}

/** Wire node for applyFleetSnapshot. */
function node(id: string, p: Partial<AgentNode>): AgentNode {
  return {
    id: asAgentId(id),
    parentId: null,
    kind: "subagent",
    title: id,
    status: "running",
    branch: "",
    cwd: TODO,
    runtime: "claude-code",
    startedAt: now - 300_000,
    finishedAt: null,
    lastActivityAt: now - 5_000,
    ...p,
  } as AgentNode;
}

/** Seed a realistic fleet: two projects, roots with nested sub-agents in mixed states. */
function seedFleet(): { rate: AgentId; pay: AgentId; docs: AgentId } {
  const a = useAppStore.getState().agentActions;
  let rate!: AgentId, pay!: AgentId, docs!: AgentId;
  act(() => {
    pay = a.createAgent({ cwd: PAY, title: "Fix flaky payment retries" });
    docs = a.createAgent({ cwd: TODO, title: "Document the REST API" });
    rate = a.createAgent({ cwd: TODO, title: "Add rate limiting" });
  });
  const sub = (id: string, parent: AgentId, title: string, status: AgentStatus, cwd = TODO) =>
    node(id, { parentId: asAgentId(parent), title, status, cwd });
  act(() => {
    a.applyFleetSnapshot([
      node(rate, { kind: "orchestrator", title: "Add rate limiting", branch: "feat/rate-limit", status: "running", parentId: null }),
      sub("sa-explore", rate, "explore-codebase", "done"),
      sub("sa-grep", asAgentId("sa-explore"), "grep-route-handlers", "done"),
      sub("sa-tests", rate, "write-tests", "running"),
      sub("sa-sec", rate, "review-security", "waiting_input"),
      node(docs, { kind: "orchestrator", title: "Document the REST API", branch: "docs/openapi", status: "done", parentId: null }),
      sub("sa-openapi", docs, "generate-openapi-spec", "done"),
      node(pay, { kind: "orchestrator", title: "Fix flaky payment retries", branch: "fix/retry-backoff", status: "waiting_input", cwd: PAY, parentId: null }),
      sub("sa-repro", pay, "reproduce-flake", "running", PAY),
      sub("sa-bench", pay, "bench-backoff", "error", PAY),
    ]);
    for (const id of [rate, pay, docs, "sa-explore"]) {
      const ag = useAppStore.getState().agents[id as AgentId];
      if (ag && !ag.expanded) a.toggleAgentExpanded(id as AgentId);
    }
    a.selectAgent(rate);
  });
  return { rate, pay, docs };
}

async function shot(name: string): Promise<void> {
  await settle(600);
  await page.screenshot({ path: `${OUT}/${name}.png` });
}

beforeEach(() => {
  resetE2E();
  resetAgentLogsForTests();
  resetNetworkStore();
  useMetricsStore.setState({ report: null, error: null, loading: false });
  h = installE2EHarness();
  setupBackend();
});
afterEach(() => teardownE2E(h.ipc));

/** Canned output per agent id, written once its PTY exists (agent PTYs spawn lazily, on first view). */
const pending = new Map<string, string>();
function feed(): void {
  for (const [id, text] of pending) {
    const drv = ptyById.get(id);
    if (drv) {
      drv.send(text);
      pending.delete(id);
    }
  }
}

async function boot(opts: { hideRight?: boolean; noSession?: boolean } = {}): Promise<ReturnType<typeof seedFleet>> {
  render(<App />);
  await screen.findByTestId("app-shell");
  act(() => useAppStore.getState().uiActions.setLeftRailWidth(290));
  if (opts.hideRight) act(() => useAppStore.getState().uiActions.toggleRightRail());
  const ids = seedFleet();
  // Attribute the canned log lines / flows to the real "Add rate limiting" agent terminal.
  const tabs = Object.values(useAppStore.getState().tabs) as unknown as { ref: { kind: string; agentId?: string; terminalId?: string } }[];
  const rateTerm = tabs.find((t) => t.ref.kind === "agent-terminal" && t.ref.agentId === ids.rate)?.ref.terminalId ?? ids.rate;
  // (Module-level fixtures are re-pointed on every boot: each test mints fresh ids.)
  for (const l of X.LOG_LINES) if (l.agentId !== null) Object.assign(l, { agentId: ids.rate, terminalId: rateTerm });
  for (const f of X.FLOWS) if (f.terminalId !== null) f.terminalId = rateTerm;
  await settle(300);
  pending.clear();
  if (!opts.noSession) pending.set(ids.rate, AGENT_SESSION);
  pending.set(ids.pay, PAY_SESSION);
  feed();
  return ids;
}

it("hero — agent tree, agent terminal, file tree", async () => {
  await boot();
  await shot("01-hero");
});

it("editor — syntax-highlighted code beside a terminal", async () => {
  await boot({ hideRight: true });
  act(() => void useAppStore.getState().layoutActions.openEditorTab(`${TODO}/src/middleware/rateLimit.ts`));
  await settle(300);
  let termPane: string | undefined;
  act(() => {
    const st = useAppStore.getState() as unknown as { focusedPaneId: PaneId };
    termPane = useAppStore.getState().layoutActions.splitPane(st.focusedPaneId, "row");
  });
  const known = new Set(ptyById.keys());
  act(() => {
    useAppStore.getState().layoutActions.openTerminalTab({ cwd: TODO, paneId: termPane as PaneId });
  });
  await settle(500);
  for (const [id, drv] of ptyById) if (!known.has(id)) drv.send(SHELL_TESTS);
  await shot("02-editor-terminal");
});

/** GIF frames: a session streaming in, then hopping around the tree. */
it("gif — tour", async () => {
  let n = 0;
  const frame = async (holds = 1) => {
    await settle(60);
    for (let i = 0; i < holds; i++) await page.screenshot({ path: `${OUT}/gif/${String(n++).padStart(4, "0")}.png` });
  };
  const ids = await boot({ noSession: true });
  const user = userEvent.setup();
  await frame(3);
  const lines = AGENT_SESSION.split("\r\n");
  for (let i = 0; i < lines.length; i += 2) {
    ptyById.get(ids.rate)?.send(lines.slice(i, i + 2).join("\r\n") + "\r\n");
    await frame();
  }
  await frame(8);
  await user.click(screen.getByText("write-tests", { selector: ".fleet-row *" }));
  await frame(10);
  await user.click(screen.getByText("Fix flaky payment retries", { selector: ".fleet-row *" }));
  await settle(200);
  feed();
  await frame(12);
  act(() => void useAppStore.getState().layoutActions.openNetworkTab());
  await settle(300);
  act(() => openDetail(X.DETAIL_FLOW_ID));
  await frame(12);
  await user.click(screen.getByText("Add rate limiting", { selector: ".fleet-row *" }));
  await frame(10);
});

it("api — request with a JSON response", async () => {
  await boot();
  const user = userEvent.setup();
  h.setHttpResponse(X.HTTP_RESPONSE);
  act(() => {
    const st = useAppStore.getState();
    st.uiActions.setRightRailTab("collections");
    const rid = st.apiActions.createApiRequest();
    st.apiActions.patchApiRequest(rid, { method: "GET", url: "http://localhost:3000/api/todos?status=open&limit=3" });
    st.apiActions.addHeader(rid);
    const req = useAppStore.getState().apiRequests?.[rid] as unknown as { headers: { id: string }[] } | undefined;
    const hid = req?.headers?.[req.headers.length - 1]?.id;
    if (hid) st.apiActions.updateHeader(rid, hid, { name: "x-api-key", value: "{{API_KEY}}" } as never);
    const tab = st.layoutActions.openApiRequestTab(rid);
    st.layoutActions.renameTab(tab, "List open todos");
  });
  await settle(300);
  await user.click(screen.getByTestId("api-send"));
  await screen.findByTestId("api-status");
  await shot("03-api-client");
});

it("db — query results grid with the schema tree", async () => {
  await boot();
  await act(async () => {
    const st = useAppStore.getState();
    st.uiActions.setRightRailTab("db");
    await st.dbActions.loadDbStore();
    await useAppStore.getState().dbActions.openDbSession(X.DB_CONN.id);
    useAppStore.getState().layoutActions.openDbConsoleTab(X.DB_CONN.id);
    useAppStore.getState().dbActions.setDbConsoleText(X.DB_CONN.id, X.DB_SQL);
    await useAppStore.getState().dbActions.runDbQuery(X.DB_CONN.id, "statement");
  });
  await settle(400);
  await act(async () => {
    for (const ref of X.DB_EXPAND) {
      useAppStore.getState().dbActions.toggleDbNode(X.DB_CONN.id, "sess-1", ref as never);
      await new Promise((r) => setTimeout(r, 80));
    }
  });
  await shot("04-db-client");
});

it("agent logs — every agent, tool call and dev app in one stream", async () => {
  await boot({ hideRight: true });
  act(() => void useAppStore.getState().layoutActions.openAgentLogsTab());
  await settle(800);
  await shot("05-agent-logs");
});

it("network — captured HTTP flows with a JSON detail", async () => {
  await boot({ hideRight: true });
  act(() => void useAppStore.getState().layoutActions.openNetworkTab());
  await settle(600);
  act(() => openDetail(X.DETAIL_FLOW_ID));
  await settle(600);
  await shot("06-network");
});

it("metrics — token usage and turns", async () => {
  await boot({ hideRight: true });
  act(() => void useAppStore.getState().layoutActions.openMetricsTab(null));
  await settle(800);
  await shot("07-metrics");
});

/** Context-window GIF frames land in .out/ctxgif/; readme-media.mjs encodes the GIF. */
it("gif — context window", async () => {
  let n = 0;
  const frame = async (holds = 1) => {
    await settle(60);
    for (let i = 0; i < holds; i++)
      await page.screenshot({ path: `${OUT}/ctxgif/${String(n++).padStart(4, "0")}.png` });
  };
  const cat = (key: string, label: string, tokens: number) => ({ key, label, tokens, percent: tokens / 10_000 });
  const reading = (msgs: number) => {
    const fixed = 2_300 + 20_400 + 717 + 4_800 + 4_600;
    const used = fixed + msgs;
    return {
      model: "claude-opus-5-5",
      usedTokens: used,
      windowTokens: 1_000_000,
      usedPercent: Math.round(used / 10_000),
      categories: [
        cat("system-prompt", "System prompt", 2_300),
        cat("system-tools", "System tools", 20_400),
        cat("mcp-server-instructions", "MCP server instructions", 717),
        cat("memory-files", "Memory files", 4_800),
        cat("skills", "Skills", 4_600),
        cat("messages", "Messages", msgs),
        cat("free-space", "Free space", 1_000_000 - used - 33_000),
        cat("autocompact-buffer", "Autocompact buffer", 33_000),
      ],
      measuredAtMs: Date.now(),
    };
  };
  const ids = await boot({ hideRight: true });
  const byAgent: Record<string, number> = { [ids.rate]: 257_900, [ids.pay]: 781_000, [ids.docs]: 64_200 };
  h.ipc.handle("context_usage", async (args) => {
    await new Promise((r) => setTimeout(r, 700)); // the CLI takes a moment — show "measuring"
    return reading(byAgent[(args as { agentId: string }).agentId] ?? 10_000);
  });
  const user = userEvent.setup();
  // Metrics in its own pane on the right, so selecting an agent (which brings its
  // terminal to the front on the left) keeps the card in view.
  act(() => {
    const L = useAppStore.getState().layoutActions;
    const st = useAppStore.getState() as unknown as { focusedPaneId: PaneId };
    const right = L.splitPane(st.focusedPaneId, "row");
    L.focusPane(right);
    L.openMetricsTab(null);
  });
  act(() => useAppStore.getState().agentActions.selectAgent(ids.docs));
  await frame(4);
  await settle(800);
  await frame(10);
  act(() => useAppStore.getState().agentActions.selectAgent(ids.rate));
  await frame(3);
  await settle(800);
  await frame(10);
  await user.click(await screen.findByTestId("context-view-grid"));
  await frame(12);
  act(() => useAppStore.getState().agentActions.selectAgent(ids.pay));
  await frame(3);
  await settle(800);
  await frame(12);
  await user.click(await screen.findByTestId("context-view-bar"));
  await frame(10);
  act(() => useAppStore.getState().agentActions.selectAgent(ids.rate));
  await settle(300);
  await frame(10);
});

/** Demo still: an agent whose claude was killed — Error row with ↻ Resume,
 *  the tab says how it ended and accepts selection again. */
it("exited agent — Resume and a copyable tab", async () => {
  const ids = await boot({ hideRight: true });
  act(() => useAppStore.getState().agentActions.selectAgent(ids.pay));
  await settle(400);
  const drv = ptyById.get(ids.pay);
  drv?.send(PAY_SESSION + "\x1b[?1002h\x1b[?1006h"); // claude's mouse tracking, never turned off
  await settle(300);
  act(() => {
    const a = useAppStore.getState().agentActions;
    a.applyAgentEvent({ t: "exited", agentId: ids.pay, code: 137 });
    // What Rust's stop_unfinished_descendants emits for the still-running child.
    a.applyAgentEvent({ t: "status", agentId: asAgentId("sa-repro"), status: "error" });
    noteAgentExited(asTerminalId(ids.pay), 137);
  });
  await settle(500);
  await shot("08-agent-exited");
});

/*
 * Agents drive Agent Studio: a Claude Code session uses the API-client tools through the
 * `agent-studio` command, and the app shows it. Imports are dynamic so these blocks stay
 * self-contained at the end of the file.
 */

it("agent api tools — Claude Code runs agent-studio api/http, the app shows the results", async () => {
  const F = await import("./agentApiFixtures");
  const { dispatchAgentCtl } = await import("../../src/features/agentctl/dispatch");
  // The history file the tools append to (`history_store.rs`): the user's earlier sends, then
  // each agent send as it happens. `apiHistory` makes the rail re-read it.
  const t0 = Date.now();
  const history = F.earlierHistory(t0);
  h.ipc.handle("api_store_load", () => F.AGENT_API_STORE);
  h.ipc.handle("api_history_load", () => ({ entries: [...history] }));

  const ids = await boot({ noSession: true });
  const terminalId = String(ids.rate);
  // The agent's terminal on top, the pane its request tab opens in below. (Side by side, the
  // request bar has no room left for the URL.)
  let below!: PaneId;
  act(() => {
    const L = useAppStore.getState().layoutActions;
    below = L.splitPane((useAppStore.getState() as unknown as { focusedPaneId: PaneId }).focusedPaneId, "column");
    L.resizePane((useAppStore.getState() as unknown as { layout: { id: PaneId } }).layout.id, [0.555, 0.445]);
  });
  await settle(500);
  const resize = h.ipc.calls("terminal_resize").filter((c) => String(c.args.terminalId) === terminalId);
  const size = resize[resize.length - 1]?.args ?? {};
  console.log(`[media] agent terminal: ${String(size.cols)}x${String(size.rows)}`);
  const s = F.agentApiSession(Number(size.cols ?? 100), Number(size.rows ?? 24));
  const pty = ptyById.get(terminalId);
  const write = async (text: string) => {
    pty?.send(text);
    await settle(150);
  };
  const ctl = (kind: string, fields: Record<string, unknown>) =>
    act(() => dispatchAgentCtl({ kind, terminalId, ...fields }));

  await write(s.prompt);
  history.push(F.listEntry(t0 - 40_000));
  await write(s.list);
  ctl("apiHistory", { historyIds: [history[history.length - 1].id] });
  history.push(F.burstEntry(t0 - 25_000));
  await write(s.burst);
  ctl("apiHistory", { historyIds: [history[history.length - 1].id] });
  await write(s.open);
  act(() => useAppStore.getState().layoutActions.focusPane(below));
  ctl("httpOpen", F.OPEN_EVENT);
  await write(s.summary);
  await settle(300);

  // The user presses Send in the tab the agent opened.
  const user = userEvent.setup();
  h.setHttpResponse(F.BURST_RESPONSE);
  await user.click(screen.getByTestId("api-send"));
  await screen.findByTestId("api-status");
  await shot("10-agent-api-tools");
});

it("settings — Claude Code has Agent Studio's tools", async () => {
  const F = await import("./agentApiFixtures");
  const { forgetClaudeMcpRuns } = await import("../../src/features/settings/claudeMcpRuns");
  // The real mouse (Playwright): a click with it leaves no keyboard-focus ring on the gear.
  const { userEvent: mouse } = await import("vitest/browser");
  forgetClaudeMcpRuns();
  h.ipc.handle("claude_mcp_status", () => F.MCP_INSTALLED);
  await boot({ hideRight: true, noSession: true });
  await mouse.click(screen.getByRole("button", { name: "Settings" }));
  const item = await screen.findByTestId("settings-claude-mcp");
  await settle(300);
  if (item.getAttribute("data-state") !== "installed") throw new Error("the Claude MCP item is not in its added state");
  // Crop: the popover under the titlebar, with a little of the titlebar to its left.
  const box = screen.getByTestId("settings-popover").getBoundingClientRect();
  const left = Math.round(box.left - 48);
  const frame = document.createElement("div");
  Object.assign(frame.style, {
    position: "fixed",
    left: `${left}px`,
    top: "0px",
    width: `${window.innerWidth - left}px`,
    height: `${Math.round(box.bottom + 24)}px`,
    pointerEvents: "none",
    zIndex: "9999",
  });
  document.body.appendChild(frame);
  await settle(300);
  await page.screenshot({ path: `${OUT}/11-claude-code-setting.png`, element: frame });
  frame.remove();
});

/**
 * "Agents drive Agent Studio": a Claude Code agent used the `agent-studio db …` tools from its
 * terminal (left), and the app shows what it did — the DB panel's notice naming the agent, and
 * the connection's console tab with the query and what it returned (right).
 *
 * The DB side goes through the app's own path: each command's `agent-ctl://event` payload (as
 * Rust emits it) is handed to the real dispatcher (`src/features/agentctl/dispatch.ts`). Imports
 * are local so this block stays self-contained at the end of the file.
 *
 * Rendered in Docker (the Playwright image): there, Liberation Mono is hidden from fontconfig and
 * DejaVu Sans Mono installed, so the mono font is close to the SF Mono of the macOS-made shots.
 */
it("agent db tools — an agent's database work, shown in the app", async () => {
  const { dispatchAgentCtl } = await import("../../src/features/agentctl/dispatch");
  const A = await import("./agentToolsFixtures");
  const ids = await boot({ noSession: true });

  // The connection store before and after `db connect` writes it (Rust saves, then emits).
  let saved: unknown[] = [];
  h.ipc.handle("db_connections_load", () => ({ connections: saved, version: 1 }));
  // The size each terminal was fitted to, so the transcript wraps where the terminal does.
  const size = new Map<string, { cols: number; rows: number }>();
  h.ipc.handle("terminal_resize", (args) => {
    size.set(String(args.terminalId), { cols: Number(args.cols), rows: Number(args.rows) });
    return null;
  });

  // A connection the agent just added has no saved queries yet; its tree is the todo-api one.
  h.ipc.handle("db_saved_queries", () => []);
  h.ipc.handle("db_children", (args) => {
    const n = args.node as { kind: string; name?: string };
    return n.kind === "table" && n.name === "rate_limit_events" ? A.RATE_LIMIT_EVENTS_COLUMNS : X.dbChildren(n);
  });

  // The agent's tab dragged to the front of its pane (its name shows in the narrower strip), the
  // pane split, and the user's click into the empty right half: the console tab the agent's run
  // opens lands in the focused pane.
  let right!: PaneId;
  act(() => {
    const L = useAppStore.getState().layoutActions;
    const left = (useAppStore.getState() as unknown as { focusedPaneId: PaneId }).focusedPaneId;
    const tabs = Object.values(useAppStore.getState().tabs) as unknown as { id: string; ref: { kind: string; agentId?: string } }[];
    const rateTab = tabs.find((t) => t.ref.kind === "agent-terminal" && t.ref.agentId === ids.rate);
    if (rateTab) L.moveTab(rateTab.id as never, left, 0);
    right = L.splitPane(left, "row");
    L.resizePane((useAppStore.getState() as unknown as { layout: { id: PaneId } }).layout.id, [0.515, 0.485]);
  });
  await settle(300);
  act(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    useAppStore.getState().layoutActions.focusPane(right);
  });

  const emit = async (event: { kind: string } & Record<string, unknown>) => {
    await act(async () => dispatchAgentCtl({ ...event, terminalId: ids.rate }));
    await settle(300);
  };
  const connectionId = A.AGENT_DB_CONN.id;
  // agent-studio db connect 'postgres://dev@localhost:5432/todo_api' --name 'todo-api (local)'
  saved = [A.AGENT_DB_CONN];
  await emit({ kind: "dbConnection", connectionId, created: true, open: true });
  // agent-studio db schema … emits nothing; agent-studio db query 'todo-api (local)' "SELECT …"
  await emit({ kind: "dbQueryRun", connectionId, query: A.AGENT_SQL, results: [A.AGENT_RESULT], error: null, notes: [] });

  // The panel's tree opened down to the table the agent read (the clicks a user makes), and the
  // empty Saved queries folder closed.
  const eventsTable = { kind: "table", database: "todo_api", schema: "public", name: "rate_limit_events" };
  await act(async () => {
    for (const ref of [...X.DB_EXPAND.slice(0, 4), eventsTable, { kind: "savedQueries" }]) {
      useAppStore.getState().dbActions.toggleDbNode(connectionId, "sess-1", ref as never);
      await new Promise((r) => setTimeout(r, 80));
    }
  });
  await settle(300);

  const { cols, rows } = size.get(ids.rate) ?? { cols: 80, rows: 40 };
  ptyById.get(ids.rate)?.send(A.agentDbSession(cols, rows));
  await shot("09-agent-db-tools");
});
