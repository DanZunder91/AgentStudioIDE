/**
 * SEAM TEST — Agent Logs view. Not a unit test.
 *
 * The lines fed in here were produced by REAL Rust: the supervisor over real PTYs (`/bin/sh`
 * output, lifecycle, agent session lines) and the real `ClaudeAdapter` + `TranscriptToolTail`
 * over the checked-in transcript fixture, stamped by a real `LogHub` and serialised as
 * `logstream_snapshot` / `logstream://lines` would (`src-tauri/tests/contract_goldens.rs`).
 * Only `invoke` and `listen` are mocked, answering with that golden JSON; `logstreamIpc` →
 * `agentLogsStore` (snapshot + event ingest) → `AgentLogsPanel` are the real ones.
 *
 * What the view makes of them: the shell's and the service's lines render RAW,
 * the agents' tool calls pair with their results by `toolUseId` into command blocks headed
 * `$ …`, and the lifecycle lines are dividers. The service's `gazelle · bg`
 * reads `gazelle` with a `service` tag everywhere, a solo shows a stream header instead of
 * hiding the Source column, and a block's output rows repeat its time/level/source dimmed.
 * Expected strings are written by hand, never derived from the golden.
 */

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => {
  const state = {
    snapshot: [] as unknown[],
    handler: null as null | ((e: { payload: unknown }) => void),
  };
  const invoke = vi.fn((cmd: string) => {
    if (cmd === "logstream_snapshot") return Promise.resolve(state.snapshot);
    // syslog_* have their own seam test: syslog.contract.test.tsx.
    return Promise.reject(new Error(`not part of this contract test: ${cmd}`));
  });
  const listen = vi.fn((name: string, cb: (e: { payload: unknown }) => void) => {
    if (name === "logstream://lines") state.handler = cb;
    return Promise.resolve(() => {});
  });
  return { state, invoke, listen };
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: tauri.listen }));
vi.mock("../../features/terminal", () => ({ configureTerminal: vi.fn(), dispose: vi.fn() }));

import { useAppStore } from "../../app/store";
import type { TabId } from "../../app/types";
import { useColumnLayoutStore } from "../../components/columns";
import { AgentLogsPanel } from "../../features/agentlogs/AgentLogsPanel";
import { resetAgentLogsForTests, useAgentLogsStore } from "../../features/agentlogs/agentLogsStore";
import type { LogLine } from "../../features/agentlogs/agentLogsTypes";
import { resetStore } from "../store-harness";
import { LINES } from "./goldens";

const settle = () =>
  act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });

async function mount(snapshot: LogLine[]): Promise<void> {
  tauri.state.snapshot = snapshot;
  render(<AgentLogsPanel />);
  await settle();
}

function emit(lines: LogLine[]): void {
  const h = tauri.state.handler;
  if (!h) throw new Error("the store never subscribed to logstream://lines");
  act(() => h({ payload: lines }));
}

const ENTRY = '[data-testid="alog-row"], [data-testid="alog-divider"], [data-testid="alog-block-head"]';
/** Every stream entry's line id, in order: raw rows, dividers, block headers (never a result). */
const shown = () => [...document.querySelectorAll<HTMLElement>(ENTRY)].map((r) => Number(r.dataset.id));
const rows = () => screen.queryAllByTestId("alog-row");
const rowById = (id: number) => document.querySelector(`[data-testid="alog-row"][data-id="${id}"]`) as HTMLElement;
const dividerById = (id: number) => document.querySelector(`[data-testid="alog-divider"][data-id="${id}"]`) as HTMLElement;
const headById = (id: number) => document.querySelector(`[data-testid="alog-block-head"][data-id="${id}"]`) as HTMLElement;
const textOf = (id: number) => (rowById(id).querySelector(".alog-text") as HTMLElement).textContent;
const badgeOf = (id: number) => (rowById(id).querySelector(".alog-badge") as HTMLElement).textContent;
/** The source cell's NAME — its text nodes, without the `service` tag span. */
const nameIn = (el: Element) => [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join("");
const sourceOf = (id: number) => nameIn(rowById(id).querySelector(".alog-src") as HTMLElement);
const tagOf = (id: number) => rowById(id).querySelector(".alog-src .alog-tag")?.textContent ?? null;
const outputsOf = (key: string) =>
  [...document.querySelectorAll<HTMLElement>(`[data-testid="alog-block-out"][data-key="${key}"]`)].map(
    (o) => (o.querySelector(".alog-block__outtext") as HTMLElement).textContent,
  );

/** `HH:MM:SS.mmm`, local — the time column. */
function clock(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

beforeEach(() => {
  resetAgentLogsForTests();
  resetStore();
  // The column layout is a module-level store too: a test that hides Source must not leak it.
  useColumnLayoutStore.setState({ layouts: {} });
  tauri.state.snapshot = [];
  tauri.state.handler = null;
  vi.clearAllMocks();
});
afterEach(() => resetAgentLogsForTests());

/* Which golden ids are what: raw rows = the shell's output (2–6) and gazelle's own log (27–30);
   dividers = lifecycle (1, 7–11, 25, 26, 31); blocks = each tool call (12, 14, 16, 17, 20, 21, 23)
   with its result (13, 15, 19, 18, —, 22, 24) nested under it. A result is never an entry. */
const RAW = [2, 3, 4, 5, 6, 27, 28, 29, 30];
const DIVIDERS = [1, 7, 8, 9, 10, 11, 25, 26, 31];
const BLOCKS = [12, 14, 16, 17, 20, 21, 23];
const ALL_ENTRIES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16, 17, 20, 21, 23, 25, 26, 27, 28, 29, 30, 31];

describe("every golden line renders as the user sees it", () => {
  it("31 lines become 25 entries in id order: 9 raw rows, 9 dividers, 7 command blocks — the 6 results are nested, never rows", async () => {
    await mount(LINES);
    expect(shown()).toEqual(ALL_ENTRIES);
    expect(rows().map((r) => Number(r.dataset.id))).toEqual(RAW);
    expect(screen.getAllByTestId("alog-divider").map((d) => Number(d.dataset.id))).toEqual(DIVIDERS);
    expect(screen.getAllByTestId("alog-block-head").map((h) => Number(h.dataset.id))).toEqual(BLOCKS);
    for (const id of [13, 15, 18, 19, 22, 24]) expect(document.querySelector(`[data-id="${id}"]`), `result ${id}`).toBeNull();
    expect(screen.getByText("31 lines")).toBeInTheDocument();
  });

  it("raw rows: the shell's lines and gazelle's own log, `time  LEVEL  source  text` with no marker; the service reads `gazelle` + a tag", async () => {
    await mount(LINES);
    // [id, badge, source NAME as read, its tag, text as rendered]
    const want: [number, string, string, string | null, string][] = [
      [2, "I", "sh · proj", null, "hello-42"],
      [3, "E", "sh · proj", null, "error: red"], // ANSI stripped by Rust, then the level heuristic
      [4, "W", "sh · proj", null, "warning: flag --x is deprecated"],
      [5, "I", "sh · proj", null, "progress 100%"], // `\r` — last write wins
      [6, "D", "sh · proj", null, "DEBUG cache hit"],
      // Background tasks: the tailed output, raw. Rust's `gazelle · bg`
      // is shown as `gazelle` with a `service` tag; the key stays the wire label.
      [27, "I", "gazelle", "service", "2026-01-01T12:00:05.101Z  INFO gazelle: starting, config=/work/gazelle/.env"],
      [28, "I", "gazelle", "service", "2026-01-01T12:00:05.152Z  INFO gazelle: listening on 0.0.0.0:8080"],
      // The level column (WARN) beats the word "error" later in the line.
      [29, "W", "gazelle", "service", "2026-01-01T12:00:05.160Z  WARN gazelle::upstream: geo key missing, error budget unaffected"],
      [30, "E", "gazelle", "service", "2026-01-01T12:00:06.001Z ERROR gazelle::api: upstream closed the connection"],
    ];
    for (const [id, badge, source, tag, text] of want) {
      expect([badgeOf(id), sourceOf(id), tagOf(id), textOf(id)], `line ${id}`).toEqual([badge, source, tag, text]);
    }
    expect(rowById(28).dataset.source).toBe("gazelle · bg");
    expect(rowById(2).className).toContain("alog-row--kind-output");
    expect(rowById(28).className).toContain("alog-row--kind-task");
    expect(rowById(4).className).toContain("alog-row--warn");
    expect(rowById(6).className).toContain("alog-row--debug");
    expect(rowById(30).className).toContain("alog-row--error");
  });

  it("dividers: every lifecycle line, centred, with its time and (while the Source column shows) its source; the level colours it", async () => {
    await mount(LINES);
    // [id, source name as read, its tag, text]
    const want: [number, string, string, string][] = [
      [1, "sh · proj", "", "terminal opened · sh in /work/proj"],
      [7, "sh · proj", "", "terminal exited (code 3)"],
      [8, "sh · proj (2)", "", "terminal opened · sh in /work/proj"],
      [9, "stub · proj", "", "agent started · stub-runtime in /work/proj"],
      [10, "stub · proj", "", "agent session ended"],
      [11, "sh · proj (2)", "", "terminal closed"],
      [25, "gazelle", "service", "background task started · gazelle (bgen1a2b3)"],
      [26, "tail", "service", "background task started · tail (bmon4c5d6)"],
      [31, "gazelle", "service", "background task stopped · gazelle (bgen1a2b3) — stopped by the agent"],
    ];
    for (const [id, source, tag, text] of want) {
      const d = dividerById(id);
      expect(nameIn(d.querySelector(".alog-divider__src") as HTMLElement), `divider ${id}`).toBe(source);
      expect(d.querySelector(".alog-divider__src .alog-tag")?.textContent ?? "", `divider ${id}`).toBe(tag);
      expect(d.querySelector(".alog-divider__text")?.textContent, `divider ${id}`).toBe(`${clock(LINES[id - 1].tsMs)}${source}${tag}${text}`);
      expect(d.querySelector(".alog-badge"), `divider ${id} has no badge`).toBeNull();
    }
    expect(dividerById(7).className).toContain("alog-divider--warn");
    expect(dividerById(1).className).toContain("alog-divider--info");
  });

  it("command blocks: each call headed `$ …` / `Tool …` (description first when there is one), its result's output nested — paired by id, so the Agent's late `done` is the Agent's", async () => {
    await mount(LINES);
    // [anchor id, block key, header label, description (shown FIRST, bold), failed, output lines]
    const want: [number, string, string, string | null, boolean, string[]][] = [
      [12, "toolu_log_01", "$ cargo test --lib", "Run the unit tests", false, ["running 3 tests", "test a ... ok", "test result: ok"]],
      [14, "toolu_log_02", "Read /work/proj/src/lib.rs", null, false, ["fn main() {}"]],
      // Its result (19) lands AFTER the WebFetch call and its 404: the id says whose it is.
      [16, "toolu_log_03", "Agent Explore the parser", null, false, ["done"]],
      [17, "toolu_log_04", "WebFetch https://example.test/doc", null, true, ["Request failed with status 404"]],
      [20, "toolu_log_05", "TodoWrite", null, false, []], // no result: pending
      [21, "toolu_sub_01", 'Grep "fn parse"', null, false, ["src/a.rs:1:fn parse()"]],
      [23, "toolu_sub_02", "Edit /work/proj/src/a.rs", null, false, ["The file has been updated"]],
    ];
    for (const [id, key, label, desc, failed, output] of want) {
      const h = headById(id);
      expect(h.dataset.key, `block ${id}`).toBe(key);
      expect(h.querySelector(".alog-block__label")?.textContent, `block ${id}`).toBe(label);
      expect(h.querySelector(".alog-block__desc")?.textContent ?? null, `block ${id}`).toBe(desc);
      // With a description the command follows it, dimmed; without one the command leads, bold.
      expect(h.querySelector(".alog-block__label")?.classList.contains("alog-block__label--after"), `block ${id}`).toBe(desc !== null);
      expect(h.dataset.error, `block ${id}`).toBe(String(failed));
      expect(outputsOf(key), `block ${id}`).toEqual(output);
    }
    // The Bash block's description comes before its command in the DOM (read left to right).
    const cmd = headById(12).querySelector(".alog-block__cmd") as HTMLElement;
    expect([...cmd.children].map((c) => c.className)).toEqual(["alog-block__desc", "alog-block__label alog-block__label--after"]);
    // No golden block names a file a service tails: no "→ open … stream" link anywhere
    // (the paths ARE known — see the background-tasks block below — so this is two-sided).
    expect(screen.queryByTestId("alog-block-stream")).toBeNull();
    // The invocation line Rust puts first in every result's detail is not repeated as output.
    for (const out of document.querySelectorAll('[data-testid="alog-block-out"] .alog-block__outtext')) {
      expect(out.textContent).not.toMatch(/^\$ |^[A-Z][a-z]+: /);
    }
    expect(headById(17).className).toContain("alog-block__head--error");
    expect(within(headById(17)).getByText("E")).toHaveClass("alog-badge--error");
    expect(headById(20).className).toContain("alog-block__head--pending");
    // No block folds: the longest output is three lines.
    expect(screen.queryByTestId("alog-block-more")).toBeNull();
  });

  it("times: output lines at the hub's stamp, a block at its call's transcript timestamp, a divider's in its text", async () => {
    await mount(LINES);
    const time = (el: HTMLElement) => (el.querySelector(".alog-time") as HTMLElement).textContent;
    expect(time(dividerById(1))).toBe(clock(Date.UTC(2026, 8, 24, 12, 0, 0, 0)));
    expect(time(rowById(3))).toBe(clock(Date.UTC(2026, 8, 24, 12, 0, 0, 500)));
    // Fixture: `"timestamp": "2026-09-20T10:00:01.000Z"` on the Bash tool_use.
    expect(time(headById(12))).toBe(clock(Date.UTC(2026, 8, 20, 10, 0, 1, 0)));
  });

  it("a block's output rows repeat the call's time and source, dimmed — never blank — and carry each line's OWN level", async () => {
    await mount(LINES);
    const cells = (o: Element) => [
      o.querySelector(".alog-time")?.textContent,
      o.querySelector(".alog-badge")?.textContent,
      nameIn(o.querySelector(".alog-src") as HTMLElement),
      o.querySelectorAll(".alog-cell--dim").length,
      o.querySelectorAll(".alog-cell--blank").length,
    ];
    const bash = [...document.querySelectorAll<HTMLElement>('[data-testid="alog-block-out"][data-key="toolu_log_01"]')];
    expect(bash).toHaveLength(3);
    // Time and Source dim (2 cells); the Level is the line's own and is not dimmed.
    for (const o of bash) expect(cells(o)).toEqual([clock(Date.UTC(2026, 8, 20, 10, 0, 1, 0)), "I", "claude · proj", 2, 0]);
    // The failed WebFetch: `Request failed with status 404` holds no level word (lowercase
    // "failed" is not one), so the LINE is I — the failure is told by the failed block's red
    // rule and red header, not by the line's badge.
    const [fetch] = document.querySelectorAll<HTMLElement>('[data-testid="alog-block-out"][data-key="toolu_log_04"]');
    expect(fetch.querySelector(".alog-block__outtext")).toHaveTextContent("Request failed with status 404");
    expect(cells(fetch)).toEqual([clock(LINES[16].tsMs), "I", "claude · proj", 2, 0]);
    expect(fetch).toHaveClass("alog-block__out--error");
    expect(headById(17)).toHaveAttribute("data-error", "true");
  });

  it("clicking a block header opens the call AND its result in the drawer; a call without detail shows only the result", async () => {
    await mount(LINES);
    fireEvent.click(headById(12));
    let detail = screen.getByTestId("alog-detail");
    expect(within(detail).getByText("tool")).toBeInTheDocument();
    expect(detail.querySelector(".alog-detail__text")).toHaveTextContent("Bash: cargo test --lib");
    expect(detail.querySelector(".alog-detail__more")).toHaveTextContent("Run the unit tests");
    // The result, as Rust sent it: `$ <command>`, a blank line, then the output.
    expect(within(screen.getByTestId("alog-detail-result")).getByText("tool-result")).toBeInTheDocument();
    expect((detail.querySelector(".alog-detail__result") as HTMLElement).textContent).toBe(
      "$ cargo test --lib\n\nrunning 3 tests\ntest a ... ok\ntest result: ok",
    );

    fireEvent.click(headById(14));
    detail = screen.getByTestId("alog-detail");
    expect(detail.querySelector(".alog-detail__more")).toBeNull();
    expect((detail.querySelector(".alog-detail__result") as HTMLElement).textContent).toBe("Read: /work/proj/src/lib.rs\n\nfn main() {}");

    // A pending call: no result section.
    fireEvent.click(headById(20));
    expect(screen.queryByTestId("alog-detail-result")).toBeNull();
  });
});

describe("background tasks: what the service an agent started logged, raw", () => {
  it("task rows carry the task kind class and read `<program>` + `service` (the wire's ` · bg` is the key, not the name); the announce divider opens the command + output path", async () => {
    await mount(LINES);
    expect(rowById(28).className).toContain("alog-row--kind-task");
    expect(rowById(28).textContent).not.toContain("⚙");
    expect(sourceOf(28)).toBe("gazelle");
    expect(tagOf(28)).toBe("service");
    expect(rowById(28).textContent).not.toContain(" · bg");
    fireEvent.click(dividerById(25));
    const detail = screen.getByTestId("alog-detail");
    expect(within(detail).getByText("system")).toBeInTheDocument();
    expect((detail.querySelector(".alog-detail__more") as HTMLElement).textContent).toBe(
      "cd /work/gazelle && RUST_LOG=info ./target/debug/gazelle serve\n" +
        "/private/tmp/claude-501/-work-gazelle/sess/tasks/bgen1a2b3.output",
    );
    // A task line's own drawer shows the same command + path.
    fireEvent.click(rowById(28));
    expect((screen.getByTestId("alog-detail").querySelector(".alog-detail__more") as HTMLElement).textContent).toBe(
      "cd /work/gazelle && RUST_LOG=info ./target/debug/gazelle serve\n" +
        "/private/tmp/claude-501/-work-gazelle/sess/tasks/bgen1a2b3.output",
    );
  });
});

describe("the Sources sidebar over the real lines", () => {
  const sideRows = () =>
    screen.getAllByTestId("alog-src-row").map((c) => {
      const errs = c.querySelector('[data-testid="alog-src-errors"]')?.textContent;
      const count = c.querySelector('[data-testid="alog-src-count"]')?.textContent;
      return `${c.dataset.group} ${c.dataset.running === "true" ? "●" : "○"} ${c.dataset.source} ${count}${errs ? ` !${errs}` : ""}`;
    });
  const sideRow = (source: string) =>
    within(screen.getAllByTestId("alog-src-row").find((c) => c.dataset.source === source) as HTMLElement);
  const groups = () => screen.getAllByTestId("alog-src-group").map((g) => g.getAttribute("aria-label"));

  it("Services · Terminals · Agents; running first (in the order they appeared), then stopped; line and error counts", async () => {
    await mount(LINES);
    expect(groups()).toEqual(["Services", "Terminals", "Agents"]);
    expect(sideRows()).toEqual([
      "task ● tail · bg 1", // started, never stopped
      "task ○ gazelle · bg 6 !1", // started → 4 task lines → stopped by the agent
      // The first shell exited but its terminal stayed open, so the second one in the same folder
      // is its own source, `sh · proj (2)` (LogHub::tap). Stopped rows: most recently
      // stopped first, so the second shell (closed at line 11) precedes the first (exited at 7).
      "terminal ○ sh · proj (2) 2", // opened → closed
      "terminal ○ sh · proj 7 !1", // opened → 5 output lines → exited (3)
      "agent ● claude · proj 9 !1", // tool calls, no lifecycle line → an agent at work; the 404 is its error
      "agent ● sublog01 4",
      "agent ○ stub · proj 2", // agent started → session ended
    ]);
    expect(screen.getByTestId("alog-src-all")).toHaveTextContent("All31");
  });

  it("each stopped row carries its reason; a task's carries its command", async () => {
    await mount(LINES);
    const title = (source: string) => sideRow(source).getAllByRole("button")[0].getAttribute("title") as string;
    expect(title("gazelle · bg")).toMatch(/^gazelle · Service, stopped .+ — stopped by the agent\n6 lines, 1 error\n/);
    expect(title("gazelle · bg")).toContain("cd /work/gazelle && RUST_LOG=info ./target/debug/gazelle serve");
    expect(title("sh · proj")).toMatch(/Terminal, stopped .+ — exited \(code 3\)\n/);
    expect(title("sh · proj (2)")).toMatch(/Terminal, stopped .+ — closed\n/);
    expect(title("stub · proj")).toMatch(/Agent, stopped .+ — session ended\n/);
    expect(title("tail · bg")).toMatch(/^tail · Service, running — started /);
  });

  it("display names: Services is the first group; its rows read `gazelle` / `tail` with a `service` tag and no ` · bg`; the running one is emphasised", async () => {
    await mount(LINES);
    expect(screen.getAllByTestId("alog-src-group")[0]).toHaveAttribute("aria-label", "Services");
    const names = () =>
      screen.getAllByTestId("alog-src-row").map((c) => [
        c.dataset.source,
        (c.querySelector(".alog-side__name") as HTMLElement).textContent,
        c.querySelector('[data-testid="alog-src-tag"]')?.textContent ?? null,
        c.classList.contains("alog-side__row--emph"),
      ]);
    expect(names()).toEqual([
      ["tail · bg", "tail", "service", true], // running: emphasised
      ["gazelle · bg", "gazelle", "service", false], // stopped
      ["sh · proj (2)", "sh · proj (2)", null, false],
      ["sh · proj", "sh · proj", null, false],
      ["claude · proj", "claude · proj", null, false],
      ["sublog01", "sublog01", null, false],
      ["stub · proj", "stub · proj", null, false],
    ]);
    // The toolbar picker: the same groups in the same order, the same display names.
    fireEvent.click(screen.getByRole("button", { name: "Filter by source" }));
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "All sources",
      "tailServicesOnly",
      "gazelleServicesOnly",
      "sh · proj (2)TerminalsOnly",
      "sh · projTerminalsOnly",
      "claude · projAgentsOnly",
      "sublog01AgentsOnly",
      "stub · projAgentsOnly",
    ]);
  });

  it("the stream arriving in pieces: gazelle is running until its stopped line lands", async () => {
    await mount(LINES.slice(0, 24));
    expect(screen.getAllByTestId("alog-src-row").map((c) => c.dataset.source)).not.toContain("gazelle · bg");
    emit(LINES.slice(24, 30));
    expect(sideRows()).toContain("task ● gazelle · bg 5 !1");
    emit(LINES.slice(30));
    expect(sideRows()).toContain("task ○ gazelle · bg 6 !1");
  });

  it("click gazelle = only gazelle's stream under a stream header; the Source column STAYS (the user's choice); click again = everything", async () => {
    await mount(LINES);
    const headLabels = () => [...screen.getByTestId("alog-head").querySelectorAll(".alog-head__cell")].map((c) => c.textContent);
    expect(screen.queryByTestId("alog-stream-head")).toBeNull();
    fireEvent.click(sideRow("gazelle · bg").getAllByRole("button")[0]);
    expect(shown()).toEqual([25, 27, 28, 29, 30, 31]);
    // No column comes or goes with the selection…
    expect(headLabels()).toEqual(["Time", "Level", "Source", "Text"]);
    expect(sourceOf(28)).toBe("gazelle");
    expect(nameIn(dividerById(25).querySelector(".alog-divider__src") as HTMLElement)).toBe("gazelle");
    // …the stream header says what is selected: name · service · state · counts, over the real lines.
    const head = screen.getByTestId("alog-stream-head");
    expect(head.dataset.source).toBe("gazelle · bg");
    expect(head.querySelector(".alog-stream-head__text")).toHaveTextContent("gazelle · service · ○ stopped · 6 lines · 1 error");
    fireEvent.click(sideRow("gazelle · bg").getAllByRole("button")[0]);
    expect(shown()).toEqual(ALL_ENTRIES);
    expect(headLabels()).toEqual(["Time", "Level", "Source", "Text"]);
    expect(screen.queryByTestId("alog-stream-head")).toBeNull();
    // The running tail service: `● running`. Its header's "All sources" is the way back.
    fireEvent.click(sideRow("tail · bg").getAllByRole("button")[0]);
    expect(screen.getByTestId("alog-stream-head").querySelector(".alog-stream-head__text")).toHaveTextContent("tail · service · ● running · 1 line");
    fireEvent.click(within(screen.getByTestId("alog-stream-head")).getByRole("button", { name: "All sources" }));
    expect(shown()).toEqual(ALL_ENTRIES);
  });

  it("a Source column the user hid under Columns ▾ stays hidden through a solo and back", async () => {
    await mount(LINES);
    const headLabels = () => [...screen.getByTestId("alog-head").querySelectorAll(".alog-head__cell")].map((c) => c.textContent);
    fireEvent.click(screen.getByRole("button", { name: "Columns ▾" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Source" }));
    expect(headLabels()).toEqual(["Time", "Level", "Text"]);
    fireEvent.click(sideRow("gazelle · bg").getAllByRole("button")[0]);
    expect(headLabels()).toEqual(["Time", "Level", "Text"]);
    expect(rowById(28).querySelector(".alog-src")).toBeNull();
    expect(screen.getByTestId("alog-stream-head")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("alog-src-all"));
    expect(headLabels()).toEqual(["Time", "Level", "Text"]);
  });

  it("→ open gazelle stream: a block naming the REAL output path Rust listed for gazelle links to its stream; clicking it solos gazelle", async () => {
    // Constructed (no golden block names a service's file): a Bash call over the path the
    // golden's task lines carry in their detail — `/private/tmp/…/tasks/bgen1a2b3.output`.
    const grep: LogLine = {
      ...LINES[11],
      id: 32,
      toolUseId: "toolu_ctor_01",
      text: "Bash: grep ERROR /private/tmp/claude-501/-work-gazelle/sess/tasks/bgen1a2b3.output | tail -5",
      detail: "Show the service's last errors",
    };
    await mount([...LINES, grep]);
    const head = headById(32);
    expect(head.querySelector(".alog-block__desc")).toHaveTextContent("Show the service's last errors");
    const link = within(head).getByTestId("alog-block-stream");
    expect(link).toHaveTextContent("→ open gazelle stream");
    expect(link).toHaveAttribute("data-source", "gazelle · bg");
    // Every other block is still bare.
    expect(screen.getAllByTestId("alog-block-stream")).toHaveLength(1);
    fireEvent.click(link);
    expect(useAgentLogsStore.getState().filter.onlySources).toEqual(["gazelle · bg"]);
    expect(shown()).toEqual([25, 27, 28, 29, 30, 31]);
    expect(sideRow("gazelle · bg").getAllByRole("button")[0]).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("alog-stream-head").dataset.source).toBe("gazelle · bg");
  });

  it("the error badge jumps to the source's error: gazelle's ERROR line, the agent's failed WebFetch block", async () => {
    await mount(LINES);
    fireEvent.click(sideRow("gazelle · bg").getByTestId("alog-src-errors"));
    // Solo stream [25, 27, 28, 29, 30, 31]: the error (30) is row 4 → 4 × 18 px.
    expect(screen.getByTestId("alog-list").scrollTop).toBe(4 * 18);
    expect(rowById(30).className).toContain("alog-row--target");
    fireEvent.click(sideRow("claude · proj").getByTestId("alog-src-errors"));
    // Solo stream: blocks 12 (4 rows), 14 (2), 16 (2), 17 → header at row 8.
    expect(screen.getByTestId("alog-list").scrollTop).toBe(8 * 18);
    expect(headById(17).className).toContain("alog-row--target");
  });

  it("while a query is active the sidebar counts each source's matches", async () => {
    await mount(LINES);
    fireEvent.change(screen.getByLabelText("Filter log lines"), { target: { value: "work/proj" } });
    const matches = () =>
      screen.getAllByTestId("alog-src-row").map((c) => `${c.dataset.source} ${c.querySelector('[data-testid="alog-src-matches"]')?.textContent}`);
    // sh · proj and sh · proj (2): one `terminal opened · sh in /work/proj` each; stub · proj: `agent started … in /work/proj`;
    // claude · proj: Read (14) + its result's detail (15); sublog01: Edit (23) + its result's detail (24).
    expect(matches()).toEqual(["tail · bg 0", "gazelle · bg 0", "sh · proj (2) 1", "sh · proj 1", "claude · proj 2", "sublog01 2", "stub · proj 1"]);
  });
});

describe("filters over the real values", () => {
  it("there are no kind chips: Tasks / Tools / Output / System are gone from the toolbar", async () => {
    await mount(LINES);
    for (const name of ["Tasks", "Tools", "Output", "System"]) expect(screen.queryByRole("button", { name })).toBeNull();
    expect(screen.queryByRole("group", { name: "Kinds" })).toBeNull();
  });

  it("the text filter searches detail: the Bash description, and a result's output hits show in place", async () => {
    await mount(LINES);
    const box = screen.getByLabelText("Filter log lines");
    const via = () =>
      [...document.querySelectorAll<HTMLElement>(ENTRY)].filter((r) => r.querySelector('[data-testid="alog-via-detail"]')).map((r) => Number(r.dataset.id));
    // Line 12's header reads `$ cargo test --lib`; "unit tests" is only in its description.
    fireEvent.change(box, { target: { value: "unit tests" } });
    expect(shown()).toEqual([12]);
    expect(via()).toEqual([12]);
    // Line 13's last output line: the RESULT matched, so its block (headed by the call) is in,
    // and the matching output row is marked in place.
    fireEvent.change(box, { target: { value: "/^test result: ok$/m" } });
    expect(shown()).toEqual([12]);
    expect([...document.querySelectorAll(".alog-block__out--hit .alog-block__outtext")].map((o) => o.textContent)).toEqual(["test result: ok"]);
    expect(via()).toEqual([]);
    // "cargo test" hits the call's text and (through its `$ cargo test --lib` opening line) the
    // result's detail — still ONE block, not marked as a detail hit.
    fireEvent.change(box, { target: { value: "cargo test" } });
    expect(shown()).toEqual([12]);
    expect(via()).toEqual([]);
    expect(screen.getByText("2 of 31 lines")).toBeInTheDocument();
  });

  it("level chips: Error alone leaves the ANSI-red output line, the failed WebFetch's block and gazelle's ERROR line", async () => {
    await mount(LINES);
    for (const name of ["Warn", "Info", "Debug"]) fireEvent.click(screen.getByRole("button", { name }));
    // Not 29: its level column says WARN, though its text contains "error". The WebFetch
    // block stands at its call (17) although only its result (18) is an error.
    expect(shown()).toEqual([3, 17, 30]);
    expect(headById(17).querySelector(".alog-block__label")).toHaveTextContent("WebFetch https://example.test/doc");
  });
});

describe("snapshot + logstream://lines ingest", () => {
  it("the snapshot, then an event batch appends only ids above the last — a replay is dropped", async () => {
    await mount(LINES.slice(0, 11));
    expect(shown()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    emit(LINES.slice(11));
    expect(shown()).toEqual(ALL_ENTRIES);
    // The whole ring again (e.g. a batch overlapping the snapshot): nothing doubles.
    emit(LINES);
    expect(shown()).toEqual(ALL_ENTRIES);
    expect(useAgentLogsStore.getState().lastId).toBe(31);
    expect(useAgentLogsStore.getState().lines).toHaveLength(31);
  });

  it("a call arriving before its result is pending, then complete — one block throughout", async () => {
    await mount(LINES.slice(0, 12)); // …through the Bash call (12)
    expect(headById(12).className).toContain("alog-block__head--pending");
    expect(outputsOf("toolu_log_01")).toEqual([]);
    emit([LINES[12]]); // its result (13)
    expect(headById(12).className).not.toContain("alog-block__head--pending");
    expect(outputsOf("toolu_log_01")).toEqual(["running 3 tests", "test a ... ok", "test result: ok"]);
    expect(shown()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it("the store keeps each line exactly as Rust sent it", async () => {
    await mount(LINES);
    expect(useAgentLogsStore.getState().lines).toEqual(LINES);
  });
});

describe("source resolution: the real terminal/agent ids against the open tabs", () => {
  it("lines of an open terminal link to it; a closed terminal's lines say why they do not", async () => {
    const tab = useAppStore.getState().layoutActions.openTerminalTab({ title: "claude" });
    useAppStore.setState((s) => {
      (s.tabs[tab as TabId].ref as { terminalId: string }).terminalId = "term-agent";
    });
    await mount(LINES);
    // term-agent (open): its block headers are links.
    expect(within(headById(12)).getByRole("button", { name: "claude · proj" })).toHaveAttribute("title", "Focus claude · proj");
    expect(within(headById(21)).getByRole("button", { name: "sublog01" })).toBeInTheDocument();
    // term-shell (never opened here): plain text with the reason.
    expect(within(rowById(2)).queryByRole("button")).toBeNull();
    expect(within(rowById(2)).getByText("sh · proj")).toHaveAttribute(
      "title",
      "sh · proj — That terminal is closed — there is no tab to focus",
    );
  });
});
