#!/usr/bin/env bash
# Installs the latest Agent Studio release on macOS (Apple Silicon):
#
#   curl -fsSL https://raw.githubusercontent.com/DanZunder91/AgentStudioIDE/main/scripts/install-macos.sh | bash
#
# Downloads the newest release's .dmg, checks it against the release's SHA256SUMS.txt, copies
# "Agent Studio.app" into /Applications (~/Applications when /Applications is not writable),
# checks its code signature and opens it. A file fetched with curl carries no quarantine flag, so
# the app opens without the Gatekeeper prompt a browser download gets while builds are not
# notarized.
#
# AGENT_STUDIO_DMG=/path/to/file.dmg installs that local .dmg instead of downloading (no checksum:
# there is no release to check it against). Used to try a build before it is published.
set -euo pipefail

REPO="DanZunder91/AgentStudioIDE"
APP="Agent Studio.app"

fail() {
  printf 'Agent Studio install failed: %s\n' "$1" >&2
  exit 1
}

[ "$(uname -s)" = "Darwin" ] || fail "this installer is for macOS."
[ "$(uname -m)" = "arm64" ] || fail "only Apple Silicon (arm64) builds are published."

tmp="$(mktemp -d)"
mnt="$tmp/mnt"
cleanup() {
  hdiutil detach "$mnt" -quiet >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT

# The URL of the first asset in the release JSON on stdin whose name ends with $1.
asset_url() {
  grep -o '"browser_download_url": *"[^"]*"' | sed 's/.*"\(https[^"]*\)"$/\1/' | grep -E "$1\$" | head -1
}

if [ -n "${AGENT_STUDIO_DMG:-}" ]; then
  [ -f "$AGENT_STUDIO_DMG" ] || fail "no such file: $AGENT_STUDIO_DMG"
  dmg="$AGENT_STUDIO_DMG"
else
  release="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest")" ||
    fail "could not read the latest release from GitHub."
  dmg_url="$(printf '%s\n' "$release" | asset_url '_aarch64\.dmg')"
  sums_url="$(printf '%s\n' "$release" | asset_url 'SHA256SUMS\.txt')"
  [ -n "$dmg_url" ] || fail "the latest release has no Apple Silicon .dmg."
  [ -n "$sums_url" ] || fail "the latest release has no SHA256SUMS.txt."

  dmg="$tmp/AgentStudio.dmg"
  echo "Downloading ${dmg_url##*/}"
  curl -fL --progress-bar -o "$dmg" "$dmg_url" || fail "download failed."
  curl -fsSL -o "$tmp/SHA256SUMS.txt" "$sums_url" || fail "could not download SHA256SUMS.txt."
  # Matched by hash, not name: GitHub renames assets (a space becomes a dot), the sums file keeps
  # the name the build gave the file.
  sum="$(shasum -a 256 "$dmg" | cut -d' ' -f1)"
  grep -q "^$sum " "$tmp/SHA256SUMS.txt" || fail "checksum mismatch: the download is corrupt."
fi

mkdir -p "$mnt"
hdiutil attach "$dmg" -nobrowse -readonly -noautoopen -mountpoint "$mnt" -quiet ||
  fail "could not open the .dmg."
[ -d "$mnt/$APP" ] || fail "the .dmg does not contain $APP."

dest="/Applications"
if [ ! -w "$dest" ]; then
  dest="$HOME/Applications"
  mkdir -p "$dest"
fi

if pgrep -f "$dest/$APP/Contents/MacOS/" >/dev/null 2>&1; then
  echo "Quitting the running Agent Studio"
  osascript -e 'tell application id "com.agentstudio.app" to quit' >/dev/null 2>&1 || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    pgrep -f "$dest/$APP/Contents/MacOS/" >/dev/null 2>&1 || break
    sleep 1
  done
fi

echo "Installing into $dest"
rm -rf "${dest:?}/$APP"
ditto "$mnt/$APP" "$dest/$APP"
codesign --verify --deep --strict "$dest/$APP" 2>/dev/null ||
  fail "the installed app's code signature is invalid; please report this build."

echo "Agent Studio is installed: $dest/$APP"
open "$dest/$APP"
