//! Linux journald: filter → `journalctl` argv, journal JSON → [`LineDraft`], and the
//! "can you see the whole journal?" reasoning. Pure and compiled on every OS — the Mac
//! runs these tests too; only `detect_backend` in `mod.rs` touches the filesystem.

use std::path::PathBuf;

use serde_json::Value;

use super::{unavailable, Backend, BackendKind, SyslogFilter, SyslogLevel};
use crate::logstream::{cap_text, LineDraft, LogKind, LogLevel};

/// Where Ubuntu (usrmerge) and older layouts put the binary. Absolute, never `$PATH`.
pub const JOURNALCTL_PATHS: [&str; 2] = ["/usr/bin/journalctl", "/bin/journalctl"];
/// journald's runtime dir — present iff journald is (or was, this boot) running.
pub const JOURNALD_RUNTIME_DIR: &str = "/run/systemd/journal";
/// The kernel truncates `comm` (and so journald's `_COMM`) to 15 bytes.
pub const COMM_MAX: usize = 15;
/// Groups whose members can read the whole system journal.
pub const JOURNAL_GROUPS: [&str; 3] = ["systemd-journal", "adm", "wheel"];

pub const NO_JOURNALCTL: &str =
    "journalctl was not found, so system app logs can't be read on this machine.";
pub const NO_JOURNALD: &str =
    "journald isn't running on this machine (a container?), so there are no system logs to read.";
pub const PARTIAL_JOURNAL: &str = "Only your own journal is visible — add yourself to the \
    `systemd-journal` group to see every app's logs.";

/// `name` cut to what `_COMM` holds (15 bytes, on a char boundary).
pub fn comm_of(name: &str) -> &str {
    if name.len() <= COMM_MAX {
        return name;
    }
    let mut end = COMM_MAX;
    while !name.is_char_boundary(end) {
        end -= 1;
    }
    &name[..end]
}

/// `--priority` ceiling for a level floor (`None` = everything).
fn priority_arg(min: SyslogLevel) -> Option<&'static str> {
    match min {
        SyslogLevel::Debug => None,
        SyslogLevel::Info => Some("--priority=6"),
        SyslogLevel::Default => Some("--priority=5"),
        SyslogLevel::Error => Some("--priority=3"),
    }
}

/// Args for `journalctl`. Several `_COMM=` matches on the same field are ORed by
/// journalctl itself; each is one argv element (no shell).
pub fn journal_args(f: &SyslogFilter) -> Vec<String> {
    let mut a: Vec<String> = vec![
        "--follow".into(),
        "--output=json".into(),
        "--lines=0".into(),
        "--no-pager".into(),
    ];
    if let Some(p) = priority_arg(f.min_level) {
        a.push(p.into());
    }
    if let Some(unit) = f.subsystem.as_deref().filter(|s| !s.is_empty()) {
        a.push(format!("--unit={unit}"));
    }
    if let Some(apps) = f.apps.as_ref() {
        let mut seen: Vec<&str> = Vec::new();
        for name in apps {
            let c = comm_of(name);
            if !c.is_empty() && !seen.contains(&c) {
                seen.push(c);
                a.push(format!("_COMM={c}"));
            }
        }
    }
    a
}

/// journald `PRIORITY` → level: 0–3 error, 4 warn, 5–6 info, 7 debug.
pub fn priority_level(p: u8) -> LogLevel {
    match p {
        0..=3 => LogLevel::Error,
        4 => LogLevel::Warn,
        5 | 6 => LogLevel::Info,
        _ => LogLevel::Debug,
    }
}

/// A journal field as text: a string, or — for non-UTF-8 / binary payloads — an array
/// of byte values (journald's JSON output does that), decoded lossily.
pub fn field_text(v: Option<&Value>) -> Option<String> {
    match v? {
        Value::String(s) => Some(s.clone()),
        Value::Array(bytes) => {
            let raw: Vec<u8> = bytes
                .iter()
                .map(|b| b.as_u64().and_then(|n| u8::try_from(n).ok()))
                .collect::<Option<Vec<u8>>>()?;
            Some(String::from_utf8_lossy(&raw).into_owned())
        }
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// One `journalctl --output=json` line → a `machine` [`LineDraft`].
pub fn parse_journal(line: &str) -> Option<LineDraft> {
    let line = line.trim();
    if !line.starts_with('{') {
        return None;
    }
    let v: Value = serde_json::from_str(line).ok()?;
    let get = |k: &str| field_text(v.get(k));
    let message = get("MESSAGE")?;
    let source = get("_COMM")
        .or_else(|| get("SYSLOG_IDENTIFIER"))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "journal".to_string());
    let level = get("PRIORITY")
        .and_then(|p| p.trim().parse::<u8>().ok())
        .map(priority_level)
        .unwrap_or(LogLevel::Info);
    let ts_ms = get("__REALTIME_TIMESTAMP")
        .and_then(|t| t.trim().parse::<i64>().ok())
        .map(|us| us / 1000);

    let mut msg_lines = message.lines();
    let first = msg_lines.next().unwrap_or("").to_string();
    let multiline = msg_lines.next().is_some();
    let mut parts: Vec<String> = Vec::new();
    if let Some(exe) = get("_EXE") {
        parts.push(exe);
    }
    if let Some(pid) = get("_PID") {
        parts.push(format!("pid {pid}"));
    }
    if let Some(unit) = get("_SYSTEMD_UNIT") {
        parts.push(unit);
    }
    let mut detail = parts.join(" · ");
    if multiline {
        detail.push('\n');
        detail.push_str(&message);
    }
    Some(LineDraft {
        terminal_id: None,
        agent_id: None,
        source,
        kind: LogKind::Machine,
        level,
        text: cap_text(&first, super::macos::MAX_TEXT),
        detail: if detail.is_empty() {
            None
        } else {
            Some(cap_text(&detail, super::macos::MAX_DETAIL))
        },
        ts_ms,
        tool_use_id: None,
    })
}

/// The `Uid:` (real) and `Groups:` lines of `/proc/self/status`.
pub fn ids_from_proc_status(status: &str) -> (Option<u32>, Vec<u32>) {
    let mut uid = None;
    let mut gids: Vec<u32> = Vec::new();
    let mut primary = None;
    for line in status.lines() {
        if let Some(rest) = line.strip_prefix("Uid:") {
            uid = rest.split_whitespace().next().and_then(|u| u.parse().ok());
        } else if let Some(rest) = line.strip_prefix("Groups:") {
            gids = rest
                .split_whitespace()
                .filter_map(|g| g.parse().ok())
                .collect();
        } else if let Some(rest) = line.strip_prefix("Gid:") {
            primary = rest.split_whitespace().next().and_then(|g| g.parse().ok());
        }
    }
    if let Some(g) = primary {
        if !gids.contains(&g) {
            gids.push(g);
        }
    }
    (uid, gids)
}

/// Can this user read the whole system journal? root, or a member (by gid) of one of
/// [`JOURNAL_GROUPS`] as listed in `/etc/group`. `None` = yes; `Some(reason)` = partial.
pub fn access_reason(uid: Option<u32>, gids: &[u32], group_file: &str) -> Option<String> {
    if uid == Some(0) {
        return None;
    }
    let privileged = group_file.lines().any(|l| {
        let mut f = l.split(':');
        let name = f.next().unwrap_or("");
        let gid = f.nth(1).and_then(|g| g.parse::<u32>().ok());
        JOURNAL_GROUPS.contains(&name) && gid.is_some_and(|g| gids.contains(&g))
    });
    if privileged {
        None
    } else {
        Some(PARTIAL_JOURNAL.to_string())
    }
}

/// The Linux backend decision, from what the glue observed.
pub fn linux_backend(
    program: Option<PathBuf>,
    journald_running: bool,
    proc_status: &str,
    group_file: &str,
) -> Backend {
    let Some(program) = program else {
        return unavailable(NO_JOURNALCTL);
    };
    if !journald_running {
        return unavailable(NO_JOURNALD);
    }
    let (uid, gids) = ids_from_proc_status(proc_status);
    Backend {
        available: true,
        name: Some("linux-journald"),
        reason: access_reason(uid, &gids, group_file),
        program: Some(program),
        kind: BackendKind::LinuxJournald,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn comm_is_cut_to_15_bytes_on_a_char_boundary() {
        assert_eq!(comm_of("nginx"), "nginx");
        assert_eq!(comm_of("abcdefghijklmnop"), "abcdefghijklmno");
        // 'é' is 2 bytes and straddles byte 15 → cut before it.
        assert_eq!(comm_of("abcdefghijklmnéx"), "abcdefghijklmn");
    }

    #[test]
    fn journal_args_table() {
        let all = SyslogFilter::default();
        assert_eq!(
            journal_args(&all),
            vec![
                "--follow",
                "--output=json",
                "--lines=0",
                "--no-pager",
                "--priority=5"
            ]
        );
        let f = SyslogFilter {
            apps: Some(vec![
                "nginx".into(),
                "gnome-shell".into(),
                "nginx".into(),
                "a-very-long-process-name".into(),
            ]),
            subsystem: Some("ssh.service".into()),
            min_level: SyslogLevel::Debug,
            ..Default::default()
        };
        assert_eq!(
            journal_args(&f),
            vec![
                "--follow",
                "--output=json",
                "--lines=0",
                "--no-pager",
                "--unit=ssh.service",
                "_COMM=nginx",
                "_COMM=gnome-shell",
                "_COMM=a-very-long-pro",
            ]
        );
        let e = SyslogFilter {
            min_level: SyslogLevel::Error,
            ..Default::default()
        };
        assert!(journal_args(&e).contains(&"--priority=3".to_string()));
        let i = SyslogFilter {
            min_level: SyslogLevel::Info,
            ..Default::default()
        };
        assert!(journal_args(&i).contains(&"--priority=6".to_string()));
    }

    #[test]
    fn priority_mapping_table() {
        let want = [
            LogLevel::Error,
            LogLevel::Error,
            LogLevel::Error,
            LogLevel::Error,
            LogLevel::Warn,
            LogLevel::Info,
            LogLevel::Info,
            LogLevel::Debug,
        ];
        for (p, w) in want.iter().enumerate() {
            assert_eq!(priority_level(p as u8), *w, "PRIORITY {p}");
        }
    }

    #[test]
    fn message_as_a_byte_array_decodes() {
        let v: Value = serde_json::json!([104, 105, 0xE2, 0x9C, 0x93]);
        assert_eq!(field_text(Some(&v)).as_deref(), Some("hi✓"));
        let bad: Value = serde_json::json!([104, 300]);
        assert_eq!(field_text(Some(&bad)), None, "not bytes");
        let invalid: Value = serde_json::json!([0xFF, 104]);
        assert_eq!(field_text(Some(&invalid)).as_deref(), Some("\u{FFFD}h"));
        assert_eq!(
            field_text(Some(&Value::Null)),
            None,
            "journald's too-large marker"
        );
    }

    #[test]
    fn access_is_full_for_root_or_a_journal_group_member() {
        let groups = "root:x:0:\nadm:x:4:syslog\nsystemd-journal:x:101:\ndan:x:1000:\n";
        assert_eq!(access_reason(Some(0), &[], groups), None, "root");
        assert_eq!(access_reason(Some(1000), &[1000, 101], groups), None);
        assert_eq!(access_reason(Some(1000), &[4], groups), None, "adm");
        assert_eq!(
            access_reason(Some(1000), &[1000], groups).as_deref(),
            Some(PARTIAL_JOURNAL)
        );
        assert!(access_reason(Some(1000), &[1000], "").is_some());
    }

    #[test]
    fn ids_come_from_proc_self_status() {
        let status = "Name:\tcat\nUid:\t1000\t1000\t1000\t1000\nGid:\t1000\t1000\t1000\t1000\nGroups:\t4 24 101 \n";
        let (uid, gids) = ids_from_proc_status(status);
        assert_eq!(uid, Some(1000));
        assert_eq!(gids, vec![4, 24, 101, 1000]);
    }

    #[test]
    fn the_linux_backend_decision_table() {
        let groups = "systemd-journal:x:101:\n";
        let st = "Uid:\t1000\t1000\t1000\t1000\nGroups:\t101\n";
        let p = || Some(PathBuf::from("/usr/bin/journalctl"));
        assert_eq!(
            linux_backend(None, true, st, groups),
            unavailable(NO_JOURNALCTL)
        );
        assert_eq!(
            linux_backend(p(), false, st, groups),
            unavailable(NO_JOURNALD)
        );
        let ok = linux_backend(p(), true, st, groups);
        assert!(ok.available && ok.reason.is_none());
        assert_eq!(ok.name, Some("linux-journald"));
        let partial = linux_backend(p(), true, "Uid:\t1000\nGroups:\t1000\n", groups);
        assert!(partial.available);
        assert_eq!(partial.reason.as_deref(), Some(PARTIAL_JOURNAL));
    }
}
