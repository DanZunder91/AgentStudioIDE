/**
 * TerminalRegistry — the non-React owner of every xterm instance.
 *
 * ARCHITECTURE §1 (governing invariant) & §4: high-volume byte streams NEVER
 * enter React state or the Zustand store. `channel.onmessage` in this file is
 * the ONE place PTY bytes land; from there they go straight to `term.write()`.
 * React only mounts and unmounts a DOM host (see `useTerminal`).
 *
 * Instances outlive their React components on purpose: `detach()` moves the
 * terminal's DOM out of the visible tree but keeps the emulator, its
 * scrollback and its cursor alive, so tab/session switches are lossless
 * (ARCHITECTURE §4). Only `dispose()` tears anything down.
 */

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

/**
 * FitAddon's own clamp floor (MINIMUM_COLS / MINIMUM_ROWS in
 * `@xterm/addon-fit`). A proposal that lands on either value means that axis
 * could not be measured — see `applyFit`. Mirrored here because the addon does
 * not export them.
 */
const FIT_MIN_COLS = 2;
const FIT_MIN_ROWS = 1;

const encoder = new TextEncoder();

/**
 * How a terminal's PTY should be spawned, if not the default shell in the
 * default cwd.
 *
 * `agentId` is the only thing that makes a terminal an *agent* terminal. An
 * agent terminal is just a terminal whose argv an adapter chose: same xterm,
 * same Channel, same registry, same lifecycle — only the spawn command differs
 * (`agent_spawn` vs `terminal_open`). The PTY path is deliberately not forked;
 * neither is Rust's.
 */
export interface TerminalSpawnOptions {
  /** Absolute path. Falls back to the registry default (`setDefaultTerminalCwd`). */
  cwd?: string;
  /** Defaults to the user's `$SHELL`, resolved on the Rust side. */
  program?: string;
  args?: string[];
  /**
   * Set => spawn via `agent_spawn` instead of `terminal_open`.
   *
   * **Must equal this terminal's own `TerminalId`.** Rust keys an agent's PTY
   * by its agentId (`supervisor/mod.rs`: "the agent's terminal shares the id
   * space with plain terminals" — `let terminal_id = spec.agent_id.clone()`),
   * and `agent_spawn` takes no terminalId at all. If the two diverge, output
   * still streams (the Channel is handed over directly) but every subsequent
   * `terminal_write`/`_resize`/`_close` addresses an id Rust has never heard
   * of. `openPty` checks this rather than let it fail silently.
   */
  agentId?: AgentId;
  /**
   * The AgentAdapter id to launch, e.g. `"claude-code"`. Required when
   * `agentId` is set — UNLESS `reattach` is set (reattach spawns nothing).
   *
   * A runtime id, NOT a program: which binary, which flags, and which
   * transcript layout it implies are `agent/claude.rs`'s business alone.
   * The frontend must never learn the answer.
   */
  runtime?: string;
  /**
   * Set => re-subscribe to a PTY that already exists (survived a webview
   * reload) via `terminal_reattach`, instead of spawning a new one. Takes
   * precedence over `agentId`/`program`: the child is already running, so there
   * is nothing to launch and no `runtime` is needed. Used only by the store's
   * `rebuildTerminalTabs` after a `fleet_snapshot`.
   */
  reattach?: boolean;
  /**
   * A KNOWN past session to resume ("Recover session") rather than mint a
   * fresh one: forwarded to `agent_spawn`'s `resumeSessionId` so `claude`
   * launches with `--resume <id>`. Set only when an agent is spawned
   * from the session picker; `undefined` for every ordinary launch. Requires
   * `agentId`/`runtime` (it is an agent spawn); ignored on the reattach path.
   */
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
  /**
   * Find-overlay UI state (query + toggles), kept HERE rather than in the
   * overlay component so it survives close/reopen and tab switches (the
   * component unmounts) and dies with the terminal (IntelliJ-like recall).
   */
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
  /**
   * `applyFit` has measured a real host at least once. Until then `term.rows/cols` are
   * xterm's 24x80 default — a guess, not a measurement — and `pushSize` sends nothing.
   * That never mattered for an open (the PTY is born at the term's size, so there is
   * nothing to correct), but a REATTACH — a webview reload, or a tab arriving from another
   * window before its pane is laid out (tab-tearoff.md §7) — would otherwise reflow a live
   * `claude` TUI to 80 columns on the way to its real size.
   */
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

/**
 * Set the cwd used by terminals opened without an explicit one.
 *
 * `<TerminalView>` takes only a `terminalId`, so the cwd has to come from
 * here or from `configureTerminal()`. Until this is called the Rust side
 * resolves `"."` against the app process's working directory.
 */
export function setDefaultTerminalCwd(cwd: string): void {
  defaultCwd = cwd;
}

const configured = new Map<TerminalId, TerminalSpawnOptions>();

/**
 * Pre-register how a terminal should spawn, before anything renders it.
 * Lets a caller that knows the cwd/program (e.g. an agent terminal) stay
 * decoupled from the component that mounts it.
 */
export function configureTerminal(terminalId: TerminalId, opts: TerminalSpawnOptions): void {
  configured.set(terminalId, { ...configured.get(terminalId), ...opts });
}

/* ───────────────────────── detached DOM holder ───────────────────────── */

let holder: HTMLDivElement | null = null;

/**
 * Offscreen parent for detached terminals. `display:none` keeps the emulator
 * alive with zero rendering cost; every attach re-fits, so the stale
 * measurements a hidden element produces never reach the user.
 */
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

/**
 * Restore mouse-wheel scrolling of the scrollback when an application has
 * grabbed the mouse.
 *
 * The bug (scrolling up did not work, most noticeably while running
 * claude agents): a TUI that enables mouse tracking (claude sends DECSET `?1002h` +
 * `?1006h`) makes xterm hand every wheel event to the application and switch its
 * own scrollback scrolling OFF (`ScrollableElement.handleMouseWheel = false`).
 * From then on wheel-up scrolls nothing — the earlier output is in the buffer
 * but unreachable. Reproduced in real Chromium: a plain terminal scrolls with
 * the wheel; the same terminal with mouse tracking on does not.
 *
 * The fix follows the terminal convention (kitty, iTerm2): the mouse wheel
 * scrolls the *scrollback* on the NORMAL buffer regardless of mouse mode,
 * because the scrollback belongs to the terminal. Full-screen apps use the
 * ALTERNATE buffer, and there the wheel legitimately belongs to the app (its
 * own viewport) — so we defer and let xterm forward the event as before.
 *
 * `attachCustomWheelEventHandler` returns `true` to let xterm handle the event
 * normally, `false` to withhold it. On the normal buffer under mouse tracking we
 * scroll the scrollback ourselves and return `false`, so the app never sees a
 * wheel event it would only have consumed.
 */
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

/**
 * Fit the terminal to its host, and tell the PTY — but only if the host has a
 * real size.
 *
 * The subtlety that bit us: **FitAddon does not return undefined for a
 * zero-size host.** It clamps to its own floor,
 *
 *   cols: Math.max(MINIMUM_COLS = 2, Math.floor(availableWidth  / cellWidth))
 *   rows: Math.max(MINIMUM_ROWS = 1, Math.floor(availableHeight / cellHeight))
 *
 * and with no layout `availableWidth` is *negative* (0 minus padding minus the
 * 14px scrollbar), so it returns exactly `{cols: 2, rows: 1}`. A `>= 1` sanity
 * check can therefore never fire — it is dead code by construction. It only
 * returns undefined when the terminal is not open, or when the character cell
 * itself is unmeasurable.
 *
 * That mattered because `attach()` fits synchronously while allotment has not
 * laid the pane out yet (it sizes purely off ResizeObserver), so every
 * split/drag/reorder remounts the host and pushed a 2-column resize down the
 * PTY. A shell just reflows its prompt; `claude` redraws its entire TUI two
 * characters wide.
 *
 * Better to send no resize than a wrong one: when the host is unmeasurable we
 * do nothing and leave the PTY at its last good size. The ResizeObserver fires
 * as soon as there is real geometry and fits properly then.
 *
 * The two guards below were each measured to fix the bug **on their own**
 * (`terminalFit.browser.test.tsx`). Both are kept deliberately: they encode
 * different invariants — "the host has no layout" vs "FitAddon could not
 * measure, for whatever reason" — and the M2 failure mode (a `claude` TUI
 * redrawing at 2 columns) is bad enough to be worth the redundancy. Neither is
 * decoration; do not drop one assuming the other covers it.
 */
function applyFit(entry: Entry): void {
  if (entry.disposed || !entry.host || !entry.domOpened) return;

  // Guard 1 — the actual cause: no layout, no fit. Stops FitAddon from ever
  // being asked to measure an unlaid-out host.
  if (entry.host.clientWidth <= 0 || entry.host.clientHeight <= 0) return;

  const dims = entry.fit.proposeDimensions();
  if (!dims || !Number.isFinite(dims.rows) || !Number.isFinite(dims.cols)) return;

  // Guard 2 — reject the clamp floor, per axis. It is FitAddon's "I could not
  // measure this axis" signal, never an intent. Per-axis matters: the axes fail
  // independently, and a column split gives the host real height with zero
  // width, yielding {cols: 2, rows: 38} — not the {cols: 2, rows: 1} you would
  // think to look for.
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

/**
 * Turn off every input mode a full-screen program can leave behind: mouse tracking
 * (X10/normal/button/any-motion + UTF-8/SGR/urxvt/pixel encodings), focus events,
 * bracketed paste, application cursor keys and keypad; show the cursor, reset SGR.
 * Written to the EMULATOR, not the PTY. The alternate screen is deliberately left
 * as-is, so the last frame stays on screen to read and copy.
 *
 * Why: when an agent's `claude` is killed mid-frame it
 * never sends its own "mouse off", so xterm keeps routing every drag to a dead
 * process — selection, and therefore copy, stopped working and the tab looked frozen.
 */
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

/**
 * An agent's process ended while its terminal was open (the `exited` agent event).
 *
 * - The PTY's child WAS the agent (`agent_spawn`): the tab becomes read-only like a
 *   reattached dead PTY, its input modes are reset so text can be selected and
 *   copied, and it says how it ended and how to get back in.
 * - The agent was a `claude` typed into a SHELL: the shell is still alive, so only
 *   the modes are reset — silently, nothing is written over the prompt.
 *
 * Unknown / already-exited / disposed terminals are a no-op.
 */
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

  // A WebGL canvas is put on screen one draw late by WebKitGTK, so a terminal that went quiet
  // right after drawing output (a restored agent's replay, in a pane that is not focused)
  // showed the frame BEFORE it — blank — indefinitely. Never let a drawn frame be the last
  // one: see settleRepaint.ts.
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

  // Defence-in-depth for the "arrows work in the shell but not inside claude"
  // report. Investigated cause: when a TUI enables mouse tracking, a click is
  // reported to the app and the mousedown is preventDefault()'d, which could
  // leave the hidden textarea unfocused so arrows go to the webview, not the PTY.
  //
  // Honest caveat: xterm already calls `this.focus()` unconditionally in its own
  // mousedown handler (verified in @xterm/xterm 6 source and in Chromium), so on
  // the `.xterm-screen` this is redundant. It is kept because it is NOT fully
  // redundant: it is a capture-phase listener on the whole host, so it also
  // focuses on clicks that land on host padding/scrollbar outside the screen
  // element, and it fires even if xterm's screen-level listener is ever bypassed
  // — the belt-and-suspenders the WKWebView-only case (which we cannot reproduce
  // in Chromium) may need. No preventDefault of our own: selection and
  // mouse-reporting are untouched.
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

/**
 * Open the PTY on the next task rather than right now.
 *
 * React runs `ensureTerminal()` and `attach()` in the same layout-effect tick,
 * and `attach()` fits synchronously — so by the time this fires, term.rows/cols
 * are the real fitted size. That matters: the PTY must be allocated at the
 * correct size or the child's first paint (Claude Code's boxes and status
 * lines) is laid out for 24x80 and then reflows. A terminal that is never
 * attached still opens, at xterm's default
 * size, and gets resized by the first fit.
 *
 * setTimeout, not requestAnimationFrame: rAF never fires while the document is
 * hidden, and background agent terminals must still spawn.
 *
 * Residual: when a renderer addon is in play it re-measures character width as
 * it activates (measured: 151 -> 169 cols), so the WebGL path costs exactly one
 * corrective resize a few ms after open; the DOM path opens exact. We accept
 * that rather than block the spawn on a lazy chunk import — the resize lands
 * before the child has exec'd, so its first paint is still correctly sized,
 * which is the property that actually matters.
 */
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

/**
 * Spawn this terminal's PTY through the agent adapter seam (ARCHITECTURE §2.4).
 *
 * The only difference from `terminal_open` is which command runs: the Channel,
 * the entry, and every downstream call are identical, because an agent terminal
 * *is* a terminal — one whose argv `agent/claude.rs` chose.
 */
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
  // Rust keys an agent's PTY by its agentId and `agent_spawn` accepts no
  // terminalId, so a mismatch here means every write/resize/close we send will
  // miss. Bytes would still arrive (the Channel was handed over directly), so
  // this fails as a *dead keyboard*, not as an error — check it explicitly.
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

/**
 * Create the xterm instance and open its PTY, once. Idempotent: safe to call
 * on every render, every attach, and from React StrictMode's double-invoked
 * effects.
 */
export function ensureTerminal(terminalId: TerminalId, cwd?: string, spawn?: TerminalSpawnOptions): void {
  const existing = registry.get(terminalId);
  if (existing && !existing.disposed) return;
  createEntry(terminalId, { ...configured.get(terminalId), ...spawn, ...(cwd ? { cwd } : {}) });
}

/**
 * Move the terminal's DOM into `host` and start tracking its size.
 * Creates the terminal first if it does not exist yet.
 */
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

/**
 * Remove the terminal's DOM from the visible tree but KEEP the instance,
 * its scrollback and its PTY alive. This is what makes tab/session switching
 * lossless.
 */
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

/**
 * Who to ask when a terminal this window has never shown is disposed — set by tab
 * tear-off (`app/tearoff`) to "the window holding it". Answers whether it took the close.
 */
let remoteDisposer: ((terminalId: TerminalId) => boolean) | null = null;

/**
 * Route the close of a terminal that lives in ANOTHER window (tab tear-off) to that window.
 *
 * The case it exists for: the main rail's ✕ on an agent whose tab was moved to a detached
 * window. `dismissAgent` finds no tab here and calls `dispose(agentId)` to "still kill any
 * live child" — but this window holds no entry for it, so without a hand-off the close went
 * nowhere and the agent kept running, unlisted, in the other window. `null` unsets.
 */
export function setRemoteDisposer(fn: ((terminalId: TerminalId) => boolean) | null): void {
  remoteDisposer = fn;
}

/**
 * Tear everything down: renderer + addons + emulator + the PTY itself.
 * Call on tab close, not on unmount.
 *
 * With no entry here, the terminal was never mounted in this window, and there are two
 * cases. Configured to REATTACH: a tab rebuilt after a reload (or adopted from another
 * window) that was never shown — its PTY is alive in Rust, and returning early, as this
 * used to, left it running with no tab at all. Otherwise: it may live in another window,
 * which `remoteDisposer` hands the close to. Both are one-shot — `configured` is dropped —
 * so a second `dispose` stays the no-op it always was.
 */
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

/**
 * Tear down this window's VIEW of a terminal and leave its PTY running — the hand-off half
 * of a tab moving to another window (tab-tearoff.md §3: "a hand-off needs 'abandon without
 * killing', which does not exist"). Everything `dispose` does except `terminal_close`.
 *
 * The receiving window re-binds the same PTY with `terminal_reattach`, which swaps the
 * pump's Channel and replays Rust's 256 KB ring. Lost in the move, by decision: scrollback
 * older than that ring, the selection, and the find overlay's query.
 */
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

/**
 * Serialize scrollback to a replayable ANSI string (ARCHITECTURE §4: the
 * persist/re-attach and offscreen-virtualization hook).
 */
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

/**
 * The live SearchAddon for a terminal, for the find overlay
 * (`find/TerminalSearch`). Loaded with the terminal in `createEntry` and
 * disposed with it by `term.dispose()` — same lifecycle as fit/serialize.
 */
export function getSearchAddon(terminalId: TerminalId): SearchAddon | undefined {
  const entry = registry.get(terminalId);
  return entry && !entry.disposed ? entry.search : undefined;
}

/**
 * The terminal's current selection, or `null` when there is none.
 *
 * Read by `<TerminalView>`'s Cmd/Ctrl+F handler to seed the overlay
 * (`find/selectionSeed`): pressing Cmd+F with text selected must search for
 * that selection. It lives here rather than
 * in the view because the view never touches an xterm instance: the registry
 * owns them, and `getTerminal` is already how the overlay reaches one.
 *
 * xterm joins selected rows with `\n`, so a block selection spanning lines
 * arrives as a multi-line string and `seedFromSelectionText` declines it — the
 * same answer the editor gives for the same shape.
 */
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
