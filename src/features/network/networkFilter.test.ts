/**
 * The filter language. Table-driven, but every row's expectation is a hand-written list of
 * which fixture flows should survive — never derived from the parser.
 */

import { describe, expect, it } from "vitest";

import {
  AI_PROVIDERS,
  hiddenBy,
  isAiProviderCall,
  isAiProviderHost,
  matchesChips,
  matchesFilter,
  parseFilter,
  type ProtoChip,
} from "./networkFilter";
import type { FlowSummary } from "./networkTypes";

function flow(id: number, o: Partial<FlowSummary>): FlowSummary {
  return {
    id,
    startedMs: 0,
    proto: "https",
    method: "GET",
    host: "example.com",
    port: 443,
    path: "/",
    status: 200,
    grpcStatus: null,
    contentType: null,
    reqBytes: 0,
    resBytes: 0,
    durationMs: 1,
    state: "done",
    error: null,
    terminalId: null,
    httpVersion: "HTTP/1.1",
    wsMessages: null,
    client: null,
    note: null,
    ...o,
  };
}

// Named fixtures: A..G. Expectations below are lists of these letters.
const FLOWS: Record<string, FlowSummary> = {
  A: flow(1, { host: "staging.api.acme.test", path: "/bookings/widgets/wgt_1", method: "POST", status: 502 }),
  B: flow(2, { host: "api.anthropic.com", path: "/v1/messages", method: "POST", status: 200 }),
  C: flow(3, { host: "registry.npmjs.org", path: "/react", status: 404, proto: "http", port: 80 }),
  D: flow(4, { proto: "grpc", host: "grpc.local", path: "/pkg.Svc/Get", status: 200 }),
  E: flow(5, { proto: "tunnel", method: "CONNECT", host: "github.com", path: "", status: null }),
  F: flow(6, { proto: "wss", host: "ws.example.com", path: "/socket", status: 101 }),
  G: flow(7, { host: "api.anthropic.com", path: "/v1/pending", status: null, state: "pending", durationMs: null, method: "DELETE" }),
};

const survivors = (q: string): string[] => {
  const f = parseFilter(q);
  return Object.entries(FLOWS)
    .filter(([, v]) => matchesFilter(v, f))
    .map(([k]) => k);
};

describe("matchesFilter", () => {
  it.each([
    ["", ["A", "B", "C", "D", "E", "F", "G"]],
    ["   ", ["A", "B", "C", "D", "E", "F", "G"]],
    ["anthropic", ["B", "G"]],
    ["ANTHROPIC", ["B", "G"]],
    ["/v1", ["B", "G"]],
    ["post", ["A", "B"]],
    ["502", ["A"]],
    ["40", ["C"]],
    ["anthropic messages", ["B"]],
    ["status:5xx", ["A"]],
    ["status:2xx", ["B", "D"]],
    ["status:1xx", ["F"]],
    ["status:404", ["C"]],
    ["status:4xx status:5xx", ["A", "C"]],
    ["proto:grpc", ["D"]],
    ["proto:http", ["A", "B", "C", "G"]],
    ["proto:https", ["A", "B", "G"]],
    ["proto:ws", ["F"]],
    ["proto:tunnel", ["E"]],
    ["method:post", ["A", "B"]],
    ["method:DELETE", ["G"]],
    ["method:connect", ["E"]],
    ["host:api", ["A", "B", "G"]],
    ["host:API.ANTHROPIC", ["B", "G"]],
    ["method:post status:2xx", ["B"]],
    ["host:anthropic pending", ["G"]],
    ["github.com:443", []],
    ["status:abc", ["A", "B", "C", "D", "E", "F", "G"]],
    ["status:", ["A", "B", "C", "D", "E", "F", "G"]],
    ["nomatch", []],
  ])("%j keeps %j", (q, expected) => expect(survivors(q)).toEqual(expected));
});

describe("parseFilter", () => {
  it("reports unreadable tokens instead of silently hiding every row", () => {
    expect(parseFilter("status:abc status:600 host: foo").invalid).toEqual(["status:abc", "status:600", "host:"]);
    expect(parseFilter("foo").text).toEqual(["foo"]);
  });

  it("a colon in a word is not a key (host:port pasted from a tunnel row)", () => {
    const f = parseFilter("github.com:443");
    expect(f.text).toEqual(["github.com:443"]);
    expect(f.host).toEqual([]);
  });

  it("status values parse to class vs exact", () => {
    expect(parseFilter("status:5xx status:404").status).toEqual([
      { kind: "class", digit: 5 },
      { kind: "exact", code: 404 },
    ]);
  });
});

describe("matchesChips", () => {
  const keep = (chips: ProtoChip[]) =>
    Object.entries(FLOWS)
      .filter(([, v]) => matchesChips(v, chips))
      .map(([k]) => k);

  it.each([
    [[], ["A", "B", "C", "D", "E", "F", "G"]],
    [["http"], ["A", "B", "C", "G"]],
    [["ws"], ["F"]],
    [["grpc"], ["D"]],
    [["tunnel"], ["E"]],
    [["grpc", "tunnel"], ["D", "E"]],
  ] as [ProtoChip[], string[]][])("%j keeps %j", (chips, expected) => expect(keep(chips)).toEqual(expected));
});

describe("hiddenBy — each ACTIVE control's own count; an inactive one is null", () => {
  const all = Object.values(FLOWS);
  const none = { source: null, process: null, host: null };

  it("nothing active: every entry null", () => {
    expect(hiddenBy(all, [], "  ", none)).toEqual({
      chips: null,
      text: null,
      source: null,
      process: null,
      host: null,
      app: null,
      ai: null,
    });
  });

  it("chips count per family; text counts the misses; each picker counts what IT alone excludes", () => {
    const onlyAnthropic = (f: FlowSummary) => f.host === "api.anthropic.com";
    expect(hiddenBy(all, ["http"], "status:2xx", { source: (f) => f.id === 1, process: null, host: onlyAnthropic })).toEqual({
      chips: { count: 3, families: { http: 0, ws: 1, grpc: 1, tunnel: 1 } },
      text: 5, // B and D are 2xx
      source: 6,
      process: null,
      host: 5, // B and G
      app: null,
      ai: null,
    });
  });

  it("Hide AI providers counts an agent CLI's own provider requests — none among these fixtures", () => {
    expect(hiddenBy(all, [], "", none, true).ai).toBe(0);
    const claude = { pid: 9, name: "claude", path: "/u/.local/share/claude/versions/2.1.212" };
    const codex = { pid: 10, name: "codex", path: "/u/.local/bin/codex" };
    const withClis = [...all, flow(8, { host: "api.anthropic.com", client: claude }), flow(9, { host: "api.openai.com", client: codex })];
    expect(hiddenBy(withClis, [], "", none, true).ai).toBe(2);
    expect(hiddenBy(withClis, [], "", none).ai).toBeNull();
  });

  it("the Apps sidebar's picks count what they alone exclude", () => {
    const why = hiddenBy(all, [], "", { source: null, process: null, host: null, app: (f) => f.id === 1 });
    expect(why.app).toBe(6);
    expect(why.source).toBeNull();
  });

  it("the host picker's count is independent of the text filter's `host:` token — both are reported", () => {
    const why = hiddenBy(all, [], "host:example", { source: null, process: null, host: (f) => f.host === "github.com" });
    expect(why.text).toBe(6); // only F's host carries "example"
    expect(why.host).toBe(6); // only E is github.com
  });
});

describe("isAiProviderHost", () => {
  it.each([
    ["api.anthropic.com", true],
    ["API.Anthropic.COM", true],
    ["statsig.anthropic.com", true],
    ["anthropic.com", true],
    ["anthropic.com.", true],
    ["claude.ai", true],
    ["console.claude.ai", true],
    ["claude.com", true],
    ["api.openai.com", true],
    ["chatgpt.com", true],
    ["my-team.openai.azure.com", true],
    ["generativelanguage.googleapis.com", true],
    ["api.mistral.ai", true],
    ["api.x.ai", true],
    ["openrouter.ai", true],
    ["api.githubcopilot.com", true],
    // Look-alikes and neighbours are not providers.
    ["notanthropic.com", false],
    ["anthropic.com.evil.net", false],
    ["myclaude.ai", false],
    ["notopenai.com", false],
    ["box.ai", false], // ends in "x.ai" but is not under it
    ["storage.googleapis.com", false], // another Google API
    ["example.com", false],
    ["", false],
  ])("%s → %s", (host, want) => {
    expect(isAiProviderHost(host)).toBe(want);
  });

  it("every listed domain of every provider, and a subdomain of it, is a provider host", () => {
    for (const { domains } of AI_PROVIDERS) {
      for (const d of domains) {
        expect(isAiProviderHost(d), d).toBe(true);
        expect(isAiProviderHost(`api.${d}`), `api.${d}`).toBe(true);
      }
    }
  });
});

describe("isAiProviderCall — an agent CLI's own calls, never an agent's command", () => {
  const claude = { pid: 9, name: "claude", path: "/Users/dev/.local/share/claude/versions/2.1.212" };
  const claudeWin = { pid: 9, name: "claude", path: String.raw`C:\Users\dev\.local\bin\claude.exe` };
  const codex = { pid: 12, name: "codex", path: "/Users/dev/.local/bin/codex" };
  const curl = { pid: 10, name: "curl", path: "/usr/bin/curl" };
  const node = { pid: 11, name: "node", path: "/usr/local/bin/node" };
  it.each<[string, Partial<FlowSummary>, boolean]>([
    ["the native CLI → api.anthropic.com (decrypted)", { host: "api.anthropic.com", client: claude }, true],
    ["the CLI on Windows", { host: "api.anthropic.com", client: claudeWin }, true],
    ["the CLI's tunnel (not decrypted)", { proto: "tunnel", method: "CONNECT", host: "api.anthropic.com", path: "", client: claude }, true],
    ["the CLI's telemetry host", { host: "statsig.anthropic.com", client: claude }, true],
    ["the CLI's MCP proxy", { host: "mcp-proxy.anthropic.com", path: "/v1/mcp/srv_1", client: claude }, true],
    ["the CLI's downloads", { host: "downloads.claude.ai", path: "/claude-code-releases/latest", client: claude }, true],
    ["the CLI's Datadog telemetry", { host: "http-intake.logs.us5.datadoghq.com", client: claude }, true],
    ["the CLI's changelog check", { host: "raw.githubusercontent.com", path: "/anthropics/claude-code/refs/heads/main/CHANGELOG.md", client: claude }, true],
    ["Codex → OpenAI", { host: "api.openai.com", path: "/v1/responses", client: codex }, true],
    ["Codex's changelog check", { host: "raw.githubusercontent.com", path: "/openai/codex/main/CHANGELOG.md", client: codex }, true],
    ["a name in another case", { host: "api.anthropic.com", client: { ...claude, name: "Claude" } }, true],
    ["an agent's curl to Anthropic stays", { host: "api.anthropic.com", client: curl }, false],
    ["an agent's curl to OpenAI stays", { host: "api.openai.com", client: curl }, false],
    ["a node app calling a provider stays (npm installs are not recognised)", { host: "api.openai.com", client: node }, false],
    ["an app's own Datadog calls stay", { host: "http-intake.logs.us5.datadoghq.com", client: node }, false],
    ["an unattributed request stays", { host: "api.anthropic.com", client: null }, false],
    ["the CLI calling elsewhere stays", { host: "registry.npmjs.org", client: claude }, false],
    ["the CLI reading another GitHub raw file stays", { host: "raw.githubusercontent.com", path: "/someone/repo/main/README.md", client: claude }, false],
    ["an org whose name only starts like one stays", { host: "raw.githubusercontent.com", path: "/openai-fan/repo/main/README.md", client: claude }, false],
    ["a bypass row is an agent's command", { proto: "bypass", host: "api.anthropic.com", client: claude }, false],
  ])("%s", (_name, o, want) => {
    expect(isAiProviderCall(flow(1, o))).toBe(want);
  });
});
