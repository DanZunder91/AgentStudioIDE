//! Append-only, uncapped API-client request history. Lives in the OS app config dir, NEVER in a
//! workspace, and keeps `{{VAR}}` placeholders literal so no resolved secret is written here.
//! A missing or corrupt store loads as empty: history must never break UI startup.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::api_store::HttpHeader;

/// File name inside the config dir.
const FILE_NAME: &str = "api-history.json";

/// One executed request + outcome. Request fields are the literal template (`{{VAR}}` kept).
/// Outcome: `status`/`status_text`/`duration_ms`/`size_bytes` on success, else `error`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    /// Stable client-generated key.
    pub id: String,
    pub method: String,
    pub url: String,
    pub headers: Vec<HttpHeader>,
    pub body: String,
    /// HTTP status code on a completed response, else `None` (a transport error).
    pub status: Option<u16>,
    pub status_text: Option<String>,
    pub duration_ms: Option<u64>,
    pub size_bytes: Option<u64>,
    /// The transport/DNS/TLS/timeout error message, when the send never completed.
    pub error: Option<String>,
    /// When the request was executed — epoch milliseconds, stamped by the frontend
    /// (the store keeps no clock; this crosses the wire as a number).
    pub at: i64,
    /// Which protocol executed this entry. `#[serde(default)]`
    /// so a pre-gRPC log (no field) still loads — a missing value reads as HTTP on the
    /// frontend. `"grpc"` for a gRPC unary call. Preserved verbatim through save/load.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol: Option<String>,
    /// gRPC only: the service FQN (`method` holds the gRPC method, `url` the endpoint).
    /// `None`/absent for HTTP. Kept so a re-run restores the full gRPC request.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grpc_service: Option<String>,
}

/// The whole persisted history: every executed request, oldest first (the frontend
/// appends and renders newest-first). [`Default`] is an **empty** log — exactly what
/// a missing/corrupt file loads as.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryStore {
    pub entries: Vec<HistoryEntry>,
}

/// Load history from `path`. **Any** failure — missing, unreadable, corrupt JSON, or
/// a wrong-shaped value — yields [`HistoryStore::default()`] (empty), so startup can
/// never break on a bad file. (Exactly `api_store::load`'s robustness contract.)
pub fn load(path: &Path) -> HistoryStore {
    let Ok(text) = std::fs::read_to_string(path) else {
        return HistoryStore::default();
    };
    serde_json::from_str::<HistoryStore>(&text).unwrap_or_default()
}

/// Write `store` as pretty JSON with [`crate::api_store::save`]'s writer (atomic, then `0600`):
/// literal headers like `Authorization: Bearer …` can land here.
fn save(path: &Path, store: &HistoryStore) -> std::io::Result<()> {
    // `store_file`: locked, a unique temp per write (born 0600 on unix), the
    // temp removed on failure, and on Windows a retried rename over a briefly-held file.
    let json = serde_json::to_string_pretty(store).unwrap_or_else(|_| "{}".to_string());
    let _guard = crate::store_file::lock(path);
    crate::store_file::write_atomic(path, json.as_bytes(), true)?;
    Ok(())
}

/// The history file inside the app config dir `dir` — where [`store_path`] puts it, for a
/// caller that already holds the dir (the agent tools, whose tests pass a temp dir).
pub fn path_in(dir: &Path) -> PathBuf {
    dir.join(FILE_NAME)
}

/// Append one entry under the file's lock: re-read, push, write. A request sent outside the
/// webview (an agent's, through `agent_ctl`) is recorded here, and the lock keeps it from
/// interleaving with the webview's wholesale [`api_history_save`].
pub fn append(path: &Path, entry: HistoryEntry) -> std::io::Result<()> {
    let _guard = crate::store_file::lock(path);
    let mut store = load(path);
    store.entries.push(entry);
    save(path, &store)
}

/// The history file's path: the Tauri app config dir if available, else a
/// `home_dir()`-based fallback. **Always outside any workspace/repo** — the
/// secret-safety guarantee. Mirrors [`crate::api_store`]'s path resolution.
fn store_path(app: &tauri::AppHandle) -> PathBuf {
    use tauri::Manager;
    if let Ok(dir) = app.path().app_config_dir() {
        return dir.join(FILE_NAME);
    }
    fallback_store_path()
}

/// `~/.config/agent-studio/api-history.json` — used when the Tauri config dir can't be
/// resolved. Reuses `claude::home_dir` (the same fallback `api_store.rs` uses).
fn fallback_store_path() -> PathBuf {
    crate::agent::claude::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".config")
        .join("agent-studio")
        .join(FILE_NAME)
}

/// The persisted request history. Missing/corrupt file → an empty [`HistoryStore`].
///
/// Frontend contract: `invoke<HistoryStore>('api_history_load')`.
#[tauri::command]
pub fn api_history_load(app: tauri::AppHandle) -> HistoryStore {
    load(&store_path(&app))
}

/// Replace the whole store. Frontend: `invoke('api_history_save', { store })`.
#[tauri::command]
pub fn api_history_save(app: tauri::AppHandle, store: HistoryStore) -> Result<(), String> {
    save(&store_path(&app), &store).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh temp directory that cleans itself up, plus the store path inside it.
    struct Fixture {
        dir: PathBuf,
        store: PathBuf,
    }

    impl Fixture {
        fn new(label: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "agentstudio-apihistory-{label}-{}",
                ulid::Ulid::new()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            let store = dir.join(FILE_NAME);
            Self { dir, store }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn ok_entry(id: &str) -> HistoryEntry {
        HistoryEntry {
            id: id.into(),
            method: "GET".into(),
            url: "https://api.example.com/user".into(),
            headers: vec![HttpHeader {
                name: "Authorization".into(),
                value: "Bearer {{TOKEN}}".into(),
            }],
            body: String::new(),
            status: Some(200),
            status_text: Some("OK".into()),
            duration_ms: Some(42),
            size_bytes: Some(128),
            error: None,
            at: 1_700_000_000_000,
            protocol: None,
            grpc_service: None,
        }
    }

    fn err_entry(id: &str) -> HistoryEntry {
        HistoryEntry {
            id: id.into(),
            method: "POST".into(),
            url: "https://nope.invalid/".into(),
            headers: vec![],
            body: "{\"q\":\"v\"}".into(),
            status: None,
            status_text: None,
            duration_ms: None,
            size_bytes: None,
            error: Some("dns error: failed to lookup address".into()),
            at: 1_700_000_100_000,
            protocol: None,
            grpc_service: None,
        }
    }

    /// A gRPC entry: `protocol`/`grpcService` populated.
    fn grpc_entry(id: &str) -> HistoryEntry {
        HistoryEntry {
            id: id.into(),
            method: "SayHello".into(),
            url: "localhost:50051".into(),
            headers: vec![HttpHeader {
                name: "authorization".into(),
                value: "Bearer {{TOKEN}}".into(),
            }],
            body: "{\"name\":\"world\"}".into(),
            status: Some(0),
            status_text: Some("OK".into()),
            duration_ms: None,
            size_bytes: None,
            error: None,
            at: 1_700_000_200_000,
            protocol: Some("grpc".into()),
            grpc_service: Some("greeter.Greeter".into()),
        }
    }

    #[test]
    fn round_trips_success_and_error_entries() {
        let f = Fixture::new("roundtrip");
        let store = HistoryStore {
            entries: vec![ok_entry("a"), err_entry("b")],
        };
        save(&f.store, &store).unwrap();
        assert_eq!(load(&f.store), store);
    }

    #[test]
    fn grpc_entry_round_trips_protocol_and_service() {
        // A gRPC entry must keep its `protocol`/`grpcService` through save→load
        // (the Rust struct dropping unknown fields on deserialize was the bug this
        // guards). And the wire form is camelCase `grpcService`.
        let f = Fixture::new("grpc");
        let store = HistoryStore {
            entries: vec![grpc_entry("g")],
        };
        save(&f.store, &store).unwrap();
        assert_eq!(load(&f.store), store);
        let text = std::fs::read_to_string(&f.store).unwrap();
        assert!(
            text.contains("grpcService"),
            "camelCase on the wire: {text}"
        );
        assert!(text.contains("\"grpc\""), "protocol recorded: {text}");
    }

    #[test]
    fn a_pre_grpc_log_without_the_new_fields_still_loads() {
        // Back-compat: a log written before gRPC support has no protocol/grpcService.
        // `#[serde(default)]` must let it load, reading as an HTTP entry (None).
        let f = Fixture::new("legacy");
        let legacy = r#"{"entries":[{"id":"x","method":"GET","url":"https://h/","headers":[],"body":"","status":200,"statusText":"OK","durationMs":1,"sizeBytes":2,"error":null,"at":1}]}"#;
        std::fs::write(&f.store, legacy).unwrap();
        let loaded = load(&f.store);
        assert_eq!(loaded.entries.len(), 1);
        assert_eq!(loaded.entries[0].protocol, None);
        assert_eq!(loaded.entries[0].grpc_service, None);
    }

    /// An append keeps every entry already on disk and adds one at the end, concurrent appends
    /// included (each re-reads under the lock). Falsify: drop the guard in `append`.
    #[test]
    fn append_adds_to_what_is_on_disk_and_loses_nothing_under_concurrency() {
        let f = Fixture::new("append");
        assert_eq!(path_in(&f.dir), f.store);
        save(
            &f.store,
            &HistoryStore {
                entries: vec![ok_entry("first")],
            },
        )
        .unwrap();
        let path = std::sync::Arc::new(f.store.clone());
        let threads: Vec<_> = (0..8)
            .map(|i| {
                let path = path.clone();
                std::thread::spawn(move || append(&path, ok_entry(&format!("t{i}"))).unwrap())
            })
            .collect();
        for t in threads {
            t.join().unwrap();
        }
        let loaded = load(&f.store);
        assert_eq!(loaded.entries.len(), 9, "an append was lost");
        assert_eq!(loaded.entries[0].id, "first", "appends go at the end");
    }

    #[test]
    fn missing_file_reads_as_default_empty_log() {
        let f = Fixture::new("missing");
        assert_eq!(load(&f.store), HistoryStore::default());
        assert!(load(&f.store).entries.is_empty());
    }

    #[test]
    fn corrupt_file_reads_as_default_never_errors() {
        let f = Fixture::new("corrupt");
        for junk in ["{ not json", "42", "", "[1, 2, 3]", "\"a string\"", "null"] {
            std::fs::write(&f.store, junk).unwrap();
            assert_eq!(
                load(&f.store),
                HistoryStore::default(),
                "corrupt {junk:?} must read as an empty history"
            );
        }
    }

    #[test]
    fn appends_without_limit_or_dedup() {
        // "No limit, no cache": the same request executed many times is recorded
        // once per execution — save is wholesale, so the frontend's appended list
        // round-trips verbatim, duplicates and all.
        let f = Fixture::new("nolimit");
        let entries: Vec<HistoryEntry> = (0..500)
            .map(|i| HistoryEntry {
                id: format!("id-{i}"),
                at: 1_700_000_000_000 + i as i64,
                ..ok_entry("dup")
            })
            .collect();
        let store = HistoryStore { entries };
        save(&f.store, &store).unwrap();
        let loaded = load(&f.store);
        assert_eq!(loaded.entries.len(), 500, "nothing is capped");
        assert_eq!(loaded, store, "duplicates survive verbatim");
    }

    #[test]
    fn recorded_request_keeps_placeholders_literal() {
        // Secret-safety: history stores the literal `{{VAR}}`, never a resolved token.
        let f = Fixture::new("literal");
        let store = HistoryStore {
            entries: vec![ok_entry("a")],
        };
        save(&f.store, &store).unwrap();
        let text = std::fs::read_to_string(&f.store).unwrap();
        assert!(
            text.contains("Bearer {{TOKEN}}"),
            "the literal placeholder must be what's stored: {text}"
        );
        assert!(
            !text.contains("sk-"),
            "no resolved secret should ever appear: {text}"
        );
    }

    #[test]
    fn saved_json_is_camel_case_on_the_wire() {
        let f = Fixture::new("camel");
        save(
            &f.store,
            &HistoryStore {
                entries: vec![ok_entry("a")],
            },
        )
        .unwrap();
        let text = std::fs::read_to_string(&f.store).unwrap();
        assert!(
            text.contains("statusText"),
            "wire form must be camelCase: {text}"
        );
        assert!(
            text.contains("durationMs"),
            "wire form must be camelCase: {text}"
        );
        assert!(
            !text.contains("status_text"),
            "must not leak snake_case: {text}"
        );
    }

    #[test]
    fn save_creates_the_parent_dir_if_absent() {
        let f = Fixture::new("mkdir");
        let nested = f.dir.join("a").join("b").join(FILE_NAME);
        assert!(!nested.parent().unwrap().exists());
        save(
            &nested,
            &HistoryStore {
                entries: vec![ok_entry("a")],
            },
        )
        .unwrap();
        assert!(nested.exists());
        assert_eq!(load(&nested).entries.len(), 1);
    }

    #[test]
    fn save_is_owner_only_and_leaves_no_temp_file() {
        let f = Fixture::new("mode");
        let path = f.dir.join(FILE_NAME);
        for _ in 0..2 {
            save(
                &path,
                &HistoryStore {
                    entries: vec![ok_entry("a")],
                },
            )
            .unwrap();
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "history may hold literal auth headers");
        }
        // Every OS: the temp names are unique per write now, so look for ANY leftover.
        let names: Vec<String> = std::fs::read_dir(&f.dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec![FILE_NAME.to_string()], "a temp was left behind");
    }
}
