/** Non-React owner of every xterm instance. PTY bytes land only in `channel.onmessage` and go
 * straight to `term.write()`, never React or the store (ARCHITECTURE §1, §4). `detach()` keeps
 * the emulator alive so tab switches are lossless; only `dispose()` tears down. */

import "@xterm/xterm/css/xterm.css";

import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import type { IDisposable } from "@xterm/xterm";

import {
  Channel,
  closeTerminal,
  openTerminal,
  reattachTerminal,
  resizeTerminal,
  toBytes,
  writeTerminal,
} from "../../app/ipc";
import type { RawFrame } from "../../app/ipc";
import type { AgentId, TerminalId, TerminalMeta } from "../../app/types";
// The agent half of the command surface. Imported from the module directly
// rather than `../fleet` so this stays a plain non-React module — the barrel
// pulls in the rail's components.
import { spawnAgent } from "../fleet/fleetIpc";
import { urlOpen } from "../git/gitIpc";
import type { SearchUiOptions } from "./find/searchModel";
import { mountRenderer } from "./renderer";
import type { RendererHandle } from "./renderer";
import { installSettleRepaint } from "./settleRepaint";
import { installTerminalClipboardKeys } from "./terminalClipboard";
import {
  TERMINAL_FONT_SIZE,
  TERMINAL_LINE_HEIGHT,
  TERMINAL_SCROLLBACK,
  terminalFontFamily,
  terminalTheme,
} from "./theme";

/** ARCHITECTURE §2.4: "Debounced 50 ms UI-side." */
const RESIZE_DEBOUNCE_MS = 50;

/** FitAddon's clamp floor (MINIMUM_COLS/ROWS in `@xterm/addon-fit`, not exported): a proposal at
 * either value means that axis could not be measured (see `applyFit`). */
const FIT_MIN_COLS = 2;
const FIT_MIN_ROWS = 1;

const encoder = new TextEncoder();

/** Spawn overrides. `agentId` alone makes an agent terminal: same xterm, Channel and lifecycle,
 * only `agent_spawn` instead of `terminal_open`; the PTY path is not forked (nor is Rust's). */
export interface TerminalSpawnOptions {
  /** Absolute path. Falls back to the registry default (`setDefaultTerminalCwd`). */
  cwd?: string;
  /** Defaults to the user's `$SHELL`, resolved on the Rust side. */
  program?: string;
  args?: string[];
  /** Set => spawn via `agent_spawn`. Must equal this terminal's `TerminalId`: Rust keys the PTY
   * by agentId (`supervisor/mod.rs`), so a mismatch streams output but every write/resize/close
   * misses; `openPty` checks it. */
  agentId?: AgentId;
  /** AgentAdapter runtime id (e.g. `"claude-code"`), required with `agentId` unless `reattach`.
   * Not a program: binary, flags and transcript layout are `agent/claude.rs`'s business alone. */
  runtime?: string;
  /** Set => re-subscribe via `terminal_reattach` to a PTY that survived a webview reload;
   * overrides `agentId`/`program`. Only the store's `rebuildTerminalTabs` sets it. */
  reattach?: boolean;
  /** A past session to resume (`agent_spawn`'s `resumeSessionId` → `claude --resume <id>`), set
   * only from the session picker. Requires `agentId`/`runtime`; ignored when reattaching. */
  resumeSessionId?: string;
}

interface Size {
  rows: number;
  cols: number;
}

interface Entry {
  id: TerminalId;
  term: Terminal;
  fit: FitAddon;
  serialize: SerializeAddon;
  search: SearchAddon;
  /** Find-overlay query + toggles, here so they survive the overlay unmounting and die with the
   * terminal. */
  searchUi: TerminalSearchUiState | null;
  renderer: RendererHandle | null;
  channel: Channel<ArrayBuffer>;
  /** Persistent wrapper that xterm renders into; re-parented on attach/detach. */
  container: HTMLDivElement;
  /** The React-owned element the container currently lives in, if attached. */
  host: HTMLElement | null;
  ro: ResizeObserver | null;
  resizeTimer: number | null;
  disposables: IDisposable[];
  /** `term.open()` has run — only valid once the container has been in the DOM. */
  domOpened: boolean;
  /** A `terminal_open` is in flight or has settled. */
  opening: boolean;
  /** The PTY exists and accepts writes/resizes. */
  ptyReady: boolean;
  /** The child has exited (reattached to a dead PTY, or an agent's `claude` ended
   *  while we watched); read-only scrollback. */
  exited: boolean;
  /** The PTY's child IS the agent (`agent_spawn`), not a shell hosting one. */
  agentPty: boolean;
  /** `applyFit` has measured a real host. Until then rows/cols are xterm's 24x80 guess and
   * `pushSize` sends nothing, so a reattach (reload, tear-off: tab-tearoff.md §7) never reflows a
   * live TUI. */
  fitted: boolean;
  /** Size the Rust side currently believes the PTY is. */
  sentSize: Size | null;
  /** Keystrokes typed before the PTY finished opening; flushed in order. */
  pendingInput: Uint8Array[];
  meta: TerminalMeta | null;
  disposed: boolean;
}

const registry = new Map<TerminalId, Entry>();

let defaultCwd = ".";

/** Until set, Rust resolves `"."` against the app process's cwd. */
export function setDefaultTerminalCwd(cwd: string): void {
  defaultCwd = cwd;
}

const configured = new Map<TerminalId, TerminalSpawnOptions>();

/** Lets a caller that knows the cwd/program stay decoupled from the component that mounts it. */
export function configureTerminal(terminalId: TerminalId, opts: TerminalSpawnOptions): void {
  configured.set(terminalId, { ...configured.get(terminalId), ...opts });
}

/* ───────────────────────── detached DOM holder ───────────────────────── */

let holder: HTMLDivElement | null = null;

/** Offscreen `display:none` parent: the emulator lives with no render cost, and every attach
 * re-fits, so a hidden element's stale measurements never reach the user. */
function detachedHolder(): HTMLDivElement {
  if (!holder) {
    holder = document.createElement("div");
    holder.dataset.agentstudio = "terminal-detached-holder";
    holder.style.display = "none";
    document.body.appendChild(holder);
  }
  return holder;
}

/* ─────────────────────── scrollback wheel bypass ─────────────────────── */

/** Mouse tracking (claude's `?1002h` + `?1006h`) makes xterm give the wheel to the app and stop
 * scrolling scrollback. On the normal buffer we scroll it ourselves and withhold the event (as
 * kitty and iTerm2 do); on the alternate buffer the wheel stays the app's. */
function installScrollbackWheelBypass(term: Terminal): void {
  // Fractional lines carried between pixel-delta (trackpad) events, so slow
  // scrolls accumulate instead of rounding to zero every frame.
  let pixelRemainder = 0;

  term.attachCustomWheelEventHandler((ev: WheelEvent): boolean => {
    // Alt buffer: the app owns its viewport — defer (also: no scrollback here).
    if (term.buffer.active.type !== "normal") return true;
    // No app mouse capture: xterm's own scrollback scrolling already works.
    if (term.modes.mouseTrackingMode === "none") return true;

    // Normal buffer + mouse tracking: scroll the terminal's own scrollback.
    let lines: number;
    if (ev.deltaMode === WheelEvent.DOM_DELTA_LINE) {
      lines = ev.deltaY;
    } else if (ev.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
      lines = ev.deltaY * term.rows;
    } else {
      // DOM_DELTA_PIXEL — the common macOS/trackpad case.
      pixelRemainder += ev.deltaY / cellHeightPx(term);
      lines = Math.trunc(pixelRemainder);
      pixelRemainder -= lines;
    }

    if (lines !== 0) term.scrollLines(lines);
    return false; // handled locally; do NOT forward the wheel to the app
  });
}

/** Rendered height of one row, measured off the screen element. */
function cellHeightPx(term: Terminal): number {
  const screen = term.element?.querySelector<HTMLElement>(".xterm-screen");
  if (screen && term.rows > 0) {
    const h = screen.clientHeight / term.rows;
    if (h > 0) return h;
  }
  // Fallback before first paint: derived from the configured font metrics.
  return TERMINAL_FONT_SIZE * TERMINAL_LINE_HEIGHT;
}

/* ──────────────────────────── sizing ──────────────────────────── */

function pushSize(entry: Entry): void {
  if (entry.disposed || !entry.ptyReady || !entry.fitted) return;
  const { rows, cols } = entry.term;
  if (rows < 1 || cols < 1) return;
  if (entry.sentSize && entry.sentSize.rows === rows && entry.sentSize.cols === cols) return;
  entry.sentSize = { rows, cols };
  void resizeTerminal(entry.id, rows, cols).catch((err) => {
    console.warn(`[terminal ${entry.id}] resize failed`, err);
  });
}

/** FitAddon clamps an unmeasurable host to `{cols: 2, rows: 1}` instead of undefined, and
 * `attach()` fits before allotment lays out: a 2-column resize redraws `claude` 2 chars wide, so
 * send nothing then. Each guard fixes it alone; keep both (different invariants). */
function applyFit(entry: Entry): void {
  if (entry.disposed || !entry.host || !entry.domOpened) return;

  // Guard 1 — the actual cause: no layout, no fit. Stops FitAddon from ever
  // being asked to measure an unlaid-out host.
  if (entry.host.clientWidth <= 0 || entry.host.clientHeight <= 0) return;

  const dims = entry.fit.proposeDimensions();
  if (!dims || !Number.isFinite(dims.rows) || !Number.isFinite(dims.cols)) return;

  // Guard 2: the clamp floor, per axis (axes fail independently: a column split can yield
  // {cols: 2, rows: 38}).
  if (dims.cols <= FIT_MIN_COLS || dims.rows <= FIT_MIN_ROWS) return;

  try {
    entry.fit.fit();
  } catch (err) {
    console.warn(`[terminal ${entry.id}] fit failed`, err);
    return;
  }
  entry.fitted = true;
  pushSize(entry); // post-fit rows/cols, per ARCHITECTURE §4
}

function scheduleFit(entry: Entry): void {
  if (entry.disposed) return;
  if (entry.resizeTimer !== null) window.clearTimeout(entry.resizeTimer);
  entry.resizeTimer = window.setTimeout(() => {
    entry.resizeTimer = null;
    applyFit(entry);
  }, RESIZE_DEBOUNCE_MS);
}

function cancelScheduledFit(entry: Entry): void {
  if (entry.resizeTimer !== null) {
    window.clearTimeout(entry.resizeTimer);
    entry.resizeTimer = null;
  }
}

/* ──────────────────────────── lifecycle ──────────────────────────── */

/** Resets every input mode a full-screen program can leave on, written to the emulator, not the
 * PTY; the alternate screen stays so the last frame can be read. A killed `claude` never turns
 * its mouse tracking off, so drags (and copy) would go to a dead process. */
export const TERMINAL_MODE_RESET =
  "\x1b[?9l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?1016l" +
  "\x1b[?1004l\x1b[?2004l\x1b[?1l\x1b>\x1b[?25h\x1b[0m";

/** "claude exited with code 137 (killed — SIGKILL)" — what the dead tab says. */
export function describeAgentExit(code: number): string {
  if (code === 0) return "claude exited";
  const signals: Record<number, string> = {
    1: "SIGHUP",
    2: "SIGINT",
    6: "SIGABRT",
    9: "SIGKILL",
    11: "SIGSEGV",
    15: "SIGTERM",
  };
  const sig = code > 128 ? signals[code - 128] : undefined;
  return sig
    ? `claude exited with code ${code} (killed — ${sig})`
    : `claude exited with code ${code}`;
}

/** The agent's process ended. If it was the PTY's child, the tab turns read-only with modes
 * reset and says how it ended; if typed into a shell, only modes reset, silently. Unknown,
 * exited or disposed terminals are a no-op. */
export function noteAgentExited(terminalId: TerminalId, code: number): void {
  const entry = registry.get(terminalId);
  if (!entry || entry.disposed || entry.exited) return;
  entry.term.write(TERMINAL_MODE_RESET);
  if (!entry.agentPty) return;
  entry.exited = true;
  entry.ptyReady = false;
  entry.pendingInput.length = 0;
  entry.term.write(
    `\r\n\x1b[${code === 0 ? "2" : "31"}m[${describeAgentExit(code)}]\x1b[0m` +
      "\r\n\x1b[2mThe conversation is saved — use ↻ Resume on the agent in the Agents rail to continue it.\x1b[0m\r\n",
  );
}

/** Print a dim notice line into a terminal (e.g. why a Resume failed). No-op if unknown. */
export function writeTerminalNotice(terminalId: TerminalId, text: string): void {
  const entry = registry.get(terminalId);
  if (!entry || entry.disposed) return;
  entry.term.write(`\r\n\x1b[33m${text}\x1b[0m\r\n`);
}

/** Open a clicked terminal link in the OS browser — https only (Rust re-checks). */
export function openTerminalLink(uri: string): void {
  if (/^https:\/\//i.test(uri)) void urlOpen(uri).catch(() => undefined);
}

function createEntry(terminalId: TerminalId, spawn: TerminalSpawnOptions): Entry {
  const term = new Terminal({
    allowProposedApi: true,
    scrollback: TERMINAL_SCROLLBACK,
    fontFamily: terminalFontFamily(),
    fontSize: TERMINAL_FONT_SIZE,
    lineHeight: TERMINAL_LINE_HEIGHT,
    theme: terminalTheme(),
    cursorBlink: true,
    convertEol: false,
    macOptionIsMeta: true,
    // Option(⌥)-drag always selects, even while a TUI has turned on mouse tracking
    // (copying must stay possible).
    macOptionClickForcesSelection: true,
    // OSC 8 hyperlinks: xterm's default accepts ANY scheme and calls window.open().
    // Only https, and only via the OS browser.
    linkHandler: { activate: (_e, uri) => openTerminalLink(uri) },
  });

  const fit = new FitAddon();
  const serialize = new SerializeAddon();
  const search = new SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(serialize);
  term.loadAddon(search);
  term.loadAddon(new WebLinksAddon((_e, uri) => openTerminalLink(uri)));
  installScrollbackWheelBypass(term);
  // Windows/Linux: Ctrl+C copies a selection, Ctrl+V pastes (Windows Terminal's keys).
  // macOS is untouched — its app menu already does ⌘C/⌘V.
  installTerminalClipboardKeys(term);

  const container = document.createElement("div");
  container.dataset.terminalId = terminalId;
  container.style.width = "100%";
  container.style.height = "100%";

  // ─── THE hot plane. Bytes land here and nowhere else. ───
  const channel = new Channel<ArrayBuffer>();

  const entry: Entry = {
    id: terminalId,
    term,
    fit,
    serialize,
    search,
    searchUi: null,
    renderer: null,
    channel,
    container,
    host: null,
    ro: null,
    resizeTimer: null,
    disposables: [],
    domOpened: false,
    opening: false,
    ptyReady: false,
    exited: false,
    agentPty: Boolean(spawn.agentId),
    fitted: false,
    sentSize: null,
    pendingInput: [],
    meta: null,
    disposed: false,
  };

  channel.onmessage = (frame) => {
    if (entry.disposed) return;
    term.write(toBytes(frame as RawFrame));
  };

  // WebKitGTK shows a WebGL canvas one draw late, so never let a drawn frame be the last one
  // (settleRepaint.ts).
  entry.disposables.push(installSettleRepaint(term, () => entry.renderer?.kind === "webgl"));

  // Input: xterm -> PTY. Encoded to bytes for binary safety.
  entry.disposables.push(
    term.onData((data) => {
      send(entry, encoder.encode(data));
    }),
  );
  // True binary keys / paste take the raw-byte path; onBinary yields a
  // latin1-encoded string, so map char codes rather than UTF-8 encoding it.
  entry.disposables.push(
    term.onBinary((data) => {
      const bytes = new Uint8Array(data.length);
      for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i) & 0xff;
      send(entry, bytes);
    }),
  );

  // Defence in depth: xterm 6 focuses on its own screen mousedown, but this capture-phase host
  // listener also covers padding/scrollbar clicks and a bypassed screen listener (WKWebView).
  // No preventDefault: selection and mouse reporting are untouched.
  const focusOnPointerDown = (): void => {
    if (entry.disposed) return;
    term.focus();
  };
  container.addEventListener("mousedown", focusOnPointerDown, { capture: true });
  entry.disposables.push({
    dispose: () => container.removeEventListener("mousedown", focusOnPointerDown, { capture: true }),
  });

  registry.set(terminalId, entry);
  scheduleOpen(entry, spawn);
  return entry;
}

/** Opens on the next task so `attach()` has fitted and the PTY is born at the real size (else
 * the first paint reflows). setTimeout, not rAF: rAF never fires while hidden, and background
 * agents must spawn. WebGL may cost one corrective resize, still before the child's first paint. */
function scheduleOpen(entry: Entry, spawn: TerminalSpawnOptions): void {
  setTimeout(() => {
    if (entry.disposed || entry.opening) return;
    void openPty(entry, spawn);
  }, 0);
}

function send(entry: Entry, bytes: Uint8Array): void {
  if (entry.disposed || entry.exited) return; // a dead PTY has nothing to type into
  if (!entry.ptyReady) {
    entry.pendingInput.push(bytes);
    return;
  }
  void writeTerminal(entry.id, bytes).catch((err) => {
    console.warn(`[terminal ${entry.id}] write failed`, err);
  });
}

/** Same as `terminal_open` except the command: the Channel and every downstream call are shared
 * (ARCHITECTURE §2.4). */
async function openAgentPty(
  entry: Entry,
  agentId: AgentId,
  spawn: TerminalSpawnOptions,
  cwd: string,
  rows: number,
  cols: number,
): Promise<TerminalMeta> {
  if (!spawn.runtime) {
    // Falling back to a shell here is exactly the M2 bug this guards against: the
    // user clicks "+ New agent" and silently gets bash. Fail loudly instead.
    throw new Error(
      `agent terminal ${entry.id} has an agentId but no runtime; ` +
        `pass { agentId, runtime } together to configureTerminal().`,
    );
  }
  const meta = await spawnAgent({
    agentId,
    runtime: spawn.runtime,
    cwd,
    rows,
    cols,
    // "Recover session": resume a picked past session (claude --resume) instead of a fresh
    // one; undefined for every ordinary agent launch.
    resumeSessionId: spawn.resumeSessionId,
    onOutput: entry.channel,
  });
  // A mismatch would make every write/resize/close miss while bytes still arrive: a dead
  // keyboard, not an error, so check explicitly.
  if (meta.id !== entry.id) {
    throw new Error(
      `agent_spawn returned terminalId ${meta.id} but this terminal is keyed ` +
        `by ${entry.id}. An agent terminal's TerminalId must BE its AgentId.`,
    );
  }
  return meta;
}

async function openPty(entry: Entry, spawn: TerminalSpawnOptions): Promise<void> {
  entry.opening = true;
  const rows = entry.term.rows;
  const cols = entry.term.cols;
  const cwd = spawn.cwd ?? defaultCwd;
  try {
    // reattach wins over spawn: the PTY already exists (survived a reload), so
    // there is nothing to launch and no runtime is required — see the `reattach` option.
    const meta = spawn.reattach
      ? await reattachTerminal(entry.id, entry.channel)
      : spawn.agentId
        ? await openAgentPty(entry, spawn.agentId, spawn, cwd, rows, cols)
        : await openTerminal({
            terminalId: entry.id,
            program: spawn.program,
            args: spawn.args,
            cwd,
            rows,
            cols,
            onOutput: entry.channel,
          });
    if (entry.disposed) {
      // Disposed while opening — the PTY exists now, so kill it. (Not for a
      // reattach: closing here would kill a child the user never asked to end.)
      if (!spawn.reattach) void closeTerminal(entry.id).catch(() => undefined);
      return;
    }
    entry.meta = meta;
    entry.exited = meta.status === "exited";
    entry.ptyReady = !entry.exited;
    // Rust's view of the size (it echoes what we sent for open/spawn; for a
    // reattach it is the PTY's pre-reload size). pushSize corrects if our fit
    // has since diverged.
    entry.sentSize = { rows: meta.rows, cols: meta.cols };

    if (entry.exited) {
      // Reattached to a dead PTY: its scrollback (replayed by Rust) is on
      // screen. Mark it over and accept no input; drop anything queued.
      entry.pendingInput.length = 0;
      entry.term.write("\r\n\x1b[2m[process exited]\x1b[0m\r\n");
      return;
    }

    for (const bytes of entry.pendingInput) {
      void writeTerminal(entry.id, bytes).catch((err) => {
        console.warn(`[terminal ${entry.id}] write failed`, err);
      });
    }
    entry.pendingInput.length = 0;

    // A fit may have landed while the PTY was opening/reattaching.
    pushSize(entry);
  } catch (err) {
    if (entry.disposed) return;
    const message = err instanceof Error ? err.message : String(err);
    const what = spawn.reattach ? "terminal_reattach" : "terminal_open";
    console.error(`[terminal ${entry.id}] ${what} failed`, err);
    // Surface it in the terminal itself — never in React state (ARCHITECTURE §1).
    entry.term.write(`\r\n\x1b[31mFailed to start terminal: ${message}\x1b[0m\r\n`);
  }
}

/** Creates the instance and opens its PTY once; idempotent across renders, attaches and
 * StrictMode's double-invoked effects. */
export function ensureTerminal(terminalId: TerminalId, cwd?: string, spawn?: TerminalSpawnOptions): void {
  const existing = registry.get(terminalId);
  if (existing && !existing.disposed) return;
  createEntry(terminalId, { ...configured.get(terminalId), ...spawn, ...(cwd ? { cwd } : {}) });
}

/** Moves the terminal's DOM into `host` and tracks its size; creates the terminal if needed. */
export function attach(terminalId: TerminalId, host: HTMLElement): void {
  const entry = registry.get(terminalId);
  if (!entry || entry.disposed) return;
  if (entry.host === host) return;
  if (entry.host) detach(terminalId);

  entry.host = host;
  host.appendChild(entry.container);

  if (!entry.domOpened) {
    // Deferred until now: xterm measures character cells on open(), which needs
    // the container to be in the document.
    entry.term.open(entry.container);
    entry.domOpened = true;
    entry.renderer = mountRenderer(entry.term);
  }

  // Fit synchronously: it sizes the PTY correctly before scheduleOpen() fires,
  // and on re-attach it avoids a debounce-length flash at the previous size.
  applyFit(entry);

  // Fires once on observe(); subsequent ticks are debounced.
  entry.ro = new ResizeObserver(() => scheduleFit(entry));
  entry.ro.observe(host);
}

/** Keeps the instance, scrollback and PTY alive: what makes tab/session switching lossless. */
export function detach(terminalId: TerminalId): void {
  const entry = registry.get(terminalId);
  if (!entry || entry.disposed) return;

  entry.ro?.disconnect();
  entry.ro = null;
  cancelScheduledFit(entry);

  entry.host = null;
  if (entry.domOpened) detachedHolder().appendChild(entry.container);
  else entry.container.remove();
}

/** Set by tab tear-off (`app/tearoff`): asks the window holding a never-shown terminal to close
 * it; returns whether it did. */
let remoteDisposer: ((terminalId: TerminalId) => boolean) | null = null;

/** E.g. the rail's ✕ on an agent whose tab moved to a detached window: without this hand-off
 * the agent would keep running unlisted there. `null` unsets. */
export function setRemoteDisposer(fn: ((terminalId: TerminalId) => boolean) | null): void {
  remoteDisposer = fn;
}

/** Renderer, addons, emulator and PTY; call on tab close, not unmount. With no entry here: a
 * configured-to-reattach tab never shown still has a live PTY to close; otherwise hand off to
 * `remoteDisposer`. Both one-shot, so a second `dispose` is a no-op. */
export function dispose(terminalId: TerminalId): void {
  const entry = registry.get(terminalId);
  if (!entry) {
    const neverMountedReattach = configured.get(terminalId)?.reattach === true;
    configured.delete(terminalId);
    if (neverMountedReattach) {
      void closeTerminal(terminalId).catch((err) => {
        console.warn(`[terminal ${terminalId}] terminal_close failed`, err);
      });
    } else {
      remoteDisposer?.(terminalId);
    }
    return;
  }
  teardown(entry, true);
}

/** Everything `dispose` does except `terminal_close`: tear-off's hand-off half (tab-tearoff.md
 * §3). The receiver reattaches, replaying Rust's 256 KB ring; older scrollback, the selection
 * and the find query are lost by decision. */
export function abandon(terminalId: TerminalId): void {
  configured.delete(terminalId);
  const entry = registry.get(terminalId);
  if (entry) teardown(entry, false);
}

/** `dispose`/`abandon`'s shared body; `killPty` is the only difference between them. */
function teardown(entry: Entry, killPty: boolean): void {
  const terminalId = entry.id;
  registry.delete(terminalId);
  configured.delete(terminalId);
  if (entry.disposed) return;
  entry.disposed = true;

  entry.ro?.disconnect();
  entry.ro = null;
  cancelScheduledFit(entry);

  // Stop bytes landing before we dispose the emulator they'd land in.
  entry.channel.onmessage = () => undefined;

  for (const d of entry.disposables) {
    try {
      d.dispose();
    } catch {
      /* already torn down */
    }
  }
  entry.disposables.length = 0;

  // Renderer first: it holds the GPU/canvas resources.
  entry.renderer?.dispose();
  entry.renderer = null;

  // term.dispose() disposes the remaining loaded addons (fit/serialize/links/
  // search — SearchAddon's own dispose clears its decorations and listeners).
  try {
    entry.term.dispose();
  } catch (err) {
    console.warn(`[terminal ${terminalId}] dispose failed`, err);
  }
  entry.container.remove();

  if (!killPty) return;
  void closeTerminal(terminalId).catch((err) => {
    console.warn(`[terminal ${terminalId}] terminal_close failed`, err);
  });
}

/** Dispose every terminal. For app teardown / hot-reload cleanup. */
export function disposeAll(): void {
  for (const id of [...registry.keys()]) dispose(id);
}

/* ──────────────────────────── accessors ──────────────────────────── */

export function hasTerminal(terminalId: TerminalId): boolean {
  const entry = registry.get(terminalId);
  return !!entry && !entry.disposed;
}

/** The live xterm instance, for imperative extras (search, selection, ...). */
export function getTerminal(terminalId: TerminalId): Terminal | undefined {
  const entry = registry.get(terminalId);
  return entry && !entry.disposed ? entry.term : undefined;
}

/** Metadata returned by `terminal_open`; null until the PTY is up. */
export function getTerminalMeta(terminalId: TerminalId): TerminalMeta | null {
  return registry.get(terminalId)?.meta ?? null;
}

export function focusTerminal(terminalId: TerminalId): void {
  const entry = registry.get(terminalId);
  if (entry && !entry.disposed && entry.domOpened && entry.host) entry.term.focus();
}

/** Replayable ANSI scrollback (ARCHITECTURE §4: persist/re-attach, offscreen virtualization). */
export function serializeTerminal(terminalId: TerminalId): string | null {
  const entry = registry.get(terminalId);
  if (!entry || entry.disposed || !entry.domOpened) return null;
  try {
    return entry.serialize.serialize();
  } catch {
    return null;
  }
}

/** Which renderer a terminal actually ended up with. Useful for the ARCHITECTURE §6 gate. */
export function getRendererKind(terminalId: TerminalId): string | null {
  return registry.get(terminalId)?.renderer?.kind ?? null;
}

/* ──────────────────────────── find-in-terminal ─────────────────────────────── */

/** Query + toggles of the find overlay, persisted per terminal (see `Entry.searchUi`). */
export interface TerminalSearchUiState extends SearchUiOptions {
  query: string;
}

/** Loaded in `createEntry` and disposed by `term.dispose()`, like fit/serialize. */
export function getSearchAddon(terminalId: TerminalId): SearchAddon | undefined {
  const entry = registry.get(terminalId);
  return entry && !entry.disposed ? entry.search : undefined;
}

/** Seeds the find overlay (`find/selectionSeed`); here because only the registry touches xterm.
 * Multi-line selections arrive joined with `\n` and are declined, as in the editor. */
export function getTerminalSelection(terminalId: TerminalId): string | null {
  const entry = registry.get(terminalId);
  if (!entry || entry.disposed) return null;
  return entry.term.hasSelection() ? entry.term.getSelection() : null;
}

/** Last find-overlay state for this terminal; null before the first search. */
export function getTerminalSearchUi(terminalId: TerminalId): TerminalSearchUiState | null {
  const entry = registry.get(terminalId);
  return entry && !entry.disposed ? entry.searchUi : null;
}

export function setTerminalSearchUi(terminalId: TerminalId, ui: TerminalSearchUiState): void {
  const entry = registry.get(terminalId);
  if (entry && !entry.disposed) entry.searchUi = ui;
}
