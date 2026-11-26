/** R2, Decrypt HTTPS on ("never break a client"), against example.com only; reported, not blocking.
 * Allowlisted curl is decrypted; wget is tunnelled, still works, and its row says why. */

import { $, browser, expect } from "@wdio/globals";

import { openTerminalFromEmptyPane, type OpenedTerminal } from "../support/terminal";
import {
  SERVICE_PORT,
  SERVICE_SCRIPT,
  SERVICE_URL,
  detailHeaders,
  openAnotherTerminal,
  openFlow,
  openLogs,
  openNetwork,
  runIn,
  snap,
  terminalText,
  waitForFlow,
  waitForLog,
  showNetworkColumns,
} from "../support/real-service";

async function waitForScreen(term: OpenedTerminal, re: RegExp, what: string, timeout = 45_000): Promise<string> {
  let text = "";
  const ok = await browser
    .waitUntil(
      async () => {
        text = await terminalText(term.id);
        return re.test(text);
      },
      { timeout, interval: 300 },
    )
    .catch(() => false);
  if (!ok) {
    await snap(`terminal-${what}`);
    throw new Error(`${what}: ${re} never appeared in the terminal; screen:\n${text}`);
  }
  return text;
}

describe("real service, external: outbound HTTPS to example.com with Decrypt HTTPS on", () => {
  let term: OpenedTerminal;

  before(async () => {
    // A first terminal gives the pane its tab bar (and its "New terminal tab" button).
    await openTerminalFromEmptyPane();
    await openNetwork();
    // Reads Process / Type: tick them on (the 1280 px window's fit hides them — fitColumns).
    await showNetworkColumns();
    // WebdriverIO's `tag=text` form cannot follow a CSS descendant chain — XPath can.
    const decrypt = $(
      '//*[@data-testid="network-panel"]//button[@role="switch"][contains(normalize-space(.), "Decrypt HTTPS")]',
    );
    await decrypt.waitForEnabled({ timeout: 15_000 });
    if ((await decrypt.getAttribute("aria-checked")) !== "true") await decrypt.click();
    await expect(decrypt).toHaveAttribute("aria-checked", "true");
    // The env is fixed at spawn: only a terminal opened NOW trusts the IDE's CA.
    term = await openAnotherTerminal();
  });

  it("curl https://example.com/ is decrypted: GET example.com / 200, Process curl, the page in the body", async () => {
    await runIn(term, "curl -s https://example.com/ | grep -c 'Example Domain' | sed 's/^/curl-hits:/'");
    await waitForScreen(term, /curl-hits:[1-9]/, "curl-example");

    await openNetwork();
    const row = await waitForFlow(
      (r) => r.host === "example.com" && r.path === "/" && r.status === "200" && r.process === "curl",
      "GET example.com / 200 (curl, decrypted)",
    );
    expect(row.proto).toBe("HTTPS");
    expect(row.method).toBe("GET");
    expect(row.type).toBe("text/html");

    const detail = await openFlow(row.flowId);
    await detail.$('button[role="tab"]=Request').click();
    await expect(detail.$('[data-testid="net-request-line"]')).toHaveText(/^GET \/ HTTP\//);
    await detail.$('button[role="tab"]=Response').click();
    await expect(detail.$('[data-testid="net-status-line"]')).toHaveText(/^Status 200/);
    expect((await detailHeaders())["content-type"]).toMatch(/^text\/html/);
    await browser.waitUntil(
      async () => (await detail.$(".net-bodyview").getText().catch(() => "")).includes("Example Domain"),
      { timeout: 10_000, timeoutMsg: "the decrypted response body does not show `Example Domain`" },
    );
    await expect(detail.$(".net-actions").$("button=Copy as cURL")).toBeEnabled();
  });

  it("wget (not on the allowlist) still works, and its row is an explained tunnel, never an empty pane", async () => {
    await runIn(term, "wget -qO- https://example.com/ | grep -c 'Example Domain' | sed 's/^/wget-hits:/'");
    // The never-break check: the client's command SUCCEEDED through the proxy.
    await waitForScreen(term, /wget-hits:[1-9]/, "wget-example");

    await openNetwork();
    const row = await waitForFlow(
      (r) => r.proto === "TUNNEL" && r.host === "example.com:443" && r.process === "wget",
      "TUNNEL example.com:443 (wget)",
    );
    expect(row.type).toBe("not decrypted: wget doesn't read the IDE's CA");

    const detail = await openFlow(row.flowId);
    await expect(detail.$('[data-testid="net-explain"]')).toHaveText("not decrypted: wget doesn't read the IDE's CA");
    await expect(detail.$('[data-testid="net-tunnel-note"]')).toHaveText(/^Encrypted tunnel: \d+ B up, \d+ B down\./);
    const facts = await browser.execute(() =>
      Object.fromEntries(
        Array.from(document.querySelectorAll('[data-testid="net-facts"] .net-facts__row')).map((r) => [
          r.querySelector("dt")?.textContent?.trim() ?? "",
          r.querySelector("dd")?.textContent?.trim() ?? "",
        ]),
      ),
    );
    expect(facts.Host).toBe("example.com");
    expect(facts.Port).toBe("443");
    expect(facts.Process).toMatch(/^wget \(pid \d+\)/);
    // Real bytes both ways — the page came back through the tunnel.
    expect(Number(/\((\d+) B\)/.exec(facts.Received ?? "")?.[1] ?? 0)).toBeGreaterThan(500);
    await expect(detail.$(".net-actions").$("button=Copy as cURL")).toBeDisabled();
  });

  it("the service's own /upstream to example.com succeeds, is logged, and is a decrypted row", async () => {
    const svc = await openAnotherTerminal(); // opened with Decrypt on
    await runIn(svc, `SVC_PORT=${SERVICE_PORT} node ${SERVICE_SCRIPT}`);
    await waitForScreen(svc, /INFO svc: listening on/, "service-listening", 20_000);
    await runIn(term, `curl -s ${SERVICE_URL}/upstream; echo`);
    await waitForScreen(term, /\{"upstream":"example\.com","bytes":\d+\}/, "upstream-ok");

    await openLogs();
    const ok = await waitForLog((r) => r.text.includes("INFO svc: upstream example.com 200"), "`INFO svc: upstream example.com 200`");
    expect(ok.level).toBe("info");

    await openNetwork();
    await waitForFlow(
      (r) => r.host === "example.com" && r.path === "/" && r.status === "200" && r.source === svc.title,
      "GET example.com / 200 from the service's terminal",
    );
    await waitForFlow(
      (r) => r.host === "localhost" && r.path === "/upstream" && r.status === "200",
      "GET localhost /upstream 200",
    );
  });
});
