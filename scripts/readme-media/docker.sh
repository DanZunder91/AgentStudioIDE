#!/usr/bin/env bash
# Render README media in Linux, inside the Playwright Docker image.
#
#   scripts/readme-media/docker.sh                    # every shot
#   scripts/readme-media/docker.sh "agent db tools"   # only tests whose name matches (vitest -t)
#
# Frames land in scripts/readme-media/.out/ as with scripts/readme-media.mjs; copy the PNGs you
# want into docs/media/ yourself. node_modules lives in a Docker volume, so the host checkout
# keeps its own.
#
# Fonts: the app's mono stack is `ui-monospace, SF Mono, Menlo, Consolas, Liberation Mono,
# monospace`. In the image it would resolve to Liberation Mono, which looks clearly different
# from the SF Mono of the macOS-made shots. Hiding Liberation Mono and installing DejaVu Sans Mono
# (the font Menlo was built from) makes it fall through to a close match.
set -euo pipefail

repo="$(cd "$(dirname "$0")/../.." && pwd)"
# The image must match the playwright version in package-lock.json.
image="mcr.microsoft.com/playwright:v$(node -p "require('$repo/package-lock.json').packages['node_modules/playwright'].version")-noble"
filter="${1:-}"

# TZ only changes how timestamps in the shots read (the API shots' History is "earlier today").
docker run --rm --init --ipc=host --shm-size=1g \
  -e TZ="${TZ:-Asia/Tokyo}" -e FILTER="$filter" \
  -v "$repo":/repo -v agent-studio-readme-media-nm:/repo/node_modules \
  -w /repo "$image" bash -c '
set -euo pipefail
apt-get update -qq && apt-get install -y -qq --no-install-recommends fonts-dejavu-core >/dev/null
cat > /etc/fonts/conf.d/99-no-liberation-mono.conf <<EOF
<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig><selectfont><rejectfont><glob>/usr/share/fonts/truetype/liberation/LiberationMono-*</glob></rejectfont></selectfont></fontconfig>
EOF
fc-cache -f >/dev/null
npm ci --no-audit --no-fund --loglevel=error
if [ -n "$FILTER" ]; then
  npx vitest run --config scripts/readme-media/vitest.media.config.ts -t "$FILTER"
else
  npx vitest run --config scripts/readme-media/vitest.media.config.ts
fi
'
