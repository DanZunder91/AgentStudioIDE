#!/usr/bin/env node
/**
 * Regenerate the README screenshots + GIF in docs/media/.
 *
 *   node scripts/readme-media.mjs
 *
 * What it renders: the REAL <App/> (React UI, real CSS, real xterm/CodeMirror) in Playwright
 * Chromium, driven by scripts/readme-media/shots.media.tsx against a MOCKED Tauri backend
 * (src/e2e/harness.ts + extra canned handlers). The data is fictional (scripts/readme-media/
 * fixtures.ts, panelFixtures.ts): a "todo-api" TypeScript service and a "payments-service"
 * Rust crate, with agent/sub-agent names like "write-tests". No Rust core, no real `claude`,
 * nothing read from ~/.claude.
 *
 * Not a test gate: the spec uses its own config (scripts/readme-media/vitest.media.config.ts)
 * whose include glob no gate matches. Raw frames land in scripts/readme-media/.out/ (ignored).
 *
 * Needs: `npx playwright install chromium` (same as `npm run test:browser`) and ffmpeg on
 * PATH (or FFMPEG=/path/to/ffmpeg) for the GIF. Pass --no-gif to skip encoding the GIF.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(repo, "scripts/readme-media/.out");
const media = path.join(repo, "docs/media");
const ffmpeg = process.env.FFMPEG ?? "ffmpeg";
const withGif = !process.argv.includes("--no-gif");

const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: repo, ...opts });
  if (r.status !== 0) {
    console.error(`[readme-media] ${cmd} failed (${r.status ?? r.error})`);
    process.exit(r.status ?? 1);
  }
};

rmSync(out, { recursive: true, force: true });
mkdirSync(path.join(out, "gif"), { recursive: true });
mkdirSync(path.join(out, "ctxgif"), { recursive: true });
mkdirSync(media, { recursive: true });

run("npx", ["vitest", "run", "--config", "scripts/readme-media/vitest.media.config.ts"]);

for (const f of readdirSync(out).filter((f) => f.endsWith(".png")).sort()) {
  copyFileSync(path.join(out, f), path.join(media, f));
  console.log(`[readme-media] docs/media/${f}  ${(statSync(path.join(media, f)).size / 1024).toFixed(0)} KB`);
}

/** Two-pass palette GIF from numbered PNG frames: 5 fps, 1200px wide, Bayer dithering. */
function encodeGif(dir, name) {
  const frames = path.join(out, `${dir}/%04d.png`);
  const palette = path.join(out, `${dir}-palette.png`);
  const gif = path.join(media, name);
  const vf = "fps=5,scale=1200:-1:flags=lanczos";
  run(ffmpeg, ["-y", "-loglevel", "error", "-framerate", "5", "-i", frames, "-vf", `${vf},palettegen=stats_mode=diff`, palette]);
  run(ffmpeg, [
    "-y", "-loglevel", "error", "-framerate", "5", "-i", frames, "-i", palette,
    "-lavfi", `${vf} [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
    "-loop", "0", gif,
  ]);
  console.log(`[readme-media] docs/media/${name}  ${(statSync(gif).size / 1024).toFixed(0)} KB`);
}

if (withGif) {
  encodeGif("gif", "tour.gif");
  encodeGif("ctxgif", "context-window.gif");
}
