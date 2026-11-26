//! `netcap/prefs.json` in the app config dir: live toggles, last bound port, per-app decrypt
//! opt-ins. Every field is `#[serde(default)]` so older or hand-edited files load with defaults.

use std::path::Path;

use serde::{Deserialize, Serialize};

pub const FILE_NAME: &str = "prefs.json";

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Prefs {
    /// Inject the proxy env into NEW terminals. Default on.
    #[serde(default = "yes")]
    pub enabled: bool,
    /// Terminate TLS with our CA. Default off: `CONNECT` is a transparent tunnel.
    #[serde(default)]
    pub decrypt: bool,
    /// Last bound port, reused so hand-configured apps (Postman → `127.0.0.1:<port>`) keep working.
    /// `None` = never started. PERMANENT `#[serde(default)]`: older files lack it.
    #[serde(default)]
    pub port: Option<u16>,
    /// Apps the user says trust the IDE's CA: an `.app` bundle name (`Postman`) or an
    /// executable name. See [`super::client::user_opted_in`] for the match.
    /// PERMANENT `#[serde(default)]` (an older file has no such key).
    #[serde(default)]
    pub decrypt_apps: Vec<String>,
    /// Strict agent capture: the `curl` shim drops `--noproxy`/`-x ''`/`NO_PROXY=*`
    /// ([`super::shim`]); new terminals get `AGENTSTUDIO_PROXY_STRICT`. PERMANENT default ON:
    /// older files lack the key.
    #[serde(default = "yes")]
    pub strict_agent_capture: bool,
}

impl Default for Prefs {
    fn default() -> Self {
        Prefs {
            enabled: true,
            decrypt: false,
            port: None,
            decrypt_apps: Vec::new(),
            strict_agent_capture: true,
        }
    }
}

/// Missing, unreadable or corrupt → defaults. Reading prefs must never break startup.
pub fn load(path: &Path) -> Prefs {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Atomic write (temp + rename), creating the directory.
pub fn save(path: &Path, prefs: &Prefs) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    }
    let json = serde_json::to_string_pretty(prefs).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("rename {}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_enabled_and_not_decrypting() {
        assert_eq!(
            Prefs::default(),
            Prefs {
                enabled: true,
                decrypt: false,
                port: None,
                decrypt_apps: Vec::new(),
                strict_agent_capture: true,
            }
        );
    }

    #[test]
    fn every_field_defaults_independently() {
        let p: Prefs = serde_json::from_str("{}").unwrap();
        assert_eq!(p, Prefs::default());
        let p: Prefs = serde_json::from_str(r#"{"decrypt":true}"#).unwrap();
        assert!(
            p.enabled,
            "a missing `enabled` must default to TRUE, not bool::default"
        );
        assert!(p.decrypt);
        let p: Prefs = serde_json::from_str(r#"{"enabled":false}"#).unwrap();
        assert!(!p.enabled && !p.decrypt);
        let p: Prefs = serde_json::from_str(r#"{"strictAgentCapture":false}"#).unwrap();
        assert!(
            !p.strict_agent_capture && p.enabled,
            "camelCase key, others default"
        );
    }

    /// A file written by an older build, before the port and opt-in fields (hand-written here,
    /// never serialised from today's struct) keeps its toggles, gains the new fields' defaults,
    /// and survives the write-back.
    #[test]
    fn a_pre_round_6_file_keeps_its_toggles_and_survives_the_write_back() {
        let dir = std::env::temp_dir().join(format!("netcap-prefs-old-{}", ulid::Ulid::new()));
        let path = dir.join(FILE_NAME);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&path, r#"{ "enabled": false, "decrypt": true }"#).unwrap();
        let p = load(&path);
        assert!(!p.enabled && p.decrypt, "old toggles kept: {p:?}");
        assert_eq!(p.port, None);
        assert!(p.decrypt_apps.is_empty());
        assert!(
            p.strict_agent_capture,
            "an older file loads with strict capture ON"
        );
        let mut p = p;
        p.port = Some(40001);
        p.decrypt_apps.push("Postman".into());
        save(&path, &p).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(
            text.contains(r#""decryptApps""#),
            "camelCase on disk: {text}"
        );
        let back = load(&path);
        assert!(!back.enabled && back.decrypt);
        assert_eq!(back.port, Some(40001));
        assert_eq!(back.decrypt_apps, ["Postman"]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn round_trips_through_disk_and_tolerates_garbage() {
        let dir = std::env::temp_dir().join(format!("netcap-prefs-{}", ulid::Ulid::new()));
        let path = dir.join("netcap").join(FILE_NAME);
        assert_eq!(load(&path), Prefs::default(), "missing file");
        let p = Prefs {
            enabled: false,
            decrypt: true,
            port: Some(8877),
            decrypt_apps: vec!["Postman".into()],
            strict_agent_capture: false,
        };
        save(&path, &p).unwrap();
        assert_eq!(load(&path), p);
        std::fs::write(&path, "not json").unwrap();
        assert_eq!(load(&path), Prefs::default(), "corrupt file");
        let _ = std::fs::remove_dir_all(dir);
    }
}
