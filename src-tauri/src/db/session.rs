//! Live-session registry (`ws.rs`'s idiom: a `LazyLock<Mutex<HashMap>>`, so commands need no
//! `State`). The webview holds only an opaque session id. The std map lock is never held across
//! `.await`; each session's tokio mutex is. The inner `Option` lets `db_close` take the connection.

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
    /// Kept beside the session mutex, not inside it, because `db::query` holds that lock for the
    /// whole run. Taken once at [`insert`]; `None` = no server-side cancel (MongoDB, Redis,
    /// DynamoDB).
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

    /// `db::query` holds the session mutex for the whole run, so cancel must work while it is held.
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

    /// Liveness is proven before the statement goes out, so nothing is ever re-sent; reversed, a
    /// committed `INSERT` could be retried and applied twice.
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

    /// `run` is armed with the dead socket's `UnexpectedEof`; if the query path reached it after a
    /// failed reconnect, that misleading message would show.
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

    /// Editing a connection must leave nothing alive on the old one: `db_connection_upsert` calls
    /// `invalidate_sessions`.
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
