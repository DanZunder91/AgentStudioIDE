//! Persisted **layout preferences**: the user's manual
//! ordering of project folders in the rails, which folders they left collapsed,
//! and the **center layout**: the views (the iTerm2/tmux
//! "window" strip), their names, their pane arrangement, and which terminal sat
//! in which pane. All of it survives an app restart.
//!
//! Three lists, all keyed by **absolute folder path** (stable across restarts,
//! unlike the ephemeral agent ids):
//!   - `folder_order` — the authoritative order the project folders appear in, in
//!     BOTH the left (Agents) rail and the right (Files) rail. A single source of
//!     truth is exactly what lets the two sides stay in the same sort:
//!     a drag in either rail rewrites this one list and both re-read it.
//!   - `collapsed_folders` — folder paths collapsed in the left (Agents) rail.
//!   - `collapsed_roots` — folder paths collapsed in the right (Files) rail.
//!
//! **WHERE it lives:** the OS **app config dir**
//! (`~/.config/agent-studio/layout-prefs.json` on the fallback path), never inside a
//! workspace/repo — exactly like [`crate::recent_projects`] / [`crate::api_store`].
//! It holds only folder paths and boolean-ish membership, no secrets.
//!
//! **Robustness over correctness of the file:** a missing, unreadable, or corrupt
//! store loads as [`LayoutPrefs::default()`] (three empty lists), never an error —
//! reading layout prefs must not be able to break UI startup. Same contract as
//! `recent_projects` / `api_store` / `history_store`.
//!
//! [`load`]/[`save`] operate on an explicit path so they are unit-testable against a
//! temp dir; the `#[tauri::command]`s are the thin glue resolving that path from the
//! `AppHandle`.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// File name inside the config dir.
const FILE_NAME: &str = "layout-prefs.json";

/// How a split divides its children — mirrors `Orientation` in `src/app/types.ts`.
///
/// A real enum rather than a `String` on purpose: **this type is the validator**.
/// The frontend hydrates a persisted tree straight into live `PaneNode`s, so a
/// hand-edited `"orientation": "sideways"` must be rejected here, at the door,
/// rather than handed on as a value the TypeScript union swore could not exist.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Orientation {
    Row,
    Column,
}

/// One restorable tab inside a persisted pane, keyed by the id that actually
/// survives a restart.
///
/// **Not a `TabId`.** Tab ids are minted fresh on every boot, so a blob full of
/// them would restore a skeleton nothing could bind to. A `TerminalId` is durable
/// in the one way that matters: for an agent terminal it IS the agent id, which
/// [`crate::pinned_agents`] reuses verbatim when it re-spawns a pinned root
/// — so the tab lands back in the pane the user left it in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedTerminal {
    pub terminal_id: String,
    /// The user's rename, or `None` when the tab still wears its derived title.
    /// This is the field that fixes a renamed tab losing its name after a
    /// restart — nothing else in the app persisted a custom name.
    #[serde(default)]
    pub custom_title: Option<String>,
}

/// A persisted pane tree: the frontend's `PaneNode`, with each leaf's tabs
/// replaced by the terminals that can be brought back.
///
/// Pane ids are deliberately absent — they are ephemeral UI identity, minted
/// fresh on hydrate, and re-using a persisted one risks colliding with the boot
/// tree it replaces.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum PersistedPane {
    #[serde(rename_all = "camelCase")]
    Split {
        orientation: Orientation,
        sizes: Vec<f64>,
        children: Vec<PersistedPane>,
    },
    #[serde(rename_all = "camelCase")]
    Leaf {
        terminals: Vec<PersistedTerminal>,
        /// Which of `terminals` was the selected tab, if any.
        active_terminal_id: Option<String>,
    },
}

/// One view of the center strip: a name the user can rename, and one whole pane
/// arrangement. The `id` is carried across so `activeViewId` can name one.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedView {
    pub id: String,
    pub name: String,
    pub layout: PersistedPane,
}

/// Deserialize `T`, falling back to `T::default()` when the value is present but
/// the wrong shape — so **one malformed field can never take the whole prefs file
/// down with it**.
///
/// The plain `#[serde(default)]` on every other field only covers a *missing* key;
/// a wrong-shaped one makes the whole struct fail, and [`load`]'s
/// `unwrap_or_default()` then throws away the user's folder order too. That was an
/// acceptable risk while every field was a list of strings. `views` is a recursive
/// tree written by a frontend that will keep changing shape, and it is by far the
/// most likely field to arrive malformed — so it degrades on its own.
fn lenient<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::de::DeserializeOwned + Default,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(serde_json::from_value(value).unwrap_or_default())
}

/// The persisted layout preferences. [`Default`] is all-empty — exactly what a
/// missing/corrupt file loads as. Every field is `#[serde(default)]` so a
/// partially-written or older file (missing a field) still loads cleanly.
///
/// (No `Eq`: `PersistedPane::Split::sizes` is `Vec<f64>`. `PartialEq` is what the
/// round-trip tests need, and float sizes are compared, never hashed.)
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutPrefs {
    /// Absolute folder paths, in the order the user arranged them (shared by both
    /// rails). Paths not present fall back to discovery order on the frontend.
    #[serde(default)]
    pub folder_order: Vec<String>,
    /// Absolute folder paths the user collapsed in the left (Agents) rail.
    #[serde(default)]
    pub collapsed_folders: Vec<String>,
    /// Absolute folder paths the user collapsed in the right (Files) rail.
    #[serde(default)]
    pub collapsed_roots: Vec<String>,
    /// "Focus follows agent": when true, selecting an agent in the left rail
    /// collapses every other Files-rail folder and expands the selected agent's
    /// working directory. `#[serde(default)]` so an older store lacking this key
    /// still loads (defaults to `false` — today's behaviour).
    #[serde(default)]
    pub focus_follows_agent: bool,
    /// How the agent rail draws a project (Settings → Interface): `"card"`, `"well"`,
    /// `"divider"` or `"pinned"`. A plain string, not an enum, on purpose: the frontend
    /// owns the list, so a style from a newer build round-trips through an older one
    /// instead of being dropped, and an unknown one reads as the default there.
    /// [`lenient`] so a wrong-shaped value degrades to `None` rather than costing the
    /// user their folder order.
    #[serde(default, deserialize_with = "lenient")]
    pub rail_group_style: Option<String>,
    /// Ids of API-client **saved-request folders** the user collapsed in the
    /// Collections rail.
    ///
    /// It lives here rather than in `api-store.json` on purpose, and it is *why* the
    /// collapse state was free to persist: this file already IS "which folders did the
    /// user leave shut", it is the only store that can be written wholesale without
    /// racing Rust's own writers, and it holds no secrets — while `api-store.json` is
    /// the Vault, where a per-view UI preference has no business. No second store file
    /// was invented for it.
    ///
    /// Ids, not paths, because a folder here is a user-named group with a minted id and
    /// no filesystem behind it. A stale id (folder deleted elsewhere) is inert: it names
    /// nothing, so nothing is collapsed by it.
    #[serde(default)]
    pub collapsed_api_folders: Vec<String>,
    /// The **center layout**: every view in bar order, with its name and its pane
    /// arrangement.
    ///
    /// Two bugs shared this one gap. A view's name lived only in the JS
    /// heap, so a rename died with the process; and nothing recorded *which* view
    /// a terminal sat in, so on restart every restored agent was dumped into the
    /// one view on screen. Persisting the arrangement — not just a flat list —
    /// fixes both, and keeps splits too.
    ///
    /// It lives here rather than in a new store file for the reason
    /// `collapsed_api_folders` does: this file already IS "what did the user's
    /// window look like", it is written wholesale by the frontend with no Rust
    /// writer to race, and it holds no secrets.
    ///
    /// [`lenient`] so a malformed tree degrades to "no persisted layout" (the
    /// frontend then keeps its boot view) instead of blanking the folder order.
    #[serde(default, deserialize_with = "lenient")]
    pub views: Vec<PersistedView>,
    /// Which of [`Self::views`] was on screen. `None`, or an id naming no view,
    /// restores the first one.
    #[serde(default)]
    pub active_view_id: Option<String>,
}

/// Load prefs from `path`. **Any** failure — missing file, unreadable, corrupt
/// JSON, or a wrong-shaped value — yields [`LayoutPrefs::default()`], so startup can
/// never break on a bad store. (Exactly `recent_projects::load`'s robustness contract.)
pub fn load(path: &Path) -> LayoutPrefs {
    let Ok(text) = std::fs::read_to_string(path) else {
        return LayoutPrefs::default();
    };
    serde_json::from_str::<LayoutPrefs>(&text).unwrap_or_default()
}

/// Write `prefs` to `path` as pretty JSON, creating the parent dir if needed.
/// Best-effort at the call site; a write failure surfaces as `Err` here.
fn save(path: &Path, prefs: &LayoutPrefs) -> std::io::Result<()> {
    // `store_file`: locked and atomic — a crash or a concurrent save can no
    // longer leave a half-written prefs file (the old plain `std::fs::write` truncated first).
    let json = serde_json::to_string_pretty(prefs).unwrap_or_else(|_| "{}".to_string());
    let _guard = crate::store_file::lock(path);
    crate::store_file::write_atomic(path, json.as_bytes(), false)
}

/// The store file's path: the Tauri app config dir if available (created on write),
/// else a `home_dir()`-based fallback. Always outside any workspace/repo.
fn store_path(app: &tauri::AppHandle) -> PathBuf {
    use tauri::Manager;
    if let Ok(dir) = app.path().app_config_dir() {
        return dir.join(FILE_NAME);
    }
    fallback_store_path()
}

/// `~/.config/agent-studio/layout-prefs.json` — used when the Tauri config dir can't
/// be resolved. Reuses `claude::home_dir` (the same fallback the other stores use).
fn fallback_store_path() -> PathBuf {
    crate::agent::claude::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".config")
        .join("agent-studio")
        .join(FILE_NAME)
}

/// The persisted rail layout prefs. Missing/corrupt store → [`LayoutPrefs::default()`].
///
/// Frontend contract: `invoke<LayoutPrefs>('layout_prefs_load')`.
#[tauri::command]
pub fn layout_prefs_load(app: tauri::AppHandle) -> LayoutPrefs {
    load(&store_path(&app))
}

/// Persist the whole `prefs` blob, replacing whatever was there (wholesale, like
/// `api_store_save`). A write failure surfaces as `Err(String)`; never panics.
///
/// **Main window only** (tab tear-off, docs/design/tab-tearoff.md §4.2). This file's
/// wholesale, non-atomic `save` is justified by it having exactly one writer; a detached
/// window runs its own store — a second full mirror of a different layout — so letting it
/// save would be a lost update. The page already skips the call outside the
/// main window; this refusal makes the single writer a fact rather than a convention.
///
/// Frontend contract: `invoke('layout_prefs_save', { prefs })`.
#[tauri::command]
pub fn layout_prefs_save(
    app: tauri::AppHandle,
    window: tauri::Window,
    prefs: LayoutPrefs,
) -> Result<(), String> {
    if !crate::tearoff::writes_layout_prefs(window.label()) {
        return Err(format!(
            "layout-prefs is written by the main window only, not {}",
            window.label()
        ));
    }
    save(&store_path(&app), &prefs).map_err(|e| e.to_string())
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
                "agentstudio-layoutprefs-{label}-{}",
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

    /// A terminal slot with an explicit rename.
    fn term(id: &str, title: Option<&str>) -> PersistedTerminal {
        PersistedTerminal {
            terminal_id: id.into(),
            custom_title: title.map(str::to_string),
        }
    }

    /// A leaf holding `ids`, with the first one active.
    fn leaf(ids: &[&str]) -> PersistedPane {
        PersistedPane::Leaf {
            terminals: ids.iter().map(|id| term(id, None)).collect(),
            active_terminal_id: ids.first().map(|id| (*id).to_string()),
        }
    }

    /// Two views: a split one (two terminals side by side) and a
    /// plain one — the shape that used to break restore.
    fn views() -> Vec<PersistedView> {
        vec![
            PersistedView {
                id: "v-1".into(),
                name: "Backend".into(),
                layout: PersistedPane::Split {
                    orientation: Orientation::Row,
                    sizes: vec![0.5, 0.5],
                    children: vec![
                        PersistedPane::Leaf {
                            terminals: vec![term("t-1", Some("gazelle"))],
                            active_terminal_id: Some("t-1".into()),
                        },
                        leaf(&["t-2"]),
                    ],
                },
            },
            PersistedView {
                id: "v-2".into(),
                name: "Frontend".into(),
                layout: leaf(&["t-3"]),
            },
        ]
    }

    fn sample() -> LayoutPrefs {
        LayoutPrefs {
            folder_order: vec!["/a".into(), "/b".into(), "/c".into()],
            collapsed_folders: vec!["/b".into()],
            collapsed_roots: vec!["/a".into(), "/c".into()],
            focus_follows_agent: true,
            rail_group_style: Some("well".into()),
            collapsed_api_folders: vec!["f-1".into(), "f-2".into()],
            views: views(),
            active_view_id: Some("v-2".into()),
        }
    }

    #[test]
    fn round_trips_through_disk() {
        let f = Fixture::new("roundtrip");
        let prefs = sample();
        save(&f.store, &prefs).unwrap();
        assert_eq!(
            load(&f.store),
            prefs,
            "a saved store loads back identically"
        );
    }

    #[test]
    fn missing_file_reads_as_default() {
        let f = Fixture::new("missing");
        assert_eq!(
            load(&f.store),
            LayoutPrefs::default(),
            "no file yet => three empty lists"
        );
    }

    #[test]
    fn corrupt_file_reads_as_default_never_errors() {
        let f = Fixture::new("corrupt");
        for junk in ["{ not json", "\"a string\"", "42", "[1, 2, 3]", ""] {
            std::fs::write(&f.store, junk).unwrap();
            assert_eq!(
                load(&f.store),
                LayoutPrefs::default(),
                "corrupt {junk:?} must read as default"
            );
        }
    }

    #[test]
    fn a_partial_file_fills_missing_fields_with_defaults() {
        let f = Fixture::new("partial");
        // Only folderOrder present — collapsed* must default to empty, not error.
        std::fs::write(&f.store, r#"{ "folderOrder": ["/x"] }"#).unwrap();
        let prefs = load(&f.store);
        assert_eq!(prefs.folder_order, vec!["/x".to_string()]);
        assert!(prefs.collapsed_folders.is_empty());
        assert!(prefs.collapsed_roots.is_empty());
        assert!(
            !prefs.focus_follows_agent,
            "focusFollowsAgent defaults false when absent"
        );
    }

    #[test]
    fn an_old_blob_without_focus_follows_agent_defaults_it_false() {
        // A pre-feature store carried all three lists but no focusFollowsAgent key.
        let f = Fixture::new("prefeature");
        std::fs::write(
            &f.store,
            r#"{ "folderOrder": ["/a"], "collapsedFolders": [], "collapsedRoots": ["/a"] }"#,
        )
        .unwrap();
        let prefs = load(&f.store);
        assert_eq!(prefs.folder_order, vec!["/a".to_string()]);
        assert_eq!(prefs.collapsed_roots, vec!["/a".to_string()]);
        assert!(
            !prefs.focus_follows_agent,
            "an older store missing the key loads as false (today's behaviour)"
        );
    }

    #[test]
    fn rail_group_style_round_trips_and_serializes_camel_case() {
        let f = Fixture::new("rgs");
        save(&f.store, &sample()).unwrap();
        assert_eq!(load(&f.store).rail_group_style.as_deref(), Some("well"));

        let json = serde_json::to_string(&sample()).unwrap();
        assert!(json.contains("\"railGroupStyle\":\"well\""), "got: {json}");
    }

    #[test]
    fn an_old_blob_without_rail_group_style_loads_it_as_none() {
        let f = Fixture::new("rgs-old");
        std::fs::write(
            &f.store,
            r#"{ "folderOrder": ["/a"], "focusFollowsAgent": true }"#,
        )
        .unwrap();
        let prefs = load(&f.store);
        assert_eq!(prefs.rail_group_style, None);
        assert!(
            prefs.focus_follows_agent,
            "the rest of the file still loads"
        );
    }

    #[test]
    fn a_style_this_build_does_not_know_survives_a_round_trip() {
        // A newer build wrote a style this one has never heard of. Rust keeps it as-is, so
        // going back to the newer build does not lose the user's choice.
        let f = Fixture::new("rgs-future");
        std::fs::write(&f.store, r#"{ "railGroupStyle": "orbit" }"#).unwrap();
        let prefs = load(&f.store);
        assert_eq!(prefs.rail_group_style.as_deref(), Some("orbit"));
        save(&f.store, &prefs).unwrap();
        assert_eq!(load(&f.store).rail_group_style.as_deref(), Some("orbit"));
    }

    #[test]
    fn a_wrong_shaped_rail_group_style_costs_nothing_else() {
        let f = Fixture::new("rgs-bad");
        std::fs::write(
            &f.store,
            r#"{ "folderOrder": ["/a", "/b"], "railGroupStyle": { "not": "a string" } }"#,
        )
        .unwrap();
        let prefs = load(&f.store);
        assert_eq!(prefs.rail_group_style, None);
        assert_eq!(
            prefs.folder_order,
            vec!["/a".to_string(), "/b".to_string()],
            "a malformed style must not take the folder order down with it"
        );
    }

    #[test]
    fn focus_follows_agent_round_trips_and_serializes_camel_case() {
        let f = Fixture::new("ffa");
        save(&f.store, &sample()).unwrap();
        assert!(
            load(&f.store).focus_follows_agent,
            "true survives a round-trip"
        );

        let json = serde_json::to_string(&sample()).unwrap();
        assert!(json.contains("\"focusFollowsAgent\":true"), "got: {json}");
    }

    #[test]
    fn serializes_camel_case_on_the_wire() {
        // The frontend reads folderOrder/collapsedFolders/collapsedRoots.
        let json = serde_json::to_string(&sample()).unwrap();
        assert!(json.contains("\"folderOrder\""), "got: {json}");
        assert!(json.contains("\"collapsedFolders\""), "got: {json}");
        assert!(json.contains("\"collapsedRoots\""), "got: {json}");
    }

    #[test]
    fn persists_across_a_fresh_read() {
        let f = Fixture::new("persist");
        save(&f.store, &sample()).unwrap();
        // A brand-new read of the same store file sees the persisted prefs.
        assert_eq!(load(&f.store), sample());
    }

    #[test]
    fn the_center_layout_round_trips_through_disk_with_its_names_and_splits() {
        let f = Fixture::new("views");
        save(&f.store, &sample()).unwrap();
        let back = load(&f.store);

        assert_eq!(
            back.views,
            views(),
            "the whole view tree survives a restart"
        );
        assert_eq!(back.active_view_id.as_deref(), Some("v-2"));
        // The two former bugs, asserted as facts about the file.
        assert_eq!(
            back.views
                .iter()
                .map(|v| v.name.as_str())
                .collect::<Vec<_>>(),
            ["Backend", "Frontend"],
            "a renamed view keeps its name across a restart"
        );
        let PersistedPane::Split { children, .. } = &back.views[0].layout else {
            panic!(
                "view 1 must still be a split, got {:?}",
                back.views[0].layout
            );
        };
        assert_eq!(children.len(), 2, "the split arrangement survives");
    }

    #[test]
    fn an_old_blob_without_views_loads_as_no_persisted_layout() {
        // A store from before the center layout was persisted. It must not error, and it must not
        // invent a view — an empty list is how the frontend knows to keep its
        // own boot view.
        let f = Fixture::new("previews");
        std::fs::write(&f.store, r#"{ "folderOrder": ["/a"] }"#).unwrap();
        let prefs = load(&f.store);
        assert_eq!(prefs.folder_order, vec!["/a".to_string()]);
        assert!(prefs.views.is_empty(), "absent views => none, not an error");
        assert!(prefs.active_view_id.is_none());
    }

    #[test]
    fn a_malformed_views_field_degrades_alone_and_keeps_the_rest_of_the_prefs() {
        // 🔴 The reason `views` is `lenient`. Every other field only defends
        // against a MISSING key; a wrong-shaped one fails the whole struct, and
        // `load`'s `unwrap_or_default()` would then throw away the folder order
        // the user spent time arranging. `views` is a recursive tree written by a
        // frontend that will keep changing shape, so it degrades on its own.
        let f = Fixture::new("badviews");
        for junk in [
            r#""not an array""#,
            "42",
            r#"[{ "id": "v-1" }]"#, // missing name/layout
            r#"[{ "id": "v-1", "name": "n", "layout": { "type": "wat" } }]"#,
            // The orientation enum IS the validator — see `Orientation`.
            r#"[{ "id": "v-1", "name": "n", "layout": { "type": "split", "orientation": "sideways", "sizes": [], "children": [] } }]"#,
            "null",
        ] {
            let blob = format!(r#"{{ "folderOrder": ["/a"], "views": {junk} }}"#);
            std::fs::write(&f.store, &blob).unwrap();
            let prefs = load(&f.store);
            assert_eq!(
                prefs.folder_order,
                vec!["/a".to_string()],
                "a bad views field must not cost the user their folder order: {junk}"
            );
            assert!(prefs.views.is_empty(), "bad views drop to empty: {junk}");
        }
    }

    #[test]
    fn the_center_layout_is_camel_case_on_the_wire_and_omits_an_absent_rename() {
        let text = serde_json::to_string(&sample()).unwrap();
        for key in [
            "\"views\"",
            "\"activeViewId\"",
            "\"terminalId\"",
            "\"activeTerminalId\"",
            "\"customTitle\"",
            "\"orientation\"",
            "\"row\"",
        ] {
            assert!(text.contains(key), "missing {key} in: {text}");
        }
        assert!(
            !text.contains("terminal_id") && !text.contains("active_view_id"),
            "must not leak snake_case: {text}"
        );
        // `custom_title: None` is written as null (not skipped) — the frontend's
        // `PersistedTerminal.customTitle` is `string | null`, and a *present* null
        // is what says "this tab has no rename", as opposed to "older file".
        assert!(
            text.contains("\"customTitle\":null"),
            "an absent rename is an explicit null: {text}"
        );
    }

    #[test]
    fn save_creates_the_parent_dir() {
        let f = Fixture::new("mkdir");
        let nested = f.dir.join("does").join("not").join("exist").join(FILE_NAME);
        save(&nested, &sample()).unwrap();
        assert_eq!(load(&nested), sample(), "save creates the parent dir tree");
    }
}
