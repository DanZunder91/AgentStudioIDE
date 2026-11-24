/**
 * `agent-studio db connect` from a real terminal in the real app — the command an agent runs
 * when the user says "connect me to this database".
 *
 * Typed into a real PTY exactly as an agent's shell would run it: the script on the terminal's
 * PATH execs the app binary in command mode, which posts to the running app's listener with the
 * terminal's token; the app saves the connection and the DB panel comes into view with a notice.
 * No database runs in this container, so the URL points at a port nothing listens on and
 * `--force` saves it anyway — the path under test is the command → app → panel round trip, not
 * the driver (the live tier, `db_live_agent_ctl`, covers a real server).
 */
import { $, browser, expect } from "@wdio/globals";
import { openTerminalFromEmptyPane, typeInTerminal } from "../support/terminal";

const PASSWORD = "s3cret-e2e-pw";

describe("agent-studio command: a database connection from a terminal", () => {
  it("adds the connection to the DB panel, read-only, without its password", async () => {
    const term = await openTerminalFromEmptyPane();
    await typeInTerminal(
      term.id,
      `agent-studio db connect 'postgres://e2e:${PASSWORD}@127.0.0.1:1/e2eshop' --force --name 'E2E Shop'`,
    );

    const notice = await $('[data-testid="db-agent-notice"]');
    await notice.waitForDisplayed({
      timeout: 30_000,
      timeoutMsg:
        "the DB panel never showed the agent notice — the command did not reach the app",
    });
    await expect(notice).toHaveText(
      expect.stringContaining('added "E2E Shop"'),
    );
    await expect(notice).toHaveText(expect.stringContaining("read-only"));

    const list = await $('[data-testid="db-connection-list"]');
    await list.waitForDisplayed({ timeout: 10_000 });
    const row = await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const r = document.querySelector(
            '[data-testid="db-connection-list"]',
          );
          return r?.textContent?.includes("E2E Shop") ? r.textContent : false;
        }),
      {
        timeout: 10_000,
        timeoutMsg: "the connection never appeared in the DB panel's list",
      },
    );
    expect(row).toContain("read-only");

    // In the default-width rail the row must show its name and keep every button inside the
    // panel. On one line, the buttons once squeezed the name to 0px and pushed Delete past the
    // rail's clipped edge.
    const layout = await browser.execute(() => {
      const rect = (s: string) =>
        document.querySelector(s)?.getBoundingClientRect();
      const panel = rect('[data-testid="db-panel"]');
      const buttons = [
        ...document.querySelectorAll(".db-panel__rowhead button"),
      ].map((b) => b.getBoundingClientRect());
      return {
        name: rect(".db-panel__name")?.width ?? 0,
        panelRight: panel?.right ?? 0,
        buttonsRight: Math.max(...buttons.map((b) => b.right)),
      };
    });
    expect(layout.name).toBeGreaterThan(40);
    expect(layout.buttonsRight).toBeLessThanOrEqual(layout.panelRight);

    // The password went to the Vault: nothing on screen shows it.
    const body = await browser.execute(() => document.body.innerText);
    expect(body.includes(PASSWORD)).toBe(false);

    await $('[data-testid="db-agent-notice-dismiss"]').click();
    await notice.waitForExist({ reverse: true, timeout: 5_000 });
  });
});
