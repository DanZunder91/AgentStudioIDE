/**
 * Helpers for the gazelle-like scenario (e2e/specs/gazelle-like*.e2e.ts; docs/design/testing-strategy.md
 * "gazelle-like scenario"): start the Rust fixture in an IDE terminal the way a realistic Rust
 * service is run, run the fake agent in another, and — for the hermetic spec — a LOCAL TLS upstream the
 * fixture trusts through one extra test root (never the IDE's CA).
 *
 * Reads the shared real-service helpers; owns nothing in them.
 */

import { $, browser, expect } from "@wdio/globals";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { openNetwork, snap, terminalText } from "./real-service";
import type { OpenedTerminal } from "./terminal";

/** The fixture binary, built by scripts/e2e-linux.mjs into the E2E target volume. */
export const GAZELLE_BIN = process.env.GAZELLE_LIKE_BIN ?? "/repo/src-tauri/target/fixtures/debug/gazelle-like";
/** The port the fixture serves on, and its default. */
export const GAZELLE_PORT = 3000;
export const GAZELLE_URL = `http://127.0.0.1:${GAZELLE_PORT}`;
/** The fixture's own dir, relative to the fixture workspace: its cwd names the app `gazelle-like`. */
export const GAZELLE_DIR = "../gazelle-like";
/** The local TLS upstream of the hermetic spec. */
export const TLS_UPSTREAM_PORT = 47830;

/**
 * Where the fixture writes its log file. NOT in the repo: under Docker Desktop the bind-mounted repo
 * is a virtiofs share, and the kernel reports an open file there as `/run/host_virtiofs/<host path>`
 * — a path that does not exist inside the container, so Stream failed with ENOENT (an
 * artefact of the E2E's mount, not of a real Mac). A container-native dir avoids it.
 */
export const GAZELLE_LOG_DIR = "/tmp/gazelle-like";

/** The shell line that runs the fixture in the foreground of an IDE terminal (its cwd = its own dir). */
export function gazelleLine(env: Record<string, string> = {}): string {
  const vars = Object.entries({ GAZELLE_LOG: `${GAZELLE_LOG_DIR}/gazelle-like.log`, ...env }).map(([k, v]) => `${k}='${v}'`);
  // A fresh log each run: the Logs assertions must not read a previous run's lines.
  return `cd ${GAZELLE_DIR} && rm -rf ${GAZELLE_LOG_DIR} && mkdir -p ${GAZELLE_LOG_DIR} && ${[...vars, GAZELLE_BIN].join(" ")}`;
}

/** The agent's name as Network's sidebar shows it (its AGENTS row) — what its flows' Source reads. */
export async function agentNameInNetwork(agentId: string): Promise<string> {
  let name = "";
  await browser.waitUntil(
    async () => {
      name = await browser.execute(
        (key: string) =>
          document.querySelector(`[data-testid="net-apps"] [data-testid="net-src-row"][data-source="${key}"] .net-side__name`)?.textContent ?? "",
        `t:${agentId}`,
      );
      return name !== "";
    },
    { timeout: 15_000, timeoutMsg: `the agent t:${agentId} has no row in Network's sidebar` },
  );
  return name;
}

/** Wait until `re` shows in a terminal's output; fail with the whole screen and a screenshot. */
export async function waitForScreen(term: OpenedTerminal, re: RegExp, what: string, timeout = 45_000): Promise<string> {
  let text = "";
  const ok = await browser
    .waitUntil(
      async () => {
        text = await terminalText(term.id);
        return re.test(text);
      },
      { timeout, interval: 300 },
    )
    .catch(() => false);
  if (!ok) {
    await snap(`gazelle-terminal-${what}`);
    throw new Error(`${what}: ${re} never appeared in the terminal; screen:\n${text}`);
  }
  return text;
}

/** Rename the ACTIVE tab (double-click its title, type, Enter) — the way a user names a terminal. */
export async function renameActiveTab(name: string): Promise<void> {
  const title = await $('[role="tab"][aria-selected="true"] .pane-tab__title');
  await title.waitForDisplayed({ timeout: 10_000 });
  await title.doubleClick();
  const input = await $('[role="tab"][aria-selected="true"] .pane-tab__title-input');
  await input.waitForDisplayed({ timeout: 5_000 });
  // The input pre-selects its value on mount, so typing replaces it.
  for (const ch of name) await browser.keys(ch);
  await browser.keys("Enter");
  await $(`[role="tab"][title="${name}"]`).waitForExist({ timeout: 5_000 });
}

/** Turn Network's Decrypt HTTPS on (the env is fixed at spawn: open terminals AFTER this). */
export async function enableDecrypt(): Promise<void> {
  await openNetwork();
  const decrypt = $(
    '//*[@data-testid="network-panel"]//button[@role="switch"][contains(normalize-space(.), "Decrypt HTTPS")]',
  );
  await decrypt.waitForEnabled({ timeout: 15_000 });
  if ((await decrypt.getAttribute("aria-checked")) !== "true") await decrypt.click();
  await expect(decrypt).toHaveAttribute("aria-checked", "true");
}

/** Every visible text of the flow detail pane (one string). */
export async function detailText(): Promise<string> {
  return browser.execute(() => document.querySelector('[data-testid="net-detail"]')?.textContent ?? "");
}

/** A named checkpoint screenshot (`gl__<n>-<name>.png`), only with E2E_CHECKPOINTS=1. */
let checkpointN = 0;
export async function checkpoint(name: string): Promise<void> {
  if (process.env.E2E_CHECKPOINTS !== "1") return;
  checkpointN += 1;
  await snap(`gl__${String(checkpointN).padStart(2, "0")}-${name}`);
}

export interface TlsUpstream {
  /** The PEM of the test CA that signed the server's certificate — handed to gazelle-like only. */
  caPath: string;
  url: string;
  hits: () => number;
  stop: () => void;
}

/**
 * A local HTTPS server on `localhost:<port>` with a certificate from a throwaway test CA (made
 * here with the image's `openssl`, in a temp dir, deleted on stop — no key is ever committed).
 * Every response carries `Connection: close`, so each call is one connection and its tunnel row
 * CLOSES (shows `closed` + final bytes) instead of idling in a pool.
 */
export function startTlsUpstream(port = TLS_UPSTREAM_PORT): Promise<TlsUpstream> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gl-tls-"));
  const p = (f: string): string => path.join(dir, f);
  const ssl = (...args: string[]): void => {
    execFileSync("openssl", args, { cwd: dir, stdio: "ignore" });
  };
  const ec = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"];
  ssl("req", "-x509", ...ec, "-keyout", p("ca.key"), "-out", p("ca.pem"), "-days", "2", "-subj", "/CN=gazelle-like test CA",
    "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign");
  ssl("req", ...ec, "-keyout", p("leaf.key"), "-out", p("leaf.csr"), "-subj", "/CN=localhost");
  fs.writeFileSync(
    p("leaf.ext"),
    "basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n",
  );
  ssl("x509", "-req", "-in", p("leaf.csr"), "-CA", p("ca.pem"), "-CAkey", p("ca.key"), "-CAcreateserial",
    "-out", p("leaf.pem"), "-days", "2", "-extfile", p("leaf.ext"));

  let n = 0;
  const body = JSON.stringify({ upstream: "local-tls", rates: [1.1, 2.4, 5.0], pad: "x".repeat(512) });
  const server = https.createServer({ key: fs.readFileSync(p("leaf.key")), cert: fs.readFileSync(p("leaf.pem")) }, (_req, res) => {
    n += 1;
    res.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
    res.end(body);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () =>
      resolve({
        caPath: p("ca.pem"),
        url: `https://localhost:${port}/`,
        hits: () => n,
        stop: () => {
          server.close();
          fs.rmSync(dir, { recursive: true, force: true });
        },
      }),
    );
  });
}

/* ── the fake agent: an IDE AGENT (quick-launch) whose stub `claude` runs fake-agent.sh ── */

const FAKE_AGENT_ABS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "fake-agent.sh");
/** claude-stub.sh execs this file when it exists (and only then). */
const AGENT_TRIGGER = path.join(os.tmpdir(), "agentstudio-e2e-agent.sh");

async function terminalIdList(): Promise<string[]> {
  return browser.execute(() =>
    Array.from(document.querySelectorAll(".terminal-view[data-terminal-id]")).map((e) => e.getAttribute("data-terminal-id") ?? ""),
  );
}

/**
 * Launch an agent with the left rail's ⚡ quick-launch, its stub `claude` running the fake agent
 * (`fake-agent.sh [--external]`). Returns the agent's terminal (id = its agent id) and tab title.
 * The trigger file is removed as soon as the agent is up, so no later agent in the run is affected.
 */
export async function launchFakeAgent(opts: { external?: boolean } = {}): Promise<OpenedTerminal> {
  fs.rmSync(AGENT_OUT, { force: true });
  const args = opts.external ? " --external" : "";
  fs.writeFileSync(AGENT_TRIGGER, `exec sh '${FAKE_AGENT_ABS}'${args} "$@"\n`);
  try {
    const before = new Set(await terminalIdList());
    const quick = await $('[data-testid="left-rail"] button[aria-label^="Quick-launch an agent"]');
    await quick.waitForClickable({ timeout: 15_000 });
    await quick.click();
    const id = await browser.waitUntil(async () => (await terminalIdList()).find((t) => !before.has(t)) ?? false, {
      timeout: 15_000,
      timeoutMsg: "quick-launch did not mount an agent terminal",
    });
    const term: OpenedTerminal = {
      id,
      title: await browser.execute(
        () => document.querySelector('[role="tab"][aria-selected="true"] .pane-tab__title')?.textContent?.trim() ?? "",
      ),
    };
    await waitForAgent(/fake agent \(gazelle-like\) ready/, "fake-agent-ready", 30_000);
    return term;
  } finally {
    fs.rmSync(AGENT_TRIGGER, { force: true });
  }
}

/** Remove the trigger if a spec died before launchFakeAgent could. */
export function clearFakeAgentTrigger(): void {
  fs.rmSync(AGENT_TRIGGER, { force: true });
}

/**
 * What the fake agent printed. An AGENT terminal's PTY output is deliberately not in the log hub
 * (Claude's TUI redraws are noise), and under WebGL its screen is a canvas — so the agent tees its
 * output to this file (same container as the runner). The screenshot shows the same text on screen.
 */
const AGENT_OUT = path.join(os.tmpdir(), "agentstudio-e2e-agent.out");
export function fakeAgentOutput(): string {
  try {
    return fs.readFileSync(AGENT_OUT, "utf8");
  } catch {
    return "";
  }
}

export async function waitForAgent(re: RegExp, what: string, timeout = 45_000): Promise<string> {
  let text = "";
  const ok = await browser
    .waitUntil(async () => re.test((text = fakeAgentOutput())), { timeout, interval: 300 })
    .catch(() => false);
  if (!ok) {
    await snap(`gazelle-agent-${what}`);
    throw new Error(`${what}: ${re} never appeared in the fake agent's output:\n${text}`);
  }
  return text;
}
