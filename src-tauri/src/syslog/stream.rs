//! A running log stream, whatever feeds it: a supervised child process (`child.rs` —
//! `log stream`, `journalctl`, `simctl`) or an Event Log subscription thread (`winevt.rs`,
//! Windows). One lifecycle for all of them, which is what `syslog_status` reads:
//!
//! - **Drop = stop.** Dropping a [`Running`] drops its stop guard, which ends the source
//!   (kills the child / signals and joins the thread) — quietly: a deliberate stop posts no line.
//! - **A stream that ends on its own** calls [`Life::die`]: `alive` flips off, the reason is kept
//!   for `syslog_status`, and ONE `system` line says why.
//! - **A stream that never started** is [`Running::failed`]: dead from birth, same reason + line.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use crate::logstream::{LineDraft, LogHub, LogLevel};

/// The shared half of a stream: read by `syslog_status`, written by the source when it ends.
#[derive(Debug)]
pub struct Life {
    alive: AtomicBool,
    exit: Mutex<Option<String>>,
}

impl Life {
    pub fn new() -> Arc<Life> {
        Arc::new(Life {
            alive: AtomicBool::new(true),
            exit: Mutex::new(None),
        })
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Relaxed)
    }

    /// Why it stopped (only once it has).
    pub fn exit_reason(&self) -> Option<String> {
        self.exit.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    /// The stream ended by itself: not alive, why, and one `system` line saying so.
    pub fn die(&self, hub: &LogHub, why: String) {
        self.alive.store(false, Ordering::Relaxed);
        *self.exit.lock().unwrap_or_else(|p| p.into_inner()) = Some(why.clone());
        hub.push(LineDraft::system(None, None, "logs", LogLevel::Error, why));
    }
}

/// A live (or dead) stream. Drop = stop.
pub struct Running {
    life: Arc<Life>,
    /// Whatever ends the source when dropped (its `Drop` does the stopping).
    _stop: Box<dyn Send>,
}

impl Running {
    /// `stop` is dropped with this handle; its `Drop` must end the source.
    pub fn new(life: Arc<Life>, stop: impl Send + 'static) -> Running {
        Running {
            life,
            _stop: Box::new(stop),
        }
    }

    /// A stream that could not start: dead, carrying why, and its one `system` line.
    pub fn failed(hub: &LogHub, why: String) -> Running {
        let life = Life::new();
        life.die(hub, why);
        Running::new(life, ())
    }

    pub fn is_alive(&self) -> bool {
        self.life.is_alive()
    }

    /// Why it stopped (only once it has).
    pub fn exit_reason(&self) -> Option<String> {
        self.life.exit_reason()
    }

    /// The shared half (tests watch it outlive — or not — the source).
    pub fn life(&self) -> &Arc<Life> {
        &self.life
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logstream::{LogKind, NullLogSink};
    use std::sync::atomic::AtomicUsize;

    struct Guard(Arc<AtomicUsize>);
    impl Drop for Guard {
        fn drop(&mut self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }

    #[test]
    fn dropping_the_handle_runs_the_stop_guard_once_and_quietly() {
        let stops = Arc::new(AtomicUsize::new(0));
        let life = Life::new();
        let r = Running::new(life.clone(), Guard(stops.clone()));
        assert!(r.is_alive());
        assert_eq!(r.exit_reason(), None);
        assert_eq!(stops.load(Ordering::SeqCst), 0);
        drop(r);
        assert_eq!(stops.load(Ordering::SeqCst), 1);
        assert!(life.is_alive(), "a deliberate stop is not a death");
        assert_eq!(life.exit_reason(), None);
    }

    #[tokio::test]
    async fn dying_and_failing_record_why_and_post_one_system_line() {
        let (hub, task) = LogHub::new(Arc::new(NullLogSink));
        tokio::spawn(task);
        let life = Life::new();
        let r = Running::new(life.clone(), ());
        life.die(&hub, "System apps log stream stopped (x).".into());
        assert!(!r.is_alive());
        assert_eq!(
            r.exit_reason().as_deref(),
            Some("System apps log stream stopped (x).")
        );
        let f = Running::failed(&hub, "could not start: y".into());
        assert!(!f.is_alive());
        assert_eq!(f.exit_reason().as_deref(), Some("could not start: y"));
        for _ in 0..64 {
            tokio::task::yield_now().await;
        }
        let sys: Vec<String> = hub
            .snapshot()
            .into_iter()
            .filter(|l| l.kind == LogKind::System)
            .map(|l| l.text)
            .collect();
        assert_eq!(
            sys,
            ["System apps log stream stopped (x).", "could not start: y"]
        );
    }
}
