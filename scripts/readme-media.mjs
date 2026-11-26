#!/usr/bin/env node
/** Regenerate README media in docs/media/ from shots.media.tsx (mocked backend, fictional data; not
 * a gate). Needs Playwright Chromium and ffmpeg on PATH (or FFMPEG=…); --no-gif skips the GIF. */
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
