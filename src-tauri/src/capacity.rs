//! Agent Village **capacity**: both the City and the Village show
//! the agent seats in use and the seats still available, and also the memory available for
//! agents, since more agents are started whenever the machine has room for them.
//!
//! One read-only command, [`machine_capacity`]: how many logical CPUs this machine offers, how
//! much RAM it has and how much of it is available, and how much of it this user's `claude`
//! processes hold — plus the processes those started (MCP servers, shells, dev servers).
//!
//! The CPU count is returned RAW. The Village turns it into "seats" with Claude Code's own rule
//! for how many workflow agents run at once (`min(16, max(2, CPUs − 2))`, read off the installed
//! CLI 2.1.300 and documented under `CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS`), so the formula
//! and the caption that names it as an estimate live side by side in one place
//! (`src/features/village/capacityModel.ts`).
//!
//! | need | macOS | Linux | Windows | other |
//! |---|---|---|---|---|
//! | logical CPUs | [`std::thread::available_parallelism`] — the count Node's `os.availableParallelism()`, i.e. Claude Code, reads | same | same | same |
//! | total RAM | `sysctlbyname("hw.memsize")` | `/proc/meminfo` `MemTotal` | `GlobalMemoryStatusEx` `ullTotalPhys` | — |
//! | available RAM | `host_statistics64(HOST_VM_INFO64)`: total − (app + wired + compressed), Activity Monitor's "Memory Used" ([`mac_available`]) | `MemAvailable` | `GlobalMemoryStatusEx` `ullAvailPhys` (Task Manager's "Available": free + standby) | — |
//! | a process's memory | `proc_pidinfo(PROC_PIDTASKINFO)` resident size | `/proc/<pid>/statm` resident pages | `K32GetProcessMemoryInfo` `WorkingSetSize` (limited access) | — |
//! | which processes | [`crate::procscan::os::list`] + [`crate::procscan::ide::is_claude_cli`] | same | same (the user SID's processes) | — |
//!
//! **Reads only.** No file is written, no process is signalled, nothing under `~/.claude` is
//! touched — the process table and two kernel counters are the whole input. No OS
//! permission is needed for any of it: every call reads this user's own processes.
//!
//! The IDE's own one-shot probes (`claude -p --no-session-persistence "/usage"` every few
//! seconds, `"/context"` on demand — see `usage.rs`, `context_usage.rs`) are left out
//! ([`is_probe`]): they are not agents, and counting them would make the agents' figure blink
//! every time the usage strip polls.
//!
//! Resident memory is summed per process, so pages two processes share are counted for both —
//! the panel says "resident memory", never "exclusive".

use std::collections::{HashMap, HashSet};

use serde::Serialize;

use crate::procscan::ide::is_claude_cli;
use crate::procscan::os::RawProc;

/// Wire `MachineCapacity` (camelCase). Every figure is `null` when this OS gives no way to read
/// it — "unknown", never a zero that would read as "nothing".
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineCapacity {
    /// Logical CPUs available to this process.
    pub logical_cpus: Option<u32>,
    /// Physical RAM, bytes.
    pub total_mem_bytes: Option<u64>,
    /// RAM available to start more programs without swapping, bytes (never above the total).
    pub available_mem_bytes: Option<u64>,
    /// What this user's agents hold; `null` where the OS gives no process table.
    pub agents: Option<AgentMemory>,
    /// When this sample was taken, unix ms.
    pub sampled_at_ms: u64,
}

/// The agents' share of the machine's memory.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMemory {
    /// Live `claude` sessions: CLI processes whose parent is not itself a `claude`.
    pub sessions: u32,
    /// Every counted `claude` CLI process — the sessions and their own `claude` helpers.
    pub claude_processes: u32,
    /// Their summed resident memory, bytes.
    pub claude_rss_bytes: u64,
    /// The other processes descended from them (MCP servers, shells, dev servers), each once.
    pub tool_processes: u32,
    /// Their summed resident memory, bytes.
    pub tool_rss_bytes: u64,
}

/// A one-shot print-mode run that keeps no session — the IDE's own `/usage` and `/context`
/// reads (and anything shaped like them). Flags only count after the program name.
pub fn is_probe(argv: &[String]) -> bool {
    let has = |flag: &str| argv.iter().skip(1).any(|a| a == flag);
    (has("-p") || has("--print")) && has("--no-session-persistence")
}

/// What this user's agents hold, from a process `table`: every `claude` CLI process except
/// one-shot probes ([`is_probe`]), and every non-`claude` process descended from one of them,
/// each counted once. `rss` reads one process's resident bytes; a process it cannot read (gone
/// since the table was taken) still counts as a process, with 0 bytes.
///
/// Pure over its inputs, so the accounting is tested on a fake table. Bounded on a malformed
/// table: a ppid cycle is walked once (`seen`).
pub fn agent_memory(table: &[RawProc], rss: impl Fn(u32) -> Option<u64>) -> AgentMemory {
    let is_claude = |p: &RawProc| is_claude_cli(p.exe.as_deref(), &p.argv);
    let by_pid: HashMap<u32, &RawProc> = table.iter().map(|p| (p.pid, p)).collect();
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for p in table {
        if p.ppid != p.pid {
            children.entry(p.ppid).or_default().push(p.pid);
        }
    }

    let mut out = AgentMemory::default();
    let mut stack: Vec<u32> = Vec::new();
    for p in table.iter().filter(|p| is_claude(p) && !is_probe(&p.argv)) {
        out.claude_processes += 1;
        out.claude_rss_bytes += rss(p.pid).unwrap_or(0);
        if !by_pid.get(&p.ppid).is_some_and(|parent| is_claude(parent)) {
            out.sessions += 1;
        }
        stack.push(p.pid);
    }

    // The processes they started: walk down from every counted claude. A claude met on the way
    // is already counted above (or is a probe, deliberately not counted) — but what IT started
    // is still walked.
    let mut seen: HashSet<u32> = stack.iter().copied().collect();
    while let Some(pid) = stack.pop() {
        for &child in children.get(&pid).map(Vec::as_slice).unwrap_or(&[]) {
            if !seen.insert(child) {
                continue;
            }
            stack.push(child);
            if by_pid.get(&child).is_some_and(|c| is_claude(c)) {
                continue;
            }
            out.tool_processes += 1;
            out.tool_rss_bytes += rss(child).unwrap_or(0);
        }
    }
    out
}

/// Page counts from `vm_statistics64` that decide macOS's "Memory Used" (each in pages).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct VmCounts {
    /// Anonymous memory (`internal_page_count`).
    pub internal: u64,
    /// The part of it the system may discard at will (`purgeable_count`).
    pub purgeable: u64,
    /// Wired down (`wire_count`).
    pub wired: u64,
    /// Held by the compressor (`compressor_page_count`).
    pub compressed: u64,
}

/// macOS's available memory, as Activity Monitor counts it: total minus "Memory Used" (App
/// Memory = anonymous − purgeable, plus Wired, plus Compressed). The rest — free pages and
/// cached files — can be handed to a new program without swapping. Never negative.
pub fn mac_available(total_bytes: u64, vm: VmCounts, page_bytes: u64) -> u64 {
    let used_pages = vm.internal.saturating_sub(vm.purgeable) + vm.wired + vm.compressed;
    total_bytes.saturating_sub(used_pages.saturating_mul(page_bytes))
}

/// `/proc/meminfo` → `(MemTotal, MemAvailable)` in bytes (the file says kB, meaning KiB).
pub fn parse_meminfo(text: &str) -> (Option<u64>, Option<u64>) {
    let field = |name: &str| -> Option<u64> {
        let rest = text.lines().find_map(|l| l.strip_prefix(name))?;
        let kib: u64 = rest
            .trim_start_matches(':')
            .split_whitespace()
            .next()?
            .parse()
            .ok()?;
        kib.checked_mul(1024)
    };
    (field("MemTotal:"), field("MemAvailable:"))
}

/// `/proc/<pid>/statm` → resident pages (its second field).
pub fn parse_statm_resident(text: &str) -> Option<u64> {
    text.split_whitespace().nth(1)?.parse().ok()
}

/// Logical CPUs available to this process (`None` only where the platform cannot say).
pub fn logical_cpus() -> Option<u32> {
    std::thread::available_parallelism()
        .ok()
        .map(|n| u32::try_from(n.get()).unwrap_or(u32::MAX))
}

/// A whole sample of this machine. Blocking (it reads the process table): call it off the
/// async runtime, as [`machine_capacity`] does.
pub fn sample() -> MachineCapacity {
    let (total, available) = os::memory();
    MachineCapacity {
        logical_cpus: logical_cpus(),
        total_mem_bytes: total,
        available_mem_bytes: available.map(|a| total.map_or(a, |t| a.min(t))),
        agents: agent_table().map(|table| agent_memory(&table, os::rss)),
        sampled_at_ms: now_ms(),
    }
}

/// This user's process table, or `None` where the OS gives none.
fn agent_table() -> Option<Vec<RawProc>> {
    if !crate::procscan::os::AVAILABLE {
        return None;
    }
    let uid = crate::procscan::os::my_uid()?;
    Some(crate::procscan::os::list(uid))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

/// `machine_capacity` — the Village's Seats / Memory buildings. Read-only; polled by the panel
/// only while the Village tab is on screen and the window is visible.
#[tauri::command]
pub async fn machine_capacity() -> Result<MachineCapacity, String> {
    tokio::task::spawn_blocking(sample)
        .await
        .map_err(|_| "unknown: the capacity sample did not finish".to_string())
}

#[cfg(target_os = "macos")]
mod os {
    use super::{mac_available, VmCounts};
    use std::ffi::c_void;
    use std::sync::OnceLock;

    /// `hw.memsize`, bytes.
    fn total() -> Option<u64> {
        let mut bytes: u64 = 0;
        let mut size = std::mem::size_of::<u64>();
        // SAFETY: a NUL-terminated name; `bytes` is a writable u64 and `size` says so.
        let r = unsafe {
            libc::sysctlbyname(
                c"hw.memsize".as_ptr(),
                &mut bytes as *mut u64 as *mut c_void,
                &mut size,
                std::ptr::null_mut(),
                0,
            )
        };
        (r == 0 && size == std::mem::size_of::<u64>() && bytes > 0).then_some(bytes)
    }

    /// The host port, asked for ONCE: every `mach_host_self()` call adds a send-right
    /// reference, so polling it every few seconds would leak one per sample.
    fn host() -> libc::mach_port_t {
        static HOST: OnceLock<libc::mach_port_t> = OnceLock::new();
        // SAFETY: no preconditions; the right is kept for the life of the process.
        #[allow(deprecated)]
        *HOST.get_or_init(|| unsafe { libc::mach_host_self() })
    }

    fn vm_counts() -> Option<VmCounts> {
        // SAFETY: zero-initialised and the count names exactly its size in integer_t units.
        let mut vm: libc::vm_statistics64 = unsafe { std::mem::zeroed() };
        let mut count = libc::HOST_VM_INFO64_COUNT;
        let r = unsafe {
            libc::host_statistics64(
                host(),
                libc::HOST_VM_INFO64,
                &mut vm as *mut libc::vm_statistics64 as libc::host_info64_t,
                &mut count,
            )
        };
        (r == libc::KERN_SUCCESS).then(|| VmCounts {
            internal: u64::from(vm.internal_page_count),
            purgeable: u64::from(vm.purgeable_count),
            wired: u64::from(vm.wire_count),
            compressed: u64::from(vm.compressor_page_count),
        })
    }

    fn page_bytes() -> u64 {
        // SAFETY: sysconf has no preconditions.
        let p = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
        u64::try_from(p).ok().filter(|p| *p > 0).unwrap_or(4096)
    }

    pub fn memory() -> (Option<u64>, Option<u64>) {
        let total = total();
        let available = match (total, vm_counts()) {
            (Some(t), Some(vm)) => Some(mac_available(t, vm, page_bytes())),
            _ => None,
        };
        (total, available)
    }

    pub fn rss(pid: u32) -> Option<u64> {
        // SAFETY: zero-initialised, exact size passed; the kernel writes at most that.
        let mut info: libc::proc_taskinfo = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of::<libc::proc_taskinfo>() as i32;
        let n = unsafe {
            libc::proc_pidinfo(
                pid as i32,
                libc::PROC_PIDTASKINFO,
                0,
                &mut info as *mut libc::proc_taskinfo as *mut c_void,
                size,
            )
        };
        (n == size).then_some(info.pti_resident_size)
    }
}

#[cfg(target_os = "linux")]
mod os {
    use super::{parse_meminfo, parse_statm_resident};

    pub fn memory() -> (Option<u64>, Option<u64>) {
        std::fs::read_to_string("/proc/meminfo")
            .map(|text| parse_meminfo(&text))
            .unwrap_or((None, None))
    }

    pub fn rss(pid: u32) -> Option<u64> {
        let pages =
            parse_statm_resident(&std::fs::read_to_string(format!("/proc/{pid}/statm")).ok()?)?;
        // SAFETY: sysconf has no preconditions.
        let page = u64::try_from(unsafe { libc::sysconf(libc::_SC_PAGESIZE) }).ok()?;
        pages.checked_mul(page)
    }
}

#[cfg(windows)]
mod os {
    use crate::procscan::winproc;
    use windows_sys::Win32::System::ProcessStatus::{
        K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS,
    };
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    use windows_sys::Win32::System::Threading::PROCESS_QUERY_LIMITED_INFORMATION;

    /// `(ullTotalPhys, ullAvailPhys)`.
    pub fn memory() -> (Option<u64>, Option<u64>) {
        let mut s = MEMORYSTATUSEX {
            dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
            ..Default::default()
        };
        // SAFETY: a writable `MEMORYSTATUSEX` whose `dwLength` is set, as the API requires.
        if unsafe { GlobalMemoryStatusEx(&mut s) } == 0 || s.ullTotalPhys == 0 {
            return (None, None);
        }
        (Some(s.ullTotalPhys), Some(s.ullAvailPhys))
    }

    /// The working set — Windows' resident memory (Task Manager's "Memory" column is the
    /// private working set; this is the whole one, the same thing `ps`'s RSS counts).
    pub fn rss(pid: u32) -> Option<u64> {
        let h = winproc::open(pid, PROCESS_QUERY_LIMITED_INFORMATION)?;
        let mut c = PROCESS_MEMORY_COUNTERS {
            cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
            ..Default::default()
        };
        // SAFETY: a live process handle and a writable struct whose size is passed.
        let ok = unsafe { K32GetProcessMemoryInfo(h.raw(), &mut c, c.cb) };
        (ok != 0).then_some(c.WorkingSetSize as u64)
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
mod os {
    pub fn memory() -> (Option<u64>, Option<u64>) {
        (None, None)
    }

    pub fn rss(_pid: u32) -> Option<u64> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIB: u64 = 1024 * 1024;

    fn proc_(pid: u32, ppid: u32, exe: &str, args: &[&str]) -> RawProc {
        let mut argv = vec![exe.rsplit('/').next().unwrap_or(exe).to_string()];
        argv.extend(args.iter().map(|a| a.to_string()));
        RawProc {
            pid,
            ppid,
            exe: Some(exe.to_string()),
            argv,
            cwd: None,
            started_ms: None,
            fds: Vec::new(),
        }
    }

    const CLAUDE: &str = "/Users/u/.local/share/claude/versions/2.1.300";

    /// The resident size this fake table reports: pid × 1 MiB (pid 0 = unreadable).
    fn rss_of(pid: u32) -> Option<u64> {
        (pid != 0 && pid != 99).then_some(u64::from(pid) * MIB)
    }

    #[test]
    fn sessions_helpers_and_the_tools_they_started_are_counted_once_each() {
        let table = vec![
            proc_(1, 0, "/sbin/launchd", &[]),
            proc_(10, 1, "/bin/zsh", &["-l"]),
            // A session in a terminal, with a claude helper and two tools.
            proc_(20, 10, CLAUDE, &[]),
            proc_(21, 20, CLAUDE, &["--mcp-helper"]),
            proc_(22, 20, "/usr/local/bin/node", &["mcp-server.js"]),
            proc_(23, 22, "/usr/bin/python3", &["child.py"]), // a grandchild: also a tool
            proc_(24, 21, "/bin/sh", &["-c", "rg foo"]),      // started by the helper: a tool
            // A second session (started by its full path through npm).
            proc_(
                30,
                10,
                "/opt/homebrew/bin/node",
                &["/x/node_modules/@anthropic-ai/claude-code/cli.js"],
            ),
            // Unrelated processes, including one the shell started.
            proc_(40, 10, "/usr/bin/vim", &["notes.md"]),
            proc_(50, 1, "/Applications/Safari.app/Contents/MacOS/Safari", &[]),
        ];
        let m = agent_memory(&table, rss_of);
        assert_eq!(
            m.sessions, 2,
            "20 and 30 are sessions; 21's parent is a claude"
        );
        assert_eq!(m.claude_processes, 3);
        assert_eq!(m.claude_rss_bytes, (20 + 21 + 30) * MIB);
        assert_eq!(
            m.tool_processes, 3,
            "22, 23 and 24 — never vim (the shell's), never Safari"
        );
        assert_eq!(m.tool_rss_bytes, (22 + 23 + 24) * MIB);
    }

    #[test]
    fn the_ides_own_one_shot_probes_are_not_agents() {
        let table = vec![
            proc_(1, 0, "/sbin/launchd", &[]),
            proc_(
                5,
                1,
                "/Applications/Agent Studio.app/Contents/MacOS/agent-studio",
                &[],
            ),
            proc_(6, 5, CLAUDE, &["-p", "--no-session-persistence", "/usage"]),
            proc_(
                7,
                5,
                CLAUDE,
                &[
                    "--print",
                    "--resume",
                    "abc",
                    "--no-session-persistence",
                    "/context",
                ],
            ),
            // A headless agent that KEEPS its session is an agent, print mode or not.
            proc_(8, 5, CLAUDE, &["-p", "fix the build"]),
            // A probe's own children are still walked: nothing here, but a tool under an
            // agent's probe would count (see the next test).
        ];
        let m = agent_memory(&table, rss_of);
        assert_eq!((m.sessions, m.claude_processes), (1, 1));
        assert_eq!(m.claude_rss_bytes, 8 * MIB);
        assert_eq!((m.tool_processes, m.tool_rss_bytes), (0, 0));
    }

    #[test]
    fn a_probe_run_by_an_agent_is_skipped_but_what_it_started_still_counts() {
        let table = vec![
            proc_(20, 1, CLAUDE, &[]),
            proc_(
                21,
                20,
                CLAUDE,
                &["-p", "--no-session-persistence", "/usage"],
            ),
            proc_(22, 21, "/bin/sh", &["-c", "x"]),
        ];
        let m = agent_memory(&table, rss_of);
        assert_eq!((m.sessions, m.claude_processes), (1, 1));
        assert_eq!((m.tool_processes, m.tool_rss_bytes), (1, 22 * MIB));
    }

    #[test]
    fn an_unreadable_process_counts_with_zero_bytes_and_a_ppid_cycle_ends() {
        let table = vec![
            // 99's memory cannot be read (it exited after the table was taken).
            proc_(99, 1, CLAUDE, &[]),
            // A malformed table: 60 and 61 are each other's parent, under the claude.
            proc_(60, 61, "/bin/sh", &[]),
            proc_(61, 60, "/bin/sh", &[]),
            proc_(62, 99, "/bin/sh", &[]),
            proc_(63, 63, "/bin/sh", &[]), // its own parent: never a child of anything
        ];
        let m = agent_memory(&table, rss_of);
        assert_eq!(
            (m.sessions, m.claude_processes, m.claude_rss_bytes),
            (1, 1, 0)
        );
        assert_eq!((m.tool_processes, m.tool_rss_bytes), (1, 62 * MIB));

        // A cycle the walk CAN reach (a malformed table naming pid 60 twice, once under the
        // claude and once under 61): it ends, and each pid counts once.
        let cyc = vec![
            proc_(20, 1, CLAUDE, &[]),
            proc_(60, 20, "/bin/sh", &[]),
            proc_(61, 60, "/bin/sh", &[]),
            proc_(60, 61, "/bin/sh", &[]),
        ];
        let m = agent_memory(&cyc, rss_of);
        assert_eq!((m.tool_processes, m.tool_rss_bytes), (2, (60 + 61) * MIB));
    }

    /// The Claude DESKTOP app is not an agent: its bundle binary is named `Claude`, which a
    /// case-insensitive basename match took for the CLI — one phantom session, and every
    /// Electron helper under it summed as a "tool".
    #[test]
    fn the_claude_desktop_app_and_its_helpers_are_not_agents() {
        let app = "/Applications/Claude.app/Contents/MacOS/Claude";
        let helper = "/Applications/Claude.app/Contents/Frameworks/Claude Helper (Renderer).app/Contents/MacOS/Claude Helper (Renderer)";
        let full = |pid: u32, ppid: u32, exe: &str, args: &[&str]| {
            let mut p = proc_(pid, ppid, exe, args);
            p.argv[0] = exe.to_string(); // a bundle's argv[0] is its full path
            p
        };
        let table = vec![
            proc_(1, 0, "/sbin/launchd", &[]),
            full(70, 1, app, &[]),
            full(71, 70, helper, &["--type=renderer"]),
            full(72, 70, "/Applications/Claude.app/Contents/Frameworks/Claude Helper (GPU).app/Contents/MacOS/Claude Helper (GPU)", &["--type=gpu-process"]),
            // The desktop app's own embedded Claude Code IS a CLI session.
            proc_(80, 70, "/Users/u/Library/Application Support/Claude/claude-code/2.1.300/claude", &[]),
        ];
        let m = agent_memory(&table, rss_of);
        assert_eq!(
            (m.sessions, m.claude_processes, m.claude_rss_bytes),
            (1, 1, 80 * MIB),
            "only the embedded CLI (80) is a session — never the app (70)"
        );
        assert_eq!(
            (m.tool_processes, m.tool_rss_bytes),
            (0, 0),
            "the app's Electron helpers are not tools an agent started"
        );
    }

    #[test]
    fn no_claude_means_nothing_held() {
        let table = vec![
            proc_(1, 0, "/sbin/launchd", &[]),
            proc_(2, 1, "/bin/zsh", &[]),
        ];
        assert_eq!(agent_memory(&table, rss_of), AgentMemory::default());
        assert_eq!(agent_memory(&[], rss_of), AgentMemory::default());
    }

    #[test]
    fn probe_needs_both_flags_after_the_program_name() {
        let argv = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(is_probe(&argv(&[
            "claude",
            "-p",
            "--no-session-persistence",
            "/usage"
        ])));
        assert!(is_probe(&argv(&[
            "claude",
            "--no-session-persistence",
            "--print",
            "x"
        ])));
        assert!(!is_probe(&argv(&["claude", "-p", "/usage"])));
        assert!(!is_probe(&argv(&["claude", "--no-session-persistence"])));
        // The program name itself is not a flag.
        assert!(!is_probe(&argv(&["-p", "--no-session-persistence"])));
        assert!(!is_probe(&[]));
    }

    #[test]
    fn mac_available_is_total_minus_app_wired_and_compressed() {
        let page = 16 * 1024;
        let vm = VmCounts {
            internal: 1000,
            purgeable: 100,
            wired: 200,
            compressed: 50,
        };
        // used = (1000 − 100) + 200 + 50 = 1150 pages.
        assert_eq!(
            mac_available(64 * 1024 * MIB, vm, page),
            64 * 1024 * MIB - 1150 * page
        );
        // Purgeable larger than internal never underflows, and used past the total is 0 left.
        let odd = VmCounts {
            internal: 10,
            purgeable: 50,
            wired: 0,
            compressed: 0,
        };
        assert_eq!(mac_available(MIB, odd, page), MIB);
        let full = VmCounts {
            internal: u64::MAX / 2,
            purgeable: 0,
            wired: 0,
            compressed: 0,
        };
        assert_eq!(mac_available(MIB, full, page), 0);
    }

    #[test]
    fn meminfo_gives_total_and_available_in_bytes() {
        let text = "MemTotal:       16318300 kB\nMemFree:          512000 kB\nMemAvailable:    8159150 kB\nBuffers: 1 kB\n";
        assert_eq!(
            parse_meminfo(text),
            (Some(16_318_300 * 1024), Some(8_159_150 * 1024))
        );
        // An old kernel without MemAvailable: total only. Garbage: nothing.
        assert_eq!(
            parse_meminfo("MemTotal: 2048 kB\n"),
            (Some(2048 * 1024), None)
        );
        assert_eq!(
            parse_meminfo("MemTotal: lots kB\nMemAvailable:\n"),
            (None, None)
        );
        assert_eq!(parse_meminfo(""), (None, None));
    }

    #[test]
    fn statm_resident_is_the_second_field() {
        assert_eq!(
            parse_statm_resident("102400 2560 600 10 0 4000 0\n"),
            Some(2560)
        );
        assert_eq!(parse_statm_resident("102400"), None);
        assert_eq!(parse_statm_resident("1 x 3"), None);
    }

    #[test]
    fn the_wire_is_camel_case_with_nulls_for_unknowns() {
        let cap = MachineCapacity {
            logical_cpus: Some(16),
            total_mem_bytes: None,
            available_mem_bytes: None,
            agents: Some(AgentMemory {
                sessions: 2,
                claude_processes: 3,
                claude_rss_bytes: 7,
                tool_processes: 4,
                tool_rss_bytes: 9,
            }),
            sampled_at_ms: 1,
        };
        let json = serde_json::to_value(&cap).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "logicalCpus": 16,
                "totalMemBytes": null,
                "availableMemBytes": null,
                "agents": {
                    "sessions": 2,
                    "claudeProcesses": 3,
                    "claudeRssBytes": 7,
                    "toolProcesses": 4,
                    "toolRssBytes": 9
                },
                "sampledAtMs": 1
            })
        );
    }

    /// The real probe on this machine: only invariants that hold on ANY machine (no Docker, no
    /// network, no signed-in CLI).
    #[test]
    fn a_real_sample_is_self_consistent() {
        let s = sample();
        assert!(s.logical_cpus.is_some_and(|n| n >= 1));
        if let (Some(t), Some(a)) = (s.total_mem_bytes, s.available_mem_bytes) {
            assert!(t > 0 && a <= t, "available {a} must not exceed total {t}");
        }
        #[cfg(any(target_os = "macos", target_os = "linux", windows))]
        {
            assert!(
                s.total_mem_bytes.is_some_and(|t| t > 0),
                "macOS, Linux and Windows always report a total"
            );
            assert!(s.available_mem_bytes.is_some());
            let agents = s
                .agents
                .expect("macOS, Linux and Windows have a process table");
            assert!(agents.sessions <= agents.claude_processes);
            // This test's own process has a readable resident size.
            assert!(os::rss(std::process::id()).is_some_and(|b| b > 0));
        }
        assert!(s.sampled_at_ms > 0);
    }

    /// Windows: plausible figures, cross-checked against independent facts — at least 1 GiB
    /// of RAM and at most 64 TiB, some of it available, and our own working set between 1 MiB
    /// and the whole machine; a child's working set is readable too (limited access).
    #[cfg(windows)]
    #[test]
    fn windows_memory_figures_are_plausible() {
        use crate::spawn::NoWindow;
        const GIB: u64 = 1024 * MIB;
        let (total, available) = os::memory();
        let total = total.expect("a total");
        let available = available.expect("an available figure");
        assert!((GIB..=64 * 1024 * 1024 * GIB).contains(&total), "{total}");
        assert!(
            available > 0 && available <= total,
            "{available} of {total}"
        );
        let me = os::rss(std::process::id()).expect("our own working set");
        assert!((MIB..total).contains(&me), "{me}");
        let mut child = std::process::Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Sleep 20",
            ])
            .stdout(std::process::Stdio::null())
            .no_window()
            .spawn()
            .expect("powershell starts");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        let got = loop {
            match os::rss(child.id()) {
                Some(b) if b > MIB => break Some(b),
                _ if std::time::Instant::now() > deadline => break None,
                _ => std::thread::sleep(std::time::Duration::from_millis(100)),
            }
        };
        let _ = child.kill();
        let _ = child.wait();
        assert!(got.is_some(), "a child's working set is readable");
        assert_eq!(os::rss(0xFFFF_FFF1), None, "no such process");
    }

    #[tokio::test]
    async fn the_command_returns_a_sample() {
        let s = machine_capacity().await.expect("the sample finishes");
        assert!(s.logical_cpus.is_some());
    }
}
