/** V1: the Agent Village and City in the real app, in Tokyo, with IDE agents and eleven fake
 * outside agents (seeded in Docker only). Buildings, landmarks and commuters are found via product
 * hooks or support/village-scene.ts; stills are timed in the page, never by sleeping. */

import { lookup } from "node:dns/promises";

import { $, browser, expect } from "@wdio/globals";

import { APP_ZONES } from "../support/app-zone";
import { moment, recording } from "../support/record";
import { seedOutsideAgents, type OutsideAgentSpec, type SeededOutside } from "../support/outside-agents";
import { openTerminalFromEmptyPane } from "../support/terminal";
import {
  watchLife,
  bandColours,
  buildingOf,
  centredIn,
  grow,
  houseOf,
  hqOf,
  loungeOf,
  scene,
  startTracking,
  stopTracking,
  tracked,
  union,
  waitInPage,
  type BandColours,
  type Box,
  type Scene,
  type WaitCond,
  type WaitResult,
} from "../support/village-scene";
import { movePointer, osWindows } from "../support/x11";

/** The zone this spec's app runs in (wdio.conf → support/app-zone.ts). */
const ZONE = APP_ZONES["village-city"];

/** Source files the seeded agents' tool calls name, per project — what their languages are voted from. */
const RUST = ["src/main.rs", "src/logger.rs", "src/net/peer.rs"];
const TYPESCRIPT = ["src/app.tsx", "src/cart.ts", "src/api/client.ts"];
const PYTHON = ["app/main.py", "app/logger.py"];
/** Docs only: Markdown never votes, so this project has no language — and no sign. */
const MARKDOWN = ["docs/index.md", "docs/setup.md"];

/** 26 sub-agents > one desk row of 20 (10 desks of 2), so its floor wraps onto a second row. */
const BIG_TEAM = {
  folder: "storefront",
  slug: "swift-violet-crane",
  subagents: [
    "Explore", "general-purpose", "Plan", "Explore", "code-reviewer", "general-purpose",
    "test-runner", "Explore", "docs-writer", "general-purpose", "Plan", "Explore",
    "Explore", "general-purpose", "test-runner", "code-reviewer", "Plan", "Explore",
    "general-purpose", "docs-writer", "Explore", "test-runner", "general-purpose", "Plan",
    "code-reviewer", "Explore",
  ],
};
/** Team seats in one desk row (a row wraps after ten tables — tables of two). */
const ROW_SEATS = 10 * 2;
/** The City's lounge: a fixed 64 seats while the agents fit. */
const LOUNGE_SEATS = 64;
/** Lounge seats per bench row: two benches of four on each side of its lift (engine/city.ts). */
const BENCH_ROW_SEATS = 16;

/** Two roots in one repo, so the newcomer rides past a whole floor. Whichever floor is on top,
 * one more sub-agent still fits its four desks, so the world is not rebuilt mid-commute. */
const GAZELLE: OutsideAgentSpec[] = [
  { folder: "gazelle", slug: "quiet-running-otter", doing: "subagents", subagents: ["Explore"], files: RUST },
  { folder: "gazelle", slug: "keen-copper-lynx", doing: "subagents", subagents: ["general-purpose", "Plan", "code-reviewer"], files: RUST },
];

/** Six more `claude`s in the big team's repo: seven floors, each two desk rows tall (the most
 * crowded floor sets every floor's rows). The building most likely to hide a landmark on zoom. */
const TALL_FLOORS: OutsideAgentSpec[] = [
  { folder: BIG_TEAM.folder, slug: "amber-quiet-lark", doing: "subagents", subagents: ["Explore", "Plan"], files: TYPESCRIPT },
  { folder: BIG_TEAM.folder, slug: "bold-cedar-wren", doing: "read", files: TYPESCRIPT },
  { folder: BIG_TEAM.folder, slug: "deep-iron-moth", doing: "subagents", subagents: ["general-purpose", "test-runner"], files: TYPESCRIPT },
  { folder: BIG_TEAM.folder, slug: "lucky-tin-badger", doing: "idle", files: TYPESCRIPT },
  { folder: BIG_TEAM.folder, slug: "pale-ochre-finch", doing: "subagents", subagents: ["Explore"], files: TYPESCRIPT },
  { folder: BIG_TEAM.folder, slug: "rapid-sage-otter", doing: "read", files: TYPESCRIPT },
];
/** The tall building: the big team's, with all seven of its floors. */
const TALL = { folder: BIG_TEAM.folder, floors: 1 + TALL_FLOORS.length };

const OUTSIDE: OutsideAgentSpec[] = [
  ...GAZELLE,
  { folder: "payments-api", slug: "brave-silver-heron", doing: "read", files: PYTHON },
  { folder: "handbook", slug: "calm-amber-fox", doing: "idle", files: MARKDOWN },
  { folder: BIG_TEAM.folder, slug: BIG_TEAM.slug, doing: "subagents", subagents: BIG_TEAM.subagents, files: TYPESCRIPT },
  ...TALL_FLOORS,
];

/** What each seeded project's building must say on its neon sign (`CityBuilding.language`); null = no sign. */
const LANGUAGES: Readonly<Record<string, string | null>> = {
  gazelle: "rust",
  storefront: "typescript",
  "payments-api": "python",
  handbook: null,
};

/** Time from asking to grabbing a still (WebDriver round trip, ffmpeg start, next paint): ~0.1 s
 * measured in Docker. Crossings last ~0.4 s, one-floor rides ~0.6 s (engine/commute.ts). */
const STILL_LEAD_S = 0.1;

interface HudView {
  mode: string;
  counts: string;
  canvasLabel: string;
  weather: string;
  phase: string;
}

async function hud(): Promise<HudView> {
  return browser.execute(() => ({
    mode: document.querySelector('[data-testid="village-panel"]')?.getAttribute("data-mode") ?? "",
    counts: document.querySelector('[data-testid="village-hud"] .village-hud__counts')?.textContent?.trim() ?? "",
    canvasLabel: document.querySelector('[data-testid="village-canvas"]')?.getAttribute("aria-label") ?? "",
    weather: document.querySelector('[data-testid="village-sky"]')?.getAttribute("data-weather") ?? "",
    phase: document.querySelector('[data-testid="village-sky"]')?.getAttribute("data-phase") ?? "",
  }));
}

/** Wire `MachineCapacity` (src-tauri/src/capacity.rs, camelCase; `null` = this OS cannot say). */
interface MachineCapacity {
  logicalCpus: number | null;
  totalMemBytes: number | null;
  availableMemBytes: number | null;
  agents: { sessions: number; claudeProcesses: number; claudeRssBytes: number; toolProcesses: number; toolRssBytes: number } | null;
  sampledAtMs: number;
}

/** `"1 in IDE · 3 outside · 3 active"` → numbers. */
function parseCounts(counts: string): { ide: number; outside: number; active: number } {
  const n = (re: RegExp): number => Number(re.exec(counts)?.[1] ?? NaN);
  return { ide: n(/(\d+) in IDE/), outside: n(/(\d+) outside/), active: n(/(\d+) active/) };
}

async function waitForHud(pred: (h: HudView) => boolean, what: string, timeout = 30_000): Promise<HudView> {
  let last: HudView | undefined;
  const ok = await browser
    .waitUntil(async () => pred((last = await hud())), { timeout, interval: 500 })
    .catch(() => false);
  if (!ok) throw new Error(`${what}; the HUD reads ${JSON.stringify(last)}`);
  return last as HudView;
}

async function pickRadio(group: string, label: string): Promise<void> {
  const opt = await $(`//*[@role="radiogroup"][@aria-label="${group}"]//button[@role="radio"][normalize-space(.)="${label}"]`);
  await opt.waitForClickable({ timeout: 10_000 });
  await opt.click();
  await expect(opt).toHaveAttribute("aria-checked", "true");
}

/** `ok` must hold. On failure the report carries `what` and `context` (a bare boolean diff says nothing). */
function check(what: string, ok: boolean, context: unknown): void {
  expect({ what, ok, context }).toEqual({ what, ok: true, context });
}

/* ── the words the page shows: the HUD, the canvas's name and its description ─────────────────── */

/** The capacity description (`data-testid="village-capacity"`, the floor plates' captions). `textContent`: it is visually hidden by design. */
async function capacityWords(): Promise<string> {
  return browser.execute(() => document.querySelector('[data-testid="village-capacity"]')?.textContent ?? "");
}

/** The Village's Seats hall board: "Seats 23/200 · …" → the seats taken in the selected agent's context window, and the hall's seats. */
function hallBoard(words: string): { taken: number; seats: number } {
  const m = /^Seats (\d+)\/(\d+)/.exec(words);
  if (!m) throw new Error(`the capacity description has no Seats hall board ("Seats N/200"): ${JSON.stringify(words)}`);
  return { taken: Number(m[1]), seats: Number(m[2]) };
}

/** The City's lounge board: "… · Lounge 34/64" → who holds a bench, and the lounge's benches. */
function loungeBoard(words: string): { seated: number; seats: number } {
  const m = /Lounge (\d+)\/(\d+)/.exec(words);
  if (!m) throw new Error(`the capacity description has no lounge board ("Lounge N/64"): ${JSON.stringify(words)}`);
  return { seated: Number(m[1]), seats: Number(m[2]) };
}

/** The description once it carries the seats and the machine's memory (the capacity sample lands a moment after the panel). */
async function waitForCapacityWords(): Promise<string> {
  return browser.waitUntil(
    async () => {
      const t = await capacityWords();
      return /^Seats \d+\/\d+/.test(t) && /Memory \d/.test(t) ? t : false;
    },
    { timeout: 20_000, timeoutMsg: "the capacity description never carried the seats and the machine's memory" },
  );
}

/** Everyone has a desk, so no "+N" anywhere the page describes the picture: HUD, canvas name
 * and capacity description. */
async function expectNoPlusN(where: string): Promise<void> {
  const said = await browser.execute(() => ({
    hud: document.querySelector('[data-testid="village-hud"]')?.textContent ?? "",
    label: document.querySelector('[data-testid="village-canvas"]')?.getAttribute("aria-label") ?? "",
    capacity: document.querySelector('[data-testid="village-capacity"]')?.textContent ?? "",
  }));
  for (const [what, text] of Object.entries(said)) {
    expect({ where, what, text, plusN: /\+\s?\d/.test(text) }).toEqual({ where, what, text, plusN: false });
  }
}

/* ── the page's own errors ──────────────────────────────────────────────────────────────────── */

/** A throwing rAF frame leaves a half-painted canvas and stale `data-capacity-boxes`, so later
 * checks would fail somewhere confusing. */
async function watchPageErrors(): Promise<void> {
  await browser.execute(() => {
    const w = window as unknown as { __e2eErrors?: string[] };
    if (w.__e2eErrors) return;
    w.__e2eErrors = [];
    window.addEventListener("error", (e) => w.__e2eErrors?.push(`${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`));
    window.addEventListener("unhandledrejection", (e) => w.__e2eErrors?.push(`unhandled rejection: ${String(e.reason)}`));
  });
}

/** Nothing threw in the page since the last look (a few frames are let through first). */
async function expectNoPageErrors(where: string): Promise<void> {
  await browser.pause(500);
  const errors = await browser.execute(() => {
    const w = window as unknown as { __e2eErrors?: string[] };
    const out = w.__e2eErrors ?? [];
    w.__e2eErrors = [];
    return out;
  });
  // WebKit reports a ResizeObserver that settled over two frames as an "error"; it is not one.
  const real = [...new Set(errors.filter((e) => !/ResizeObserver loop/.test(e)))];
  expect({ where, errors: real.slice(0, 5), count: real.length }).toEqual({ where, errors: [], count: 0 });
}

/* ── time zone ─────────────────────────────────────────────────────────────────────────────────── */

/** `Date.getTimezoneOffset()` for `zone` at `at` (minutes, UTC − local), computed in THIS process. */
function zoneOffsetMin(zone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(at);
  const p = Object.fromEntries(parts.map((x) => [x.type, Number(x.value)]));
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return -Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
}

/** Minutes since midnight in `zone`, now. */
function minutesIn(zone: string): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", hour: "2-digit", minute: "2-digit" })
      .formatToParts(new Date())
      .map((x) => [x.type, Number(x.value)]),
  );
  return p.hour * 60 + p.minute;
}

/* ── capacity buildings: canvas pixels, found through `data-capacity-boxes` ───────────────────── */

type CapacityKind = "seats" | "memory" | "usage" | "lounge";
/** The Village's capacity houses (sorted), and the City's: its HQ's two floors, the lounge and the Seats hall under it. */
const KINDS: readonly CapacityKind[] = ["memory", "seats", "usage"];
const CITY_KINDS: readonly CapacityKind[] = ["lounge", "memory", "seats", "usage"];

/** `VillageView.capacityBoxes`: whole CSS px relative to the canvas, clipped to it. */
interface CapacityBox {
  kind: CapacityKind;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The capacity buildings on screen, plus where the canvas is and where the floating HUD ends. */
interface Stage {
  boxes: CapacityBox[];
  canvas: { left: number; top: number; width: number; height: number };
  /** The HUD's bottom edge, canvas-relative CSS px (Fit keeps the world below it). */
  hudBottom: number;
}

async function stage(): Promise<Stage> {
  return browser.execute(() => {
    const c = document.querySelector('[data-testid="village-canvas"]') as HTMLCanvasElement;
    const r = c.getBoundingClientRect();
    const hud = (document.querySelector('[data-testid="village-hud"]') as HTMLElement).getBoundingClientRect();
    return {
      boxes: JSON.parse(c.getAttribute("data-capacity-boxes") ?? "[]") as CapacityBox[],
      canvas: { left: r.left, top: r.top, width: r.width, height: r.height },
      hudBottom: hud.bottom - r.top,
    };
  });
}

/** Wait until every capacity building (`kinds`: the Village's three by default) is drawn on the canvas. */
async function waitForCapacityBuildings(what: string, kinds: readonly CapacityKind[] = KINDS): Promise<Stage> {
  let last: Stage | undefined;
  const ok = await browser
    .waitUntil(
      async () => {
        last = await stage();
        return JSON.stringify(last.boxes.map((b) => b.kind).sort()) === JSON.stringify(kinds);
      },
      { timeout: 15_000, interval: 300 },
    )
    .catch(() => false);
  if (!ok) throw new Error(`${what}: the canvas never showed the capacity buildings ${kinds.join(", ")}; ${JSON.stringify(last)}`);
  return last as Stage;
}

/** Boxes are clipped to the canvas, so a cut-off building shows as a box touching an edge. */
function expectWholeBelowHud(s: Stage): void {
  for (const b of s.boxes) {
    const where = `${b.kind} ${JSON.stringify(b)} in ${JSON.stringify(s.canvas)}, HUD bottom ${s.hudBottom}`;
    expect({ where, left: b.x > 0 }).toEqual({ where, left: true });
    expect({ where, right: b.x + b.w < s.canvas.width }).toEqual({ where, right: true });
    expect({ where, belowHud: b.y >= Math.floor(s.hudBottom) }).toEqual({ where, belowHud: true });
    expect({ where, bottom: b.y + b.h < s.canvas.height }).toEqual({ where, bottom: true });
  }
}

const centre = (b: { x: number; y: number; w: number; h: number }): { x: number; y: number } => ({
  x: b.x + b.w / 2,
  y: b.y + b.h / 2,
});

const boxOf = (s: Stage, kind: CapacityKind): CapacityBox => {
  const b = s.boxes.find((x) => x.kind === kind);
  if (!b) throw new Error(`no ${kind} building on screen: ${JSON.stringify(s.boxes)}`);
  return b;
};

/** Recording only: mirror the WebDriver pointer with the real X pointer (via the main window's
 * client origin) so a still's cursor points at the open card. */
function mirrorPointer(viewport: { x: number; y: number }): void {
  if (!recording()) return;
  const main = osWindows().sort((a, b) => b.width * b.height - a.width * a.height)[0];
  if (main) movePointer({ x: main.x + viewport.x, y: main.y + viewport.y });
}

async function pointerAt(s: Stage, p: { x: number; y: number }): Promise<void> {
  const at = { x: Math.round(s.canvas.left + p.x), y: Math.round(s.canvas.top + p.y) };
  mirrorPointer(at);
  await browser.action("pointer", { parameters: { pointerType: "mouse" } }).move({ origin: "viewport", ...at }).perform();
}

/** Off the canvas, so its card closes. The real X pointer parks in the blank lower Files rail (on
 * the HUD it sat on the counts' text in every later still). */
async function pointerAway(): Promise<void> {
  const park = await browser.execute(() => ({ x: window.innerWidth - 120, y: window.innerHeight - 160 }));
  mirrorPointer(park);
  await $('[data-testid="village-hud"] .village-hud__counts').moveTo();
  await $('[data-testid="village-capacity-card"]').waitForExist({ reverse: true, timeout: 5_000 });
}

/** The product's hover card (`capacityModel.capacityCard`); returns its text. */
async function hoverCapacity(s: Stage, kind: CapacityKind): Promise<string> {
  await pointerAt(s, centre(boxOf(s, kind)));
  const card = await $(`[data-testid="village-capacity-card"][data-kind="${kind}"]`);
  await card.waitForDisplayed({ timeout: 5_000, timeoutMsg: `hovering the ${kind} building opened no ${kind} card` });
  return browser.execute(() => document.querySelector('[data-testid="village-capacity-card"]')?.textContent ?? "");
}

/* ── close-ups: the product's pan (a drag) and its zoom buttons ────────────────────────────────── */

const zoomInBtn = (): ReturnType<typeof $> => $('[aria-label="Village zoom"] button[aria-label="Zoom in"]');

/** A drag ends when the pointer leaves the canvas or crosses the HUD, so far (even off-screen)
 * targets are reached in hops, each symmetric about the free band's centre. */
async function panTo(s: Stage, target: { x: number; y: number }): Promise<void> {
  const top = Math.ceil(s.hudBottom) + 12;
  const bottom = s.canvas.height - 12;
  const mid = { x: s.canvas.width / 2, y: (top + bottom) / 2 };
  const reach = { x: Math.max(8, s.canvas.width - 48), y: Math.max(8, bottom - top - 24) };
  const clamp = (v: number, r: number): number => Math.max(-r, Math.min(r, v));
  let dx = Math.round(s.canvas.width / 2 - target.x);
  let dy = Math.round(s.canvas.height / 2 - target.y);
  // Under DRAG_SLOP-ish moves a press would be a CLICK (it selects / focuses an agent): close enough.
  for (let hop = 0; hop < 12 && (Math.abs(dx) >= 4 || Math.abs(dy) >= 4); hop++) {
    const mx = Math.round(clamp(dx, reach.x));
    const my = Math.round(clamp(dy, reach.y));
    const from = { x: Math.round(s.canvas.left + mid.x - mx / 2), y: Math.round(s.canvas.top + mid.y - my / 2) };
    await browser
      .action("pointer", { parameters: { pointerType: "mouse" } })
      .move({ origin: "viewport", ...from })
      .down({ button: 0 })
      .pause(50)
      .move({ origin: "pointer", x: Math.round(mx / 2), y: Math.round(my / 2), duration: 150 })
      .move({ origin: "pointer", x: mx - Math.round(mx / 2), y: my - Math.round(my / 2), duration: 150 })
      .up({ button: 0 })
      .perform();
    await browser.releaseActions().catch(() => undefined);
    dx -= mx;
    dy -= my;
  }
}

/** The zoom one "Zoom in" press lands on (`render/camera.ts` `stepZoom`, one step up). */
function zoomAfterIn(z: number): number {
  const up = z < 1 ? ([3 / 4, 1 / 2, 1 / 4, 1 / 8].filter((r) => r > z).at(-1) ?? 1) : z + 1;
  return Math.min(8, up);
}

/** Would `box`, scaled by `k` about the canvas centre, still be whole on the canvas and below the HUD? */
function fitsAfter(sc: Scene, box: Box, k: number): boolean {
  const cx = sc.canvas.width / 2;
  const cy = sc.canvas.height / 2;
  const x0 = cx + (box.x - cx) * k;
  const y0 = cy + (box.y - cy) * k;
  return x0 >= 4 && x0 + box.w * k <= sc.canvas.width - 4 && y0 >= sc.hudBottom + 4 && y0 + box.h * k <= sc.canvas.height - 4;
}

/** Pan, then zoom (buttons zoom about the centre). `zoom`: presses, or `{ frame }` to press while
 * that box stays whole on screen (at most `max`). */
async function closeUpOn(
  s: Stage,
  target: { x: number; y: number },
  zoom: number | { frame: (sc: Scene) => Box; max?: number },
): Promise<void> {
  await pointerAway().catch(() => undefined);
  await panTo(s, target);
  if (typeof zoom === "number") {
    for (let i = 0; i < zoom; i++) await zoomInBtn().click();
  } else {
    for (let i = 0; i < (zoom.max ?? 4); i++) {
      const sc = await scene();
      const k = zoomAfterIn(sc.zoom) / sc.zoom;
      if (k <= 1 || !fitsAfter(sc, zoom.frame(sc), k)) break;
      await zoomInBtn().click();
    }
  }
  await pointerAway().catch(() => undefined);
  await browser.pause(600);
}

/** Frame `frame` (re-read after every press) from Fit, and check it ended up at the centre of the still. */
async function closeUpOnBox(what: string, frame: (sc: Scene) => Box, max = 4): Promise<Scene> {
  await $(".village-btn=Fit").click();
  await browser.pause(300);
  const s = await stage();
  await closeUpOn(s, centre(frame(await scene())), { frame, max });
  const near = await scene();
  const box = frame(near);
  const view = { x: 0, y: 0, w: near.canvas.width, h: near.canvas.height };
  // The still is ON it: the view's centre is inside the framed box.
  check(`${what} is at the centre of the close-up`, centredIn(view, box), { box, view });
  return near;
}

/** Doors open 21.5–26.5 s into each 90 s half cycle (engine/subway.ts), on the frame clock: the
 * page's `performance.now()` (rAF timestamps, useVillageLoop.ts). */
const TRAIN_HALF_CYCLE_MS = 90_000;
const TRAIN_DOORS_OPEN_MS = 21_500;

/** Half a second into the open doors (for the grab), so all eight cars show; read off the page's
 * own clock (≤ 90 s). */
async function trainInStation(): Promise<void> {
  const waitMs = await browser.execute(
    (half: number, open: number) => (open - (performance.now() % half) + half) % half,
    TRAIN_HALF_CYCLE_MS,
    TRAIN_DOORS_OPEN_MS + 500,
  );
  console.log(`[village-city] waiting ${Math.round(waitMs)} ms for the train to stand in the station`);
  await browser.pause(waitMs);
}

/** Set the sky through the HUD chip's own override (a product control), then close its popover. */
async function setSky(weather: string, time: string): Promise<void> {
  await $(".village-sky__chip").click();
  await pickRadio("Weather", weather);
  await pickRadio("Time", time);
  await $(".village-sky__chip").click();
}

/** Clear sky at `time` (a chip label), asserted on the chip AND in the canvas's accessible name, then Fit. */
async function clearSkyAt(time: "Afternoon" | "Evening" | "Night"): Promise<void> {
  await setSky("Clear", time);
  const phase = time.toLowerCase();
  const view = await waitForHud((h) => h.weather === "clear" && h.phase === phase, `the sky never turned to clear + ${phase}`);
  // `skySummary`: "… — Clear · evening".
  expect(view.canvasLabel).toContain(`Clear · ${phase}`);
  await $(".village-btn=Fit").click();
  await pointerAway().catch(() => undefined);
  await browser.pause(800);
}

/* ── the commute (engine/commute.ts), watched in the page ──────────────────────────────────────── */

/** Waits in the page until {@link STILL_LEAD_S} before the moment. A moment already passed gets
 * no still: a still named for a moment it does not show would be a lie. */
async function commuteStill(name: string, what: string, cond: WaitCond, timeoutMs: number): Promise<WaitResult> {
  const r = await waitInPage(cond, timeoutMs);
  const seen = { ok: r.ok, late: r.late, missed: r.missed, etaS: r.etaS, rate: r.rate, place: r.char?.place ?? null, detail: r.detail };
  console.log(`[village-city] ${name}: ${JSON.stringify(seen)}`);
  check(what, r.ok, seen);
  if (r.missed) console.warn(`[village-city] ${name}: the newcomer was already past that moment — no still (${r.detail})`);
  else await moment(name, { settleMs: 0 });
  return r;
}

/** At Fit (¼ in a ~720 px pane) nobody visibly walks, so commute stills frame lounge, HQ and
 * gazelle. */
const commuteFrame = (sc: Scene): Box => grow(union([loungeOf(sc).box, hqOf(sc).box, buildingOf(sc, "gazelle").box]), sc.tilePx);

/* ── Tokyo's landmarks: crowns no building may hide ─────────────────────────────────────────── */

/** The far landmarks the Tokyo City draws a crown for (`data-landmark-boxes` kinds). */
const CROWN_KINDS = ["fuji", "skytree", "tokyo-tower"] as const;
/** villageView.ts WHEEL_STEP_PX / WHEEL_IDLE_MS: wheel pixels per zoom step, and the pause that starts a fresh one. */
const WHEEL_STEP_PX = 50;
const WHEEL_IDLE_MS = 150;

/** A building hides a crown when its roof is above the crown's bottom and they overlap
 * horizontally (render/landmarks.ts); one shared rounded pixel is only touching. */
function hiddenCrowns(sc: Scene): string[] {
  const out: string[] = [];
  for (const c of sc.crowns)
    for (const b of sc.city?.buildings ?? []) {
      const overlap = Math.min(c.box.x + c.box.w, b.box.x + b.box.w) - Math.max(c.box.x, b.box.x);
      if (b.box.y < c.box.y + c.box.h && overlap > 1) out.push(`${c.kind} ${JSON.stringify(c.box)} behind ${b.key} ${JSON.stringify(b.box)} (${overlap} px)`);
    }
  return out;
}

/** No crown on screen is hidden by a building (and at least `min` crowns are on screen to be hidden). */
async function expectCrownsClear(where: string, min: number): Promise<Scene> {
  const sc = await scene();
  console.log(`[village-city] crowns ${where} (zoom ${sc.zoom}): ${JSON.stringify(sc.crowns)}`);
  check(`${where}: at least ${min} landmark crown(s) on screen`, sc.crowns.length >= min, sc.crowns);
  check(`${where}: no building hides a landmark's crown`, hiddenCrowns(sc).length === 0, hiddenCrowns(sc));
  return sc;
}

/** The product's wheel zoom about `at`. Without driver wheel input, the same `wheel` event is
 * dispatched on the canvas and the run says so. Each step must land exactly one zoom step. */
async function wheelZoomAt(at: { x: number; y: number }, steps: number): Promise<void> {
  const first = await scene();
  const vp = { x: Math.round(first.canvas.left + at.x), y: Math.round(first.canvas.top + at.y) };
  mirrorPointer(vp);
  let z = first.zoom;
  for (let i = 0; i < steps; i++) {
    const want = zoomAfterIn(z);
    let via = "webdriver wheel";
    await browser
      .action("wheel")
      .scroll({ x: vp.x, y: vp.y, deltaX: 0, deltaY: -WHEEL_STEP_PX, duration: 0 })
      .perform()
      .catch(() => undefined);
    let now = (await scene()).zoom;
    if (now === z) {
      via = "a dispatched wheel event";
      await browser.execute(
        (x: number, y: number, dy: number) => {
          const c = document.querySelector('[data-testid="village-canvas"]') as HTMLCanvasElement;
          c.dispatchEvent(new WheelEvent("wheel", { clientX: x, clientY: y, deltaY: dy, deltaMode: 0, bubbles: true, cancelable: true }));
        },
        vp.x,
        vp.y,
        -WHEEL_STEP_PX,
      );
      now = (await scene()).zoom;
    }
    console.log(`[village-city] wheel step ${i + 1} at ${JSON.stringify(at)} via ${via}: zoom ${z} → ${now}`);
    check(`a wheel step zooms exactly one step in (${z} → ${want})`, now === want, { now, want, via });
    z = now;
    await browser.pause(WHEEL_IDLE_MS + 50);
  }
  await pointerAway().catch(() => undefined);
  await browser.pause(400);
}

/** A crown wholly on the canvas (not clipped), so its box is its real place. */
const wholeOnCanvas = (sc: Scene, b: Box): boolean => b.x > 0 && b.y > 0 && b.x + b.w < sc.canvas.width && b.y + b.h < sc.canvas.height;

/** Mid-turn activities (`VillageActivity`): a sub-agent in one of these is working. */
const BUSY: readonly string[] = ["typing", "reading", "thinking", "waiting"];

/** Do `want`'s places appear in `seen`, in this order (others may come between)? The first one missing, if not. */
function inOrder(seen: readonly string[], want: readonly string[]): { ok: boolean; missing: string | null } {
  let i = 0;
  for (const p of seen) if (i < want.length && p === want[i]) i++;
  return { ok: i === want.length, missing: want[i] ?? null };
}

/* ── Tokyo's backdrop (render/backdrop.ts), seen in the canvas's pixels ────────────────────────── */

/** From {@link BAND_RISE_TILES} above the street (over its props: a torii rises 2 tiles) through
 * the lower {@link BAND_SKY} of the sky. */
const BAND_RISE_TILES = 3;
const BAND_SKY = 0.4;
/** Reads of the band, this far apart: a check holds on the WORST of them (a stuttering kana, a screen's scene, a blinking beacon). */
const BAND_READS = 3;
const BAND_GAP_MS = 1_000;
/** Share that must read `coloured` by day / `neon` at night. The backdrop is world-locked, so reads
 * are stable: measured worst 0.197 % day, 0.553 % night, haze 0.000 %; floors at ~⅖ and ~½. */
const BACKDROP_DAY_COLOURED = 0.0008;
const BACKDROP_NIGHT_NEON = 0.003;

/** Open street beyond the city's ends, minus columns under landmark crowns (saturated too) widened
 * by their own width each side: tower legs spread to about twice the deck's width. */
function backdropBands(sc: Scene): Box[] {
  const city = sc.city;
  if (!city || city.buildings.length === 0) throw new Error(`no city to read the backdrop of (mode ${sc.mode})`);
  const left = Math.floor(Math.min(...city.buildings.map((b) => b.box.x)) - sc.tilePx);
  const right = Math.ceil(Math.max(...city.buildings.map((b) => b.box.x + b.box.w)) + sc.tilePx);
  const top = Math.round(city.horizon * (1 - BAND_SKY));
  const h = Math.round(city.horizon - BAND_RISE_TILES * sc.tilePx) - top;
  let spans: [number, number][] = [
    [0, Math.max(0, left)],
    [Math.min(sc.canvas.width, right), sc.canvas.width],
  ];
  for (const c of sc.crowns) {
    const [a, b] = [c.box.x - c.box.w, c.box.x + 2 * c.box.w];
    spans = spans.flatMap(([x0, x1]): [number, number][] => (b <= x0 || a >= x1 ? [[x0, x1]] : [[x0, Math.min(x1, a)], [Math.max(x0, b), x1]]));
  }
  return spans.filter(([x0, x1]) => x1 > x0).map(([x0, x1]) => ({ x: x0, y: top, w: x1 - x0, h }));
}

/** `neon 2.710 %, coloured 3.300 % of 33408 px`, for the log. */
const fmtColours = (c: BandColours): string => `neon ${(100 * c.neon).toFixed(3)} %, coloured ${(100 * c.coloured).toFixed(3)} % of ${c.pixels} px`;

describe("Agent Village + City in Tokyo: IDE and outside agents, a big team, the commute, neon from dusk into the night", () => {
  let outside: SeededOutside | undefined;

  before(async () => {
    outside = seedOutsideAgents(OUTSIDE);
    // A plain console — a City floor of its own.
    const consoleTerm = await openTerminalFromEmptyPane();
    // An IDE agent (the stub `claude`), in the launch workspace.
    const quick = await $('[data-testid="left-rail"] button[aria-label^="Quick-launch an agent"]');
    await quick.waitForClickable({ timeout: 15_000 });
    await quick.click();
    await browser.waitUntil(
      // Only the active tab's terminal is in the DOM: wait for one that is not the console.
      async () =>
        (await browser.execute(() =>
          Array.from(document.querySelectorAll(".terminal-view[data-terminal-id]")).map((e) => e.getAttribute("data-terminal-id") ?? ""),
        )).some((id) => id !== "" && id !== consoleTerm.id),
      { timeout: 15_000, timeoutMsg: "quick-launch did not mount an agent terminal" },
    );
    await watchPageErrors();
  });

  after(async () => {
    await stopTracking().catch(() => undefined);
    // Leave the sky on Live for whoever opens the village next (the override is per viewer).
    if (await $('[data-testid="village-sky"]').isExisting()) {
      if (!(await $('//*[@role="radiogroup"][@aria-label="Weather"]').isExisting())) await $(".village-sky__chip").click();
      await pickRadio("Weather", "Live").catch(() => undefined);
      await pickRadio("Time", "Live").catch(() => undefined);
    }
    outside?.cleanup();
  });

  it("Titlebar ▸ Agent Village shows the IDE agent and the outside agents, big team included — on Tokyo time", async () => {
    await $('[data-testid="titlebar-village"]').click();
    await $('[data-testid="village-panel"]').waitForDisplayed({ timeout: 15_000 });

    // The APP is in Tokyo — its JS clock, not just a zone name — and only the app: this worker (the
    // container's own zone) is not, so nothing the spec itself formats has moved (support/app-zone.ts).
    const page = await browser.execute(() => ({
      zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      offsetMin: new Date().getTimezoneOffset(),
    }));
    console.log(`[village-city] page zone: ${JSON.stringify(page)}; worker zone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`);
    expect(page.zone).toBe(ZONE);
    expect(page.offsetMin).toBe(zoneOffsetMin(ZONE, new Date()));
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).not.toBe(ZONE);
    // The chip's clock (HH:MM, the viewer's local time) reads Tokyo's — within the chip's 30 s tick.
    const chipText = await browser.execute(() => document.querySelector(".village-sky__text")?.textContent ?? "");
    const hm = /(\d{2}):(\d{2})/.exec(chipText);
    expect({ chipText, hasClock: hm !== null }).toEqual({ chipText, hasClock: true });
    const drift = Math.abs(Number(hm![1]) * 60 + Number(hm![2]) - minutesIn(ZONE));
    expect({ chipText, drift: Math.min(drift, 1440 - drift) <= 1 }).toEqual({ chipText, drift: true });

    // In Tokyo the live weather would come from Open-Meteo; the Docker run maps that host to loopback,
    // so the request fails at once and the chip says so — Tokyo's coordinates never left the container.
    const blocked = (process.env.E2E_BLOCKED_HOSTS ?? "").split(",").filter(Boolean);
    if (blocked.includes("api.open-meteo.com")) {
      expect((await lookup("api.open-meteo.com")).address).toBe("127.0.0.1");
      await browser.waitUntil(
        async () => ((await $(".village-sky__chip").getAttribute("title")) ?? "") === "Live weather unavailable (offline)",
        { timeout: 20_000, interval: 500, timeoutMsg: "the sky chip never reported the blocked live weather as offline" },
      );
    } else {
      console.warn("[village-city] api.open-meteo.com is NOT blocked in this run (not scripts/e2e-linux.mjs): the weather check is skipped, and the app may have asked Open-Meteo for Tokyo's weather");
    }

    // Village first (the mode is remembered per viewer, so set it rather than assume it).
    await pickRadio("Picture", "Village");
    // The day stills are a day whatever the clock says (a container running at 02:42 UTC would
    // render the "day" stills at night in Tokyo): pin Clear + Afternoon through the chip.
    await setSky("Clear", "Afternoon");
    await waitForHud((h) => h.weather === "clear" && h.phase === "afternoon", "the sky never turned to clear + afternoon");
    const switchBtn = await $('//button[@role="switch"][normalize-space(.)="Show agents outside the IDE"]');
    if ((await switchBtn.getAttribute("aria-checked")) !== "true") await switchBtn.click();

    // Every seeded outside agent is counted — the 11 roots AND their 35 sub-agents (the big team's 26).
    const seeded = outside!.roots + outside!.subagents;
    const view = await waitForHud((h) => {
      const c = parseCounts(h.counts);
      return h.mode === "village" && c.ide >= 1 && c.outside >= seeded;
    }, `the village never showed 1 IDE agent and all ${seeded} outside agents (${outside!.roots} roots + ${outside!.subagents} sub-agents)`);
    expect(view.canvasLabel).toContain(`${parseCounts(view.counts).outside} outside the IDE`);
    await expect($('[data-testid="village-empty"]')).not.toBeExisting();
    await expectNoPlusN("village");
    // The picture itself was given the zone (Ambience.zone — what picks the street theme).
    expect((await scene()).zone).toBe(ZONE);
    await $(".village-btn=Fit").click();
    await pointerAway().catch(() => undefined);
    await expectNoPageErrors("the Village at Fit");
    await moment("village-ide-and-outside-agents");

    // The Village's Seats are the selected agent's context window (a hall of /context's 200
    // seats), from the stub through the real `context_usage` command.
    const s = await waitForCapacityBuildings("Village at Fit");
    console.log(`[village-city] village capacity boxes: ${JSON.stringify(s)}`);
    expectWholeBelowHud(s);
    // The board: 23 of the 200 seats taken (each used category gets at least one seat, as in /context).
    const board = hallBoard(await waitForCapacityWords());
    expect(board).toEqual({ taken: 23, seats: 200 });
    const seatsCard = await hoverCapacity(s, "seats");
    console.log(`[village-city] seats card: ${seatsCard}`);
    expect(seatsCard).toMatch(/Seats — .+'s context window/);
    expect(seatsCard).toContain("23 of 200 seats taken · 7 reserved (autocompact buffer) · 170 free");
    expect(seatsCard).toContain("claude-opus-5-5 · 109.9k / 1m tokens (11%)");
    expect(seatsCard).toContain("Messages: 75.9k tokens (7.6%)");
    expect(seatsCard).toContain("MCP server instructions: 717 tokens (0.1%)");
    expect(seatsCard).toContain("One seat = 1/200 of the window (5k tokens)");
    await moment("village-seats-hall-card");
    expect(await hoverCapacity(s, "memory")).toContain("Memory — what the agents hold");
    await moment("village-memory-house-card");
    expect(await hoverCapacity(s, "usage")).toContain("Usage — your plan's limits");
    await pointerAway();

    // Close-up of the Seats hall: the audience in their categories' colours, the empty seats, the
    // reserved row's cards and the screen's legend.
    await closeUpOn(s, centre(boxOf(s, "seats")), 3);
    const near = await stage();
    const seats = boxOf(near, "seats");
    const mid = { x: near.canvas.width / 2, y: near.canvas.height / 2 };
    expect({ seats, mid, centred: mid.x > seats.x && mid.x < seats.x + seats.w && mid.y > seats.y && mid.y < seats.y + seats.h }).toMatchObject({ centred: true });
    await moment("village-seats-hall-close-up");
    // The room behind it: one hall, and nothing of the old room of desks (no PCs, no LAN switch).
    const room = (await scene()).houses.find((h) => h.capacity === "seats")!;
    check("the Seats house is one hall of seats", room.props.hall === 1, { room: room.key, props: room.props });
    check("the Seats house has no desks, PCs or switch any more", !room.props.pc && !room.props.desk && !room.props.switch, { room: room.key, props: room.props });
    await $(".village-btn=Fit").click();
  });

  it("the Village up close: the big team's house (team tables, Wi-Fi router) and the plaza (sakura, vending machines, torii)", async () => {
    // The big team's house, whole: its leader's desk, its team tables, the router and the cables.
    const team = await closeUpOnBox("the big team's house", (sc) => houseOf(sc, BIG_TEAM.folder).box);
    await moment("village-team-house-close-up");

    // The plaza and the Tokyo props around it: the vending machines just north of it, the torii by the
    // pond (engine/streetTheme.ts) — framed together with the square itself.
    const plazaFrame = (sc: Scene): Box => {
      if (!sc.plaza) throw new Error("the village has no plaza");
      const near = sc.landmarks.filter((l) => l.kind === "vending" || l.kind === "torii").map((l) => l.box);
      return grow(union([sc.plaza, ...near]), 2 * sc.tilePx);
    };
    const plaza = await closeUpOnBox("the plaza", plazaFrame);
    await moment("village-plaza-close-up");
    await $(".village-btn=Fit").click();
    await expectNoPageErrors("the Village's close-ups");

    // The structure behind the two stills (never their pixels).
    const house = houseOf(team, BIG_TEAM.folder);
    console.log(`[village-city] big team's house: ${JSON.stringify(house)}`);
    // A team-table seat for every one of the 26, and the room's Wi-Fi router.
    check("the big team's house has a team-table seat for each sub-agent", house.teamSeats >= BIG_TEAM.subagents.length, { house: house.key, teamSeats: house.teamSeats, team: BIG_TEAM.subagents.length });
    check("the big team's house has its Wi-Fi router", (house.props.router ?? 0) >= 1, { house: house.key, props: house.props });
    // Tokyo's street theme (only in Asia/Tokyo): blossoming trees, vending machines and a torii.
    console.log(`[village-city] village props: ${JSON.stringify(plaza.props)}`);
    for (const kind of ["sakura", "vending", "torii"]) {
      check(`the Tokyo village has ${kind}`, (plaza.props[kind] ?? 0) >= 1, { zone: plaza.zone, props: plaza.props });
    }
  });

  it("the Picture switch turns it into a City: the HQ in the middle of the street, and every busy sub-agent rides up from the Seats lounge to its desk", async () => {
    await pickRadio("Picture", "City");
    const view = await waitForHud((h) => h.mode === "city" && /consoles/.test(h.counts), "City mode never came up");

    // Wait for the stream (ten out on the street at once), not the first moment, when all are
    // still stacked in the lounge lift's shaft.
    await closeUpOnBox("the rush from the lounge", commuteFrame);
    const rush = await waitInPage({ kind: "crowd", street: 10 }, 15_000);
    console.log(`[village-city] the switch to City: ${rush.detail}`);
    check("on the switch to City the busy sub-agents leave the lounge for their desks (ten on the street at once)", rush.ok, rush.detail);
    await moment("city-everyone-rides-to-work", { settleMs: 0 });
    // …and every one of them gets there: seated at its own desk on its leader's floor.
    const settled = await waitInPage({ kind: "settled" }, 45_000);
    console.log(`[village-city] after the commute: ${settled.detail}`);
    check("every busy sub-agent reaches its desk", settled.ok, settled.detail);
    // …and every seeded sub-agent IS busy: each is a BACKGROUND launch (the CLI's ordinary Agent call),
    // answered by its parent at once — an answer that used to read as "done", so the City showed
    // nobody working. Working until its <task-notification>.
    const working = (await scene()).chars.filter((c) => c.sub && BUSY.includes(c.activity));
    check(`all ${outside!.subagents} seeded background sub-agents are working, at their desks`, working.length >= outside!.subagents && working.every((c) => c.place.startsWith("desk:")), { working: working.length, seeded: outside!.subagents, away: working.filter((c) => !c.place.startsWith("desk:")).map((c) => `${c.label}@${c.place}`) });

    // `citySummary`: "<n> buildings, <m> floors, <k> consoles …" — at least the console and the agents.
    expect(view.canvasLabel).toMatch(/\d+ buildings?/);
    expect(view.canvasLabel).toMatch(/\d+ floors?/);
    expect(Number(/(\d+) consoles/.exec(view.counts)?.[1] ?? 0)).toBeGreaterThanOrEqual(1);
    await expectNoPlusN("city");
    expect((await scene()).zone).toBe(ZONE);
    await clearSkyAt("Afternoon");
    await expectNoPageErrors("the City at Fit");
    await moment("city-afternoon");

    // The structure behind the still.
    const sc = await scene();
    const city = sc.city!;
    const hq = hqOf(sc);
    const projects = city.buildings.filter((b) => !b.hq);
    console.log(`[village-city] city: ${JSON.stringify({ street: city.street, world: city.world, buildings: city.buildings.map((b) => ({ key: b.key, rect: b.rect, doorCol: b.doorCol, language: b.language, lift: b.lift && { col: b.lift.col, stops: b.lift.stops } })) })}`);
    // The HQ in the CENTRE of the street: projects on both sides of it, the
    // world as wide on both sides — and Fit puts it in the middle of the picture.
    const west = projects.filter((b) => b.rect.col + b.rect.w <= hq.rect.col).map((b) => b.key);
    const east = projects.filter((b) => b.rect.col >= hq.rect.col + hq.rect.w).map((b) => b.key);
    check("projects stand on both sides of the HQ", west.length > 0 && east.length > 0, { west, east });
    const hqMid = hq.box.x + hq.box.w / 2;
    check("the HQ stands in the middle of the street", Math.abs(hqMid - (city.world.x + city.world.w / 2)) <= sc.tilePx, { hq: hq.box, world: city.world });
    check("Fit centres the picture on the HQ", Math.abs(hqMid - sc.canvas.width / 2) <= sc.tilePx / 2 + 1, { hq: hq.box, canvas: sc.canvas, tilePx: sc.tilePx });
    // Its two floors, Memory on the ground floor, then Usage; its door in the middle of its front.
    check("the HQ's floors are Memory (ground) and Usage", JSON.stringify(hq.floors.map((k) => houseOf(sc, k).capacity)) === JSON.stringify(["memory", "usage"]), { floors: hq.floors });
    check("the HQ's door is in the middle of its front", Math.abs(hq.doorCol + 0.5 - (hq.rect.col + hq.rect.w / 2)) <= 0.5, { doorCol: hq.doorCol, rect: hq.rect });
    check("the HQ wears no neon sign (it has no language)", hq.language === null, { language: hq.language });

    // The Seats LOUNGE under the street, right below the HQ's door: its lift comes up the door's
    // column to a kiosk on the far sidewalk, so a rider crosses the road there — the crossing.
    const lounge = loungeOf(sc);
    check("the lounge is under the street (below the far sidewalk)", lounge.rect.row > city.street + 3, { lounge: lounge.rect, street: city.street });
    check("the lounge's lift runs up the HQ's door column (the crossing)", lounge.lift.col === hq.doorCol, { lift: lounge.lift.col, door: hq.doorCol });
    check("the lounge is centred under the HQ's door", lounge.rect.col + (lounge.rect.w - 1) / 2 === lounge.lift.col, { lounge: lounge.rect, lift: lounge.lift.col });
    check("the lounge's lift comes up on the far sidewalk, at its kiosk", lounge.lift.top === city.street + 3 && lounge.kiosk?.col === lounge.lift.col && lounge.kiosk?.row === lounge.lift.top, { lift: lounge.lift, kiosk: lounge.kiosk, street: city.street });
    // 64 bench seats, numbered 0..63, sixteen to a bench row; the lift stops at every row's aisle.
    check(`the lounge has ${LOUNGE_SEATS} bench seats, one per seat number`, JSON.stringify(lounge.benches.map((b) => b.index)) === JSON.stringify([...Array(LOUNGE_SEATS).keys()]), { benches: lounge.benches.length });
    const benchRows = [...new Set(lounge.benches.map((b) => b.row))].sort((a, b) => a - b);
    check(`the lounge's benches stand in rows of ${BENCH_ROW_SEATS}`, benchRows.length === LOUNGE_SEATS / BENCH_ROW_SEATS && benchRows.every((r) => lounge.benches.filter((b) => b.row === r).length === BENCH_ROW_SEATS), { benchRows });
    check("the lounge's lift stops at every bench row's aisle", benchRows.every((r) => lounge.lift.stops.includes(r + 1)), { benchRows, stops: lounge.lift.stops });
    // Every project with a team has a lift up its door's column, stopping at every team chair row and
    // at the door; a project without a team has none (only sub-agents ride).
    for (const b of projects) {
      const chairRows = b.floors.flatMap((k) => houseOf(sc, k).chairRows.map((r) => r.row));
      if (chairRows.length === 0) {
        check(`${b.key} (no team) has no lift`, b.lift === null, { lift: b.lift });
        continue;
      }
      const lift = b.lift;
      check(`${b.key}'s lift runs up its door's column from the door`, lift !== null && lift.col === b.doorCol && lift.bottom === b.rect.row + b.rect.h - 1, { lift, doorCol: b.doorCol, rect: b.rect });
      check(`${b.key}'s lift stops at every team chair row`, chairRows.every((r) => lift?.stops.includes(r)), { chairRows, stops: lift?.stops });
    }
  });

  it("Tokyo's landmarks: no building hides Fuji's cap or a tower's crown — at Fit, zoomed on the tall building and on the HQ; they move with the street", async () => {
    // Afternoon, Fit: the tall building (seven floors of two desk rows) and all three crowns, clear.
    await clearSkyAt("Afternoon");
    const fit = await expectCrownsClear("at Fit", CROWN_KINDS.length);
    const tall = buildingOf(fit, TALL.folder);
    check(`the tall building is ${TALL.floors} floors`, tall.floors.length === TALL.floors, { floors: tall.floors.length });
    check("Fit shows Fuji, Tokyo Tower and the Skytree", JSON.stringify(fit.crowns.map((c) => c.kind).sort()) === JSON.stringify([...CROWN_KINDS].sort()), fit.crowns);
    // The two towers stand APART: two buildings between their crowns when the
    // street allows — this street of six does (the HQ and the workspace end up between them).
    const tower = fit.crowns.find((c) => c.kind === "tokyo-tower") as Scene["crowns"][number];
    const tree = fit.crowns.find((c) => c.kind === "skytree") as Scene["crowns"][number];
    const [westward, eastward] = tower.box.x < tree.box.x ? [tower.box, tree.box] : [tree.box, tower.box];
    const between = (fit.city?.buildings ?? []).filter((b) => b.box.x >= westward.x + westward.w && b.box.x + b.box.w <= eastward.x).map((b) => b.key);
    console.log(`[village-city] between Tokyo Tower and the Skytree at Fit: ${JSON.stringify(between)}`);
    check("two buildings stand between Tokyo Tower's crown and the Skytree's", between.length >= 2, { between, tower: tower.box, skytree: tree.box });
    // Fit frames a tile over the tallest tip: every crown whole on the canvas, below the HUD.
    for (const c of fit.crowns) check(`at Fit ${c.kind}'s crown is whole and below the HUD`, wholeOnCanvas(fit, c.box) && c.box.y >= fit.hudBottom, { crown: c.box, canvas: fit.canvas, hudBottom: fit.hudBottom });
    await moment("city-landmarks-fit");

    // Wheel-zoom on the tall building's right wall: the zoom that showed the bug. With parallax, a
    // tower standing beside it slid in behind it as the picture grew about that wall.
    const wall = { x: tall.box.x + tall.box.w, y: tall.box.y + Math.round(tall.box.h / 3) };
    await wheelZoomAt(wall, 2);
    await expectCrownsClear("zoomed on the tall building's right wall", 1);
    await moment("city-landmarks-zoomed-on-tall-building");

    // And on the HQ, from Fit again.
    await $(".village-btn=Fit").click();
    await browser.pause(300);
    const hqFit = hqOf(await scene());
    await wheelZoomAt({ x: hqFit.box.x + Math.round(hqFit.box.w / 2), y: hqFit.box.y }, 3);
    const onHq = await expectCrownsClear("zoomed on the HQ", 1);
    await moment("city-landmarks-zoomed-on-hq");

    // WORLD-LOCKED under zoom: a crown keeps its place relative to the street — its offset from the HQ
    // grew by exactly the zoom (a parallax layer's would have grown less). Every crown whole in both.
    const k = onHq.zoom / fit.zoom;
    const hqZ = hqOf(onHq).box;
    const pairs = onHq.crowns
      .map((c) => ({ c, f: fit.crowns.find((x) => x.kind === c.kind) }))
      .filter((p): p is { c: (typeof onHq.crowns)[number]; f: (typeof fit.crowns)[number] } => p.f !== undefined && wholeOnCanvas(onHq, p.c.box));
    check("a crown is whole on screen both at Fit and zoomed on the HQ", pairs.length > 0, { fit: fit.crowns, zoomed: onHq.crowns });
    for (const { c, f } of pairs) {
      const was = { x: f.box.x - hqFit.box.x, y: f.box.y - hqFit.box.y };
      const is = { x: c.box.x - hqZ.x, y: c.box.y - hqZ.y };
      check(`${c.kind}'s crown zooms with the street (offset from the HQ × ${k})`, Math.abs(is.x - was.x * k) <= k + 1 && Math.abs(is.y - was.y * k) <= k + 1, { was, is, k });
    }

    // WORLD-LOCKED under a pan: drag the picture; the crown moves by exactly what the HQ moves.
    const [lock] = pairs;
    const dx = lock.c.box.x + lock.c.box.w / 2 < onHq.canvas.width / 2 ? 120 : -120;
    await panTo({ ...onHq, boxes: [] }, { x: onHq.canvas.width / 2 - dx, y: onHq.canvas.height / 2 - 40 });
    const panned = await scene();
    const moved = panned.crowns.find((c) => c.kind === lock.c.kind);
    const hqP = hqOf(panned).box;
    const hqMove = { x: hqP.x - hqZ.x, y: hqP.y - hqZ.y };
    check("the pan moved the picture", Math.abs(hqMove.x) >= 60, { hqMove });
    check(
      `${lock.c.kind}'s crown pans exactly with the street`,
      moved !== undefined && wholeOnCanvas(panned, moved.box) && Math.abs(moved.box.x - lock.c.box.x - hqMove.x) <= 1 && Math.abs(moved.box.y - lock.c.box.y - hqMove.y) <= 1,
      { before: lock.c.box, after: moved?.box, hqMove },
    );
    check("after the pan no building hides a crown", hiddenCrowns(panned).length === 0, hiddenCrowns(panned));
    await $(".village-btn=Fit").click();
    await expectNoPageErrors("the landmarks, zoomed and panned");
  });

  it("city life: a subway under the lounge, traffic and passers-by on the street — umbrellas only in the rain, and never an agent", async () => {
    // Some life in the city. All of it is DECORATION: the train runs on a timetable, the cars and the passers-by are drawn by the street, and
    // none of it is an agent — never counted, never hovered.
    await clearSkyAt("Afternoon");
    const sc = await scene();
    const city = sc.city!;
    const sw = city.subway;
    const lounge = loungeOf(sc);
    console.log(`[village-city] subway: ${JSON.stringify(sw)}; lounge ${JSON.stringify(lounge.rect)}; street ${city.street}`);
    check("the City has a subway", sw !== null, city);
    const sub = sw!;
    // Under the Seats lounge (its floor wall is the row under its interior), the station right under
    // its street entrance, which stands on the FAR sidewalk, left of the lounge.
    check("the subway runs under the Seats lounge", sub.top > lounge.rect.row + lounge.rect.h && sub.top < sub.rail && sub.rail <= sub.bottom, { sub, lounge: lounge.rect });
    check("its entrance is on the far sidewalk, left of the lounge", sub.entrance.row === city.street + 3 && sub.entrance.col + 2 <= lounge.rect.col - 1, { entrance: sub.entrance, street: city.street, lounge: lounge.rect });
    check("its station is under the entrance", sub.station.col0 <= sub.entrance.col && sub.entrance.col + 2 <= sub.station.col1, sub);
    const metro = sc.landmarks.filter((l) => l.kind === "metro");
    const metroAt = sub.box.x + sub.entrance.col * sc.tilePx;
    check("the metro entrance (its `metro` prop) stands at the subway's entrance", metro.length === 1 && Math.abs(metro[0].box.x - metroAt) <= 1 && Math.abs(metro[0].box.w - 2 * sc.tilePx) <= 1, { metro, metroAt, tilePx: sc.tilePx });

    // Ten seconds of real frames at Fit, by day: cars and passers-by on screen; nobody under an umbrella
    // in dry weather; and not one more agent (they are not agents).
    const day = await watchLife(10_000);
    console.log(`[village-city] street life by day: ${JSON.stringify(day)}`);
    check("by day, vehicles drive on screen", day.vehicles >= 2, day);
    check("by day, passers-by walk on screen", day.walkers >= 2, day);
    check("no umbrella in dry weather", day.umbrellasAny === 0, day);
    check("street life adds no agent", day.agents.first > 0 && day.agents.first === day.agents.last, day.agents);
    await moment("city-life-fit");

    // The subway entrance close-up: the metro sign on the far sidewalk, the stairwell down, the station.
    const entranceFrame = (s: Scene): Box => {
      const w = s.city!.subway!;
      const m = s.landmarks.find((l) => l.kind === "metro")!.box;
      const x = w.box.x + (w.station.col0 - 3) * s.tilePx;
      const y = m.y - 2 * s.tilePx;
      return { x, y, w: (w.station.col1 - w.station.col0 + 6) * s.tilePx, h: w.box.y + w.box.h + s.tilePx - y };
    };
    await closeUpOnBox("the subway entrance", entranceFrame);
    // With its eight-car train standing along the whole platform, doors open.
    await trainInStation();
    await moment("city-subway-entrance-close-up");

    // Rain: about two in three open an umbrella (they react within ~3 s).
    await setSky("Rain", "Afternoon");
    await waitForHud((h) => h.weather === "rain" && h.phase === "afternoon", "the sky never turned to rain + afternoon");
    await $(".village-btn=Fit").click();
    await pointerAway().catch(() => undefined);
    await browser.pause(4_000);
    const wet = await watchLife(12_000);
    console.log(`[village-city] street life in the rain: ${JSON.stringify(wet)}`);
    check("in the rain, passers-by still walk", wet.walkers >= 1, wet);
    check("in the rain, umbrellas open", wet.umbrellasOpen >= 1, wet);
    check("street life adds no agent, in the rain either", wet.agents.first === day.agents.first && wet.agents.last === day.agents.first, wet.agents);
    // A rain still on the street, taken as someone walks by under an open umbrella.
    await closeUpOnBox("the street in the rain", commuteFrame);
    const under = await waitInPage({ kind: "umbrella" }, 40_000);
    check("an umbrella walks by in the rain close-up", under.ok, under.detail);
    await moment("city-life-rain");
    // A cloudy sky (a cloudy day used to show only two clouds): the clouds now
    // cover the whole sky in view — grey banks in rows, past the world's ends (render/clouds.ts).
    await setSky("Cloudy", "Afternoon");
    await waitForHud((h) => h.weather === "cloudy" && h.phase === "afternoon", "the sky never turned to cloudy + afternoon");
    await $(".village-btn=Fit").click();
    await pointerAway().catch(() => undefined);
    await moment("city-cloudy-sky");
    await clearSkyAt("Afternoon");
    await expectNoPageErrors("city life");
  });

  it("Tokyo's backdrop by day and at night: high-rises, the neon canyon and the yokochō shops behind the street — sign plates by day, neon at night", async () => {
    // The Tokyo theme's backdrop (render/city.ts `backdropOf`): towers, ramen shops, neon signs.
    const passes = [
      { time: "Afternoon", when: "day", what: "coloured", min: BACKDROP_DAY_COLOURED },
      { time: "Night", when: "night", what: "neon", min: BACKDROP_NIGHT_NEON },
    ] as const;
    for (const { time, when, what, min } of passes) {
      await clearSkyAt(time);
      const sc = await scene();
      const bands = backdropBands(sc);
      const reads: BandColours[] = [];
      for (let i = 0; i < BAND_READS; i++) {
        if (i > 0) await browser.pause(BAND_GAP_MS);
        reads.push(await bandColours(bands));
      }
      const worst = Math.min(...reads.map((r) => r[what]));
      console.log(`[village-city] backdrop (${when}) over ${JSON.stringify(bands)} (crowns ${JSON.stringify(sc.crowns)}): ${reads.map(fmtColours).join(" | ")}`);
      check(`${when}: the open street's sky has room to read`, reads[0].pixels >= 10_000, { bands, pixels: reads[0].pixels });
      check(`${when}: Tokyo's backdrop shows — ≥ ${(100 * min).toFixed(2)} % of the band ${what} in every read (the plain haze: none)`, worst >= min, { what, worst, min, reads });
      await moment(`skyline-${when}`);
    }
    // As found: a clear afternoon.
    await clearSkyAt("Afternoon");
    await expectNoPageErrors("Tokyo's backdrop");
  });

  it("the City's Capacity HQ, its lounge (a fixed 64 benches, a waiting agent on every free one) and the Seats hall under it (the selected agent's context window)", async () => {
    // Real `machine_capacity` against the seeded processes: each is a live `claude` with a
    // non-`claude` parent, a session by capacity.rs's rule.
    const cap = await browser.execute(async () => {
      const tauri = (window as unknown as { __TAURI_INTERNALS__?: { invoke: (c: string) => Promise<unknown> } }).__TAURI_INTERNALS__;
      return tauri ? ((await tauri.invoke("machine_capacity")) as MachineCapacity) : null;
    });
    console.log(`[village-city] machine_capacity: ${JSON.stringify(cap)}`);
    expect(cap).not.toBeNull();
    const c = cap as MachineCapacity;
    expect(c.logicalCpus ?? 0).toBeGreaterThanOrEqual(1);
    expect(c.totalMemBytes ?? 0).toBeGreaterThan(0);
    expect(c.availableMemBytes ?? 0).toBeGreaterThan(0);
    expect(c.availableMemBytes ?? Infinity).toBeLessThanOrEqual(c.totalMemBytes ?? 0);
    expect(c.agents).not.toBeNull();
    expect(c.agents?.sessions ?? 0).toBeGreaterThanOrEqual(outside!.roots);
    expect(c.agents?.claudeRssBytes ?? 0).toBeGreaterThan(0);
    expect(Math.abs(Date.now() - c.sampledAtMs)).toBeLessThan(5 * 60_000);

    // Via the canvas description's board captions. The lounge is a fixed 64 benches, one per live
    // agent; the Seats are the stub's reading, 23 of /context's 200.
    const seatsWanted = Math.min(16, Math.max(2, (c.logicalCpus ?? 0) - 2));
    const words = await waitForCapacityWords();
    console.log(`[village-city] capacity: ${words}`);
    const board = loungeBoard(words);
    expect(hallBoard(words)).toEqual({ taken: 23, seats: 200 });
    expect(board.seats).toBe(LOUNGE_SEATS);
    expect(board.seated).toBeGreaterThanOrEqual(outside!.busy);
    expect(words).toMatch(/Memory \d+(\.\d)? (MB|GB)/);
    // Usage reuses the usage strip's reading: in the container the CLI is not signed in, so "?".
    expect(words).toMatch(/Usage (\d+%|\?) · (\d+%|\?)/);
    const describedBy = await $('[data-testid="village-canvas"]').getAttribute("aria-describedby");
    expect(describedBy).toBe(await $('[data-testid="village-capacity"]').getAttribute("id"));
    await $(".village-btn=Fit").click();
    await pointerAway().catch(() => undefined);
    await expectNoPageErrors("the Capacity HQ at Fit");

    // The HQ's two floors, the lounge and the Seats hall are drawn, whole and below the HUD at Fit, and each opens its card.
    const s = await waitForCapacityBuildings("City at Fit", CITY_KINDS);
    console.log(`[village-city] city capacity boxes: ${JSON.stringify(s)}`);
    expectWholeBelowHud(s);
    // One building: Memory and Usage share their walls (same x and width) and stack without a gap…
    const memory = boxOf(s, "memory");
    const usage = boxOf(s, "usage");
    const lounge = boxOf(s, "lounge");
    const hall = boxOf(s, "seats");
    check("the HQ's floors share their walls", memory.x === usage.x && memory.w === usage.w, { memory, usage });
    check("the HQ's Usage floor stands on its Memory floor", Math.abs(memory.y - (usage.y + usage.h)) <= 1, { memory, usage });
    // …and the lounge is below them, past the street, centred under the HQ (under its door)…
    const t = (await scene()).tilePx;
    check("the lounge is below the HQ, past the street", lounge.y > memory.y + memory.h + t, { memory, lounge, tilePx: t });
    check("the lounge is centred under the HQ", Math.abs(centre(lounge).x - centre(memory).x) <= t / 2 + 1, { memory, lounge, tilePx: t });
    // …and the Seats hall is right under the lounge, centred under it too.
    check("the Seats hall is under the lounge", hall.y >= lounge.y + lounge.h - 1, { lounge, hall });
    check("the Seats hall is centred under the lounge", Math.abs(centre(hall).x - centre(lounge).x) <= t / 2 + 1, { lounge, hall, tilePx: t });
    const room = (await scene()).houses.find((h) => h.capacity === "seats")!;
    check("the City's Seats is one hall of seats", room.props.hall === 1, { room: room.key, props: room.props });

    // The Seats hall's card: the selected agent's context window, the same as the Village's.
    const hallCard = await hoverCapacity(s, "seats");
    console.log(`[village-city] city seats card: ${hallCard}`);
    expect(hallCard).toMatch(/Seats — .+'s context window/);
    expect(hallCard).toContain("23 of 200 seats taken · 7 reserved (autocompact buffer) · 170 free");
    expect(hallCard).toContain("claude-opus-5-5 · 109.9k / 1m tokens (11%)");
    await moment("city-seats-hall-card");

    // The lounge's card: the board's figure, the free benches, and the estimate as a yardstick.
    const card = await hoverCapacity(s, "lounge");
    console.log(`[village-city] lounge card: ${card}`);
    expect(card).toContain("Lounge — agents at once");
    const taken = /(\d+) of (\d+) benches taken · (\d+) active · (\d+) free/.exec(card);
    check("the lounge's card says how many of its 64 benches are taken and free", taken !== null, card);
    const now = loungeBoard(await capacityWords());
    check("the lounge's card agrees with its board", Number(taken![1]) === now.seated && Number(taken![2]) === now.seats && Number(taken![4]) === now.seats - now.seated, { card: taken![0], board: now });
    check("the lounge's card measures against the estimate (a yardstick, not its size)", Number(/Estimate: [^=]*= (\d+)/.exec(card)?.[1]) === seatsWanted, { card, seatsWanted });
    await moment("city-lounge-card");
    expect(await hoverCapacity(s, "memory")).toContain("Memory — what the agents hold");
    expect(await hoverCapacity(s, "usage")).toContain("Usage — your plan's limits");
    await moment("city-hq-usage-floor-card");
    await pointerAway();

    // Close-up of the lounge — its board, its benches (an agent waiting on every free seat; the busy
    // ones are at their desks), its lift up to the kiosk on the far sidewalk.
    const loungeFrame = (sc: Scene): Box => grow(union([loungeOf(sc).box, loungeOf(sc).lift.box]), sc.tilePx);
    const near = await closeUpOnBox("the lounge", loungeFrame);
    await moment("city-lounge-close-up");
    // Close-up of the Seats hall under it: the audience in their categories' colours.
    await closeUpOnBox("the Seats hall", (sc) => grow(houseOf(sc, "cap/seats").box, sc.tilePx));
    await moment("city-seats-hall-close-up");
    await $(".village-btn=Fit").click();
    // The busy are all at work: nobody busy is left in the lounge, so its seats hold only waiters.
    const inLounge = near.chars.filter((ch) => ch.sub && (ch.place === "bench" || ch.place === "lounge") && ["typing", "reading", "thinking", "waiting"].includes(ch.activity));
    check("no busy sub-agent is left waiting in the lounge", inLounge.length === 0, inLounge.map((ch) => `${ch.label}@${ch.place}`));
  });

  it("the commute: a newcomer rides up from the lounge, crosses in front of the HQ, rides its building's lift to its desk — and back to its bench when it is done", async () => {
    // Gazelle's upper floor: the newcomer works there, so its lift ride passes a whole floor.
    const before = await scene();
    const gazelle = buildingOf(before, "gazelle");
    check("gazelle is two floors (two `claude`s in one repo)", gazelle.floors.length === 2, { floors: gazelle.floors });
    const upper = houseOf(before, gazelle.floors[1]);
    // A floor's plate is its leader's title — an outside root's is its transcript's slug.
    const leader = GAZELLE.find((g) => g.slug === upper.label);
    check("gazelle's upper floor is led by a seeded root", leader !== undefined, { label: upper.label, seeded: GAZELLE.map((g) => g.slug) });
    const hq = hqOf(before);

    // One frame holds the whole trip: the lounge, the HQ and gazelle.
    await closeUpOnBox("the commute's route", commuteFrame);

    // Watch for the newcomer (every frame), then start it: a sidecar under gazelle's upper root.
    await startTracking();
    const newcomer = outside!.addSubagent(leader!.slug, { agentType: "security-reviewer", file: "src/auth/keys.rs" });

    // Out: the lounge's lift up to the street, its building's lift up to its floor, its desk.
    await commuteStill("city-commute-1-lounge-lift", "the newcomer rides the lounge's lift up to the street", { kind: "leg", leg: 2, at: 0.5, dir: 1, leadS: STILL_LEAD_S }, 30_000);
    await commuteStill("city-commute-2-building-lift", "the newcomer rides gazelle's lift up to its floor", { kind: "leg", leg: 6, at: 0.5, dir: 1, leadS: STILL_LEAD_S }, 20_000);
    const atDesk = await waitInPage({ kind: "place", place: `desk:${upper.key}` }, 20_000);
    check("the newcomer sits down at its desk on gazelle's upper floor", atDesk.ok, atDesk.detail);
    const desk = atDesk.char;
    check("…its own desk (the seat it holds)", desk !== null && desk.seat !== null && desk.seat.houseKey === upper.key && desk.col === desk.seat.col && desk.row === desk.seat.row, desk);
    await moment("city-commute-3-at-its-desk");

    // Done: its turn ends in its transcript; after its result's beat at the desk it walks back.
    newcomer.finish();
    await commuteStill("city-commute-4-crossing-back", "the newcomer, done, crosses back in front of the HQ", { kind: "leg", leg: 3, at: 0.5, dir: -1, leadS: STILL_LEAD_S }, 30_000);
    const home = await waitInPage({ kind: "place", place: "bench" }, 20_000);
    check("the newcomer sits down on its lounge bench again", home.ok, home.detail);
    await moment("city-commute-5-back-on-its-bench");
    await stopTracking();
    await $(".village-btn=Fit").click();
    await expectNoPageErrors("the commute");

    // The whole trip, from the tracker (every frame — the still timings above prove nothing).
    const trip = await tracked();
    const places = trip.entries.map((e) => e.place);
    console.log(`[village-city] the newcomer (${trip.label}): ${JSON.stringify(trip.entries)}`);
    check("the newcomer is the sub-agent the spec started", trip.label === "security-reviewer", { label: trip.label });
    check("it appears on a lounge bench", places[0] === "bench", places.slice(0, 3));
    const there = ["bench", "lounge-lift", "crossing", "near-sidewalk", "lift:gazelle", `desk:${upper.key}`];
    const back = ["lift:gazelle", "near-sidewalk", "crossing", "lounge-lift", "bench"];
    const order = inOrder(places, [...there, ...back]);
    check("there and back the same way: lounge lift, crossing, sidewalk, gazelle's lift, desk — and back", order.ok, { missing: order.missing, places });
    check("it crosses the road only at the crossing", !places.includes("road"), places);
    check("it rides no other building's lift", places.every((p) => !p.startsWith("lift:") || p === "lift:gazelle"), places);
    const crossings = trip.entries.filter((e) => e.place === "crossing");
    check("the crossing is in front of the HQ's door", crossings.length > 0 && crossings.every((e) => e.col === hq.doorCol), { crossings, door: hq.doorCol });
    const first = trip.entries[0];
    const last = trip.entries.filter((e) => e.place === "bench").at(-1);
    check("it sits on the bench it left from", last !== undefined && last.col === first.col && last.row === first.row && last !== first, { first, last });
    check("it went home because it was done", last?.activity === "done", { last });
    // Busy all the way to its desk and while it worked there — a background sub-agent, its launch
    // answered at once, until its <task-notification>.
    const deskAt = trip.entries.findIndex((e) => e.place === `desk:${upper.key}`);
    check("working (not done) from its bench to its desk", deskAt > 0 && trip.entries.slice(0, deskAt + 1).every((e) => BUSY.includes(e.activity ?? "")), trip.entries.slice(0, deskAt + 1));
  });

  it("the big team's floor wraps after ten desks onto a second desk row — taller, not longer — with its lift and its LAN", async () => {
    const before = await scene();
    const building = buildingOf(before, BIG_TEAM.folder);
    expect(building.floors.length).toBe(TALL.floors);
    // Its floor is the one its leader's plate names (a floor's plate is its leader's title — the slug).
    const floorKey = building.floors.find((k) => houseOf(before, k).label === BIG_TEAM.slug);
    if (!floorKey) throw new Error(`no floor of ${BIG_TEAM.folder} is led by ${BIG_TEAM.slug}: ${building.floors.map((k) => houseOf(before, k).label).join(", ")}`);
    // The big team's ONE floor, whole: its leader on Wi-Fi, two rows of team desks cabled to the router.
    const near = await closeUpOnBox("the big team's floor", (sc) => houseOf(sc, floorKey).box);
    await moment("city-team-floor-close-up");
    // Its leader up close, at its keyboard on the big desk right in front of its chair, the monitor beside
    // it (the agents once had nothing to type on — a monitor but no keyboard).
    await closeUpOnBox("the big team's leader at its keyboard", (sc) => {
      const b = houseOf(sc, floorKey).box;
      return { x: b.x, y: b.y, w: 8 * sc.tilePx, h: b.h };
    });
    await moment("city-leader-at-keyboard");
    await $(".village-btn=Fit").click();
    await expectNoPageErrors("the big team's floor up close");

    const floor = houseOf(near, floorKey);
    console.log(`[village-city] big team's floor: ${JSON.stringify(floor)}`);
    // No cap, no "+N": a desk for every one of the 26 — ten desks to a row, the rest on a second row.
    check(`the big team's floor seats all ${BIG_TEAM.subagents.length}`, floor.teamSeats >= BIG_TEAM.subagents.length, { teamSeats: floor.teamSeats });
    check(
      `ten desks (${ROW_SEATS} seats) on the first row, the rest on a second`,
      floor.chairRows.length === 2 && floor.chairRows[0].seats === ROW_SEATS && floor.chairRows[1].seats === floor.teamSeats - ROW_SEATS,
      { chairRows: floor.chairRows, teamSeats: floor.teamSeats },
    );
    check("no longer than ten desks", floor.teamCols === ROW_SEATS, { teamCols: floor.teamCols });
    const small = houseOf(before, buildingOf(before, "gazelle").floors[0]);
    check("taller than a one-row floor", floor.rect.h > small.rect.h, { big: floor.rect, small: small.rect });
    check("the big team's floor has its Wi-Fi router", (floor.props.router ?? 0) >= 1, { props: floor.props });
    // Its building's lift stops at both chair rows (and at the door).
    const lift = building.lift;
    check("its lift stops at both desk rows' chairs", lift !== null && floor.chairRows.every((r) => lift.stops.includes(r.row)), { lift, chairRows: floor.chairRows });
    // And the whole team sits at its own desks there (the commute is over).
    const team = near.chars.filter((ch) => ch.sub && ch.seat?.houseKey === floorKey);
    const away = team.filter((ch) => ch.place !== `desk:${floorKey}` || ch.col !== ch.seat?.col || ch.row !== ch.seat?.row);
    check(`all ${BIG_TEAM.subagents.length} sit at their own desks on it`, team.length >= BIG_TEAM.subagents.length && away.length === 0, { team: team.length, away: away.map((ch) => `${ch.label}@${ch.place}`) });
    check(`all ${BIG_TEAM.subagents.length} are working (background sub-agents, not "done" at their launch)`, team.every((ch) => BUSY.includes(ch.activity)), team.map((ch) => `${ch.label}:${ch.activity}`));
  });

  it("neon signs: every project whose agents' language is known wears it — lit from dusk into the night; Tokyo's street", async () => {
    // Languages voted from the seeded tool calls (external_agents/language.rs); Markdown never
    // votes. Checked on the building and as drawn (`data-neon-boxes`).
    await clearSkyAt("Evening");
    const fit = await scene();
    const drawn = Object.fromEntries(fit.neon.map((n) => [n.building, n.language]));
    console.log(`[village-city] neon at Fit: ${JSON.stringify(fit.neon)}`);
    for (const [folder, language] of Object.entries(LANGUAGES)) {
      const b = buildingOf(fit, folder);
      check(`${folder}'s building carries ${language ?? "no language"}`, b.language === language, { folder, language: b.language });
      if (language) check(`${folder}'s neon sign is drawn and says ${language}`, drawn[folder] === language, { folder, drawn });
      else check(`${folder} has no neon sign`, !(folder in drawn), { folder, drawn });
    }
    const hq = hqOf(fit);
    check("the HQ has no neon sign", !(hq.key in drawn), { hq: hq.key, drawn });
    // Every sign hangs off its building's RIGHT wall, high up (engine/drawList.ts `neonAnchor`).
    for (const n of fit.neon) {
      const b = buildingOf(fit, n.building).box;
      check(`${n.building}'s sign hangs off its right wall, below its roof`, Math.abs(n.box.x - (b.x + b.w)) <= 2 && n.box.y >= b.y && n.box.y < b.y + b.h, { sign: n.box, building: b });
    }
    await moment("city-neon-evening");

    // The far skyline at dusk (the buildings behind should look a little bigger — its blocks now
    // scale with the city's sky), wheel-zoomed on the HQ's roof: the haze
    // between the buildings, the towers and Fuji over it, none of their crowns hidden.
    const roof = (sc: Scene): { x: number; y: number } => ({ x: hqOf(sc).box.x + Math.round(hqOf(sc).box.w / 2), y: hqOf(sc).box.y });
    await wheelZoomAt(roof(fit), 2);
    await expectCrownsClear("the skyline at dusk", 1);
    await moment("city-skyline-dusk");

    // Gazelle's sign up close (gazelle is Rust): the building and its sign.
    const signFrame = (s: Scene): Box => {
      const sign = s.neon.find((n) => n.building === "gazelle");
      const b = buildingOf(s, "gazelle").box;
      return grow(sign ? union([b, sign.box]) : b, s.tilePx);
    };
    const wholeSign = async (when: string): Promise<void> => {
      const near = await scene();
      const sign = near.neon.find((n) => n.building === "gazelle");
      check(`gazelle's sign is whole in the ${when} close-up`, sign !== undefined && sign.box.x > 0 && sign.box.x + sign.box.w < near.canvas.width && sign.box.y > near.hudBottom && sign.box.y + sign.box.h < near.canvas.height, { sign, canvas: near.canvas });
    };
    await closeUpOnBox("gazelle's neon sign at dusk", signFrame);
    await wholeSign("dusk");
    await moment("city-neon-evening-close-up");
    // Night: full glow on a dark street (with the lit skyline, the towers' lights, stars).
    await clearSkyAt("Night");
    await moment("city-neon-night");
    // The skyline at night: its blocks' windows lit, the towers' lights on, the same zoom on the HQ.
    await wheelZoomAt(roof(await scene()), 2);
    await expectCrownsClear("the skyline at night", 1);
    await moment("city-skyline-night");
    await closeUpOnBox("gazelle's neon sign at night", signFrame);
    await wholeSign("night");
    await moment("city-neon-night-close-up");
    await $(".village-btn=Fit").click();
    await expectNoPageErrors("the City from dusk into the night");

    // The City's street theme too (only in Asia/Tokyo): blossoming street trees, vending machines, a torii.
    const night = await scene();
    console.log(`[village-city] city props: ${JSON.stringify(night.props)}`);
    for (const kind of ["sakura", "vending", "torii"]) {
      check(`the Tokyo city has ${kind}`, (night.props[kind] ?? 0) >= 1, { zone: night.zone, props: night.props });
    }
  });

  it("the sky override puts the city at night in the rain", async () => {
    await $(".village-sky__chip").click();
    await pickRadio("Weather", "Rain");
    await pickRadio("Time", "Night");
    const view = await waitForHud((h) => h.weather === "rain" && h.phase === "night", "the sky never turned to night + rain");
    expect(view.canvasLabel.toLowerCase()).toMatch(/rain/);
    expect(view.canvasLabel.toLowerCase()).toMatch(/night/);
    // Close the popover so the picture is unobstructed, then let a few rain frames fall.
    await $(".village-sky__chip").click();
    await $(".village-btn=Fit").click();
    await pointerAway().catch(() => undefined);
    await browser.pause(1_500);
    await moment("city-night-rain");
    // Close up at night: the lit windows, the neon and the street lamps, and the rain over the street —
    // framed on the street (gazelle, the HQ, the lounge): since Fit frames the tall building and the
    // landmarks' tips, the view's centre is sky, and a blind zoom about it shows mostly rain on sky.
    await closeUpOnBox("the street at night in the rain", commuteFrame);
    await browser.pause(800);
    await moment("city-night-rain-close-up");
    await $(".village-btn=Fit").click();

    await pickRadio("Picture", "Village").catch(async () => {
      await $(".village-sky__chip").click();
    });
    await waitForHud((h) => h.mode === "village", "back to the village");
    await $(".village-btn=Fit").click();
    await browser.pause(1_000);
    await moment("village-night-rain");
    await expectNoPageErrors("night and rain");
  });
});
