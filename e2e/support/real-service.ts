/**
 * Helpers for the real-service specs (e2e/specs/real-service*.e2e.ts): open more terminals,
 * read the Network and Agent logs views, capture what the app puts on the clipboard, and
 * drag a column resizer — all through hooks the product already renders (no test-only ids).
 */

import { $, $$, browser } from "@wdio/globals";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { typeInTerminal, type OpenedTerminal } from "./terminal";

/** The committed fixture service, relative to the IDE terminal's cwd (the fixture workspace). */
export const SERVICE_SCRIPT = "../real-service.mjs";
export const SERVICE_PORT = 47819;
export const SERVICE_URL = `http://localhost:${SERVICE_PORT}`;

/** Evidence for a finding: a screenshot of the real window into E2E_SCREENSHOT_DIR. */
export async function snap(name: string): Promise<void> {
  const dir = process.env.E2E_SCREENSHOT_DIR;
  if (!dir) return;
  await browser.saveScreenshot(path.join(dir, `${name.replace(/[^\w.-]+/g, "_")}.png`)).catch(() => undefined);
}

async function terminalIds(): Promise<string[]> {
  return browser.execute(() =>
    Array.from(document.querySelectorAll(".terminal-view[data-terminal-id]")).map(
      (e) => e.getAttribute("data-terminal-id") ?? "",
    ),
  );
}

/**
 * Open ANOTHER terminal with the tab bar's "New terminal tab" button (the empty-pane button
 * only exists for the first one). Returns the terminal that was not there before.
 */
export async function openAnotherTerminal(): Promise<OpenedTerminal> {
  const before = new Set(await terminalIds());
  const plus = await $('button[aria-label="New terminal tab"]');
  await plus.waitForClickable({ timeout: 15_000 });
  await plus.click();
  const id = await browser.waitUntil(
    async () => (await terminalIds()).find((t) => !before.has(t)) ?? false,
    { timeout: 15_000, timeoutMsg: "New terminal tab did not mount a new terminal" },
  );
  await $(`.terminal-view[data-terminal-id="${id}"] .xterm-helper-textarea`).waitForExist({ timeout: 15_000 });
  const title = await browser.execute(
    () => document.querySelector('[role="tab"][aria-selected="true"] .pane-tab__title')?.textContent?.trim() ?? "",
  );
  return { id, title };
}

/**
 * What a terminal printed — to see a command's own output. xterm's DOM rows when the DOM
 * renderer is active; under the WebGL renderer (the default wherever WebGL2 exists, including
 * software GL in the E2E container) the screen is a canvas, so read the same terminal's output
 * as the app itself captured it: the log hub's ring (`logstream_snapshot`, filtered to this
 * terminal id) — the PTY bytes after the tap's line split and ANSI strip.
 */
export async function terminalText(terminalId: string): Promise<string> {
  return browser.execute(async (id: string) => {
    const dom = Array.from(document.querySelectorAll(`.terminal-view[data-terminal-id="${id}"] .xterm-rows > div`))
      .map((r) => r.textContent ?? "")
      .join("\n");
    if (dom.trim() !== "") return dom;
    const tauri = (window as unknown as { __TAURI_INTERNALS__?: { invoke: (c: string) => Promise<unknown> } })
      .__TAURI_INTERNALS__;
    if (!tauri) return "";
    const lines = (await tauri.invoke("logstream_snapshot")) as { terminalId: string | null; text: string }[];
    return lines
      .filter((l) => l.terminalId === id)
      .map((l) => l.text)
      .join("\n");
  }, terminalId);
}

/** Bring a terminal to the front by clicking its tab (by id → its tab title) and type a line. */
export async function runIn(term: OpenedTerminal, line: string): Promise<void> {
  const tab = await $(`[role="tab"][title="${term.title}"]`);
  await tab.waitForClickable({ timeout: 10_000 });
  await tab.click();
  await typeInTerminal(term.id, line);
}

/* ── Network ─────────────────────────────────────────────────────────────── */

export interface FlowRowView {
  flowId: string;
  proto: string;
  method: string;
  host: string;
  path: string;
  status: string;
  type: string;
  /** The Size cell — a tunnel's is `↑n ↓m`. */
  size: string;
  source: string;
  process: string;
}

export async function openNetwork(): Promise<void> {
  await $('[aria-label="Network traffic"]').click();
  await $('[data-testid="network-panel"]').waitForDisplayed({ timeout: 15_000 });
}

export async function flowRows(): Promise<FlowRowView[]> {
  return browser.execute(() =>
    Array.from(document.querySelectorAll('[data-testid="network-panel"] [data-testid="net-row"]')).map((r) => {
      const cell = (c: string): string => r.querySelector(`.net-c--${c}`)?.textContent?.trim() ?? "";
      return {
        flowId: r.getAttribute("data-flow-id") ?? "",
        proto: cell("proto"),
        method: cell("method"),
        host: cell("host"),
        path: cell("path"),
        status: cell("status"),
        type: cell("type"),
        size: cell("size"),
        source: cell("source"),
        process: cell("process"),
      };
    }),
  );
}

const show = (r: FlowRowView): string =>
  `${r.proto} ${r.method} ${r.host} ${r.path} ${r.status} [${r.type}] ${r.size} src=${r.source} proc=${r.process}`;

/** Poll the table until a row satisfies `pred`; fail with every row that WAS there. */
export async function waitForFlow(pred: (r: FlowRowView) => boolean, what: string, timeout = 30_000): Promise<FlowRowView> {
  let last: FlowRowView[] = [];
  const row = await browser
    .waitUntil(
      async () => {
        last = await flowRows();
        return last.find(pred) ?? false;
      },
      { timeout, interval: 300 },
    )
    .catch(() => undefined);
  if (!row) {
    await snap(`no-flow-${what}`);
    throw new Error(`no flow ${what} within ${timeout} ms; rows:\n  ${last.map(show).join("\n  ") || "(none)"}`);
  }
  return row;
}

/** Open a flow's detail (click a CELL — WebKitWebDriver calls a <tr> "not interactable"). */
export async function openFlow(flowId: string): Promise<WebdriverIO.Element> {
  await $(`[data-testid="net-row"][data-flow-id="${flowId}"] .net-c--time`).click();
  const detail = await $('[data-testid="net-detail"]').getElement();
  await detail.waitForDisplayed({ timeout: 10_000 });
  return detail;
}

/** Header rows of the detail's open tab panel, lower-cased names. */
export async function detailHeaders(): Promise<Record<string, string>> {
  return browser.execute(() => {
    const out: Record<string, string> = {};
    for (const tr of Array.from(document.querySelectorAll('[data-testid="net-detail"] [role="tabpanel"] table[aria-label="Headers"] tr'))) {
      out[tr.querySelector("th")?.textContent?.trim().toLowerCase() ?? ""] = tr.querySelector("td")?.textContent?.trim() ?? "";
    }
    return out;
  });
}

/**
 * Replace `navigator.clipboard.writeText` with a recorder, so a spec can read back the EXACT
 * string a Copy button writes (the webview's real clipboard is not readable over WebDriver).
 * The app's own code path is unchanged: it still calls writeText and awaits its promise.
 */
export async function recordClipboard(): Promise<void> {
  await browser.execute(() => {
    const w = window as unknown as { __copied: string[] };
    w.__copied = [];
    const rec = { writeText: (t: string) => (w.__copied.push(t), Promise.resolve()), readText: () => Promise.resolve("") };
    try {
      Object.defineProperty(navigator, "clipboard", { value: rec, configurable: true });
    } catch {
      (navigator.clipboard as unknown as { writeText: unknown }).writeText = rec.writeText;
    }
  });
}

export async function copied(): Promise<string[]> {
  return browser.execute(() => (window as unknown as { __copied?: string[] }).__copied ?? []);
}

/** Click one of the detail's copy buttons by its visible label and return what it copied. */
export async function copyVia(label: string): Promise<string> {
  const n = (await copied()).length;
  const btn = await $('[data-testid="net-detail"] .net-actions').$(`button=${label}`);
  await btn.waitForEnabled({ timeout: 10_000 });
  await btn.click();
  const all = await browser.waitUntil(async () => {
    const c = await copied();
    return c.length > n ? c : false;
  }, { timeout: 5_000, timeoutMsg: `"${label}" wrote nothing to the clipboard` });
  return all[all.length - 1];
}

/* ── the IDE's own API client ──────────────────────────────────────────── */

/**
 * Open a new API request tab from the titlebar globe, send `GET url`, and wait for the status
 * pill to read `expectedStatus` — the same hooks api.e2e.ts drives (`New API request`,
 * `Request URL`, `api-send`, `api-status`).
 */
export async function sendApiGet(url: string, expectedStatus: string): Promise<void> {
  await $('[aria-label="New API request"]').click();
  await $('[data-testid="api-request"]').waitForExist({ timeout: 15_000 });
  await $('[aria-label="Request URL"]').setValue(url);
  await $('[data-testid="api-send"]').click();
  const status = await $('[data-testid="api-status"]');
  await status.waitForExist({ timeout: 15_000 });
  await browser.waitUntil(async () => (await status.getText()).trim() === expectedStatus, {
    timeout: 15_000,
    timeoutMsg: `the API client's status pill never read ${expectedStatus} for ${url}`,
  });
}

/* ── an EXTERNAL client: a process outside the app, pointed at its proxy by hand ── */

/**
 * The capture proxy's port, read from the IDE-traffic header (`proxy 127.0.0.1:<port>`) — the
 * same place a user reads it before typing it into Postman. Opens Network first.
 */
export async function proxyPortFromHeader(): Promise<number> {
  await openNetwork();
  const port = await $('[data-testid="network-panel"] [data-testid="net-port"]');
  let text = "";
  await browser.waitUntil(
    async () => {
      text = String(await port.getProperty("textContent")).trim();
      return /^proxy 127\.0\.0\.1:\d+$/.test(text);
    },
    { timeout: 15_000, timeoutMsg: `the Network header never showed the proxy address (last: "${text}")` },
  );
  return Number(text.slice(text.lastIndexOf(":") + 1));
}

/**
 * `curl -s -x http://127.0.0.1:<proxyPort> <url>` from THIS process (the wdio runner, outside
 * the app), resolving with curl's stdout. The runner's own proxy variables are stripped and
 * `--noproxy ""` overrides any NO_PROXY, so the ONLY route is the one given with `-x` — a
 * `localhost` NO_PROXY would otherwise send the request straight to the service and the test
 * would be measuring nothing. execFile (no shell), so nothing in the URL is interpreted.
 */
export function curlViaProxy(proxyPort: number, url: string): Promise<string> {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(https?|all|no)_proxy$/i.test(k)) env[k] = v;
  return new Promise((resolve, reject) => {
    execFile(
      "curl",
      ["-s", "--max-time", "15", "--noproxy", "", "-x", `http://127.0.0.1:${proxyPort}`, url],
      { env, timeout: 20_000 },
      (err, stdout, stderr) => (err ? reject(new Error(`curl via the proxy failed: ${err.message} ${stderr}`)) : resolve(stdout)),
    );
  });
}

/* ── the toolbar pickers (Source / Process / Host) ───────────────────────── */

const NET_PICKER = (label: string): string => `[data-testid="network-panel"] .net-bar button[aria-label="${label}"]`;

/**
 * "Only" one row of a Network toolbar picker (by the trigger's aria-label and the row's label).
 * The Only button is `visibility: hidden` until its row is hovered, so the pointer is moved
 * onto the row first — the same gesture a user makes.
 */
export async function pickOnly(pickerLabel: string, rowLabel: string): Promise<void> {
  await $(NET_PICKER(pickerLabel)).click();
  await $('[data-testid="network-panel"] [role="listbox"]').waitForExist({ timeout: 5_000 });
  const rows = await $$('[data-testid="network-panel"] [role="listbox"] [role="option"]');
  let hit: WebdriverIO.Element | undefined;
  const seen: string[] = [];
  for (const r of rows) {
    const label = await r.$(".app-picker__label");
    if (!(await label.isExisting())) continue;
    // textContent, not getText(): WebKitWebDriver's getText() returns "" for text it judges not yet
    // rendered, which a popover that has just opened (and may have flipped) can be.
    const text = String(await label.getProperty("textContent")).trim();
    seen.push(text);
    if (text === rowLabel) hit = r;
  }
  if (!hit) throw new Error(`no "${rowLabel}" row in the "${pickerLabel}" picker; rows: ${JSON.stringify(seen)}`);
  await hit.moveTo();
  await hit.$("button.app-picker__only").click();
  await browser.keys("Escape");
}

/** Put a Network toolbar picker back on All (tick its All row). */
export async function pickAll(pickerLabel: string): Promise<void> {
  await $(NET_PICKER(pickerLabel)).click();
  const all = await $('[data-testid="network-panel"] [role="listbox"] .app-picker__row--all input');
  await all.waitForExist({ timeout: 5_000 });
  if (!(await all.isSelected())) await all.click();
  await browser.keys("Escape");
}

/* ── Agent logs ───────────────────────────────────────────────────────────── */

export interface LogRowView {
  id: string;
  text: string;
  source: string;
  level: string;
  viaDetail: boolean;
}

export async function openLogs(): Promise<void> {
  await $('[aria-label="Agent logs"]').click();
  await $('[data-testid="agent-logs-panel"]').waitForDisplayed({ timeout: 15_000 });
}

export async function logRows(): Promise<LogRowView[]> {
  return browser.execute(() =>
    Array.from(document.querySelectorAll('[data-testid="agent-logs-panel"] [data-testid="alog-row"]')).map((r) => ({
      id: r.getAttribute("data-id") ?? "",
      text: r.querySelector(".alog-text")?.textContent?.trim() ?? "",
      source: r.querySelector(".alog-src")?.textContent?.trim() ?? "",
      level: (/alog-row--(error|warn|info|debug)\b/.exec(r.className) ?? [])[1] ?? "",
      viaDetail: r.querySelector('[data-testid="alog-via-detail"]') !== null,
    })),
  );
}

export async function waitForLog(pred: (r: LogRowView) => boolean, what: string, timeout = 30_000): Promise<LogRowView> {
  let last: LogRowView[] = [];
  const row = await browser
    .waitUntil(
      async () => {
        last = await logRows();
        return last.find(pred) ?? false;
      },
      { timeout, interval: 300 },
    )
    .catch(() => undefined);
  if (!row) {
    await snap(`no-log-${what}`);
    const seen = last.map((r) => `[${r.level}] [${r.source}] ${r.text}`).join("\n  ");
    throw new Error(`no log row ${what} within ${timeout} ms; rows:\n  ${seen || "(none)"}`);
  }
  return row;
}


/* ── dev apps on this machine ─────────────────────────────────────────────── */

export interface DevAppRowView {
  key: string;
  name: string;
  /** The runtime (`node`, `rust`…) — rows are badge-free; the section they sit in names it. */
  runtime: string;
  /** The heading of the runtime section the row sits in: `Node · JS`, `Rust · Cargo`… */
  section: string;
  /** `ide` (an IDE terminal or agent started it) or `external`. */
  origin: string;
  /** The small tag: `by <launchedBy>` or `external`. */
  tag: string;
  /** `pid N`, the cwd and the (masked) command, one per line. */
  title: string;
  pressed: string;
}

/**
 * The Apps group's app rows (every runtime section) in the Logs Sources sidebar — scoped to it:
 * Network's IDE-traffic sidebar renders the same section.
 */
export async function devAppRows(): Promise<DevAppRowView[]> {
  return browser.execute(() =>
    Array.from(document.querySelectorAll('[data-testid="alog-sidebar"] [data-testid="procs-section"] [data-testid="procs-row"]')).map((r) => ({
      key: r.getAttribute("data-key") ?? "",
      name: r.querySelector(".procs-side__name")?.textContent ?? "",
      runtime: r.getAttribute("data-runtime") ?? "",
      section: r.closest('[data-testid="procs-runtime"]')?.getAttribute("aria-label") ?? "",
      origin: r.getAttribute("data-origin") ?? "",
      tag: r.querySelector('[data-testid="procs-origin"]')?.textContent ?? "",
      title: r.getAttribute("title") ?? "",
      pressed: r.getAttribute("aria-pressed") ?? "",
    })),
  );
}

/** Poll the dev-app rows (the section polls `procs_list` every 3 s) until one satisfies `pred`. */
export async function waitForDevApp(pred: (r: DevAppRowView) => boolean, what: string, timeout = 30_000): Promise<DevAppRowView> {
  let last: DevAppRowView[] = [];
  const row = await browser
    .waitUntil(
      async () => {
        last = await devAppRows();
        return last.find(pred) ?? false;
      },
      { timeout, interval: 500 },
    )
    .catch(() => undefined);
  if (!row) {
    await snap(`no-dev-app-${what}`);
    const why = await browser.execute(
      () => document.querySelector('[data-testid="alog-sidebar"] [data-testid="procs-section"]')?.textContent ?? "(no procs section)",
    );
    throw new Error(`no dev app ${what} within ${timeout} ms; rows:\n  ${last.map((r) => `[${r.runtime} ${r.origin}] ${r.name} ${JSON.stringify(r.title)}`).join("\n  ") || "(none)"}\nsection: ${why}`);
  }
  return row;
}

export interface ExternalNodeApp {
  /**
   * The app's display name as procscan builds it (`classify::app_name`):
   * `<tool> · <project>` — the script, then its cwd's basename: `probe.mjs · alog-probe-file-…`.
   */
  name: string;
  /** Where its stdout goes: a file (readable → Stream), or a pty of its own (unreadable). */
  console: "file" | "terminal";
  logPath: string | null;
  stop: () => void;
}

/**
 * A Node app started OUTSIDE the IDE — by this wdio process, the way a user starts one in
 * another terminal app. It prints `probe tick <n>` every 250 ms until stopped, from a fresh
 * temp dir with a distinctive name (what its row is named after).
 *
 * - `file`: `node probe.mjs > probe.log` — its console is readable (`console: "file"`), so the
 *   card offers Stream on it.
 * - `terminal`: run under `script`, which gives it a pty of its OWN — exactly a dev server in
 *   Terminal.app / another IDE: `console: "terminal"`, which no other program may read, so the
 *   card offers Restart in the IDE. (`script` is util-linux/bsdutils on Linux, base macOS.)
 *
 * The script is named by ABSOLUTE path so `stop()` can find every process of this app with
 * `pkill -f <dir>` — `script` puts its child in a session of its own, out of our process group.
 */
export function startExternalNodeApp(consoleKind: "file" | "terminal"): ExternalNodeApp {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), consoleKind === "file" ? "alog-probe-file-" : "alog-probe-tty-"));
  const script = path.join(dir, "probe.mjs");
  fs.writeFileSync(script, "let n = 0;\nsetInterval(() => console.log(`probe tick ${++n}`), 250);\n");
  let logPath: string | null = null;
  if (consoleKind === "file") {
    logPath = path.join(dir, "probe.log");
    const out = fs.openSync(logPath, "a");
    // `process.execPath` is a real `node` binary, so procscan classifies it as Node.
    spawn(process.execPath, [script], { cwd: dir, stdio: ["ignore", out, "ignore"], detached: true }).unref();
    fs.closeSync(out);
  } else {
    const args =
      process.platform === "darwin"
        ? ["-q", "/dev/null", process.execPath, script]
        : ["-qfec", `"${process.execPath}" "${script}"`, "/dev/null"];
    // stdin is /dev/null, NOT a pipe: Node's "pipe" is a socketpair, and macOS `script` fails
    // on it (`tcgetattr/ioctl: Operation not supported on socket`). Verified on macOS: with
    // /dev/null it keeps running and the child's fd 1 is `/dev/ttysNNN`.
    spawn("script", args, { cwd: dir, stdio: ["ignore", "ignore", "ignore"], detached: true }).unref();
  }
  const stop = (): void => {
    execFile("pkill", ["-f", dir], () => fs.rmSync(dir, { recursive: true, force: true }));
  };
  return { name: `probe.mjs · ${path.basename(dir)}`, console: consoleKind, logPath, stop };
}

/* ── columns ─────────────────────────────────────────────────────────────── */

/** Drag a resizer handle (by its aria-label, inside `scope`) `dx` px with a real pointer. */
export async function dragResizer(scope: string, label: string, dx: number): Promise<void> {
  const handle = await $(`${scope} [aria-label="${label}"]`);
  await handle.waitForExist({ timeout: 10_000 });
  await handle.scrollIntoView({ block: "nearest", inline: "nearest" });
  await browser
    .action("pointer", { parameters: { pointerType: "mouse" } })
    .move({ origin: handle, x: 0, y: 0 })
    .down({ button: 0 })
    .pause(50)
    .move({ origin: "pointer", x: Math.round(dx / 2), y: 0, duration: 100 })
    .move({ origin: "pointer", x: dx - Math.round(dx / 2), y: 0, duration: 100 })
    .up({ button: 0 })
    .perform();
  await browser.releaseActions().catch(() => undefined);
}

/** Tick/untick a column in a view's "Columns ▾" menu, then close the menu. */
export async function toggleColumn(scope: string, label: string): Promise<void> {
  const trigger = await $(`${scope} button.cols-menu__trigger`);
  await trigger.click();
  const rows = await $$(`${scope} [role="menu"] label.cols-menu__row`);
  let hit: WebdriverIO.Element | undefined;
  for (const r of rows) {
    if ((await r.$("span").getText()).trim() === label) hit = r;
  }
  if (!hit) throw new Error(`no "${label}" in the Columns menu of ${scope}`);
  await hit.$("input").click();
  await browser.keys("Escape");
}

/**
 * The Network columns the table hides by itself to fit a narrow pane (networkColumns.fitColumns:
 * at the 1280 px E2E window the table is ~440 px, so Process / Size / Duration / Type give way).
 */
export const FIT_HIDDEN_COLUMNS = ["Process", "Size", "Duration", "Type"] as const;

/**
 * Tick columns ON in Network's "Columns ▾" — the way a user who wants them does; an explicit show
 * is never auto-hidden again. Specs that read Process / Size / Type / Duration cells call this
 * first (after asserting anything about the default fit). Idempotent.
 */
export async function showNetworkColumns(labels: readonly string[] = FIT_HIDDEN_COLUMNS): Promise<void> {
  const scope = '[data-testid="network-panel"]';
  const trigger = await $(`${scope} button.cols-menu__trigger`);
  await trigger.waitForClickable({ timeout: 10_000 });
  await trigger.click();
  for (const label of labels) {
    const rows = await $$(`${scope} [role="menu"] label.cols-menu__row`);
    let hit: WebdriverIO.Element | undefined;
    for (const r of rows) {
      if ((await r.$("span").getText()).trim() === label) hit = r;
    }
    if (!hit) throw new Error(`no "${label}" in Network's Columns menu`);
    const box = await hit.$("input");
    if (!(await box.isSelected())) await box.click();
  }
  await browser.keys("Escape");
  await browser.waitUntil(
    async () => {
      const heads: string[] = await browser.execute(() =>
        Array.from(document.querySelectorAll("table[aria-label='Network flows'] thead th")).map((h) => h.firstChild?.textContent?.trim() ?? ""),
      );
      return labels.every((l) => heads.includes(l));
    },
    { timeout: 5_000, timeoutMsg: `Network did not show ${labels.join(", ")} after ticking them on` },
  );
}

/**
 * Empty the Logs filter box the way a user does (select all + Backspace). WebdriverIO's
 * `clearValue()` blanks the DOM value without firing React's change event under WebKitWebDriver,
 * so the store kept the old query and a later test's rows were silently filtered out.
 */
export async function clearLogsFilter(): Promise<void> {
  const input = $('[aria-label="Filter log lines"]');
  await input.click();
  await browser.keys(["Control", "a"]);
  await browser.keys("Backspace");
  await browser.waitUntil(async () => (await input.getValue()) === "", {
    timeout: 5_000,
    timeoutMsg: "the Logs filter box did not empty",
  });
}

/* ── the capture guard ───────────────────────────────────────────────────── */

/** The port of the service the capture-guard E2E starts with its proxy variables stripped. */
export const NOCAP_PORT = 47821;

/**
 * The shell line that starts the fixture service the way an agent often starts a service:
 * every proxy variable stripped. A copy under a distinctive name (`nocap-service.mjs`, in a fresh
 * temp dir) so its dev-app row is told apart from the captured service's by its command.
 */
export function nocapServiceLine(): string {
  return (
    `D=$(mktemp -d) && cp ${SERVICE_SCRIPT} "$D/nocap-service.mjs" && ` +
    `env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy SVC_PORT=${NOCAP_PORT} node "$D/nocap-service.mjs"`
  );
}

/** Network › IDE traffic's Apps sidebar: each app row's key, name and capture state. */
export async function networkAppRows(): Promise<{ key: string; name: string; title: string; capture: string }[]> {
  return browser.execute(() =>
    Array.from(document.querySelectorAll('[data-testid="net-apps"] [data-testid="procs-line"]')).map((l) => ({
      key: l.getAttribute("data-key") ?? "",
      name: l.querySelector(".procs-side__name")?.textContent ?? "",
      title: l.querySelector('[data-testid="procs-row"]')?.getAttribute("title") ?? "",
      capture: l.querySelector('[data-testid="net-app-capture"]')?.getAttribute("data-state") ?? "",
    })),
  );
}

/** The Network sidebar's Terminals / Agents / Other rows (`data-source` = the Source picker's key). */
export async function networkSourceRows(): Promise<{ key: string; group: string; name: string; count: number; checked: boolean; pressed: string }[]> {
  return browser.execute(() =>
    Array.from(document.querySelectorAll('[data-testid="net-apps"] [data-testid="net-src-row"]')).map((r) => ({
      key: r.getAttribute("data-source") ?? "",
      group: r.closest('[data-testid="net-src-group"]')?.getAttribute("data-group") ?? "",
      name: r.querySelector(".net-side__name")?.textContent ?? "",
      count: Number(r.querySelector('[data-testid="net-src-count"]')?.textContent ?? "NaN"),
      checked: (r.querySelector('[data-testid="net-src-check"]') as HTMLInputElement | null)?.checked ?? false,
      pressed: r.querySelector("button")?.getAttribute("aria-pressed") ?? "",
    })),
  );
}

/**
 * Is the element on screen — inside the window AND inside the Network panel's box? (A real
 * bug: the toolbar's pickers existed but were laid out past the pane's right edge.)
 */
export async function isInNetworkViewport(selector: string): Promise<{ ok: boolean; rect: string }> {
  return browser.execute((sel: string) => {
    const el = document.querySelector(sel);
    const panel = document.querySelector('[data-testid="network-panel"]');
    if (!el || !panel) return { ok: false, rect: `missing: ${el ? "panel" : sel}` };
    const r = el.getBoundingClientRect();
    const p = panel.getBoundingClientRect();
    const ok = r.width > 0 && r.left >= p.left && r.right <= p.right + 0.5 && r.right <= window.innerWidth + 0.5;
    return { ok, rect: `el ${r.left}–${r.right}, panel ${p.left}–${p.right}, window ${window.innerWidth}` };
  }, selector);
}
