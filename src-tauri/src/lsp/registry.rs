//! `LanguageId → LspServerSpec` table and binary detection: bring-your-own-server, degrade to
//! the row's install hint (`code-intelligence.md` §3); `lsp/languages.ts` mirrors the set. For
//! rustup-managed servers ask `rustup which` first: the PATH binary is often a rustup proxy.

use crate::spawn::NoWindow as _;
use std::path::{Path, PathBuf};

/// How to launch + detect the server for one language.
pub struct LspServerSpec {
    /// The binary name to resolve on PATH (e.g. `rust-analyzer`).
    pub command: &'static str,
    /// Args after the binary (e.g. `--stdio` for stdio-mode servers).
    pub args: &'static [&'static str],
    /// Shown when the server is absent — the exact install command.
    pub install_hint: &'static str,
    /// Files that mark a project root. Unread by the relay itself (the JS client
    /// picks `rootUri`), but the table is the single home for per-language facts, and
    /// later slices / root inference will use it.
    #[allow(dead_code)]
    pub root_markers: &'static [&'static str],
    /// Human-facing server name for the UI.
    pub server_name: &'static str,
    /// For a rustup-managed server (rust-analyzer): the component to probe via
    /// `rustup which`, dodging the PATH shim. `None` for everything else.
    pub rustup_component: Option<&'static str>,
}

/// The spec for a canonical `LanguageId` (`src/lib/language/ids.ts`), or `None` for
/// an unmapped language (feature simply off, no install hint). The install hint is this
/// OS's ([`spec_for_os`]).
pub fn spec_for(language_id: &str) -> Option<LspServerSpec> {
    spec_for_os(language_id, cfg!(windows))
}

/// [`spec_for`] for a named OS, so every OS tests both tables. Only the install hint
/// differs: `brew install llvm` is not an answer on Windows (a native route per OS, macOS's
/// text unchanged).
pub fn spec_for_os(language_id: &str, windows: bool) -> Option<LspServerSpec> {
    let mut spec = spec_unix(language_id)?;
    if windows {
        if let Some(hint) = windows_install_hint(language_id) {
            spec.install_hint = hint;
        }
    }
    Some(spec)
}

/// The Windows install hint where the macOS/Linux one does not apply. `None`: the same
/// command works on both (rustup, npm, go).
fn windows_install_hint(language_id: &str) -> Option<&'static str> {
    Some(match language_id {
        "c" | "cpp" | "objective-c" | "objective-cpp" => "winget install LLVM.LLVM",
        // Neither server has a winget package; both publish a zip whose `bin` holds the
        // Windows launcher (`jdtls.bat` / `kotlin-language-server.bat`).
        "java" => {
            "download jdtls from https://download.eclipse.org/jdtls/milestones/ and add its \
             bin folder to PATH  (needs JDK 17+)"
        }
        "kotlin" => {
            "download kotlin-language-server from \
             https://github.com/fwcd/kotlin-language-server/releases and add its bin folder \
             to PATH"
        }
        _ => return None,
    })
}

/// The macOS/Linux table (the original one, unchanged).
fn spec_unix(language_id: &str) -> Option<LspServerSpec> {
    Some(match language_id {
        "rust" => LspServerSpec {
            command: "rust-analyzer",
            args: &[],
            install_hint: "rustup component add rust-analyzer",
            root_markers: &["Cargo.toml"],
            server_name: "rust-analyzer",
            rustup_component: Some("rust-analyzer"),
        },
        // ── Data-only rows (`code-intelligence.md` §3). ──
        "typescript" | "typescriptreact" | "javascript" | "javascriptreact" => LspServerSpec {
            command: "typescript-language-server",
            args: &["--stdio"],
            install_hint: "npm i -g typescript-language-server typescript",
            root_markers: &["package.json", "tsconfig.json"],
            server_name: "typescript-language-server",
            rustup_component: None,
        },
        "python" => LspServerSpec {
            command: "pyright-langserver",
            args: &["--stdio"],
            install_hint: "npm i -g pyright",
            root_markers: &["pyproject.toml", "setup.py"],
            server_name: "pyright",
            rustup_component: None,
        },
        "go" => LspServerSpec {
            command: "gopls",
            args: &[],
            install_hint: "go install golang.org/x/tools/gopls@latest",
            root_markers: &["go.mod"],
            server_name: "gopls",
            rustup_component: None,
        },
        "c" | "cpp" | "objective-c" | "objective-cpp" => LspServerSpec {
            command: "clangd",
            args: &[],
            install_hint: "brew install llvm  (or: apt install clangd)",
            root_markers: &["compile_commands.json", "compile_flags.txt", ".clangd"],
            server_name: "clangd",
            rustup_component: None,
        },
        // ── JVM family ──
        // `jdtls` speaks stdio LSP and manages its own workspace dir, so navigation needs
        // no args or init options; Lombok/Spring-Boot intelligence needs extra setup.
        "java" => LspServerSpec {
            command: "jdtls",
            args: &[],
            install_hint: "brew install jdtls  (needs JDK 17+)",
            root_markers: &[
                "pom.xml",
                "build.gradle",
                "build.gradle.kts",
                "settings.gradle",
                ".project",
            ],
            server_name: "jdtls",
            rustup_component: None,
        },
        "kotlin" => LspServerSpec {
            command: "kotlin-language-server",
            args: &[],
            install_hint: "brew install kotlin-language-server",
            root_markers: &[
                "build.gradle.kts",
                "build.gradle",
                "settings.gradle.kts",
                "pom.xml",
            ],
            server_name: "kotlin-language-server",
            rustup_component: None,
        },
        _ => return None,
    })
}

/// The outcome of resolving a server binary.
#[derive(Debug, PartialEq, Eq)]
pub enum Detection {
    /// The real, runnable binary.
    Found(PathBuf),
    /// No binary anywhere — the feature is simply off (calm install hint upstream).
    NotInstalled,
}

/// The environment probes detection needs, abstracted so it is unit-testable with a
/// stub (no rustup, no PATH, no filesystem).
pub trait Prober: Send + Sync {
    /// `rustup which <component>` → the real toolchain binary, if rustup knows it.
    fn rustup_which(&self, component: &str) -> Option<PathBuf>;
    /// Resolve `command` on PATH + known install dirs.
    fn which(&self, command: &str) -> Option<PathBuf>;
    /// Is `path` one of rustup's proxies (`~/.cargo/bin/rust-analyzer` → `rustup`)? The
    /// real check is [`is_rustup_proxy`]; stubs default to "no".
    fn is_rustup_proxy(&self, _path: &Path) -> bool {
        false
    }
}

/// Resolve `spec`'s binary: the rustup toolchain binary for a rustup-managed server, else PATH
/// or known dirs, else [`Detection::NotInstalled`]. A PATH hit that is rustup's proxy is not a
/// server (it exits 1), so the install hint stays reachable.
pub fn detect_with<P: Prober + ?Sized>(spec: &LspServerSpec, prober: &P) -> Detection {
    if let Some(component) = spec.rustup_component {
        if let Some(path) = prober.rustup_which(component) {
            return Detection::Found(path);
        }
    }
    match prober.which(spec.command) {
        Some(path) if spec.rustup_component.is_some() && prober.is_rustup_proxy(&path) => {
            Detection::NotInstalled
        }
        Some(path) => Detection::Found(path),
        None => Detection::NotInstalled,
    }
}

/// A rustup proxy is a link to (or copy of; hard link on Windows) the `rustup` beside it: same
/// file or same size. A real rust-analyzer is a different program of a different size.
pub fn is_rustup_proxy(candidate: &Path) -> bool {
    let Some(dir) = candidate.parent() else {
        return false;
    };
    let rustup = dir.join(exe_name("rustup"));
    if rustup == candidate {
        return false;
    }
    let (Ok(c), Ok(r)) = (std::fs::metadata(candidate), std::fs::metadata(&rustup)) else {
        return false;
    };
    if !r.is_file() {
        return false;
    }
    let same_file = matches!(
        (crate::paths::canonicalize(candidate), crate::paths::canonicalize(&rustup)),
        (Ok(a), Ok(b)) if a == b
    );
    same_file || c.len() == r.len()
}

/// The real prober: runs `rustup` and searches the live PATH + known install dirs.
pub struct SystemProber;

/// Home-relative dirs a GUI launch's thin PATH tends to miss, where cargo/npm/go drop server
/// binaries (on Windows home is `%USERPROFILE%`, same defaults).
const KNOWN_INSTALL_DIRS: &[&str] = &[
    ".cargo/bin",
    ".local/bin",
    "go/bin",
    ".npm-global/bin",
    ".deno/bin",
    "bin",
];

/// Absolute dirs to check beyond PATH (macOS / Linux only: on Windows `/usr/bin` is a
/// folder on the current drive).
const KNOWN_ABSOLUTE_DIRS: &[&str] = &["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin"];

/// Windows install dirs a GUI app's PATH can lack, as `(env var, subdir)`: npm's global prefix
/// (on the user PATH only), winget links, scoop shims, and LLVM (not on PATH by default).
const WINDOWS_ENV_DIRS: &[(&str, &str)] = &[
    ("APPDATA", "npm"),
    ("LOCALAPPDATA", "Microsoft/WinGet/Links"),
    ("USERPROFILE", "scoop/shims"),
    ("ProgramFiles", "LLVM/bin"),
];

/// Every dir searched after `PATH`, in order. `env` reads a variable (a parameter, so
/// every OS tests both lists).
pub fn known_dirs(
    windows: bool,
    home: Option<&Path>,
    env: impl Fn(&str) -> Option<std::ffi::OsString>,
) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = home
        .map(|h| KNOWN_INSTALL_DIRS.iter().map(|rel| h.join(rel)).collect())
        .unwrap_or_default();
    if windows {
        // `%SCOOP%` relocates scoop; its shims are then there instead.
        if let Some(scoop) = env("SCOOP") {
            dirs.push(PathBuf::from(scoop).join("shims"));
        }
        for (var, rel) in WINDOWS_ENV_DIRS {
            if let Some(base) = env(var) {
                dirs.push(PathBuf::from(base).join(rel));
            }
        }
    } else {
        dirs.extend(KNOWN_ABSOLUTE_DIRS.iter().map(PathBuf::from));
    }
    dirs
}

impl Prober for SystemProber {
    fn rustup_which(&self, component: &str) -> Option<PathBuf> {
        // `rustup which <component>` prints the real toolchain binary path — the one
        // the ~/.cargo/bin proxy would otherwise shadow with a shim that errors.
        let out = std::process::Command::new("rustup")
            .arg("which")
            .arg(component)
            .no_window()
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        let path = PathBuf::from(String::from_utf8_lossy(&out.stdout).trim());
        is_executable(&path).then_some(path)
    }

    fn is_rustup_proxy(&self, path: &Path) -> bool {
        is_rustup_proxy(path)
    }

    fn which(&self, command: &str) -> Option<PathBuf> {
        let windows = cfg!(windows);
        let names = file_names(command, windows);
        // Absolute entries only: a relative one would resolve against the app's cwd.
        let on_path: Vec<PathBuf> = std::env::var_os("PATH")
            .map(|p| crate::agent::claude::absolute_path_dirs(&p))
            .unwrap_or_default();
        // PATH first, as before; then the install dirs a GUI launch's PATH misses.
        find_in_dirs(&on_path, &names).or_else(|| {
            let home = crate::agent::claude::home_dir();
            let known = known_dirs(windows, home.as_deref(), |v| std::env::var_os(v));
            find_in_dirs(&known, &names)
        })
    }
}

/// The first of `names` found in any of `dirs` — every dir is searched for the first name
/// before any is searched for the second, so on Windows a native `.exe` anywhere beats an npm
/// `.cmd` shim (which needs `node` and a shim to read), and both beat a `.bat`.
pub fn find_in_dirs(dirs: &[PathBuf], names: &[String]) -> Option<PathBuf> {
    names.iter().find_map(|name| {
        dirs.iter()
            .map(|dir| dir.join(name))
            .find(|candidate| is_executable(candidate))
    })
}

/// File names a server `command` may have, in preference order. Windows: `.exe`, then npm's
/// `.cmd` shim (npm installs only `.cmd` + `.ps1`), then a `.bat` launcher. Elsewhere bare.
pub fn file_names(command: &str, windows: bool) -> Vec<String> {
    if windows {
        vec![
            format!("{command}.exe"),
            format!("{command}.cmd"),
            format!("{command}.bat"),
        ]
    } else {
        vec![command.to_string()]
    }
}

/// The binary file name on this OS (`rustup` → `rustup.exe` on Windows).
fn exe_name(command: &str) -> String {
    if cfg!(windows) {
        format!("{command}.exe")
    } else {
        command.to_string()
    }
}

/// How to start a detected server: the program `CreateProcess`/`execve` runs and its whole
/// argv after it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Launch {
    pub program: PathBuf,
    pub args: Vec<String>,
}

/// Characters cmd.exe interprets in a command line even inside quotes or outside them —
/// the reason no user text may ever reach a batch file.
const CMD_META: &[char] = &['%', '!', '^', '&', '|', '<', '>', '"', '\r', '\n'];

/// A detected binary → [`Launch`]. On Windows an npm-style `.cmd` shim is unwrapped
/// ([`crate::winshim::unwrap_npm_shim`]) so stop kills the real server. Other `.bat`/`.cmd` run
/// via cmd.exe: safe only because the fixed args and path are refused if they hold metachars.
pub fn launch_for(
    bin: &Path,
    args: &[&str],
    windows: bool,
    node: impl FnOnce() -> Option<PathBuf>,
) -> Result<Launch, String> {
    let args_owned = || args.iter().map(|a| a.to_string()).collect::<Vec<_>>();
    if !windows || !crate::winshim::is_batch(bin) {
        return Ok(Launch {
            program: bin.to_path_buf(),
            args: args_owned(),
        });
    }
    use crate::winshim::UnwrapError;
    match crate::winshim::unwrap_npm_shim(bin, None, node) {
        Ok(u) => Ok(Launch {
            program: u.program,
            args: u.prefix.into_iter().chain(args_owned()).collect(),
        }),
        Err(UnwrapError::NoNode) => Err(format!(
            "`{}` runs with Node.js, and `node.exe` was not found",
            bin.display()
        )),
        Err(UnwrapError::Read(e)) => Err(format!("could not read `{}`: {e}", bin.display())),
        Err(UnwrapError::NotAShim) => {
            let path = bin.to_string_lossy();
            if let Some(bad) = std::iter::once(path.as_ref())
                .chain(args.iter().copied())
                .find(|s| s.contains(CMD_META))
            {
                return Err(format!(
                    "`{}` is a batch file, and `{bad}` holds a character cmd.exe would \
                     interpret — refusing to run it",
                    bin.display()
                ));
            }
            Ok(Launch {
                program: bin.to_path_buf(),
                args: args_owned(),
            })
        }
    }
}

/// Is `path` an existing, executable regular file?
fn is_executable(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rust_resolves_to_rust_analyzer_with_a_rustup_component() {
        let spec = spec_for("rust").expect("rust must be mapped");
        assert_eq!(spec.command, "rust-analyzer");
        assert_eq!(spec.rustup_component, Some("rust-analyzer"));
        assert_eq!(spec.install_hint, "rustup component add rust-analyzer");
        assert_eq!(spec.root_markers, &["Cargo.toml"]);
    }

    #[test]
    fn an_unmapped_language_has_no_spec() {
        assert!(spec_for("cobol").is_none());
        assert!(spec_for("").is_none());
        // A couple of data rows exist so the table is not rust-only by accident.
        assert!(spec_for("go").is_some());
        assert!(spec_for("typescript").is_some());
    }

    #[test]
    fn the_c_family_shares_clangd_and_needs_no_rustup() {
        for lang in ["c", "cpp", "objective-c", "objective-cpp"] {
            let spec = spec_for(lang).unwrap_or_else(|| panic!("{lang} must map to clangd"));
            assert_eq!(spec.command, "clangd", "{lang}");
            assert_eq!(spec.rustup_component, None, "{lang}");
            assert_eq!(spec.server_name, "clangd", "{lang}");
        }
    }

    #[test]
    fn java_and_kotlin_map_to_their_jvm_servers_with_no_rustup() {
        // Java → the Eclipse JDT LS `jdtls` launcher (stdio, no flag, no rustup).
        let java = spec_for("java").expect("java must map to jdtls");
        assert_eq!(java.command, "jdtls");
        assert!(java.args.is_empty(), "jdtls speaks stdio by default");
        assert_eq!(java.server_name, "jdtls");
        assert_eq!(java.rustup_component, None);
        assert!(java.root_markers.contains(&"pom.xml"), "Maven root marker");
        assert!(
            java.root_markers.contains(&"build.gradle"),
            "Gradle root marker"
        );

        // Kotlin → kotlin-language-server (stdio, no flag, no rustup).
        let kotlin = spec_for("kotlin").expect("kotlin must map to kotlin-language-server");
        assert_eq!(kotlin.command, "kotlin-language-server");
        assert!(kotlin.args.is_empty());
        assert_eq!(kotlin.server_name, "kotlin-language-server");
        assert_eq!(kotlin.rustup_component, None);
        assert!(kotlin.root_markers.contains(&"build.gradle.kts"));
    }

    #[test]
    fn stdio_servers_pass_the_stdio_flag_and_others_do_not() {
        // typescript-language-server + pyright speak stdio only with `--stdio`.
        assert_eq!(spec_for("typescript").unwrap().args, &["--stdio"]);
        assert_eq!(spec_for("python").unwrap().args, &["--stdio"]);
        // rust-analyzer / gopls / clangd default to stdio; no flag.
        assert!(spec_for("rust").unwrap().args.is_empty());
        assert!(spec_for("go").unwrap().args.is_empty());
        assert!(spec_for("c").unwrap().args.is_empty());
    }

    /// A stub prober whose two probes are independently configurable; also records
    /// whether `rustup_which` was consulted (a `Mutex` since `Prober: Sync`).
    struct Stub {
        rustup: Option<PathBuf>,
        which: Option<PathBuf>,
        proxy: bool,
        rustup_called: std::sync::Mutex<bool>,
    }
    impl Prober for Stub {
        fn rustup_which(&self, _component: &str) -> Option<PathBuf> {
            *self.rustup_called.lock().unwrap() = true;
            self.rustup.clone()
        }
        fn which(&self, _command: &str) -> Option<PathBuf> {
            self.which.clone()
        }
        fn is_rustup_proxy(&self, _path: &Path) -> bool {
            self.proxy
        }
    }
    fn stub(rustup: Option<&str>, which: Option<&str>) -> Stub {
        Stub {
            rustup: rustup.map(PathBuf::from),
            which: which.map(PathBuf::from),
            proxy: false,
            rustup_called: std::sync::Mutex::new(false),
        }
    }

    /// Windows: rustup lacks the component and PATH holds its proxy → not installed. Two-sided:
    /// a non-proxy PATH hit is still found; a non-rustup server is never judged a proxy.
    #[test]
    fn a_rustup_proxy_on_path_is_not_an_installed_rust_analyzer() {
        let rust = spec_for("rust").unwrap();
        let proxy = Stub {
            proxy: true,
            ..stub(None, Some("/home/u/.cargo/bin/rust-analyzer"))
        };
        assert_eq!(detect_with(&rust, &proxy), Detection::NotInstalled);

        let real = stub(None, Some("/home/u/.cargo/bin/rust-analyzer"));
        assert_eq!(
            detect_with(&rust, &real),
            Detection::Found(PathBuf::from("/home/u/.cargo/bin/rust-analyzer"))
        );

        let go = spec_for("go").unwrap();
        let gopls = Stub {
            proxy: true,
            ..stub(None, Some("/home/u/go/bin/gopls"))
        };
        assert_eq!(
            detect_with(&go, &gopls),
            Detection::Found(PathBuf::from("/home/u/go/bin/gopls")),
            "only a rustup-managed server is checked for the proxy"
        );
    }

    /// [`is_rustup_proxy`] on real files: a copy of `rustup` beside it is a proxy; a
    /// different binary beside `rustup`, a binary with no `rustup` beside it, and `rustup`
    /// itself are not.
    #[test]
    fn a_rustup_proxy_is_a_same_size_twin_of_the_rustup_beside_it() {
        let dir = std::env::temp_dir().join(format!("lsp-proxy-{}", ulid::Ulid::new()));
        let lone = dir.join("lone");
        std::fs::create_dir_all(&lone).unwrap();
        let rustup_bytes = b"rustup multiplexer binary".as_slice();
        std::fs::write(dir.join(exe_name("rustup")), rustup_bytes).unwrap();
        std::fs::write(dir.join(exe_name("rust-analyzer")), rustup_bytes).unwrap();
        std::fs::write(dir.join(exe_name("gopls")), b"a different, real server").unwrap();
        std::fs::write(lone.join(exe_name("rust-analyzer")), rustup_bytes).unwrap();

        assert!(is_rustup_proxy(&dir.join(exe_name("rust-analyzer"))));
        assert!(!is_rustup_proxy(&dir.join(exe_name("gopls"))));
        assert!(
            !is_rustup_proxy(&lone.join(exe_name("rust-analyzer"))),
            "no rustup beside it"
        );
        assert!(!is_rustup_proxy(&dir.join(exe_name("rustup"))));
        assert!(!is_rustup_proxy(&dir.join(exe_name("missing"))));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn detection_prefers_the_rustup_toolchain_binary() {
        let spec = spec_for("rust").unwrap();
        let p = stub(
            Some("/toolchain/bin/rust-analyzer"),
            Some("/cargo/bin/shim"),
        );
        assert_eq!(
            detect_with(&spec, &p),
            Detection::Found(PathBuf::from("/toolchain/bin/rust-analyzer")),
            "rustup which must win over the PATH shim"
        );
    }

    #[test]
    fn detection_falls_back_to_path_when_rustup_is_absent() {
        let spec = spec_for("rust").unwrap();
        let p = stub(None, Some("/usr/local/bin/rust-analyzer"));
        assert_eq!(
            detect_with(&spec, &p),
            Detection::Found(PathBuf::from("/usr/local/bin/rust-analyzer")),
        );
    }

    #[test]
    fn detection_reports_not_installed_when_nothing_resolves() {
        let spec = spec_for("rust").unwrap();
        assert_eq!(
            detect_with(&spec, &stub(None, None)),
            Detection::NotInstalled
        );
    }

    // ── Windows: install hints, file names, install dirs, batch launchers ──

    /// `brew install llvm` was the clangd hint on Windows too. Every hint that names a
    /// macOS/Linux package manager has a Windows twin; the macOS table is unchanged; the
    /// cross-platform commands (rustup/npm/go) are the same on both.
    #[test]
    fn install_hints_are_per_os_and_the_macos_ones_are_unchanged() {
        let hint = |lang: &str, windows: bool| spec_for_os(lang, windows).unwrap().install_hint;
        assert_eq!(
            hint("c", false),
            "brew install llvm  (or: apt install clangd)"
        );
        assert_eq!(hint("java", false), "brew install jdtls  (needs JDK 17+)");
        assert_eq!(hint("kotlin", false), "brew install kotlin-language-server");
        assert_eq!(hint("cpp", true), "winget install LLVM.LLVM");
        for lang in [
            "rust",
            "typescript",
            "python",
            "go",
            "c",
            "cpp",
            "objective-c",
            "java",
            "kotlin",
        ] {
            let win = hint(lang, true);
            for unix_only in ["brew ", "apt "] {
                assert!(!win.contains(unix_only), "{lang} on Windows: {win}");
            }
        }
        for lang in ["rust", "typescript", "python", "go"] {
            assert_eq!(hint(lang, true), hint(lang, false), "{lang}");
        }
        assert!(hint("java", true).contains("JDK 17"));
        assert!(spec_for_os("cobol", true).is_none());
    }

    #[test]
    fn windows_tries_exe_then_npm_cmd_then_bat_and_unix_the_bare_name() {
        assert_eq!(
            file_names("pyright-langserver", true),
            vec![
                "pyright-langserver.exe",
                "pyright-langserver.cmd",
                "pyright-langserver.bat"
            ]
        );
        assert_eq!(file_names("gopls", false), vec!["gopls"]);
    }

    /// `%APPDATA%\npm` (and winget / scoop / LLVM) are searched on Windows only; the
    /// macOS/Linux absolute dirs only off Windows; home-relative dirs on both.
    #[test]
    fn the_known_install_dirs_are_per_os() {
        let env = |v: &str| -> Option<std::ffi::OsString> {
            match v {
                "APPDATA" => Some(r"C:\Users\u\AppData\Roaming".into()),
                "LOCALAPPDATA" => Some(r"C:\Users\u\AppData\Local".into()),
                "USERPROFILE" => Some(r"C:\Users\u".into()),
                "ProgramFiles" => Some(r"C:\Program Files".into()),
                _ => None,
            }
        };
        let home = Path::new("/home/u");
        let win = known_dirs(true, Some(home), env);
        let unix = known_dirs(false, Some(home), env);
        let npm = PathBuf::from(r"C:\Users\u\AppData\Roaming").join("npm");
        assert!(win.contains(&npm), "{win:?}");
        assert!(win.contains(&PathBuf::from(r"C:\Program Files").join("LLVM/bin")));
        assert!(win.contains(&PathBuf::from(r"C:\Users\u").join("scoop/shims")));
        assert!(win.contains(&home.join(".cargo/bin")) && win.contains(&home.join("go/bin")));
        assert!(!win.contains(&PathBuf::from("/usr/local/bin")));
        assert!(unix.contains(&PathBuf::from("/opt/homebrew/bin")));
        assert!(!unix.contains(&npm));
        // `%SCOOP%` adds its own shims; an unset variable adds nothing.
        let scoop = known_dirs(true, None, |v| {
            (v == "SCOOP").then(|| std::ffi::OsString::from(r"D:\scoop"))
        });
        assert_eq!(scoop, vec![PathBuf::from(r"D:\scoop").join("shims")]);
    }

    /// Real files in temp dirs: an `.exe` in a later dir beats a `.cmd` in an earlier one,
    /// and a `.cmd` beats a `.bat`.
    #[test]
    fn a_native_exe_beats_an_npm_shim_beats_a_bat_across_all_dirs() {
        let base = std::env::temp_dir().join(format!("lsp-find-{}", ulid::Ulid::new()));
        let (a, b) = (base.join("a"), base.join("b"));
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        let names = file_names("srv", true);
        let dirs = [a.clone(), b.clone()];
        let write = |p: PathBuf| {
            std::fs::write(&p, "").unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt as _;
                std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
        };
        assert_eq!(find_in_dirs(&dirs, &names), None);
        write(a.join("srv.bat"));
        assert_eq!(find_in_dirs(&dirs, &names), Some(a.join("srv.bat")));
        write(b.join("srv.cmd"));
        assert_eq!(find_in_dirs(&dirs, &names), Some(b.join("srv.cmd")));
        write(b.join("srv.exe"));
        assert_eq!(find_in_dirs(&dirs, &names), Some(b.join("srv.exe")));
        let _ = std::fs::remove_dir_all(base);
    }

    /// npm 10's shim for `typescript-language-server` (the shape `npm i -g` writes).
    const TSLS_SHIM: &str = "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\n\
EXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST \"%dp0%\\node.exe\" (\r\n  \
SET \"_prog=%dp0%\\node.exe\"\r\n) ELSE (\r\n  SET \"_prog=node\"\r\n  \
SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || \
title %COMSPEC% & \"%_prog%\"  \
\"%dp0%\\node_modules\\typescript-language-server\\lib\\cli.mjs\" %*\r\n";

    fn npm_prefix_with_tsls() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lsp-npm-{}", ulid::Ulid::new()));
        std::fs::create_dir_all(dir.join("node_modules/typescript-language-server/lib")).unwrap();
        std::fs::write(
            dir.join("node_modules/typescript-language-server/lib/cli.mjs"),
            "",
        )
        .unwrap();
        std::fs::write(dir.join("typescript-language-server.cmd"), TSLS_SHIM).unwrap();
        dir
    }

    /// The npm shim becomes `node <cli.mjs> --stdio` — the server process itself, never
    /// `cmd.exe`. Off Windows (or for an `.exe`) the binary runs as itself.
    #[test]
    fn an_npm_cmd_shim_launches_as_node_plus_its_script_with_the_server_args() {
        let dir = npm_prefix_with_tsls();
        let shim = dir.join("typescript-language-server.cmd");
        let node = PathBuf::from(r"C:\nodejs\node.exe");
        let script = dir
            .join("node_modules")
            .join("typescript-language-server")
            .join("lib")
            .join("cli.mjs");
        let got = launch_for(&shim, &["--stdio"], true, || Some(node.clone())).unwrap();
        assert_eq!(
            got,
            Launch {
                program: node.clone(),
                args: vec![script.to_string_lossy().into_owned(), "--stdio".to_string()],
            }
        );
        let err = launch_for(&shim, &["--stdio"], true, || None).unwrap_err();
        assert!(
            err.contains("node.exe") && err.contains("not found"),
            "{err}"
        );
        assert_eq!(
            launch_for(&shim, &["--stdio"], false, || None)
                .unwrap()
                .program,
            shim,
            "off Windows nothing is unwrapped"
        );
        let exe = Path::new(r"C:\x\clangd.exe");
        assert_eq!(
            launch_for(exe, &[], true, || None).unwrap(),
            Launch {
                program: exe.to_path_buf(),
                args: vec![],
            }
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A `.bat` launcher (jdtls) runs as a batch file with the registry's fixed args — and is
    /// refused if its path or an arg carries a character cmd.exe would interpret.
    #[test]
    fn a_bat_launcher_runs_with_fixed_args_and_cmd_metacharacters_are_refused() {
        let dir = std::env::temp_dir().join(format!("lsp-bat-{}", ulid::Ulid::new()));
        std::fs::create_dir_all(&dir).unwrap();
        let bat = dir.join("jdtls.bat");
        // An unquoted target is not an npm shim's shape: no target to read, so a batch run.
        std::fs::write(
            &bat,
            "@echo off\r\njava -jar %~dp0..\\plugins\\launcher.jar %*\r\n",
        )
        .unwrap();
        assert_eq!(
            launch_for(&bat, &[], true, || None).unwrap(),
            Launch {
                program: bat.clone(),
                args: vec![],
            }
        );
        for bad in ["%PATH%", "a&b", "x^y", "line\nbreak", "!v!"] {
            let err = launch_for(&bat, &[bad], true, || None).unwrap_err();
            assert!(err.contains("cmd.exe would"), "{bad}: {err}");
        }
        // A launcher in the shim's shape (quoted `%~dp0` script + interpreter) is unwrapped
        // like an npm shim: the interpreter runs the script, no cmd.exe in between.
        let py = dir.join("py.bat");
        std::fs::write(&py, "@echo off\r\npython \"%~dp0jdtls\" %*\r\n").unwrap();
        assert_eq!(
            launch_for(&py, &[], true, || None).unwrap(),
            Launch {
                program: PathBuf::from("python"),
                args: vec![dir.join("jdtls").to_string_lossy().into_owned()],
            }
        );
        let odd = dir.join("100%.bat");
        std::fs::write(&odd, "@echo off\r\n").unwrap();
        assert!(launch_for(&odd, &[], true, || None).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Every server's args reach a batch launcher on Windows, so none may hold a cmd
    /// metacharacter (the "fixed args only" half of the `.bat` route).
    #[test]
    fn no_registry_args_contain_a_cmd_metacharacter() {
        for lang in ["rust", "typescript", "python", "go", "c", "java", "kotlin"] {
            for arg in spec_for_os(lang, true).unwrap().args {
                assert!(!arg.contains(CMD_META), "{lang}: {arg}");
            }
        }
    }

    /// The real Windows search: a fake npm prefix as `%APPDATA%\npm`-style dir resolves the
    /// `.cmd`, and launching it gives the real `node.exe` + the script. Run on Windows only —
    /// it reads the real `node.exe` the build machine has.
    #[cfg(windows)]
    #[test]
    fn on_windows_a_fake_npm_cmd_shim_resolves_to_node_and_its_script() {
        let dir = npm_prefix_with_tsls();
        let found = find_in_dirs(
            std::slice::from_ref(&dir),
            &file_names("typescript-language-server", true),
        )
        .expect("the .cmd shim is found");
        assert_eq!(found, dir.join("typescript-language-server.cmd"));
        let launch = launch_for(&found, &["--stdio"], true, crate::winshim::find_node)
            .expect("node.exe is installed on a machine that builds this repo");
        assert!(
            launch
                .program
                .to_string_lossy()
                .to_ascii_lowercase()
                .ends_with("node.exe"),
            "{launch:?}"
        );
        assert!(launch.args[0].ends_with(r"typescript-language-server\lib\cli.mjs"));
        assert_eq!(launch.args[1], "--stdio");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_non_rustup_server_never_consults_rustup() {
        // `go` has no rustup component. Even with a (bogus) rustup answer available,
        // detection must ignore it and use PATH.
        let spec = spec_for("go").unwrap();
        let p = stub(Some("/bogus/rustup/answer"), Some("/usr/bin/gopls"));
        assert_eq!(
            detect_with(&spec, &p),
            Detection::Found(PathBuf::from("/usr/bin/gopls")),
        );
        assert!(
            !*p.rustup_called.lock().unwrap(),
            "rustup must not be probed for a non-rustup server"
        );
    }
}
