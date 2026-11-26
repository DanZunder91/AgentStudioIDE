/** Restart E2E helpers (docs/design/agent-restart-restore.md §7). The stub's argv log is the only
 * way to learn session ids. Transcripts are seeded only in the container (/.dockerenv), not a real
 * ~/.claude. Close sends WM_DELETE_WINDOW via python ctypes: the image's xdotool cannot. */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { osWindows } from "./x11";

/** Where the stub appends its argv — the same `${TMPDIR:-/tmp}` the stub's shell expands. */
export const ARGV_LOG = path.join(process.env.TMPDIR || "/tmp", "agentstudio-e2e-claude-argv.log");

/** Forget every earlier launch (the spec reads only its own). */
export function clearArgvLog(): void {
  fs.rmSync(ARGV_LOG, { force: true });
}

/** Every stub launch so far, oldest first: the argv as one line. */
export function argvLines(): string[] {
  if (!fs.existsSync(ARGV_LOG)) return [];
  return fs.readFileSync(ARGV_LOG, "utf8").split("\n").filter((l) => l.trim() !== "");
}

/** Only launches carrying `--session-id`/`--resume`: the usage strip runs the same binary. */
export function agentLaunches(): string[] {
  return argvLines().filter((l) => launchOf(l) !== null);
}

/** A launch line's rung and session: `--session-id <id>` → fresh, `--resume <id>` → resume. */
export function launchOf(line: string): { rung: "fresh" | "resume"; session: string } | null {
  const m = /(?:^|\s)--(session-id|resume)\s+(\S+)/.exec(line);
  if (!m) return null;
  return { rung: m[1] === "resume" ? "resume" : "fresh", session: m[2] };
}

/** The project directory {@link seedTranscript} writes in (never one Claude itself would name: no leading `-`). */
const SEEDED_PROJECT = "agentstudio-e2e";

function seededDir(): string {
  return path.join(os.homedir(), ".claude", "projects", SEEDED_PROJECT);
}

/** One user turn, so the restore takes the RESUME rung. Container only (module note). */
export function seedTranscript(session: string, cwd: string): string {
  if (!fs.existsSync("/.dockerenv")) {
    throw new Error("seedTranscript writes under $HOME/.claude — it runs ONLY in the Docker E2E container (scripts/e2e-linux.mjs)");
  }
  if (!/^[A-Za-z0-9-]+$/.test(session)) throw new Error(`not a session id: ${JSON.stringify(session)}`);
  fs.mkdirSync(seededDir(), { recursive: true });
  const file = path.join(seededDir(), `${session}.jsonl`);
  const record = {
    type: "user",
    sessionId: session,
    cwd,
    timestamp: new Date().toISOString(),
    message: { role: "user", content: "e2e: a conversation saved before the restart" },
  };
  fs.writeFileSync(file, JSON.stringify(record) + "\n");
  return file;
}

/** Remove what {@link seedTranscript} wrote (container only; a no-op elsewhere). */
export function removeSeededTranscripts(): void {
  if (fs.existsSync("/.dockerenv")) fs.rmSync(seededDir(), { recursive: true, force: true });
}

/** WM_PROTOCOLS/WM_DELETE_WINDOW to window `argv[1]`, as a close button sends; prints "sent". */
const WM_DELETE_PY = String.raw`
import ctypes, ctypes.util, sys
x = ctypes.cdll.LoadLibrary(ctypes.util.find_library("X11") or "libX11.so.6")
x.XOpenDisplay.restype = ctypes.c_void_p
x.XOpenDisplay.argtypes = [ctypes.c_char_p]
x.XInternAtom.restype = ctypes.c_ulong
x.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
x.XSendEvent.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_long, ctypes.c_void_p]
x.XFlush.argtypes = [ctypes.c_void_p]
x.XCloseDisplay.argtypes = [ctypes.c_void_p]
class ClientMessage(ctypes.Structure):
    _fields_ = [("type", ctypes.c_int), ("serial", ctypes.c_ulong), ("send_event", ctypes.c_int),
                ("display", ctypes.c_void_p), ("window", ctypes.c_ulong), ("message_type", ctypes.c_ulong),
                ("format", ctypes.c_int), ("l", ctypes.c_long * 5)]
class XEvent(ctypes.Union):
    _fields_ = [("xclient", ClientMessage), ("pad", ctypes.c_long * 24)]
d = x.XOpenDisplay(None)
if not d:
    sys.exit("no X display")
ev = XEvent()
ev.xclient.type = 33  # ClientMessage
ev.xclient.window = int(sys.argv[1])
ev.xclient.message_type = x.XInternAtom(d, b"WM_PROTOCOLS", 0)
ev.xclient.format = 32
ev.xclient.l[0] = x.XInternAtom(d, b"WM_DELETE_WINDOW", 0)
ev.xclient.l[1] = 0  # CurrentTime
if not x.XSendEvent(d, int(sys.argv[1]), 0, 0, ctypes.byref(ev)):
    sys.exit("XSendEvent failed")
x.XFlush(d)
x.XCloseDisplay(d)
print("sent")
`;

/** Like the title bar's ✕ (module note); throws when there is no main window or sending fails. */
export function closeMainWindowGracefully(): string {
  const main = osWindows().sort((a, b) => b.width * b.height - a.width * a.height)[0];
  if (!main) throw new Error("no Agent Studio window on the X display to close");
  const r = spawnSync("python3", ["-I", "-c", WM_DELETE_PY, String(Number(main.id))], { encoding: "utf8", timeout: 15_000 });
  if (r.status !== 0 || !/sent/.test(r.stdout)) throw new Error(`WM_DELETE_WINDOW not sent to ${main.id}: ${r.stderr || r.stdout}`);
  return `WM_DELETE_WINDOW → window ${main.id} "${main.name}"`;
}

/** Is the app's process still alive (the debug binary, by name)? */
export function appRunning(): boolean {
  return spawnSync("pgrep", ["-f", "target/debug/agent-studio-scaffold"], { stdio: "ignore" }).status === 0;
}

/** Wait (polling) until the app's process has gone, up to `timeoutMs`. Resolves whether it did. */
export async function waitForAppExit(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!appRunning()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return !appRunning();
}

/** The xvfb display (support/record.ts grabs the same one). */
const DISPLAY = process.env.DISPLAY ?? ":99";

/** Pixels of luma ≥ `minLuma` in an X-screen rect via x11grab, not the DOM: WebKitGTK shows a
 * WebGL canvas one draw late. Calibrated: the stub banner row lights ~400 at 150, a blank pane 0.
 * Never measure under a native tooltip. */
export function screenTextPixels(rect: { x: number; y: number; w: number; h: number }, minLuma = 150): number {
  const [x, y, w, h] = [rect.x, rect.y, rect.w, rect.h].map((v) => Math.max(0, Math.round(v)));
  if (w === 0 || h === 0) return 0;
  const r = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-f", "x11grab", "-video_size", `${w}x${h}`, "-i", `${DISPLAY}+${x},${y}`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
    { maxBuffer: 64 * 1024 * 1024, timeout: 15_000 },
  );
  if (r.status !== 0) throw new Error(`x11grab of ${w}x${h}+${x},${y} failed: ${String(r.stderr)}`);
  const px = r.stdout as Buffer;
  let lit = 0;
  for (let i = 0; i + 2 < px.length; i += 3) if (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2] >= minLuma) lit++;
  return lit;
}

/** The app's main window's client area on the X screen (its top-left = the viewport's 0,0). */
export function mainWindowOrigin(): { x: number; y: number } {
  const main = osWindows().sort((a, b) => b.width * b.height - a.width * a.height)[0];
  if (!main) throw new Error("no Agent Studio window on the X display");
  return { x: main.x, y: main.y };
}
