/** Agents survive a restart (docs/design/agent-restart-restore.md §7), with the stub `claude`: a
 * graceful close resumes the mid-turn agent and reopens the other fresh; a crash restart restores
 * what remains, marked honestly. Both terminals must be painted on screen. */

import { $, $$, browser, expect } from "@wdio/globals";

import { moment, recording } from "../support/record";
import {
  agentLaunches,
  appRunning,
  argvLines,
  clearArgvLog,
  closeMainWindowGracefully,
  launchOf,
  mainWindowOrigin,
  removeSeededTranscripts,
  screenTextPixels,
  seedTranscript,
  waitForAppExit,
} from "../support/restart";
import { typeInTerminal } from "../support/terminal";
import { movePointer, osWindows } from "../support/x11";

/** W3C WebDriver key code for Enter. */
const ENTER = "\uE007";

/** The name the second agent is given on its tab — no doubled letters (WebKitWebDriver drops the second of two identical keys, e2e/README.md). */
const RENAMED = "release-checker";

/** The stub's banner lights ~400 (support/restart.ts `screenTextPixels`); a blank row 0. */
const PAINTED_ROW_PIXELS = 200;

/** `restoredMarker.ts` copy — written out here, so a change of the words is a visible change of this spec. */
const COPY = {
  resumedWorking: {
    label: "Resumed · was working",
    tooltip: "Resumed after restart — same conversation. Agent Studio was closed while it was working — tell it to continue.",
  },
  freshIdle: {
    label: "Reopened · new chat",
    tooltip: "Reopened after restart in the same folder. Its earlier conversation was never saved, so this is a new one.",
  },
  resumedUnknown: {
    label: "Resumed",
    tooltip: "Resumed after restart — same conversation. Agent Studio did not close cleanly, so it may have been working — if it was, tell it to continue.",
  },
} as const;

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Marker {
  label: string;
  tooltip: string;
}

interface RootRow {
  title: string;
  status: string;
  marker: Marker | null;
  /** Its folder (the row's subtitle tooltip). */
  cwd: string;
}

interface PaneView {
  x: number;
  /** The focused pane (where a new tab — an agent's too — opens). */
  focused: boolean;
  tabs: { title: string; active: boolean; marker: Marker | null }[];
  /** The active tab's terminal, if it is one. */
  terminalId: string | null;
}

/** `ok` must hold. On failure the report carries `what` and `context` (a bare boolean diff says nothing). */
function check(what: string, ok: boolean, context: unknown): void {
  expect({ what, ok, context }).toEqual({ what, ok: true, context });
}

/** The rail's ROOT agent rows, top to bottom: name, status pill, restored marker (row text + its tooltip). */
async function rootRows(): Promise<RootRow[]> {
  return browser.execute(() =>
    Array.from(document.querySelectorAll('[data-testid="left-rail"] li.fleet-row:not(.fleet-row--child)')).map((li) => {
      const m = li.querySelector(".fleet-row__restored");
      return {
        title: li.querySelector(".fleet-row__title")?.textContent?.trim() ?? "",
        status: li.querySelector(".fleet-row__status")?.textContent?.trim() ?? "",
        marker: m ? { label: m.textContent?.trim() ?? "", tooltip: m.getAttribute("title") ?? "" } : null,
        cwd: li.querySelector(".fleet-row__meta")?.getAttribute("title") ?? "",
      };
    }),
  );
}

/** The center's panes, left to right: their tabs (name, active, the ↻ marker's label + tooltip) and the visible terminal. */
async function panes(): Promise<PaneView[]> {
  return browser.execute(() =>
    Array.from(document.querySelectorAll(".pane"))
      .map((p) => ({
        x: Math.round(p.getBoundingClientRect().left),
        focused: p.classList.contains("pane--focused"),
        tabs: Array.from(p.querySelectorAll('[role="tab"]')).map((t) => {
          const m = t.querySelector(".pane-tab__restored");
          return {
            title: t.querySelector(".pane-tab__title")?.textContent?.trim() ?? "",
            active: t.getAttribute("aria-selected") === "true",
            marker: m ? { label: m.getAttribute("aria-label") ?? "", tooltip: m.getAttribute("title") ?? "" } : null,
          };
        }),
        terminalId: p.querySelector(".terminal-view[data-terminal-id]")?.getAttribute("data-terminal-id") ?? null,
      }))
      .sort((a, b) => a.x - b.x),
  );
}

/** Wait for `pred` over the rail and the panes; throws with what they last showed. */
async function waitForUi(pred: (rows: RootRow[], ps: PaneView[]) => boolean, what: string, timeout = 30_000): Promise<{ rows: RootRow[]; ps: PaneView[] }> {
  let last = { rows: [] as RootRow[], ps: [] as PaneView[] };
  const ok = await browser
    .waitUntil(
      async () => {
        last = { rows: await rootRows(), ps: await panes() };
        return pred(last.rows, last.ps);
      },
      { timeout, interval: 400 },
    )
    .catch(() => false);
  if (!ok) throw new Error(`${what}; the UI showed ${JSON.stringify(last)}`);
  return last;
}

/** ⚡ quick-launch an agent; resolves with its launch line (the stub's argv) once it is up. */
async function quickLaunch(): Promise<string> {
  const before = agentLaunches().length;
  const quick = await $('[data-testid="left-rail"] button[aria-label^="Quick-launch an agent"]');
  await quick.waitForClickable({ timeout: 15_000 });
  await quick.click();
  await browser.waitUntil(() => agentLaunches().length > before, { timeout: 20_000, timeoutMsg: "the quick-launched agent's claude never started" });
  return agentLaunches()[before];
}

/** The app is up again (after a launch): the shell, the rail. */
async function waitForApp(): Promise<void> {
  await $('[data-testid="app-shell"]').waitForExist({ timeout: 60_000 });
  await $('[data-testid="left-rail"]').waitForExist({ timeout: 30_000 });
}

/** An inactive tab's ✕ is hidden until hover, so the tab is brought to the front first. */
async function closeTabNamed(name: string): Promise<void> {
  const tab = await $(`.pane-tab[title="${name}"]`);
  await tab.waitForClickable({ timeout: 10_000 });
  await tab.click();
  const x = await $(`.pane-tab[title="${name}"] button[aria-label="Close ${name}"]`);
  await x.waitForClickable({ timeout: 10_000 });
  await x.click();
  const proceed = await $('[data-testid="close-terminal-proceed"]');
  if (await proceed.waitForDisplayed({ timeout: 2_000 }).catch(() => false)) await proceed.click();
}

/** Recording only: the real X pointer onto a viewport point (so a native tooltip can open, and the video shows where). */
function mirrorPointer(viewport: { x: number; y: number }): void {
  if (!recording()) return;
  const main = osWindows().sort((a, b) => b.width * b.height - a.width * a.height)[0];
  if (main) movePointer({ x: main.x + viewport.x, y: main.y + viewport.y });
}

/** Recording only: keeps native tooltips out of the stills. */
async function parkPointer(): Promise<void> {
  if (!recording()) return;
  const park = await browser.execute(() => ({ x: window.innerWidth - 120, y: window.innerHeight - 160 }));
  mirrorPointer(park);
  await browser.pause(300);
}

describe("Agents survive a restart: every open agent comes back in its own pane — resumed or fresh, renamed, marked — and a closed one stays closed", () => {
  /** What was set up before the first restart. */
  let first = { a: "", b: "", aTab: "" };

  before(() => {
    clearArgvLog();
    removeSeededTranscripts();
  });

  after(async () => {
    // Leave nothing for the next spec's app to restore: close every tab still open (an agent's close
    // removes it from `open-agents.json`, and the panes collapse back to one empty pane), then the
    // seeded conversation. Checked: a spec after this one opens a terminal from the empty pane.
    for (let i = 0; i < 6; i++) {
      // `.pane-tab`: a pane's tabs only (the view bar's tabs are `role="tab"` too).
      const names = await browser
        .execute(() => Array.from(document.querySelectorAll(".pane-tab")).map((t) => t.getAttribute("title") ?? ""))
        .catch(() => [] as string[]);
      if (names.length === 0) break;
      await closeTabNamed(names[0]).catch((e: Error) => console.warn(`[restart] cleanup: closing "${names[0]}" failed: ${e.message}`));
      await browser.pause(500);
    }
    const left = await browser.execute(() => document.querySelectorAll(".pane-tab").length).catch(() => -1);
    console.log(`[restart] cleanup: ${left} tab(s) left, ${(await rootRows().catch(() => [])).length} agent(s) in the rail`);
    removeSeededTranscripts();
  });

  it("two agents in two panes, the second renamed, the first mid-turn with a saved conversation", async () => {
    await waitForApp();
    await $('[data-testid="empty-pane-new-terminal"]').waitForExist({ timeout: 15_000 });

    // Agent A in the (only) pane.
    const lineA = await quickLaunch();
    const a = launchOf(lineA);
    check("agent A was launched fresh with a session id", a?.rung === "fresh", lineA);
    await waitForUi((rows, ps) => rows.length === 1 && ps.length === 1 && ps[0].terminalId !== null, "agent A never got its tab");

    // A second pane to the right, and agent B in it. A new agent's tab opens in the FOCUSED pane; the
    // split hands the new pane the focus, but the Split button keeps the keyboard focus in the first
    // pane, which takes it back — so, like a user, click into the new pane before launching.
    await $('button[aria-label="Split pane right"]').click();
    await waitForUi((_r, ps) => ps.length === 2, "the pane never split");
    await $(".pane__placeholder-hint").click();
    await waitForUi((_r, ps) => ps[1].focused && !ps[0].focused, "the new pane never took the focus");
    const lineB = await quickLaunch();
    const b = launchOf(lineB);
    check("agent B was launched fresh with its own session id", b?.rung === "fresh" && b.session !== a?.session, { lineA, lineB });
    await waitForUi((rows, ps) => rows.length === 2 && ps[1].tabs.length === 1 && ps[1].terminalId !== null, "agent B never got its tab in the second pane");
    first = { a: (a as { session: string }).session, b: (b as { session: string }).session, aTab: "" };

    // Rename B on its tab — the right pane's only one (an agent tab's name is the agent's: the rail follows).
    await renameTabInPane(1, RENAMED);
    const named = await waitForUi(
      (rows, ps) => ps[1].tabs[0]?.title === RENAMED && rows.some((r) => r.title === RENAMED),
      "the rename never reached B's tab and row",
    );
    console.log(`[restart] before: ${JSON.stringify(named)}; argv: ${JSON.stringify(argvLines())}`);
    first.aTab = named.ps[0].tabs[0].title;

    // A's conversation is on disk (the resume rung), and A starts a turn (the "was working" marker).
    const aRow = named.rows.find((r) => r.title !== RENAMED) as RootRow;
    const transcript = seedTranscript(first.a, aRow.cwd);
    console.log(`[restart] seeded ${transcript}`);
    await typeInTerminal(named.ps[0].terminalId as string, "/work");
    const working = await waitForUi(
      (rows) => rows.some((r) => r.title !== RENAMED && /Running/.test(r.status)),
      "agent A never read Running after its turn started (the stub's UserPromptSubmit)",
    );
    check("B stays idle", working.rows.some((r) => r.title === RENAMED && /Idle/.test(r.status)), working.rows);
    await parkPointer();
    await moment("restart-1-before", { settleMs: 800 });
  });

  it("closed like the user closes it, the app comes back with both agents in their panes — A resumed and 'was working', B reopened fresh", async () => {
    const how = closeMainWindowGracefully();
    console.log(`[restart] graceful close: ${how}`);
    check("the app exits when its main window is closed", await waitForAppExit(20_000), { stillRunning: appRunning() });
    const launched = agentLaunches().length;
    await browser.reloadSession();
    await waitForApp();

    const back = await waitForUi(
      (rows, ps) => rows.length === 2 && rows.every((r) => r.marker !== null) && ps.length === 2 && ps.every((p) => p.tabs.length === 1),
      "the two agents never came back, each with its marker, in two panes",
    );
    console.log(`[restart] after the graceful restart: ${JSON.stringify(back)}; argv: ${JSON.stringify(argvLines())}`);
    const rowA = back.rows.find((r) => r.title !== RENAMED) as RootRow;
    const rowB = back.rows.find((r) => r.title === RENAMED);
    check("B is back under its new name", rowB !== undefined, back.rows);
    // The markers: A resumed and was working (the turn the quit interrupted); B reopened fresh, idle.
    check("A's row: resumed, was working — tell it to continue", JSON.stringify(rowA.marker) === JSON.stringify(COPY.resumedWorking), rowA);
    check("B's row: reopened, a new conversation", JSON.stringify(rowB?.marker) === JSON.stringify(COPY.freshIdle), rowB);
    // In their own panes: A on the left, B (renamed) on the right; each tab's ↻ says what its row says.
    const [left, right] = back.ps;
    check("A's tab is back in the left pane", left.tabs[0].title !== RENAMED && JSON.stringify(left.tabs[0].marker) === JSON.stringify(COPY.resumedWorking), left);
    check("B's tab is back in the right pane, renamed", right.tabs[0].title === RENAMED && JSON.stringify(right.tabs[0].marker) === JSON.stringify(COPY.freshIdle), right);
    check("A's tab keeps the name it had before the restart (its folder's, like a fresh spawn)", left.tabs[0].title === first.aTab, { before: first.aTab, after: left.tabs[0].title });
    // How they were launched: A with `--resume <its id>`, B with a NEW session id (its first was never saved).
    const relaunched = agentLaunches().slice(launched).map(launchOf);
    check(
      "A resumed its own conversation; B started a new one",
      relaunched.length === 2 &&
        relaunched.some((l) => l?.rung === "resume" && l.session === first.a) &&
        relaunched.some((l) => l?.rung === "fresh" && l.session !== first.a && l.session !== first.b),
      { relaunched, first },
    );
    // The proof both terminals are painted: each pane's first xterm row on the X display holds the
    // stub's banner (a WebGL canvas can lag a draw behind memory).
    await parkPointer();
    const rowsAt = await browser.execute(() =>
      Array.from(document.querySelectorAll(".pane"))
        .sort((p, q) => p.getBoundingClientRect().left - q.getBoundingClientRect().left)
        .map((p) => {
          const r = p.querySelector(".terminal-view .xterm-screen")?.getBoundingClientRect();
          return r ? { x: r.left, y: r.top, w: r.width, h: Math.min(20, r.height) } : null;
        }),
    );
    check("both panes show a terminal", rowsAt.length === 2 && rowsAt.every((r) => r !== null), rowsAt);
    const origin = mainWindowOrigin();
    const lit = (): number[] => rowsAt.map((r) => screenTextPixels({ x: origin.x + (r as Box).x, y: origin.y + (r as Box).y, w: (r as Box).w, h: (r as Box).h }));
    let counts = lit();
    for (let i = 0; i < 20 && counts.some((n) => n < PAINTED_ROW_PIXELS); i++) {
      await browser.pause(250);
      counts = lit();
    }
    console.log(`[restart] text pixels in the first terminal row, from the X screen: A (left) ${counts[0]}, B (right) ${counts[1]}`);
    check("A's terminal (resumed, unfocused pane) is painted — its banner is on the screen", counts[0] >= PAINTED_ROW_PIXELS, { textPixels: counts[0], min: PAINTED_ROW_PIXELS, row: rowsAt[0], origin });
    check("B's terminal is painted — its banner is on the screen", counts[1] >= PAINTED_ROW_PIXELS, { textPixels: counts[1], min: PAINTED_ROW_PIXELS, row: rowsAt[1], origin });
    await moment("restart-2-after", { settleMs: 800 });

    // The tooltip: A's tab's ↻, hovered (the real X pointer too, so the native tooltip opens on video).
    const at = await browser.execute(() => {
      const el = Array.from(document.querySelectorAll(".pane"))
        .sort((p, q) => p.getBoundingClientRect().left - q.getBoundingClientRect().left)[0]
        ?.querySelector(".pane-tab__restored");
      const r = el?.getBoundingClientRect();
      return r ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : null;
    });
    check("A's tab has its ↻ marker", at !== null, at);
    mirrorPointer(at as { x: number; y: number });
    await browser.action("pointer", { parameters: { pointerType: "mouse" } }).move({ origin: "viewport", ...(at as { x: number; y: number }) }).perform();
    await moment("restart-3-tooltip", { settleMs: 1_800 });
  });

  it("an agent closed by the user stays closed: after the next restart only the other comes back", async () => {
    await closeTabNamed(RENAMED);
    await waitForUi((rows, ps) => rows.length === 1 && ps.length === 1, "closing B's tab did not close B (its row and pane)");
    const launched = agentLaunches().length;
    await browser.reloadSession();
    await waitForApp();
    const back = await waitForUi((rows, ps) => rows.length === 1 && rows[0].marker !== null && ps.length === 1 && ps[0].tabs.length === 1, "A never came back alone");
    // Give a late restore every chance to bring B back too — it must not.
    await browser.pause(3_000);
    const settled = { rows: await rootRows(), ps: await panes() };
    console.log(`[restart] after the second restart: ${JSON.stringify(settled)}; argv: ${JSON.stringify(argvLines())}`);
    check("only A is back", settled.rows.length === 1 && settled.rows[0].title !== RENAMED && settled.ps.every((p) => p.tabs.every((t) => t.title !== RENAMED)), settled);
    const relaunched = agentLaunches().slice(launched).map(launchOf);
    check("only A was launched — resumed again — and nothing for the closed one", relaunched.length === 1 && relaunched[0]?.rung === "resume" && relaunched[0].session === first.a, { relaunched, first });
    // This time tauri-driver ENDED the app (a session's end kills the browser process — no window ✕, no
    // `Destroyed`, nothing recorded): the marker must not guess. Not "was working", not "idle" — it says
    // the app did not close cleanly and leaves the user to judge (restoredMarker.ts, the crash row).
    const marker = back.rows[0].marker as Marker;
    check("A's marker: resumed — and honest that the app did not close cleanly", JSON.stringify(marker) === JSON.stringify(COPY.resumedUnknown), marker);
    check("A's tab says the same", JSON.stringify(back.ps[0].tabs[0].marker) === JSON.stringify(COPY.resumedUnknown), back.ps[0].tabs[0]);
    await parkPointer();
    await moment("restart-4-closed-one-stays-closed", { settleMs: 800 });
  });
});

/** Rename the only tab of pane `index` (left to right): double-click its name, type, Enter. */
async function renameTabInPane(index: number, name: string): Promise<void> {
  const titles = await $$(".pane .pane-tab__title");
  const placed = await Promise.all(Array.from(titles).map(async (t) => ({ t, x: (await t.getLocation()).x })));
  const target = placed.sort((a, b) => a.x - b.x)[index]?.t;
  if (!target) throw new Error(`pane ${index} has no tab to rename`);
  await target.doubleClick();
  // InlineEditInput opens focused with its whole value selected and commits on blur — so type over the
  // selection (one key at a time: WebKitWebDriver drops the second of two identical keys in one
  // sequence), never `setValue`, whose clear step blurs the input and commits the old name.
  const input = await $(".pane-tab__title-input");
  await input.waitForDisplayed({ timeout: 5_000 });
  for (const ch of name) await browser.keys(ch);
  await browser.keys(ENTER);
}
