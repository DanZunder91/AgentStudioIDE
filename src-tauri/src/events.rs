//! The cold telemetry plane's outlet: `agent://event` (ARCHITECTURE §1).
//!
//! # Why a trait and not an `AppHandle`
//!
//! The supervisor needs to emit events, but taking a `tauri::AppHandle` would make
//! it unconstructable without a running Tauri app — and the whole agent lifecycle
//! (spawn → status → exit) would become untestable, which is exactly the logic
//! most worth testing.
//!
//! So the supervisor depends on this trait instead. Production passes
//! [`TauriEventSink`]; tests pass a recorder and assert on what was emitted.
//! `emit` is the only thing the core needs from Tauri, so it is the only thing
//! abstracted here — this is a seam, not a framework.

use crate::model::AgentEvent;

/// Canonical event name (ARCHITECTURE §1). One event carrying one tagged payload,
/// so the UI reduces the whole union in a single reducer.
pub const AGENT_EVENT: &str = "agent://event";

/// Where `AgentEvent`s go.
pub trait EventSink: Send + Sync + 'static {
    fn emit(&self, event: &AgentEvent);
}

/// Drops everything. For headless use and for tests that assert on state rather
/// than telemetry.
pub struct NullSink;

impl EventSink for NullSink {
    fn emit(&self, _event: &AgentEvent) {}
}

/// The real outlet: `app.emit("agent://event", payload)`.
pub struct TauriEventSink<R: tauri::Runtime>(pub tauri::AppHandle<R>);

impl<R: tauri::Runtime> EventSink for TauriEventSink<R> {
    fn emit(&self, event: &AgentEvent) {
        use tauri::Emitter;
        // A failed emit means the webview is gone — the window closed, or the app
        // is shutting down. There is nothing to recover, and panicking here would
        // take the supervisor (and every live terminal) down with it.
        if let Err(e) = self.0.emit(AGENT_EVENT, event) {
            eprintln!("agent://event emit failed (webview gone?): {e}");
        }
    }
}
