/**
 * Host-platform decisions shared by the gate scripts (`verify.mjs`, `audit.mjs`,
 * `windows-check.mjs`). Pure functions only — every decision here is unit-tested in
 * `verify.test.mjs` with the platform passed in, so the Windows branch is pinned on a Mac and
 * the macOS/Linux branch is pinned on Windows.
 *
 * Before these existed every script here had only ever run on macOS or Linux, and two of them
 * could not start on Windows at all:
 *
 *  - `spawnSync("npm", …)` — there is no `npm.exe`; npm on Windows is `npm.cmd`, a batch file,
 *    so a bare `npm` is ENOENT.
 *  - `spawnSync("npm.cmd", …)` without a shell — **EINVAL** since Node 18.20.2 / 20.12.2. That
 *    is the CVE-2024-27980 ("BatBadBut") fix: Node no longer runs a `.cmd`/`.bat` behind your
 *    back, because cmd.exe re-parses the command line and an argument can smuggle in `&` or `|`.
 *    `audit.mjs` already spelled it `npm.cmd` and failed exactly this way.
 *
 * Zero dependencies, like the scripts that use it.
 */

/**
 * Commands that are batch files on Windows (`<name>.cmd` beside `node.exe`) rather than
 * executables. Everything else the scripts spawn — `cargo`, `docker`, `node`, `git`, `xcrun` —
 * is a real executable on every OS and is spawned without a shell everywhere.
 */
const WINDOWS_BATCH_COMMANDS = new Set(["npm", "npx"]);

/**
 * Characters an argument may contain when it has to pass through cmd.exe. cmd re-parses the
 * line, so `&`, `|`, `<`, `>`, `^`, `%`, `!`, quotes and whitespace would all change what runs.
 * Every argument the gates actually pass (`run`, `test:coverage`, `--omit=dev`, `--json`, …) is
 * inside this set, so nothing needs quoting — and anything that would need it is refused rather
 * than quoted, because a quoting routine for cmd.exe is precisely the code CVE-2024-27980 shows
 * people get wrong.
 */
const CMD_SAFE_ARG = /^[A-Za-z0-9_@+=:,./-]+$/;

/**
 * How to spawn `cmd args` on `platform`: `{ cmd, args, options }`, where `options` is merged
 * into the `spawnSync` options. Identity on macOS and Linux, so their behaviour is unchanged.
 *
 * Throws when an argument for a Windows batch command contains a character cmd.exe would
 * interpret: a gate script that cannot express its command safely must stop, not run something
 * else.
 */
export function spawnSpec(cmd, args, platform = process.platform) {
  if (platform !== "win32" || !WINDOWS_BATCH_COMMANDS.has(cmd)) {
    return { cmd, args, options: {} };
  }
  const unsafe = args.filter((a) => !CMD_SAFE_ARG.test(a));
  if (unsafe.length > 0) {
    throw new Error(
      `refusing to run \`${cmd}\` through cmd.exe with argument(s) it would re-interpret: ` +
        `${unsafe.map((a) => JSON.stringify(a)).join(", ")} (CVE-2024-27980; see scripts/platform.mjs)`,
    );
  }
  return { cmd: `${cmd}.cmd`, args, options: { shell: true } };
}

/**
 * Why `scripts/windows-check.mjs` does not run on a Windows host, printed by both `verify` and
 * the script itself. On Windows the script would be redundant, not merely unavailable: it is a
 * Docker cross-compile that type-checks and lints `cfg(windows)` code and RUNS nothing, while
 * the native `cargo clippy --all-targets` and `cargo test` steps in `verify` compile, lint AND
 * run that code for the host's own target. Saying so on every run keeps the skip from reading
 * as a pass (a silent skip is indistinguishable from a pass).
 */
export const WINDOWS_HOST_CHECK_SKIP =
  "this host is Windows; the native cargo clippy --all-targets and cargo test steps are the " +
  "Windows check (they compile, lint AND run the cfg(windows) code — the Docker cross-compile " +
  "only compiles and lints it)";
