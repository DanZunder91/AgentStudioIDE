/** Gazelle-like scenario, local and blocking (docs/design/testing-strategy.md). A rustls service
 * that doesn't trust the IDE's CA must be tunnelled and keep working. */

import { $, browser, expect } from "@wdio/globals";
import { execFile } from "node:child_process";

import { openTerminalFromEmptyPane, type OpenedTerminal } from "../support/terminal";
import {
  detailHeaders,
  devAppRows,
  flowRows,
  isInNetworkViewport,
  logRows,
  networkSourceRows,
  openFlow,
  openLogs,
  openNetwork,
  runIn,
  snap,
  terminalText,
  waitForDevApp,
  waitForFlow,
  waitForLog,
  clearLogsFilter,
  showNetworkColumns,
  type FlowRowView,
} from "../support/real-service";
import {
  GAZELLE_BIN,
  GAZELLE_PORT,
  TLS_UPSTREAM_PORT,
  agentNameInNetwork,
  checkpoint,
  clearFakeAgentTrigger,
  detailText,
  enableDecrypt,
  fakeAgentOutput,
  gazelleLine,
  launchFakeAgent,
  renameActiveTab,
  startTlsUpstream,
  waitForAgent,
  waitForScreen,
  type TlsUpstream,
} from "../support/gazelle-like";

const NET = '[data-testid="network-panel"]';
const LOGS = '[data-testid="agent-logs-panel"]';
const GAZELLE = "gazelle";

const isLoopback = (r: FlowRowView): boolean => /^127\.0\.0\.1(:3000)?$/.test(r.host);
const isTunnelToUpstream = (r: FlowRowView): boolean =>
  r.proto === "TUNNEL" && r.host.replace(/:\d+$/, "") === "localhost" && r.host.endsWith(`:${TLS_UPSTREAM_PORT}`);

/** The Logs Sources sidebar's rows (source key, display name, group). */
async function logSourceRows(): Promise<{ source: string; name: string; group: string }[]> {
  return browser.execute(() =>
    Array.from(document.querySelectorAll('[data-testid="alog-sidebar"] [data-testid="alog-src-row"]')).map((r) => ({
      source: r.getAttribute("data-source") ?? "",
      name: r.querySelector(".alog-side__name")?.textContent ?? "",
      group: r.getAttribute("data-group") ?? "",
    })),
  );
}

async function rowSources(): Promise<string[]> {
  return browser.execute(() =>
    Array.from(document.querySelectorAll('[data-testid="agent-logs-panel"] [data-testid="alog-row"]')).map(
      (r) => r.getAttribute("data-source") ?? "",
    ),
  );
}

describe("gazelle-like: a Rust server + an agent's --noproxy calls, in the IDE like real use runs them", () => {
  let tls: TlsUpstream;
  let gazelle: OpenedTerminal;
  let agent: OpenedTerminal;
  /** The agent's name in Network (its rail name) — the Source of its flows. */
  let agentName = "";

  before(async () => {
    tls = await startTlsUpstream();
    const first = await openTerminalFromEmptyPane();
    await renameActiveTab(GAZELLE);
    gazelle = { id: first.id, title: GAZELLE };
    // Decrypt on, as in real use: the agent's terminal (opened after) trusts the IDE's CA,
    // and gazelle-like is tunnelled by choice ("doesn't read the IDE's CA"), not because it is off.
    await enableDecrypt();
    await runIn(
      gazelle,
      gazelleLine({ GAZELLE_UPSTREAM: tls.url, GAZELLE_EXTRA_ROOT: tls.caPath, GAZELLE_UPSTREAM_EVERY_S: "5" }),
    );
    await waitForScreen(gazelle, /gazelle_like::main: listening on http:\/\/127\.0\.0\.1:3000/, "gazelle-listening");
    await checkpoint("gazelle-running");

    // Terminal B is an IDE AGENT (⚡ quick-launch): its stub `claude` runs the fake agent, which
    // writes a Claude transcript the IDE tails (Logs tool lines, BYPASS rows) and runs the commands.
    agent = await launchFakeAgent();
    await waitForAgent(/agent: done/, "fake-agent-done", 90_000);
    await checkpoint("fake-agent-done");
    await openNetwork();
    agentName = await agentNameInNetwork(agent.id);
  });

  after(() => {
    clearFakeAgentTrigger();
    tls?.stop();
    execFile("pkill", ["-f", GAZELLE_BIN], () => undefined);
  });

  it("the fixture runs in terminal `gazelle` and answers the agent: /health, /shipping/rates (via its TLS upstream) and python all 200", async () => {
    const screen = fakeAgentOutput();
    // The agent's Bash resolves `curl` to the IDE's shim (netcap/shim.rs), which drops --noproxy.
    expect(screen).toMatch(/agent\$ command -v curl\n\S*\/netcap\/bin\/curl\nagent: which exit 0/);
    expect(screen).toContain("agent: health exit 0");
    expect(screen).toContain("agent: rates exit 0");
    expect(screen).toContain("agent: python exit 0");
    expect(screen).toContain("agent: python-direct exit 0");
    expect((screen.match(/\{"status":"ok"\}/g) ?? []).length).toBeGreaterThanOrEqual(2);
    // TLS never broken: gazelle-like reached its upstream THROUGH the IDE's proxy and trusted it.
    expect(screen).toMatch(/"zone":"eu:1"/);
    expect(screen).toMatch(/"upstream":\{"bytes":\d+,"host":"localhost","status":200\}/);
    expect(tls.hits()).toBeGreaterThanOrEqual(2); // startup + /shipping/rates
    const own = await terminalText(gazelle.id);
    expect(own).toMatch(/INFO gazelle_like::upstream: rates: GET localhost 200/);
    expect(own).not.toMatch(/ERROR gazelle_like/);
  });

  it("Network at the 1280 px window: Time, Proto, Method, Status, Host, Path and Source are inside the table's viewport — no sideways scroll", async () => {
    // At this size only Time / Proto / Method / Host used to be visible; Status, Path and Source
    // were past the right edge (the table is ~440 px here: both rails + the Apps sidebar). The table
    // now fits itself (networkColumns.fitColumns). Before that fix this failed on Status.
    await openNetwork();
    await waitForFlow((r) => r.proto === "HTTP", "any HTTP row");
    const at: { label: string; ok: boolean; rect: string }[] = await browser.execute(
      (labels: string[]) => {
        const box = document.querySelector('[data-testid="network-panel"] .net-scroll')?.getBoundingClientRect();
        const heads = Array.from(document.querySelectorAll("table[aria-label='Network flows'] thead th"));
        return labels.map((label) => {
          const th = heads.find((h) => h.firstChild?.textContent?.trim() === label);
          if (!box || !th) return { label, ok: false, rect: th ? "no scroll box" : "no header" };
          const r = th.getBoundingClientRect();
          const ok = r.width >= 40 && r.left >= box.left - 0.5 && r.right <= box.right + 0.5;
          return { label, ok, rect: `th ${r.left}–${r.right}, viewport ${box.left}–${box.right}` };
        });
      },
      ["Time", "Proto", "Method", "Status", "Host", "Path", "Source"],
    );
    if (at.some((a) => !a.ok)) await snap("gl-network-columns-offscreen");
    for (const a of at) expect(`${a.label}: ${a.ok ? "on screen" : a.rect}`).toBe(`${a.label}: on screen`);
    const scroll = await browser.execute(() => {
      const el = document.querySelector('[data-testid="network-panel"] .net-scroll') as HTMLElement;
      return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
    });
    expect(scroll.scrollWidth).toBeLessThanOrEqual(scroll.clientWidth);
    await checkpoint("network-fit-1280");
    // The rest of this spec reads Process and Size: tick them on, as a user who wants them would.
    await showNetworkColumns();
  });

  it("Network: one row per agent call — a bypass that was captured anyway is its captured HTTP row only; the note says why", async () => {
    await openNetwork();
    // The direct python call is the agent's LAST (transcript order): once its row is here, every
    // earlier bypass has been recorded too. Before the fix, /health and /shipping/rates each
    // had a "via proxy" BYPASS twin, and the proxied python call a false "not captured" one.
    await waitForFlow((r) => r.proto === "BYPASS" && r.path === "/health?direct=1", "the direct python BYPASS row");
    const rows = await flowRows();
    const agentRows = rows.filter((r) => isLoopback(r) && r.source === agentName);
    const health = agentRows.filter((r) => r.path === "/health");
    const rates = agentRows.filter((r) => r.path === "/shipping/rates?zone=eu:1");
    const show = (xs: FlowRowView[]) => xs.map((r) => `${r.proto} ${r.status} ${r.process}`).join(", ");
    expect(show(rates)).toBe("HTTP 200 curl");
    // curl --noproxy (shimmed) and NO_PROXY='*' python3 (never took effect: urllib reads the PTY's
    // lowercase no_proxy="") — each ONE captured row, no BYPASS row for either.
    // The Process cell is the executable's name: `python3.12` in the E2E image (a symlink resolved).
    expect(show(health)).toMatch(/^HTTP 200 curl, HTTP 200 python3(\.\d+)?$/);
    expect(rows.some((r) => r.status === "via proxy")).toBe(false);
    expect(rows.filter((r) => r.status === "not captured").map((r) => r.path)).toEqual(["/health?direct=1"]);

    await openFlow(health[0].flowId);
    await expect($('[data-testid="net-shimmed"]')).toHaveText(
      "The agent asked for --noproxy; the IDE's curl shim captured it anyway.",
    );
    await checkpoint("network-one-row-per-call");
    await openFlow(health[1].flowId);
    await expect($('[data-testid="net-shimmed"]')).toHaveText(
      /^The agent asked for NO_PROXY=\* but python3(\.\d+)? still used the IDE proxy\.$/,
    );
    await checkpoint("network-python-captured-anyway");
  });

  it("Network: the agent's `curl --noproxy '*'` to 127.0.0.1:3000 are HTTP rows, 200, attributed to its terminal, with headers and body", async () => {
    await openNetwork();
    const health = await waitForFlow(
      (r) => isLoopback(r) && r.path === "/health" && r.status === "200" && r.process === "curl",
      "curl --noproxy GET 127.0.0.1:3000/health 200",
    );
    expect([health.proto, health.method, health.source]).toEqual(["HTTP", "GET", agentName]);
    const rates = await waitForFlow(
      (r) => isLoopback(r) && r.path === "/shipping/rates?zone=eu:1" && r.process === "curl",
      "curl --noproxy GET /shipping/rates",
    );
    expect([rates.status, rates.source]).toEqual(["200", agentName]);
    await checkpoint("network-agent-curls");

    const detail = await openFlow(health.flowId);
    await detail.$('button[role="tab"]=Request').click();
    await expect(detail.$('[data-testid="net-request-line"]')).toHaveText("GET /health HTTP/1.1");
    const req = await detailHeaders();
    expect(req.host).toBe(`127.0.0.1:${GAZELLE_PORT}`);
    expect(req["user-agent"]).toMatch(/^curl\//);
    await detail.$('button[role="tab"]=Response').click();
    await expect(detail.$('[data-testid="net-status-line"]')).toHaveText(/^Status 200/);
    const res = await detailHeaders();
    expect(res["x-svc"]).toBe("gazelle-like");
    expect(res["content-type"]).toBe("application/json");
    await browser.waitUntil(
      async () => {
        const t = await detail.$(".net-bodyview").getText().catch(() => "");
        return t.includes("status") && t.includes("ok");
      },
      { timeout: 10_000, timeoutMsg: 'the /health response body {"status":"ok"} is not shown' },
    );
    await checkpoint("network-health-detail");

    const ratesDetail = await openFlow(rates.flowId);
    await ratesDetail.$('button[role="tab"]=Response').click();
    await browser.waitUntil(async () => (await ratesDetail.$(".net-bodyview").getText().catch(() => "")).includes("eu:1"), {
      timeout: 10_000,
      timeoutMsg: "the /shipping/rates response body (zone eu:1) is not shown",
    });
    await checkpoint("network-rates-detail");
  });

  it("Network: a REAL bypass (`env -u …_PROXY python3`) is still a row — BYPASS, not captured, GET 127.0.0.1:3000 /health?direct=1, the command verbatim", async () => {
    await openNetwork();
    const row = await waitForFlow(
      (r) => r.proto === "BYPASS" && r.status === "not captured",
      "BYPASS python3 (env -u) → 127.0.0.1:3000",
    );
    // Method and Host used to read `—` (only a curl's URL was parsed). logstream/bypass.rs now
    // reads any command's first http(s):// URL.
    expect([row.method, row.path, row.source]).toEqual(["GET", "/health?direct=1", agentName]);
    expect(isLoopback(row)).toBe(true);
    // …and nothing captured it: no HTTP row for that path.
    expect((await flowRows()).some((r) => r.proto !== "BYPASS" && r.path === "/health?direct=1")).toBe(false);
    await openFlow(row.flowId);
    const text = await detailText();
    if (!(text.includes("env -u HTTP_PROXY") && text.includes("urllib.request.urlopen"))) await snap("gl-bypass-detail");
    expect(text).toContain("env -u HTTP_PROXY");
    expect(text).toContain("urllib.request.urlopen");
    expect(text).toContain("Not captured");
    await checkpoint("network-python-bypass");
  });

  it("Network: gazelle-like's outbound HTTPS is a TUNNEL row from terminal `gazelle` — closed, bytes ↑/↓, and why it was not decrypted", async () => {
    await openNetwork();
    const row = await waitForFlow(
      (r) => isTunnelToUpstream(r) && r.source === GAZELLE && /closed/i.test(r.status),
      `TUNNEL localhost:${TLS_UPSTREAM_PORT} closed from ${GAZELLE}`,
      45_000,
    );
    expect(row.method).toBe("CONNECT");
    expect(row.process).toBe("gazelle-like");
    const size = await browser.execute(
      (id: string) => document.querySelector(`[data-testid="net-row"][data-flow-id="${id}"] .net-c--size`)?.getAttribute("title") ?? "",
      row.flowId,
    );
    const [, up, down] = /↑(\d+) B\s+↓(\d+) B/.exec(size) ?? [];
    expect(Number(up)).toBeGreaterThan(0);
    expect(Number(down)).toBeGreaterThan(0);

    await openFlow(row.flowId);
    await expect($('[data-testid="net-tunnel-note"]')).toBeDisplayed();
    await expect($('[data-testid="net-explain"]')).toBeDisplayed();
    const text = await detailText();
    expect(text).toMatch(/gazelle-like/);
    expect(text).toMatch(/CA/);
    await checkpoint("network-gazelle-tunnel");
  });

  it("the sidebar: APPS › Rust · Cargo lists gazelle-like (IDE, not external); TERMINALS lists `gazelle`, AGENTS the fake agent; `gazelle` filters to its flows", async () => {
    await openNetwork();
    let app: { name: string; origin: string; section: string } | undefined;
    await browser
      .waitUntil(
        async () => {
          app = await browser.execute(() => {
            const r = Array.from(document.querySelectorAll('[data-testid="net-apps"] [data-testid="procs-row"]')).find(
              (e) => e.querySelector(".procs-side__name")?.textContent === "gazelle-like",
            );
            return r
              ? {
                  name: "gazelle-like",
                  origin: r.getAttribute("data-origin") ?? "",
                  section: r.closest('[data-testid="procs-runtime"]')?.getAttribute("aria-label") ?? "",
                }
              : undefined;
          });
          return app !== undefined;
        },
        { timeout: 20_000, interval: 500 },
      )
      .catch(() => undefined);
    if (!app) await snap("gl-no-network-app");
    expect(app).toEqual({ name: "gazelle-like", origin: "ide", section: "Rust · Cargo" });
    // Launched from the terminal the user named `gazelle`: the tag says so (it read `by bash`).
    const netTag = await browser.execute(
      () =>
        Array.from(document.querySelectorAll('[data-testid="net-apps"] [data-testid="procs-row"]'))
          .find((e) => e.querySelector(".procs-side__name")?.textContent === "gazelle-like")
          ?.querySelector('[data-testid="procs-origin"]')?.textContent ?? "",
    );
    expect(netTag).toBe(`by ${GAZELLE}`);

    for (const label of ["Filter by source", "Filter by process", "Filter by host"]) {
      const at = await isInNetworkViewport(`${NET} .net-bar button[aria-label="${label}"]`);
      expect(`${label}: ${at.ok ? "on screen" : at.rect}`).toBe(`${label}: on screen`);
    }

    const rows = await networkSourceRows();
    const g = rows.find((r) => r.key === `t:${gazelle.id}`);
    const b = rows.find((r) => r.key === `t:${agent.id}`);
    expect([g?.group, g?.name]).toEqual(["terminals", GAZELLE]);
    // The agent's terminal is an agent's: it is listed under Agents, by its title.
    expect([b?.group, b?.name]).toEqual(["agents", agentName]);
    await checkpoint("network-sidebar");

    await $(`${NET} [data-testid="net-src-row"][data-source="t:${gazelle.id}"] button`).click();
    await browser.waitUntil(async () => {
      const shown = await flowRows();
      return shown.length > 0 && shown.every((r) => r.source === GAZELLE);
    }, { timeout: 5_000, timeoutMsg: "picking `gazelle` left other terminals' flows in the table" });
    const shown = await flowRows();
    expect(shown.some(isTunnelToUpstream)).toBe(true);
    expect(shown.some((r) => r.process === "curl")).toBe(false);
    await checkpoint("network-gazelle-only");
    await $(`${NET} [data-testid="net-side-all"]`).click();
  });

  it("Logs: gazelle-like is an app (Rust · Cargo, IDE); its log file streams as its own source with only its lines", async () => {
    await openLogs();
    await clearLogsFilter();
    const row = await waitForDevApp((r) => r.name === "gazelle-like", "gazelle-like");
    expect([row.runtime, row.section, row.origin]).toEqual(["rust", "Rust · Cargo", "ide"]);
    // The launcher tag names the renamed terminal by its live title (it read `by bash · workspace`).
    expect(row.tag).toBe(`by ${GAZELLE}`);
    await $(`${LOGS} [data-testid="procs-row"][data-key="${row.key}"]`).click();
    const card = $(`[data-testid="procs-card"][data-key="${row.key}"]`);
    await card.waitForDisplayed({ timeout: 10_000 });
    await expect(card.$('[data-testid="procs-console"]')).toHaveAttribute("data-console", "ide-terminal");
    await checkpoint("logs-gazelle-card");

    const stream = card.$('button[aria-label="Stream gazelle-like.log"]');
    if (!(await stream.isExisting())) await snap("gl-no-stream-button");
    await stream.click();
    const source = "gazelle-like · gazelle-like.log";
    await browser.waitUntil(async () => (await $('[data-testid="alog-stream-head"]').getAttribute("data-source")) === source, {
      timeout: 15_000,
      timeoutMsg: `Stream did not solo "${source}"`,
    });
    await waitForLog((r) => r.text.includes("gazelle_like::http: GET /shipping/rates?zone=eu:1 200"), "the log file's rates line");
    const sources = await rowSources();
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.every((s) => s === source)).toBe(true);
    expect((await logRows()).every((r) => r.text.includes("gazelle_like::"))).toBe(true);
    await checkpoint("logs-gazelle-logfile");
    await card.$('button[aria-label="Stop gazelle-like.log"]').click();
    await $('[data-testid="alog-src-all"]').click();
  });

  it("Logs: the `gazelle` terminal's stdout is a source with gazelle-like's lines only; the fake agent's commands are visible under its own", async () => {
    await openLogs();
    await $('[data-testid="alog-src-all"]').click();
    await clearLogsFilter();
    // gazelle-like's stdout is the `gazelle` terminal's PTY output.
    await waitForLog((r) => r.text.includes("gazelle_like::main: listening on"), "gazelle-like's `listening on` line");
    const byText = async (needle: string): Promise<string> =>
      (await browser.execute(
        (n: string) =>
          Array.from(document.querySelectorAll('[data-testid="agent-logs-panel"] [data-testid="alog-row"]'))
            .find((r) => (r.querySelector(".alog-text")?.textContent ?? "").includes(n))
            ?.getAttribute("data-source") ?? "",
        needle,
      )) as string;
    const gSource = await byText("gazelle_like::main: listening on");
    const srcRows = await logSourceRows();
    expect(gSource).not.toBe("");
    expect(srcRows.find((r) => r.source === gSource)?.name).toBe(GAZELLE);

    await $(`${LOGS} [data-testid="alog-src-row"][data-source="${gSource}"] button.alog-side__main`).click();
    await browser.waitUntil(async () => (await rowSources()).every((s) => s === gSource), {
      timeout: 5_000,
      timeoutMsg: "picking the `gazelle` terminal left other sources' lines",
    });
    const gRows = await logRows();
    expect(gRows.some((r) => r.text.includes("gazelle_like::http: GET /health 200"))).toBe(true);
    expect(gRows.some((r) => r.text.includes("agent$"))).toBe(false);
    // The renamed terminal is `gazelle` everywhere Logs names it — Source cells, the stream
    // header, the source picker — not its spawn label (`bash · workspace`, as older builds showed).
    expect([...new Set(gRows.map((r) => r.source))]).toEqual([GAZELLE]);
    const named = await browser.execute(() => ({
      head: document.querySelector('[data-testid="alog-stream-head"] .alog-stream-head__name')?.textContent ?? "",
      headText: document.querySelector('[data-testid="alog-stream-head"]')?.textContent ?? "",
      picker: document.querySelector('[data-testid="agent-logs-panel"] button[aria-label="Filter by source"]')?.textContent ?? "",
    }));
    expect(named.head).toBe(GAZELLE);
    expect(named.headText).not.toContain(gSource);
    expect(named.picker).toContain(GAZELLE);
    expect(named.picker).not.toContain(gSource);
    await checkpoint("logs-gazelle-terminal");

    // The agent's commands: its terminal's PTY output is not a log source (Claude's TUI is noise),
    // so what Logs shows of an agent is its transcript's tool calls — the command, verbatim.
    await $('[data-testid="alog-src-all"]').click();
    const panelHas = async (needle: string): Promise<boolean> =>
      browser.execute((n: string) => (document.querySelector('[data-testid="agent-logs-panel"]')?.textContent ?? "").includes(n), needle);
    for (const cmd of [
      "curl -s --noproxy '*' http://127.0.0.1:3000/health",
      "curl -s --noproxy '*' 'http://127.0.0.1:3000/shipping/rates?zone=eu:1'",
      "NO_PROXY='*' python3 -c",
    ]) {
      const ok = await browser.waitUntil(() => panelHas(cmd), { timeout: 20_000, interval: 500 }).catch(() => false);
      if (!ok) await snap("gl-logs-no-agent-command");
      expect(`${cmd}: ${ok ? "shown" : "missing"}`).toBe(`${cmd}: shown`);
    }
    await checkpoint("logs-fake-agent");
    await $('[data-testid="alog-src-all"]').click();
  });

  it("devAppRows sanity: gazelle-like is not listed as external anywhere", async () => {
    const all = (await devAppRows()).filter((r) => r.name === "gazelle-like");
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((r) => r.origin === "ide")).toBe(true);
  });
});
