/**
 * Shared harness for the browser-tier smoke-core E2E suite (the primary E2E
 * tier). Renders the REAL `<App/>` in real Chromium (Playwright) with a fully
 * mocked Tauri backend, so the 8 smoke-core flows (docs/design/e2e-flow-catalog
 * §4.1) can be driven through real DOM interaction and asserted on the real
 * selectors — the frontend-wiring layer that jsdom can't reach.
 *
 * ── What this installs ────────────────────────────────────────────────────────
 * `installTauriMock()` (src/test/tauri-mock.ts) fakes `invoke()`; every command
 * on the Rust surface (`src-tauri/src/lib.rs`) is registered here so any code
 * path the app exercises is satisfied — an un-stubbed command throws loudly
 * rather than resolving `undefined` (the mock's contract). The command surface
 * and the "what each flow invokes" table are §5 of the flow catalog.
 *
 *   - control:    fleet_snapshot, default_workspace, recent_projects,
 *                 push_recent_project, ensure_agent_hooks, subagent_activity
 *   - terminals:  terminal_open / _write / _resize / _close / _reattach,
 *                 agent_spawn  (each captures its hot-plane Channel via a driver)
 *   - workspace:  read_dir (a fixture tree), read_file (fixture contents),
 *                 write_file
 *   - search:     find_in_files (fixture matches)
 *   - http:       http_send (a canned response; the last request is recorded)
 *   - api store:  api_store_load (empty store), api_store_save (noop) — the API
 *                 view hydrates its collections/environments on first mount
 *   - lsp:        lsp_start (→ "unavailable" — the fixture files are markdown,
 *                 which has no server, so this is only insurance), lsp_send/_stop
 *   - context:    context_usage({ agentId }) (a canned `/context` reading —
 *                 the Metrics panel's per-agent "Context window" card)
 *
 * ── Boot seeding ──────────────────────────────────────────────────────────────
 * `<App/>` is pure — the cold-plane bridge (`startBridge`, which resolves
 * `default_workspace` → `setWorkspaceRoot` and subscribes to `agent://event`)
 * lives in `main.tsx`, NOT in the component tree, so rendering `<App/>` never
 * boots it (that is exactly what keeps App renderable in this tier). So the
 * harness seeds `workspaceRoot` directly to the fixture root — the same write
 * the bridge would make from `default_workspace` — which is all the smoke-core
 * flows depend on. This mirrors how the existing full-App browser specs
 * (`terminalFit`, `reattachFlow`) seed the store rather than driving the bridge.
 */

import { act } from "@testing-library/react";

import { useAppStore } from "../app/store";
import {
  asAgentId,
  asTerminalId,
  type FsEntry,
  type TerminalMeta,
} from "../app/types";
import type { HttpRequest, HttpResponse } from "../features/api/httpIpc";
import type { ContextUsage } from "../features/context/contextTypes";
import type { FindFilesResult, FindResult } from "../features/find/findIpc";
import type { LspServerMeta } from "../features/editor/lsp/lspIpc";
import { disposeAll as disposeTerminals } from "../features/terminal";
import { disposeAll as disposeEditors } from "../features/editor/EditorRegistry";
import { resetClients } from "../features/editor/lsp/client";
import { resetContextStore } from "../features/context/contextStore";
import { resetStore } from "../test/store-harness";
import { resetFleetStore } from "../test/fleet-harness";
import {
  installTauriMock,
  type ChannelDriver,
  type TauriMock,
} from "../test/tauri-mock";

/* ────────────────────────────── fixtures ────────────────────────────── */

/** The mocked project root the app boots into (`default_workspace` equivalent). */
export const FIXTURE_ROOT = "/projects/fixture";

/** A top-level file in the fixture tree — clicked in the Open-file flow (E1). */
export const FIXTURE_FILE = `${FIXTURE_ROOT}/README.md`;
export const FIXTURE_FILE_CONTENT =
  "# Agent Studio fixture\n\nHELLO_FROM_MOCK_BACKEND\n";

/** The file a Find match lands in (S6 opens it). Markdown → no LSP round-trip. */
export const FIXTURE_NOTES = `${FIXTURE_ROOT}/notes.md`;
export const FIXTURE_NOTES_CONTENT =
  "first line\nfind me right here on the second line\nthird line\n";

/** The query the Find flow types; the mock returns a match regardless of value. */
export const FIND_QUERY = "find me";

/** The canned GET/POST response `http_send` resolves with. */
/**
 * A canned usage reading (the usage strip) — the three windows the real CLI prints, with
 * percentages chosen to land one in each colour band (ok / warn / danger) so a
 * browser-tier test can measure all three at once. `resetsAtMs` is a fixed epoch,
 * not `Date.now()`-relative: the strip's reset text is only shown on hover, and a
 * moving target would make any assertion about it time-dependent.
 */
export const CANNED_USAGE = {
  windows: [
    { key: "current-session", label: "Current session", usedPct: 41, resetsAtMs: 1_785_243_600_000 },
    { key: "current-week-all-models", label: "All models", usedPct: 62, resetsAtMs: 1_785_600_000_000 },
    { key: "current-week-fable", label: "Fable", usedPct: 96, resetsAtMs: 1_785_600_000_000 },
  ],
  fetchedAtMs: 1_785_200_000_000,
};

/**
 * The `context_usage` reading (Metrics → "Context window" card): a realistic
 * reading, 290.7k of a 1m window, with free space and the autocompact
 * buffer printed as the CLI prints them. Fixed `measuredAtMs` for the same reason as
 * {@link CANNED_USAGE}: a moving timestamp would make any assertion time-dependent.
 */
export const CANNED_CONTEXT_USAGE: ContextUsage = {
  model: "claude-opus-5-5",
  usedTokens: 290_700,
  windowTokens: 1_000_000,
  usedPercent: 29,
  categories: [
    { key: "system-prompt", label: "System prompt", tokens: 2_300, percent: 0.2 },
    { key: "system-tools", label: "System tools", tokens: 20_400, percent: 2 },
    { key: "mcp-server-instructions", label: "MCP server instructions", tokens: 717, percent: 0.1 },
    { key: "memory-files", label: "Memory files", tokens: 4_800, percent: 0.5 },
    { key: "skills", label: "Skills", tokens: 4_600, percent: 0.5 },
    { key: "messages", label: "Messages", tokens: 257_900, percent: 25.8 },
    { key: "free-space", label: "Free space", tokens: 676_300, percent: 67.6 },
    { key: "autocompact-buffer", label: "Autocompact buffer", tokens: 33_000, percent: 3.3 },
  ],
  measuredAtMs: 1_785_200_000_000,
};

export const CANNED_HTTP_RESPONSE: HttpResponse = {
  status: 200,
  statusText: "OK",
  headers: [{ name: "content-type", value: "application/json" }],
  body: '{"ok":true,"source":"mock-backend"}',
  durationMs: 12,
  sizeBytes: 35,
  truncated: false,
};

/** The fixture directory listing `read_dir` serves, keyed by absolute path. */
const FIXTURE_TREE: Record<string, FsEntry[]> = {
  [FIXTURE_ROOT]: [
    { name: "src", path: `${FIXTURE_ROOT}/src`, isDir: true },
    { name: "README.md", path: FIXTURE_FILE, isDir: false },
    { name: "notes.md", path: FIXTURE_NOTES, isDir: false },
  ],
  [`${FIXTURE_ROOT}/src`]: [
    { name: "main.md", path: `${FIXTURE_ROOT}/src/main.md`, isDir: false },
  ],
};

/** The fixture file contents `read_file` serves, keyed by absolute path. */
const FIXTURE_FILES: Record<string, string> = {
  [FIXTURE_FILE]: FIXTURE_FILE_CONTENT,
  [FIXTURE_NOTES]: FIXTURE_NOTES_CONTENT,
};

/* ──────────────────────────── the harness ──────────────────────────── */

export interface E2EHarness {
  /** The installed IPC mock — `handle`/`calls`/`lastCall` per test as needed. */
  ipc: TauriMock;
  /** Every PTY Channel captured from a terminal_open / agent_spawn / reattach. */
  ptys: ChannelDriver[];
  /** The most recent `http_send` request, or null — for asserting method/body. */
  lastHttpRequest(): HttpRequest | null;
  /** Swap the canned `http_send` response (defaults to {@link CANNED_HTTP_RESPONSE}). */
  setHttpResponse(response: HttpResponse): void;
}

/** A TerminalMeta the way Rust echoes one back — id must equal the sent id. */
function terminalMeta(
  id: string,
  args: Record<string, unknown>,
  agentId?: string,
): TerminalMeta {
  return {
    id: asTerminalId(id),
    kind: agentId ? "agent-terminal" : "terminal",
    title: "sh",
    cwd: String(args.cwd ?? FIXTURE_ROOT),
    cols: Number(args.cols ?? 80),
    rows: Number(args.rows ?? 24),
    status: "live",
    ...(agentId ? { agentId: asAgentId(agentId) } : {}),
  };
}

/**
 * Install the mock backend, register the whole command surface, and seed the
 * workspace root. Call from `beforeEach` after {@link resetE2E}.
 */
export function installE2EHarness(): E2EHarness {
  const ipc = installTauriMock();
  const ptys: ChannelDriver[] = [];
  let httpResponse = CANNED_HTTP_RESPONSE;

  // Capture the hot-plane Channel a PTY-spawning command hands over, so a test
  // could stream bytes if it wanted; the smoke-core flows only assert the
  // control plane (command fired, tab/host mounted).
  const capturePty = (onOutput: unknown): void => {
    ptys.push(ipc.channel().capture(onOutput));
  };

  ipc
    // ── cold plane / boot ──
    .handle("fleet_snapshot", () => ({ agents: [], terminals: [] }))
    .handle("default_workspace", () => FIXTURE_ROOT)
    .handle("recent_projects", () => [])
    .handle("push_recent_project", () => null)
    // Agent pinning: the bridge calls `pinned_agents()` on boot to
    // reconcile the pin registry, and the 📌 toggle calls pin/unpin. Empty +
    // no-ops so any <App/> render (which now runs the boot reconcile) is clean.
    .handle("pinned_agents", () => [])
    .handle("pin_agent", () => null)
    .handle("unpin_agent", () => null)
    // Opening a folder (addBrowseRoot) installs the ad-hoc hook for it;
    // a no-op keeps the browser tier green when a flow opens a folder.
    .handle("ensure_agent_hooks", () => null)
    .handle("subagent_activity", () => [])

    // ── terminals (real PTY path is mocked; ids must round-trip) ──
    .handle("terminal_open", (args) => {
      capturePty(args.onOutput);
      return terminalMeta(String(args.terminalId), args);
    })
    .handle("agent_spawn", (args) => {
      capturePty(args.onOutput);
      // An agent terminal's TerminalId IS its AgentId (the registry enforces it).
      return terminalMeta(String(args.agentId), args, String(args.agentId));
    })
    .handle("terminal_reattach", (args) => {
      capturePty(args.onOutput);
      return terminalMeta(String(args.terminalId), args);
    })
    .handle("terminal_write", () => null)
    .handle("terminal_resize", () => null)
    .handle("terminal_close", () => null)

    // ── workspace (fixture filesystem) ──
    .handle("read_dir", (args) => FIXTURE_TREE[String(args.path)] ?? [])
    .handle(
      "read_file",
      (args) => FIXTURE_FILES[String(args.path)] ?? "fixture file\n",
    )
    .handle("write_file", () => null)

    // ── search ──
    .handle("find_in_files", (): FindResult => ({
      matches: [
        {
          // `file` is relative to the search root (find_in_files contract);
          // the panel joins it to `root` to reveal the absolute path.
          file: "notes.md",
          line: 2,
          col: 1,
          lineText: FIXTURE_NOTES_CONTENT.split("\n")[1],
          matchStart: 0,
          matchEnd: 7,
        },
      ],
      truncated: false,
    }))
    // ── filename finder: one relative hit, joined to `root` to open ──
    .handle("find_files", (): FindFilesResult => ({
      files: [{ path: "README.md", name: "README.md" }],
      truncated: false,
    }))
    // Cancellation. Inert on purpose: both find panels stop their
    // in-flight walk on EVERY exit — superseding the query, and closing the
    // overlay — so any flow that types in Find and then leaves fires this. The
    // mocked searches resolve instantly, so there is never a live walk to stop;
    // `false` ("no such search") is the honest answer, and the point of the stub
    // is that a background best-effort cancel must not throw the loud
    // "unmocked command" that would fail the tier.
    .handle("find_cancel", (): boolean => false)

    // ── http (canned; the last request is inspectable via lastHttpRequest) ──
    .handle("http_send", () => httpResponse)

    // ── api durable store: the view loads it on first mount ──
    // Empty store on load, noop on save — the smoke-core API flows (A2/A3)
    // only need the load to resolve so the view mounts without a store error.
    .handle("api_store_load", () => ({
      collections: [],
      environments: [],
      activeEnvironmentId: null,
    }))
    .handle("api_store_save", () => null)

    // ── api request history: the History rail panel loads it on
    // mount. Empty log on load, noop on save — a test that opens History (or
    // re-runs from it) mounts the panel without a persistence error. ──
    .handle("api_history_load", () => ({ entries: [] }))
    .handle("api_history_save", () => null)

    // ── websocket console: complete the surface so nothing throws ──
    // The smoke-core does not drive the WS console; these just satisfy the
    // command surface. `ws_connect` returns a fake id and pushes an `open` event
    // on the channel (a JSON string frame), mirroring the real relay.
    .handle("ws_connect", (args) => {
      ipc
        .channel()
        .capture(args.onEvent)
        .sendRaw(JSON.stringify({ kind: "open" }));
      return "ws-conn-fixture";
    })
    .handle("ws_send", () => null)
    .handle("ws_close", () => null)

    // ── grpc (native tonic): reflection returns a small schema; a unary
    // send returns an OK response. Satisfies the gRPC console when a test drives it. ──
    .handle("grpc_reflect", () => ({
      services: [{ name: "greeter.Greeter", methods: [{ name: "SayHello" }] }],
    }))
    .handle("grpc_send", () => ({
      message: '{"greeting":"hi"}',
      statusCode: 0,
      statusName: "OK",
      error: null,
    }))

    // ── git: WorkspaceTree mounts `startGitPolling()`, so EVERY
    // full-App render issues `git_status` per workspace root. A clean empty repo
    // keeps the tree undecorated and the poll on the happy path — without this
    // stub every render leaned on gitStore's reject-then-catch (code "unknown",
    // backoff), which passed but was standing noise. `gh_prs` and `url_open` are
    // surface-completion: the smoke never drives the PR list. ──
    .handle("git_status", (args) => ({
      root: String(args.root),
      branch: "main",
      changes: [],
    }))
    .handle("gh_prs", () => [])
    .handle("url_open", () => null)
    // Compare/revert. Inert on purpose: no smoke flow drives the
    // tree's Git submenu, so these exist so that a stray Compare (or a future
    // flow that opens a diff tab) meets a well-formed answer instead of the
    // "unmocked command" throw. `unchanged: true` is the calm end state — the
    // diff tab renders "No changes" and mounts no MergeView. `git_file_restore`
    // is a no-op: this tier has no working tree to put anything back into.
    .handle("git_file_diff", (args) => ({
      path: String(args.path),
      relative: String(args.path),
      head: null,
      working: null,
      unchanged: true,
      binary: false,
    }))
    .handle("git_file_restore", () => null)

    // ── lsp (insurance: fixtures are markdown, so this is never called) ──
    .handle("lsp_start", (args): LspServerMeta => ({
      serverId: "",
      languageId: String(args.languageId ?? "markdown"),
      status: "unavailable",
      installHint: "no server in the mock backend",
    }))
    .handle("lsp_send", () => null)
    .handle("lsp_stop", () => null)

    // ── usage strip ──
    // The rail's footer polls this on mount, so EVERY <App/> render in this tier
    // reaches it. Handled with a canned reading rather than left to reject: an
    // unhandled command would put the strip in its error state, which is a
    // perfectly valid state but not the one a layout assertion wants to measure.
    .handle("claude_usage", () => CANNED_USAGE)

    // ── context window (Metrics card) ──
    // Read when the Metrics tab is open with a root agent selected; args are
    // `{ agentId }` (Rust resolves the session + cwd). Canned for the same
    // reason as `claude_usage`: the error state is valid but not what a layout
    // assertion wants to measure.
    .handle("context_usage", () => CANNED_CONTEXT_USAGE);

  // Seed the workspace root — the write `startBridge` would make from
  // `default_workspace`. Everything else the smoke-core flows need follows.
  act(() => {
    useAppStore.getState().workspaceActions.setWorkspaceRoot(FIXTURE_ROOT);
  });

  return {
    ipc,
    ptys,
    lastHttpRequest: () =>
      (ipc.lastCall("http_send")?.request as HttpRequest | undefined) ?? null,
    setHttpResponse: (response) => {
      httpResponse = response;
    },
  };
}

/**
 * Reset every module-level singleton this tier touches, so each `it` starts from
 * the app's boot state. Call from `beforeEach` BEFORE {@link installE2EHarness}.
 */
export function resetE2E(): void {
  disposeTerminals(); // tear down xterm instances + their (mocked) PTYs
  disposeEditors(); // tear down CodeMirror views
  resetClients(); // drop the LSP client cache
  resetStore(); // layout / tabs / workspace / editor / api slices
  resetFleetStore(); // agents / roots / selection / tombstones + the row memo
  resetContextStore(); // per-session context readings + their in-flight/status plumbing
}

/** Tear the harness down. Call from `afterEach`. */
export function teardownE2E(ipc: TauriMock): void {
  disposeTerminals();
  disposeEditors();
  resetClients();
  ipc.reset();
}

/**
 * Let the terminal lifecycle settle: xterm's `scheduleOpen` fires on a
 * `setTimeout(0)` and its auto-focus on a `requestAnimationFrame`, so a
 * terminal-spawning click needs one macrotask + one frame before the PTY
 * command has been dispatched. Wrapped in `act` so React flushes cleanly.
 */
export async function settle(ms = 120): Promise<void> {
  await act(async () => {
    const deadline = performance.now() + ms;
    while (performance.now() < deadline) {
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
    }
    await new Promise<void>((r) => setTimeout(r, 0));
  });
}
