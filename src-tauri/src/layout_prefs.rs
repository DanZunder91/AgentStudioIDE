//! Persisted layout preferences keyed by absolute folder path: folder order (ONE list both rails
//! read), collapsed folders per rail, and the center layout (views, panes, terminals). Lives in
//! the OS app config dir, never a workspace; a missing or corrupt file loads as defaults.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// File name inside the config dir.
const FILE_NAME: &str = "layout-prefs.json";

/// Mirrors `Orientation` in `src/app/types.ts`. An enum, not a `String`: this type IS the
/// validator, so a hand-edited bad value is rejected before reaching live `PaneNode`s.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Orientation {
    Row,
    Column,
}

/// One restorable tab keyed by `TerminalId`, not `TabId` (minted fresh each boot): an agent's
/// terminal id is its agent id, which [`crate::pinned_agents`] reuses on re-spawn.
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

/// The frontend's `PaneNode` with each leaf's tabs replaced by restorable terminals. No pane
/// ids: they are minted fresh on hydrate, and a persisted one could collide with the boot tree.
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

/// Deserialize `T`, or `T::default()` when present but wrong-shaped, so one malformed field
/// (like the recursive `views` tree) can't fail the struct and lose the folder order in [`load`].
fn lenient<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::de::DeserializeOwned + Default,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(serde_json::from_value(value).unwrap_or_default())
}

/// [`Default`] (all empty) is what a missing/corrupt file loads as; every field is
/// `#[serde(default)]` so older files load. No `Eq`: `Split::sizes` is `Vec<f64>`.
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
    /// Selecting an agent collapses every other Files-rail folder and expands its working dir.
    /// Defaults to `false`.
    #[serde(default)]
    pub focus_follows_agent: bool,
    /// `"card"`, `"well"`, `"divider"` or `"pinned"`. A string, not an enum: the frontend owns
    /// the list, so a newer style round-trips through an older build. [`lenient`]: bad → `None`.
    #[serde(default, deserialize_with = "lenient")]
    pub rail_group_style: Option<String>,
    /// Ids of collapsed API-client saved-request folders (minted ids, no filesystem). Here, not in
    /// `api-store.json` (the Vault): this file is written wholesale with no Rust writer to race.
    /// A stale id is inert.
    #[serde(default)]
    pub collapsed_api_folders: Vec<String>,
    /// The center layout: every view in bar order with its name and panes, so restored terminals
    /// land back in their view. [`lenient`]: a malformed tree degrades to "no persisted layout"
    /// instead of blanking the folder order.
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

/// Replace the whole blob (`invoke('layout_prefs_save', { prefs })`). Main window only
/// (docs/design/tab-tearoff.md §4.2): the wholesale, non-atomic save needs exactly one writer,
/// and a detached window's save would be a lost update.
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
        // Why `views` is `lenient`: a wrong-shaped field fails the whole struct, and
        // `load` would then throw away the folder order.
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
