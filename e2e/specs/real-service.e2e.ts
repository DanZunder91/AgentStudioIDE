/**
 * R1 — a REAL local service, driven from the IDE's own terminals, seen correctly in Network
 * and Agent logs: a real service running, the UI opened, and every view checked to show the
 * correct things.
 *
 * Everything is local (blocking in `npm run verify`): the service (e2e/fixtures/real-service.mjs)
 * listens on loopback, the calls are `curl` from another IDE terminal through the injected proxy
 * (loopback is captured too), and the service's one outbound call here is the
 * deterministic LOCAL failure `/upstream?fail=1` (curl → https://localhost:1/). The example.com
 * half lives in real-service-external.e2e.ts, which verify reports but does not block on.
 *
 * Not covered here, on purpose: a service Claude starts with `run_in_background` (its stdout
 * goes to a task file found through the Claude transcript). The E2E has no
 * signed-in `claude` (never test with real user credentials), so that path is covered by the
 * Rust tests (tests/logstream_tasks*.rs). Here the service runs in the FOREGROUND of an IDE
 * terminal, so its stdout is that terminal's PTY output.
 *
 * Dev apps on this machine (the last suite): two Node apps are started OUTSIDE the IDE by
 * this wdio process — one under `script` (a pty of its own, like a dev server in another
 * terminal app: console `terminal`, the card offers Restart in the IDE), one with stdout
 * redirected to a file (readable: Stream tails it into the Logs view as `app` lines, under its
 * app's row). The service above runs in an IDE terminal: the IDE's own process tree
 * IS listed — `origin: "ide"`, tagged `by <terminal title>`, console `ide-terminal`, no Restart
 * (it is already in the IDE) — asserted too.
 */

import { $, browser, expect } from "@wdio/globals";

import { openTerminalFromEmptyPane, type OpenedTerminal } from "../support/terminal";
import {
  SERVICE_PORT,
  SERVICE_SCRIPT,
  SERVICE_URL,
  copyVia,
  curlViaProxy,
  detailHeaders,
  devAppRows,
  dragResizer,
  flowRows,
  logRows,
  clearLogsFilter,
  networkAppRows,
  networkSourceRows,
  isInNetworkViewport,
  nocapServiceLine,
  NOCAP_PORT,
  openAnotherTerminal,
  openFlow,
  openLogs,
  openNetwork,
  pickAll,
  pickOnly,
  proxyPortFromHeader,
  recordClipboard,
  runIn,
  sendApiGet,
  snap,
  startExternalNodeApp,
  terminalText,
  toggleColumn,
  waitForDevApp,
  waitForFlow,
  waitForLog,
  type ExternalNodeApp,
  showNetworkColumns,
} from "../support/real-service";

const NET = '[data-testid="network-panel"]';
const LOGS = '[data-testid="agent-logs-panel"]';

interface SidebarRowView {
  source: string;
  /** The display name: never ends in ` · bg`. */
  name: string;
  group: string;
  running: string;
  count: number;
  pressed: string;
}

/** The Logs view's Sources sidebar rows — the successor of the Running strip's chips. */
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

/** A raw row's source: its `data-source`, which is set whether or not the Source column is shown. */
async function rowSources(): Promise<string[]> {
  return browser.execute(() =>
    Array.from(document.querySelectorAll(`${'[data-testid="agent-logs-panel"]'} [data-testid="alog-row"]`)).map(
      (r) => r.getAttribute("data-source") ?? "",
    ),
  );
}

describe("real service: a local service's calls and logs, seen in the IDE", () => {
  let svc: OpenedTerminal;
  let client: OpenedTerminal;

  before(async () => {
    // Both terminals open after the app booted its proxy, so both get the proxy env.
    svc = await openTerminalFromEmptyPane();
    await runIn(svc, `SVC_PORT=${SERVICE_PORT} node ${SERVICE_SCRIPT}`);
    await browser.waitUntil(async () => (await terminalText(svc.id)).includes("INFO svc: listening on"), {
      timeout: 20_000,
      timeoutMsg: "the service never printed `listening on` in its terminal",
    });
    client = await openAnotherTerminal();
    await runIn(client, `curl -s ${SERVICE_URL}/health; echo`);
    await runIn(client, `curl -s ${SERVICE_URL}/upstream?fail=1; echo`);
    await browser.waitUntil(async () => (await terminalText(client.id)).includes('{"error":"upstream failed"}'), {
      timeout: 30_000,
      timeoutMsg: "the client terminal never showed the /upstream?fail=1 response",
    });
    expect(await terminalText(client.id)).toContain('{"status":"ok"}');
  });

  it("Network lists GET localhost /health 200 made by curl", async () => {
    await openNetwork();
    // At the 1280 px E2E window the table fits itself to ~440 px and hides Process / Size /
    // Duration / Type (networkColumns.fitColumns); this spec reads them, so it ticks them on.
    await showNetworkColumns();
    const row = await waitForFlow(
      (r) => r.method === "GET" && r.host === "localhost" && r.path === "/health" && r.status === "200",
      "GET localhost /health 200",
    );
    expect(row.proto).toBe("HTTP");
    expect(row.process).toBe("curl");
    expect(row.source).toBe(client.title);
  });

  it("the /health detail shows the request line, headers, and the JSON response", async () => {
    const row = (await flowRows()).find((r) => r.path === "/health" && r.status === "200");
    const detail = await openFlow(row?.flowId ?? "");

    await detail.$('button[role="tab"]=Request').click();
    await expect(detail.$('[data-testid="net-request-line"]')).toHaveText("GET /health HTTP/1.1");
    const req = await detailHeaders();
    expect(req.host).toBe(`localhost:${SERVICE_PORT}`);
    expect(req["user-agent"]).toMatch(/^curl\//);

    await detail.$('button[role="tab"]=Response').click();
    await expect(detail.$('[data-testid="net-status-line"]')).toHaveText(/^Status 200/);
    const res = await detailHeaders();
    expect(res["content-type"]).toBe("application/json");
    expect(res["x-svc"]).toBe("real-service");
    // The JSON body renders through JsonView: the key and the value are both on screen.
    await browser.waitUntil(
      async () => {
        const t = await detail.$(".net-bodyview").getText().catch(() => "");
        return t.includes("status") && t.includes("ok");
      },
      { timeout: 10_000, timeoutMsg: 'the response body {"status":"ok"} is not shown' },
    );
  });

  it("Copy request / response / body / as cURL copy the exact captured text", async () => {
    // What a real click does first: the real clipboard, and the app's own verdict on it.
    const curlBtn = await $('[data-testid="net-detail"] .net-actions').$("button=Copy as cURL");
    await expect(curlBtn).toBeEnabled();
    await curlBtn.click();
    const verdict = await $('[data-testid="net-detail"] .net-actions [role="status"]');
    await verdict.waitForExist({ timeout: 5_000 });
    const said = await verdict.getText();
    if (said !== "Copied cURL") await snap("copy-as-curl-real-clipboard");
    expect(said).toBe("Copied cURL");

    // Then read back the exact strings.
    await recordClipboard();
    const curl = await copyVia("Copy as cURL");
    expect(curl).toMatch(/^curl /);
    expect(curl).toContain(`${SERVICE_URL}/health`);
    expect(curl).not.toMatch(/proxy-authorization/i);

    const request = await copyVia("Copy request");
    expect(request.split("\n")[0]).toBe("GET /health HTTP/1.1");
    expect(request).toMatch(/^host: localhost:47819$/im);

    const response = await copyVia("Copy response");
    expect(response.split("\n")[0]).toMatch(/^HTTP\/1\.1 200\b/);
    expect(response).toContain('{"status":"ok"}');

    expect(await copyVia("Copy body")).toBe('{"status":"ok"}');
  });

  it("the /upstream?fail=1 call is its own row (502), and so is the service's failed upstream", async () => {
    const up = await waitForFlow(
      (r) => r.host === "localhost" && r.path === "/upstream?fail=1",
      "GET localhost /upstream?fail=1",
    );
    expect(up.status).toBe("502");
    expect(up.process).toBe("curl");
    // The service's own child curl (https://localhost:1 through the proxy) is captured too,
    // attributed to the SERVICE's terminal — it inherited that terminal's proxy env.
    const rows = await flowRows();
    const own = rows.find((r) => r.source === svc.title);
    if (!own) throw new Error(`the service's upstream call (localhost:1) is not listed; rows:\n  ${JSON.stringify(rows)}`);
    expect(own.host).toMatch(/^localhost(:1)?$/);
    expect(own.process).toBe("curl");
  });

  it("the Network sidebar's TERMINALS group picks the service's terminal: only its flows remain, and the Source picker is on screen", async () => {
    // With the Apps sidebar the toolbar's Source / Process / Host pickers were once laid out off
    // the pane's right edge, and there was no way left to pick the terminal that runs the app.
    // The sidebar's Terminals rows are the Source picker's selection.
    await openNetwork();
    for (const label of ["Filter by source", "Filter by process", "Filter by host"]) {
      const at = await isInNetworkViewport(`${NET} .net-bar button[aria-label="${label}"]`);
      if (!at.ok) await snap("network-toolbar-clipped");
      expect(`${label}: ${at.ok ? "on screen" : at.rect}`).toBe(`${label}: on screen`);
    }
    const key = `t:${svc.id}`;
    let rows = await networkSourceRows();
    await browser.waitUntil(async () => (rows = await networkSourceRows()).some((r) => r.key === key), {
      timeout: 10_000,
      timeoutMsg: `the service's terminal is not a Network sidebar row; rows: ${JSON.stringify(rows)}`,
    });
    const mine = rows.find((r) => r.key === key)!;
    expect(mine.group).toBe("terminals");
    expect(mine.name).toBe(svc.title);
    expect(mine.count).toBeGreaterThanOrEqual(1);
    // The client terminal (the curls) is its own Terminals row.
    expect(rows.some((r) => r.key === `t:${client.id}` && r.group === "terminals")).toBe(true);

    await $(`${NET} [data-testid="net-src-row"][data-source="${key}"] button`).click();
    await browser.waitUntil(async () => (await flowRows()).every((r) => r.source === svc.title), {
      timeout: 5_000,
      timeoutMsg: "picking the service's terminal left other sources' flows in the table",
    });
    const shown = await flowRows();
    expect(shown.length).toBe(mine.count);
    const picked = (await networkSourceRows()).find((r) => r.key === key)!;
    expect([picked.checked, picked.pressed]).toEqual([true, "true"]);
    // The toolbar's Source picker names the same pick (textContent: see the Host picker below).
    const trigger = $(`${NET} .net-bar button[aria-label="Filter by source"]`);
    expect(String(await trigger.getProperty("textContent")).trim()).toBe(`${svc.title} ▾`);

    await $(`${NET} [data-testid="net-side-all"]`).click();
    await browser.waitUntil(async () => (await flowRows()).some((r) => r.source !== svc.title), {
      timeout: 5_000,
      timeoutMsg: "All did not bring the other sources' flows back",
    });
  });

  it("the IDE's own API client: GET /health is a row with Source `API client`, Process `Agent Studio`, 200 — and the host picker narrows to localhost", async () => {
    // Requests sent from the IDE's built-in API client used to never appear in Network.
    // `http_send` now records straight into the capture ring, with the reserved terminalId
    // `ide-api-client` and the IDE itself as the client process.
    await sendApiGet(`${SERVICE_URL}/health`, "200");
    await openNetwork();
    const row = await waitForFlow(
      (r) => r.source === "API client" && r.path === "/health" && r.status === "200",
      "API client GET /health 200",
    );
    expect(row.method).toBe("GET");
    expect(row.host).toBe("localhost");
    expect(row.process).toBe("Agent Studio");

    // Its detail is a full request + response (no proxy round-trip, nothing encrypted).
    const detail = await openFlow(row.flowId);
    await detail.$('button[role="tab"]=Request').click();
    await expect(detail.$('[data-testid="net-request-line"]')).toHaveText("GET /health HTTP/1.1");
    await detail.$('button[role="tab"]=Response').click();
    await expect(detail.$('[data-testid="net-status-line"]')).toHaveText(/^Status 200/);
    expect((await detailHeaders())["x-svc"]).toBe("real-service");
    await expect($('[data-testid="net-detail"] .net-actions').$("button=Copy as cURL")).toBeEnabled();

    // The Host picker: "Only localhost" keeps every localhost row — the curl
    // calls, this one, and the service's own tunnel to localhost:1 (a tunnel's Host cell
    // carries its port) — and nothing else.
    await pickOnly("Filter by host", "localhost");
    // textContent: WebKitWebDriver's getText() returns "" for an element that clips with an
    // ellipsis (the picker trigger does), so toHaveText cannot see it.
    const hostTrigger = $('[data-testid="network-panel"] .net-bar button[aria-label="Filter by host"]');
    expect(String(await hostTrigger.getProperty("textContent")).trim()).toBe("localhost ▾");
    const rows = await flowRows();
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const r of rows) expect(r.host.replace(/:\d+$/, "")).toBe("localhost");
    expect(rows.some((r) => r.source === "API client")).toBe(true);
    await pickAll("Filter by host");
    await browser.waitUntil(
      async () =>
        String(await $('[data-testid="network-panel"] .net-bar button[aria-label="Filter by host"]').getProperty("textContent"))
          .trim()
          .startsWith("All hosts"),
      { timeout: 5_000, timeoutMsg: "the Host picker did not go back to All hosts" },
    );
  });

  it("an EXTERNAL client pointed at the proxy by hand: curl from outside the app is a row with Source `external · curl`, Process `curl`, 200", async () => {
    // An external client (e.g. Postman) is not captured until something points it at
    // the proxy. This is the same act, done by a process the IDE did not start: the wdio runner
    // reads the port where a user would (the header), then curls the service through it.
    const port = await proxyPortFromHeader();
    const body = await curlViaProxy(port, `${SERVICE_URL}/health?from=external`);
    expect(body).toContain('{"status":"ok"}');
    await openNetwork();
    const row = await waitForFlow(
      (r) => r.path === "/health?from=external" && r.status === "200",
      "external GET /health?from=external 200",
    );
    expect(row.method).toBe("GET");
    expect(row.host).toBe("localhost");
    // No `t-<id>` userinfo, but the proxy resolved the process — so never "unattributed".
    expect(row.source).toBe("external · curl");
    expect(row.process).toBe("curl");
  });

  it("columns: drag Host wider; hide Type", async () => {
    const width = (label: string) =>
      browser.execute(
        (l: string) =>
          Array.from(document.querySelectorAll("table[aria-label='Network flows'] thead th"))
            .find((h) => h.textContent?.trim() === l)
            ?.getBoundingClientRect().width ?? -1,
        label,
      );
    const before = await width("Host");
    expect(before).toBeGreaterThan(0);
    await dragResizer(NET, "Resize Host column", 120);
    const after = await width("Host");
    if (after < before + 60) await snap("network-host-resize");
    expect(after).toBeGreaterThanOrEqual(before + 60);

    const headers = () =>
      browser.execute(() =>
        Array.from(document.querySelectorAll("table[aria-label='Network flows'] thead th")).map((h) => h.textContent?.trim()),
      );
    expect(await headers()).toContain("Type");
    await toggleColumn(NET, "Type");
    await browser.waitUntil(async () => !(await headers()).includes("Type"), {
      timeout: 5_000,
      timeoutMsg: "the Type header is still shown after unticking it in Columns ▾",
    });
    expect(await headers()).toContain("Host");
    // Put it back so later readers of this session see the default table.
    await toggleColumn(NET, "Type");
  });

  it("Logs shows the service's INFO lines as info and its ERROR line as error — raw, no marker", async () => {
    await openLogs();
    const info = await waitForLog((r) => r.text.includes("INFO svc: GET /health 200"), "`INFO svc: GET /health 200`");
    expect(info.level).toBe("info");
    expect(info.text).not.toMatch(/^[⚙◆▸]/);
    const err = await waitForLog((r) => r.text.includes("ERROR svc: upstream failed localhost:1"), "`ERROR svc: upstream failed`");
    expect(err.level).toBe("error");
    expect(err.source).toBe(info.source);
  });

  it("the Sources sidebar lists the service's terminal under Terminals; clicking it shows only that stream under a stream header, the Source column kept", async () => {
    // The service runs in the FOREGROUND of an IDE terminal here, so it is a Terminal source
    // (a `run_in_background` service would be a Service — covered by the Rust task tests).
    const svcSource = (await logRows()).find((r) => r.text.includes("INFO svc: GET /health 200"))?.source ?? "";
    let rows = await sidebarRows();
    const row = rows.find((c) => c.source === svcSource);
    if (!row) throw new Error(`no sidebar row for "${svcSource}"; rows: ${JSON.stringify(rows)}`);
    expect(row.group).toBe("terminal");
    expect(row.running).toBe("true");
    expect(row.name).toBe(svcSource);
    for (const r of rows) expect(r.name).not.toMatch(/ · bg$/);
    expect(row.count).toBeGreaterThanOrEqual(3); // opened + listening + /health + the error, at least
    // The ERROR line gives the row an error badge (a button).
    await expect($(`[data-testid="alog-src-row"][data-source="${svcSource}"] [data-testid="alog-src-errors"]`)).toBeDisplayed();

    // KNOWN GAP (not asserted here): two plain shells opened in the same
    // folder share one source label (`bash · workspace` — logstream::source_label is
    // "<pty title> · <cwd basename>"), so this row also counts the client terminal's lines and
    // cannot isolate the service from them. What IS asserted: the row narrows the list to
    // exactly its source, and the service's lines are in it.
    await $(`[data-testid="alog-src-row"][data-source="${svcSource}"] button.alog-side__main`).click();
    await browser.waitUntil(
      async () => {
        const sources = await rowSources();
        return sources.length > 0 && sources.every((s) => s === svcSource);
      },
      { timeout: 10_000, timeoutMsg: `the sidebar row did not narrow the rows to "${svcSource}"` },
    );
    rows = await sidebarRows();
    expect(rows.find((c) => c.source === svcSource)?.pressed).toBe("true");
    expect((await logRows()).some((r) => r.text.includes("INFO svc: GET /health 200"))).toBe(true);
    // One source selected: the Source column is NOT toggled by the selection —
    // it stays; a stream header names the selection instead.
    const headers = () =>
      browser.execute(() =>
        Array.from(document.querySelectorAll('[data-testid="alog-head"] .alog-head__cell')).map((c) => c.textContent?.trim()),
      );
    expect(await headers()).toEqual(["Time", "Level", "Source", "Text"]);
    await expect($('[data-testid="alog-stream-head"]')).toHaveAttribute("data-source", svcSource);
    await expect($('[data-testid="alog-stream-head"] .alog-stream-head__text')).toHaveText(
      / · terminal · ● running · \d+ lines · [1-9]\d* errors?$/,
    );
    // Back to every source: the header goes, the column is still there.
    await $('[data-testid="alog-src-all"]').click();
    await browser.waitUntil(async () => !(await $('[data-testid="alog-stream-head"]').isExisting()), {
      timeout: 10_000,
      timeoutMsg: "All did not remove the stream header",
    });
    expect(await headers()).toEqual(["Time", "Level", "Source", "Text"]);
  });

  it("the error badge jumps the list to the service's ERROR line and selects the source; All restores", async () => {
    const svcSource = (await logRows()).find((r) => r.text.includes("INFO svc: GET /health 200"))?.source ?? "";
    await $(`[data-testid="alog-src-row"][data-source="${svcSource}"] [data-testid="alog-src-errors"]`).click();
    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const t = document.querySelector('[data-testid="agent-logs-panel"] .alog-row--target');
          return t !== null && (t.textContent ?? "").includes("ERROR svc: upstream failed");
        }),
      { timeout: 10_000, timeoutMsg: "the error badge did not land on the ERROR line" },
    );
    expect((await sidebarRows()).find((c) => c.source === svcSource)?.pressed).toBe("true");
    // The landed row is inside the visible part of the scroll box.
    const inView = await browser.execute(() => {
      const list = document.querySelector('[data-testid="alog-list"]') as HTMLElement;
      const t = document.querySelector('[data-testid="agent-logs-panel"] .alog-row--target') as HTMLElement;
      const L = list.getBoundingClientRect();
      const T = t.getBoundingClientRect();
      return T.top >= L.top && T.bottom <= L.bottom;
    });
    expect(inView).toBe(true);
    await $('[data-testid="alog-src-all"]').click();
  });

  it("the text filter `health` finds the service's lines, and the sidebar counts each source's matches", async () => {
    const svcSource = (await logRows()).find((r) => r.text.includes("INFO svc: GET /health 200"))?.source ?? "";
    await $('[aria-label="Filter log lines"]').setValue("health");
    await browser.waitUntil(
      async () => {
        const rows = await logRows();
        return rows.length > 0 && rows.every((r) => r.text.toLowerCase().includes("health") || r.viaDetail);
      },
      { timeout: 10_000, interval: 250, timeoutMsg: "the filter `health` did not narrow the rows" },
    );
    const rows = await logRows();
    expect(rows.some((r) => r.text.includes("INFO svc: GET /health 200"))).toBe(true);
    expect(rows.some((r) => r.text.includes("upstream failed"))).toBe(false);
    await expect($(".alog-count")).toHaveText(/^\d+ of \d+ lines$/);
    // While the filter is active the service's row shows its MATCH count, not its line total.
    const matches = await $(`[data-testid="alog-src-row"][data-source="${svcSource}"] [data-testid="alog-src-matches"]`);
    await expect(matches).toBeDisplayed();
    await expect(matches).toHaveText(/^[1-9]\d*$/);
    await clearLogsFilter();
    await browser.waitUntil(
      async () => (await sidebarRows()).find((c) => c.source === svcSource)?.count !== undefined && !Number.isNaN((await sidebarRows()).find((c) => c.source === svcSource)?.count),
      { timeout: 10_000, timeoutMsg: "clearing the filter did not restore the line counts" },
    );
  });

  it("columns: drag the Logs Source column wider", async () => {
    const width = () =>
      browser.execute(
        () => document.querySelector('[data-testid="alog-head"] [data-col="source"]')?.getBoundingClientRect().width ?? -1,
      );
    const before = await width();
    expect(before).toBeGreaterThan(0);
    await dragResizer(LOGS, "Resize Source column", 100);
    const after = await width();
    if (after < before + 50) await snap("logs-source-resize");
    expect(after).toBeGreaterThanOrEqual(before + 50);
    // The rows follow the header (one grid template for both).
    const cell = await browser.execute(
      () => document.querySelector('[data-testid="alog-row"] .alog-src')?.getBoundingClientRect().width ?? -1,
    );
    expect(cell).toBeGreaterThan(before);
  });
  describe("dev apps on this machine", () => {
    let fileApp: ExternalNodeApp;
    let ttyApp: ExternalNodeApp;

    before(async () => {
      fileApp = startExternalNodeApp("file");
      ttyApp = startExternalNodeApp("terminal");
      // Each test here reads rows; start from an empty filter whatever ran before.
      await clearLogsFilter();
    });
    after(() => {
      fileApp.stop();
      ttyApp.stop();
    });

    const cardOf = (key: string) => $(`[data-testid="procs-card"][data-key="${key}"]`);
    const selectApp = async (key: string) => {
      await $(`${LOGS} [data-testid="procs-row"][data-key="${key}"]`).click();
      await cardOf(key).waitForDisplayed({ timeout: 10_000 });
    };

    it("the Apps group sits right under All, above every other group, with every runtime section", async () => {
      await openLogs();
      const section = $('[data-testid="procs-section"]');
      await section.waitForDisplayed({ timeout: 15_000 });
      await expect(section).toHaveAttribute("aria-label", "Apps");
      const order = await browser.execute(() =>
        Array.from(document.querySelector('[data-testid="alog-sidebar"] .alog-side__list')?.children ?? []).map(
          (c) => c.getAttribute("data-testid") ?? "",
        ),
      );
      expect(order.slice(0, 2)).toEqual(["alog-src-all", "procs-section"]);
      const heads = await browser.execute(() =>
        Array.from(document.querySelectorAll('[data-testid="procs-runtime"]')).map((s) => s.getAttribute("aria-label")),
      );
      expect(heads).toEqual(["Rust · Cargo", "JVM", "Node · JS", "Python", "Go", "Docker", "Shell"]);
      await expect($('[data-testid="alog-src-all-apps"]')).toBeDisplayed();
    });

    it("a Node app with its own terminal outside the IDE: listed as Node, card says console `terminal` and offers Restart in the IDE", async () => {
      const row = await waitForDevApp((r) => r.name === ttyApp.name, `named ${ttyApp.name}`);
      expect([row.runtime, row.section, row.origin, row.tag]).toEqual(["node", "Node · JS", "external", "external"]);
      expect(row.title).toMatch(/^pid \d+\n/);
      await selectApp(row.key);
      const card = cardOf(row.key);
      await expect(card.$('[data-testid="procs-console"]')).toHaveAttribute("data-console", "terminal");
      // Restart is offered, not pressed: it SIGTERMs the process after a confirm.
      await expect(card.$('[data-testid="procs-restart"]')).toBeDisplayed();
      // Nothing of it streams: the list says what to do instead of looking empty.
      await expect($('[data-testid="alog-app-hint"]')).toHaveText(/^Pick a log to stream/);
      // Picking another source (All) lets the app go: the card unmounts.
      await $('[data-testid="alog-src-all"]').click();
      await card.waitForExist({ reverse: true, timeout: 10_000 });
      expect((await devAppRows()).find((r) => r.key === row.key)?.pressed).toBe("false");
    });

    it("the service in the IDE's OWN terminal IS listed: origin ide, tagged by its terminal, console ide-terminal, no Restart", async () => {
      // procscan lists the IDE's own descendants, each naming the IDE
      // terminal its shell belongs to. The service runs in the FOREGROUND of a plain shell there.
      const row = await waitForDevApp((r) => r.title.includes("real-service.mjs"), "running real-service.mjs");
      expect([row.runtime, row.section, row.origin]).toEqual(["node", "Node · JS", "ide"]);
      // `launchedBy` is the terminal's title — the shell's source label (`bash · workspace`).
      const svcSource = (await logRows()).find((r) => r.text.includes("INFO svc: GET /health 200"))?.source ?? "";
      expect(svcSource).not.toBe("");
      expect(row.tag).toBe(`by ${svcSource}`);
      expect(row.tag).toMatch(/^by \S+ · \S+$/);
      // The IDE's apps come first in their section — before both external Node probes.
      const nodeRows = (await devAppRows()).filter((r) => r.runtime === "node");
      expect(nodeRows.findIndex((r) => r.key === row.key)).toBeLessThan(nodeRows.findIndex((r) => r.name === ttyApp.name));
      await selectApp(row.key);
      const card = cardOf(row.key);
      await expect(card.$('[data-testid="procs-console"]')).toHaveAttribute("data-console", "ide-terminal");
      await expect(card.$('[data-testid="procs-open-terminal"]')).toBeDisplayed();
      expect(await card.$('[data-testid="procs-restart"]').isExisting()).toBe(false);
      await expect(card.$('[data-testid="procs-requests"]')).toBeDisplayed();
      // Its output is still the Terminal source it always was.
      await expect($(`[data-testid="alog-src-row"][data-source="${svcSource}"]`)).toHaveAttribute("data-group", "terminal");
      await $('[data-testid="alog-src-all"]').click();
      await card.waitForExist({ reverse: true, timeout: 10_000 });
    });

    it("a Node app outside the IDE with stdout to a file: Stream tails it into Logs — raw `app` lines, soloed, under its app", async () => {
      const row = await waitForDevApp((r) => r.name === fileApp.name, `named ${fileApp.name}`);
      expect([row.runtime, row.origin]).toEqual(["node", "external"]);
      await selectApp(row.key);
      const card = cardOf(row.key);
      await expect(card.$('[data-testid="procs-console"]')).toHaveAttribute("data-console", "file");

      await card.$('button[aria-label="Stream probe.log"]').click();
      const source = `${fileApp.name} · probe.log`;
      // The new stream is soloed: a stream header names it, and every row is its.
      await browser.waitUntil(async () => (await $('[data-testid="alog-stream-head"]').getAttribute("data-source")) === source, {
        timeout: 15_000,
        timeoutMsg: `Stream did not solo "${source}"`,
      });
      const tick = await waitForLog((r) => /^probe tick \d+$/.test(r.text), "`probe tick N`");
      expect(tick.level).toBe("info");
      const sources = await browser.execute(() =>
        Array.from(document.querySelectorAll('[data-testid="agent-logs-panel"] [data-testid="alog-row"]')).map((r) =>
          r.getAttribute("data-source"),
        ),
      );
      expect(sources.length).toBeGreaterThan(0);
      expect(sources.every((s) => s === source)).toBe(true);
      // Raw like a service: rows, never a command block.
      expect(await $$('[data-testid="agent-logs-panel"] [data-testid="alog-block-head"]').length).toBe(0);
      // The stream is a row UNDER the app's row in the same group, labelled by its file.
      const nested = await browser.execute((key: string) => {
        const next = document.querySelector(`[data-testid="alog-sidebar"] [data-testid="procs-row"][data-key="${key}"]`)?.nextElementSibling;
        return {
          inSection: (next?.closest('[data-testid="procs-section"]') ?? null) !== null,
          source: next?.getAttribute("data-source") ?? "",
          group: next?.getAttribute("data-group") ?? "",
          name: next?.querySelector(".alog-side__name")?.textContent ?? "",
        };
      }, row.key);
      expect(nested).toEqual({ inSection: true, source, group: "app", name: "probe.log" });
      // Its own stream was picked, so the app is still selected, and its row shows ● streaming.
      await expect(card).toBeDisplayed();
      const live = $(`${LOGS} [data-testid="procs-row"][data-key="${row.key}"] [data-testid="procs-live"]`);
      await expect(live).toBeDisplayed();

      // The toolbar's text filter searches `app` lines like any raw line.
      await $('[aria-label="Filter log lines"]').setValue("probe tick 1");
      await browser.waitUntil(
        async () => {
          const rows = await logRows();
          return rows.length > 0 && rows.every((r) => r.text.startsWith("probe tick 1"));
        },
        {
          timeout: 10_000,
          timeoutMsg: "the text filter did not narrow the app's lines",
        },
      );
      await clearLogsFilter();

      // Stop the tail; All lets the app go.
      await card.$('button[aria-label="Stop probe.log"]').click();
      await live.waitForExist({ reverse: true, timeout: 10_000 });
      await $('[data-testid="alog-src-all"]').click();
      await card.waitForExist({ reverse: true, timeout: 10_000 });
    });
  });

  describe("the capture guard: a service started with the proxy variables stripped", () => {
    // The case guarded: a service launched from an IDE terminal with every proxy variable
    // removed sends none of its calls to Network — silently. This fixture is started
    // the same way (`env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy …`).
    let nocap: OpenedTerminal;
    let oldKey = "";
    let newKey = "";
    const isNocap = (r: { title: string }) => r.title.includes("nocap-service.mjs");
    const nodeSelfcalls = async () =>
      (await flowRows()).filter((r) => r.process === "node" && r.path === "/health" && r.host === "localhost");

    before(async () => {
      nocap = await openAnotherTerminal();
      await runIn(nocap, nocapServiceLine());
      await browser.waitUntil(async () => (await terminalText(nocap.id)).includes(`listening on http://localhost:${NOCAP_PORT}`), {
        timeout: 20_000,
        timeoutMsg: "the stripped service never printed `listening on`",
      });
      // The filter box only exists while Logs is in front — opening a terminal put the
      // terminal tab there.
      await openLogs();
      await clearLogsFilter();
    });

    it("its card and its Logs row say it is not captured", async () => {
      await openLogs();
      const row = await waitForDevApp((r) => isNocap(r) && r.origin === "ide", "nocap-service.mjs (origin ide)");
      oldKey = row.key;
      // ⚠ on the sidebar row, once the next scan has judged its env.
      const mark = $(`${LOGS} [data-testid="procs-row"][data-key="${oldKey}"] [data-testid="procs-uncaptured-mark"]`);
      await mark.waitForExist({ timeout: 15_000, timeoutMsg: "no ⚠ on the stripped service's row" });
      await $(`${LOGS} [data-testid="procs-row"][data-key="${oldKey}"]`).click();
      const card = $(`[data-testid="procs-card"][data-key="${oldKey}"]`);
      await card.waitForDisplayed({ timeout: 10_000 });
      await expect(card.$('[data-testid="procs-uncaptured"]')).toHaveText(
        /was started without the IDE's proxy — its launcher removed the proxy variables, so its HTTP calls can't reach Network\.$/,
      );
      await expect(card.$('[data-testid="procs-restart-capture"]')).toBeDisplayed();
    });

    it("Network names it in a banner and on its sidebar row — and its own call really is missing", async () => {
      // The service calls itself; with the proxy stripped the call goes direct and Network never sees it.
      await runIn(client, `curl -s http://localhost:${NOCAP_PORT}/selfcall; echo`);
      await browser.waitUntil(async () => (await terminalText(client.id)).includes('{"selfcall":"direct","ok":true}'), {
        timeout: 20_000,
        timeoutMsg: "the stripped service's /selfcall did not answer `direct`",
      });
      await openNetwork();
      const banner = $(`${NET} [data-testid="net-uncaptured-row"][data-key="${oldKey}"]`);
      await banner.waitForDisplayed({ timeout: 15_000, timeoutMsg: "no Not-captured banner for the stripped service" });
      await expect(banner).toHaveText(/^⚠ Not captured: .*nocap-service\.mjs.* \(pid \d+\) — started without the IDE's proxy\./);
      const side = (await networkAppRows()).find((r) => r.key === oldKey);
      expect(side?.capture).toBe("uncaptured");
      // The curl TO it is captured (the client terminal has the proxy); its own call is not.
      await waitForFlow((r) => r.path === "/selfcall" && r.process === "curl", "curl → /selfcall");
      expect(await nodeSelfcalls()).toEqual([]);
    });

    it("Restart with capture (confirmed) relaunches it in an IDE terminal; its card flips to ✓ Receiving and Show them lands on its rows", async () => {
      await openLogs();
      // The previous test left this row selected, and a click on the SELECTED row deselects it
      // (DevAppsSection: "Clicking the selected row again deselects") — so click only when it is
      // not already pressed (otherwise this click hides the card).
      const oldRow = $(`${LOGS} [data-testid="procs-row"][data-key="${oldKey}"]`);
      if ((await oldRow.getAttribute("aria-pressed")) !== "true") await oldRow.click();
      const card = $(`[data-testid="procs-card"][data-key="${oldKey}"]`);
      await card.waitForDisplayed({ timeout: 10_000 });
      await card.$('[data-testid="procs-restart-capture"]').click();
      const dialog = $('[data-testid="procs-restart-dialog"]');
      await dialog.waitForDisplayed({ timeout: 5_000 });
      await expect(dialog).toHaveText(/Stop it and run the same command in an IDE terminal with capture on\?/);
      await dialog.$('[data-testid="procs-restart-confirm"]').click();
      await dialog.waitForExist({ reverse: true, timeout: 20_000 });

      await openLogs();
      const fresh = await waitForDevApp((r) => isNocap(r) && r.origin === "ide" && r.key !== oldKey, "the relaunched nocap-service.mjs");
      newKey = fresh.key;
      expect((await devAppRows()).some((r) => r.key === oldKey)).toBe(false);
      // Its own call now goes through the proxy.
      await runIn(client, `curl -s http://localhost:${NOCAP_PORT}/selfcall; echo`);
      await browser.waitUntil(async () => (await terminalText(client.id)).includes('{"selfcall":"proxy","ok":true}'), {
        timeout: 20_000,
        timeoutMsg: "the relaunched service's /selfcall did not go through the proxy",
      });
      await openLogs();
      await $(`${LOGS} [data-testid="procs-row"][data-key="${newKey}"]`).click();
      const newCard = $(`[data-testid="procs-card"][data-key="${newKey}"]`);
      await newCard.waitForDisplayed({ timeout: 10_000 });
      const receiving = newCard.$('[data-testid="net-idecap-receiving"]');
      await browser.waitUntil(async () => /^✓ Receiving .*'s requests — \d+ so far/.test(await receiving.getText().catch(() => "")), {
        timeout: 20_000,
        timeoutMsg: "the relaunched service's card never said ✓ Receiving",
      });
      await expect(newCard.$('[data-testid="net-idecap-where"]')).toHaveText(/^They appear under IDE traffic, Source .+, Process node\.$/);
      await receiving.$('[data-testid="net-idecap-show"]').click();
      await $(NET).waitForDisplayed({ timeout: 10_000 });
      const own = await waitForFlow((r) => r.process === "node" && r.path === "/health" && r.host === "localhost", "the service's own /health call");
      expect(own.status).toBe("200");
      expect((await flowRows()).every((r) => r.process === "node")).toBe(true);
      // No longer in the banner.
      await $(`${NET} [data-testid="net-uncaptured-row"][data-key="${newKey}"]`).waitForExist({ reverse: true, timeout: 10_000 });
    });

    it("the Network sidebar: its row is ✓, and picking it (row click = Only) leaves only its flows", async () => {
      await openNetwork();
      await $(`${NET} [data-testid="net-apps-all"]`).click();
      // The previous test's "Show them" narrowed the TOOLBAR's Process picker to `node`
      // (agentLogsFocus.showRequestsOf); the sidebar's All apps does not touch the toolbar's
      // pickers by design, so put that one back to All processes the way a user would.
      await $(`${NET} .net-bar button[aria-label="Filter by process"]`).click();
      const allProcs = $(`${NET} .net-bar .app-picker__row--all input[type="checkbox"]`);
      await allProcs.waitForExist({ timeout: 5_000 });
      if (!(await allProcs.isSelected())) await allProcs.click();
      await browser.keys("Escape");
      await browser.waitUntil(async () => (await networkAppRows()).find((r) => r.key === newKey)?.capture === "captured", {
        timeout: 15_000,
        timeoutMsg: "the relaunched service's Network row is not ✓",
      });
      // Other apps' flows are in the table before the pick (curl's calls from the client terminal).
      expect((await flowRows()).some((r) => r.process === "curl")).toBe(true);
      await $(`${NET} [data-testid="procs-line"][data-key="${newKey}"] [data-testid="procs-row"]`).click();
      await browser.waitUntil(
        async () => {
          const rows = await flowRows();
          return rows.length > 0 && rows.every((r) => r.process === "node" && r.host === "localhost");
        },
        { timeout: 10_000, timeoutMsg: "picking the service did not leave only its flows" },
      );
      await expect($(`${NET} [data-testid="procs-line"][data-key="${newKey}"] [data-testid="net-app-check"]`)).toBeChecked();
      await $(`${NET} [data-testid="net-apps-all"]`).click();
      await browser.waitUntil(async () => (await flowRows()).some((r) => r.process === "curl"), {
        timeout: 10_000,
        timeoutMsg: "All apps did not bring every flow back",
      });
    });
  });
  /*
   * A tunnel from a client that does NOT trust the IDE's CA (`TUNNEL CONNECT api.example.net:443 —`)
   * used to look unfinished and did not show what it was doing. Here, locally (no internet): `openssl s_server` on loopback with a throwaway
   * self-signed cert, and `wget` (not on the decrypt list) fetching it through the injected proxy
   * with Decrypt HTTPS ON. The request must still work (decryption must never break a client), and the row + card must say
   * what the tunnel is: closed, bytes each way, why it was not decrypted, how to see more.
   */
  describe("an HTTPS client that does not trust the IDE's CA: an explained tunnel, not a blank row", () => {
    const TLS_PORT = 47823;
    const DECRYPT = '//*[@data-testid="network-panel"]//button[@role="switch"][normalize-space(.)="Decrypt HTTPS"]';
    let decryptWasOn = false;

    before(async () => {
      await openNetwork();
      const decrypt = $(DECRYPT);
      await decrypt.waitForEnabled({ timeout: 15_000 });
      decryptWasOn = (await decrypt.getAttribute("aria-checked")) === "true";
      if (!decryptWasOn) await decrypt.click();
      await expect(decrypt).toHaveAttribute("aria-checked", "true");
    });

    after(async () => {
      await openNetwork();
      const decrypt = $(DECRYPT);
      if (((await decrypt.getAttribute("aria-checked")) === "true") !== decryptWasOn) await decrypt.click();
    });

    it("wget → local s_server: the page arrives, the row is a closed tunnel with bytes, the card explains it", async () => {
      const tls = await openAnotherTerminal();
      // One line: cert, server in the background, the fetch, then the server is stopped.
      await runIn(
        tls,
        `cd "$(mktemp -d)" && openssl req -x509 -newkey rsa:2048 -nodes -subj /CN=localhost -keyout k.pem -out c.pem -days 1 2>/dev/null ` +
          `&& (openssl s_server -quiet -accept 127.0.0.1:${TLS_PORT} -cert c.pem -key k.pem -www >/dev/null 2>&1 & echo $! > s.pid) ` +
          `&& sleep 1 && wget --no-check-certificate -qO- https://127.0.0.1:${TLS_PORT}/ | grep -c s_server | sed 's/^/tls-hits:/'; ` +
          `kill "$(cat s.pid)"`,
      );
      // The never-break check: the client's request SUCCEEDED through the tunnel.
      await browser.waitUntil(async () => /tls-hits:[1-9]/.test(await terminalText(tls.id)), {
        timeout: 45_000,
        timeoutMsg: "wget never printed the s_server page through the proxy",
      });

      await openNetwork();
      const row = await waitForFlow(
        (r) => r.proto === "TUNNEL" && r.host === `127.0.0.1:${TLS_PORT}` && r.process === "wget" && r.status === "closed",
        `a closed TUNNEL 127.0.0.1:${TLS_PORT} from wget`,
      );
      expect(row.method).toBe("CONNECT");
      expect(row.type).toBe("not decrypted: wget doesn't read the IDE's CA");
      // Bytes each way, never a bare `—`.
      expect(row.size).toMatch(/^↑\d+(\.\d)?[BKM] ↓\d+(\.\d)?[BKM]$/);
      expect(row.size).not.toMatch(/↑0B|↓0B/);
      expect(row.path).toMatch(/^encrypted · \d+(\.\d)?(B|KB|MB) ↑ \d+(\.\d)?(B|KB|MB) ↓$/);

      const detail = await openFlow(row.flowId);
      const card = detail.$('[data-testid="net-tunnel-card"]');
      await card.waitForDisplayed({ timeout: 10_000 });
      await expect(card.$("h4")).toHaveText("Encrypted tunnel — contents not visible");
      await expect(detail.$('[data-testid="net-tunnel-why"]')).toHaveText(/^wget isn't on the decrypt list: it doesn't read the IDE's certificate/);
      await expect(detail).toHaveText(/TUNNEL · \d+(\.\d)?m?s · connection closed/);
      const facts = await browser.execute(() =>
        Object.fromEntries(
          Array.from(document.querySelectorAll('[data-testid="net-facts"] .net-facts__row')).map((r) => [
            r.querySelector("dt")?.textContent?.trim() ?? "",
            r.querySelector("dd")?.textContent?.trim() ?? "",
          ]),
        ),
      );
      expect(facts.Host).toBe("127.0.0.1");
      expect(facts.Port).toBe(String(TLS_PORT));
      expect(facts.Closed).not.toBe("still open");
      expect(facts.Process).toMatch(/^wget \(pid \d+\)/);
      expect(facts.Source).toBe(tls.title);
      // The s_server page came back through the tunnel: real bytes down.
      expect(Number(/\((\d+) B\)/.exec(facts.Received ?? "")?.[1] ?? 0)).toBeGreaterThan(500);
      // The three ways to see the requests, with the per-app switch wired (off: wget is not opted in).
      await expect(detail.$('button[role="switch"][data-testid="net-tunnel-decrypt-app"]')).toHaveAttribute("aria-checked", "false");
      await expect(detail.$('[data-testid="net-tunnel-cargo"]')).toHaveText(/rustls-tls-native-roots/);
      await expect(detail.$('[data-testid="net-tunnel-logs"] button')).toHaveText("Open Logs");
      await snap("tunnel-card-wget");
    });
  });
});
