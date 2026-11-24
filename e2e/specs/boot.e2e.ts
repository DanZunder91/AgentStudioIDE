/**
 * B1 — the app boots to the 3-pane shell.
 *
 * The CI-only "real shipped webview + real Rust core are wired" smoke (half 1 of
 * 2). It proves the production artifact launches, React mounts against the real
 * frontendDist, and the shell paints: the app root, both rails, and a center
 * pane. Deeper UI behaviour is owned by the browser tier (Playwright, mocked
 * backend) — this tier's sole remit is "the real thing came up".
 */

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
