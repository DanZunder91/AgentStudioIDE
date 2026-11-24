//! The live-session registry — `ws.rs`'s idiom.
//!
//! A `LazyLock<Mutex<HashMap<…>>>` rather than Tauri managed state, exactly like
//! `ws.rs::CONNECTIONS`, for the same reason given there: it keeps the commands free of a
//! `State<…>` parameter and therefore callable from a test without standing up an `AppHandle`.
//!
//! ## What the webview holds, and what it does not
//!
//! It holds a **session id** — an opaque ULID. Never a DSN, never a credential, never a socket.
//! The resolved password lives in the [`crate::db::engine::ResolvedConfig`] that opened the
//! session and in the session's own redaction list, both inside this process. A future
//! XSS in this app (a renderer with a permissive CSP and dozens of IPC commands) can therefore
//! ask us to *use* a connection; it cannot read the password behind it.
//!
//! ## The lock discipline, which is the only subtle part
//!
//! Two locks, and the outer one is never held across an `await`:
//!
//! * `SESSIONS` is a **std** `Mutex` over the map. Every use is a lock → clone an `Arc` →
//!   unlock. Holding a std mutex across `.await` is the classic way to deadlock a tokio
//!   runtime, so the map's guard never outlives a single statement.
//! * each session is a **tokio** `Mutex` over its connection, which *is* held across the await
//!   that runs a query — that is the point of it. One connection cannot serve two concurrent
//!   queries, and serialising them is more honest than opening a second connection the user did
//!   not ask for.
//!
//! The `Option` inside that inner mutex exists because `sqlx`'s `close` consumes the
//! connection: `db_close` takes the box out and leaves `None`, so a query racing a close gets a
//! clean `not-found` instead of a use-after-close.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};

use tokio::sync::Mutex as AsyncMutex;

use crate::db::engine::{DbCancel, DbSession, Limits};
use crate::db::error::DbError;

/// One open session: its connection, the connection record it came from, and the limits that
/// record asked for.
#[derive(Clone)]
pub struct LiveSession {
    /// Which `DbConnection` opened this, so deleting that record can close its sessions.
    pub connection_id: String,
    pub limits: Limits,
    /// `None` once closed — see the module doc on why this is an `Option`.
    pub session: Arc<AsyncMutex<Option<Box<dyn DbSession>>>>,
    /// 🔴 **Beside the mutex, deliberately — not inside it.**
    ///
    /// `db::query` holds `session`'s lock for the whole of `run`. Anything reachable only through
    /// the session is therefore unreachable *exactly while a query is running*, which is the only
    /// moment a cancel is wanted: a cancel behind this lock would wait for the statement it was
    /// asked to stop. That is why an earlier version had no reachable `db_cancel` even though
    /// three engines had complete cancel implementations.
    ///
    /// Taken once at [`insert`], before the session goes behind the lock. `None` means the engine
    /// has no server-side cancel (MongoDB, Redis, DynamoDB) — a structural answer, so the command
    /// can say so without a round trip.
    pub cancel: Option<Arc<dyn DbCancel>>,
}

static SESSIONS: LazyLock<Mutex<HashMap<String, LiveSession>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Register `session` and return its id.
pub fn insert(connection_id: &str, limits: Limits, session: Box<dyn DbSession>) -> String {
    let id = ulid::Ulid::new().to_string();
    // Taken BEFORE the session goes behind the mutex — see `LiveSession::cancel`.
    let cancel = session.cancel_handle();
    let live = LiveSession {
        connection_id: connection_id.to_string(),
        limits,
        session: Arc::new(AsyncMutex::new(Some(session))),
        cancel,
    };
    SESSIONS
        .lock()
        .expect("sessions mutex")
        .insert(id.clone(), live);
    id
}

/// The session for `id`, or a `not-found` error naming nothing but the id — a stale handle is a
/// UI bug, not a database failure, and it must not be reported as one.
pub fn get(id: &str) -> Result<LiveSession, DbError> {
    SESSIONS
        .lock()
        .expect("sessions mutex")
        .get(id)
        .cloned()
        .ok_or_else(|| DbError::not_found(format!("There is no open session `{id}`.")))
}

/// Remove `id` from the registry. Idempotent: a second call is `None`, not an error.
pub fn take(id: &str) -> Option<LiveSession> {
    SESSIONS.lock().expect("sessions mutex").remove(id)
}

/// Remove and return every session opened from `connection_id` — what `db_connection_delete`
/// cascades over, so deleting a connection cannot leave a live socket pointing at it.
pub fn take_for_connection(connection_id: &str) -> Vec<LiveSession> {
    let mut map = SESSIONS.lock().expect("sessions mutex");
    let ids: Vec<String> = map
        .iter()
        .filter(|(_, s)| s.connection_id == connection_id)
        .map(|(id, _)| id.clone())
        .collect();
    ids.iter().filter_map(|id| map.remove(id)).collect()
}

/// Close a session's connection, if it still has one.
pub async fn close(live: &LiveSession) {
    if let Some(inner) = live.session.lock().await.take() {
        inner.close().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::engine::{Script, ServerInfo};
    use crate::db::result::DbResultSet;

    /// A session that never touches a network. The registry's contract is about bookkeeping,
    /// and proving it against a real socket would make a hermetic test a live one.
    struct FakeSession {
        closed: Arc<std::sync::atomic::AtomicBool>,
        /// Set when the handle this session hands out is used. `None` = an engine with no
        /// server-side cancel, which is the honest answer for three of the six families.
        cancelled: Option<Arc<std::sync::atomic::AtomicBool>>,
        /// Every trait method this session was asked for, in order. The stale-connection fix is a
        /// contract about **ordering** — liveness proven, *then* the statement sent — and only a log
        /// can assert an order. An "it worked" assertion cannot tell the two arrangements apart.
        calls: Arc<Mutex<Vec<&'static str>>>,
        /// What `ensure_live` answers. `Some(e)` stands in for a socket that had died and could not
        /// be re-dialled.
        ensure_live: Option<DbError>,
        /// What `run` answers. Set to the dead-socket `UnexpectedEof` in the reconnect-failure test,
        /// so reaching `run` at all is visible as *that* message coming back.
        run_error: Option<DbError>,
    }

    impl FakeSession {
        fn new() -> Self {
            Self {
                closed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
                cancelled: None,
                calls: Arc::new(Mutex::new(Vec::new())),
                ensure_live: None,
                run_error: None,
            }
        }

        fn record(&self, what: &'static str) {
            self.calls.lock().expect("the call log").push(what);
        }
    }

    /// The cancel handle a `FakeSession` hands out — owned independently of the session, which is
    /// the entire property under test.
    struct FakeCancel {
        cancelled: Arc<std::sync::atomic::AtomicBool>,
    }

    #[async_trait::async_trait]
    impl crate::db::engine::DbCancel for FakeCancel {
        async fn cancel(&self) -> Result<(), DbError> {
            self.cancelled
                .store(true, std::sync::atomic::Ordering::SeqCst);
            Ok(())
        }
    }

    #[async_trait::async_trait]
    impl DbSession for FakeSession {
        async fn probe(&mut self) -> Result<ServerInfo, DbError> {
            self.record("probe");
            Ok(ServerInfo {
                version: "fake".into(),
                backend_pid: None,
            })
        }
        async fn ensure_live(&mut self, _limits: &Limits) -> Result<(), DbError> {
            self.record("ensure_live");
            match &self.ensure_live {
                Some(e) => Err(e.clone()),
                None => Ok(()),
            }
        }
        async fn run(
            &mut self,
            _script: &Script,
            _limits: &Limits,
        ) -> Result<Vec<DbResultSet>, DbError> {
            self.record("run");
            match &self.run_error {
                Some(e) => Err(e.clone()),
                None => Ok(Vec::new()),
            }
        }
        fn cancel_handle(&self) -> Option<Arc<dyn crate::db::engine::DbCancel>> {
            self.cancelled.as_ref().map(|c| {
                Arc::new(FakeCancel {
                    cancelled: c.clone(),
                }) as Arc<dyn crate::db::engine::DbCancel>
            })
        }
        async fn children(
            &mut self,
            _node: &crate::db::tree::DbNodeRef,
        ) -> Result<Vec<crate::db::tree::DbNode>, DbError> {
            // The registry's tests are about session lifetime, not about the tree.
            self.record("children");
            Ok(Vec::new())
        }

        async fn close(self: Box<Self>) {
            self.closed.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }

    fn limits() -> Limits {
        Limits {
            row_limit: 500,
            timeout_ms: 30_000,
            allow_multi_statement: false,
        }
    }

    fn fake() -> (Box<dyn DbSession>, Arc<std::sync::atomic::AtomicBool>) {
        let s = FakeSession::new();
        let flag = s.closed.clone();
        (Box::new(s), flag)
    }

    /// A session that CAN cancel, plus the flag its handle sets.
    fn cancellable() -> (Box<dyn DbSession>, Arc<std::sync::atomic::AtomicBool>) {
        let cancelled = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let s = FakeSession {
            cancelled: Some(cancelled.clone()),
            ..FakeSession::new()
        };
        (Box::new(s), cancelled)
    }

    /// 🔴 **THE property that makes `db_cancel` possible at all.**
    ///
    /// `db::query` holds the session mutex for the whole of `run`. If the cancel path went through
    /// the session, it would block behind the very statement it was asked to stop — which is why
    /// three engines once had complete, correct cancel code that no caller could reach. This
    /// asserts the handle is usable **while the session lock is held**.
    #[tokio::test]
    async fn a_cancel_handle_works_while_a_query_holds_the_session_lock() {
        let (session, cancelled) = cancellable();
        let id = insert("c-lock", limits(), session);
        let live = get(&id).expect("registered");

        // Stand in for a running query: take the lock and do not give it back.
        let _query_guard = live.session.lock().await;

        // The cancel must not need that lock. If it did, this would deadlock rather than fail —
        // so the test is wrapped in a timeout that turns a hang into a readable failure.
        let handle = live
            .cancel
            .clone()
            .expect("a cancellable engine hands one out");
        let outcome =
            tokio::time::timeout(std::time::Duration::from_secs(2), handle.cancel()).await;
        assert!(
            outcome.is_ok(),
            "the cancel handle blocked on the session lock — this is the deadlock the handle exists \
             to avoid, and it is exactly what a `cancel(&self)` METHOD on DbSession would do"
        );
        assert!(outcome.unwrap().is_ok());
        assert!(cancelled.load(std::sync::atomic::Ordering::SeqCst));
        take(&id);
    }

    #[test]
    fn an_engine_with_no_server_side_cancel_registers_no_handle() {
        // `None` is structural: `db_cancel` can then refuse without a round trip, and say which
        // bound still applies, instead of every such engine returning a runtime error that reads
        // like a failure. MongoDB, Redis and DynamoDB are the three.
        let (session, _) = fake();
        let id = insert("c-nocancel", limits(), session);
        assert!(get(&id).expect("registered").cancel.is_none());
        take(&id);
    }

    #[test]
    fn an_inserted_session_is_retrievable_and_a_stale_id_is_not_found() {
        let (s, _) = fake();
        let id = insert("conn-A", limits(), s);
        let live = get(&id).expect("just inserted");
        assert_eq!(live.connection_id, "conn-A");

        // `.map(|_| ())` because `LiveSession` holds a `dyn DbSession` and so is not `Debug`.
        let err = get("no-such-session")
            .map(|_| ())
            .expect_err("a stale handle must not be a db failure");
        assert_eq!(err.code, crate::db::error::DbErrorCode::NotFound);

        take(&id);
    }

    #[test]
    fn take_is_idempotent() {
        let (s, _) = fake();
        let id = insert("conn-B", limits(), s);
        assert!(take(&id).is_some());
        assert!(
            take(&id).is_none(),
            "a second close is a no-op, not an error"
        );
    }

    #[test]
    fn closing_drops_the_connection_and_a_second_close_does_nothing() {
        let (s, closed) = fake();
        let id = insert("conn-C", limits(), s);
        let live = get(&id).expect("inserted");
        let rt = tokio::runtime::Runtime::new().expect("runtime");
        rt.block_on(close(&live));
        assert!(closed.load(std::sync::atomic::Ordering::SeqCst));
        // Idempotent: the box is gone, so this must not panic on an unwrap.
        rt.block_on(close(&live));
        take(&id);
    }

    /// Note the ids are per-connection-record, not per-test: the registry is process-global, so
    /// this test names its own connection ids (`cascade-A`/`cascade-B`) and asserts only about
    /// those. Asserting on the map's *size* would be a flake as soon as tests run in parallel.
    #[test]
    fn deleting_a_connection_takes_exactly_its_own_sessions() {
        let (a1, _) = fake();
        let (a2, _) = fake();
        let (b1, _) = fake();
        let ia1 = insert("cascade-A", limits(), a1);
        let ia2 = insert("cascade-A", limits(), a2);
        let ib1 = insert("cascade-B", limits(), b1);

        let taken = take_for_connection("cascade-A");
        assert_eq!(taken.len(), 2, "both of A's sessions");
        assert!(get(&ia1).is_err() && get(&ia2).is_err());
        assert!(get(&ib1).is_ok(), "B's session is untouched");

        take(&ib1);
    }

    /* ─────────────────────────── the stale-connection fix ─────────────────────────── */

    /// 🔴 **THE ordering property of the fix, and the reason it is safe.**
    ///
    /// A cached session is a socket held for the life of the app, and a laptop suspend, a pooler's
    /// idle timeout or a server restart closes it without telling us. So the query path proves the
    /// connection is alive **before** the statement goes out — and that ordering is not a detail,
    /// it is the entire safety argument: because nothing is sent until liveness is proven, nothing
    /// is ever *re*-sent. Reverse the two lines and you have a retry, and a retried `INSERT` that
    /// had already committed applies the user's write twice.
    #[tokio::test]
    async fn the_query_path_proves_the_connection_is_live_before_it_sends_the_statement() {
        let s = FakeSession::new();
        let calls = s.calls.clone();
        let id = insert("c-ensure-order", limits(), Box::new(s));

        crate::db::query(
            &id,
            "SELECT 1".to_string(),
            crate::db::model::DbRunMode::Statement,
            None,
        )
        .await
        .expect("a live session runs");

        assert_eq!(
            calls.lock().expect("the call log").as_slice(),
            ["ensure_live", "run"],
            "the statement must go out only AFTER liveness is proven — see this test's doc for why \
             the other order is a double-write bug rather than a style preference"
        );
        take(&id);
    }

    /// The tree browses over the very same cached connection, so it carries the very same guard.
    #[tokio::test]
    async fn the_tree_path_also_proves_the_connection_is_live_first() {
        let s = FakeSession::new();
        let calls = s.calls.clone();
        let id = insert("c-ensure-children", limits(), Box::new(s));

        crate::db::children(&id, &crate::db::tree::DbNodeRef::Root)
            .await
            .expect("a live session lists");

        assert_eq!(
            calls.lock().expect("the call log").as_slice(),
            ["ensure_live", "children"],
            "expanding a node after the laptop woke up must not report a dead socket as a broken \
             database"
        );
        take(&id);
    }

    /// 🔴 **What the user is shown when the reconnect itself fails — and what they must NOT be.**
    ///
    /// The message used to be the dead socket's own `UnexpectedEof`, rendered as advice about
    /// SSL modes and connection poolers. It is about a socket that no longer exists, and it sent
    /// the user to check a host and a port that were fine. Here `run` is armed with exactly that
    /// error: if the query path ever reached it on a session whose reconnect failed, the assertions
    /// below would show the old message coming straight back.
    #[tokio::test]
    async fn a_failed_reconnect_surfaces_the_reconnect_error_and_never_reaches_the_statement() {
        let s = FakeSession {
            ensure_live: Some(crate::db::engine::reconnect_failed(
                "db.internal:5432",
                DbError::new(
                    crate::db::error::DbErrorCode::Network,
                    "Nothing is listening there — check the host and the port.",
                ),
            )),
            run_error: Some(DbError::new(
                crate::db::error::DbErrorCode::Network,
                "The server accepted the connection and then closed it without answering \
                 (expected to read 5 bytes, got 0 bytes at EOF)",
            )),
            ..FakeSession::new()
        };
        let calls = s.calls.clone();
        let id = insert("c-ensure-fails", limits(), Box::new(s));

        let err = crate::db::query(
            &id,
            "SELECT 1".to_string(),
            crate::db::model::DbRunMode::Statement,
            None,
        )
        .await
        .map(|_| ())
        .expect_err("a session that could not be re-established must not report success");

        assert!(
            err.message.contains("could not be re-established"),
            "the user must be told the connection dropped: {}",
            err.message
        );
        assert!(
            !err.message.contains("expected to read 5 bytes"),
            "the dead socket's EOF came back — this is the original bug, unfixed: {}",
            err.message
        );
        assert_eq!(
            calls.lock().expect("the call log").as_slice(),
            ["ensure_live"],
            "the statement was sent to a connection we had just failed to re-establish"
        );
        take(&id);
    }

    /// Editing a connection must leave NOTHING alive on the old one (the bug: after the database
    /// URL was edited, a reopened query console was still using the old URL).
    ///
    /// `db_connection_upsert` calls `invalidate_sessions`; before it did, only DELETE cascaded
    /// over live sessions, so an edit updated the record while the socket dialled from the
    /// previous host stayed registered — and the console kept querying down it.
    #[tokio::test]
    async fn invalidating_a_connection_deregisters_and_closes_every_session_it_opened() {
        let (a, a_closed) = fake();
        let (b, b_closed) = fake();
        let (other, other_closed) = fake();
        // Two sessions on one connection: a console and the tree can both hold one.
        let a_id = insert("edited-conn", limits(), a);
        let b_id = insert("edited-conn", limits(), b);
        let other_id = insert("untouched-conn", limits(), other);

        crate::db::invalidate_sessions("edited-conn").await;

        // Deregistered, so a stale session id the UI still holds cannot be used to query.
        assert!(get(&a_id).is_err(), "the session id must stop resolving");
        assert!(
            get(&b_id).is_err(),
            "EVERY session of the connection, not just the first"
        );
        // And genuinely closed, not merely forgotten: a forgotten session is a socket the
        // server keeps open to a database nobody points at any more.
        assert!(
            a_closed.load(std::sync::atomic::Ordering::SeqCst),
            "socket must be closed"
        );
        assert!(
            b_closed.load(std::sync::atomic::Ordering::SeqCst),
            "socket must be closed"
        );

        // Two-sided: a sibling connection is untouched. The registry is global,
        // so "drop the sessions of the edited connection" must not become "drop everything".
        assert!(get(&other_id).is_ok(), "another connection must stay open");
        assert!(!other_closed.load(std::sync::atomic::Ordering::SeqCst));
        take(&other_id);
    }
}
