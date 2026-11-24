#!/bin/sh
# A FAKE Claude agent for the gazelle-like scenario (e2e/specs/gazelle-like*.e2e.ts). No real
# Claude, no account, never a real ~/.claude.
#
# How it runs: the E2E's stub `claude` (claude-stub.sh, AGENTSTUDIO_CLAUDE_BIN) execs a trigger file
# the spec writes (`$TMPDIR/agentstudio-e2e-agent.sh`) when one exists, which execs THIS script with the
# adapter's argv (`--session-id <uuid>`). So it runs exactly where Claude would: in an IDE AGENT
# terminal, with that PTY's env (the IDE proxy, the curl shim on PATH), in the agent's cwd.
#
# What it does, like a real agent against the gazelle-like service:
#   1. writes a Claude-format transcript, `$HOME/.claude/projects/<cwd-slug>/<session-id>.jsonl`, with
#      one Bash `tool_use` line per command and its `tool_result` — what the IDE's transcript tail
#      reads (agent/tools.rs: Logs tool lines, logstream/bypass.rs: BYPASS rows). ONLY inside a
#      throwaway container (/.dockerenv): outside one, $HOME is a real person's and it writes nothing.
#   2. runs each command with `sh -c` (as Claude's Bash tool does), echoing `agent$ <command>`, the
#      output, and `agent: <name> exit <code>`:
#        command -v curl                                   (the IDE's curl shim, first on PATH)
#        curl -s --noproxy '*' http://127.0.0.1:3000/health
#        curl -s --noproxy '*' 'http://127.0.0.1:3000/shipping/rates?zone=eu:1'
#        NO_PROXY='*' python3 -c 'import urllib.request; …127.0.0.1:3000/health…'
#          (still proxied: the PTY's lowercase no_proxy="" wins in urllib — captured anyway)
#        env -u HTTP_PROXY -u http_proxy … python3 -c '…/health?direct=1…'
#          (a REAL bypass: no proxy variable left, so Network can only report it)
#        curl -s https://example.com/        (only with --external)
#   3. prints `agent: done` and stays alive (reads the PTY) like a running agent.
#
#   fake-agent.sh [--external] [--base <url>] [--session-id <uuid>] [ignored…]
# POSIX sh + awk only.

external=0
base="http://127.0.0.1:3000"
session=""
while [ $# -gt 0 ]; do
  case "$1" in
    --external) external=1 ;;
    --base) shift; base="${1:-$base}" ;;
    --session-id) shift; session="${1:-}" ;;
  esac
  [ $# -gt 0 ] && shift
done

# Everything it prints is also appended here: an AGENT terminal's PTY output is deliberately NOT in
# the log hub (Claude's TUI redraws are noise — logstream/mod.rs), so the spec reads this instead.
out_file="${TMPDIR:-/tmp}/agentstudio-e2e-agent.out"
: > "$out_file"
say() { printf "$@"; printf "$@" >> "$out_file"; }

say 'AGENTSTUDIO-E2E fake agent (gazelle-like) ready\n'

transcript=""
if [ -n "$session" ] && [ -f /.dockerenv ]; then
  slug=$(pwd | sed 's#[/.]#-#g')
  dir="$HOME/.claude/projects/$slug"
  mkdir -p "$dir" && transcript="$dir/$session.jsonl"
elif [ -n "$session" ]; then
  say 'agent: not in a container — no transcript written (never a real ~/.claude)\n'
fi

json_str() { # stdin → a JSON string body (no surrounding quotes)
  awk 'BEGIN { ORS = "" } { gsub(/\\/, "\\\\"); gsub(/"/, "\\\""); gsub(/\t/, "\\t"); gsub(/\r/, ""); if (NR > 1) print "\\n"; print }'
}
now() { date -u +%Y-%m-%dT%H:%M:%S.%3NZ; }
cwd_json=$(pwd | json_str)
n=0

emit() { [ -n "$transcript" ] && printf '%s\n' "$1" >> "$transcript"; }

emit "{\"type\":\"user\",\"cwd\":\"$cwd_json\",\"sessionId\":\"$session\",\"timestamp\":\"$(now)\",\"message\":{\"role\":\"user\",\"content\":\"Check gazelle is healthy and fetch the eu:1 shipping rates.\"}}"

bash_tool() { # <name> <command>
  name="$1"; cmd="$2"; n=$((n + 1)); id="toolu_e2e_${session:-x}_$n"
  cmd_json=$(printf '%s' "$cmd" | json_str)
  emit "{\"type\":\"assistant\",\"cwd\":\"$cwd_json\",\"sessionId\":\"$session\",\"timestamp\":\"$(now)\",\"message\":{\"id\":\"msg_e2e_$n\",\"role\":\"assistant\",\"model\":\"claude-e2e-stub\",\"stop_reason\":\"tool_use\",\"content\":[{\"type\":\"text\",\"text\":\"Running $name.\"},{\"type\":\"tool_use\",\"id\":\"$id\",\"name\":\"Bash\",\"input\":{\"command\":\"$cmd_json\",\"description\":\"$name\"}}]}}"
  say 'agent$ %s\n' "$cmd"
  out=$(sh -c "$cmd" 2>&1)
  code=$?
  say '%s\nagent: %s exit %s\n' "$out" "$name" "$code"
  out_json=$(printf '%s' "$out" | json_str)
  err=false; [ "$code" -ne 0 ] && err=true
  emit "{\"type\":\"user\",\"cwd\":\"$cwd_json\",\"sessionId\":\"$session\",\"timestamp\":\"$(now)\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"$id\",\"content\":\"$out_json\",\"is_error\":$err}]}}"
  # Give the IDE's transcript tail (50 ms in the E2E) a beat between calls, as a model would.
  sleep 0.5
}

# Which curl an agent's Bash gets: the IDE's shim (<app config>/netcap/bin/curl), first on PATH.
bash_tool which "command -v curl"
bash_tool health "curl -s --noproxy '*' $base/health"
bash_tool rates "curl -s --noproxy '*' '$base/shipping/rates?zone=eu:1'"
bash_tool python "NO_PROXY='*' python3 -c 'import urllib.request; print(urllib.request.urlopen(\"$base/health\", timeout=15).read().decode())'"
bash_tool python-direct "env -u HTTP_PROXY -u http_proxy -u HTTPS_PROXY -u https_proxy -u ALL_PROXY -u all_proxy python3 -c 'import urllib.request; print(urllib.request.urlopen(\"$base/health?direct=1\", timeout=15).read().decode())'"
if [ "$external" = 1 ]; then
  bash_tool example "curl -s -o /dev/null -w 'example.com %{http_code}' https://example.com/"
fi
say 'agent: done\n'

# Stay alive like a running agent; exits when the PTY closes.
exec cat
