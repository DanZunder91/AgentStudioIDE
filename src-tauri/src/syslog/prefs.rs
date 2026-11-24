//! `<app config dir>/syslog/prefs.json` — the active [`SyslogFilter`]. Every field is
//! `#[serde(default)]`, so a field added later loses nothing; missing/corrupt → defaults
//! (off). Reading prefs must never break startup.

use std::path::Path;

use super::SyslogFilter;

pub const FILE_NAME: &str = "prefs.json";

/// Missing, unreadable or corrupt → defaults.
pub fn load(path: &Path) -> SyslogFilter {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Atomic write (temp + rename), creating the directory.
pub fn save(path: &Path, filter: &SyslogFilter) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    }
    let json = serde_json::to_string_pretty(filter).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("rename {}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::super::SyslogLevel;
    use super::*;

    #[test]
    fn defaults_are_off_all_apps_default_level_no_simulator() {
        let f = SyslogFilter::default();
        assert!(!f.enabled, "high volume — opt-in");
        assert_eq!(f.apps, None, "null = all apps");
        assert_eq!(f.subsystem, None);
        assert_eq!(f.min_level, SyslogLevel::Default);
        assert!(!f.simulator);
        assert_eq!(f.simulator_apps, None);
    }

    #[test]
    fn every_field_defaults_independently() {
        let f: SyslogFilter = serde_json::from_str("{}").unwrap();
        assert_eq!(f, SyslogFilter::default());
        let f: SyslogFilter = serde_json::from_str(r#"{"enabled":true}"#).unwrap();
        assert!(f.enabled);
        assert_eq!(f.min_level, SyslogLevel::Default);
        // A future build's level name degrades alone.
        let f: SyslogFilter =
            serde_json::from_str(r#"{"enabled":true,"minLevel":"verbose","apps":["A"]}"#).unwrap();
        assert!(f.enabled);
        assert_eq!(f.min_level, SyslogLevel::Default);
        assert_eq!(f.apps, Some(vec!["A".to_string()]));
    }

    #[test]
    fn round_trips_through_disk_and_tolerates_garbage() {
        let dir = std::env::temp_dir().join(format!("syslog-prefs-{}", ulid::Ulid::new()));
        let path = dir.join("syslog").join(FILE_NAME);
        assert_eq!(load(&path), SyslogFilter::default(), "missing file");
        let f = SyslogFilter {
            enabled: true,
            apps: Some(vec!["Safari".into(), "Mail".into()]),
            subsystem: Some("com.example".into()),
            min_level: SyslogLevel::Error,
            simulator: true,
            simulator_apps: Some(vec!["MyApp".into()]),
        };
        save(&path, &f).unwrap();
        assert_eq!(load(&path), f);
        std::fs::write(&path, "not json").unwrap();
        assert_eq!(load(&path), SyslogFilter::default(), "corrupt file");
        let _ = std::fs::remove_dir_all(dir);
    }
}
