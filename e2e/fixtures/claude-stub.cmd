@echo off
rem E2E fake `claude` for Windows (seam S1, AGENTSTUDIO_CLAUDE_BIN) — the .cmd
rem sibling of claude-stub.sh. Windows E2E is nightly-only (see e2e.yml), so this
rem is best-effort: it prints the banner and then stays alive so the agent PTY
rem reads as `live`.
rem
rem TODO(windows-e2e): verify ConPTY spawns a bare `.cmd` here without a `cmd /c`
rem wrapper. If portable-pty refuses to exec the .cmd directly, the Windows agent
rem spec needs a small launcher, to be checked on the nightly run (macOS
rem cannot drive this tier at all, so it is unverifiable from the dev host).
echo AGENTSTUDIO-E2E fake agent ready
:loop
rem Sleep ~1h without needing stdin, then loop. Crude but keeps the process alive
rem until the PTY is closed.
ping -n 3600 127.0.0.1 >nul
goto loop
