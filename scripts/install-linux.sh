#!/usr/bin/env bash
# Installs the latest Agent Studio release on Linux (x86_64):
#
#   curl -fsSL https://raw.githubusercontent.com/DanZunder91/AgentStudioIDE/main/scripts/install-linux.sh | bash
#
# Downloads the newest release's package for this machine, checks it against the release's
# SHA256SUMS.txt, installs it and opens the app when there is a graphical session:
#
#   apt-get                      -> the .deb, installed with apt-get (sudo)
#   dnf, zypper or yum           -> the .rpm, installed with that package manager (sudo)
#   none of them, or no sudo     -> the AppImage, into ~/.local/bin with a menu entry (no root)
#
# The package manager resolves the WebKitGTK and GTK libraries the .deb and .rpm depend on. Every
# build is versioned 0.1.0, so a package with the installed version is REinstalled: otherwise
# running this again for a newer build would stop at "already the newest version".
#
# Under `curl | bash`, bash reads the script from stdin. Everything runs inside main(), which bash
# has read whole before it runs a line, and every command that could read stdin gets </dev/null,
# so nothing can swallow the rest of the script. sudo asks for the password on the terminal.
#
# AGENT_STUDIO_PKG=/path/to/file.{deb,rpm,AppImage} installs that local file instead of downloading
# (no checksum: there is no release to check it against). Used to try a build before it is
# published. AGENT_STUDIO_FORMAT=deb|rpm|appimage picks the format instead of detecting it.
set -euo pipefail

REPO="DanZunder91/AgentStudioIDE"
# The command the .deb and .rpm put in /usr/bin (Tauri names the binary after the Cargo crate).
# The AppImage is installed under the same name, so one command starts the app on every route.
CMD="agent-studio-scaffold"

fail() {
  printf 'Agent Studio install failed: %s\n' "$1" >&2
  exit 1
}

have() { command -v "$1" >/dev/null 2>&1; }

is_root() { [ "$(id -u)" -eq 0 ]; }

as_root() {
  if is_root; then
    "$@" </dev/null
  else
    sudo "$@" </dev/null
  fi
}

# The URL of the first asset in the release JSON on stdin whose name matches the regex $1.
asset_url() {
  grep -o '"browser_download_url": *"[^"]*"' | sed 's/.*"\(https[^"]*\)"$/\1/' | grep -E "$1\$" | head -1
}

detect_format() {
  if ! is_root && ! have sudo; then
    echo "sudo is not available, so installing the AppImage for this user only." >&2
    echo appimage
  elif have apt-get; then
    echo deb
  elif have dnf || have zypper || have yum; then
    echo rpm
  else
    echo appimage
  fi
}

# The first /usr/bin entry of the package's file list on stdin, or the default command.
bin_of() {
  local found
  found="$(grep '^/usr/bin/' || true)"
  found="${found%%$'\n'*}"
  echo "${found:-/usr/bin/$CMD}"
}

install_deb() {
  local pkg="$1" name
  have apt-get || fail "the .deb needs apt-get, which this machine does not have."
  echo "Installing with apt-get"
  # Without fresh lists apt cannot fetch the WebKitGTK dependencies. A broken third-party source
  # should not stop the install, so a failed update only warns.
  as_root env DEBIAN_FRONTEND=noninteractive apt-get update -q ||
    echo "apt-get update failed; installing with the package lists as they are." >&2
  as_root env DEBIAN_FRONTEND=noninteractive \
    apt-get install -y -q --reinstall --allow-downgrades "$pkg"
  name="$(dpkg-deb -f "$pkg" Package)"
  installed="$(dpkg -L "$name" </dev/null | bin_of)"
}

install_rpm() {
  local pkg="$1" nvr action=install
  nvr="$(rpm -qp --qf '%{NAME}-%{VERSION}-%{RELEASE}' "$pkg" 2>/dev/null </dev/null || true)"
  if [ -n "$nvr" ] && rpm -q "$nvr" >/dev/null 2>&1 </dev/null; then
    action=reinstall
  fi
  if have dnf; then
    echo "Installing with dnf"
    as_root dnf "$action" -y "$pkg"
  elif have zypper; then
    echo "Installing with zypper"
    # Builds are not signed yet; --force reinstalls a package with the installed version.
    as_root zypper --non-interactive install --force --allow-unsigned-rpm "$pkg"
  elif have yum; then
    echo "Installing with yum"
    as_root yum "$action" -y "$pkg"
  else
    fail "the .rpm needs dnf, zypper or yum, and this machine has none of them."
  fi
  installed="$(rpm -qlp "$pkg" 2>/dev/null </dev/null | bin_of)"
}

install_appimage() {
  local pkg="$1" dir="$HOME/.local/bin" data="${XDG_DATA_HOME:-$HOME/.local/share}"
  local icons="$data/icons/hicolor/256x256/apps"
  echo "Installing the AppImage into $dir"
  mkdir -p "$dir" "$data/applications" "$icons"
  # Copied then renamed: writing over the file of a running AppImage fails ("Text file busy").
  cp "$pkg" "$dir/.$CMD.new"
  chmod 755 "$dir/.$CMD.new"
  mv -f "$dir/.$CMD.new" "$dir/$CMD"
  installed="$dir/$CMD"

  # The icon the packages install, from the same branch this script comes from.
  curl -fsSL -o "$icons/$CMD.png" \
    "https://raw.githubusercontent.com/$REPO/main/src-tauri/icons/128x128@2x.png" ||
    echo "Could not download the icon; the menu entry uses a generic one." >&2
  cat >"$data/applications/$CMD.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Agent Studio
Comment=Cockpit for orchestrating fleets of AI coding agents
Exec="$installed"
Icon=$CMD
StartupWMClass=$CMD
Categories=Development;
Terminal=false
EOF
  if have update-desktop-database; then
    update-desktop-database "$data/applications" >/dev/null 2>&1 </dev/null || true
  fi

  # The AppImage runtime is static: it needs only a fusermount binary, not libfuse2.
  if ! have fusermount && ! have fusermount3; then
    echo "Note: the AppImage needs FUSE to start: install the fuse3 package (or fuse)." >&2
  fi
  case ":$PATH:" in
    *":$dir:"*) ;;
    *) echo "Note: $dir is not on your PATH, so start Agent Studio from the applications menu or as $installed." ;;
  esac
}

# Opens the app detached from this terminal, when there is a desktop to open it on.
launch() {
  local name="${installed##*/}" run="$installed"
  # The bare command when it resolves to what was just installed, the full path otherwise.
  if [ "$(command -v "$name" 2>/dev/null || true)" = "$installed" ]; then
    run="$name"
  fi
  if is_root; then
    echo "Start it as your own user (not root): $run"
  elif [ -z "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
    echo "No graphical session here; start it later with: $run"
  elif pgrep -f -- "(^|/)$name( |\$)" >/dev/null 2>&1 </dev/null; then
    # Quitting it would end the agents running in its terminals.
    echo "Agent Studio is already running: quit and reopen it to use the new version."
  elif have setsid; then
    setsid "$installed" </dev/null >/dev/null 2>&1 &
  else
    nohup "$installed" </dev/null >/dev/null 2>&1 &
  fi
}

main() {
  [ "$(uname -s)" = "Linux" ] || fail "this installer is for Linux."
  case "$(uname -m)" in
    x86_64 | amd64) ;;
    *) fail "only x86_64 builds are published (this machine is $(uname -m))." ;;
  esac
  have curl || fail "curl is required."
  have sha256sum || fail "sha256sum is required."

  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  # apt reads a local package as its unprivileged _apt user, which cannot enter a 0700 directory.
  chmod 755 "$tmp"

  local format pattern release url sums_url pkg sum
  if [ -n "${AGENT_STUDIO_PKG:-}" ]; then
    [ -f "$AGENT_STUDIO_PKG" ] || fail "no such file: $AGENT_STUDIO_PKG"
    case "$AGENT_STUDIO_PKG" in
      *.deb) format=deb ;;
      *.rpm) format=rpm ;;
      *.AppImage) format=appimage ;;
      *) fail "AGENT_STUDIO_PKG must be a .deb, .rpm or .AppImage file." ;;
    esac
    pkg="$tmp/${AGENT_STUDIO_PKG##*/}"
    cp "$AGENT_STUDIO_PKG" "$pkg"
  else
    format="${AGENT_STUDIO_FORMAT:-$(detect_format)}"
    case "$format" in
      deb) pattern='_amd64\.deb' ;;
      rpm) pattern='\.x86_64\.rpm' ;;
      appimage) pattern='_amd64\.AppImage' ;;
      *) fail "AGENT_STUDIO_FORMAT must be deb, rpm or appimage." ;;
    esac
    release="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest")" ||
      fail "could not read the latest release from GitHub."
    url="$(printf '%s\n' "$release" | asset_url "$pattern")"
    sums_url="$(printf '%s\n' "$release" | asset_url 'SHA256SUMS\.txt')"
    [ -n "$url" ] || fail "the latest release has no x86_64 $format package."
    [ -n "$sums_url" ] || fail "the latest release has no SHA256SUMS.txt."

    pkg="$tmp/${url##*/}"
    echo "Downloading ${url##*/}"
    curl -fL --progress-bar -o "$pkg" "$url" || fail "download failed."
    curl -fsSL -o "$tmp/SHA256SUMS.txt" "$sums_url" || fail "could not download SHA256SUMS.txt."
    # Matched by hash, not name: GitHub renames assets (a space becomes a dot), the sums file keeps
    # the name the build gave the file.
    sum="$(sha256sum "$pkg" | cut -d' ' -f1)"
    grep -q "^$sum " "$tmp/SHA256SUMS.txt" || fail "checksum mismatch: the download is corrupt."
  fi
  chmod 644 "$pkg"

  installed=""
  case "$format" in
    deb) install_deb "$pkg" ;;
    rpm) install_rpm "$pkg" ;;
    appimage) install_appimage "$pkg" ;;
  esac
  [ -x "$installed" ] || fail "the package installed, but $installed is missing."

  echo "Agent Studio is installed: $installed"
  launch
}

main "$@"
