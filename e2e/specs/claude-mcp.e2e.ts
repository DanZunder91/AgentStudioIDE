/** Settings' "Add Agent Studio to Claude Code" with `claude` stubbed (claude-stub.sh logs argv).
 * Its argv has no `--session-id`/`--resume`, so the restart spec reading that log ignores it. */
import fs from "node:fs";
import path from "node:path";

import { $, browser, expect } from "@wdio/globals";

const ARGV_LOG = path.join(process.env.TMPDIR || "/tmp", "agentstudio-e2e-claude-argv.log");

/** The stub's runs with `mcp` as the first word, oldest first. */
function mcpRuns(): string[] {
  if (!fs.existsSync(ARGV_LOG)) return [];
  return fs
    .readFileSync(ARGV_LOG, "utf8")
    .split("\n")
    .filter((l) => l.startsWith("mcp "));
}

const item = () => $('[data-testid="settings-claude-mcp"]');

/** Wait for an answer that is not "checking", "working" or `previous`, and return it. */
async function settled(previous = ""): Promise<string> {
  let state = "";
  await browser.waitUntil(
    async () => {
      state = (await (await item()).getAttribute("data-state")) ?? "";
      return !["", "checking", "working", previous].includes(state);
    },
    { timeout: 30_000, timeoutMsg: "the Claude Code item never got an answer" },
  );
  return state;
}

describe("Settings: Add Agent Studio to Claude Code", () => {
  it("asks Claude Code on open, adds this binary on click, and removes it again", async () => {
    const before = mcpRuns().length;
    await (await $('[aria-label="Settings"]')).click();
    await (await $('[data-testid="settings-popover"]')).waitForDisplayed({ timeout: 10_000 });

    // Opening the menu asked `claude mcp get agent-studio`. The stub answers in no form the app
    // knows, so the item says so — and still offers the add.
    expect(await settled()).toBe("failed");
    await expect(item()).toHaveText(expect.stringContaining("Add Agent Studio to Claude Code"));
    await expect($('[data-testid="settings-claude-mcp-hint"]')).toHaveText(
      expect.stringContaining("could not read"),
    );
    expect(mcpRuns().slice(before)).toEqual(["mcp get agent-studio"]);

    // The add: Claude Code's own command, with this app's binary by absolute path, then a look at
    // what Claude Code now runs (the stub's answer is unreadable, so the add's exit code stands).
    await (await item()).click();
    expect(await settled("failed")).toBe("installed");
    await expect(item()).toHaveText(expect.stringContaining("Remove Agent Studio from Claude Code"));
    const add = mcpRuns().slice(before)[1] ?? "";
    // Absolute on either OS: `/…` or `C:\…`.
    expect(add).toMatch(/^mcp add --scope user agent-studio -- (\/|[A-Za-z]:\\).*agent-studio.* mcp$/);
    expect(mcpRuns().slice(before)[2]).toBe("mcp get agent-studio");

    // And the removal.
    await (await item()).click();
    expect(await settled("installed")).toBe("notInstalled");
    await expect(item()).toHaveText(expect.stringContaining("Add Agent Studio to Claude Code"));
    expect(mcpRuns().slice(before)[3]).toBe("mcp remove --scope user agent-studio");

    // The popover stayed open throughout (the answer is shown in the item); Esc closes it.
    await browser.keys("Escape");
    await (await $('[data-testid="settings-popover"]')).waitForExist({ reverse: true, timeout: 5_000 });
  });
});
