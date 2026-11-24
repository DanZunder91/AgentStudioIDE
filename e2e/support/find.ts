/**
 * Open a file the way a user does when the Files rail has no root for it: Find Files
 * (Ctrl+Shift+O — the Linux spelling of Cmd+Shift+O), type the name, click the hit.
 *
 * The Files rail lists agent folders and opened folders only (`workspaceRoots`), so in a fresh app
 * the launch workspace has no tree to click in — but Find Files searches it (the primary root).
 */

import { $, $$, browser } from "@wdio/globals";

/** Press a Ctrl+Shift+<letter> hotkey: one key action, all three down then all up. */
export async function pressCtrlShift(letter: string): Promise<void> {
  await browser.keys(["Control", "Shift", letter]);
}

/** Press a bare Ctrl+<letter> (no Shift) — the Linux spelling of Cmd+<letter>. */
export async function pressCtrl(letter: string): Promise<void> {
  await browser.keys(["Control", letter]);
}

/**
 * Open `name` through Find Files. `workspaceLabel` picks the Workspace dropdown first (the option
 * text, e.g. "workspace"); omitted, the overlay's own default scope is used.
 */
export async function openWithFindFiles(name: string, workspaceLabel?: string): Promise<void> {
  if (!(await $('[data-testid="find-files"]').isExisting())) await pressCtrlShift("o");
  const panel = await $('[data-testid="find-files"]');
  await panel.waitForDisplayed({ timeout: 10_000 });
  if (workspaceLabel) {
    await $('[data-testid="find-files"] select[aria-label="Search workspace"]').selectByVisibleText(workspaceLabel);
  }
  await $('[data-testid="find-files"] input[aria-label="Find files"]').setValue(name);
  const hit = await browser.waitUntil(
    async () => {
      for (const h of await $$('[data-testid="find-files"] [data-testid="find-file-hit"]')) {
        if ((await h.$(".find-file__name").getText()).trim() === name) return h;
      }
      return false;
    },
    { timeout: 20_000, interval: 300, timeoutMsg: `Find Files never listed ${name}` },
  );
  await hit.click();
  await $(".cm-content").waitForDisplayed({ timeout: 20_000 });
  await browser.waitUntil(
    async () =>
      (await browser.execute(() => document.querySelector('[role="tab"][aria-selected="true"] .pane-tab__title')?.textContent?.trim() ?? "")) ===
      name,
    { timeout: 10_000, timeoutMsg: `${name} did not become the active tab` },
  );
}
