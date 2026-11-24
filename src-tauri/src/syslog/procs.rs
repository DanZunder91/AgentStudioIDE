//! Running processes for the app picker (`syslog_apps`) and for PASSIVE simulator
//! detection (`simctl` is never run to probe). Listing is `cfg`-gated (macOS: libc
//! `proc_listallpids` + `proc_pidpath`; Linux: `/proc`); grouping/sorting is pure and
//! tested on every OS.
//! Windows lists Event Log providers instead (`eventlog::group_providers`), so
//! [`list_processes`] stays empty there.
//!
//! The grouping key matches what the stream filters on: macOS `process ==` compares the
//! executable's basename, Linux `_COMM=` the kernel's (15-byte) `comm`.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// Wire contract `RunningApp` (serde camelCase).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningApp {
    pub name: String,
    pub pids: Vec<u32>,
    pub path: Option<String>,
    /// macOS: inside a `.app` bundle (shown first in the picker).
    pub is_app: bool,
}

/// One process as the platform glue saw it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcInfo {
    pub pid: u32,
    pub name: String,
    pub path: Option<String>,
}

/// The process whose presence means an iOS Simulator is booted.
pub const SIMULATOR_MARKER: &str = "launchd_sim";

pub fn is_app_bundle_path(path: &str) -> bool {
    path.contains(".app/Contents/MacOS/")
}

/// Passive: a `launchd_sim` process exists. Never asks `simctl`.
pub fn simulator_booted(procs: &[ProcInfo]) -> bool {
    procs.iter().any(|p| p.name == SIMULATOR_MARKER)
}

/// Group by name; `.app` bundles first, then case-insensitive alphabetical. Pids sorted.
pub fn group_apps(procs: Vec<ProcInfo>) -> Vec<RunningApp> {
    let mut by: BTreeMap<String, RunningApp> = BTreeMap::new();
    for p in procs {
        if p.name.is_empty() {
            continue;
        }
        let e = by.entry(p.name.clone()).or_insert_with(|| RunningApp {
            name: p.name.clone(),
            pids: Vec::new(),
            path: None,
            is_app: false,
        });
        e.pids.push(p.pid);
        if let Some(path) = p.path {
            if is_app_bundle_path(&path) {
                e.is_app = true;
            }
            if e.path.is_none() {
                e.path = Some(path);
            }
        }
    }
    let mut out: Vec<RunningApp> = by.into_values().collect();
    for a in &mut out {
        a.pids.sort_unstable();
        a.pids.dedup();
    }
    sort_apps(&mut out);
    out
}

/// The picker order on every OS: apps first, then case-insensitive name (exact name breaks
/// ties). Shared with the Windows provider list (`eventlog::group_providers`).
pub fn sort_apps(apps: &mut [RunningApp]) {
    apps.sort_by(|a, b| {
        b.is_app
            .cmp(&a.is_app)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });
}

#[cfg(target_os = "macos")]
pub fn list_processes() -> Vec<ProcInfo> {
    use std::ffi::c_void;
    // Grow until the kernel's answer fits (it returns how many pids it wrote).
    let mut cap: usize = 4096;
    let pids: Vec<i32> = loop {
        let mut buf = vec![0i32; cap];
        let bytes = (cap * std::mem::size_of::<i32>()) as i32;
        // SAFETY: `buf` is a valid, writable buffer of `bytes` bytes.
        let n = unsafe { libc::proc_listallpids(buf.as_mut_ptr() as *mut c_void, bytes) };
        if n <= 0 {
            return Vec::new();
        }
        let n = n as usize;
        if n < cap || cap >= 1 << 20 {
            buf.truncate(n.min(cap));
            break buf;
        }
        cap *= 2;
    };
    let mut out = Vec::with_capacity(pids.len());
    let mut path_buf = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    for pid in pids {
        if pid <= 0 {
            continue;
        }
        // SAFETY: `path_buf` is writable for its full length, which we pass.
        let n = unsafe {
            libc::proc_pidpath(
                pid,
                path_buf.as_mut_ptr() as *mut c_void,
                path_buf.len() as u32,
            )
        };
        let path = (n > 0).then(|| String::from_utf8_lossy(&path_buf[..n as usize]).into_owned());
        let name = match &path {
            Some(p) => p.rsplit('/').next().unwrap_or(p).to_string(),
            None => {
                let mut nb = [0u8; 256];
                // SAFETY: `nb` is writable for its full length, which we pass.
                let n = unsafe {
                    libc::proc_name(pid, nb.as_mut_ptr() as *mut c_void, nb.len() as u32)
                };
                if n <= 0 {
                    continue;
                }
                String::from_utf8_lossy(&nb[..n as usize]).into_owned()
            }
        };
        out.push(ProcInfo {
            pid: pid as u32,
            name,
            path,
        });
    }
    out
}

#[cfg(target_os = "linux")]
pub fn list_processes() -> Vec<ProcInfo> {
    let Ok(dir) = std::fs::read_dir("/proc") else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in dir.flatten() {
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|s| s.parse::<u32>().ok())
        else {
            continue;
        };
        let base = entry.path();
        // Kernel threads have an empty cmdline and never log as an app.
        match std::fs::read(base.join("cmdline")) {
            Ok(c) if !c.is_empty() => {}
            _ => continue,
        }
        let Ok(comm) = std::fs::read_to_string(base.join("comm")) else {
            continue;
        };
        let path = std::fs::read_link(base.join("exe"))
            .ok()
            .map(|p| p.to_string_lossy().into_owned());
        out.push(ProcInfo {
            pid,
            name: comm.trim_end_matches('\n').to_string(),
            path,
        });
    }
    out
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn list_processes() -> Vec<ProcInfo> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(pid: u32, name: &str, path: Option<&str>) -> ProcInfo {
        ProcInfo {
            pid,
            name: name.into(),
            path: path.map(str::to_string),
        }
    }

    #[test]
    fn groups_by_name_apps_first_then_alpha() {
        let got = group_apps(vec![
            p(30, "zsh", Some("/bin/zsh")),
            p(
                10,
                "Safari",
                Some("/Applications/Safari.app/Contents/MacOS/Safari"),
            ),
            p(31, "zsh", Some("/bin/zsh")),
            p(5, "launchd", None),
            p(
                12,
                "Mail",
                Some("/System/Applications/Mail.app/Contents/MacOS/Mail"),
            ),
            p(7, "bash", Some("/bin/bash")),
            p(9, "", None),
        ]);
        let names: Vec<&str> = got.iter().map(|a| a.name.as_str()).collect();
        assert_eq!(names, ["Mail", "Safari", "bash", "launchd", "zsh"]);
        assert!(got[0].is_app && got[1].is_app && !got[2].is_app);
        assert_eq!(got[4].pids, vec![30, 31]);
        assert_eq!(got[3].path, None);
    }

    #[test]
    fn app_bundle_detection() {
        assert!(is_app_bundle_path("/Applications/X.app/Contents/MacOS/X"));
        assert!(!is_app_bundle_path("/usr/libexec/x"));
        assert!(!is_app_bundle_path(
            "/Applications/X.app/Contents/Resources/helper"
        ));
    }

    #[test]
    fn a_simulator_is_booted_iff_launchd_sim_runs() {
        assert!(!simulator_booted(&[
            p(1, "launchd", None),
            p(2, "Simulator", None)
        ]));
        assert!(simulator_booted(&[
            p(1, "launchd", None),
            p(3, "launchd_sim", Some("/Library/Developer/…/launchd_sim"))
        ]));
    }

    #[test]
    fn this_machine_lists_itself() {
        if cfg!(any(target_os = "macos", target_os = "linux")) {
            let me = std::process::id();
            let all = list_processes();
            assert!(
                all.iter().any(|x| x.pid == me),
                "own pid {me} missing from {} processes",
                all.len()
            );
            let apps = group_apps(all);
            assert!(!apps.is_empty());
        }
    }
}
