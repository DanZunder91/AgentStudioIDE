//! The `agent-studio` script on every terminal's PATH, exec'ing the binary in [`EXE_VAR`]; written
//! under the app config dir, never `~/.claude` (LESSONS §1). Claude's Bash tool reorders PATH
//! (LESSONS §85). Windows gets only [`TOOLS_DIR_VAR`]: PowerShell opens extensionless files.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// `<app config dir>/agent-tools`.
pub const DIR: &str = "agent-tools";
/// The directory under [`DIR`] that goes on `PATH`.
pub const BIN_DIR: &str = "bin";
/// The command's name.
pub const SCRIPT_NAME: &str = "agent-studio";
/// The line after the shebang that marks the file as ours.
pub const MARKER: &str = "# agentstudio-cli v1";
/// The directory holding the script, exported to every PTY.
pub const TOOLS_DIR_VAR: &str = "AGENTSTUDIO_TOOLS_DIR";
/// The running app's binary, exported to every PTY; the script `exec`s it.
pub const EXE_VAR: &str = "AGENTSTUDIO_EXE";

/// The script. `cygpath` converts the `C:\…` path Windows puts in [`EXE_VAR`] for Git Bash; it
/// does not exist on macOS or Linux, where the path is used as given.
pub const SCRIPT: &str = r#"#!/bin/sh
# agentstudio-cli v1
# Written by Agent Studio: runs the app's own binary in command mode (`agent-studio help`).
exe="${AGENTSTUDIO_EXE:-}"
if [ -z "$exe" ]; then
  echo "agent-studio: run this from a terminal inside Agent Studio." >&2
  exit 2
fi
if command -v cygpath >/dev/null 2>&1; then exe="$(cygpath -u "$exe")"; fi
if [ ! -x "$exe" ]; then
  echo "agent-studio: the Agent Studio app that opened this terminal is gone ($exe). Open a new terminal." >&2
  exit 3
fi
exec "$exe" "$@"
"#;

/// Where the script is and which binary it runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tools {
    pub bin_dir: PathBuf,
    pub exe: PathBuf,
}

static TOOLS: OnceLock<Tools> = OnceLock::new();

/// Write the script under `config_dir` and remember it for every PTY spawned from now on.
/// Real boot only. `None` (logged) when it cannot be written: terminals still open, without
/// the command.
pub fn install(config_dir: &Path, exe: PathBuf) -> Option<Tools> {
    match write(&config_dir.join(DIR)) {
        Ok(bin_dir) => {
            let tools = Tools { bin_dir, exe };
            let _ = TOOLS.set(tools.clone());
            Some(tools)
        }
        Err(e) => {
            eprintln!("agent tools: `agent-studio` command not written: {e}");
            None
        }
    }
}

/// Write `<dir>/bin/agent-studio` (0755) when it is missing or differs; returns the `bin` dir.
/// Atomic (temp + rename), so a terminal spawning mid-write never runs half a script.
pub fn write(dir: &Path) -> std::io::Result<PathBuf> {
    let bin = dir.join(BIN_DIR);
    std::fs::create_dir_all(&bin)?;
    let path = bin.join(SCRIPT_NAME);
    if std::fs::read(&path).ok().as_deref() != Some(SCRIPT.as_bytes()) {
        let tmp = bin.join(format!(".{SCRIPT_NAME}.{}.tmp", ulid::Ulid::new()));
        std::fs::write(&tmp, SCRIPT)?;
        set_executable(&tmp)?;
        std::fs::rename(&tmp, &path)?;
    } else {
        set_executable(&path)?;
    }
    Ok(bin)
}

#[cfg(unix)]
fn set_executable(p: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt as _;
    std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o755))
}

#[cfg(not(unix))]
fn set_executable(_: &Path) -> std::io::Result<()> {
    Ok(())
}

/// Add the tools env to a PTY's spawn env, if [`install`] ran. Call it LAST: it reads the
/// `PATH` the capture env may already have set and prepends to that.
pub fn apply_env(env: &mut Vec<(String, String)>) {
    let Some(tools) = TOOLS.get() else {
        return;
    };
    let base = std::env::var("PATH").ok();
    let add = env_for(tools, env, base.as_deref(), cfg!(windows));
    env.extend(add);
}

/// The variables to append for `tools`, given the env built so far and the inherited `PATH`.
/// Pure, with the OS as a parameter, so every platform's answer is tested everywhere.
pub fn env_for(
    tools: &Tools,
    env: &[(String, String)],
    inherited_path: Option<&str>,
    windows: bool,
) -> Vec<(String, String)> {
    let dir = tools.bin_dir.to_string_lossy().into_owned();
    let mut out = vec![
        (TOOLS_DIR_VAR.to_string(), dir.clone()),
        (
            EXE_VAR.to_string(),
            tools.exe.to_string_lossy().into_owned(),
        ),
    ];
    if !windows {
        // The last PATH already in the spawn env wins at spawn (later sets override earlier
        // ones), so that is the one to prepend to.
        let current = env
            .iter()
            .rev()
            .find(|(k, _)| k == "PATH")
            .map(|(_, v)| v.as_str())
            .or(inherited_path);
        out.push(("PATH".to_string(), prepend_path(&dir, current)));
    }
    out
}

/// `dir` first, then `base` without any other copy of `dir` (an app started from an app
/// terminal inherits it). An empty `base` gets the POSIX default.
pub fn prepend_path(dir: &str, base: Option<&str>) -> String {
    let base = base
        .filter(|b| !b.is_empty())
        .unwrap_or("/usr/bin:/bin:/usr/sbin:/sbin");
    let mut out = vec![dir];
    out.extend(base.split(':').filter(|e| *e != dir));
    out.join(":")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tools() -> Tools {
        Tools {
            bin_dir: PathBuf::from("/cfg/agent-tools/bin"),
            exe: PathBuf::from("/Applications/Agent Studio.app/Contents/MacOS/agent-studio"),
        }
    }

    fn get<'a>(env: &'a [(String, String)], k: &str) -> Option<&'a str> {
        env.iter()
            .rev()
            .find(|(n, _)| n == k)
            .map(|(_, v)| v.as_str())
    }

    #[test]
    fn the_tools_dir_goes_in_front_of_the_path_the_capture_env_already_set() {
        // The capture env put the curl shim first; ours must compose with it, not replace it.
        let built = vec![(
            "PATH".to_string(),
            "/cfg/netcap/bin:/usr/bin:/bin".to_string(),
        )];
        let add = env_for(&tools(), &built, Some("/inherited"), false);
        assert_eq!(
            get(&add, "PATH"),
            Some("/cfg/agent-tools/bin:/cfg/netcap/bin:/usr/bin:/bin")
        );
        assert_eq!(get(&add, TOOLS_DIR_VAR), Some("/cfg/agent-tools/bin"));
        assert_eq!(
            get(&add, EXE_VAR),
            Some("/Applications/Agent Studio.app/Contents/MacOS/agent-studio")
        );
    }

    #[test]
    fn without_a_capture_path_it_prepends_to_the_inherited_one_once() {
        let add = env_for(
            &tools(),
            &[],
            Some("/cfg/agent-tools/bin:/usr/local/bin:/usr/bin"),
            false,
        );
        assert_eq!(
            get(&add, "PATH"),
            Some("/cfg/agent-tools/bin:/usr/local/bin:/usr/bin")
        );
        let add = env_for(&tools(), &[], None, false);
        assert_eq!(
            get(&add, "PATH"),
            Some("/cfg/agent-tools/bin:/usr/bin:/bin:/usr/sbin:/sbin")
        );
    }

    #[test]
    fn on_windows_the_path_is_left_alone_and_only_the_variables_are_exported() {
        let add = env_for(&tools(), &[], Some(r"C:\Windows"), true);
        assert_eq!(get(&add, "PATH"), None);
        assert_eq!(get(&add, TOOLS_DIR_VAR), Some("/cfg/agent-tools/bin"));
        assert!(get(&add, EXE_VAR).is_some());
    }

    #[test]
    fn the_script_is_written_executable_and_rewritten_only_when_it_differs() {
        let dir = std::env::temp_dir().join(format!("agentstudio-tools-{}", ulid::Ulid::new()));
        let bin = write(&dir).unwrap();
        let path = bin.join(SCRIPT_NAME);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), SCRIPT);
        assert!(SCRIPT.lines().nth(1) == Some(MARKER));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o755);
        }
        std::fs::write(&path, "stale").unwrap();
        write(&dir).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), SCRIPT);
        // No temp file is left behind.
        let leftovers: Vec<_> = std::fs::read_dir(&bin)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The real script, run by the real `sh`: it execs the binary named in the env with every
    /// argument intact (a URL with `&` and spaces included), and says what is wrong otherwise.
    #[cfg(unix)]
    #[test]
    fn the_script_execs_the_app_binary_with_its_arguments_intact() {
        use std::process::Command;
        let dir = std::env::temp_dir().join(format!("agentstudio-tools-{}", ulid::Ulid::new()));
        let bin = write(&dir).unwrap();
        let fake = dir.join("fake app");
        std::fs::write(
            &fake,
            "#!/bin/sh\nfor a in \"$@\"; do printf '[%s]' \"$a\"; done\n",
        )
        .unwrap();
        set_executable(&fake).unwrap();

        let out = Command::new(bin.join(SCRIPT_NAME))
            .args([
                "db",
                "connect",
                "postgres://u:p@h/db?a=1&b=2",
                "--name",
                "My Shop",
            ])
            .env(EXE_VAR, &fake)
            .output()
            .unwrap();
        assert!(out.status.success());
        assert_eq!(
            String::from_utf8_lossy(&out.stdout),
            "[db][connect][postgres://u:p@h/db?a=1&b=2][--name][My Shop]"
        );

        let out = Command::new(bin.join(SCRIPT_NAME))
            .arg("help")
            .env_remove(EXE_VAR)
            .output()
            .unwrap();
        assert_eq!(out.status.code(), Some(2));
        assert!(String::from_utf8_lossy(&out.stderr).contains("inside Agent Studio"));

        let out = Command::new(bin.join(SCRIPT_NAME))
            .arg("help")
            .env(EXE_VAR, dir.join("gone"))
            .output()
            .unwrap();
        assert_eq!(out.status.code(), Some(3));
        assert!(String::from_utf8_lossy(&out.stderr).contains("Open a new terminal"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
