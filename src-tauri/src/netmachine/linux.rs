//! Linux glue: every second, read the world-readable `/proc/net/{tcp,tcp6,udp,udp6}`, name the
//! sockets we can (inode → pid through `/proc/<pid>/fd`, which is readable only for the user's
//! own processes without root) and add TCP byte counters from `ss -tinH` when iproute2 is there.

use super::procnet::{assemble, parse_proc_net, parse_ss, ProcSocket, SsBytes};
use super::{MachineProto, Platform, RawApp, RawSample, Source, SourceFactory};
use crate::spawn::NoWindow as _;
use std::collections::HashMap;
use std::os::unix::fs::MetadataExt;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

const SS_PATHS: &[&str] = &["/usr/bin/ss", "/bin/ss", "/usr/sbin/ss", "/sbin/ss"];

pub const PARTIAL_REASON: &str =
    "Other users' connections are listed without a process — naming them needs root.";
pub const NO_SS_REASON: &str =
    "Other users' connections are listed without a process, and byte counts need `ss` (iproute2), which isn't installed.";

pub fn ss_path() -> Option<&'static str> {
    SS_PATHS.iter().copied().find(|p| Path::new(p).exists())
}

pub fn platform() -> (Platform, Option<SourceFactory>) {
    let ss = ss_path();
    (
        Platform {
            available: true,
            backend: Some("linux-proc"),
            reason: Some(
                if ss.is_some() {
                    PARTIAL_REASON
                } else {
                    NO_SS_REASON
                }
                .to_string(),
            ),
            has_bytes: ss.is_some(),
        },
        Some(Arc::new(move || {
            Ok(Box::new(ProcSource::new(ss)) as Box<dyn Source>)
        })),
    )
}

pub struct ProcSource {
    ss: Option<&'static str>,
    tick: tokio::time::Interval,
}

impl ProcSource {
    pub fn new(ss: Option<&'static str>) -> ProcSource {
        let mut tick = tokio::time::interval(Duration::from_secs(1));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        ProcSource { ss, tick }
    }
}

#[async_trait::async_trait]
impl Source for ProcSource {
    async fn next(&mut self) -> Result<RawSample, String> {
        self.tick.tick().await;
        let ss = self.ss;
        let apps = tokio::task::spawn_blocking(move || read_sample(ss))
            .await
            .map_err(|e| format!("Reading /proc failed: {e}"))??;
        Ok(RawSample {
            apps,
            interval_ms: None,
        })
    }
}

/// One full sample from the real `/proc` (blocking).
pub fn read_sample(ss: Option<&str>) -> Result<Vec<RawApp>, String> {
    let mut sockets: Vec<ProcSocket> = Vec::new();
    let mut any = false;
    for (file, proto) in [
        ("tcp", MachineProto::Tcp4),
        ("tcp6", MachineProto::Tcp6),
        ("udp", MachineProto::Udp4),
        ("udp6", MachineProto::Udp6),
    ] {
        // A kernel without IPv6 has no tcp6/udp6 — not an error.
        if let Ok(text) = std::fs::read_to_string(format!("/proc/net/{file}")) {
            any = true;
            sockets.extend(parse_proc_net(&text, proto));
        }
    }
    if !any {
        return Err("/proc/net is not readable, so connections can't be listed.".to_string());
    }
    let my_uid = std::fs::metadata("/proc/self")
        .map(|m| m.uid())
        .map_err(|e| format!("/proc/self: {e}"))?;
    let ss_bytes = ss.and_then(read_ss);
    Ok(assemble(
        &sockets,
        &socket_owners(),
        my_uid,
        ss_bytes.as_ref(),
    ))
}

fn read_ss(path: &str) -> Option<SsBytes> {
    let out = std::process::Command::new(path)
        .arg("-tinH")
        .no_window()
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| parse_ss(&String::from_utf8_lossy(&out.stdout)))
}

/// inode → (pid, comm) for every socket fd we are allowed to read.
pub fn socket_owners() -> HashMap<u64, (u32, String)> {
    let mut owners = HashMap::new();
    let Ok(procs) = std::fs::read_dir("/proc") else {
        return owners;
    };
    for entry in procs.flatten() {
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|s| s.parse::<u32>().ok())
        else {
            continue;
        };
        // Another user's process: EACCES here — that is the "other user" case, not an error.
        let Ok(fds) = std::fs::read_dir(entry.path().join("fd")) else {
            continue;
        };
        let mut name: Option<String> = None;
        for fd in fds.flatten() {
            let Ok(target) = std::fs::read_link(fd.path()) else {
                continue;
            };
            let Some(inode) = target
                .to_str()
                .and_then(|t| t.strip_prefix("socket:["))
                .and_then(|t| t.strip_suffix(']'))
                .and_then(|t| t.parse::<u64>().ok())
            else {
                continue;
            };
            let name = name.get_or_insert_with(|| {
                std::fs::read_to_string(entry.path().join("comm"))
                    .map(|s| s.trim_end().to_string())
                    .unwrap_or_else(|_| format!("pid {pid}"))
            });
            owners.entry(inode).or_insert((pid, name.clone()));
        }
    }
    owners
}
