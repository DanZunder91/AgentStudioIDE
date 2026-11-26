/** `agent-studio http send|open` typed into a real PTY: the PATH script runs the app binary in
 * command mode against the running app. A send lands in API history; an open adds an unsent tab. */
import { $, browser, expect } from "@wdio/globals";
import { startHttpFixture, type HttpFixture } from "../support/http-fixture";
import { openTerminalFromEmptyPane, typeInTerminal } from "../support/terminal";

describe("agent-studio command: HTTP requests from a terminal", () => {
  let fixture: HttpFixture;

  before(async () => {
    fixture = await startHttpFixture();
  });

  after(async () => {
    await fixture?.close();
  });

  it("sends a request, records it in the API history and shows the History rail", async () => {
    const term = await openTerminalFromEmptyPane();
    await typeInTerminal(term.id, `agent-studio http send '${fixture.url}/health'`);

    const panel = await $('[data-testid="history-panel"]');
    await panel.waitForDisplayed({
      timeout: 30_000,
      timeoutMsg: "the History rail never came into view — the command did not reach the app",
    });
    const row = await browser.waitUntil(
      async () =>
        browser.execute((want: string) => {
          const rows = [...document.querySelectorAll('[data-testid="history-run"]')];
          const hit = rows.find((r) => r.textContent?.includes(want));
          return hit?.textContent ?? false;
        }, `${fixture.url}/health`),
      { timeout: 15_000, timeoutMsg: "the agent's request never appeared in the API history" },
    );
    expect(row).toContain("GET");
    expect(row).toContain("200");

    // A request naming a Vault variable is refused: nothing new is recorded.
    const before = await browser.execute(
      () => document.querySelectorAll('[data-testid="history-run"]').length,
    );
    await typeInTerminal(term.id, `agent-studio http send '${fixture.url}/health?k={{TOKEN}}'`);
    await browser.pause(2_000);
    const after = await browser.execute(
      () => document.querySelectorAll('[data-testid="history-run"]').length,
    );
    expect(after).toBe(before);
  });

  it("opens a request in a new API client tab without sending it", async () => {
    const view = await $(".terminal-view[data-terminal-id]");
    const id = (await view.getAttribute("data-terminal-id")) ?? "";
    await typeInTerminal(
      id,
      `agent-studio http open '${fixture.url}/echo' --method POST --body e2e-open-marker`,
    );

    const request = await $('[data-testid="api-request"]');
    await request.waitForExist({
      timeout: 30_000,
      timeoutMsg: "no API request tab opened — the command did not reach the app",
    });
    await expect($('[aria-label="Request URL"]')).toHaveValue(`${fixture.url}/echo`);
    await expect($('[aria-label="HTTP method"]')).toHaveValue("POST");
    await expect($('[aria-label="Request body"]')).toHaveValue("e2e-open-marker");
    // Opened, not sent: no status pill.
    expect(await $('[data-testid="api-status"]').isExisting()).toBe(false);
  });
});
