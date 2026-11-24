/**
 * T1 — tab tear-off in the REAL app (docs/design/tab-tearoff.md): a tab leaves the main
 * window for a window of its own and comes back, and what it holds survives the trip.
 *
 * The real chain, no mocks: right-click a tab ▸ "Move to New Window" → `tearoff_open` (Rust) builds a
 * second OS window → its `TearoffApp` claims the tab from its mailbox → a terminal REATTACHES to the
 * same PTY (the shell never moves), an editor arrives with its unsaved buffer. "Move to Main Window"
 * in the detached window sends it home and the detached window closes itself.
 *
 * Three independent witnesses that a second window exists, because each can lie alone:
 *   - the X server (`xdotool search`, support/x11.ts) — an OS window titled "<tab> — Agent Studio";
 *   - Rust's tear-off ledger (`tearoff_holdings` over real IPC) — which window holds which tab;
 *   - WebDriver's window handles — the detached webview is driven directly for the move back.
 *
 * "The terminal output survived" is proven by behaviour, not pixels: the shell prints its own PID
 * before the trip and again after it — the same PID means the same shell process in the same PTY,
 * and the first command's output is still in that terminal's stream.
 *
 * The drag-out gesture (release a tab outside the window → new window at the cursor) is driven with
 * real X11 pointer events (xdotool), the only way to end an HTML5 drag outside a webview.
 */

import { $, browser, expect } from "@wdio/globals";

import { moment } from "../support/record";
import { terminalText } from "../support/real-service";
import { openTerminalFromEmptyPane, typeInTerminal, type OpenedTerminal } from "../support/terminal";
import { openWithFindFiles } from "../support/find";
import { describeDisplay, osWindows, realDrag, x11Available } from "../support/x11";

interface Holding {
  label: string;
  keys: string[];
}

/** Rust's ledger of which window holds which tab (`tearoff_holdings`, real IPC). */
async function holdings(): Promise<Holding[]> {
  return browser.execute(async () => {
    const tauri = (window as unknown as { __TAURI_INTERNALS__?: { invoke: (c: string) => Promise<unknown> } })
      .__TAURI_INTERNALS__;
    return tauri ? ((await tauri.invoke("tearoff_holdings")) as Holding[]) : [];
  });
}

/** Wait until the X server shows exactly `n` app windows; returns them. */
async function waitForOsWindows(n: number, what: string): Promise<{ name: string }[]> {
  let seen: { name: string }[] = [];
  await browser
    .waitUntil(
      async () => {
        seen = osWindows();
        return seen.length === n;
      },
      { timeout: 20_000, interval: 300 },
    )
    .catch(() => {
      throw new Error(
        `${what}: expected ${n} Agent Studio window(s), found ${JSON.stringify(seen)}; every visible window: ${describeDisplay()}`,
      );
    });
  return seen;
}

/** Right-click a tab (by its title) and pick a menu item. */
async function tabMenu(title: string, item: string): Promise<void> {
  const tab = await $(`[role="tab"][title="${title}"]`);
  await tab.waitForDisplayed({ timeout: 15_000 });
  await tab.click({ button: "right" });
  const entry = await $(`//*[@role="menu"]//button[@role="menuitem"][normalize-space(.)="${item}"]`);
  await entry.waitForClickable({ timeout: 10_000 });
  try {
    await entry.click();
  } catch (e) {
    // "Move to Main Window" from the tab's last window: the detached window hands the tab over
    // and closes ITSELF while the click command is still answering — WebKitWebDriver then reports
    // "no such window". That is the success path; anything else is a real failure.
    if (!/no such window/i.test(String(e))) throw e;
  }
}

/** The handle of the main window (the session's first). */
let mainHandle = "";

/** Switch WebDriver into the one window that is not the main one. */
async function switchToDetached(): Promise<string> {
  const other = await browser.waitUntil(
    async () => (await browser.getWindowHandles()).find((h) => h !== mainHandle) ?? false,
    { timeout: 20_000, interval: 300, timeoutMsg: "WebDriver never saw a second window handle" },
  );
  await browser.switchToWindow(other);
  await $('[data-testid="tearoff-shell"]').waitForExist({ timeout: 20_000 });
  return other;
}

async function backToMain(): Promise<void> {
  await browser.switchToWindow(mainHandle);
  await $('[data-testid="app-shell"]').waitForExist({ timeout: 10_000 });
}

/** Every `tty` answer the terminal printed (`/dev/pts/<n>` lines), once at least `n` are there. */
async function waitForTtys(terminalId: string, n: number): Promise<string[]> {
  let ttys: string[] = [];
  await browser
    .waitUntil(
      async () => {
        ttys = (await terminalText(terminalId)).match(/^\/dev\/pts\/\d+(?=\s*$)/gm) ?? [];
        return ttys.length >= n;
      },
      { timeout: 20_000, interval: 300 },
    )
    .catch(async () => {
      throw new Error(`expected ${n} tty line(s); terminal:\n${await terminalText(terminalId)}`);
    });
  return ttys;
}

/**
 * `ps -o pid=,args=` lists the processes on this terminal: the shell is the line that is not `ps`.
 * Waits until a listing shows `pid` running bash — the same shell as before the trip.
 */
async function waitForShellInPs(terminalId: string, pid: string): Promise<void> {
  await browser
    .waitUntil(
      async () => new RegExp(`^\\s*${pid}\\s+\\S*bash\\b`, "m").test(await terminalText(terminalId)),
      { timeout: 20_000, interval: 300 },
    )
    .catch(async () => {
      throw new Error(`ps never listed the shell ${pid}; terminal:\n${await terminalText(terminalId)}`);
    });
}

/** The PID the shell printed for `marker` (`<marker>_<pid>`), or "" if not (yet) printed. */
async function printedPid(terminalId: string, marker: string): Promise<string> {
  const text = await terminalText(terminalId);
  return new RegExp(`^${marker}_(\\d+)\\s*$`, "m").exec(text)?.[1] ?? "";
}

async function waitForPid(terminalId: string, marker: string): Promise<string> {
  let pid = "";
  await browser
    .waitUntil(async () => (pid = await printedPid(terminalId, marker)) !== "", { timeout: 20_000, interval: 300 })
    .catch(async () => {
      throw new Error(`the shell never printed ${marker}_<pid>; terminal:\n${await terminalText(terminalId)}`);
    });
  return pid;
}

/** A terminal still waits for the software-GL screen to paint output already read off the log stream. */
const TERMINAL_SETTLE = { settleMs: 2_000 };

describe("tab tear-off: Move to New Window and back, in the real app", () => {
  let term: OpenedTerminal;
  let shellPid = "";
  let shellTty = "";

  before(async () => {
    expect(x11Available()).toBe(true);
    term = await openTerminalFromEmptyPane();
    mainHandle = await browser.getWindowHandle();
    // `${$}` is the shell's PID (`$$` without two identical keys in a row: WebKitWebDriver drops the
    // second of a repeated key — terminal.ts). The output line `TEAROFF_PID_<digits>` can only come from the shell.
    // `tty` names the PTY device the shell is attached to — the same device after the trip is the
    // same PTY.
    await typeInTerminal(term.id, "echo TEAROFF_PID_${$}; tty");
    shellPid = await waitForPid(term.id, "TEAROFF_PID");
    shellTty = (await waitForTtys(term.id, 1))[0];
    await waitForOsWindows(1, "before any tear-off");
  });

  it("a terminal moves to a second OS window with its PTY, and back with its output", async () => {
    await moment("terminal-before-move", TERMINAL_SETTLE);
    await tabMenu(term.title, "Move to New Window");

    // Witness 1 — the X server: a second top-level window, titled after the tab.
    const wins = await waitForOsWindows(2, "after Move to New Window");
    expect(wins.some((w) => w.name.startsWith(`${term.title} — Agent Studio`))).toBe(true);
    // Witness 2 — Rust's ledger: a tearoff-* window holds this terminal; main no longer shows its tab.
    await browser.waitUntil(
      async () => (await holdings()).some((h) => h.label.startsWith("tearoff-") && h.keys.some((k) => k.includes(term.id))),
      { timeout: 20_000, timeoutMsg: "the tear-off ledger never put the terminal in a detached window" },
    );
    await browser.waitUntil(async () => !(await $(`[role="tab"][title="${term.title}"]`).isExisting()), {
      timeout: 10_000,
      timeoutMsg: "the main window still shows the moved tab",
    });

    // Witness 3 — WebDriver: drive the detached window itself. The SAME terminal id reattached.
    await switchToDetached();
    await $(`.terminal-view[data-terminal-id="${term.id}"]`).waitForDisplayed({ timeout: 20_000 });
    await expect($(`[role="tab"][title="${term.title}"]`)).toBeDisplayed();
    // Type into the reattached terminal: the same PTY and the same shell answer. Only UNSHIFTED keys
    // from here on: once a second window has existed, WebKitWebDriver delivers characters without
    // Shift — in that window AND back in main (`echo DETACHED_PID_$$` arrives as `echo detached-pid-44`).
    // A driver quirk, not the app: `tty` and `ps -o pid=,args=` need no Shift.
    await typeInTerminal(term.id, "tty");
    expect(await waitForTtys(term.id, 2)).toEqual([shellTty, shellTty]);
    await typeInTerminal(term.id, "ps -o pid=,args=");
    await waitForShellInPs(term.id, shellPid);
    await moment("terminal-in-second-window", TERMINAL_SETTLE);

    await tabMenu(term.title, "Move to Main Window");
    await backToMain();
    await waitForOsWindows(1, "after Move to Main Window (the detached window closes itself)");
    await $(`.terminal-view[data-terminal-id="${term.id}"]`).waitForDisplayed({ timeout: 20_000 });
    // Survived: the output from BEFORE the trip is still this terminal's, and the shell is the same.
    expect(await printedPid(term.id, "TEAROFF_PID")).toBe(shellPid);
    await typeInTerminal(term.id, "tty");
    expect(await waitForTtys(term.id, 3)).toEqual([shellTty, shellTty, shellTty]);
    await moment("terminal-back-in-main", TERMINAL_SETTLE);
  });

  it("an editor with unsaved text moves out and back, still unsaved, text intact", async () => {
    // A fresh app has no Files root for the launch workspace; Find Files searches it.
    await openWithFindFiles("library.rs");
    const content = await $(".cm-content");
    await content.waitForDisplayed({ timeout: 20_000 });
    await content.click();
    await browser.keys(["Control", "Home"]);
    // Unshifted and without a repeated key (see the Shift note above; terminal.ts on repeats).
    const line = "e2e unsaved edit, never saved";
    for (const ch of line) await browser.keys(ch);
    await browser.keys("Enter");
    const tabTitle = "library.rs";
    await expect($(`[role="tab"][title="${tabTitle}"] .pane-tab__dirty`)).toBeExisting();
    await moment("editor-unsaved-before-move");

    await tabMenu(tabTitle, "Move to New Window");
    await waitForOsWindows(2, "after moving the editor");
    await switchToDetached();
    await $(".cm-content").waitForDisplayed({ timeout: 20_000 });
    await browser.waitUntil(async () => (await $(".cm-content").getText()).includes(line), {
      timeout: 15_000,
      timeoutMsg: "the detached editor does not show the unsaved line",
    });
    await expect($(`[role="tab"][title="${tabTitle}"] .pane-tab__dirty`)).toBeExisting();
    await moment("editor-unsaved-in-second-window");

    await tabMenu(tabTitle, "Move to Main Window");
    await backToMain();
    await waitForOsWindows(1, "after moving the editor home");
    await browser.waitUntil(async () => (await $(".cm-content").getText()).includes(line), {
      timeout: 15_000,
      timeoutMsg: "the editor came home without its unsaved line",
    });
    await expect($(`[role="tab"][title="${tabTitle}"] .pane-tab__dirty`)).toBeExisting();
    await moment("editor-back-in-main-still-unsaved");
  });

  it("dragging a tab out of the window opens it in a new window where it was released (real X11 drag)", async () => {
    const tab = await $(`[role="tab"][title="${term.title}"]`);
    await tab.waitForClickable({ timeout: 10_000 });
    await tab.click();
    // Where the tab is on the SCREEN: the window's origin (X server) + the webview's offset inside
    // it (a GTK menu bar sits above the webview) + the tab's rect in the page.
    // The main window is titled "Agent Studio <version> (<commit>)"; a detached one "<tab> — Agent Studio".
    const [main] = osWindows().filter((w) => w.name.startsWith("Agent Studio"));
    if (!main) throw new Error(`no main window on the X server: ${JSON.stringify(osWindows())}`);
    const rect = await browser.execute((t: string) => {
      const el = document.querySelector(`[role="tab"][title="${t}"]`);
      const r = el?.getBoundingClientRect();
      return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2, innerH: window.innerHeight, innerW: window.innerWidth } : null;
    }, term.title);
    if (!rect) throw new Error("the terminal tab has no rect");
    const from = { x: main.x + (main.width - rect.innerW) + rect.x, y: main.y + (main.height - rect.innerH) + rect.y };
    // Release over the bare desktop, right of the main window (the screen is wider than it).
    const to = { x: main.x + main.width + 60, y: from.y + 220 };
    await realDrag(from, to);

    await waitForOsWindows(2, "after dragging the tab out of the window");
    await browser.waitUntil(
      async () => (await holdings()).some((h) => h.label.startsWith("tearoff-") && h.keys.some((k) => k.includes(term.id))),
      { timeout: 20_000, timeoutMsg: "the drag-out did not hand the terminal to a detached window" },
    );
    // The editor left behind in main is untouched by the drag: still unsaved. Asserted on the DOM: the
    // dot is hidden by `:hover`, and after the X11 drag leaves the window WebKitGTK keeps the tab now
    // sitting where the dragged one was "hovered" (it shows a × instead of the dot) — through
    // WebDriver's synthetic moves, real pointer motion AND a real click on main
    // (`matches(":hover")` stays true). So the still shows a ×; the marker is there all the same.
    await expect($('[role="tab"][title="library.rs"] .pane-tab__dirty')).toBeExisting();
    await moment("terminal-dragged-out-to-new-window", TERMINAL_SETTLE);

    // Home again, by the menu, so the session ends with one window.
    await switchToDetached();
    await tabMenu(term.title, "Move to Main Window");
    await backToMain();
    await waitForOsWindows(1, "after moving the dragged-out tab home");
    await $(`.terminal-view[data-terminal-id="${term.id}"]`).waitForDisplayed({ timeout: 20_000 });
  });
});
