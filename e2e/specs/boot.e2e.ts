/** B1: the shipped webview and real Rust core boot to the 3-pane shell. This tier only proves the
 * real thing came up; UI behaviour belongs to the browser tier (Playwright, mocked backend). */

import { $, expect } from "@wdio/globals";

describe("boot: the shipped app comes up as the 3-pane shell", () => {
  it("renders the app shell, both rails, and an empty center pane", async () => {
    // React mounting the real dist bundle in the real webview can take a moment.
    const shell = await $('[data-testid="app-shell"]');
    await shell.waitForExist({ timeout: 30_000 });

    // Left rail (the fleet) and right rail (the workspace tree). The tree renders
    // its container testid whether or not a root has resolved yet, so presence is
    // enough to prove the rail painted.
    await expect($('[data-testid="left-rail"]')).toBeExisting();
    await expect($('[data-testid="workspace-tree"]')).toBeExisting();

    // The center pane painted: its empty-state "New terminal" button is present.
    await expect($('[data-testid="empty-pane-new-terminal"]')).toBeExisting();
  });
});
