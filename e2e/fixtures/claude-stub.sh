#!/bin/sh
# E2E fake `claude` (seam S1, AGENTSTUDIO_CLAUDE_BIN).
#
# The real agent flow spawns the `claude` CLI in a PTY — which needs auth and a
# network, and would make the suite slow and flaky. `agent/claude.rs`
# `resolve_binary()` honours AGENTSTUDIO_CLAUDE_BIN first (requiring an executable
# file), so pointing that env at this script makes `agent_spawn` drive a stub
# instead. See e2e/README.md.
#
# Contract this must satisfy (plus: `-p … /context` prints a fixed `/context` reading and exits —
# see the first block below):
#   1. Print a recognisable banner (a byte the terminal can render) so a human
#      watching a headed run can see the fake agent came up.
#   2. STAY ALIVE until the PTY is closed/killed, so the agent's terminal tab
#      reads as `live`/running (the F1 assertion) rather than `[process exited]`.
#   3. RECORD its argv — one line per launch, appended to
#      `${TMPDIR:-/tmp}/agentstudio-e2e-claude-argv.log` — and otherwise ignore it. The
#      restart E2E (e2e/specs/restart.e2e.ts) reads the adapter's `--session-id <uuid>`
#      there (the session id never crosses to the UI, by design) and, after a restart,
#      the `--resume <uuid>` / new `--session-id` the restore launched it with
#      (docs/design/agent-restart-restore.md §7).
#
# Its input, a line at a time (the PTY's line discipline already echoes what is typed;
# like `cat`, each line is printed back once more):
#   /exit  — the agent ends on its own (a user's `/exit`): the process exits 0.
#   /work  — the user submitted a prompt: report it the way Claude's `UserPromptSubmit`
#            hook does (the same POST to the app's listener, with the same env-borne URL,
#            token and terminal id — agent/claude.rs `hook_post`), so the IDE marks the
#            agent RUNNING (turn hooks). Nothing else is simulated: no transcript, no tools.
#
# POSIX /bin/sh only (no bashisms): CI runners vary.

# `/context` — the Context card's and the Village Seats hall's read-only probe
# (src-tauri/src/context_usage.rs runs `claude -p --resume <id> --no-session-persistence "/context"`):
# answer with one fixed reading — a realistic `/context` (109.9k of 1m, 11%) — in
# the CLI's `-p` markdown, and exit. Checked BEFORE the argv log on purpose: the restart spec reads
# the launches' `--session-id` / `--resume` there, and this probe is not a launch.
for arg in "$@"; do last="$arg"; done
case " $* " in
  *" -p "*)
    if [ "${last:-}" = "/context" ]; then
      cat <<'CONTEXT'
## Context Usage

**Model:** claude-opus-5-5  
**Tokens:** 109.9k / 1m (11%)

### Estimated usage by category

| Category | Tokens | Percentage |
|----------|--------|------------|
| System prompt | 4.2k | 0.4% |
| System tools | 20.2k | 2.0% |
| MCP server instructions | 717 | 0.1% |
| Memory files | 2.1k | 0.2% |
| Skills | 6.8k | 0.7% |
| Messages | 75.9k | 7.6% |
| Free space | 857.1k | 85.7% |
| Autocompact buffer | 33k | 3.3% |
CONTEXT
      exit 0
    fi
    ;;
esac

printf '%s\n' "$*" >> "${TMPDIR:-/tmp}/agentstudio-e2e-claude-argv.log"

# A spec that needs the agent to DO something (the gazelle-like scenario's fake agent,
# e2e/fixtures/fake-agent.sh) writes this trigger file before launching one and removes it after;
# every other spec never has it, so they keep the plain stub below.
trigger="${TMPDIR:-/tmp}/agentstudio-e2e-agent.sh"
if [ -f "$trigger" ]; then
  exec sh "$trigger" "$@"
fi

# The session this launch speaks for: `--session-id <id>` (a fresh one) or `--resume <id>`.
session=""
while [ $# -gt 0 ]; do
  case "$1" in
    --session-id | --resume) shift; session="${1:-}" ;;
  esac
  [ $# -gt 0 ] && shift
done

printf 'AGENTSTUDIO-E2E fake agent ready\n'

# Block on the PTY without busy-looping, until EOF (the PTY torn down at terminal close) or
# `/exit` — exactly the lifetime we want for a "running" agent.
while IFS= read -r line; do
  case "$line" in
    /exit) exit 0 ;;
    /work)
      if [ -n "$AGENTSTUDIO_HOOK_URL" ] && [ -n "$session" ]; then
        printf '{"hook_event_name":"UserPromptSubmit","session_id":"%s","cwd":"%s","prompt":"e2e"}' "$session" "$(pwd)" |
          AGENTSTUDIO_PROXY_STRICT=0 curl --noproxy '*' -sS -m 3 -X POST "$AGENTSTUDIO_HOOK_URL" \
            -H "X-AgentStudio-Token: $AGENTSTUDIO_HOOK_TOKEN" -H "X-AgentStudio-Terminal: $AGENTSTUDIO_TERMINAL_ID" \
            --data-binary @- >/dev/null 2>&1
      fi
      ;;
  esac
  printf '%s\n' "$line"
done
