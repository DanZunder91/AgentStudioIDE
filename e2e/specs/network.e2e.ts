/**
 * N1 — Network shows an IDE terminal's HTTP call, captured by the in-process proxy.
 *
 * The real chain, no mocks: a real bash in a real PTY spawned with `http_proxy` pointing at
 * the netcap proxy (userinfo = the terminal id, for attribution) → `curl` → the proxy on
 * 127.0.0.1 → the probe server on this machine's non-loopback address → the flow ring →
 * `netcap://flow` / `netcap_snapshot` / `netcap_flow` over real Tauri IPC → the DOM.
 * Nothing leaves the machine (or the container): client, proxy and server are all local.
 */

import { lookup } from "node:dns/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { $, browser, expect } from "@wdio/globals";
import { moment } from "../support/record";
import { openTerminalFromEmptyPane, showTerminalTab, typeInTerminal, type OpenedTerminal } from "../support/terminal";
import { PROBE_HEADER, PROBE_HEADER_VALUE, PROBE_PATH, startProbeServer, type ProbeServer } from "../support/probe-server";

interface FlowRowView {
  flowId: string;
  method: string;
  host: string;
  path: string;
  status: string;
  source: string;
}

async function flowRows(): Promise<FlowRowView[]> {
  return browser.execute(() =>
    Array.from(document.querySelectorAll('[data-testid="network-panel"] [data-testid="net-row"]')).map((r) => {
      const cell = (c: string): string => r.querySelector(`.net-c--${c}`)?.textContent?.trim() ?? "";
      return {
        flowId: r.getAttribute("data-flow-id") ?? "",
        method: cell("method"),
        host: cell("host"),
        path: cell("path"),
        status: cell("status"),
        source: cell("source"),
      };
    }),
  );
}

describe("network: an IDE terminal's HTTP call is captured by the proxy", () => {
  let term: OpenedTerminal;
  let probe: ProbeServer;

  before(async () => {
    probe = await startProbeServer();
    // Opened AFTER the app booted its proxy, so the PTY is spawned with the proxy env.
    term = await openTerminalFromEmptyPane();
  });

  after(async () => {
    await probe?.close();
  });

  it("lists GET /e2e-probe → 200 with the terminal as Source", async () => {
    // `-s -o /dev/null -w` keeps the terminal quiet; curl honours the lowercase http_proxy.
    await typeInTerminal(term.id, `curl -s -o /dev/null -w 'probe:%{http_code}\\n' ${probe.url}${PROBE_PATH}`);

    await $('[aria-label="Network traffic"]').click();
    await $('[data-testid="network-panel"]').waitForDisplayed({ timeout: 15_000 });

    let last: FlowRowView[] = [];
    const row = await browser
      .waitUntil(
        async () => {
          last = await flowRows();
          return last.find((r) => r.path === PROBE_PATH && r.status.startsWith("200")) ?? false;
        },
        { timeout: 20_000, interval: 250 },
      )
      .catch(() => undefined);
    if (!row) {
      const seen = last.map((r) => `${r.method} ${r.host} ${r.path} ${r.status} [${r.source}]`).join("\n  ");
      throw new Error(
        `no completed ${PROBE_PATH} flow within 20 s (server hits: ${JSON.stringify(probe.hits)}); rows:\n  ${seen || "(none)"}`,
      );
    }
    expect(row.method).toBe("GET");
    expect(row.host).toContain(probe.host);
    expect(row.source).toBe(term.title);
    // The request really reached the server (through the proxy — loopback is NO_PROXY'd).
    expect(probe.hits).toContain(`GET ${PROBE_PATH}`);

    // Detail: open the flow, switch to Response, and see the server's header.
    // Click a cell: WebKitWebDriver reports a <tr> itself as "not interactable". The Method
    // cell, not Path — Path's visibility is its own test below.
    await $(`[data-testid="net-row"][data-flow-id="${row.flowId}"] .net-c--method`).click();
    const detail = await $('[data-testid="net-detail"]');
    await detail.waitForDisplayed({ timeout: 10_000 });
    await detail.$('button[role="tab"]=Response').click();
    await expect(detail.$('[data-testid="net-status-line"]')).toHaveText(/^Status 200/);
    await browser.waitUntil(
      async () =>
        browser.execute(
          (name: string, value: string) =>
            Array.from(document.querySelectorAll('[data-testid="net-detail"] [role="tabpanel"] tr')).some(
              (tr) =>
                tr.querySelector("th")?.textContent?.trim().toLowerCase() === name &&
                tr.querySelector("td")?.textContent?.trim() === value,
            ),
          PROBE_HEADER,
          PROBE_HEADER_VALUE,
        ),
      { timeout: 10_000, interval: 250, timeoutMsg: `response header ${PROBE_HEADER} not shown in the flow detail` },
    );
  });

  it("shows the Path column at the default window size (both rails open)", async () => {
    // The rows above are read from the DOM, which holds the path even when the column has
    // collapsed. This asserts the user can actually SEE it (test the layer the user
    // touches). Wide enough for "/e2e-probe" (10 monospace chars) at the least.
    const widths = await browser.execute(() => {
      const th = Array.from(document.querySelectorAll("table[aria-label='Network flows'] thead th")).find(
        (h) => h.textContent?.trim() === "Path",
      );
      const td = document.querySelector('[data-testid="net-row"] .net-c--path');
      return {
        header: th?.getBoundingClientRect().width ?? -1,
        cell: td?.getBoundingClientRect().width ?? -1,
        pane: document.querySelector('[data-testid="network-panel"]')?.getBoundingClientRect().width ?? -1,
        window: window.innerWidth,
      };
    });
    if (widths.header < 60 || widths.cell < 60) {
      throw new Error(`the Path column is ${widths.header}px wide (cell ${widths.cell}px) in a ${widths.pane}px Network pane, window ${widths.window}px`);
    }
  });

  it("Hide AI providers: in the header, on by default — an agent CLI's call to a provider is hidden, a curl to it stays", async () => {
    const label = await $('[data-testid="network-panel"] .net-head .net-head__hide');
    await label.waitForDisplayed({ timeout: 10_000 });
    await expect(label).toHaveText(/^Hide AI providers\d+$/);
    // Looked up afresh each time: the panel is a tab, and it remounts when it comes back to the front.
    const box = () => $('[data-testid="network-panel"] .net-head [data-testid="net-hide-ai"]');
    expect(await box().isSelected()).toBe(true);

    // The hiding itself needs a provider host that resolves inside the container: scripts/e2e-linux.mjs
    // maps api.openai.com to loopback (BLOCKED_HOSTS), so nothing reaches OpenAI. Elsewhere, say so.
    if (!(process.env.E2E_BLOCKED_HOSTS ?? "").split(",").includes("api.openai.com")) {
      console.warn("[network] api.openai.com is NOT mapped to loopback in this run (not scripts/e2e-linux.mjs): the hiding check is skipped");
      return;
    }
    expect((await lookup("api.openai.com")).address).toBe("127.0.0.1");
    const hits: string[] = [];
    const server = http.createServer((req, res) => {
      hits.push(req.url ?? "");
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      // `/tmp/claude` is the real curl binary under the CLI's name, so the proxy resolves its client
      // as `claude` (netcap::client::client_name) — Claude Code itself, as far as the table knows. The
      // plain `curl` is an agent's own command to the same provider, and must stay visible.
      const url = `http://api.openai.com:${port}`;
      // The Network tab covers the terminal in this pane: bring the terminal forward, type, come back.
      await showTerminalTab(term.title);
      await typeInTerminal(term.id, `cp /usr/bin/curl /tmp/claude; /tmp/claude -so /dev/null ${url}/v1/e2e-ai; curl -so /dev/null ${url}/v1/e2e-curl`);
      await browser.waitUntil(async () => hits.includes("/v1/e2e-ai") && hits.includes("/v1/e2e-curl"), {
        timeout: 20_000,
        interval: 250,
        timeoutMsg: `the two requests never reached the local "api.openai.com" server (hits: ${JSON.stringify(hits)})`,
      });
      await $('[aria-label="Network traffic"]').click();
      await $('[data-testid="network-panel"]').waitForDisplayed({ timeout: 15_000 });
      const paths = async () => (await flowRows()).map((r) => r.path);
      await browser.waitUntil(async () => (await paths()).includes("/v1/e2e-curl"), {
        timeout: 20_000,
        interval: 250,
        timeoutMsg: "the agent's curl to the provider never showed in the table",
      });
      // The CLI's flow is in the ring (the count says so) but not in the table.
      await browser.waitUntil(async () => Number(await $('[data-testid="net-ai-count"]').getText()) >= 1, {
        timeout: 20_000,
        interval: 250,
        timeoutMsg: "the checkbox's count never counted the CLI's call",
      });
      expect(await paths()).not.toContain("/v1/e2e-ai");
      await moment("hide-ai-providers-on");

      await box().click();
      await browser.waitUntil(async () => (await paths()).includes("/v1/e2e-ai"), {
        timeout: 10_000,
        interval: 250,
        timeoutMsg: "unchecking Hide AI providers did not bring the CLI's call back",
      });
      expect(await paths()).toContain("/v1/e2e-curl");
      await moment("hide-ai-providers-off");
      await box().click();
      expect(await box().isSelected()).toBe(true);
    } finally {
      // The proxy may keep its upstream connection pooled; close() alone would wait for it.
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
