/** F1: find overlays default to the focused workspace (`src/features/find/contextScope.ts`), with a
 * second root `gazelle` in /tmp. recent-projects.json is seeded only in the container (/.dockerenv)
 * and restored after, so later specs launch where they expect. */

import { $, $$, browser, expect } from "@wdio/globals";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { openWithFindFiles, pressCtrl, pressCtrlShift } from "../support/find";
import { moment } from "../support/record";

const GAZELLE = "/tmp/e2e-roots/gazelle";
/** The launch workspace — the app's primary root (wdio.conf.ts starts tauri-driver in it). */
const WORKSPACE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "workspace");
/** Tauri's app_config_dir on Linux for identifier com.agentstudio.app (recent_projects.rs). */
const RECENTS = path.join(
  process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"),
  "com.agentstudio.app",
  "recent-projects.json",
);

/** Make the second root: a small git repo whose files are named so a hit says where it came from. */
function makeGazelle(): void {
  fs.rmSync(GAZELLE, { recursive: true, force: true });
  fs.mkdirSync(path.join(GAZELLE, "src"), { recursive: true });
  fs.writeFileSync(path.join(GAZELLE, "src", "gazelle_main.rs"), "// gazelle fixture: the second workspace root\nfn main() {}\n");
  fs.writeFileSync(path.join(GAZELLE, "GAZELLE_NOTES.md"), "# gazelle\n\nA fixture repo for the find-scope E2E.\n");
  const git = (...args: string[]): void => {
    execFileSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@agentstudio.test", ...args], { cwd: GAZELLE, stdio: "ignore" });
  };
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "gazelle fixture");
}

let savedRecents: string | null = null;

function seedRecents(): void {
  // The app config dir of a REAL user holds their recents — only ever touch the container's.
  if (!fs.existsSync("/.dockerenv")) throw new Error("find-scope seeds the app's recent projects: run it in Docker (scripts/e2e-linux.mjs)");
  savedRecents = fs.existsSync(RECENTS) ? fs.readFileSync(RECENTS, "utf8") : null;
  fs.mkdirSync(path.dirname(RECENTS), { recursive: true });
  fs.writeFileSync(RECENTS, JSON.stringify([GAZELLE]));
}

function restoreRecents(): void {
  if (!fs.existsSync("/.dockerenv")) return;
  if (savedRecents === null) fs.rmSync(RECENTS, { force: true });
  else fs.writeFileSync(RECENTS, savedRecents);
}

/** The workspace an open overlay is scoped to: the select's value and the option the eye reads. */
async function scopeOf(overlay: "find-files" | "find-in-files"): Promise<{ value: string; label: string }> {
  return browser.execute((id: string) => {
    const sel = document.querySelector<HTMLSelectElement>(`[data-testid="${id}"] select[aria-label="Search workspace"]`);
    return { value: sel?.value ?? "", label: sel?.selectedOptions[0]?.textContent?.trim() ?? "" };
  }, overlay);
}

async function pressFindHotkey(letter: "f" | "o"): Promise<void> {
  await pressCtrlShift(letter);
}

async function closeOverlay(overlay: string): Promise<void> {
  await browser.keys("Escape");
  await browser.waitUntil(async () => !(await $(`[data-testid="${overlay}"]`).isExisting()), {
    timeout: 5_000,
    timeoutMsg: `Esc did not close ${overlay}`,
  });
}

async function workspaceRootPaths(): Promise<string[]> {
  return browser.execute(() =>
    Array.from(document.querySelectorAll('[data-testid="workspace-root"]')).map((e) => e.getAttribute("data-path") ?? ""),
  );
}

/** Click a file in the Files rail, expanding its root (and folders) first if they are collapsed. */
async function openFromFiles(file: string): Promise<void> {
  const row = $(`[data-testid="ws-file"][data-path="${file}"]`);
  if (!(await row.isExisting())) {
    const root = (await workspaceRootPaths()).find((r) => file.startsWith(`${r}/`));
    if (!root) throw new Error(`no Files root holds ${file}`);
    await browser.waitUntil(
      async () => {
        if (await row.isExisting()) return true;
        // Expand whatever is on the way: the root header, then each folder of the path.
        const dirs = await browser.execute(
          (f: string) =>
            Array.from(document.querySelectorAll('[data-testid="ws-dir"]'))
              .map((d) => d.getAttribute("data-path") ?? "")
              .filter((d) => f.startsWith(`${d}/`)),
          file,
        );
        if (dirs.length > 0) {
          for (const d of dirs) {
            const dir = await $(`[data-testid="ws-dir"][data-path="${d}"]`);
            if ((await dir.getAttribute("aria-expanded")) !== "true") await dir.click();
          }
        } else {
          await $(`[data-testid="workspace-root"][data-path="${root}"]`).click();
        }
        return row.isExisting();
      },
      { timeout: 20_000, interval: 750, timeoutMsg: `could not reveal ${file} in the Files rail` },
    );
  }
  await row.click();
  await $(".cm-content").waitForDisplayed({ timeout: 20_000 });
  await browser.waitUntil(
    async () => (await browser.execute(() => document.querySelector('[role="tab"][aria-selected="true"] .pane-tab__title')?.textContent?.trim() ?? "")) === path.basename(file),
    { timeout: 10_000, timeoutMsg: `${path.basename(file)} did not become the active tab` },
  );
}

describe("find scope follows the focused workspace (two roots: workspace + gazelle)", () => {

  before(async () => {
    makeGazelle();
    seedRecents();
    await $('[data-testid="app-shell"]').waitForExist({ timeout: 30_000 });
    // The frontend read its recents at boot (before this spec seeded them): reload the page so it
    // reads them again — the Rust core, which owns the list, is untouched by a page reload.
    await browser.refresh();
    await $('[data-testid="app-shell"]').waitForExist({ timeout: 30_000 });
    const quick = await $('[data-testid="left-rail"] button[aria-label="Quick-launch an agent in gazelle"]');
    await quick.waitForClickable({ timeout: 20_000 });
    await quick.click();
    // A root agent's folder is a workspace root: the Files rail now shows both.
    await browser.waitUntil(async () => (await workspaceRootPaths()).includes(GAZELLE), {
      timeout: 20_000,
      timeoutMsg: "the gazelle agent's folder never became a Files root",
    });
    await $(".terminal-view[data-terminal-id] .xterm-helper-textarea").waitForExist({ timeout: 20_000 });
  });

  after(() => {
    restoreRecents();
  });

  it("gazelle console focused → Ctrl+Shift+F searches gazelle, and only gazelle", async () => {
    // Focus the agent's console (its PTY runs in gazelle) the way a user does: click into it.
    await $(".terminal-view[data-terminal-id]").click();
    await moment("gazelle-console-focused");
    await pressFindHotkey("f");
    await $('[data-testid="find-in-files"]').waitForDisplayed({ timeout: 10_000 });
    expect(await scopeOf("find-in-files")).toEqual({ value: GAZELLE, label: "gazelle" });

    // "fixture" is in every file of BOTH roots; scoped to gazelle, only gazelle files may answer.
    const input = await $('[data-testid="find-in-files"] input[aria-label="Search in files"]');
    await input.setValue("fixture");
    let names: string[] = [];
    await browser.waitUntil(
      async () => {
        names = await browser.execute(() =>
          Array.from(document.querySelectorAll('[data-testid="find-in-files"] [data-testid="find-file"] .find-group__name')).map(
            (n) => n.textContent?.trim() ?? "",
          ),
        );
        return names.length > 0;
      },
      { timeout: 20_000, timeoutMsg: "Find in Files found nothing for `fixture` in gazelle" },
    );
    expect(names.every((n) => /gazelle/i.test(n))).toBe(true);
    await moment("find-in-files-scoped-to-gazelle");
    await closeOverlay("find-in-files");
  });

  it("gazelle file focused → Ctrl+Shift+O finds files in gazelle", async () => {
    await openFromFiles(`${GAZELLE}/src/gazelle_main.rs`);
    await $(".cm-content").click();
    await pressFindHotkey("o");
    await $('[data-testid="find-files"]').waitForDisplayed({ timeout: 10_000 });
    expect(await scopeOf("find-files")).toEqual({ value: GAZELLE, label: "gazelle" });
    await $('[data-testid="find-files"] input[aria-label="Find files"]').setValue("gazelle");
    await browser.waitUntil(async () => (await $$('[data-testid="find-files"] [data-testid="find-file-hit"]').length) > 0, {
      timeout: 20_000,
      timeoutMsg: "Find Files listed nothing for `gazelle` in gazelle",
    });
    await moment("find-files-scoped-to-gazelle");
    await closeOverlay("find-files");
  });

  it("bare Ctrl+O (no Shift) quick-opens too, on the focused workspace", async () => {
    // The active tab is still gazelle_main.rs (previous test).
    await $(".cm-content").click();
    await pressCtrl("o");
    await $('[data-testid="find-files"]').waitForDisplayed({ timeout: 10_000 });
    expect(await scopeOf("find-files")).toEqual({ value: GAZELLE, label: "gazelle" });
    await moment("bare-ctrl-o-quick-open-gazelle");
    await closeOverlay("find-files");
  });

  it("bare Ctrl+F is the editor's own find in an editor, and Find in Files where nothing claims it", async () => {
    // In the editor, Ctrl+F belongs to CodeMirror's find bar: three guards in FindKeysShortcut keep
    // the fallback from stealing it, and only removing all three turns this red.
    await $(".cm-content").click();
    await pressCtrl("f");
    const editorFind = $('.cm-editor input[aria-label="Find"]');
    await editorFind.waitForDisplayed({ timeout: 10_000 });
    // The fallback decides a macrotask after the key; give it far longer than that to misfire.
    await browser.pause(750);
    await expect($('[data-testid="find-in-files"]')).not.toBeExisting();
    await moment("bare-ctrl-f-in-editor-is-editor-find");
    await $('.cm-editor button[aria-label="Close find bar"]').click();
    await editorFind.waitForExist({ reverse: true, timeout: 5_000 });

    // A tab header has no find of its own, so Ctrl+F there is Find in Files. WebdriverIO 10's `$`
    // throws on multiple matches, and every pane has a selected tab, so take the first.
    await $$('[role="tab"][aria-selected="true"]')[0].click();
    const focused = await browser.execute(() => {
      const a = document.activeElement;
      return a ? `${a.tagName.toLowerCase()}${a.closest(".cm-editor, .xterm") ? " (inside an editor/terminal)" : ""}` : "none";
    });
    expect(focused).not.toMatch(/inside an editor/);
    await pressCtrl("f");
    await $('[data-testid="find-in-files"]').waitForDisplayed({ timeout: 10_000 });
    expect(await scopeOf("find-in-files")).toEqual({ value: GAZELLE, label: "gazelle" });
    await moment("bare-ctrl-f-on-tab-header-find-in-files-gazelle");
    await closeOverlay("find-in-files");
  });

  it("workspace file focused → Ctrl+Shift+O is scoped to workspace instead (the default follows focus)", async () => {
    // The launch workspace is the PRIMARY root: searchable, but not a Files-rail root (that rail
    // lists agent and opened folders). Open its file through Find Files, picking it in the dropdown.
    await openWithFindFiles("library.rs", "workspace");
    if (await $('[data-testid="find-files"]').isExisting()) await closeOverlay("find-files");
    await $(".cm-content").click();
    await pressFindHotkey("o");
    await $('[data-testid="find-files"]').waitForDisplayed({ timeout: 10_000 });
    const scope = await scopeOf("find-files");
    expect(scope.label).toBe("workspace");
    expect(scope.value).toBe(WORKSPACE);
    await moment("find-files-scoped-to-workspace");
    await closeOverlay("find-files");
  });
});
