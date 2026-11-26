/** Drive a real IDE terminal from WebDriver using only hooks the app already renders. Keys go to
 * xterm's helper textarea, the same path a user's typing takes (onData → pty_write → shell). */

import { $, browser } from "@wdio/globals";

/** W3C WebDriver key code for Enter. */
const ENTER = "";

export interface OpenedTerminal {
  /** The PTY's terminal id (`data-terminal-id`). */
  id: string;
  /** The title on the terminal's tab — what the Network view shows as Source. */
  title: string;
}

/** Wait for the shell, open a terminal from the empty pane, and return its id + tab title. */
export async function openTerminalFromEmptyPane(): Promise<OpenedTerminal> {
  const shell = await $('[data-testid="app-shell"]');
  await shell.waitForExist({ timeout: 30_000 });
  const newTerm = await $('[data-testid="empty-pane-new-terminal"]');
  await newTerm.waitForClickable({ timeout: 15_000 });
  await newTerm.click();

  const view = await $(".terminal-view[data-terminal-id]");
  await view.waitForExist({ timeout: 15_000 });
  const id = (await view.getAttribute("data-terminal-id")) ?? "";
  if (!id) throw new Error("terminal view rendered without a data-terminal-id");
  // xterm mounts its input textarea once the terminal is attached to its host.
  await $(".terminal-view .xterm-helper-textarea").waitForExist({ timeout: 15_000 });

  const title = await browser.waitUntil(
    async () => {
      const t = await browser.execute(() => {
        const tab = document.querySelector('[role="tab"][aria-selected="true"] .pane-tab__title');
        return tab?.textContent?.trim() ?? "";
      });
      return t.length > 0 ? t : false;
    },
    { timeout: 10_000, timeoutMsg: "the new terminal's tab never showed a title" },
  );
  return { id, title };
}

/** Bring a terminal's tab to the front (by its tab title) — used after another tab took focus. */
export async function showTerminalTab(title: string): Promise<void> {
  const tab = await $(`[role="tab"][title="${title}"]`);
  await tab.waitForClickable({ timeout: 10_000 });
  await tab.click();
  await $(".terminal-view .xterm-helper-textarea").waitForExist({ timeout: 10_000 });
}

/** Typing before the prompt is fine: the PTY's line discipline buffers input until bash reads. */
export async function typeInTerminal(terminalId: string, line: string): Promise<void> {
  const view = await $(`.terminal-view[data-terminal-id="${terminalId}"]`);
  await view.waitForDisplayed({ timeout: 10_000 });
  await view.click();
  // One key action per character: typed as a single `keys(line)` sequence, WebKitWebDriver
  // dropped the second of two identical consecutive keys ("error" arrived as "eror",
  // "http://" as "http:/").
  for (const ch of line) await browser.keys(ch);
  await browser.keys(ENTER);
}
