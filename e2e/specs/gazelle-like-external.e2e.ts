/** Gazelle-like public half (example.com; reported, not blocking): rustls clients that don't trust
 * the IDE's CA are tunnelled and still succeed; curl, which reads the CA bundle, is decrypted. */

import { $, browser, expect } from "@wdio/globals";
import { execFile } from "node:child_process";

import { openTerminalFromEmptyPane, type OpenedTerminal } from "../support/terminal";
import { openFlow, openNetwork, runIn, showNetworkColumns, terminalText, waitForFlow } from "../support/real-service";
import {
  GAZELLE_BIN,
  agentNameInNetwork,
  checkpoint,
  clearFakeAgentTrigger,
  detailText,
  enableDecrypt,
  fakeAgentOutput,
  gazelleLine,
  launchFakeAgent,
  renameActiveTab,
  waitForAgent,
  waitForScreen,
} from "../support/gazelle-like";

const GAZELLE = "gazelle";

describe("gazelle-like, external: its example.com calls tunnel and keep working; the agent's curl is decrypted", () => {
  let gazelle: OpenedTerminal;
  let agent: OpenedTerminal;
  /** The agent's name in Network (its rail name) — the Source of its flows. */
  let agentName = "";

  before(async () => {
    const first = await openTerminalFromEmptyPane();
    await renameActiveTab(GAZELLE);
    gazelle = { id: first.id, title: GAZELLE };
    await enableDecrypt();
    // The fixture's defaults: upstream https://example.com/, webpki-roots only, every 30 s.
    await runIn(gazelle, gazelleLine());
    await waitForScreen(gazelle, /gazelle_like::main: listening on/, "gazelle-listening");
    await waitForScreen(gazelle, /gazelle_like::upstream: tick: GET example\.com (200|failed)/, "gazelle-startup-upstream");
    await checkpoint("ext-gazelle-running");
    agent = await launchFakeAgent({ external: true });
    await waitForAgent(/agent: done/, "fake-agent-done", 120_000);
    await checkpoint("ext-fake-agent-done");
    await openNetwork();
    // Reads Process / Size: tick them on (the 1280 px window's fit hides them — fitColumns).
    await showNetworkColumns();
    agentName = await agentNameInNetwork(agent.id);
  });

  after(() => {
    clearFakeAgentTrigger();
    execFile("pkill", ["-f", GAZELLE_BIN], () => undefined);
  });

  it("gazelle-like's upstream calls to example.com succeed through the IDE (TLS never broken)", async () => {
    const own = await terminalText(gazelle.id);
    expect(own).toMatch(/INFO gazelle_like::upstream: tick: GET example\.com 200/);
    expect(own).not.toMatch(/ERROR gazelle_like/);
    const screen = fakeAgentOutput();
    expect(screen).toContain("agent: rates exit 0");
    expect(screen).toMatch(/"upstream":\{"bytes":\d+,"host":"example\.com","status":200\}/);
  });

  it("Network: gazelle-like's example.com CONNECTs are TUNNEL rows from `gazelle` — closed, bytes ↑/↓, with the explanation card", async () => {
    await openNetwork();
    const row = await waitForFlow(
      (r) => r.proto === "TUNNEL" && r.host === "example.com:443" && r.source === GAZELLE && r.status === "closed",
      "TUNNEL example.com:443 closed from gazelle",
      45_000,
    );
    expect([row.method, row.process]).toEqual(["CONNECT", "gazelle-like"]);
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
    expect(await detailText()).toMatch(/gazelle-like/);
    await checkpoint("ext-network-gazelle-tunnel");
  });

  it("Network: the agent's plain `curl https://example.com/` is decrypted — HTTPS GET example.com / 200, Process curl", async () => {
    await openNetwork();
    const row = await waitForFlow(
      (r) => r.proto === "HTTPS" && r.host === "example.com" && r.path === "/" && r.process === "curl",
      "HTTPS GET example.com / from curl",
      45_000,
    );
    expect([row.status, row.source]).toEqual(["200", agentName]);
    await openFlow(row.flowId);
    await checkpoint("ext-network-agent-https");
  });
});
