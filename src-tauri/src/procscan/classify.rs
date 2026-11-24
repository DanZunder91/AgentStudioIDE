//! Which processes are **dev apps**, and what they are. Pure over
//! `(exe path, argv, parent exe/argv, console)` — [`Facts`] — and table-tested on every OS.
//!
//! | runtime | recognised by | `entry` (what it runs) |
//! |---|---|---|
//! | `jvm` | exe basename `java` (Windows also `javaw`) | `-jar x.jar` → `x.jar`; else the main class (`-m mod/cls` → `cls`) |
//! | `node` | exe basename `node`/`nodejs`/`bun`/`deno` | a `node_modules` package (`node_modules/.bin/vite` → `vite`), an npm/pnpm/yarn script (`npm run dev`), `bun run dev`, else the script's basename |
//! | `rust` | exe under `…/target/{debug,release}/` (also `target/<triple>/…`, `examples/`), or a child of `cargo run` | the exe basename |
//! | `python` | exe basename `python`, `python3`, `python3.12`, … (Windows also `pythonw`) | `-m mod` → `mod`; else the script's basename |
//! | `go` | exe under a `go-build…/…/exe/` dir (`go run`), or a child of `go run` | the exe basename |
//! | `shell` | `sh`/`bash`/`zsh`/… running a script (`-c …` or a file) **with its stdout/stderr in a file** | the script (≤ 80 chars) or its basename |
//!
//! **Launchers** (`npm run dev`, `pnpm dev`, `bun run dev`, `deno task`, `cargo run`,
//! `go run`, `gradle`/`mvn` clients) are dev apps too, flagged [`Classified::launcher`] —
//! [`super::assemble`] hides one whose descendant is a dev app (`npm run dev` → `vite`: the
//! row is `vite`, which is where the ports and the logs are).
//!
//! **Skipped** (→ `None`): anything whose executable is under a system prefix
//! ([`SYSTEM_PREFIXES`]); editors and IDEs themselves and their tooling — an executable
//! inside an IDE bundle/install ([`in_ide`]: RustRover, IntelliJ, VS Code, Cursor, Zed,
//! Xcode, …), a script inside one (a language server `node …/RustRover.app/…/server.js`),
//! and JetBrains' own JVMs (`com.intellij.*`/`org.jetbrains.*` main classes) — but **not**
//! what they launch (a Gradle daemon on the IDE's bundled JDK, an app run from IDEA with
//! `-javaagent:…/idea_rt.jar`: decided by the main class, not the JDK's location); plain
//! interactive shells and shells whose console is a terminal/pipe; one-shot tools
//! (`npm install`, `python -m pip`, `cargo build`, `bun add`); Rust build scripts and test
//! binaries (`target/debug/{build,deps}/`); everything unrecognised.
//!
//! **Why a shell with a file console counts.** `sh -c 'exec >svc.log 2>&1; …'` is how a
//! service gets started by hand or by an agent, and its log file is exactly what the view
//! is for. A shell whose output goes to a terminal is a person typing (already a terminal
//! in the IDE or in theirs) and is noise.
//!
//! **Windows-shaped paths** go through the same rules: a path with a `\` is read
//! with `/` for the comparisons ([`norm_path`]; `\\?\` dropped), names lose `.exe` (`node.exe`
//! is `node`, `target\debug\gazelle.exe` is `gazelle`), `C:\Windows\…` is the system's
//! ([`is_system_path`]), `powershell`/`pwsh`/`cmd` are shells, the console hosts
//! (`conhost.exe`, `OpenConsole.exe` — a ConPTY host can sit in a cargo `target\debug`) are never
//! apps, and the IDE installs under `Program Files` / `AppData\Local\Programs` are IDEs. A path
//! with no `\` and no drive letter is never touched by any of it, so macOS and Linux classify
//! exactly as before.

use std::borrow::Cow;

use serde::{Deserialize, Serialize};

use super::logfiles::Console;
use crate::netmachine::wintable::strip_exe;

/// `runtime` on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Runtime {
    Jvm,
    Node,
    Rust,
    Python,
    Go,
    Shell,
    Docker,
}

/// What the classifier looks at.
#[derive(Debug, Clone, Copy)]
pub struct Facts<'a> {
    pub exe: &'a str,
    pub argv: &'a [String],
    pub parent_exe: Option<&'a str>,
    pub parent_argv: &'a [String],
    pub console: Console,
}

/// A dev app, as classified.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Classified {
    pub runtime: Runtime,
    /// What it runs (`vite`, `app.jar`, `com.acme.Main`, `npm run dev`, `uvicorn`).
    pub entry: Option<String>,
    /// A wrapper that starts the real app as a child (see the module doc).
    pub launcher: bool,
    /// A name that beats the cwd rule (`gradle daemon` — its cwd is `~/.gradle/daemon/8.10`).
    pub fixed_name: Option<String>,
    /// The name when neither a tool nor the cwd names anything.
    pub fallback_name: String,
    /// What the row says it runs, before the project (seven rows all called
    /// `Agent Studio` would be noise): `vitest`, `server.js`, `sh`,
    /// `shop-0.1.jar`, `App` (a main class's simple name), `uvicorn`, the binary.
    pub tool: Option<String>,
}

/// Executables under these are the OS's, never a dev app.
pub const SYSTEM_PREFIXES: &[&str] = &[
    "/System/",
    "/usr/libexec/",
    "/usr/sbin/",
    "/sbin/",
    "/Library/Apple/",
    "/usr/lib/systemd/",
    "/lib/systemd/",
];

/// macOS bundles (`/<prefix>…​.app/`) that are editors/IDEs.
const IDE_BUNDLES: &[&str] = &[
    "RustRover",
    "IntelliJ IDEA",
    "WebStorm",
    "PyCharm",
    "GoLand",
    "CLion",
    "DataGrip",
    "DataSpell",
    "PhpStorm",
    "Rider",
    "RubyMine",
    "Aqua",
    "Fleet",
    "JetBrains Toolbox",
    "Android Studio",
    "Visual Studio Code",
    "VSCodium",
    "Cursor",
    "Windsurf",
    "Zed",
    "Xcode",
    "Sublime Text",
    "Nova",
    "Agent Studio",
];

/// Path fragments of editor/IDE installs and their extension dirs (Linux, and the
/// per-user extension dirs on every OS).
const IDE_FRAGMENTS: &[&str] = &[
    "/JetBrains/Toolbox/apps/",
    "/.local/share/JetBrains/",
    "/snap/code/",
    "/snap/rustrover/",
    "/snap/intellij-idea",
    "/snap/pycharm",
    "/snap/webstorm",
    "/snap/goland",
    "/snap/clion",
    "/usr/share/code/",
    "/opt/visual-studio-code/",
    "/.vscode-server/",
    "/.vscode/extensions/",
    "/.vscode-oss/extensions/",
    "/.cursor/extensions/",
    "/.cursor-server/",
    "/.windsurf/extensions/",
    "/opt/rustrover",
    "/opt/idea",
    "/opt/pycharm",
];

/// Main-class prefixes of JetBrains' own JVMs (the IDE, its indexers, the Kotlin daemon).
const IDE_MAIN_PREFIXES: &[&str] = &["com.intellij.", "org.jetbrains.", "com.jetbrains."];

/// Segment names (lower case) under which a folder named like an IDE is that IDE's install on
/// Windows: `C:\Program Files\JetBrains\RustRover 2025.2\…`, `%LOCALAPPDATA%\Programs\cursor\…`.
const WIN_IDE_PARENTS: &[&str] = &[
    "programs",
    "program files",
    "program files (x86)",
    "jetbrains",
    "android",
    "local",
];

/// Windows install folders of editors that are not named like their bundle (lower case).
const WIN_IDE_FOLDERS: &[&str] = &["microsoft vs code", "microsoft vs code insiders"];

const SHELLS: &[&str] = &[
    "sh", "bash", "zsh", "fish", "dash", "ksh", "mksh", "tcsh", "csh", "nu", "pwsh",
];

/// Windows' own shells, a shell only when the name comes from a Windows-shaped path or a
/// `.exe` ([`is_shell`]). Not in [`SHELLS`]: a unix binary is often called `cmd` — `go run
/// ./cmd` runs `/tmp/go-build…/exe/cmd` — and must not be read as a shell (the
/// Windows-shaped path guard).
const WINDOWS_SHELLS: &[&str] = &["cmd", "powershell"];

/// Windows console hosts: the process behind a console window or a ConPTY session, never an app
/// (an `OpenConsole.exe` shipped next to a Rust binary sits in `target\debug`).
const CONSOLE_HOSTS: &[&str] = &["conhost", "openconsole"];

/// The last path component (either separator).
pub fn basename(p: &str) -> &str {
    p.rsplit(['/', '\\']).next().unwrap_or(p)
}

/// Is this a Windows-shaped path (a `\` in it, or a drive letter)? Only such paths get the
/// Windows readings below; a unix path is never touched.
pub fn is_windows_path(p: &str) -> bool {
    let b = p.as_bytes();
    p.contains('\\') || (b.len() >= 2 && b[1] == b':' && b[0].is_ascii_alphabetic())
}

/// A Windows path read with `/` separators (`C:\w\x` → `C:/w/x`, `\\?\C:\x` → `C:/x`); any
/// other path as it is.
pub fn norm_path(p: &str) -> Cow<'_, str> {
    if !p.contains('\\') {
        return Cow::Borrowed(p);
    }
    let p = p.strip_prefix(r"\\?\").unwrap_or(p);
    Cow::Owned(p.replace('\\', "/"))
}

fn stem(p: &str) -> &str {
    let b = basename(p);
    match b.rsplit_once('.') {
        Some((s, _)) if !s.is_empty() => s,
        _ => b,
    }
}

/// Is this process a shell (`/bin/zsh`, a login `-zsh`, `bash`)? By the executable's
/// name, else argv[0]'s (a login shell's leading `-` dropped). Used by the origin
/// walk ([`super::ide`]): a shell between the `claude` CLI and a process is what makes that process
/// something the agent *ran* rather than one of claude's own helpers.
pub fn is_shell(exe: Option<&str>, argv: &[String]) -> bool {
    let source = exe.filter(|e| !exe_name(e).is_empty()).or_else(|| {
        argv.first()
            .map(|a| a.trim_start_matches('-'))
            .filter(|a| !exe_name(a).is_empty())
    });
    let Some(source) = source else {
        return false;
    };
    let name = exe_name(source);
    let windows_shaped = is_windows_path(source) || {
        let b = basename(source);
        b.len() > 4 && b[b.len() - 4..].eq_ignore_ascii_case(".exe")
    };
    SHELLS.contains(&name.as_str()) || (windows_shaped && WINDOWS_SHELLS.contains(&name.as_str()))
}

/// Is this executable the operating system's? (Windows: anything under `<drive>:\Windows\`,
/// in any case — the API spells it `C:\WINDOWS\system32\…` as often as not.)
pub fn is_system_path(exe: &str) -> bool {
    if SYSTEM_PREFIXES.iter().any(|p| exe.starts_with(p)) {
        return true;
    }
    if !is_windows_path(exe) {
        return false;
    }
    let n = norm_path(exe).to_ascii_lowercase();
    n.as_bytes().get(1) == Some(&b':') && n[2..].starts_with("/windows/")
}

/// Is `path` inside an editor/IDE install (module doc)?
pub fn in_ide(path: &str) -> bool {
    if is_windows_path(path) {
        return in_windows_ide(path);
    }
    if IDE_FRAGMENTS.iter().any(|f| path.contains(f)) {
        return true;
    }
    path.split('/').any(|seg| {
        seg.strip_suffix(".app")
            .is_some_and(|name| IDE_BUNDLES.iter().any(|b| name.starts_with(b)))
    })
}

/// [`in_ide`] for a Windows path: case-insensitive, the shared fragments (extension dirs,
/// JetBrains Toolbox), a known editor folder, or a folder named like an IDE directly under
/// `Program Files` / `Programs` / `JetBrains` / `AppData\Local`.
fn in_windows_ide(path: &str) -> bool {
    let n = norm_path(path).to_ascii_lowercase();
    if IDE_FRAGMENTS
        .iter()
        .any(|f| n.contains(&f.to_ascii_lowercase()))
    {
        return true;
    }
    let segs: Vec<&str> = n.split('/').collect();
    segs.windows(2).any(|w| {
        WIN_IDE_FOLDERS.contains(&w[1])
            || (WIN_IDE_PARENTS.contains(&w[0])
                && IDE_BUNDLES
                    .iter()
                    .any(|b| w[1].starts_with(&b.to_ascii_lowercase())))
    })
}

/// `name` or `name` + a version (`python3`, `python3.12`, `python3.13t`).
fn versioned(name: &str, stem: &str) -> bool {
    let Some(rest) = name.strip_prefix(stem) else {
        return false;
    };
    let rest = rest.strip_suffix('t').unwrap_or(rest);
    rest.is_empty()
        || (rest.starts_with(|c: char| c.is_ascii_digit())
            && rest.chars().all(|c| c.is_ascii_digit() || c == '.'))
}

fn exe_name(exe: &str) -> String {
    let b = basename(exe).to_ascii_lowercase();
    b.strip_suffix(".exe").map(str::to_string).unwrap_or(b)
}

/// The program named by argv[0] (a symlink like `/usr/local/bin/cargo` → rustup's proxy
/// still says `cargo` here), else the executable.
fn program_name(exe: Option<&str>, argv: &[String]) -> String {
    argv.first()
        .map(|a| exe_name(a))
        .filter(|n| !n.is_empty())
        .or_else(|| exe.map(exe_name))
        .unwrap_or_default()
}

/// The first argument that is not a flag, skipping `+toolchain` (cargo).
fn first_positional(args: &[String]) -> Option<&str> {
    args.iter()
        .map(String::as_str)
        .find(|a| !a.starts_with('-') && !a.starts_with('+'))
}

/// Is this (parent) process `cargo run` / `cargo r` / `cargo watch`?
fn is_cargo_run(exe: Option<&str>, argv: &[String]) -> bool {
    program_name(exe, argv) == "cargo"
        && matches!(
            first_positional(argv.get(1..).unwrap_or(&[])),
            Some("run" | "r" | "watch")
        )
}

fn is_go_run(exe: Option<&str>, argv: &[String]) -> bool {
    program_name(exe, argv) == "go" && argv.get(1).is_some_and(|a| a == "run")
}

/// `tool` defaults to the entry (a package, a script's basename, a binary, a launcher's
/// `npm run dev`); the few entries that are not a tool's name override it.
fn classified(runtime: Runtime, entry: Option<String>, fallback: impl Into<String>) -> Classified {
    Classified {
        runtime,
        tool: entry.clone(),
        entry,
        launcher: false,
        fixed_name: None,
        fallback_name: fallback.into(),
    }
}

/// Classify one process (module doc). `None` = not a dev app.
pub fn classify(f: &Facts<'_>) -> Option<Classified> {
    if f.exe.is_empty() || is_system_path(f.exe) {
        return None;
    }
    let name = exe_name(f.exe);
    let args = f.argv.get(1..).unwrap_or(&[]);

    if CONSOLE_HOSTS.contains(&name.as_str()) {
        return None;
    }
    // `javaw`: Windows' console-less java (GUI apps, some run configurations).
    if name == "java" || name == "javaw" {
        return jvm(args);
    }
    if in_ide(f.exe) {
        return None;
    }
    if matches!(name.as_str(), "node" | "nodejs" | "bun" | "deno") {
        return node(&name, f.argv.first().map(String::as_str), args);
    }
    // `pythonw`: Windows' console-less python (tray apps, background scripts).
    if versioned(&name, "python") || name == "pythonw" {
        return python(args);
    }
    if SHELLS.contains(&name.as_str()) {
        // Named as invoked: macOS's `/bin/sh` runs as `/bin/bash`, Linux's as `dash`; the
        // row should say `sh`, what the command line says, on both.
        let invoked = f
            .argv
            .first()
            .map(|a| exe_name(a.trim_start_matches('-')))
            .filter(|n| SHELLS.contains(&n.as_str()))
            .unwrap_or(name);
        return shell(&invoked, args, f.console);
    }
    if let Some(c) = rust(f, &name, args) {
        return Some(c);
    }
    go(f, &name)
}

// ── JVM ─────────────────────────────────────────────────────────────────────

/// java options that take the next argument as their value.
const JAVA_VALUE_OPTS: &[&str] = &[
    "-cp",
    "-classpath",
    "--class-path",
    "-p",
    "--module-path",
    "--upgrade-module-path",
    "--add-modules",
    "--add-opens",
    "--add-exports",
    "--add-reads",
    "--patch-module",
    "--limit-modules",
    "--source",
];

fn jvm(args: &[String]) -> Option<Classified> {
    let mut i = 0;
    let mut entry: Option<(String, String)> = None; // (entry, fallback name)
    while i < args.len() {
        let a = args[i].as_str();
        if a == "-jar" {
            let jar = args.get(i + 1)?;
            entry = Some((basename(jar).to_string(), stem(jar).to_string()));
            break;
        }
        if a == "-m" || a == "--module" {
            let m = args.get(i + 1)?;
            let class = m.split_once('/').map_or(m.as_str(), |(_, c)| c);
            entry = Some((class.to_string(), last_segment(class).to_string()));
            break;
        }
        if JAVA_VALUE_OPTS.contains(&a) {
            i += 2;
            continue;
        }
        if a.starts_with('-') || a.starts_with('@') {
            i += 1;
            continue;
        }
        entry = Some((a.to_string(), last_segment(a).to_string()));
        break;
    }
    let (entry, fallback) = entry?;
    if IDE_MAIN_PREFIXES.iter().any(|p| entry.starts_with(p)) {
        return None;
    }
    let mut c = classified(Runtime::Jvm, Some(entry.clone()), fallback);
    if !entry.ends_with(".jar") {
        // A main class: its simple name (`com.acme.shop.App` → `App`).
        c.tool = Some(last_segment(&entry).to_string());
    }
    match entry.as_str() {
        "org.gradle.launcher.daemon.bootstrap.GradleDaemon" => {
            c.fixed_name = Some("gradle daemon".into());
        }
        "org.mvndaemon.mvnd.daemon.DaemonWrapper" | "org.mvndaemon.mvnd.daemon.Server" => {
            c.fixed_name = Some("mvnd daemon".into());
        }
        "org.gradle.wrapper.GradleWrapperMain" | "org.gradle.launcher.GradleMain" => {
            c.launcher = true;
            c.entry = Some("gradle".into());
            c.tool = c.entry.clone();
            c.fallback_name = "gradle".into();
        }
        "org.codehaus.plexus.classworlds.launcher.Launcher" => {
            c.launcher = true;
            c.entry = Some("mvn".into());
            c.tool = c.entry.clone();
            c.fallback_name = "maven".into();
        }
        // The JDK's own tools (jps, jcmd, jshell) are not apps.
        e if e.starts_with("sun.tools.") || e.starts_with("jdk.") => return None,
        // Anything else is an app — on an IDE's bundled JDK too: that is something the
        // IDE launched (a run configuration), decided by the main class above.
        _ => {}
    }
    Some(c)
}

fn last_segment(class: &str) -> &str {
    class.rsplit('.').next().unwrap_or(class)
}

// ── Node / Bun / Deno ───────────────────────────────────────────────────────

/// node options that take the next argument as their value.
const NODE_VALUE_OPTS: &[&str] = &[
    "-r",
    "--require",
    "--loader",
    "--experimental-loader",
    "--import",
    "--inspect-port",
    "--title",
    "--env-file",
    "-C",
    "--conditions",
];

const JS_LAUNCHERS: &[&str] = &["npm", "npx", "pnpm", "pnpx", "yarn", "corepack"];

/// One-shot package-manager verbs: not an app.
const ONE_SHOT: &[&str] = &[
    "install",
    "i",
    "ci",
    "add",
    "remove",
    "rm",
    "uninstall",
    "update",
    "upgrade",
    "init",
    "create",
    "link",
    "outdated",
    "publish",
    "pm",
    "patch",
    "audit",
    "list",
    "ls",
    "info",
    "view",
    "why",
    "lsp",
    "fmt",
    "lint",
    "check",
    "completions",
];

fn looks_like_file(a: &str) -> bool {
    a.contains('/')
        || a.contains('\\')
        || [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".tsx", ".jsx"]
            .iter()
            .any(|e| a.ends_with(e))
}

/// A path with `.`, `..` and empty segments folded away, `/`-separated. npm's Windows shim runs
/// `node "%dp0%\..\vite\bin\vite.js"`, and `%dp0%` ends with `\` — so the script argument is
/// `…\node_modules\.bin\\..\vite\bin\vite.js`, which names `vite`, not `..`.
fn lexical(p: &str) -> String {
    let n = norm_path(p);
    let mut out: Vec<&str> = Vec::new();
    for seg in n.split('/') {
        match seg {
            "" | "." => {}
            ".." if out.last().is_some_and(|s| *s != "..") => {
                out.pop();
            }
            s => out.push(s),
        }
    }
    out.join("/")
}

/// The package a path inside `node_modules` belongs to (the last `node_modules/` wins:
/// pnpm's `.pnpm/vite@5/node_modules/vite/bin/vite.js` is `vite`).
fn node_module_package(script: &str) -> Option<String> {
    let script = lexical(script);
    let (_, rest) = script.rsplit_once("node_modules/")?;
    let mut parts = rest.split('/');
    let first = parts.next()?;
    let pkg = match first {
        ".bin" => parts.next()?.to_string(),
        s if s.starts_with('@') => format!("{s}/{}", parts.next()?),
        s => s.to_string(),
    };
    (!pkg.is_empty()).then_some(pkg)
}

/// A JS package manager's CLI script (`…/npm-cli.js`, `…/bin/pnpm.cjs`, `…/yarn.js`).
fn js_launcher_of(script: &str) -> Option<&'static str> {
    let s = stem(script).trim_end_matches("-cli");
    JS_LAUNCHERS.iter().copied().find(|l| *l == s)
}

/// `"<tool> run dev"` from the tool and its arguments (the verb and the script only).
fn launcher_entry(tool: &str, args: &[String]) -> String {
    let words: Vec<&str> = args
        .iter()
        .map(String::as_str)
        .filter(|a| !a.starts_with('-'))
        .take(2)
        .collect();
    if words.is_empty() {
        tool.to_string()
    } else {
        format!("{tool} {}", words.join(" "))
    }
}

fn node(runtime_exe: &str, argv0: Option<&str>, args: &[String]) -> Option<Classified> {
    if matches!(runtime_exe, "bun" | "deno") {
        return bun_or_deno(runtime_exe, args);
    }
    // npm/pnpm/yarn set `process.title` ("npm run dev"), which on macOS rewrites the argv
    // the kernel reports: argv[0] is then the whole title and the script path is gone.
    if let Some(title) = argv0 {
        let words: Vec<&str> = title.split_whitespace().collect();
        if let Some(first) = words.first() {
            if let Some(tool) = JS_LAUNCHERS.iter().find(|l| **l == basename(first)) {
                let rest: Vec<String> = words[1..]
                    .iter()
                    .map(|w| w.to_string())
                    .chain(args.iter().cloned())
                    .collect();
                if first_positional(&rest).is_some_and(|v| ONE_SHOT.contains(&v)) {
                    return None;
                }
                let mut c = classified(Runtime::Node, Some(launcher_entry(tool, &rest)), *tool);
                c.launcher = true;
                return Some(c);
            }
        }
    }
    let mut i = 0;
    let script = loop {
        let a = args.get(i)?.as_str();
        if a == "-e" || a == "--eval" || a == "-p" || a == "--print" {
            let mut c = classified(Runtime::Node, Some("node -e".into()), "node");
            c.tool = Some("node".into());
            return Some(c);
        }
        if NODE_VALUE_OPTS.contains(&a) {
            i += 2;
            continue;
        }
        if a == "--" {
            i += 1;
            continue;
        }
        if a.starts_with('-') {
            i += 1;
            continue;
        }
        break a;
    };
    if in_ide(script) {
        return None;
    }
    let rest = &args[i + 1..];
    let tool = js_launcher_of(script)
        .map(str::to_string)
        .or_else(|| node_module_package(script).filter(|p| JS_LAUNCHERS.contains(&p.as_str())));
    if let Some(tool) = tool {
        if first_positional(rest).is_some_and(|v| ONE_SHOT.contains(&v)) {
            return None;
        }
        let mut c = classified(Runtime::Node, Some(launcher_entry(&tool, rest)), tool);
        c.launcher = true;
        return Some(c);
    }
    if let Some(pkg) = node_module_package(script) {
        return Some(classified(Runtime::Node, Some(pkg.clone()), pkg));
    }
    Some(classified(
        Runtime::Node,
        Some(basename(script).to_string()),
        stem(script),
    ))
}

fn bun_or_deno(tool: &str, args: &[String]) -> Option<Classified> {
    let first = first_positional(args)?;
    let pos = args.iter().position(|a| a == first).unwrap_or(0);
    let rest = &args[pos + 1..];
    if ONE_SHOT.contains(&first) || (first == "test" && tool == "deno") {
        return None;
    }
    // `bun run server.ts`, `deno run main.ts`, `deno serve main.ts`: a file, run in-process.
    if matches!(first, "run" | "serve") {
        if let Some(target) = first_positional(rest) {
            if looks_like_file(target) {
                if in_ide(target) {
                    return None;
                }
                return Some(classified(
                    Runtime::Node,
                    Some(basename(target).to_string()),
                    stem(target),
                ));
            }
        }
    }
    if looks_like_file(first) {
        if in_ide(first) {
            return None;
        }
        return Some(classified(
            Runtime::Node,
            Some(basename(first).to_string()),
            stem(first),
        ));
    }
    // `bun run dev`, `bun dev`, `deno task dev`, `bun x vite`: a package script — a launcher.
    let mut c = classified(
        Runtime::Node,
        Some(launcher_entry(tool, &args[pos..])),
        tool,
    );
    c.launcher = true;
    Some(c)
}

// ── Python ──────────────────────────────────────────────────────────────────

/// python options that take the next argument as their value.
const PY_VALUE_OPTS: &[&str] = &["-X", "-W", "--check-hash-based-pycs"];
/// `python -m <these>` is tooling, not an app.
const PY_TOOL_MODULES: &[&str] = &[
    "pip",
    "venv",
    "ensurepip",
    "pylsp",
    "jedi_language_server",
    "black",
    "ruff",
    "mypy",
    "isort",
];

fn python(args: &[String]) -> Option<Classified> {
    let mut i = 0;
    while let Some(a) = args.get(i).map(String::as_str) {
        if a == "-m" {
            let m = args.get(i + 1)?;
            let top = m.split('.').next().unwrap_or(m);
            if PY_TOOL_MODULES.contains(&top) {
                return None;
            }
            return Some(classified(Runtime::Python, Some(m.clone()), m.as_str()));
        }
        if a == "-c" {
            let mut c = classified(Runtime::Python, Some("python -c".into()), "python");
            c.tool = Some("python".into());
            return Some(c);
        }
        if PY_VALUE_OPTS.contains(&a) {
            i += 2;
            continue;
        }
        if a.starts_with('-') {
            i += 1;
            continue;
        }
        if in_ide(a) {
            return None;
        }
        return Some(classified(
            Runtime::Python,
            Some(basename(a).to_string()),
            stem(a),
        ));
    }
    // A bare `python3`: a REPL.
    None
}

// ── Shell ───────────────────────────────────────────────────────────────────

/// Longest `entry` for a `sh -c` script.
pub const SHELL_ENTRY_MAX: usize = 80;

fn shell(name: &str, args: &[String], console: Console) -> Option<Classified> {
    if console != Console::File {
        return None;
    }
    // PowerShell takes its script after `-Command` (any case; `-c` is its short form, above),
    // and `-File` names a file, which the positional rule below reads.
    let powershell = matches!(name, "pwsh" | "powershell");
    if let Some(i) = args.iter().position(|a| {
        a == "-c" || a == "-lc" || a == "-ic" || (powershell && a.eq_ignore_ascii_case("-command"))
    }) {
        let script = args.get(i + 1)?;
        let one_line: String = script.split_whitespace().collect::<Vec<_>>().join(" ");
        let entry = if one_line.chars().count() > SHELL_ENTRY_MAX {
            let cut: String = one_line.chars().take(SHELL_ENTRY_MAX).collect();
            format!("{cut}…")
        } else {
            one_line
        };
        // The script is the entry; the row says which shell (`sh · svc`).
        let mut c = classified(Runtime::Shell, Some(entry), name);
        c.tool = Some(name.to_string());
        return Some(c);
    }
    let script = first_positional(args)?;
    if in_ide(script) {
        return None;
    }
    Some(classified(
        Runtime::Shell,
        Some(basename(script).to_string()),
        stem(script),
    ))
}

// ── Rust ────────────────────────────────────────────────────────────────────

/// `…/target/debug/x`, `…/target/release/x`, `…/target/<triple>/debug/x`,
/// `…/target/debug/examples/x` — but not build scripts, test binaries or incremental dirs.
pub fn is_cargo_artifact(exe: &str) -> bool {
    let exe = norm_path(exe);
    let parts: Vec<&str> = exe.split('/').collect();
    let Some(t) = parts.iter().rposition(|p| *p == "target") else {
        return false;
    };
    let after = &parts[t + 1..];
    let profile_at = match after {
        [p, ..] if matches!(*p, "debug" | "release") => 0,
        [_, p, ..] if matches!(*p, "debug" | "release") => 1,
        _ => return false,
    };
    matches!(&after[profile_at + 1..], [_] | ["examples", _])
}

fn rust(f: &Facts<'_>, name: &str, args: &[String]) -> Option<Classified> {
    if name == "cargo" {
        if is_cargo_run(Some(f.exe), f.argv) {
            let mut c = classified(Runtime::Rust, Some(launcher_entry("cargo", args)), "cargo");
            c.launcher = true;
            return Some(c);
        }
        return None;
    }
    if is_cargo_artifact(f.exe) || is_cargo_run(f.parent_exe, f.parent_argv) {
        let bin = strip_exe(basename(f.exe));
        return Some(classified(Runtime::Rust, Some(bin.to_string()), bin));
    }
    None
}

// ── Go ──────────────────────────────────────────────────────────────────────

fn go(f: &Facts<'_>, name: &str) -> Option<Classified> {
    if name == "go" {
        if is_go_run(Some(f.exe), f.argv) {
            let mut c = classified(
                Runtime::Go,
                Some(launcher_entry("go", f.argv.get(1..).unwrap_or(&[]))),
                "go",
            );
            c.launcher = true;
            return Some(c);
        }
        return None;
    }
    let exe = norm_path(f.exe);
    let in_build_cache = exe.contains("/go-build") && exe.contains("/exe/");
    if in_build_cache || is_go_run(f.parent_exe, f.parent_argv) {
        let bin = strip_exe(basename(f.exe));
        return Some(classified(Runtime::Go, Some(bin.to_string()), bin));
    }
    None
}

// ── naming ──────────────────────────────────────────────────────────────────

/// Does this cwd name a project? Not `/`, not `$HOME`, not a dot-dir of home
/// (`~/.gradle/daemon/8.10`), not the system's own dirs.
pub fn project_like(cwd: &str, home: Option<&str>) -> bool {
    if is_windows_path(cwd) {
        return windows_project_like(cwd, home);
    }
    let cwd = cwd.trim_end_matches('/');
    if cwd.is_empty() || basename(cwd).is_empty() {
        return false;
    }
    if let Some(h) = home.map(|h| h.trim_end_matches('/')) {
        if cwd == h {
            return false;
        }
        if let Some(rest) = cwd.strip_prefix(h).and_then(|r| r.strip_prefix('/')) {
            if rest.starts_with('.') {
                return false;
            }
        }
    }
    ![
        "/usr",
        "/System",
        "/private/var/root",
        "/var/root",
        "/bin",
        "/sbin",
        "/etc",
    ]
    .iter()
    .any(|p| cwd == *p || cwd.starts_with(&format!("{p}/")))
}

/// [`project_like`] for a Windows cwd, case-insensitive: not a drive root (`C:\`), not the
/// profile (`%USERPROFILE%`), not a dot-dir or `AppData` under it (`.gradle\daemon\8.10`,
/// `AppData\Local\Temp`), not `\Windows`, `\Program Files*`, `\ProgramData`.
fn windows_project_like(cwd: &str, home: Option<&str>) -> bool {
    let lower = norm_path(cwd).to_ascii_lowercase();
    let c = lower.trim_end_matches('/');
    let drive_root = c.len() == 2 && c.ends_with(':');
    if c.is_empty() || drive_root || basename(c).is_empty() {
        return false;
    }
    if let Some(h) = home {
        let h = norm_path(h).to_ascii_lowercase();
        let h = h.trim_end_matches('/');
        if c == h {
            return false;
        }
        if let Some(rest) = c.strip_prefix(h).and_then(|r| r.strip_prefix('/')) {
            if rest.starts_with('.') || rest == "appdata" || rest.starts_with("appdata/") {
                return false;
            }
        }
    }
    let path = match c.as_bytes().get(1) {
        Some(b':') => &c[2..],
        _ => c,
    };
    ![
        "/windows",
        "/program files",
        "/program files (x86)",
        "/programdata",
    ]
    .iter()
    .any(|p| path == *p || path.starts_with(&format!("{p}/")))
}

/// The row's name: a fixed name (`gradle daemon`); else
/// `<tool> · <project>` — `vitest · Agent Studio`, `vite · web`, `server.js · gazelle`,
/// `sh · svc`, `App · shop`; just the project when the tool *is* the project (`gazelle`
/// built from `gazelle/`, not `gazelle · gazelle`); just the tool when the cwd names no
/// project (`/`, `$HOME`); else the fallback.
pub fn app_name(c: &Classified, cwd: Option<&str>, home: Option<&str>) -> String {
    if let Some(n) = &c.fixed_name {
        return n.clone();
    }
    let project = cwd
        .filter(|cwd| project_like(cwd, home))
        .map(|cwd| basename(cwd.trim_end_matches(['/', '\\'])).to_string());
    let tool = c.tool.as_deref().filter(|t| !t.is_empty());
    match (tool, project) {
        (Some(t), Some(p)) if t == p => p,
        (Some(t), Some(p)) => format!("{t} · {p}"),
        (Some(t), None) => t.to_string(),
        (None, Some(p)) => p,
        (None, None) => c.fallback_name.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(args: &[&str]) -> Vec<String> {
        args.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn shells_by_exe_else_by_argv0() {
        assert!(is_shell(Some("/bin/zsh"), &v(&["-zsh"])));
        assert!(is_shell(Some("/usr/bin/bash"), &v(&["bash", "-c", "x"])));
        assert!(
            is_shell(None, &v(&["-zsh"])),
            "a login shell, exe unreadable"
        );
        assert!(
            !is_shell(Some("/opt/homebrew/bin/node"), &v(&["sh"])),
            "exe wins"
        );
        assert!(!is_shell(None, &v(&[])));
        assert!(!is_shell(
            Some("/w/target/debug/shell-svc"),
            &v(&["shell-svc"])
        ));
    }

    #[test]
    fn cargo_artifacts() {
        for yes in [
            "/w/gazelle/target/debug/gazelle",
            "/w/gazelle/target/release/gazelle",
            "/w/g/target/aarch64-apple-darwin/debug/gazelle",
            "/w/g/target/debug/examples/demo",
        ] {
            assert!(is_cargo_artifact(yes), "{yes}");
        }
        for no in [
            "/w/g/target/debug/build/ring-1a2b/build-script-build",
            "/w/g/target/debug/deps/gazelle-3f2e1d",
            "/w/g/target/debug/incremental/x/y",
            "/w/g/target/gazelle",
            "/usr/local/bin/gazelle",
        ] {
            assert!(!is_cargo_artifact(no), "{no}");
        }
    }

    #[test]
    fn ide_paths() {
        for yes in [
            "/Applications/RustRover.app/Contents/MacOS/rustrover",
            "/Applications/IntelliJ IDEA CE.app/Contents/jbr/Contents/Home/bin/java",
            "/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)",
            "/home/u/.local/share/JetBrains/Toolbox/apps/rustrover/bin/rustrover",
            "/home/u/.vscode-server/bin/abc/node",
            "/Users/u/.vscode/extensions/ms-python.python/x.py",
        ] {
            assert!(in_ide(yes), "{yes}");
        }
        for no in [
            "/opt/homebrew/bin/node",
            "/Applications/Postman.app/Contents/MacOS/Postman",
            "/w/zed-clone/target/debug/zedx",
        ] {
            assert!(!in_ide(no), "{no}");
        }
    }

    #[test]
    fn names() {
        let c = classified(Runtime::Jvm, Some("app.jar".into()), "app");
        assert_eq!(
            app_name(&c, Some("/w/shop"), Some("/Users/me")),
            "app.jar · shop"
        );
        assert_eq!(
            app_name(&c, Some("/w/shop/"), Some("/Users/me")),
            "app.jar · shop"
        );
        assert_eq!(app_name(&c, Some("/"), Some("/Users/me")), "app.jar");
        assert_eq!(
            app_name(&c, Some("/Users/me"), Some("/Users/me")),
            "app.jar"
        );
        assert_eq!(
            app_name(&c, Some("/Users/me/.gradle/daemon/8.10"), Some("/Users/me")),
            "app.jar"
        );
        assert_eq!(app_name(&c, None, None), "app.jar");
        let bin = classified(Runtime::Rust, Some("gazelle".into()), "gazelle");
        assert_eq!(
            app_name(&bin, Some("/w/gazelle"), None),
            "gazelle",
            "the tool is the project: said once"
        );
        let mut bare = c.clone();
        bare.tool = None;
        assert_eq!(app_name(&bare, Some("/w/shop"), None), "shop");
        assert_eq!(
            app_name(&bare, Some("/"), None),
            "app",
            "the fallback, last"
        );
        let mut g = c.clone();
        g.fixed_name = Some("gradle daemon".into());
        assert_eq!(app_name(&g, Some("/w/shop"), None), "gradle daemon");
    }

    /// What a row shows: runtime, entry, launcher.
    type Shown = Option<(Runtime, Option<String>, bool)>;
    /// A parent's `(exe, argv)`.
    type Parent<'a> = Option<(&'a str, &'a [&'a str])>;

    /// What classify says, reduced to what a row shows.
    fn class_of(exe: &str, argv: &[&str], parent: Parent<'_>, console: Console) -> Shown {
        let argv = v(argv);
        let parent_argv = parent.map(|(_, a)| v(a)).unwrap_or_default();
        classify(&Facts {
            exe,
            argv: &argv,
            parent_exe: parent.map(|(e, _)| e),
            parent_argv: &parent_argv,
            console,
        })
        .map(|c| (c.runtime, c.entry, c.launcher))
    }

    #[test]
    fn windows_shaped_processes_classify_like_their_unix_twins() {
        use Console::{File, Terminal};
        let node = r"C:\Program Files\nodejs\node.exe";
        let some =
            |r: Runtime, entry: &str, launcher: bool| Some((r, Some(entry.into()), launcher));
        let cases: Vec<(&str, Vec<&str>, Parent<'_>, Console, Shown)> = vec![
            (
                node,
                vec![node, "server.js"],
                None,
                Terminal,
                some(Runtime::Node, "server.js", false),
            ),
            // npm's .cmd shim: `node "%dp0%\..\vite\bin\vite.js"` with a trailing-`\` %dp0%.
            (
                node,
                vec![
                    "node",
                    r"C:\w\web\node_modules\.bin\\..\vite\bin\vite.js",
                    "--port",
                    "5173",
                ],
                None,
                Terminal,
                some(Runtime::Node, "vite", false),
            ),
            (
                node,
                vec![
                    "node.exe",
                    r"C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js",
                    "run",
                    "dev",
                ],
                None,
                Terminal,
                some(Runtime::Node, "npm run dev", true),
            ),
            (
                node,
                vec![
                    "node.exe",
                    r"C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js",
                    "install",
                ],
                None,
                Terminal,
                None,
            ),
            (
                r"C:\w\gazelle\target\debug\gazelle.exe",
                vec![r"target\debug\gazelle.exe"],
                None,
                Terminal,
                some(Runtime::Rust, "gazelle", false),
            ),
            (
                r"\\?\C:\w\gazelle\target\x86_64-pc-windows-msvc\release\gazelle.exe",
                vec!["gazelle"],
                None,
                Terminal,
                some(Runtime::Rust, "gazelle", false),
            ),
            (
                r"C:\w\g\target\debug\build\ring-1a\build-script-build.exe",
                vec!["x"],
                None,
                File,
                None,
            ),
            (
                r"C:\w\g\target\debug\deps\gazelle-3f2e1d.exe",
                vec!["x"],
                None,
                File,
                None,
            ),
            (
                r"C:\Users\u\.cargo\bin\cargo.exe",
                vec!["cargo", "run", "--release"],
                None,
                Terminal,
                some(Runtime::Rust, "cargo run", true),
            ),
            // A child of `cargo run` that lives outside target\ (an installed binary).
            (
                r"C:\tools\svc.exe",
                vec!["svc"],
                Some((
                    r"C:\Users\u\.rustup\toolchains\stable\bin\cargo.exe",
                    &["cargo.exe", "run"],
                )),
                Terminal,
                some(Runtime::Rust, "svc", false),
            ),
            (
                r"C:\Program Files\Java\jdk-21\bin\java.exe",
                vec!["java", "-jar", r"C:\w\shop\target\shop-0.1.jar"],
                None,
                Terminal,
                some(Runtime::Jvm, "shop-0.1.jar", false),
            ),
            (
                r"C:\Program Files\Java\jdk-21\bin\javaw.exe",
                vec!["javaw", "-jar", r"C:\w\tool\tool.jar"],
                None,
                Terminal,
                some(Runtime::Jvm, "tool.jar", false),
            ),
            (
                r"C:\Users\u\AppData\Local\Programs\Python\Python312\pythonw.exe",
                vec!["pythonw", r"C:\w\tray\tray.py"],
                None,
                Terminal,
                some(Runtime::Python, "tray.py", false),
            ),
            (
                r"C:\Program Files\JetBrains\RustRover 2025.2\jbr\bin\java.exe",
                vec!["java", "com.intellij.idea.Main"],
                None,
                Terminal,
                None,
            ),
            (
                r"C:\Users\u\AppData\Local\Programs\Python\Python312\python.exe",
                vec!["python", "-m", "uvicorn", "app:app"],
                None,
                Terminal,
                some(Runtime::Python, "uvicorn", false),
            ),
            (
                r"C:\Program Files\WindowsApps\PythonSoftwareFoundation.Python.3.12_3.12.2032.0_arm64__qbz5n2kfra8p0\python3.12.exe",
                vec!["python3.12", r"C:\w\bot\app.py"],
                None,
                Terminal,
                some(Runtime::Python, "app.py", false),
            ),
            (
                r"C:\Users\u\AppData\Local\Temp\go-build1234\b001\exe\main.exe",
                vec!["main"],
                None,
                Terminal,
                some(Runtime::Go, "main", false),
            ),
            // Shells: the system's never; a user shell only with a file console (as on unix).
            (
                r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
                vec!["powershell", "-File", "x.ps1"],
                None,
                File,
                None,
            ),
            (
                r"C:\Program Files\PowerShell\7\pwsh.exe",
                vec!["pwsh", "-File", r"C:\w\svc\run.ps1"],
                None,
                File,
                Some((Runtime::Shell, Some("run.ps1".into()), false)),
            ),
            (
                r"C:\Program Files\PowerShell\7\pwsh.exe",
                vec!["pwsh", "-File", "run.ps1"],
                None,
                Terminal,
                None,
            ),
            // `-Command` carries the script, not a file name: the whole line is the entry
            // (it used to be the basename of its last `\` segment — `out.log`).
            (
                r"C:\Program Files\PowerShell\7\pwsh.exe",
                vec![
                    "pwsh",
                    "-NoProfile",
                    "-Command",
                    r"& C:\w\svc\run.ps1 *> C:\w\svc\out.log",
                ],
                None,
                File,
                Some((
                    Runtime::Shell,
                    Some(r"& C:\w\svc\run.ps1 *> C:\w\svc\out.log".into()),
                    false,
                )),
            ),
            (
                r"C:\Program Files\PowerShell\7\pwsh.exe",
                vec!["pwsh", "-command", "npm run dev"],
                None,
                File,
                Some((Runtime::Shell, Some("npm run dev".into()), false)),
            ),
            (
                r"C:\Program Files\Git\usr\bin\bash.exe",
                vec!["bash", "-c", "x"],
                None,
                Terminal,
                None,
            ),
            // Console hosts: never an app, even one sitting in a cargo target dir.
            (
                r"C:\w\app\target\debug\OpenConsole.exe",
                vec!["OpenConsole.exe", "--headless"],
                None,
                Terminal,
                None,
            ),
            (
                r"C:\Program Files\WindowsApps\Microsoft.WindowsTerminal_1.25.3131.0_arm64__8wekyb3d8bbwe\OpenConsole.exe",
                vec!["OpenConsole.exe"],
                None,
                Terminal,
                None,
            ),
            (
                r"C:\WINDOWS\system32\conhost.exe",
                vec!["conhost.exe", "0xffffffff"],
                None,
                Terminal,
                None,
            ),
            // An editor's language server.
            (
                node,
                vec![
                    "node",
                    r"C:\Users\u\.vscode\extensions\ms-python.x\server.js",
                ],
                None,
                Terminal,
                None,
            ),
        ];
        for (exe, argv, parent, console, want) in cases {
            assert_eq!(
                class_of(exe, &argv, parent, console),
                want,
                "{exe} {argv:?}"
            );
        }
    }

    #[test]
    fn windows_system_ide_and_shell_paths() {
        for yes in [
            r"C:\WINDOWS\system32\cmd.exe",
            r"D:\Windows\explorer.exe",
            r"\\?\C:\Windows\System32\conhost.exe",
        ] {
            assert!(is_system_path(yes), "{yes}");
        }
        for no in [
            r"C:\Windows.old\x.exe",
            r"C:\w\windows\app.exe",
            r"C:\Program Files\nodejs\node.exe",
            "/usr/bin/node",
        ] {
            assert!(!is_system_path(no), "{no}");
        }
        for yes in [
            r"C:\Program Files\JetBrains\RustRover 2025.2\bin\rustrover64.exe",
            r"C:\Users\u\AppData\Local\Programs\cursor\Cursor.exe",
            r"C:\Users\u\AppData\Local\Programs\Microsoft VS Code\Code.exe",
            r"C:\Program Files\Microsoft VS Code\resources\app\extensions\x\server.js",
            r"C:\Users\u\.vscode\extensions\rust-lang.rust-analyzer\server\rust-analyzer.exe",
            r"C:\Users\u\AppData\Local\JetBrains\Toolbox\apps\rustrover\bin\rustrover64.exe",
            r"C:\Users\u\AppData\Local\Agent Studio\agent-studio.exe",
        ] {
            assert!(in_ide(yes), "{yes}");
        }
        for no in [
            r"C:\Program Files\nodejs\node.exe",
            r"C:\w\zed-clone\target\debug\zedx.exe",
            r"C:\Program Files\Git\usr\bin\bash.exe",
            r"C:\Users\u\AppData\Local\Programs\Python\Python312\python.exe",
        ] {
            assert!(!in_ide(no), "{no}");
        }
        for yes in [
            r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
            r"C:\WINDOWS\system32\cmd.exe",
            r"C:\Program Files\PowerShell\7\pwsh.exe",
            r"C:\Program Files\Git\bin\..\usr\bin\bash.exe",
        ] {
            assert!(is_shell(Some(yes), &[]), "{yes}");
        }
        assert!(!is_shell(
            Some(r"C:\Program Files\nodejs\node.exe"),
            &v(&["cmd"])
        ));
        assert!(!is_shell(Some(r"C:\WINDOWS\system32\conhost.exe"), &[]));
        assert!(is_shell(
            None,
            &v(&[r"C:\WINDOWS\system32\cmd.exe", "/c", "x"])
        ));
        assert!(is_shell(None, &v(&["powershell.exe", "-NoExit"])));
        // The Windows-shaped path guard: a unix binary called `cmd` (`go run ./cmd`) is not
        // Windows' shell.
        assert!(
            !is_shell(Some("/tmp/go-build1/b001/exe/cmd"), &v(&["cmd"])),
            "a unix binary called cmd"
        );
        assert!(!is_shell(None, &v(&["powershell"])), "no .exe, no path");
        assert_eq!(norm_path(r"\\?\C:\a\b"), "C:/a/b");
        assert_eq!(norm_path("/a/b"), "/a/b");
    }

    /// Hand-written Windows cases (expectations never derived from the code under test), kept as
    /// an independent check on this classifier from the earlier, non-native Windows backend. Its
    /// `Console::Unknown` is `Console::None` here — the native backend never reports "unknown".
    #[test]
    fn windows_processes_classify_as_expected() {
        let node = r"C:\Program Files\nodejs\node.exe";
        let run = |exe: &str, argv: &[&str], parent: Option<(&str, &[&str])>| {
            let argv = v(argv);
            let parent_argv = parent.map(|(_, a)| v(a)).unwrap_or_default();
            classify(&Facts {
                exe,
                argv: &argv,
                parent_exe: parent.map(|(e, _)| e),
                parent_argv: &parent_argv,
                console: Console::None,
            })
        };
        let entry = |c: Option<Classified>| c.and_then(|c| c.entry);

        let vite = run(
            node,
            &[node, r"C:\w\web\node_modules\vite\bin\vite.js"],
            None,
        )
        .unwrap();
        assert_eq!(
            (vite.runtime, vite.entry.as_deref(), vite.launcher),
            (Runtime::Node, Some("vite"), false)
        );
        let npm_cli = r"C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js";
        let npm = run(node, &[node, npm_cli, "run", "dev"], None).unwrap();
        assert_eq!(
            (npm.entry.as_deref(), npm.launcher),
            (Some("npm run dev"), true)
        );

        let bin = run(
            r"C:\w\gazelle\target\debug\gazelle.exe",
            &["gazelle.exe"],
            None,
        )
        .unwrap();
        assert_eq!(
            (bin.runtime, bin.entry.as_deref()),
            (Runtime::Rust, Some("gazelle"))
        );
        assert_eq!(
            app_name(&bin, Some(r"C:\w\gazelle"), Some(r"C:\Users\me")),
            "gazelle"
        );
        // A child of `cargo run`, wherever its target dir is, upper-case `.EXE` included.
        let cargo = r"C:\Users\me\.cargo\bin\cargo.exe";
        assert_eq!(
            entry(run(
                r"D:\out\App.EXE",
                &["App.EXE"],
                Some((cargo, &["cargo", "run"]))
            )),
            Some("App".into())
        );

        let py = r"C:\Users\me\AppData\Local\Programs\Python\Python312\python.exe";
        assert_eq!(
            entry(run(py, &["python", "-m", "uvicorn", "main:app"], None)),
            Some("uvicorn".into())
        );
        assert_eq!(
            entry(run(
                py,
                &["python", r"C:\w\api\manage.py", "runserver"],
                None
            )),
            Some("manage.py".into())
        );

        let java = r"C:\Program Files\Java\jdk-21\bin\java.exe";
        let jar = run(
            java,
            &["java", "-jar", r"C:\w\shop\build\libs\shop-0.1.jar"],
            None,
        )
        .unwrap();
        assert_eq!(jar.entry.as_deref(), Some("shop-0.1.jar"));
        assert_eq!(
            app_name(&jar, Some(r"C:\w\shop"), Some(r"C:\Users\me")),
            "shop-0.1.jar · shop"
        );

        // Not dev apps: Windows itself, an editor, an editor's language server, a shell.
        let svchost = r"C:\Windows\System32\svchost.exe";
        assert_eq!(run(svchost, &["svchost.exe", "-k", "netsvcs"], None), None);
        assert_eq!(run(r"c:\windows\py.exe", &["py"], None), None);
        let code = r"C:\Users\me\AppData\Local\Programs\Microsoft VS Code\Code.exe";
        assert_eq!(run(code, &[code, "--type=renderer"], None), None);
        let ra = r"C:\Users\me\.vscode\extensions\rust-lang.rust-analyzer\server.js";
        assert_eq!(run(node, &[node, ra], None), None);
        let ps = r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe";
        assert_eq!(run(ps, &[ps], None), None);

        // Which cwd names a project.
        let home = Some(r"C:\Users\me");
        assert!(project_like(r"C:\w\shop", home));
        assert!(project_like(r"C:\Users\me\code\shop", home));
        for not in [
            r"C:\",
            r"C:\Windows\System32",
            r"C:\Users\me",
            r"C:\Users\me\.gradle\daemon",
            r"C:\Users\me\AppData\Local\Temp",
        ] {
            assert!(!project_like(not, home), "{not}");
        }
    }

    /// The Windows-shaped path guard: only a Windows-shaped executable has its backslashes read
    /// as separators — a unix `sh -c 'printf "a\n"'` keeps its command line byte for byte.
    #[test]
    fn a_unix_command_line_keeps_its_backslashes() {
        let argv = v(&["sh", "-c", r"printf 'a\n' > svc.log"]);
        let c = classify(&Facts {
            exe: "/bin/sh",
            argv: &argv,
            parent_exe: None,
            parent_argv: &[],
            console: Console::File,
        })
        .unwrap();
        assert_eq!(c.entry.as_deref(), Some(r"printf 'a\n' > svc.log"));
    }

    #[test]
    fn windows_cwds_name_projects() {
        let home = Some(r"C:\Users\u");
        for yes in [
            r"C:\w\shop",
            r"C:\Users\u\code\web\",
            r"\\srv\share\proj",
            r"D:\gazelle",
        ] {
            assert!(project_like(yes, home), "{yes}");
        }
        for no in [
            r"C:\Users\u",
            r"c:\users\U\",
            r"C:\Users\u\.gradle\daemon\8.10",
            r"C:\Users\u\AppData\Local\Temp\x",
            r"C:\",
            r"C:\Windows\System32",
            r"C:\Program Files\nodejs",
            r"C:\ProgramData\chocolatey",
        ] {
            assert!(!project_like(no, home), "{no}");
        }
        let c = classified(Runtime::Jvm, Some("app.jar".into()), "app");
        assert_eq!(app_name(&c, Some(r"C:\w\shop\"), home), "app.jar · shop");
        assert_eq!(app_name(&c, Some(r"C:\Users\u"), home), "app.jar");
        let bin = classified(Runtime::Rust, Some("gazelle".into()), "gazelle");
        assert_eq!(app_name(&bin, Some(r"C:\w\gazelle"), home), "gazelle");
    }

    #[test]
    fn launcher_entries_keep_the_verb_and_the_script() {
        assert_eq!(launcher_entry("npm", &v(&["run", "dev"])), "npm run dev");
        assert_eq!(
            launcher_entry("cargo", &v(&["run", "--release", "--bin", "gazelle"])),
            "cargo run gazelle"
        );
        assert_eq!(launcher_entry("yarn", &v(&[])), "yarn");
    }
}
