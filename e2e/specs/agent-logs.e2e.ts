/** L1: a real PTY's output through the logstream hub to the Agent logs tab, no mocks. Assert on
 * OUTPUT only (expanded `$RANDOM`, `error: boom`), which no echoed command line can produce. */

import { $, browser, expect } from "@wdio/globals";

import { snap } from "../support/real-service";
import { openTerminalFromEmptyPane, showTerminalTab, typeInTerminal, type OpenedTerminal } from "../support/terminal";

interface RowView {
  text: string;
  /** The row's `data-source` — set on every row, whether or not the Source column is shown. */
  source: string;
  className: string;
}

/** Every rendered RAW log row, in one round-trip (the list is virtualised; follow keeps the tail in view). */
async function logRows(): Promise<RowView[]> {
  return browser.execute(() =>
    Array.from(document.querySelectorAll('[data-testid="agent-logs-panel"] [data-testid="alog-row"]')).map((r) => ({
      text: r.querySelector(".alog-text")?.textContent?.trim() ?? "",
      source: r.getAttribute("data-source") ?? "",
      className: r.className,
    })),
  );
}

interface SidebarRowView {
  source: string;
  /** What the eye reads: the display name — a service's ` · bg` is a tag, not part of it. */
  name: string;
  group: string;
  running: string;
  count: number;
  pressed: string;
}

/** The Sources sidebar's rows, grouped Services / Terminals / Agents / Mac apps. */
async function sidebarRows(): Promise<SidebarRowView[]> {
  return browser.execute(() =>
    Array.from(document.querySelectorAll('[data-testid="alog-sidebar"] [data-testid="alog-src-row"]')).map((r) => ({
      source: r.getAttribute("data-source") ?? "",
      name: r.querySelector(".alog-side__name")?.textContent ?? "",
      group: r.getAttribute("data-group") ?? "",
      running: r.getAttribute("data-running") ?? "",
      count: Number(r.querySelector('[data-testid="alog-src-count"]')?.textContent ?? "NaN"),
      pressed: r.querySelector("button.alog-side__main")?.getAttribute("aria-pressed") ?? "",
    })),
  );
}

/** Poll until a row satisfies `pred`, or fail with what WAS rendered (a hang is a failure). */
async function waitForRow(pred: (r: RowView) => boolean, what: string, timeout = 20_000): Promise<RowView> {
  let last: RowView[] = [];
  const found = await browser
    .waitUntil(
      async () => {
        last = await logRows();
        return last.find(pred) ?? false;
      },
      { timeout, interval: 250 },
    )
    .catch(() => undefined);
  if (!found) {
    const seen = last.map((r) => `[${r.source}] ${r.text}`).join("\n  ");
    throw new Error(`no log row ${what} within ${timeout} ms; rendered rows:\n  ${seen || "(none)"}`);
  }
  return found;
}

/** Click the source link of the row whose text is exactly `text`. */
async function clickSourceOf(text: string): Promise<void> {
  const clicked = await browser.execute((t: string) => {
    const row = Array.from(document.querySelectorAll('[data-testid="alog-row"]')).find(
      (r) => r.querySelector(".alog-text")?.textContent?.trim() === t,
    );
    const link = row?.querySelector<HTMLButtonElement>("button.alog-src--link");
    link?.click();
    return link !== undefined && link !== null;
  }, text);
  if (!clicked) throw new Error(`the row "${text}" has no source link (not attributed to an open terminal)`);
}

/** W3C WebDriver key codes (the `e2e/support/terminal.ts` convention: raw codes, no extra import). */
const CONTROL = "\uE009";
const BACKSPACE = "\uE003";
const ESCAPE = "\uE00C";

interface FindView {
  count: string;
  /** The current (hot) match's text. */
  hot: string | null;
  /** The text cell of the raw row the current match is in. */
  rowText: string | null;
  /** That row lies inside the list's visible box, below the sticky header. */
  inView: boolean;
  focusInInput: boolean;
}

/** The ⌘F bar's state and where its current match is, in one round-trip. */
async function findView(): Promise<FindView> {
  return browser.execute(() => {
    const hot = document.querySelector('[data-testid="alog-find-current"]');
    const row = hot?.closest('[data-testid="alog-row"]') ?? null;
    const list = document.querySelector('[data-testid="alog-list"]');
    const head = document.querySelector('[data-testid="alog-head"]');
    let inView = false;
    if (row && list && head) {
      const r = row.getBoundingClientRect();
      inView = r.top >= head.getBoundingClientRect().bottom - 1 && r.bottom <= list.getBoundingClientRect().bottom + 1;
    }
    return {
      count: document.querySelector('[data-testid="alog-find-count"]')?.textContent ?? "",
      hot: hot?.textContent ?? null,
      rowText: row?.querySelector(".alog-text")?.textContent?.trim() ?? null,
      inView,
      focusInInput: document.activeElement?.getAttribute("data-testid") === "alog-find-input",
    };
  });
}

async function openAgentLogs(): Promise<void> {
  await $('[aria-label="Agent logs"]').click();
  await $('[data-testid="agent-logs-panel"]').waitForDisplayed({ timeout: 15_000 });
}

describe("agent logs: a real terminal's output becomes log lines", () => {
  let term: OpenedTerminal;
  let marker = "";

  before(async () => {
    term = await openTerminalFromEmptyPane();
  });

  it("shows the echoed marker with the terminal as its source", async () => {
    await typeInTerminal(term.id, "echo AGENTSTUDIO_E2E_MARKER_$RANDOM");
    await openAgentLogs();

    const row = await waitForRow((r) => /^AGENTSTUDIO_E2E_MARKER_\d+$/.test(r.text), "with the expanded marker");
    marker = row.text;
    // The source label is "<pty title> · <cwd basename>", not the tab title. Prove attribution by
    // behaviour: the row's "Focus …" link brings exactly this terminal's tab to the front.
    expect(row.source).toMatch(/ · workspace$/);
    await clickSourceOf(marker);
    await browser.waitUntil(
      async () =>
        (await browser.execute(
          () => document.querySelector('[role="tab"][aria-selected="true"] .pane-tab__title')?.textContent?.trim() ?? "",
        )) === term.title,
      { timeout: 10_000, timeoutMsg: `following the row's source did not focus the "${term.title}" tab` },
    );
    await expect($(`.terminal-view[data-terminal-id="${term.id}"]`)).toBeDisplayed();
  });

  it("levels `error: boom` as an error", async () => {
    await showTerminalTab(term.title);
    await typeInTerminal(term.id, "printf '%s: %s\\n' error boom");
    await openAgentLogs();

    const row = await waitForRow((r) => r.text === "error: boom", "reading exactly `error: boom`");
    expect(row.className).toContain("alog-row--error");
    expect(row.source).toMatch(/ · workspace$/);
    // A raw terminal row carries no marker glyph.
    expect(row.text).not.toMatch(/^[⚙◆▸]/);
  });

  it("the Sources sidebar lists the terminal under Terminals, running, with its line count and the error badge", async () => {
    const svcSource = (await logRows()).find((r) => r.text === "error: boom")?.source ?? "";
    const rows = await sidebarRows();
    const mine = rows.find((r) => r.source === svcSource);
    if (!mine) throw new Error(`no sidebar row for "${svcSource}"; rows: ${JSON.stringify(rows)}`);
    expect(mine.group).toBe("terminal");
    expect(mine.running).toBe("true");
    // A terminal's display name is its label; no row anywhere reads with the ` · bg` suffix.
    expect(mine.name).toBe(svcSource);
    for (const r of rows) expect(r.name).not.toMatch(/ · bg$/);
    expect(mine.count).toBeGreaterThanOrEqual(2); // the marker line and `error: boom`, at least
    // The `error: boom` line is that terminal's one error: the badge is a button naming it.
    const badge = await $(`[data-testid="alog-src-row"][data-source="${svcSource}"] [data-testid="alog-src-errors"]`);
    await expect(badge).toBeDisplayed();
    await expect(badge).toHaveText(/^[1-9]\d*$/);
    // The lifecycle line (`terminal opened · …`) is a divider, not a log row.
    const dividers = await browser.execute(() =>
      Array.from(document.querySelectorAll('[data-testid="alog-divider"]')).map((d) => d.textContent ?? ""),
    );
    expect(dividers.some((d) => d.includes("terminal opened"))).toBe(true);
  });

  it("clicking the sidebar row shows only that terminal's stream under a stream header; the Source column stays; All removes the header", async () => {
    const svcSource = (await logRows()).find((r) => r.text === "error: boom")?.source ?? "";
    await $(`[data-testid="alog-src-row"][data-source="${svcSource}"] button.alog-side__main`).click();
    await browser.waitUntil(
      async () => {
        const rows = await logRows();
        return rows.length > 0 && rows.every((r) => r.source === svcSource);
      },
      { timeout: 10_000, timeoutMsg: `the sidebar row did not narrow the rows to "${svcSource}"` },
    );
    expect((await sidebarRows()).find((r) => r.source === svcSource)?.pressed).toBe("true");
    const headers = () =>
      browser.execute(() => Array.from(document.querySelectorAll('[data-testid="alog-head"] .alog-head__cell')).map((c) => c.textContent?.trim()));
    // The selection never toggles a column — the Source column is the user's choice.
    expect(await headers()).toEqual(["Time", "Level", "Source", "Text"]);
    const streamHead = $('[data-testid="alog-stream-head"]');
    await expect(streamHead).toBeDisplayed();
    await expect(streamHead).toHaveAttribute("data-source", svcSource);
    // `<name> · terminal · ● running · N lines · E errors`
    await expect($('[data-testid="alog-stream-head"] .alog-stream-head__text')).toHaveText(
      new RegExp(`^${svcSource.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} · terminal · ● running · \\d+ lines · \\d+ errors?$`),
    );
    await $('[data-testid="alog-src-all"]').click();
    await browser.waitUntil(async () => !(await $('[data-testid="alog-stream-head"]').isExisting()), {
      timeout: 10_000,
      timeoutMsg: "All did not remove the stream header",
    });
    expect(await headers()).toEqual(["Time", "Level", "Source", "Text"]);
  });

  it("the filter box narrows the list to the marker", async () => {
    expect(marker).not.toBe("");
    await $('[aria-label="Filter log lines"]').setValue(marker);

    await browser.waitUntil(
      async () => {
        const rows = await logRows();
        return rows.length > 0 && rows.every((r) => r.text.includes(marker));
      },
      { timeout: 10_000, interval: 250, timeoutMsg: `the filter did not narrow the rows to ${marker}` },
    );
    const rows = await logRows();
    expect(rows.some((r) => r.text === "error: boom")).toBe(false);
    // The count reads "N of M lines" once a filter hides something.
    await expect($(".alog-count")).toHaveText(/^\d+ of \d+ lines$/);
  });

  it("Ctrl+F inside the Logs panel opens its find bar: typing the marker counts it and reveals its row", async () => {
    expect(marker).not.toBe("");
    // Empty the filter first, so it is FIND that locates the marker in the whole stream.
    const filter = $('[aria-label="Filter log lines"]');
    await filter.click();
    await browser.keys([CONTROL, "a"]);
    await browser.keys(BACKSPACE);
    await browser.waitUntil(async () => (await filter.getValue()) === "", { timeout: 5_000, timeoutMsg: "the filter did not clear" });
    // The tail follows: with the whole stream back, scroll the list to the top so the reveal
    // has somewhere to go (the marker is not the last line — `error: boom` came after it).
    await browser.execute(() => {
      const list = document.querySelector('[data-testid="alog-list"]');
      if (list) list.scrollTop = 0;
    });
    // Focus inside the panel: a click on the line count lands on the panel itself (tabIndex -1).
    // Ctrl+F, not Meta+F: the E2E runs on Linux/Windows, and the panel answers Cmd OR Ctrl+F.
    await $(".alog-count").click();
    await browser.keys([CONTROL, "f"]);
    const input = $('[data-testid="alog-find-input"]');
    await expect(input).toBeDisplayed();
    await browser.waitUntil(async () => (await findView()).focusInInput, { timeout: 5_000, timeoutMsg: "Ctrl+F did not focus the find input" });

    await input.setValue(marker);
    let view = await findView();
    await browser
      .waitUntil(
        async () => {
          view = await findView();
          return /^1\/\d+$/.test(view.count) && view.hot !== null;
        },
        { timeout: 10_000, interval: 250 },
      )
      .catch(() => {
        throw new Error(`find never reported a first match for ${marker}; bar state: ${JSON.stringify(view)}`);
      });
    // The first match is the OUTPUT line (the echoed command has `$RANDOM`, not the digits),
    // highlighted whole, and its row was scrolled into the list's visible box.
    expect(view.count).toMatch(/^1\/[1-9]\d*$/);
    expect(view.hot).toBe(marker);
    expect(view.rowText).toBe(marker);
    expect(view.inView).toBe(true);

    // Esc closes the bar (and the query with it).
    await snap("logs-find-bar-open");
    await browser.keys(ESCAPE);
    await browser.waitUntil(async () => !(await $('[data-testid="alog-find"]').isExisting()), {
      timeout: 5_000,
      timeoutMsg: "Esc did not close the find bar",
    });
  });
});
