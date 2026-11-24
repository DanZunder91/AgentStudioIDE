/**
 * The OS side of the E2E display (xvfb inside the Docker E2E image): which top-level windows exist,
 * and the one gesture WebDriver cannot synthesise — a REAL pointer drag that leaves the window.
 *
 * Why not WebDriver for these: a WebDriver session sees webviews, not OS windows, and its pointer
 * actions are dispatched INTO the page — an HTML5 drag that has to end outside the window (tab
 * tear-off's drag-out, docs/design/tab-tearoff.md §5) needs the X server to see a press, motion and
 * a release over the desktop. `xdotool` produces exactly that (XTEST), and `xdotool search` lists the
 * windows by title independently of any webview. Both come from the image (Dockerfile.e2e); outside
 * it these helpers report "unavailable" instead of throwing, so a spec can say so honestly.
 */

import { spawnSync } from "node:child_process";

export interface OsWindow {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

function xdotool(args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("xdotool", args, { encoding: "utf8", timeout: 10_000 });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim() };
}

/** Is xdotool on PATH (the E2E image has it)? */
export function x11Available(): boolean {
  return spawnSync("xdotool", ["version"], { stdio: "ignore" }).status === 0;
}

/**
 * A window's title as UTF-8. `xdotool getwindowname` reads WM_NAME, which GTK writes as COMPOUND_TEXT
 * when the title is not Latin-1 — a torn-off window is "<tab> — Agent Studio" (an em dash), and xdotool's
 * name search MISSES it (the window is on screen, the search returns only main).
 * `_NET_WM_NAME` is UTF8_STRING; xprop prints its non-ASCII bytes as octal escapes in a C locale.
 */
function windowName(id: string): string {
  const r = spawnSync("xprop", ["-id", id, "_NET_WM_NAME"], { encoding: "latin1", timeout: 10_000 });
  const m = /=\s*"((?:[^"\\]|\\.)*)"/.exec(r.stdout ?? "");
  if (!m) return xdotool(["getwindowname", id]).out;
  const bytes = m[1].replace(/\\([0-7]{3})/g, (_x, o: string) => String.fromCharCode(parseInt(o, 8))).replace(/\\(.)/g, "$1");
  return Buffer.from(bytes, "latin1").toString("utf8");
}

/**
 * Every VISIBLE top-level window of the app whose title contains `needle` (default: the app's name),
 * with its on-screen geometry. Found by WM_CLASS, which carries the app's name in some spelling
 * (`agent studio`, `agent-studio`, the binary `agent-studio-scaffold`), hence the pattern; the name
 * search alone misses a torn-off window's title (see `windowName`).
 */
export function osWindows(needle = "Agent Studio"): OsWindow[] {
  const ids = new Set<string>();
  for (const q of [["--class", "agent.?studio"], ["--name", needle]]) {
    const found = xdotool(["search", "--onlyvisible", ...q]);
    if (found.ok) for (const id of found.out.split(/\s+/).filter(Boolean)) ids.add(id);
  }
  const out: OsWindow[] = [];
  for (const id of ids) {
    const name = windowName(id);
    if (!name.includes(needle)) continue;
    // `xwininfo`'s ABSOLUTE upper-left is where the client area really is. (`xdotool
    // getwindowgeometry` adds a window manager's title-bar offset a second time under openbox — the
    // drag would press ~21 px too low, inside the terminal.)
    const info = spawnSync("xwininfo", ["-id", id], { encoding: "utf8", timeout: 10_000 }).stdout ?? "";
    const num = (label: string): number => Number(new RegExp(`${label}:\\s*(-?\\d+)`).exec(info)?.[1] ?? NaN);
    const geo = { X: num("Absolute upper-left X"), Y: num("Absolute upper-left Y"), WIDTH: num("Width"), HEIGHT: num("Height") };
    // A GTK window has helper children with the same class but no size; keep real ones only.
    const w: OsWindow = { id, name, x: geo.X, y: geo.Y, width: geo.WIDTH, height: geo.HEIGHT };
    if (w.width > 50 && w.height > 50) out.push(w);
  }
  return out;
}

/** What the X server has, for a failure message: every visible window and its title. */
export function describeDisplay(): string {
  const found = xdotool(["search", "--onlyvisible", "--name", "."]);
  return found.out
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => `${id}:${JSON.stringify(windowName(id))}`)
    .join(" ");
}

const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Press at `from`, move in small steps (GTK starts a drag only after motion past its threshold, and
 * WebKit needs motion events to track it), go to `to`, release. Screen coordinates.
 */
export async function realDrag(from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  const at = (p: { x: number; y: number }): string[] => ["mousemove", String(Math.round(p.x)), String(Math.round(p.y))];
  xdotool(at(from));
  await pause(150);
  xdotool(["mousedown", "1"]);
  await pause(250);
  const steps = 24;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    xdotool(at({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }));
    await pause(40);
  }
  await pause(300);
  xdotool(["mouseup", "1"]);
}

/**
 * Put the REAL X pointer at screen `p`. WebDriver's pointer actions are synthetic events inside the
 * page, so a recorded still otherwise shows the X cursor wherever it last was — nowhere near the
 * building whose hover card is open. Returns false without
 * xdotool.
 */
export function movePointer(p: { x: number; y: number }): boolean {
  return xdotool(["mousemove", String(Math.round(p.x)), String(Math.round(p.y))]).ok;
}
