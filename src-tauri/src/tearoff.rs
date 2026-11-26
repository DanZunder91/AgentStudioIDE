//! Tab tear-off (`docs/design/tab-tearoff.md`): a tab crosses windows as a [`TornTab`]; its PTY
//! never moves (`terminal_reattach`). Tabs wait in a per-window mailbox until the receiver claims
//! them (a new window can't listen yet); a dead window's holdings re-home to main.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// The main window's label (`tauri.conf.json`). The only window that persists the layout,
/// owns the rails, and receives everything a dying detached window held.
pub const MAIN: &str = "main";

/// Every detached window's label starts with this. `capabilities/tearoff.json` grants
/// `tearoff-*`, and the frontend derives its window role from the same prefix.
pub const LABEL_PREFIX: &str = "tearoff-";

/// The doorbell: "you have mail — claim it". Payload is the addressee's label, so a page
/// can ignore a ring meant for another window even if Tauri delivered it (a JS listener
/// with the default `Any` target receives every `emit_to`, whatever its label).
pub const MAIL_EVENT: &str = "tearoff://mail";

/// Broadcast whenever the set of tabs held by detached windows changes. Payload:
/// `Vec<Holding>`. Every window caches it.
pub const HOLDINGS_EVENT: &str = "tearoff://holdings";

/// Sent to a detached window whose close button was pressed: hand your tabs (unsaved text
/// and undo history included) back to the main window, then call `tearoff_close`.
pub const CLOSING_EVENT: &str = "tearoff://closing";

/// How long a closing window gets to hand its tabs back before it is destroyed anyway. A
/// page that never answers (hung, crashed) must not make its window unclosable — and the
/// destroy path re-homes its last report, so even then nothing is killed.
pub const CLOSE_GRACE: Duration = Duration::from_secs(3);

/// A new window's size, in logical pixels. Smaller than the main window on purpose: it is
/// one tab, usually headed for a second monitor.
const NEW_WINDOW_SIZE: (f64, f64) = (960.0, 640.0);
const MIN_WINDOW_SIZE: (f64, f64) = (480.0, 320.0);

/// Where the cursor lands inside a window opened by a drag, in logical pixels from its
/// top-left: over the first tab of the new window's strip (below the native title bar),
/// so the tab appears to stay under the hand that dropped it — Chrome's behaviour.
const GRAB_OFFSET: (f64, f64) = (80.0, 44.0);

/// Is `label` a detached (torn-off) window?
pub fn is_tearoff(label: &str) -> bool {
    label.len() > LABEL_PREFIX.len() && label.starts_with(LABEL_PREFIX)
}

/// May the window `label` write `layout-prefs.json`? Only the main window: the file has
/// exactly one writer, which is what its wholesale non-atomic save relies on
/// (`layout_prefs.rs`; two writers and one mirror is a lost update).
pub fn writes_layout_prefs(label: &str) -> bool {
    label == MAIN
}

/* ───────────────────────────── the wire contract ───────────────────────────── */

/// A file's on-disk identity, as `file_stamps` reports it (`fs_tree::FileStamp`). Its own
/// type here because that one is serialise-only, and a torn tab travels both ways.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stamp {
    pub mtime_ms: Option<i64>,
    pub size: u64,
}

/// An editor's buffer, as it leaves one window for another. Everything a reader needs to
/// rebuild the editor exactly as it was, rather than re-reading the file from disk — which
/// would silently drop the user's unsaved edits.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorBuffer {
    /// What the buffer holds now, saved or not.
    pub text: String,
    /// The last saved (or loaded) text — the dirty flag is `text != baseline`.
    pub baseline: String,
    /// CodeMirror `EditorState.toJSON({ history })`, opaque to Rust and kept a STRING so its
    /// key order survives; `null` in a periodic holdings report (text only).
    #[serde(default)]
    pub state: Option<String>,
    /// The stamp the buffer was last read or written at, so the receiving window's disk
    /// watcher compares against the bytes on screen rather than re-stamping and missing an
    /// external change that landed before the move.
    #[serde(default)]
    pub stamp: Option<Stamp>,
    /// The buffer was already flagged as changed on disk (`staleOnDisk`).
    #[serde(default)]
    pub stale: bool,
}

/// One tab, enough to re-create it in another window (`src/app/tearoff/contract.ts`; golden
/// `src/test/contract/goldens/tearoff.json`). Kinds with live state (API requests, DB consoles,
/// …) are absent on purpose (tab-tearoff.md §3).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum TornTab {
    #[serde(rename_all = "camelCase")]
    Terminal {
        terminal_id: String,
        title: String,
        #[serde(default)]
        custom_title: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    AgentTerminal {
        terminal_id: String,
        agent_id: String,
        title: String,
        #[serde(default)]
        custom_title: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Editor {
        path: String,
        title: String,
        #[serde(default)]
        custom_title: Option<String>,
        /// `None` when the editor had not finished loading — the receiver reads the file.
        /// No `dirty` flag beside it on purpose: it is `text != baseline`, and a second copy
        /// of the same fact is one that can disagree.
        #[serde(default)]
        buffer: Option<EditorBuffer>,
    },
    #[serde(rename_all = "camelCase")]
    Diff {
        path: String,
        title: String,
    },
    #[serde(rename_all = "camelCase")]
    Metrics {
        cwd: Option<String>,
    },
    AgentLogs,
    Network,
    Village,
}

impl TornTab {
    /// The tab's identity across windows — at most one window may hold a key at a time.
    /// Mirrors `tabKey` in `src/app/tearoff/contract.ts`; the golden pins both.
    pub fn key(&self) -> String {
        match self {
            TornTab::Terminal { terminal_id, .. } | TornTab::AgentTerminal { terminal_id, .. } => {
                format!("terminal:{terminal_id}")
            }
            TornTab::Editor { path, .. } => format!("editor:{path}"),
            TornTab::Diff { path, .. } => format!("diff:{path}"),
            TornTab::Metrics { .. } => "metrics".to_string(),
            TornTab::AgentLogs => "agent-logs".to_string(),
            TornTab::Network => "network".to_string(),
            TornTab::Village => "village".to_string(),
        }
    }

    /// What the tab strip would call it — the new window's native title.
    fn label_text(&self) -> &str {
        match self {
            TornTab::Terminal {
                title,
                custom_title,
                ..
            }
            | TornTab::AgentTerminal {
                title,
                custom_title,
                ..
            }
            | TornTab::Editor {
                title,
                custom_title,
                ..
            } => custom_title.as_deref().unwrap_or(title),
            TornTab::Diff { title, .. } => title,
            TornTab::Metrics { .. } => "Metrics",
            TornTab::AgentLogs => "Logs",
            TornTab::Network => "Network",
            TornTab::Village => "Village",
        }
    }
}

/// One message in a window's mailbox (`Mail` in `contract.ts`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "kebab-case")]
pub enum Mail {
    /// Take these tabs: rehydrate them into your store (a move, or a re-home).
    Adopt { tabs: Vec<TornTab> },
    /// Bring the tab with this key to the front (the main rail clicked an agent you hold).
    Focus { key: String },
    /// Close the tab with this key for good (the main rail dismissed an agent you hold —
    /// the user already confirmed there, so this does not ask again).
    Close { key: String },
    /// To the main window: the user closed this agent's tab for good in a detached window,
    /// so drop it from the fleet rail and the pin registry too.
    #[serde(rename_all = "camelCase")]
    Dismissed { agent_id: String },
    /// To the window a dragged tab came from: it was dropped on window `to` — move it there
    /// (the receiving page cannot describe a tab that lives in another realm, so it asks).
    /// `tab_id` is the SENDER's own tab id, valid only in that window.
    #[serde(rename_all = "camelCase")]
    Give { tab_id: String, to: String },
    /// An agent's custom name changed (`None` = derived title). Detached → main, the only writer
    /// of `layout-prefs.json`; main → the holder, so its tab matches the rail.
    #[serde(rename_all = "camelCase")]
    Renamed {
        agent_id: String,
        #[serde(default)]
        name: Option<String>,
    },
}

/// What `tearoff_claim` answers: the tabs this window should be showing (non-empty only for
/// a detached window — after a reload, this is how it gets them back) and its drained mail.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Claim {
    pub tabs: Vec<TornTab>,
    pub mail: Vec<Mail>,
}

/// One detached window and the keys of the tabs it holds (`HOLDINGS_EVENT`'s payload).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Holding {
    pub label: String,
    pub keys: Vec<String>,
}

/// A point on the desktop, exactly as the page's `cursorPosition()` reported it.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct ScreenPoint {
    pub x: f64,
    pub y: f64,
}

/* ──────────────────────────────── the registry ──────────────────────────────── */

/// Everything this module remembers; plain data, so every rule is unit-tested without Tauri.
/// Invariant: a window is live exactly while `holdings` has its label, inserted only by
/// [`Registry::open`], so a late report cannot resurrect a dead one.
#[derive(Debug, Default)]
pub struct Registry {
    holdings: BTreeMap<String, Vec<TornTab>>,
    mail: BTreeMap<String, Vec<Mail>>,
    closing: BTreeSet<String>,
    next: u64,
}

impl Registry {
    /// Mint a label for a new window holding `tabs`, post them to it, and take them out of
    /// `sender`'s holdings (when the sender is itself a detached window).
    pub fn open(&mut self, sender: &str, tabs: Vec<TornTab>) -> String {
        self.next += 1;
        let label = format!("{LABEL_PREFIX}{}", self.next);
        self.release(sender, &tabs);
        self.holdings.insert(label.clone(), tabs.clone());
        self.mail
            .entry(label.clone())
            .or_default()
            .push(Mail::Adopt { tabs });
        label
    }

    /// Undo [`Registry::open`] for a window that failed to build. The sender re-adopts the
    /// tabs itself and its next report restores its own holdings.
    pub fn abort(&mut self, label: &str) {
        self.holdings.remove(label);
        self.mail.remove(label);
    }

    /// Post `mail` from `sender` to `to`. Refused when `to` is neither the main window nor
    /// a live detached one — mail to a dead window would sit unread forever, and for an
    /// `Adopt` that means tabs (and their running terminals) shown nowhere.
    pub fn send(&mut self, sender: &str, to: &str, mail: Mail) -> Result<(), String> {
        if to != MAIN && !self.holdings.contains_key(to) {
            return Err(format!("no window {to}"));
        }
        // A window may ask for a dragged tab to be given to ITSELF only — never direct a
        // third window's tabs somewhere else.
        if let Mail::Give { to: dest, .. } = &mail {
            if dest != sender {
                return Err(format!("{sender} cannot ask for a tab to go to {dest}"));
            }
        }
        if let Mail::Adopt { tabs } = &mail {
            self.release(sender, tabs);
            if let Some(held) = self.holdings.get_mut(to) {
                merge(held, tabs.iter().cloned());
            }
        }
        self.mail.entry(to.to_string()).or_default().push(mail);
        Ok(())
    }

    /// Drain `label`'s mailbox, plus the tabs it holds (a detached window's reload recovery).
    pub fn claim(&mut self, label: &str) -> Claim {
        Claim {
            tabs: self.holdings.get(label).cloned().unwrap_or_default(),
            mail: self.mail.remove(label).unwrap_or_default(),
        }
    }

    /// Replace what live detached window `label` holds (main and dead labels are ignored).
    /// Returns whether the set of KEYS changed, so a text-only refresh broadcasts nothing.
    pub fn report(&mut self, label: &str, tabs: Vec<TornTab>) -> bool {
        let Some(held) = self.holdings.get_mut(label) else {
            return false;
        };
        let before: Vec<String> = held.iter().map(TornTab::key).collect();
        let after: Vec<String> = tabs.iter().map(TornTab::key).collect();
        *held = tabs;
        before != after
    }

    /// The window `label` is gone. Everything it held — its last report, plus anything
    /// posted to it that it never claimed — is posted to the main window instead, and
    /// returned (empty when there was nothing to re-home).
    pub fn destroyed(&mut self, label: &str) -> Vec<TornTab> {
        self.closing.remove(label);
        let mut rehome = self.holdings.remove(label).unwrap_or_default();
        for mail in self.mail.remove(label).unwrap_or_default() {
            if let Mail::Adopt { tabs } = mail {
                merge(&mut rehome, tabs);
            }
        }
        if !rehome.is_empty() {
            self.mail
                .entry(MAIN.to_string())
                .or_default()
                .push(Mail::Adopt {
                    tabs: rehome.clone(),
                });
        }
        rehome
    }

    /// Whether to hold back `label`'s close while its page hands tabs over: true once per live
    /// detached window (a second press closes; destroy still re-homes), never for main.
    pub fn begin_close(&mut self, label: &str) -> bool {
        self.holdings.contains_key(label) && self.closing.insert(label.to_string())
    }

    /// Who holds what, in label order (deterministic, so a broadcast is diffable).
    pub fn holdings(&self) -> Vec<Holding> {
        self.holdings
            .iter()
            .map(|(label, tabs)| Holding {
                label: label.clone(),
                keys: tabs.iter().map(TornTab::key).collect(),
            })
            .collect()
    }

    /// Remove `tabs` (by key) from what `sender` holds. A no-op for the main window.
    fn release(&mut self, sender: &str, tabs: &[TornTab]) {
        if let Some(held) = self.holdings.get_mut(sender) {
            let keys: BTreeSet<String> = tabs.iter().map(TornTab::key).collect();
            held.retain(|t| !keys.contains(&t.key()));
        }
    }
}

/// Append each of `more` whose key `into` does not already hold. The version already in
/// `into` wins: in [`Registry::destroyed`] that is the window's latest report (an editor's
/// newest text), not the older copy that was posted to it.
fn merge(into: &mut Vec<TornTab>, more: impl IntoIterator<Item = TornTab>) {
    for tab in more {
        let key = tab.key();
        if !into.iter().any(|t| t.key() == key) {
            into.push(tab);
        }
    }
}

/// The managed state: one [`Registry`] for the app.
#[derive(Debug, Default)]
pub struct Tearoff(Mutex<Registry>);

impl Tearoff {
    /// The registry. Survives a poisoned lock: a panic elsewhere must not take window
    /// management (and with it, the way back to the main window) down too.
    pub fn lock(&self) -> MutexGuard<'_, Registry> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/* ──────────────────────────────── pure helpers ──────────────────────────────── */

/// The new window's native title: what its first tab is called, then the app.
pub fn window_title(tabs: &[TornTab]) -> String {
    match tabs.first() {
        Some(tab) => format!("{} — Agent Studio", tab.label_text()),
        None => "Agent Studio".to_string(),
    }
}

/// Top-left, in logical pixels, for a window dropped at `at`. `scale` is the platform's cursor
/// factor (macOS tao: the PRIMARY monitor's; see `placement_scale`); a nonsense one counts as 1.
/// Negative coordinates are legitimate (a monitor left of or above the primary).
pub fn window_origin(at: ScreenPoint, scale: f64) -> (f64, f64) {
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    (at.x / scale - GRAB_OFFSET.0, at.y / scale - GRAB_OFFSET.1)
}

/// The scale factor `window_origin` should divide `at` by — see its docs for why it
/// differs by platform. Falls back to 1 when the monitor cannot be read.
fn placement_scale(app: &AppHandle, at: ScreenPoint) -> f64 {
    #[cfg(target_os = "macos")]
    let monitor = {
        let _ = at; // macOS scales every cursor reading by the primary monitor
        app.primary_monitor()
    };
    #[cfg(not(target_os = "macos"))]
    let monitor = app.monitor_from_point(at.x, at.y);
    monitor
        .ok()
        .flatten()
        .map(|m| m.scale_factor())
        .unwrap_or(1.0)
}

/// Ring `label`'s doorbell. Best-effort: a window that is gone has nobody to tell, and its
/// mail is re-homed by the destroy path.
fn ring(app: &AppHandle, label: &str) {
    if let Err(e) = app.emit_to(label, MAIL_EVENT, label) {
        eprintln!("{MAIL_EVENT} to {label} failed: {e}");
    }
}

/// Tell every window who holds what now.
fn broadcast_holdings(app: &AppHandle, state: &Tearoff) {
    let holdings = state.lock().holdings();
    if let Err(e) = app.emit(HOLDINGS_EVENT, holdings) {
        eprintln!("{HOLDINGS_EVENT} emit failed: {e}");
    }
}

/* ────────────────────────────────── commands ────────────────────────────────── */

/// Open a window holding `tabs` moved out of the caller; `at` is the drop point, `None` lets
/// the OS place it. `async` because `build` deadlocks in a sync command on Windows
/// (tab-tearoff.md §4.1). Returns the new label.
#[tauri::command]
pub async fn tearoff_open(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, Tearoff>,
    tabs: Vec<TornTab>,
    at: Option<ScreenPoint>,
) -> Result<String, String> {
    if tabs.is_empty() {
        return Err("nothing to move".to_string());
    }
    let title = window_title(&tabs);
    let label = state.lock().open(window.label(), tabs);

    let mut builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()))
        .title(title)
        .inner_size(NEW_WINDOW_SIZE.0, NEW_WINDOW_SIZE.1)
        .min_inner_size(MIN_WINDOW_SIZE.0, MIN_WINDOW_SIZE.1)
        // 🔴 Load-bearing, exactly like `dragDropEnabled: false` on the main window
        // (`tauri.conf.json`): Tauri's drag-drop interception kills HTML5 drag on Windows,
        // and HTML5 drag is how a tab moves between panes — in this window too.
        .disable_drag_drop_handler()
        .focused(true);
    if let Some(at) = at {
        let (x, y) = window_origin(at, placement_scale(&app, at));
        builder = builder.position(x, y);
    }
    match builder.build() {
        Ok(_) => {
            broadcast_holdings(&app, &state);
            Ok(label)
        }
        Err(e) => {
            state.lock().abort(&label);
            Err(format!("could not open a new window: {e}"))
        }
    }
}

/// Post `mail` from the calling window to the window `to`, ring its doorbell, and bring it
/// to the front for an `Adopt` (the tab the user just moved is over there now) or a
/// `Focus` (that is the whole point of one).
#[tauri::command]
pub async fn tearoff_send(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, Tearoff>,
    to: String,
    mail: Mail,
) -> Result<(), String> {
    if to == window.label() {
        return Err("a window cannot post to itself".to_string());
    }
    let target = app
        .get_webview_window(&to)
        .ok_or_else(|| format!("no window {to}"))?;
    let raise = matches!(mail, Mail::Adopt { .. } | Mail::Focus { .. });
    let adopt = matches!(mail, Mail::Adopt { .. });
    state.lock().send(window.label(), &to, mail)?;
    ring(&app, &to);
    if raise {
        let _ = target.unminimize();
        let _ = target.set_focus();
    }
    if adopt {
        broadcast_holdings(&app, &state);
    }
    Ok(())
}

/// The calling window's mail, plus — for a detached window — the tabs it holds.
#[tauri::command]
pub fn tearoff_claim(window: WebviewWindow, state: State<'_, Tearoff>) -> Claim {
    state.lock().claim(window.label())
}

/// A detached window's report of everything it holds now (unsaved editor text included,
/// undo history not). Re-broadcasts the holdings only when the set of tabs changed.
#[tauri::command]
pub fn tearoff_report(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, Tearoff>,
    tabs: Vec<TornTab>,
) {
    if state.lock().report(window.label(), tabs) {
        broadcast_holdings(&app, &state);
    }
}

/// Who holds what — the boot read behind the `HOLDINGS_EVENT` cache.
#[tauri::command]
pub fn tearoff_holdings(state: State<'_, Tearoff>) -> Vec<Holding> {
    state.lock().holdings()
}

/// A detached window that has handed its tabs back asks to be destroyed. Refused for the
/// main window: closing it is quitting the app, which is the user's gesture to make.
#[tauri::command]
pub async fn tearoff_close(window: WebviewWindow) -> Result<(), String> {
    if !is_tearoff(window.label()) {
        return Err("only a detached window closes itself".to_string());
    }
    window.destroy().map_err(|e| e.to_string())
}

/* ──────────────────────────────── window events ──────────────────────────────── */

/// Window lifecycle: a detached close is held once while its page hands tabs to main (destroyed
/// after [`CLOSE_GRACE`] regardless); a destroyed detached window's tabs go to main's mailbox;
/// main destroyed quits the app.
pub fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    let label = window.label();
    match event {
        tauri::WindowEvent::CloseRequested { api, .. } if is_tearoff(label) => {
            let Some(state) = window.try_state::<Tearoff>() else {
                return;
            };
            if !state.lock().begin_close(label) {
                return;
            }
            api.prevent_close();
            if let Err(e) = window.emit_to(label, CLOSING_EVENT, label) {
                eprintln!("{CLOSING_EVENT} to {label} failed: {e}");
            }
            let doomed = window.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(CLOSE_GRACE).await;
                // Already gone (the page closed itself) → an error nobody needs to see.
                let _ = doomed.destroy();
            });
        }
        tauri::WindowEvent::Destroyed if label == MAIN => window.app_handle().exit(0),
        tauri::WindowEvent::Destroyed if is_tearoff(label) => {
            let Some(state) = window.try_state::<Tearoff>() else {
                return;
            };
            let app = window.app_handle();
            if !state.lock().destroyed(label).is_empty() {
                ring(app, MAIN);
            }
            broadcast_holdings(app, &state);
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn term(id: &str) -> TornTab {
        TornTab::Terminal {
            terminal_id: id.to_string(),
            title: id.to_string(),
            custom_title: None,
        }
    }

    fn editor(path: &str, text: &str) -> TornTab {
        TornTab::Editor {
            path: path.to_string(),
            title: "a.ts".to_string(),
            custom_title: None,
            buffer: Some(EditorBuffer {
                text: text.to_string(),
                baseline: "saved".to_string(),
                state: None,
                stamp: None,
                stale: false,
            }),
        }
    }

    fn keys(tabs: &[TornTab]) -> Vec<String> {
        tabs.iter().map(TornTab::key).collect()
    }

    #[test]
    fn labels_tell_detached_windows_from_main() {
        assert!(is_tearoff("tearoff-1"));
        assert!(is_tearoff("tearoff-42"));
        assert!(!is_tearoff("main"));
        // The bare prefix is not a window this module ever mints.
        assert!(!is_tearoff("tearoff-"));
        assert!(!is_tearoff("xtearoff-1"));
    }

    #[test]
    fn only_the_main_window_writes_layout_prefs() {
        assert!(writes_layout_prefs("main"));
        assert!(!writes_layout_prefs("tearoff-1"));
        assert!(!writes_layout_prefs("Main"));
    }

    #[test]
    fn keys_are_one_per_identity() {
        assert_eq!(term("T1").key(), "terminal:T1");
        let agent = TornTab::AgentTerminal {
            terminal_id: "A1".into(),
            agent_id: "A1".into(),
            title: "gazelle".into(),
            custom_title: None,
        };
        // An agent terminal and a plain one share the PTY id space (supervisor/mod.rs), so
        // they share the key space too.
        assert_eq!(agent.key(), "terminal:A1");
        assert_eq!(editor("/w/a.ts", "x").key(), "editor:/w/a.ts");
        let diff = TornTab::Diff {
            path: "/w/a.ts".into(),
            title: "a.ts ↔ HEAD".into(),
        };
        // A file open for editing AND as a diff is two tabs, so two keys.
        assert_eq!(diff.key(), "diff:/w/a.ts");
        assert_eq!(TornTab::Metrics { cwd: None }.key(), "metrics");
        assert_eq!(TornTab::AgentLogs.key(), "agent-logs");
        assert_eq!(TornTab::Network.key(), "network");
        assert_eq!(TornTab::Village.key(), "village");
    }

    #[test]
    fn open_mints_unique_labels_and_posts_the_tabs() {
        let mut r = Registry::default();
        let a = r.open(MAIN, vec![term("T1")]);
        let b = r.open(MAIN, vec![term("T2")]);
        assert_eq!(a, "tearoff-1");
        assert_eq!(b, "tearoff-2");
        assert!(is_tearoff(&a) && is_tearoff(&b));

        let claim = r.claim(&a);
        assert_eq!(
            claim.mail,
            vec![Mail::Adopt {
                tabs: vec![term("T1")]
            }]
        );
        // Held from the moment of the move — before the window has even booted — so a main
        // reload in that gap already knows not to re-attach T1.
        assert_eq!(keys(&claim.tabs), vec!["terminal:T1"]);
    }

    #[test]
    fn a_claim_drains_only_the_callers_mailbox_once() {
        let mut r = Registry::default();
        let a = r.open(MAIN, vec![term("T1")]);
        let b = r.open(MAIN, vec![term("T2")]);
        assert_eq!(r.claim(&a).mail.len(), 1);
        assert!(r.claim(&a).mail.is_empty(), "mail is delivered once");
        // A's claim never touched B's mail.
        assert_eq!(r.claim(&b).mail.len(), 1);
        // The main window has no holdings of its own.
        assert_eq!(r.claim(MAIN), Claim::default());
    }

    #[test]
    fn a_reload_recovers_what_the_window_holds() {
        let mut r = Registry::default();
        let a = r.open(MAIN, vec![term("T1")]);
        let _ = r.claim(&a); // first boot consumed the mail
        r.report(&a, vec![term("T1"), editor("/w/a.ts", "unsaved")]);
        // The page reloads: its store is empty, its mail is gone — the holdings are not.
        let again = r.claim(&a);
        assert!(again.mail.is_empty());
        assert_eq!(keys(&again.tabs), vec!["terminal:T1", "editor:/w/a.ts"]);
    }

    #[test]
    fn report_says_whether_the_set_of_tabs_changed() {
        let mut r = Registry::default();
        let a = r.open(MAIN, vec![editor("/w/a.ts", "one")]);
        // Same tab, new text: not news for the holdings broadcast…
        assert!(!r.report(&a, vec![editor("/w/a.ts", "two")]));
        // …but the text itself is kept, for a re-home.
        assert_eq!(r.claim(&a).tabs, vec![editor("/w/a.ts", "two")]);
        assert!(r.report(&a, vec![editor("/w/a.ts", "two"), term("T9")]));
        assert!(r.report(&a, vec![]));
    }

    #[test]
    fn a_report_cannot_resurrect_a_window() {
        let mut r = Registry::default();
        let a = r.open(MAIN, vec![term("T1")]);
        r.destroyed(&a);
        // A late report from the dying page…
        assert!(!r.report(&a, vec![term("T1")]));
        // …must not bring the window back, or the main window would skip T1 on every reload.
        assert!(r.holdings().is_empty());
        // Nor can a never-opened label, or the main window, report holdings into existence.
        assert!(!r.report("tearoff-99", vec![term("T5")]));
        assert!(!r.report(MAIN, vec![term("T6")]));
        assert!(r.holdings().is_empty());
    }

    #[test]
    fn adopt_moves_holdings_between_detached_windows() {
        let mut r = Registry::default();
        let a = r.open(MAIN, vec![term("T1"), term("T2")]);
        let b = r.open(MAIN, vec![term("T3")]);
        r.send(
            &a,
            &b,
            Mail::Adopt {
                tabs: vec![term("T2")],
            },
        )
        .unwrap();
        let held = r.holdings();
        assert_eq!(held[0].label, a);
        assert_eq!(held[0].keys, vec!["terminal:T1"]);
        assert_eq!(held[1].label, b);
        assert_eq!(held[1].keys, vec!["terminal:T3", "terminal:T2"]);
    }

    #[test]
    fn adopt_to_main_releases_the_senders_holdings() {
        let mut r = Registry::default();
        let a = r.open(MAIN, vec![term("T1"), term("T2")]);
        r.send(
            &a,
            MAIN,
            Mail::Adopt {
                tabs: vec![term("T1")],
            },
        )
        .unwrap();
        assert_eq!(r.holdings()[0].keys, vec!["terminal:T2"]);
        assert_eq!(
            r.claim(MAIN).mail,
            vec![Mail::Adopt {
                tabs: vec![term("T1")]
            }]
        );
    }

    #[test]
    fn opening_from_a_detached_window_releases_its_holdings() {
        let mut r = Registry::default();
        let a = r.open(MAIN, vec![term("T1"), term("T2")]);
        let b = r.open(&a, vec![term("T2")]);
        let held = r.holdings();
        assert_eq!(held[0].keys, vec!["terminal:T1"], "{a} gave T2 away");
        assert_eq!(held[1].label, b);
        assert_eq!(held[1].keys, vec!["terminal:T2"]);
    }

    #[test]
    fn mail_to_a_window_that_is_not_live_is_refused() {
        let mut r = Registry::default();
        let a = r.open(MAIN, vec![term("T1")]);
        assert!(r
            .send(
                MAIN,
                "tearoff-77",
                Mail::Focus {
                    key: "terminal:T1".into()
                }
            )
            .is_err());
        r.destroyed(&a);
        let err = r
            .send(
                MAIN,
                &a,
                Mail::Close {
                    key: "terminal:T1".into(),
                },
            )
            .unwrap_err();
        assert!(err.contains(&a), "{err}");
        // The main window is always live.
        assert!(r
            .send(
                &a,
                MAIN,
                Mail::Dismissed {
                    agent_id: "A1".into()
                }
            )
            .is_ok());
    }

    #[test]
    fn a_window_asks_for_dragged_tabs_for_itself_only() {
        let mut r = Registry::default();
        let a = r.open(MAIN, vec![term("T1")]);
        let b = r.open(MAIN, vec![term("T2")]);
        // A booted and took the tabs it was opened for.
        let _ = r.claim(&a);
        // B had a tab of A's dropped on it: B asks A to give it to B. Fine.
        r.send(
            &b,
            &a,
            Mail::Give {
                tab_id: "tab-1".into(),
                to: b.clone(),
            },
        )
        .unwrap();
        assert_eq!(
            r.claim(&a).mail,
            vec![Mail::Give {
                tab_id: "tab-1".into(),
                to: b.clone()
            }]
        );
        // B asking A to give a tab to the MAIN window is not B's call to make.
        let err = r
            .send(
                &b,
                &a,
                Mail::Give {
                    tab_id: "tab-1".into(),
                    to: MAIN.into(),
                },
            )
            .unwrap_err();
        assert!(err.contains("cannot ask"), "{err}");
        assert!(
            r.claim(&a).mail.is_empty(),
            "a refused message is not posted"
        );
        // A give moves nothing by itself — the Adopt that answers it does.
        assert_eq!(r.holdings()[0].keys, vec!["terminal:T1"]);
    }

    #[test]
    fn a_destroyed_window_rehomes_everything_to_main() {
        let mut r = Registry::default();
        let a = r.open(MAIN, vec![term("T1")]);
        let _ = r.claim(&a);
        r.report(&a, vec![term("T1"), editor("/w/a.ts", "newest")]);
        // Posted to A, never claimed (A died first).
        let b = r.open(MAIN, vec![term("T7")]);
        r.send(
            &b,
            &a,
            Mail::Adopt {
                tabs: vec![term("T7")],
            },
        )
        .unwrap();

        let rehomed = r.destroyed(&a);
        assert_eq!(
            keys(&rehomed),
            vec!["terminal:T1", "editor:/w/a.ts", "terminal:T7"]
        );
        // The newest report wins over any older copy — the unsaved text survives.
        assert_eq!(rehomed[1], editor("/w/a.ts", "newest"));
        assert_eq!(
            r.claim(MAIN).mail,
            vec![Mail::Adopt { tabs: rehomed }],
            "posted to the main window"
        );
        assert!(
            r.holdings().iter().all(|h| h.label != a),
            "A is no longer live"
        );
    }

    #[test]
    fn the_newest_report_beats_the_copy_the_window_was_opened_with() {
        // Opened with "old", never claimed (the page died during boot), yet it had already
        // reported "new". The re-home must carry the report, not the stale posted copy —
        // `merge` keeps the version already gathered and drops the later duplicate.
        let mut r = Registry::default();
        let a = r.open(MAIN, vec![editor("/w/a.ts", "old")]);
        r.report(&a, vec![editor("/w/a.ts", "new")]);
        let rehomed = r.destroyed(&a);
        assert_eq!(rehomed, vec![editor("/w/a.ts", "new")]);
        assert_eq!(
            r.claim(MAIN).mail,
            vec![Mail::Adopt {
                tabs: vec![editor("/w/a.ts", "new")]
            }]
        );
    }

    #[test]
    fn a_never_claimed_window_rehomes_its_tabs_once() {
        // Holdings and the pending Adopt describe the same tabs; the re-home must not
        // duplicate them.
        let mut r = Registry::default();
        let a = r.open(MAIN, vec![term("T1"), editor("/w/a.ts", "x")]);
        let rehomed = r.destroyed(&a);
        assert_eq!(keys(&rehomed), vec!["terminal:T1", "editor:/w/a.ts"]);
    }

    #[test]
    fn destroying_an_empty_or_unknown_window_posts_nothing() {
        let mut r = Registry::default();
        let a = r.open(MAIN, vec![term("T1")]);
        let _ = r.claim(&a);
        r.report(&a, vec![]);
        assert!(r.destroyed(&a).is_empty());
        assert!(r.destroyed("tearoff-99").is_empty());
        assert!(
            r.claim(MAIN).mail.is_empty(),
            "no empty Adopt for the main window"
        );
    }

    #[test]
    fn abort_forgets_a_window_that_never_opened() {
        let mut r = Registry::default();
        let a = r.open(MAIN, vec![term("T1")]);
        r.abort(&a);
        assert!(r.holdings().is_empty());
        assert_eq!(r.claim(&a), Claim::default());
        // And it is not live: nothing can be posted to it.
        assert!(r
            .send(
                MAIN,
                &a,
                Mail::Focus {
                    key: "terminal:T1".into()
                }
            )
            .is_err());
    }

    #[test]
    fn the_close_handshake_runs_once_per_live_window() {
        let mut r = Registry::default();
        let a = r.open(MAIN, vec![term("T1")]);
        assert!(
            r.begin_close(&a),
            "first press: hold the close, hand the tabs over"
        );
        assert!(!r.begin_close(&a), "second press: let it close");
        assert!(!r.begin_close(MAIN), "the main window is never held back");
        assert!(
            !r.begin_close("tearoff-99"),
            "nor a window that is not live"
        );
        r.destroyed(&a);
        assert!(!r.begin_close(&a));
    }

    #[test]
    fn the_window_title_names_the_first_tab() {
        assert_eq!(window_title(&[term("gazelle")]), "gazelle — Agent Studio");
        let renamed = TornTab::AgentTerminal {
            terminal_id: "A1".into(),
            agent_id: "A1".into(),
            title: "gazelle".into(),
            custom_title: Some("reviewer".into()),
        };
        assert_eq!(window_title(&[renamed]), "reviewer — Agent Studio");
        assert_eq!(window_title(&[TornTab::Village]), "Village — Agent Studio");
        assert_eq!(
            window_title(&[TornTab::Metrics { cwd: None }]),
            "Metrics — Agent Studio"
        );
        assert_eq!(window_title(&[TornTab::AgentLogs]), "Logs — Agent Studio");
        assert_eq!(window_title(&[TornTab::Network]), "Network — Agent Studio");
        let diff = TornTab::Diff {
            path: "/w/a.ts".into(),
            title: "a.ts ↔ HEAD".into(),
        };
        assert_eq!(window_title(&[diff]), "a.ts ↔ HEAD — Agent Studio");
        assert_eq!(window_title(&[]), "Agent Studio");
    }

    #[test]
    fn window_origin_puts_the_cursor_over_the_first_tab() {
        // A 2x display: physical (1000, 600) is logical (500, 300).
        let (x, y) = window_origin(
            ScreenPoint {
                x: 1000.0,
                y: 600.0,
            },
            2.0,
        );
        assert_eq!((x, y), (500.0 - GRAB_OFFSET.0, 300.0 - GRAB_OFFSET.1));
        // A monitor LEFT of the primary one has negative x — legitimate, kept as is.
        let (x, y) = window_origin(
            ScreenPoint {
                x: -1500.0,
                y: 200.0,
            },
            1.0,
        );
        assert_eq!((x, y), (-1500.0 - GRAB_OFFSET.0, 200.0 - GRAB_OFFSET.1));
        // A nonsense scale factor is 1, never a window at infinity.
        for bad in [0.0, -2.0, f64::NAN, f64::INFINITY] {
            let (x, y) = window_origin(ScreenPoint { x: 300.0, y: 300.0 }, bad);
            assert_eq!(
                (x, y),
                (300.0 - GRAB_OFFSET.0, 300.0 - GRAB_OFFSET.1),
                "{bad}"
            );
        }
    }

    #[test]
    fn the_wire_spells_kinds_and_fields_the_way_the_page_does() {
        // Hand-written JSON, not serialised from the type under test.
        let tab: TornTab = serde_json::from_str(
            r#"{"kind":"agent-terminal","terminalId":"A1","agentId":"A1","title":"gazelle","customTitle":"reviewer"}"#,
        )
        .unwrap();
        assert_eq!(
            tab,
            TornTab::AgentTerminal {
                terminal_id: "A1".into(),
                agent_id: "A1".into(),
                title: "gazelle".into(),
                custom_title: Some("reviewer".into()),
            }
        );
        // Optional fields may be absent (an older page), never a parse error.
        let tab: TornTab =
            serde_json::from_str(r#"{"kind":"editor","path":"/w/a.ts","title":"a.ts"}"#).unwrap();
        assert_eq!(
            tab,
            TornTab::Editor {
                path: "/w/a.ts".into(),
                title: "a.ts".into(),
                custom_title: None,
                buffer: None,
            }
        );
        let mail: Mail = serde_json::from_str(r#"{"t":"dismissed","agentId":"A1"}"#).unwrap();
        assert_eq!(
            mail,
            Mail::Dismissed {
                agent_id: "A1".into()
            }
        );
        let mail: Mail =
            serde_json::from_str(r#"{"t":"give","tabId":"tab-7","to":"tearoff-3"}"#).unwrap();
        assert_eq!(
            mail,
            Mail::Give {
                tab_id: "tab-7".into(),
                to: "tearoff-3".into()
            }
        );
        let mail: Mail =
            serde_json::from_str(r#"{"t":"renamed","agentId":"A1","name":null}"#).unwrap();
        assert_eq!(
            mail,
            Mail::Renamed {
                agent_id: "A1".into(),
                name: None
            }
        );
        let logs: TornTab = serde_json::from_str(r#"{"kind":"agent-logs"}"#).unwrap();
        assert_eq!(logs, TornTab::AgentLogs);
        // A kind this build does not know is refused at the door, not half-adopted.
        assert!(
            serde_json::from_str::<TornTab>(r#"{"kind":"db-console","connectionId":"c"}"#).is_err()
        );
    }
}
