/** `db query` runs show in the connection console without taking the pane from the terminal.
 * No DB runs here, so it targets a dead port (`--force`); `db_live_agent_ctl` covers servers. */
import { $, browser, expect } from "@wdio/globals";
import { terminalText } from "../support/real-service";
import { openTerminalFromEmptyPane, showTerminalTab, typeInTerminal } from "../support/terminal";

const PASSWORD = "s3cret-e2e-tools-pw";

/** Whether the tab titled `title` is the one its pane shows (`null`: no such tab). */
async function tabSelected(title: string): Promise<boolean | null> {
  return browser.execute((t: string) => {
    const tab = document.querySelector(`[role="tab"][title="${t}"]`);
    return tab === null ? null : tab.getAttribute("aria-selected") === "true";
  }, title);
}

describe("agent-studio db tools: what an agent runs, the user sees", () => {
  it("shows a query run in a background console tab, and opens a console on request", async () => {
    const term = await openTerminalFromEmptyPane();
    await typeInTerminal(
      term.id,
      `agent-studio db connect 'postgres://e2e:${PASSWORD}@127.0.0.1:1/e2etools' --force ` +
        `--name 'E2E Tools' && agent-studio db query 'e2e tools' 'SELECT 1'; echo "query-exit-$?"`,
    );

    // The run is reported in the terminal, as the agent reads it… (`query-exit-<digit>`: the typed
    // line itself already contains `query-exit-$?`, so waiting for the bare prefix ends at the echo.)
    const out = await browser.waitUntil(
      async () => {
        const text = await terminalText(term.id);
        return /query-exit-\d/.test(text) ? text : false;
      },
      { timeout: 30_000, timeoutMsg: "the db query command never finished" },
    );
    expect(out).toContain('Could not connect to "E2E Tools"');
    expect(out).toContain("query-exit-1");
    expect(out.includes(PASSWORD)).toBe(false);

    // …and in the app: a console tab for the connection, opened behind the terminal.
    await browser.waitUntil(async () => (await tabSelected("E2E Tools")) !== null, {
      timeout: 15_000,
      timeoutMsg: "no console tab appeared for the agent's query",
    });
    expect(await tabSelected("E2E Tools")).toBe(false);
    expect(await tabSelected(term.title)).toBe(true);

    // `db console` is the agent asking to show the user a console: that one takes the focus.
    await typeInTerminal(term.id, "agent-studio db console 'E2E Tools' 'SELECT 42 AS answer'");
    await browser.waitUntil(async () => (await tabSelected("E2E Tools")) === true, {
      timeout: 15_000,
      timeoutMsg: "db console did not bring the connection's console to the front",
    });
    // Nothing is reachable, so the console asks the user to connect rather than dialling itself.
    const closed = await $('[data-testid="db-console-closed"]');
    await closed.waitForDisplayed({ timeout: 10_000 });
    await expect(closed).toHaveText(expect.stringContaining("Not connected to E2E Tools"));

    const body = await browser.execute(() => document.body.innerText);
    expect(body.includes(PASSWORD)).toBe(false);
    await showTerminalTab(term.title);
  });
});
