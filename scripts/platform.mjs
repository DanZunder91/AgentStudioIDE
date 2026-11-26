/** Pure host-platform decisions for the gate scripts, tested in verify.test.mjs with the platform
 * passed in. On Windows npm is `npm.cmd`, and since CVE-2024-27980 a `.cmd` needs a shell. */

/** Batch files on Windows; everything else spawned is a real executable, run without a shell. */
const WINDOWS_BATCH_COMMANDS = new Set(["npm", "npx"]);

/** Args allowed through cmd.exe, which re-parses the line. Anything else is refused, not quoted:
 * cmd.exe quoting is what CVE-2024-27980 shows people get wrong. */
const CMD_SAFE_ARG = /^[A-Za-z0-9_@+=:,./-]+$/;

/** `{ cmd, args, options }` for spawnSync; identity off Windows. Throws on an arg cmd.exe would
 * interpret: a gate that cannot express its command safely must stop, not run something else. */
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

/** windows-check is a Docker cross-compile that runs nothing; on Windows the native cargo steps
 * compile, lint and run that code. Printed on every run so the skip never reads as a pass. */
export const WINDOWS_HOST_CHECK_SKIP =
  "this host is Windows; the native cargo clippy --all-targets and cargo test steps are the " +
  "Windows check (they compile, lint AND run the cfg(windows) code — the Docker cross-compile " +
  "only compiles and lints it)";
