//! **Where an outside `claude` runs, on Windows** — the host app, and bringing its window to
//! the front.
//!
//! macOS names the host by its `.app` bundle and focuses it with `open`
//! ([`super::host_from_exe`]). Windows has no bundles; what it has is a process tree and
//! top-level windows. So:
//!
//! - **The host** ([`host_of_windows`]) is found by walking the `claude` process's parent
//!   chain. The first ancestor that is a known GUI host by its executable's name (Windows
//!   Terminal, VS Code, Cursor, JetBrains IDEs… — [`KNOWN_HOSTS`]) wins; for a multi-process
//!   host (VS Code's terminals hang off a helper `Code.exe`, not the window's), the walk keeps
//!   climbing through same-named ancestors to the one that owns a window. Failing that, the
//!   first ancestor that owns a visible top-level window — including a shell, which is how a
//!   classic console window shows up (Windows reports the console's client as the window's
//!   process). Console hosts, `claude`'s own helpers and shells without a window are walked
//!   through; `explorer.exe` and the session's system processes END the walk (everything a
//!   user starts from the Start menu hangs off Explorer, which is not the host). Windows does
//!   not re-parent orphans, so a "parent" that started after its child is a reused pid and
//!   ends the walk too.
//! - **Focus** ([`focus_window`]): the host pid's first visible, unowned, non-tool top-level
//!   window in Z order (a titled one preferred) is restored if minimised and handed to
//!   `SetForegroundWindow`. The IDE is the foreground process at the moment of the click,
//!   which is exactly the case Windows allows — no privilege, no prompt, no UI Automation.
//!   Before acting, the pid's image path must still be the one the scan saw, so a pid reused
//!   since the scan is `no-host`, never somebody else's window.
//!
//! The decisions ([`host_of_windows`], [`pick_window`], [`role`]) are plain functions over
//! plain data, tested on every OS; only [`os`] calls Windows.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use super::{HostApp, HostTarget};
use crate::procscan::os::RawProc;

/// GUI hosts a `claude` commonly runs under, by executable file name (any case) → the name
/// the village shows.
pub const KNOWN_HOSTS: &[(&str, &str)] = &[
    ("WindowsTerminal.exe", "Windows Terminal"),
    ("Code.exe", "VS Code"),
    ("Code - Insiders.exe", "VS Code Insiders"),
    ("Cursor.exe", "Cursor"),
    ("Windsurf.exe", "Windsurf"),
    ("Zed.exe", "Zed"),
    ("devenv.exe", "Visual Studio"),
    ("idea64.exe", "IntelliJ IDEA"),
    ("idea.exe", "IntelliJ IDEA"),
    ("pycharm64.exe", "PyCharm"),
    ("webstorm64.exe", "WebStorm"),
    ("goland64.exe", "GoLand"),
    ("clion64.exe", "CLion"),
    ("rider64.exe", "Rider"),
    ("phpstorm64.exe", "PhpStorm"),
    ("rubymine64.exe", "RubyMine"),
    ("datagrip64.exe", "DataGrip"),
    ("rustrover64.exe", "RustRover"),
    ("studio64.exe", "Android Studio"),
    ("wezterm-gui.exe", "WezTerm"),
    ("alacritty.exe", "Alacritty"),
    ("Hyper.exe", "Hyper"),
    ("Tabby.exe", "Tabby"),
    ("ConEmu64.exe", "ConEmu"),
    ("ConEmu.exe", "ConEmu"),
    ("mintty.exe", "Git Bash"),
];

/// Shells: a host only when they own a visible window themselves (a classic console).
const SHELLS: &[(&str, &str)] = &[
    ("powershell.exe", "Windows PowerShell"),
    ("pwsh.exe", "PowerShell"),
    ("cmd.exe", "Command Prompt"),
    ("bash.exe", "bash"),
    ("sh.exe", "sh"),
    ("zsh.exe", "zsh"),
    ("fish.exe", "fish"),
    ("nu.exe", "Nushell"),
];

/// Never a host, walked through: console hosts and `claude`'s own process layers.
const PASS_THROUGH: &[&str] = &[
    "conhost.exe",
    "openconsole.exe",
    "claude.exe",
    "node.exe",
    "wsl.exe",
    "wslhost.exe",
    "winpty-agent.exe",
];

/// Reaching one of these ends the walk with no host: the desktop shell and the session's
/// system processes are above every app, never the app.
const STOP: &[&str] = &[
    "explorer.exe",
    "svchost.exe",
    "services.exe",
    "wininit.exe",
    "winlogon.exe",
    "userinit.exe",
    "sihost.exe",
    "smss.exe",
    "csrss.exe",
    "runtimebroker.exe",
    "system",
];

/// What an ancestor is to the walk.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Host(&'static str),
    Shell(&'static str),
    PassThrough,
    Stop,
    Other,
}

/// `C:\Program Files\Git\usr\bin\bash.exe` → `bash.exe` (either separator).
pub fn file_name(exe: &str) -> &str {
    exe.rsplit(['\\', '/']).next().unwrap_or(exe)
}

/// The walk's view of an executable file name (any case).
pub fn role(file: &str) -> Role {
    let is = |n: &str| file.eq_ignore_ascii_case(n);
    if let Some((_, name)) = KNOWN_HOSTS.iter().find(|(f, _)| is(f)) {
        return Role::Host(name);
    }
    if let Some((_, name)) = SHELLS.iter().find(|(f, _)| is(f)) {
        return Role::Shell(name);
    }
    if PASS_THROUGH.iter().any(|f| is(f)) {
        return Role::PassThrough;
    }
    if STOP.iter().any(|f| is(f)) {
        return Role::Stop;
    }
    Role::Other
}

/// `Foo Bar.exe` → `Foo Bar`: the generic display name.
fn stem(file: &str) -> String {
    let lower = file.to_ascii_lowercase();
    match lower.strip_suffix(".exe") {
        Some(s) => file[..s.len()].to_string(),
        None => file.to_string(),
    }
}

fn exe_of(p: &RawProc) -> String {
    p.exe
        .clone()
        .or_else(|| p.argv.first().cloned())
        .unwrap_or_default()
}

fn window_host(p: &RawProc, name: String) -> HostApp {
    HostApp {
        name,
        target: HostTarget::Window {
            pid: p.pid,
            exe: p.exe.as_ref().map(PathBuf::from),
        },
    }
}

/// `child`'s parent in `by_pid`, unless the link is not trustworthy: missing, itself, or a
/// process that started AFTER the child (Windows keeps a dead parent's pid in `ppid`, and
/// the number may since belong to someone else).
fn parent_of<'a>(child: &RawProc, by_pid: &HashMap<u32, &'a RawProc>) -> Option<&'a RawProc> {
    let parent = *by_pid.get(&child.ppid)?;
    if parent.pid == child.pid {
        return None;
    }
    match (parent.started_ms, child.started_ms) {
        (Some(p), Some(c)) if p > c => None,
        _ => Some(parent),
    }
}

/// The GUI host of the `claude` process `pid` (module doc). `windowed` = the pids owning a
/// visible top-level window ([`windowed_pids`]). Bounded and cycle-safe.
pub fn host_of_windows(
    pid: u32,
    by_pid: &HashMap<u32, &RawProc>,
    windowed: &HashSet<u32>,
) -> Option<HostApp> {
    let mut seen = HashSet::from([pid]);
    let mut child = *by_pid.get(&pid)?;
    while seen.len() <= 64 {
        let parent = parent_of(child, by_pid)?;
        if !seen.insert(parent.pid) {
            return None;
        }
        let exe = exe_of(parent);
        let file = file_name(&exe);
        match role(file) {
            Role::Stop => return None,
            Role::Host(name) => return Some(climb_same(parent, by_pid, windowed, name)),
            Role::Shell(name) if windowed.contains(&parent.pid) => {
                return Some(window_host(parent, name.to_string()))
            }
            Role::Other if windowed.contains(&parent.pid) && !file.is_empty() => {
                return Some(window_host(parent, stem(file)))
            }
            _ => {}
        }
        child = parent;
    }
    None
}

/// From a known host process, the same-named ancestor that owns a window (VS Code: the
/// terminal's `Code.exe` is a helper; the window belongs to the main `Code.exe` above it) —
/// else the topmost same-named one.
fn climb_same(
    start: &RawProc,
    by_pid: &HashMap<u32, &RawProc>,
    windowed: &HashSet<u32>,
    name: &str,
) -> HostApp {
    let file = file_name(&exe_of(start)).to_ascii_lowercase();
    let mut at = start;
    let mut seen = HashSet::from([start.pid]);
    loop {
        if windowed.contains(&at.pid) {
            break;
        }
        match parent_of(at, by_pid) {
            Some(p)
                if seen.insert(p.pid)
                    && seen.len() <= 64
                    && file_name(&exe_of(p)).eq_ignore_ascii_case(&file) =>
            {
                at = p
            }
            _ => break,
        }
    }
    window_host(at, name.to_string())
}

/// One top-level window, as `EnumWindows` reports it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TopWindow {
    /// The `HWND`, as an integer (only ever handed back to the OS).
    pub hwnd: isize,
    pub pid: u32,
    pub visible: bool,
    /// Has an owner (a dialog, a popup) — not an app's main window.
    pub owned: bool,
    /// `WS_EX_TOOLWINDOW` — not on the taskbar.
    pub tool: bool,
    pub titled: bool,
}

impl TopWindow {
    fn is_main(&self) -> bool {
        self.visible && !self.owned && !self.tool
    }
}

/// The pids owning a main window — the host walk's "owns a visible top-level window".
pub fn windowed_pids(windows: &[TopWindow]) -> HashSet<u32> {
    windows
        .iter()
        .filter(|w| w.is_main())
        .map(|w| w.pid)
        .collect()
}

/// The window to bring forward for `pid`: its first main window in Z order (`EnumWindows`
/// enumerates top-down, so that is the one the user used last), a titled one preferred.
pub fn pick_window(windows: &[TopWindow], pid: u32) -> Option<isize> {
    let mine = || windows.iter().filter(|w| w.pid == pid && w.is_main());
    mine()
        .find(|w| w.titled)
        .or_else(|| mine().next())
        .map(|w| w.hwnd)
}

/// Same file, as Windows compares paths (ASCII case-insensitive, either separator).
pub fn same_image(a: &str, b: &str) -> bool {
    let norm = |s: &str| s.replace('/', "\\").to_ascii_lowercase();
    norm(a) == norm(b)
}

/// Bring `pid`'s main window to the front ([`pick_window`]), after checking that `pid` is
/// still `exe` (when known). Errors are the command's codes: `no-host` (gone, reused, or no
/// window), `open-failed` (Windows refused).
#[cfg(windows)]
pub fn focus_window(pid: u32, exe: Option<&std::path::Path>) -> Result<(), String> {
    if let Some(exe) = exe {
        let now = crate::pty::winproc::details(pid).1;
        let same = now
            .as_deref()
            .is_some_and(|n| same_image(&n.to_string_lossy(), &exe.to_string_lossy()));
        if !same {
            return Err("no-host: that app is no longer running".to_string());
        }
    }
    let hwnd = pick_window(&os::top_level_windows(), pid)
        .ok_or_else(|| "no-host: that app has no window to show".to_string())?;
    os::bring_forward(hwnd)
}

/// Off Windows there is no window to find.
#[cfg(not(windows))]
pub fn focus_window(_pid: u32, _exe: Option<&std::path::Path>) -> Result<(), String> {
    Err("unsupported: focusing a window is Windows-only".to_string())
}

/// The pids owning a main window right now (empty off Windows).
pub fn windowed_now() -> HashSet<u32> {
    #[cfg(windows)]
    {
        windowed_pids(&os::top_level_windows())
    }
    #[cfg(not(windows))]
    {
        HashSet::new()
    }
}

/// The only Windows calls: `EnumWindows` and friends, `ShowWindow`, `SetForegroundWindow`.
#[cfg(windows)]
pub mod os {
    use super::TopWindow;
    use windows_sys::core::BOOL;
    use windows_sys::Win32::Foundation::{HWND, LPARAM};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindow, GetWindowLongW, GetWindowTextLengthW, GetWindowThreadProcessId,
        IsIconic, IsWindowVisible, SetForegroundWindow, ShowWindow, GWL_EXSTYLE, GW_OWNER,
        SW_RESTORE, WS_EX_TOOLWINDOW,
    };

    unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> BOOL {
        // SAFETY: `lparam` is the `&mut Vec<TopWindow>` passed by `top_level_windows`, alive
        // for the whole synchronous `EnumWindows` call.
        let out = unsafe { &mut *(lparam as *mut Vec<TopWindow>) };
        let mut pid = 0u32;
        // SAFETY: `hwnd` comes from EnumWindows; the out-pointer is a valid u32.
        unsafe {
            GetWindowThreadProcessId(hwnd, &mut pid);
            out.push(TopWindow {
                hwnd: hwnd as isize,
                pid,
                visible: IsWindowVisible(hwnd) != 0,
                owned: !GetWindow(hwnd, GW_OWNER).is_null(),
                tool: (GetWindowLongW(hwnd, GWL_EXSTYLE) as u32) & WS_EX_TOOLWINDOW != 0,
                titled: GetWindowTextLengthW(hwnd) > 0,
            });
        }
        1
    }

    /// Every top-level window, in Z order (top first).
    pub fn top_level_windows() -> Vec<TopWindow> {
        let mut out: Vec<TopWindow> = Vec::new();
        // SAFETY: `collect` only casts `lparam` back to this Vec, which outlives the call.
        unsafe { EnumWindows(Some(collect), &mut out as *mut Vec<TopWindow> as LPARAM) };
        out
    }

    /// Restore `hwnd` if minimised, then make it the foreground window.
    pub fn bring_forward(hwnd: isize) -> Result<(), String> {
        let hwnd = hwnd as HWND;
        // SAFETY: plain calls on a window handle; a stale handle makes them fail, not crash.
        unsafe {
            if IsIconic(hwnd) != 0 {
                ShowWindow(hwnd, SW_RESTORE);
            }
            if SetForegroundWindow(hwnd) == 0 {
                return Err("open-failed: Windows did not switch to that window".to_string());
            }
        }
        Ok(())
    }

    /// Is `hwnd` minimised? (For the tests.)
    pub fn is_minimised(hwnd: isize) -> bool {
        // SAFETY: plain call on a window handle.
        unsafe { IsIconic(hwnd as HWND) != 0 }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(pid: u32, ppid: u32, exe: &str, started: i64) -> RawProc {
        RawProc {
            pid,
            ppid,
            exe: (!exe.is_empty()).then(|| exe.to_string()),
            argv: Vec::new(),
            cwd: None,
            started_ms: Some(started),
            fds: Vec::new(),
        }
    }

    fn window(pid: u32, exe: &str, name: &str) -> HostApp {
        HostApp {
            name: name.to_string(),
            target: HostTarget::Window {
                pid,
                exe: (!exe.is_empty()).then(|| PathBuf::from(exe)),
            },
        }
    }

    const WT: &str =
        r"C:\Program Files\WindowsApps\Microsoft.WindowsTerminal_1.21\WindowsTerminal.exe";
    const CODE: &str = r"C:\Users\me\AppData\Local\Programs\Microsoft VS Code\Code.exe";
    const PS: &str = r"C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe";
    const CLAUDE: &str = r"C:\Users\me\.local\bin\claude.exe";
    const EXPLORER: &str = r"C:\WINDOWS\explorer.exe";

    #[test]
    fn roles_by_file_name_any_case() {
        assert_eq!(role("WINDOWSTERMINAL.EXE"), Role::Host("Windows Terminal"));
        assert_eq!(role("code.exe"), Role::Host("VS Code"));
        assert_eq!(role("idea64.exe"), Role::Host("IntelliJ IDEA"));
        assert_eq!(role("pwsh.exe"), Role::Shell("PowerShell"));
        assert_eq!(role("OpenConsole.exe"), Role::PassThrough);
        assert_eq!(role("Explorer.EXE"), Role::Stop);
        assert_eq!(role("MyEditor.exe"), Role::Other);
        assert_eq!(file_name(CODE), "Code.exe");
        assert_eq!(file_name("/c/x/y.exe"), "y.exe");
        assert_eq!(stem("Foo Bar.EXE"), "Foo Bar");
        assert_eq!(stem("noext"), "noext");
    }

    /// Every real shape, with every expectation written out.
    #[test]
    fn the_windows_host_is_the_first_gui_ancestor() {
        let table = [
            // Windows Terminal: claude → powershell → WindowsTerminal (its own window).
            raw(100, 99, CLAUDE, 50),
            raw(99, 98, PS, 40),
            raw(98, 10, WT, 30),
            raw(10, 4, EXPLORER, 1),
            // VS Code: claude → pwsh → Code (pty host) → Code (main, owns the window).
            raw(200, 199, CLAUDE, 50),
            raw(199, 198, r"C:\Program Files\PowerShell\7\pwsh.exe", 40),
            raw(198, 197, CODE, 30),
            raw(197, 10, CODE, 20),
            // A classic console window: claude → cmd (owns the console window) → explorer.
            raw(300, 299, CLAUDE, 50),
            raw(299, 10, r"C:\WINDOWS\system32\cmd.exe", 40),
            // Started from Explorer with no window of its own (default-terminal handoff):
            // claude → powershell → explorer → nothing.
            raw(400, 399, CLAUDE, 50),
            raw(399, 10, PS, 40),
            // An unknown GUI app that owns a window: generic, named by its exe.
            raw(500, 499, CLAUDE, 50),
            raw(499, 498, PS, 40),
            raw(498, 10, r"D:\Tools\My Editor.exe", 30),
            // The npm install: claude is node.exe; conhost in the chain is walked through.
            raw(600, 599, r"C:\Program Files\nodejs\node.exe", 50),
            raw(599, 598, r"C:\WINDOWS\system32\conhost.exe", 45),
            raw(598, 98, PS, 40),
            // A reused pid: the "parent" started after its child.
            raw(700, 701, CLAUDE, 50),
            raw(701, 10, WT, 60),
            // A cycle, a dangling parent, a self-parent.
            raw(800, 801, CLAUDE, 50),
            raw(801, 800, PS, 40),
            raw(900, 4242, CLAUDE, 50),
            raw(950, 950, CLAUDE, 50),
        ];
        let by_pid: HashMap<u32, &RawProc> = table.iter().map(|p| (p.pid, p)).collect();
        let windowed: HashSet<u32> = [98, 197, 299, 498, 10].into_iter().collect();
        let host = |pid| host_of_windows(pid, &by_pid, &windowed);
        assert_eq!(host(100), Some(window(98, WT, "Windows Terminal")));
        assert_eq!(
            host(200),
            Some(window(197, CODE, "VS Code")),
            "the window's Code.exe"
        );
        assert_eq!(
            host(300),
            Some(window(
                299,
                r"C:\WINDOWS\system32\cmd.exe",
                "Command Prompt"
            ))
        );
        assert_eq!(host(400), None, "Explorer is not the host");
        assert_eq!(
            host(500),
            Some(window(498, r"D:\Tools\My Editor.exe", "My Editor"))
        );
        assert_eq!(host(600), Some(window(98, WT, "Windows Terminal")));
        assert_eq!(
            host(700),
            None,
            "a parent younger than its child is a reused pid"
        );
        assert_eq!(host(800), None, "a cycle ends the walk");
        assert_eq!(host(900), None);
        assert_eq!(host(950), None);
        assert_eq!(host(12345), None, "not in the table");

        // A known host with no window anywhere up its chain: the topmost same-named one.
        let none: HashSet<u32> = HashSet::new();
        assert_eq!(
            host_of_windows(200, &by_pid, &none),
            Some(window(197, CODE, "VS Code"))
        );
        // Without windows, a shell or an unknown app is never a host.
        assert_eq!(host_of_windows(300, &by_pid, &none), None);
        assert_eq!(host_of_windows(500, &by_pid, &none), None);
    }

    fn w(hwnd: isize, pid: u32, visible: bool, owned: bool, tool: bool, titled: bool) -> TopWindow {
        TopWindow {
            hwnd,
            pid,
            visible,
            owned,
            tool,
            titled,
        }
    }

    #[test]
    fn the_window_to_focus_is_the_apps_first_main_window_preferring_a_title() {
        let wins = [
            w(1, 7, false, false, false, true), // hidden
            w(2, 7, true, true, false, true),   // a dialog (owned)
            w(3, 7, true, false, true, true),   // a tool window
            w(4, 7, true, false, false, false), // untitled main window
            w(5, 8, true, false, false, true),  // another app's
            w(6, 7, true, false, false, true),  // titled main window, lower in Z order
        ];
        assert_eq!(pick_window(&wins, 7), Some(6));
        assert_eq!(
            pick_window(&wins[..5], 7),
            Some(4),
            "untitled when that is all"
        );
        assert_eq!(pick_window(&wins[..3], 7), None);
        assert_eq!(pick_window(&wins, 9), None);
        assert_eq!(windowed_pids(&wins), HashSet::from([7, 8]));
        assert!(windowed_pids(&wins[..3]).is_empty());
    }

    #[test]
    fn image_paths_compare_as_windows_does() {
        assert!(same_image(
            r"C:\Program Files\X\Code.exe",
            "c:/program files/x/code.EXE"
        ));
        assert!(!same_image(r"C:\a\Code.exe", r"C:\b\Code.exe"));
    }

    /// The real thing: a window owned by a process we start (a WinForms form in a child
    /// PowerShell) is found by that pid, minimised, and restored by the focus — and a pid
    /// with no window, or a pid whose image is not the expected one, is `no-host`.
    /// A child process killed when the test ends, pass or panic.
    #[cfg(windows)]
    struct Reaped(std::process::Child);

    #[cfg(windows)]
    impl Drop for Reaped {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    #[cfg(windows)]
    #[test]
    fn on_windows_a_childs_window_is_found_by_pid_and_restored() {
        use crate::spawn::NoWindow as _;
        let title = format!("agentstudio-focus-{}", ulid::Ulid::new());
        let script = format!(
            "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object Windows.Forms.Form; \
             $f.Text = '{title}'; $f.ShowDialog() | Out-Null"
        );
        let form = Reaped(
            std::process::Command::new("powershell")
                .args(["-NoProfile", "-NonInteractive", "-Command", &script])
                .no_window()
                .spawn()
                .expect("powershell runs"),
        );
        let pid = form.0.id();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        let hwnd = loop {
            if let Some(h) = pick_window(&os::top_level_windows(), pid) {
                break h;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "the form's window never appeared under pid {pid}"
            );
            std::thread::sleep(std::time::Duration::from_millis(200));
        };
        assert!(windowed_now().contains(&pid));
        // Minimise it, then focus: restored either way; foreground only if Windows lets this
        // (background) test process take it — the IDE, foreground at click time, is allowed.
        // SAFETY: plain call on the window handle found above.
        unsafe {
            windows_sys::Win32::UI::WindowsAndMessaging::ShowWindow(
                hwnd as windows_sys::Win32::Foundation::HWND,
                windows_sys::Win32::UI::WindowsAndMessaging::SW_MINIMIZE,
            );
        }
        assert!(os::is_minimised(hwnd));
        let exe = crate::pty::winproc::details(pid).1.expect("its image path");
        let got = focus_window(pid, Some(&exe));
        println!("focus_window -> {got:?}");
        assert!(
            got.is_ok() || got.as_ref().is_err_and(|e| e.starts_with("open-failed:")),
            "{got:?}"
        );
        assert!(!os::is_minimised(hwnd), "restored");
        // The wrong image for that pid: refused before any window is touched.
        let err = focus_window(pid, Some(std::path::Path::new(r"C:\not\it.exe")));
        assert!(
            err.as_ref().is_err_and(|e| e.starts_with("no-host:")),
            "{err:?}"
        );
        // A process with no window at all (a console program started without one).
        let quiet = Reaped(
            std::process::Command::new("ping")
                .args(["-n", "30", "127.0.0.1"])
                .stdout(std::process::Stdio::null())
                .no_window()
                .spawn()
                .expect("ping runs"),
        );
        let err = focus_window(quiet.0.id(), None);
        assert!(
            err.as_ref().is_err_and(|e| e.starts_with("no-host:")),
            "{err:?}"
        );
    }
}
