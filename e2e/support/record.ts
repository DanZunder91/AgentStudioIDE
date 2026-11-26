/** Opt-in (`--record`, E2E_RECORD=1) whole-display video, GIF and stills: WebDriver sees one
 * webview, but torn-off tabs are separate OS windows. Off by default; a recording failure never
 * fails a test. Output: `$E2E_SCREENSHOT_DIR/media`. */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** A GIF bigger than this does not render inline in a GitHub PR body comfortably. */
export const GIF_BUDGET_BYTES = 8 * 1024 * 1024;

/** Is this run recording? (`--record` → `E2E_RECORD=1`.) */
export function recording(): boolean {
  return process.env.E2E_RECORD === "1" && Boolean(process.env.E2E_SCREENSHOT_DIR);
}

/** Where recordings and stills go — created on first use. */
export function mediaDir(): string {
  const dir = path.join(process.env.E2E_SCREENSHOT_DIR ?? ".", "media");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** The xvfb screen (`e2e-linux.mjs` passes the same `-screen 0 WxHxD` it starts xvfb with). */
function screenSize(): string {
  return process.env.E2E_SCREEN ?? "1440x900";
}

function display(): string {
  return process.env.DISPLAY ?? ":99";
}

/** `e2e/specs/tearoff.e2e.ts` → `tearoff`. */
export function specName(specs: readonly string[]): string {
  const first = specs[0] ?? "spec";
  return path.basename(first.replace(/^file:\/\//, "")).replace(/\.e2e\.ts$/, "").replace(/[^\w.-]+/g, "_");
}

const safe = (s: string): string => s.replace(/[^\w.-]+/g, "_");

let active: { proc: ChildProcess; file: string; exited: Promise<void> } | undefined;

/** Start recording the whole display into `<media>/<name>.mp4` (no-op unless recording). */
export function startRecording(name: string): void {
  if (!recording() || active) return;
  process.env.E2E_SPEC_NAME = name;
  const file = path.join(mediaDir(), `${safe(name)}.mp4`);
  const proc = spawn(
    "ffmpeg",
    [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "x11grab", "-draw_mouse", "1", "-framerate", "15", "-video_size", screenSize(), "-i", display(),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "32", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
      file,
    ],
    { stdio: ["pipe", "ignore", "inherit"] },
  );
  const exited = new Promise<void>((resolve) => {
    proc.once("exit", () => resolve());
    proc.once("error", (e) => {
      console.error(`[record] ffmpeg did not start: ${e.message}`);
      resolve();
    });
  });
  active = { proc, file, exited };
}

/** Stops via ffmpeg's `q` so the mp4 is finalised (a SIGKILL leaves no moov atom); never throws. */
export async function stopRecording(): Promise<void> {
  const rec = active;
  active = undefined;
  if (!rec) return;
  try {
    rec.proc.stdin?.write("q");
    rec.proc.stdin?.end();
  } catch {
    // ffmpeg already gone: the exit promise below has settled or will.
  }
  const timedOut = await Promise.race([
    rec.exited.then(() => false),
    new Promise<boolean>((r) => setTimeout(() => r(true), 20_000)),
  ]);
  if (timedOut) {
    rec.proc.kill("SIGINT");
    await rec.exited;
  }
  if (fs.existsSync(rec.file) && fs.statSync(rec.file).size > 0) makeGif(rec.file);
  else console.error(`[record] no video was written for ${rec.file}`);
}

/** Best first, trading fps, width and speed until one fits the budget: a long spec plays faster
 * rather than being cut. */
const GIF_ATTEMPTS: readonly { fps: number; width: number; speed: number }[] = [
  { fps: 8, width: 800, speed: 1 },
  { fps: 6, width: 800, speed: 1.5 },
  { fps: 5, width: 720, speed: 2 },
  { fps: 4, width: 640, speed: 3 },
  { fps: 3, width: 560, speed: 4 },
];

/** Render `<video>.gif` next to `video`, within {@link GIF_BUDGET_BYTES}. Returns the path or null. */
export function makeGif(video: string): string | null {
  const gif = video.replace(/\.mp4$/, ".gif");
  for (const a of GIF_ATTEMPTS) {
    const vf =
      `setpts=PTS/${a.speed},fps=${a.fps},scale=${a.width}:-1:flags=lanczos,split[s0][s1];` +
      `[s0]palettegen=max_colors=128:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`;
    const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", video, "-vf", vf, gif], {
      stdio: ["ignore", "ignore", "inherit"],
    });
    if (r.status === 0 && fs.existsSync(gif) && fs.statSync(gif).size <= GIF_BUDGET_BYTES) return gif;
  }
  console.error(`[record] could not fit ${gif} under ${GIF_BUDGET_BYTES} bytes`);
  fs.rmSync(gif, { force: true });
  return null;
}

let momentN = 0;

/** How long the video lingers on each named moment (recording only). */
const MOMENT_HOLD_MS = 1_500;

/** Recording: a whole-display PNG `<media>/<spec>__NN-<name>.png` after `opts.settleMs` (400).
 * Otherwise WebDriver's `snap`, which writes only when E2E_SCREENSHOT_DIR is set. */
export async function moment(name: string, opts: { settleMs?: number } = {}): Promise<void> {
  if (!recording()) {
    // Imported lazily: wdio.conf.ts loads this module in the launcher too, where no browser exists.
    const { snap } = await import("./real-service");
    await snap(name);
    return;
  }
  momentN += 1;
  const spec = process.env.E2E_SPEC_NAME ?? "spec";
  const file = path.join(mediaDir(), `${safe(spec)}__${String(momentN).padStart(2, "0")}-${safe(name)}.png`);
  // Let the last paint land. Docker's software GL can paint terminal output ~1 s after a spec
  // proved it via the log stream, hence `settleMs`. Recording only: the plain run never waits.
  await new Promise((r) => setTimeout(r, opts.settleMs ?? 400));
  const r = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-y", "-f", "x11grab", "-video_size", screenSize(), "-i", display(), "-frames:v", "1", file],
    { stdio: ["ignore", "ignore", "inherit"], timeout: 15_000 },
  );
  if (r.status !== 0) console.error(`[record] still "${name}" failed (ffmpeg exit ${r.status})`);
  // Hold the frame in the VIDEO too: a spec runs faster than a person reads, and each moment is
  // the point a viewer must be able to see. Recording only — the plain run never waits here.
  await new Promise((res) => setTimeout(res, MOMENT_HOLD_MS));
}
