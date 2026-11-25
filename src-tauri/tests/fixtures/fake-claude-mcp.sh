#!/bin/sh
# A stand-in for Claude Code's `claude mcp add|get|remove`, for the tests of
# `agent-studio mcp install|uninstall|status` (src-tauri/src/agent_ctl/mcp.rs).
#
# It never reads or writes a real Claude Code config. Its one server entry is a file next to this
# script, and every run appends its argv there as well (one argument per line, then `--end--`), so
# a test can assert the exact command the app ran. The output copies the wording `claude mcp`
# 2.1.x prints for each case the app reads. A `mode` file next to it switches to a misbehaving
# claude: `garbage` (an answer in an unknown form), `fail` (an error exit), `hang` (no answer).
#
# POSIX /bin/sh only.
here="$(cd "$(dirname "$0")" && pwd)"
for a in "$@"; do printf '%s\n' "$a"; done >> "$here/argv.log"
printf -- '--end--\n' >> "$here/argv.log"
entry="$here/entry"
mode=normal
if [ -f "$here/mode" ]; then mode="$(cat "$here/mode")"; fi
case "$mode" in
  garbage) echo "Something in a form nobody expected"; exit 0 ;;
  fail) echo "boom: the config is locked" >&2; exit 3 ;;
  hang) exec sleep 30 ;;
esac
case "$1 $2" in
  "mcp add")
    if [ -f "$entry" ]; then
      echo "MCP server $5 already exists in user config" >&2
      exit 1
    fi
    shift 6
    printf '%s\n%s\n' "$1" "$2" > "$entry"
    echo "Added stdio MCP server agent-studio with command: $1 $2 to user config"
    ;;
  "mcp get")
    if [ ! -f "$entry" ]; then
      echo "No MCP server named \"$3\". Run \`claude mcp add\` to add one." >&2
      exit 1
    fi
    printf '%s:\n  Scope: User config (available in all your projects)\n  Status: ✓ Connected\n  Type: stdio\n  Command: %s\n  Args: %s\n  Environment:\n\nTo remove this server, run: claude mcp remove %s -s user\n' \
      "$3" "$(sed -n 1p "$entry")" "$(sed -n 2p "$entry")" "$3"
    ;;
  "mcp remove")
    if [ ! -f "$entry" ]; then
      echo "No MCP server named \"$5\" in user scope" >&2
      exit 1
    fi
    rm -f "$entry"
    echo "Removed MCP server $5 from user config"
    ;;
  *)
    echo "fake claude: unexpected arguments: $*" >&2
    exit 9
    ;;
esac
