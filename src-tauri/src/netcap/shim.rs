//! A POSIX `curl` shim first on agents' `PATH` (Windows: via `$CLAUDE_ENV_FILE`, Git Bash only)
//! that, with strict capture on and our proxy set, drops curl's bypass args and `exec`s the real
//! curl. Written to the app config dir (never `~/.claude`); a depth counter stops recursion.

use std::path::{Path, PathBuf};

/// The directory under the netcap dir that is prepended to `PATH`.
pub const BIN_DIR: &str = "bin";

/// The first line after the shebang — how a file is recognised as ours.
pub const SHIM_MARKER: &str = "# agentstudio-curl-shim v1";

/// The script, verbatim. POSIX `sh` only (macOS `/bin/sh` is bash in POSIX mode; Linux is
/// usually dash): no arrays, no `local`, no `[[`.
pub const CURL_SHIM: &str = r#"#!/bin/sh
# agentstudio-curl-shim v1
# Written by Agent Studio (src-tauri/src/netcap/shim.rs) at every start; edits are overwritten.
# Inside an Agent Studio terminal with strict capture on, drops curl's proxy-bypass arguments
# (--noproxy, -x '', NO_PROXY=*) so the request shows in the Network view, then runs the real
# curl. AGENTSTUDIO_PROXY_STRICT=0 turns the rewriting off.
self=$0
last=/usr/bin/curl
for f in /usr/bin/curl /clangarm64/bin/curl /mingw64/bin/curl /ucrt64/bin/curl; do
  if [ -f "$f" ] && [ -x "$f" ]; then last=$f; break; fi
done
depth=${AGENTSTUDIO_CURL_SHIM_DEPTH:-0}
case $depth in ''|*[!0-9]*) depth=0 ;; esac
if [ "$depth" -ge 4 ]; then exec "$last" "$@"; fi
AGENTSTUDIO_CURL_SHIM_DEPTH=$((depth + 1))
export AGENTSTUDIO_CURL_SHIM_DEPTH

ours=0
if [ "${AGENTSTUDIO_PROXY_STRICT:-1}" != 0 ] && [ -n "${AGENTSTUDIO_PROXY_URL:-}" ]; then
  for v in "${HTTP_PROXY:-}" "${HTTPS_PROXY:-}" "${http_proxy:-}" "${https_proxy:-}"; do
    if [ "$v" = "$AGENTSTUDIO_PROXY_URL" ]; then ours=1; fi
  done
fi

if [ "$ours" = 1 ]; then
  n=$#
  rest=0
  while [ "$n" -gt 0 ]; do
    a=$1
    shift
    n=$((n - 1))
    if [ "$rest" = 1 ]; then
      set -- "$@" "$a"
      continue
    fi
    case $a in
      --)
        rest=1
        set -- "$@" "$a"
        ;;
      --noproxy|-x|--proxy)
        if [ "$n" -gt 0 ]; then
          v=$1
          shift
          n=$((n - 1))
          case $a in
            --noproxy) if [ -z "$v" ]; then set -- "$@" "$a" "$v"; fi ;;
            *) if [ -n "$v" ]; then set -- "$@" "$a" "$v"; fi ;;
          esac
        else
          set -- "$@" "$a"
        fi
        ;;
      --noproxy=) set -- "$@" "$a" ;;
      --noproxy=*|--proxy=) ;;
      *) set -- "$@" "$a" ;;
    esac
  done
  if [ "${NO_PROXY-}" = '*' ]; then NO_PROXY=${AGENTSTUDIO_NO_PROXY-}; export NO_PROXY; fi
  if [ "${no_proxy-}" = '*' ]; then no_proxy=${AGENTSTUDIO_NO_PROXY-}; export no_proxy; fi
fi

real=
first=
seen=0
saved_ifs=$IFS
IFS=:
set -f
for d in $PATH; do
  if [ -z "$d" ]; then continue; fi
  c=$d/curl
  if [ "$c" -ef "$self" ]; then seen=1; continue; fi
  if [ -f "$c" ] && [ -x "$c" ]; then
    if [ -z "$first" ]; then first=$c; fi
    if [ "$seen" = 1 ]; then real=$c; break; fi
  fi
done
set +f
IFS=$saved_ifs
if [ -z "$real" ]; then real=$first; fi
if [ -z "$real" ]; then real=$last; fi
exec "$real" "$@"
"#;

/// Write `<netcap dir>/bin/curl` (0755) atomically when missing or different; returns `bin`.
/// On Windows it serves Git Bash only. `None` on I/O error: capture works, bypass-proofing is lost.
pub fn ensure(netcap_dir: &Path) -> Option<PathBuf> {
    match write(netcap_dir) {
        Ok(dir) => Some(dir),
        Err(e) => {
            eprintln!("netcap: curl shim not written: {e}");
            None
        }
    }
}

fn write(netcap_dir: &Path) -> std::io::Result<PathBuf> {
    let dir = netcap_dir.join(BIN_DIR);
    std::fs::create_dir_all(&dir)?;
    let path = dir.join("curl");
    let current = std::fs::read(&path).ok();
    if current.as_deref() != Some(CURL_SHIM.as_bytes()) {
        let tmp = dir.join(format!(".curl.{}.tmp", ulid::Ulid::new()));
        std::fs::write(&tmp, CURL_SHIM)?;
        set_executable(&tmp)?;
        std::fs::rename(&tmp, &path)?;
    } else {
        // Content is right; make sure the mode is too (a copied profile can lose +x).
        set_executable(&path)?;
    }
    Ok(dir)
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

/// `shim_dir` first, then `base` with every other occurrence of `shim_dir` removed (an IDE
/// started from an IDE terminal inherits it) — the rest keeps its order. An empty `base`
/// (a GUI launch with no `PATH`) gets the POSIX default after the shim.
pub fn prepend_path(shim_dir: &Path, base: Option<&str>) -> String {
    let shim = shim_dir.to_string_lossy();
    let base = base
        .filter(|b| !b.is_empty())
        .unwrap_or("/usr/bin:/bin:/usr/sbin:/sbin");
    let mut out = vec![shim.as_ref()];
    out.extend(base.split(':').filter(|e| *e != shim.as_ref()));
    out.join(":")
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::io::Write as _;
    use std::process::{Command, Stdio};

    /// Real shim in `<root>/ide bin/bin/curl` (a space, like `Application Support`) plus a fake
    /// curl printing its argv, the proxy-bypass env and stdin, exiting with `$FAKE_EXIT`.
    struct Rig {
        root: PathBuf,
        shim_dir: PathBuf,
        real_dir: PathBuf,
    }

    const FAKE_CURL: &str = r#"#!/bin/sh
for a in "$@"; do printf '[%s]\n' "$a"; done
printf 'NO_PROXY=[%s] no_proxy=[%s]\n' "${NO_PROXY-unset}" "${no_proxy-unset}"
printf 'depth=[%s]\n' "${AGENTSTUDIO_CURL_SHIM_DEPTH-}"
if [ -n "${FAKE_STDIN:-}" ]; then printf 'stdin=['; cat; printf ']\n'; fi
exit "${FAKE_EXIT:-0}"
"#;

    impl Rig {
        fn new() -> Rig {
            let root = std::env::temp_dir().join(format!("curl-shim-{}", ulid::Ulid::new()));
            let shim_dir = ensure(&root.join("ide bin")).expect("shim written");
            let real_dir = root.join("real");
            std::fs::create_dir_all(&real_dir).unwrap();
            let fake = real_dir.join("curl");
            std::fs::write(&fake, FAKE_CURL).unwrap();
            set_executable(&fake).unwrap();
            Rig {
                root,
                shim_dir,
                real_dir,
            }
        }

        fn path(&self) -> String {
            format!(
                "{}:{}:/usr/bin:/bin",
                self.shim_dir.display(),
                self.real_dir.display()
            )
        }

        /// Run `curl <args>` through `PATH` lookup (the shim is found, as in a terminal), with
        /// a scrubbed env: `PATH`, our capture vars, and `extra`.
        fn run(&self, args: &[&str], extra: &[(&str, &str)], stdin: &[u8]) -> (String, i32) {
            let url = "http://t-term:x@127.0.0.1:4711";
            let mut c = Command::new("/bin/sh");
            c.arg("-c")
                .arg("exec curl \"$@\"")
                .arg("sh")
                .args(args)
                .env_clear()
                .env("PATH", self.path())
                .env("HTTP_PROXY", url)
                .env("HTTPS_PROXY", url)
                .env("AGENTSTUDIO_PROXY_URL", url)
                .env("AGENTSTUDIO_NO_PROXY", "corp.internal")
                .env("AGENTSTUDIO_PROXY_STRICT", "1");
            for (k, v) in extra {
                c.env(k, v);
            }
            let mut child = c
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            child.stdin.take().unwrap().write_all(stdin).unwrap();
            let out = child.wait_with_output().unwrap();
            (
                String::from_utf8(out.stdout).unwrap(),
                out.status.code().unwrap_or(-1),
            )
        }
    }

    impl Drop for Rig {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    /// The argv lines the fake curl printed, `[arg]` → `arg` (multi-line args re-joined).
    fn argv(out: &str) -> Vec<String> {
        let body = out.split("NO_PROXY=[").next().unwrap();
        let mut args = Vec::new();
        let mut cur: Option<String> = None;
        for line in body.split_inclusive('\n') {
            let line = line.strip_suffix('\n').unwrap_or(line);
            match cur.as_mut() {
                None => {
                    let l = line.strip_prefix('[').expect("argv line");
                    match l.strip_suffix(']') {
                        Some(done) => args.push(done.to_string()),
                        None => cur = Some(format!("{l}\n")),
                    }
                }
                Some(acc) => match line.strip_suffix(']') {
                    Some(end) => {
                        acc.push_str(end);
                        args.push(cur.take().unwrap());
                    }
                    None => {
                        acc.push_str(line);
                        acc.push('\n');
                    }
                },
            }
        }
        args
    }

    #[test]
    fn a_real_command_loses_its_noproxy_and_keeps_everything_else() {
        let rig = Rig::new();
        let (out, code) = rig.run(
            &[
                "-s",
                "--noproxy",
                "*",
                "http://127.0.0.1:3000/api/v1/health",
            ],
            &[],
            b"",
        );
        assert_eq!(code, 0);
        assert_eq!(argv(&out), ["-s", "http://127.0.0.1:3000/api/v1/health"]);
    }

    #[test]
    fn every_bypass_spelling_is_dropped() {
        let rig = Rig::new();
        let (out, _) = rig.run(
            &[
                "--noproxy=*",
                "-x",
                "",
                "--proxy",
                "",
                "--proxy=",
                "--noproxy",
                "localhost,127.0.0.1",
                "http://h/",
            ],
            &[],
            b"",
        );
        assert_eq!(argv(&out), ["http://h/"]);
    }

    #[test]
    fn pro_capture_arguments_and_real_proxies_are_kept() {
        let rig = Rig::new();
        // `--noproxy ''` = bypass nothing; `-x <url>` = an explicit proxy (the e2e rig uses
        // both). Neither is a bypass.
        let args = [
            "--noproxy",
            "",
            "-x",
            "http://127.0.0.1:9/",
            "--noproxy=",
            "http://h/",
        ];
        let (out, _) = rig.run(&args, &[], b"");
        assert_eq!(argv(&out), args);
    }

    #[test]
    fn arguments_pass_byte_exact_spaces_quotes_newlines_globs() {
        let rig = Rig::new();
        let args = [
            "-H",
            "X-Note: it's \"quoted\" & spaced  twice",
            "-d",
            "line one\nline two\n",
            "*",
            "$HOME",
            "",
            "-",
            "http://127.0.0.1:1/a b?q=1&r=2",
        ];
        let (out, _) = rig.run(&args, &[], b"");
        assert_eq!(argv(&out), args);
    }

    #[test]
    fn everything_after_double_dash_is_untouched() {
        let rig = Rig::new();
        let (out, _) = rig.run(&["--noproxy", "*", "--", "--noproxy", "*"], &[], b"");
        assert_eq!(argv(&out), ["--", "--noproxy", "*"]);
    }

    #[test]
    fn an_inherited_star_no_proxy_is_reset_to_the_ides_value() {
        let rig = Rig::new();
        let (out, _) = rig.run(&["http://h/"], &[("NO_PROXY", "*"), ("no_proxy", "*")], b"");
        assert!(
            out.contains("NO_PROXY=[corp.internal] no_proxy=[corp.internal]"),
            "{out}"
        );
        // A real list is the user's business — not rewritten.
        let (out, _) = rig.run(&["http://h/"], &[("NO_PROXY", "corp.internal,.svc")], b"");
        assert!(out.contains("NO_PROXY=[corp.internal,.svc]"), "{out}");
    }

    #[test]
    fn strict_off_or_a_foreign_proxy_leaves_the_command_alone() {
        let rig = Rig::new();
        let args = ["--noproxy", "*", "-x", "", "http://h/"];
        let (out, _) = rig.run(&args, &[("AGENTSTUDIO_PROXY_STRICT", "0")], b"");
        assert_eq!(argv(&out), args, "strict off");
        let (out, _) = rig.run(
            &args,
            &[
                ("HTTP_PROXY", "http://corp:3128"),
                ("HTTPS_PROXY", "http://corp:3128"),
            ],
            b"",
        );
        assert_eq!(argv(&out), args, "the user's own proxy");
        let (out, _) = rig.run(&args, &[("NO_PROXY", "*")], b"");
        assert!(!out.contains("NO_PROXY=[*]"), "strict on resets it: {out}");
    }

    #[test]
    fn exit_code_and_stdin_are_the_real_curls() {
        let rig = Rig::new();
        let (out, code) = rig.run(
            &["--data-binary", "@-", "http://h/"],
            &[("FAKE_EXIT", "7"), ("FAKE_STDIN", "1")],
            b"payload\nwith lines",
        );
        assert_eq!(code, 7, "{out}");
        assert!(out.contains("stdin=[payload\nwith lines]"), "{out}");
    }

    #[test]
    fn the_shim_never_runs_itself() {
        let rig = Rig::new();
        // The shim dir twice, the second time spelled differently (`/./`): both are skipped
        // and the fake curl after them runs, exactly once (depth 1).
        let twice = format!(
            "{}:{}/.:{}:/usr/bin",
            rig.shim_dir.display(),
            rig.shim_dir.display(),
            rig.real_dir.display()
        );
        let (out, code) = rig.run(&["http://h/"], &[("PATH", &twice)], b"");
        assert_eq!(code, 0, "{out}");
        assert!(out.contains("depth=[1]"), "{out}");
        assert_eq!(argv(&out), ["http://h/"]);
    }

    #[test]
    fn a_chain_of_shims_ends_at_a_real_curl() {
        let rig = Rig::new();
        // A second IDE's shim dir ahead of ours: the chain walks forward and ends at the fake.
        let other = ensure(&rig.root.join("other ide")).unwrap();
        let path = format!(
            "{}:{}:{}:/usr/bin",
            other.display(),
            rig.shim_dir.display(),
            rig.real_dir.display()
        );
        let (out, code) = rig.run(&["--noproxy", "*", "http://h/"], &[("PATH", &path)], b"");
        assert_eq!(code, 0, "{out}");
        assert!(out.contains("depth=[2]"), "{out}");
        assert_eq!(argv(&out), ["http://h/"]);
        // A runaway depth goes straight to /usr/bin/curl (whatever it prints, it is not the
        // fake — which would print our argv).
        let (out, _) = rig.run(&["--version"], &[("AGENTSTUDIO_CURL_SHIM_DEPTH", "9")], b"");
        assert!(!out.contains("[--version]"), "{out}");
    }

    #[test]
    fn ensure_is_idempotent_and_executable() {
        use std::os::unix::fs::PermissionsExt as _;
        let root = std::env::temp_dir().join(format!("curl-shim-ens-{}", ulid::Ulid::new()));
        let dir = ensure(&root).unwrap();
        let p = dir.join("curl");
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(ensure(&root).unwrap(), dir);
        let meta = std::fs::metadata(&p).unwrap();
        assert_eq!(meta.permissions().mode() & 0o777, 0o755);
        assert_eq!(std::fs::read_to_string(&p).unwrap(), CURL_SHIM);
        std::fs::write(&p, "#!/bin/sh\necho tampered\n").unwrap();
        ensure(&root).unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), CURL_SHIM);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn prepend_path_puts_the_shim_first_once_and_keeps_the_rest_in_order() {
        let shim = Path::new("/a b/bin");
        assert_eq!(
            prepend_path(shim, Some("/x:/a b/bin:/usr/bin:/a b/bin")),
            "/a b/bin:/x:/usr/bin"
        );
        assert_eq!(
            prepend_path(shim, None),
            "/a b/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        );
    }
}

/// The same script under the POSIX shell agents really have on Windows: Git Bash, the way
/// Claude Code runs it (`<Git>\bin\bash.exe`, which puts its own `/clangarm64/bin` or
/// `/mingw64/bin` first). Skipped with the reason printed when Git for Windows is absent.
#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;
    use crate::spawn::NoWindow as _;
    use std::process::Command;

    const FAKE_CURL: &str = "#!/bin/sh\nfor a in \"$@\"; do printf '[%s]\\n' \"$a\"; done\n\
printf 'depth=[%s]\\n' \"${AGENTSTUDIO_CURL_SHIM_DEPTH-}\"\n";

    /// Git Bash as Claude Code finds it (`CLAUDE_CODE_GIT_BASH_PATH`, else the stock install).
    fn git_bash() -> Option<PathBuf> {
        let found = [
            std::env::var_os("CLAUDE_CODE_GIT_BASH_PATH").map(PathBuf::from),
            std::env::var_os("ProgramFiles")
                .map(|p| PathBuf::from(p).join("Git").join("bin").join("bash.exe")),
        ]
        .into_iter()
        .flatten()
        .find(|p| p.is_file());
        if found.is_none() {
            eprintln!("SKIP: Git for Windows (bin\\bash.exe) is not installed");
        }
        found
    }

    struct Rig {
        root: PathBuf,
        shim_dir: PathBuf,
        real_dir: PathBuf,
        bash: PathBuf,
    }

    impl Rig {
        fn new() -> Option<Rig> {
            let bash = git_bash()?;
            let root = std::env::temp_dir().join(format!("curl-shim-w-{}", ulid::Ulid::new()));
            let shim_dir = ensure(&root.join("ide bin")).expect("the shim is written on Windows");
            let real_dir = root.join("real");
            std::fs::create_dir_all(&real_dir).unwrap();
            std::fs::write(real_dir.join("curl"), FAKE_CURL).unwrap();
            Some(Rig {
                root,
                shim_dir,
                real_dir,
                bash,
            })
        }

        /// `script` in Git Bash with `S` / `R` = the shim and fake-curl dirs as Windows paths
        /// (bash converts them with `cygpath`, as the env-file line does) and our capture vars.
        fn run(&self, script: &str, args: &[&str], extra: &[(&str, &str)]) -> (String, i32) {
            let url = "http://t-term:x@127.0.0.1:4711";
            let mut c = Command::new(&self.bash);
            c.arg("-c")
                .arg(script)
                .arg("sh")
                .args(args)
                .env("S", &self.shim_dir)
                .env("R", &self.real_dir)
                .env("HTTP_PROXY", url)
                .env("AGENTSTUDIO_PROXY_URL", url)
                .env("AGENTSTUDIO_PROXY_STRICT", "1")
                .env_remove("AGENTSTUDIO_CURL_SHIM_DEPTH");
            for (k, v) in extra {
                c.env(k, v);
            }
            let out = c.no_window().output().expect("Git Bash runs");
            (
                String::from_utf8_lossy(&out.stdout).replace('\r', "")
                    + &String::from_utf8_lossy(&out.stderr),
                out.status.code().unwrap_or(-1),
            )
        }
    }

    impl Drop for Rig {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn argv(out: &str) -> Vec<&str> {
        out.lines()
            .take_while(|l| !l.starts_with("depth="))
            .map(|l| l.trim_start_matches('[').trim_end_matches(']'))
            .collect()
    }

    /// Found through `PATH` ahead of the next curl: `--noproxy` is dropped, the rest kept,
    /// and the curl after it runs once.
    #[test]
    fn in_git_bash_the_shim_drops_noproxy_and_runs_the_next_curl() {
        let Some(rig) = Rig::new() else { return };
        let (out, code) = rig.run(
            // The arguments are in the script, as in a real `bash -c`: an MSYS program globs
            // a bare `*` on its own Windows command line.
            r#"PATH="$(cygpath -u "$S"):$(cygpath -u "$R"):$PATH"; command -v curl; exec curl -s --noproxy '*' http://127.0.0.1:3000/health"#,
            &[],
            &[],
        );
        assert_eq!(code, 0, "{out}");
        let (first, rest) = out.split_once('\n').unwrap();
        assert!(
            first.ends_with("/ide bin/bin/curl"),
            "the shim leads: {out}"
        );
        assert_eq!(argv(rest), ["-s", "http://127.0.0.1:3000/health"], "{out}");
        assert!(rest.contains("depth=[1]"), "{out}");
    }

    /// `$0` spelled `C:/…` while `PATH` spells the same dir `/c/…`: `-ef` still knows it is
    /// itself, so the shim never runs itself and the fake after it runs (depth 1).
    #[test]
    fn in_git_bash_another_spelling_of_the_shim_is_still_the_shim() {
        let Some(rig) = Rig::new() else { return };
        let (out, code) = rig.run(
            r#"PATH="$(cygpath -u "$S"):$(cygpath -u "$R"):$PATH"; exec "$(cygpath -m "$S")/curl" '--noproxy=*' http://h/"#,
            &[],
            &[],
        );
        assert_eq!(code, 0, "{out}");
        assert_eq!(argv(&out), ["http://h/"], "{out}");
        assert!(out.contains("depth=[1]"), "{out}");
    }

    /// Nothing named curl after the shim on `PATH`, and `/usr/bin/curl` does not exist in Git
    /// Bash: the fallback is Git's own curl (`/clangarm64/bin`, `/mingw64/bin`), never "not
    /// found". The same for a runaway depth.
    #[test]
    fn in_git_bash_the_fallback_is_gits_own_curl() {
        let Some(rig) = Rig::new() else { return };
        for extra in [&[][..], &[("AGENTSTUDIO_CURL_SHIM_DEPTH", "9")][..]] {
            let (out, code) = rig.run(
                r#"PATH="$(cygpath -u "$S"):/usr/bin"; [ -e /usr/bin/curl ] && echo HAS-USR-BIN-CURL; exec curl "$@""#,
                &["--version"],
                extra,
            );
            assert_eq!(code, 0, "{extra:?}: {out}");
            assert!(!out.contains("HAS-USR-BIN-CURL"), "the premise: {out}");
            assert!(
                out.starts_with("curl "),
                "a real curl ran ({extra:?}): {out}"
            );
            assert!(!out.contains("[--version]"), "{out}");
        }
    }
}
