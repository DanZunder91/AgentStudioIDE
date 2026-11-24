//! Agent Studio — Rust core.
//!
//! Module layout mirrors the two data planes (ARCHITECTURE §3):
//! `pty` + `stream` = the **hot** byte plane (PTY bytes → `ipc::Channel`, never
//! through React state, never JSON); `supervisor` = the **cold** control plane
//! (an actor owning every terminal, driven by an mpsc command loop).
//!
//! M1 ships terminals. `agent/` (fan-out) and `workspace/` (fs watch) follow.

// `pub` (not `mod`) so `src-tauri/tests/**` — which links this crate as an rlib —
// can drive the real PTY/coalescer/supervisor code. Visibility only:
// nothing here is part of the JS wire contract, which is the `#[tauri::command]`
// surface in `supervisor::commands`.
pub mod agent;
pub mod api_store;
pub mod browser_open;
pub mod build_info;
pub mod capacity;
pub mod context_usage;
pub mod db;
pub mod events;
pub mod external_agents;
pub mod find;
pub mod find_cancel;
pub mod find_files;
pub mod find_walk;
pub mod fs_tree;
pub mod gh_prs;
pub mod git;
pub mod git_blame;
pub mod git_file;
pub mod git_status;
pub mod grpc;
pub mod history_store;
pub mod hook_listener;
pub mod html_preview;
pub mod http;
pub mod layout_prefs;
pub mod logstream;
pub mod lsp;
pub mod menu;
pub mod metrics;
pub mod model;
pub mod nav_guard;
pub mod netcap;
pub mod netmachine;
pub mod open_agents;
pub mod paths;
pub mod pinned_agents;
pub mod portability;
pub mod procscan;
pub mod pty;
pub mod recent_projects;
pub mod session_index;
pub mod settings_merge;
pub mod spawn;
pub mod store_file;
pub mod stream;
pub mod supervisor;
pub mod syslog;
pub mod tearoff;
pub mod tls;
pub mod url_open;
pub mod usage;
pub mod weather;
pub mod webview_keys;
pub mod winshim;
pub mod workspace;
pub mod ws;

use std::sync::Arc;

use tauri::Manager;

use agent::claude::subagent_activity;
use api_store::{
    api_folder_create, api_folder_delete, api_folder_rename, api_folder_reorder, api_request_move,
    api_store_load, api_store_save,
};
use find::find_in_files;
use find_cancel::find_cancel;
use find_files::find_files;
use fs_tree::{
    create_directory, create_file, delete_path, file_stamps, read_dir, read_file,
    read_image_data_url, rename_path, write_file,
};
use grpc::{grpc_reflect, grpc_send};
use history_store::{api_history_load, api_history_save};
use http::http_send;
use layout_prefs::{layout_prefs_load, layout_prefs_save};
use lsp::commands::{lsp_send, lsp_start, lsp_stop};
use pinned_agents::{pin_agent, pinned_agents, unpin_agent};
use recent_projects::{push_recent_project, recent_projects};
use supervisor::commands::{
    agent_spawn, ensure_agent_hooks, fleet_snapshot, terminal_close, terminal_open,
    terminal_reattach, terminal_resize, terminal_write, terminals_busy,
};
use workspace::default_workspace;
use ws::{ws_close, ws_connect, ws_send};

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Install the ONE rustls crypto provider (`ring`) before anything can open a socket
    // `reqwest` is built with `rustls-no-provider`, so its `ClientBuilder`
    // PANICS if no process default is installed — and doing it here, once, is what makes
    // `http_send`, `ws_connect` and the gRPC dial provably share a backend instead of
    // each falling back to its own crate-feature default. Idempotent: the clients call it
    // again defensively (see `src/tls.rs` for why).
    tls::install_crypto_provider();

    tauri::Builder::default()
        // Native directory picker for choosing a workspace; the frontend
        // calls it via @tauri-apps/plugin-dialog `open({ directory: true })`.
        .plugin(tauri_plugin_dialog::init())
        // The window may only show the app — no navigation to remote pages, files or
        // data: URLs (see `nav_guard`).
        .plugin(nav_guard::plugin())
        // Windows: WebView2's own browser keys off in every window — Ctrl+R/F5 reloaded the
        // whole IDE, Ctrl+P printed it (see `webview_keys`). A no-op on macOS/Linux.
        .plugin(webview_keys::plugin())
        // `preview://` — the rendered HTML preview's transport. Registering a
        // scheme is Rust-only: it needs no `tauri.conf.json` entry, but the app CSP
        // must name it in `frame-src` or the iframe is blocked. Asynchronous so the
        // asset read runs on a blocking worker rather than the event-loop thread.
        .register_asynchronous_uri_scheme_protocol(html_preview::SCHEME, html_preview::handle)
        // Tab tear-off (docs/design/tab-tearoff.md): the registry of which detached window
        // holds which tab, and their lifecycle — a detached window's tabs go back to the
        // main window when it closes, and closing the main window quits the app.
        .manage(tearoff::Tearoff::default())
        .on_window_event(|window, event| {
            // The main window going away IS the app quitting (`tearoff` exits on it):
            // raise the supervisor's shutting-down flag before anything can tear a PTY
            // down, so the agents stay in `open-agents.json` and come back next launch.
            // `Destroyed`, not `CloseRequested`: a close request can still be refused.
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed) {
                begin_fleet_shutdown(window.app_handle());
            }
            tearoff::on_window_event(window, event);
        })
        .setup(|app| {
            // The Network view's capture proxy. FIRST,
            // so its port is known before any PTY (pinned-agent restore included) asks
            // `netcap::pty_env` for the proxy vars — and the CA bundle is on disk before it
            // returns, so no PTY gets a CA variable naming a missing file.
            // A bind failure logs and runs on.
            netcap::start(app.handle());
            // One supervisor for the whole app; the handle is cheap to clone and
            // is how every command reaches the registry.
            //
            // The sink and the adapter list are injected (rather than built inside
            // the supervisor) so the whole agent lifecycle stays testable without
            // a Tauri app or a real `claude`. Adding a runtime is one more entry
            // here and one more impl of `AgentAdapter` — the adapter seam.
            let sink = Arc::new(events::TauriEventSink(app.handle().clone()));

            // Bind the ad-hoc-detection listener FIRST: its URL + token
            // must exist before the supervisor spawns any PTY, because every PTY
            // gets them injected. If binding fails (no localhost?), the app still
            // runs — just without ad-hoc `claude` detection.
            let adapters = || vec![Arc::new(agent::claude::ClaudeAdapter::new()) as _];
            // The Agent Logs hub: every PTY's pump
            // taps into it, and the fan-out tailers feed it tool calls.
            let logs =
                logstream::LogHub::spawn(Arc::new(logstream::TauriLogSink(app.handle().clone())));
            app.manage(logs.clone());
            // For dev-app discovery, managed below once the supervisor exists.
            let procs_logs = logs.clone();
            // System-app logs into the same hub:
            // resumes only if the persisted prefs say so (default off).
            syslog::setup(app.handle(), logs.clone());
            // Open agents come back after a restart (`open_agents.rs`): the registry the
            // supervisor writes on spawn / close / own exit. The REAL app-config file is
            // only ever named here, on real boot (tests never touch it).
            let open_agents_store = open_agents::store_path(app.handle());
            let handle = match hook_listener::HookListener::bind() {
                Ok((listener, config)) => {
                    let handle = supervisor::spawn_supervisor_with_store(
                        sink,
                        adapters(),
                        Some(config),
                        Some(logs),
                        Some(open_agents_store),
                    );
                    // The listener forwards token-checked hooks to the supervisor.
                    let for_hooks = handle.clone();
                    listener.serve(move |terminal_id, body| {
                        for_hooks.deliver_hook(terminal_id, body);
                    });
                    handle
                }
                Err(e) => {
                    eprintln!("ad-hoc detection disabled: hook listener bind failed: {e}");
                    supervisor::spawn_supervisor_with_store(
                        sink,
                        adapters(),
                        None,
                        Some(logs),
                        Some(open_agents_store),
                    )
                }
            };

            // Re-open every agent of the last session — the open ones and the pinned
            // ones, once each (`open_agents.rs`; a resume-or-fresh ladder per agent). Reads
            // the real stores — ONLY on real app boot, a path `cargo test` never runs.
            // Enqueued synchronously, before the webview exists, so its
            // first `fleet_snapshot` already has them and the layout restore puts each
            // back in its pane via the terminal re-attach path.
            open_agents::restore_on_boot(app.handle(), &handle);

            // Dev apps on this machine: discovery,
            // their log tails into the hub, Restart in the IDE. Managed after the supervisor
            // because it reads the supervisor's terminal table to say which app an IDE
            // terminal or agent started. Nothing runs until the view asks
            // (`procs_list`); the docker CLI is only `stat`ed here.
            app.manage(procscan::Procs::for_app(procs_logs, handle.ide_terminals()));

            app.manage(handle);

            // The LSP transport relay: a second child-process fleet,
            // independent of the agent supervisor. Managed like `SupervisorHandle`.
            app.manage(lsp::spawn_lsp_supervisor());

            // Native menu: rebind Cmd+W to "Close Tab" (macOS). Best-effort — a
            // menu failure logs and keeps the default menu, never blocks startup.
            menu::install(app);

            // Stamp the build identity into the window title.
            // Set here rather than in `tauri.conf.json` for two reasons: the commit
            // is only known at compile time, and a static title would repeat the
            // version by hand — a second copy, free to drift from the one the
            // bundle carries. `package_info()` gives us both halves from the same
            // place the installer reads them.
            match app.get_webview_window("main") {
                Some(window) => {
                    let info = app.package_info();
                    let title = build_info::window_title(
                        &info.name,
                        &info.version.to_string(),
                        build_info::COMMIT,
                    );
                    if let Err(e) = window.set_title(&title) {
                        eprintln!("window title: could not set {title:?}: {e}");
                    }
                }
                // Loud, because the symptom — a title with no version — looks
                // exactly like the feature never having shipped.
                None => eprintln!(
                    "window title: no window labelled \"main\"; left at the config default"
                ),
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            terminal_open,
            terminal_write,
            terminal_resize,
            terminal_close,
            terminal_reattach,
            agent_spawn,
            fleet_snapshot,
            // "Is anything running in these terminals?" — asked at close time so
            // the confirm can name what the user is about to lose.
            terminals_busy,
            ensure_agent_hooks,
            // Agent Logs.
            logstream::logstream_snapshot,
            logstream::logstream_clear,
            // System-app logs.
            syslog::syslog_status,
            syslog::syslog_set,
            syslog::syslog_apps,
            // Network capture.
            netcap::netcap_status,
            netcap::netcap_set,
            netcap::netcap_set_app_decrypt,
            netcap::netcap_set_strict,
            netcap::netcap_snapshot,
            netcap::netcap_flow,
            netcap::netcap_clear,
            // Network · whole computer.
            netmachine::netmachine_status,
            netmachine::netmachine_start,
            netmachine::netmachine_stop,
            // Dev apps on this machine + their logs.
            procscan::procs_list,
            procscan::procs_restart_prepare,
            procscan::procs_restart_in_ide,
            procscan::logstream_tail_app,
            procscan::logstream_tail_docker,
            procscan::logstream_untail,
            procscan::logstream_pick_file,
            default_workspace,
            recent_projects,
            push_recent_project,
            pinned_agents,
            pin_agent,
            unpin_agent,
            // The "Resumed after restart" markers (open_agents.rs).
            open_agents::restored_agents,
            subagent_activity,
            session_index::list_claude_sessions,
            session_index::agent_resume_session,
            git_blame::git_blame,
            git_status::git_status,
            // Git ▸ Compare / Git ▸ Revert on the file tree's context menu. `restore`
            // is `git checkout HEAD -- <path>` for ONE file, not `git revert` — see
            // `git_file.rs`'s module header before touching either.
            git_file::git_file_diff,
            git_file::git_file_restore,
            gh_prs::gh_prs,
            url_open::url_open,
            // "Open in Browser" on an .html file in the tree. Separate from
            // `url_open`, which is https-only by design — see
            // `browser_open.rs`'s header.
            browser_open::list_browsers,
            browser_open::open_in_browser,
            read_dir,
            read_file,
            file_stamps,
            read_image_data_url,
            write_file,
            create_directory,
            create_file,
            rename_path,
            delete_path,
            lsp_start,
            lsp_send,
            lsp_stop,
            lsp::project_root::lsp_project_root,
            find_in_files,
            find_files,
            // Both searches are now `async` + `spawn_blocking` (they used to freeze the
            // whole window), and this is what kills one mid-flight.
            find_cancel,
            http_send,
            api_store_load,
            api_store_save,
            // Folders for saved requests. Commands rather than
            // more fields on the `api_store_save` blob, because each one re-reads the file
            // before it writes — see `api_store::edit_store`.
            api_folder_create,
            api_folder_rename,
            api_folder_delete,
            api_folder_reorder,
            api_request_move,
            api_history_load,
            api_history_save,
            layout_prefs_load,
            layout_prefs_save,
            ws_connect,
            ws_send,
            ws_close,
            grpc_reflect,
            grpc_send,
            usage::claude_usage,
            context_usage::context_usage,
            metrics::claude_metrics,
            // Agent Village: the `claude` sessions running OUTSIDE the IDE, read-only
            // off ~/.claude/projects + the process table (external_agents.rs).
            external_agents::list_external_agents,
            // …and a click on one brings the app it runs in (iTerm2, Terminal, VS Code)
            // to the front via `open` — by the opaque key of the last scan, no AppleScript.
            external_agents::focus_external_agent,
            // …and the sky over the village: the live weather at the user's time zone's
            // principal city (Open-Meteo, city-level coordinates only — weather.rs).
            weather::village_weather,
            // …and its Seats / Memory buildings: CPU count, RAM, and what this user's `claude`
            // processes hold — read-only off the process table (capacity.rs).
            capacity::machine_capacity,
            // ── the built-in database client. See `db/mod.rs` for what this surface does
            //    and does not claim.
            db::db_engines,
            db::db_connections_load,
            db::db_connection_upsert,
            db::db_connection_delete,
            db::db_test_connection,
            db::db_url_build,
            db::db_url_parse,
            db::db_open,
            db::db_close,
            db::db_children,
            // The hand-arranged table order. Read with a connection id
            // and no session, like the saved queries: the arrangement is the user's, not the
            // server's, so it is there even when the database is unreachable.
            db::db_tree_order,
            db::db_tree_order_set,
            db::db_saved_queries,
            db::db_saved_query_upsert,
            db::db_saved_query_delete,
            db::db_query,
            db::db_cancel,
            // ── shareable config bundles (export/import). The bundle's BYTES never cross this
            //    boundary in either direction: Rust reads and writes the file itself, given a
            //    path the user picked with the dialog plugin, and the webview only ever sees a
            //    header, a plan or a result. See `portability/mod.rs`.
            portability::portability_export,
            portability::portability_inspect,
            portability::portability_import,
            // ── tab tear-off (docs/design/tab-tearoff.md): move a tab into its own OS window
            //    and back. A tab crosses as a description posted to the receiver's mailbox;
            //    its PTY never moves (the receiver re-attaches it).
            tearoff::tearoff_open,
            tearoff::tearoff_send,
            tearoff::tearoff_claim,
            tearoff::tearoff_report,
            tearoff::tearoff_holdings,
            tearoff::tearoff_close
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // The other two ways a quit announces itself. On macOS, ⌘Q goes through
            // `applicationWillTerminate` and only ever reaches us as `Exit` (tao 0.35
            // emits no `ExitRequested` for it); closing the last window and
            // `app.exit()` come as `ExitRequested` first. Either way the PTYs are still
            // alive here — they die with the process — so raising the flag now keeps
            // every open agent in `open-agents.json`. Nothing here prevents the exit.
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                begin_fleet_shutdown(app);
            }
        });
}

/// How long the quit waits for the supervisor's one shutdown write (which agents were
/// working). It is one small file, written in microseconds; the budget only bounds a
/// wedged actor, so a quit can never hang on it.
const SHUTDOWN_WRITE_BUDGET: std::time::Duration = std::time::Duration::from_millis(750);

/// Tell the supervisor the app is quitting (see `SupervisorHandle::begin_shutdown`).
/// Idempotent — the main window's destruction, `ExitRequested` and `Exit` may all fire
/// for one quit — and a no-op before the supervisor is managed.
fn begin_fleet_shutdown(app: &tauri::AppHandle) {
    if let Some(supervisor) = app.try_state::<supervisor::SupervisorHandle>() {
        supervisor.begin_shutdown(SHUTDOWN_WRITE_BUDGET);
    }
}
