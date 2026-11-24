//! The database client's **live** tier — real PostgreSQL, in Docker.
//!
//! ```bash
//! npm run db:fixtures:up          # blocks on the healthchecks: up == queryable AND seeded
//! cargo test --manifest-path src-tauri/Cargo.toml -- --ignored db_live
//! npm run db:fixtures:down        # -v, so the next `up` re-runs the seeds
//! ```
//!
//! Every test here is `#[ignore]`d, so `cargo test` and CI stay hermetic. They
//! follow `usage.rs::live_smoke_reads_real_usage_from_the_cli`: the *other* tests in this feature
//! feed fixtures to pure functions, which can only prove we still handle the shapes we once saw.
//! These prove the whole path against a real server — which is the actual requirement for this
//! feature: the databases must run in Docker and be reachable from our own Rust code.
//! Compiling was never the deliverable.
//!
//! The tests are inside `mod db_live` on purpose: it puts `db_live` into every test's **name**, so
//! the documented `-- --ignored db_live` filter selects them (a filter matches test names, not
//! binary names).
//!
//! Fixture facts these tests depend on, all from `docker/db-fixtures/README.md` and
//! `docker/db-fixtures/seed/postgres.sql`:
//!
//! * `127.0.0.1:55432`, user `agentstudio`, password `agentstudio-test-pw`, database `maestro`.
//!   Throwaway credentials, published in the repo, bound to localhost — never reuse them.
//! * **The host-mapped port is the route that actually authenticates.** The image's stock
//!   `pg_hba.conf` grants `trust` to `local` and to `host … 127.0.0.1/32`, so a client *inside*
//!   the container dialling `127.0.0.1` is let in with **any** password. A connection from the
//!   host arrives over the Docker bridge instead and falls through to
//!   `host all all all scram-sha-256`. Every password assertion here depends on that, and a
//!   `docker compose exec … psql "…@127.0.0.1:5432…"` measurement would silently prove nothing.
//! * `tracks` row **2** has `tag IS NULL`; row **3** has `tag = ''`. That pair is the
//!   NULL-vs-empty invariant the whole no-type-mapping design rests on.
//! * `tracks` also carries a user-defined `ENUM`, an `integer[]`, `numeric(12,4)`, `jsonb` and
//!   `bytea` — types a per-OID binary decoder would need five feature flags for.
//! * `tall` has 2000 rows, i.e. more than the shipped default cap of 500.
//! * `id, title, ensemble, duration` are `NOT NULL`, which matters for the write probes below.

use agent_studio_scaffold_lib::db::engine::{engine_for, Limits, ResolvedConfig, Script};
use agent_studio_scaffold_lib::db::model::{DbEngineId, DbFamily, DbRunMode, SslMode};
use agent_studio_scaffold_lib::db::result::{DbResultKind, DbResultSet};

/// 🔴 **THE LIVE TIER MAY ONLY EVER DIAL OUR OWN CONTAINERS — and this test is what enforces it.**
///
/// The standing rule: live tests must never run against anyone's real databases or
/// use real credentials; they start their own local fixtures. Real clusters hold real data, a
/// write probe is damage rather than a test, and a credential we read is a credential we could
/// leak.
///
/// A rule nobody can check is a rule that erodes, so this is a
/// **hermetic** test — it runs in the default `cargo test`, needs no Docker, and reads this file's
/// own source. If anyone ever pastes a real endpoint, an Atlas SRV URI or a cloud hostname into the
/// live tier, the ordinary gate goes red before it ever dials.
///
/// It deliberately does NOT scan for collection or database *names*: `temp_playlists` and
/// `ARCHIVEDB` appear here in test inputs and comments as sample names, and they are strings, not
/// destinations. What matters is where a socket is opened.
#[test]
fn the_live_tier_only_ever_dials_loopback() {
    let src = include_str!("db_live.rs");

    // 1. Every host constant is loopback. Written as a scan rather than a list so a NEW engine's
    //    module is covered the day it is added, without anyone remembering to update this.
    for line in src.lines() {
        let trimmed = line.trim();
        let Some(rest) = trimmed
            .strip_prefix("const HOST: &str = ")
            .or_else(|| trimmed.strip_prefix("const ENDPOINT: &str = "))
        else {
            continue;
        };
        let value = rest.trim_end_matches(';').trim_matches('"');
        assert!(
            value.contains("127.0.0.1") || value.contains("localhost") || value.contains("[::1]"),
            "a live test may only dial loopback, found `{value}` — the fixture is the test bed"
        );
    }

    // 2. Nothing that could reach a real service, however it were spelled — the hostnames a pasted
    //    connection string carries, and the Atlas SRV scheme specifically.
    //
    // 🔴 **Two false positives on its first run, and both are worth keeping in mind.** The scan
    //    matched (a) its OWN forbidden list and (b) a doc comment further down that says "No test
    //    dials MongoDB Atlas" — a sentence promising the very thing this enforces. So the needles
    //    are assembled with `concat!` (the literal never appears in this file) and **comments are
    //    stripped before scanning**: what matters is code that could open a socket, not prose that
    //    mentions a hostname. A scanner that trips over the documentation of its own rule would be
    //    turned off within a week.
    let code_only: String = src
        .lines()
        .filter(|l| !l.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n");
    for forbidden in [
        concat!("mongodb", "+srv://"),
        concat!(".mongodb", ".net"),
        concat!(".amazon", "aws.com"),
        concat!("click", "house.cloud"),
        concat!(".ups", "tash.io"),
        concat!(".rds", ".amazonaws"),
    ] {
        assert!(
            !code_only.contains(forbidden),
            "`{forbidden}` in the live tier would dial something that is not ours"
        );
    }
}

mod db_live {
    use super::*;

    const HOST: &str = "127.0.0.1";
    const PORT: u16 = 55432;
    const USER: &str = "agentstudio";
    /// TEST FIXTURE ONLY — published in this repo, bound to localhost.
    const PASSWORD: &str = "agentstudio-test-pw";
    const DATABASE: &str = "maestro";

    /// Each write probe gets its **own** id in the 9000 range — nothing in the seed uses those, and
    /// every probe deletes its row afterwards so the fixture stays reusable without a reset.
    ///
    /// One shared id would be a flake, and was: `cargo test` runs these in parallel by default, so
    /// the read-write control's row was still there when the read-only probe looked for it and the
    /// read-only test failed claiming a leak that had not happened. Sharing a mutable row between
    /// parallel tests against one server is the same class of bug as sharing a temp file.
    const PROBE_READ_ONLY: i32 = 9001;
    const PROBE_SCRIPT: i32 = 9002;
    const PROBE_CONTROL: i32 = 9003;
    /// The access-mode-escape probe. Its own id, like every other probe here.
    const PROBE_ESCAPE: i32 = 9004;

    pub(super) fn config(read_only: bool, password: &str) -> ResolvedConfig {
        ResolvedConfig {
            engine: DbEngineId::Postgres,
            family: DbFamily::Postgres,
            host: HOST.to_string(),
            port: Some(PORT),
            srv: false,
            database: DATABASE.to_string(),
            user: USER.to_string(),
            password: password.to_string(),
            // The fixture speaks plaintext on a loopback port, and `prefer` is what lets a Docker
            // container work out of the box — it encrypts if offered and does not verify.
            ssl_mode: SslMode::Prefer,
            ca_pem: None,
            options: Default::default(),
            url: None,
            read_only,
            row_limit: 500,
            timeout_ms: 30_000,
            allow_multi_statement: false,
        }
    }

    fn limits(row_limit: u32, allow_multi_statement: bool) -> Limits {
        Limits {
            row_limit,
            timeout_ms: 30_000,
            allow_multi_statement,
        }
    }

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Runtime::new().expect("a tokio runtime")
    }

    /// Run `sql` on a fresh session and return its result sets. `read_only` picks which guardrail
    /// the session was opened under, which is the variable most of these tests are about.
    async fn run(read_only: bool, sql: &str, mode: DbRunMode, limits: Limits) -> Vec<DbResultSet> {
        let engine = engine_for(DbEngineId::Postgres).expect("postgres is wired");
        let mut session = engine
            .open(&config(read_only, PASSWORD))
            .await
            .unwrap_or_else(|e| {
                panic!(
                    "could not open {HOST}:{PORT} — is `npm run db:fixtures:up` running? {}",
                    e.message
                )
            });
        let out = session
            .run(
                &Script {
                    text: sql.to_string(),
                    mode,
                },
                &limits,
            )
            .await
            .unwrap_or_else(|e| panic!("run failed: {} ({})", e.message, e.code.as_str()));
        session.close().await;
        out
    }

    /// The single column of the single row of `sql`, run read-write. The verification primitive
    /// for the write probes: it must be a *separate* session so it cannot be answered from
    /// anything the probe's own transaction left behind.
    async fn scalar(sql: &str) -> Option<String> {
        let sets = run(false, sql, DbRunMode::Statement, limits(500, false)).await;
        assert_eq!(sets.len(), 1, "expected one result set: {sets:#?}");
        sets[0].rows.first().and_then(|r| r[0].clone())
    }

    async fn delete_probe_row(id: i32) {
        run(
            false,
            &format!("DELETE FROM tracks WHERE id = {id}"),
            DbRunMode::Statement,
            limits(500, false),
        )
        .await;
    }

    /* ───────────────────────────────── the smoke ───────────────────────────────── */

    /// The requirement in one test: a real query, against a real server, from Rust.
    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn a_real_select_runs_against_a_real_postgres() {
        let sets = rt().block_on(run(
            true,
            "SELECT 1 AS one, 'hello' AS greeting",
            DbRunMode::Statement,
            limits(500, false),
        ));
        assert_eq!(sets.len(), 1);
        assert_eq!(sets[0].kind, DbResultKind::Rows);
        assert_eq!(
            sets[0]
                .columns
                .iter()
                .map(|c| c.name.as_str())
                .collect::<Vec<_>>(),
            vec!["one", "greeting"]
        );
        assert_eq!(
            sets[0].rows,
            vec![vec![Some("1".to_string()), Some("hello".to_string())]]
        );
    }

    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn probe_reports_the_real_server_version() {
        let info = rt().block_on(async {
            let engine = engine_for(DbEngineId::Postgres).unwrap();
            let mut s = engine.open(&config(true, PASSWORD)).await.expect("open");
            let info = s.probe().await.expect("probe");
            s.close().await;
            info
        });
        // The server's own string, not ours — the proof a round trip happened rather than a
        // socket merely opening.
        assert!(
            info.version.starts_with("PostgreSQL 17."),
            "the fixture pins postgres:17.6-alpine, got {:?}",
            info.version
        );
        assert!(info.backend_pid.is_some(), "no backend pid for db_cancel");
    }

    /* ─────────────────── every column arrives as Option<String> ─────────────────── */

    /// **The most important test in this tier.**
    ///
    /// This is the decision the whole feature rests on: read every value out of the text protocol
    /// as `Option<String>`, so there is no per-type decoder, no `chrono`/`uuid`/`rust_decimal`
    /// feature flags, and no `<unsupported type>` cell. This asserts that against types a binary
    /// decoder would each need a branch for — a user-defined `ENUM`, an `integer[]`,
    /// `numeric(12,4)`, `jsonb`, `bytea`, `timestamptz` — and, above all, that `None` (SQL NULL)
    /// and `Some("")` (the empty string) are two different cells.
    ///
    /// That last pair is not decoration. A design that collapsed them would need a sentinel, and
    /// any sentinel is a string a real value can equal. Row 2's `tag` is NULL and row 3's is `''`
    /// precisely so this can be asserted rather than assumed.
    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn text_protocol_returns_every_column_as_option_string() {
        let sets = rt().block_on(run(
            true,
            "SELECT id, title, ensemble, duration, tempo, ok, flags, payload, raw, at, tag \
             FROM tracks ORDER BY id",
            DbRunMode::Statement,
            limits(500, false),
        ));
        assert_eq!(sets.len(), 1);
        let set = &sets[0];
        assert_eq!(set.kind, DbResultKind::Rows);
        assert_eq!(set.rows.len(), 6, "the seed has six rows");
        assert!(!set.truncated);

        // The declared type names, verbatim. They drive rendering; they are never
        // parsed, and no value's decoding depends on them.
        //
        // ⚠️ MEASURED LIMITATION, recorded rather than papered over. It is natural to assume the
        // declared type name "is available (`column.type_info().name()`)". For **built-in** types
        // it is. For a
        // user-defined type it is NOT: the simple query protocol hands back a type OID, and sqlx
        // only resolves an unknown OID to a name via `Describe`, which the unprepared path never
        // runs. So the fixture's `track_ensemble` ENUM arrives as the literal `"?"`.
        //
        // The text-protocol guarantee itself is untouched — the enum's *value* comes back as
        // `Some("duo")`, asserted below — so this costs a column header, not data. Fixing it means
        // caching a `pg_type` OID → name lookup at connect; that is future work, and this
        // assertion is what will notice when it lands (this line will have to change).
        let types: Vec<&str> = set.columns.iter().map(|c| c.type_name.as_str()).collect();
        assert_eq!(
            types,
            vec![
                "INT4",
                "VARCHAR",
                "?", // the user-defined `track_ensemble` ENUM — see the note above
                "NUMERIC",
                "FLOAT8",
                "BOOL",
                "INT4[]", // an array type, named correctly because `int4` is built in
                "JSONB",
                "BYTEA",
                "TIMESTAMPTZ",
                "TEXT",
            ],
            "the declared type names drive rendering; they are not parsed"
        );
        // An unnameable type renders as plain text rather than being guessed at — the honest
        // default, and the reason a `?` header is a cosmetic problem and not a correctness one.
        assert_eq!(
            set.columns[2].kind,
            agent_studio_scaffold_lib::db::result::DbCellKind::Unknown
        );

        let col = |name: &str| -> usize {
            set.columns
                .iter()
                .position(|c| c.name == name)
                .unwrap_or_else(|| panic!("no column {name}"))
        };
        let cell = |row: usize, name: &str| -> Option<String> { set.rows[row][col(name)].clone() };

        // ── THE invariant: NULL vs the empty string, distinguished by construction ──
        assert_eq!(
            cell(1, "tag"),
            None,
            "row 2's tag IS NULL and must arrive as None, not as Some(\"\")"
        );
        assert_eq!(
            cell(2, "tag"),
            Some(String::new()),
            "row 3's tag IS '' and must arrive as Some(\"\"), not as None"
        );

        // Row 1: exactly what `psql` would print, for every type in the row.
        assert_eq!(cell(0, "id"), Some("1".to_string()));
        assert_eq!(cell(0, "title"), Some("Amberline".to_string()));
        assert_eq!(
            cell(0, "ensemble"),
            Some("duo".to_string()),
            "the ENUM's label"
        );
        assert_eq!(
            cell(0, "duration"),
            Some("0.5000".to_string()),
            "numeric(12,4) keeps its scale — no rust_decimal, and no reformatting"
        );
        assert_eq!(cell(0, "ok"), Some("t".to_string()), "Postgres prints t/f");
        assert_eq!(cell(0, "flags"), Some("{1,2,3}".to_string()));
        assert_eq!(
            cell(0, "raw"),
            Some("\\x48656c6c6f".to_string()),
            "bytea in text mode is already `\\x…`"
        );
        assert_eq!(
            cell(0, "at"),
            Some("2026-07-29 10:00:00+00".to_string()),
            "the cell shows exactly what the server encoded; we never reformat a timestamp"
        );

        // Row 6: a JSON `null` value next to SQL NULLs. They must not collapse into each other —
        // `payload` renders as the four characters `null`, `tempo` and `raw` render as absent.
        assert_eq!(cell(5, "payload"), Some("null".to_string()));
        assert_eq!(cell(5, "tempo"), None);
        assert_eq!(cell(5, "raw"), None);

        // Row 4: non-ASCII plus an embedded tab and newline, intact and in one cell.
        let tag4 = cell(3, "tag").expect("row 4 has a tag");
        assert!(tag4.contains("ünïcode ✓ 中文") && tag4.contains('\t') && tag4.contains('\n'));

        // Row 5: a TEXT value that looks like bytea hex. The cell's *kind* comes from the column,
        // so this must not be classified as binary — otherwise the app lies about the data.
        assert_eq!(cell(4, "tag"), Some("\\x4142".to_string()));
        assert_eq!(
            set.columns[col("tag")].kind,
            agent_studio_scaffold_lib::db::result::DbCellKind::Text
        );
        assert_eq!(
            set.columns[col("raw")].kind,
            agent_studio_scaffold_lib::db::result::DbCellKind::Binary
        );
    }

    /* ────────────────────────── read-only is the server's ────────────────────────── */

    /// A write on a read-only session is refused **by the server**, and the row is not there
    /// afterwards. Both halves are asserted: an error alone would not prove the write did not
    /// happen (see the multi-statement test below for why that distinction is not academic).
    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn read_only_is_server_enforced() {
        let insert = format!(
            "INSERT INTO tracks (id, title, ensemble, duration, tag) \
             VALUES ({PROBE_READ_ONLY}, 'ESCAPED', 'duo', 1, 'single')"
        );
        rt().block_on(async {
            delete_probe_row(PROBE_READ_ONLY).await;

            let sets = run(true, &insert, DbRunMode::Statement, limits(500, false)).await;

            // The database's refusal comes back as a `message` result, not a rejected command —
            // a SQL error is a normal outcome of a console (the `http_send` contract).
            assert_eq!(sets.len(), 1, "{sets:#?}");
            assert_eq!(sets[0].kind, DbResultKind::Message);
            let notice = sets[0].notice.clone().unwrap_or_default();
            assert!(
                notice.to_lowercase().contains("read-only"),
                "the refusal must say why: {notice}"
            );

            // …and the row is not there. This is the assertion that actually matters.
            assert_eq!(
                scalar(&format!(
                    "SELECT id FROM tracks WHERE id = {PROBE_READ_ONLY}"
                ))
                .await,
                None,
                "a read-only session wrote a row"
            );
            delete_probe_row(PROBE_READ_ONLY).await;
        });
    }

    /// **The guardrail that a plausible implementation would silently void.**
    ///
    /// `sqlx::raw_sql` sends a whole `;`-separated script as ONE simple-query batch, and the
    /// obvious way to make a session read-only is to prepend `SET SESSION CHARACTERISTICS AS
    /// TRANSACTION READ ONLY` to that string. Measured against this very fixture, that does not
    /// work: the batch's implicit transaction has already begun with the old characteristics, so
    /// the `SET` does not bind the statements behind it and **the INSERT succeeds**. Issuing the
    /// `SET` as its own round trip at connect does bind them.
    ///
    /// ⚠️ **An error is not sufficient evidence here, which is the whole point of this test.** The
    /// first attempt at that measurement returned `ERROR: null value in column "title" violates
    /// not-null constraint` — a failure that looks exactly like the guard working, while the guard
    /// had in fact already let the write through and only the schema stopped it. So this test
    /// asserts on **the absence of the row**, from a separate session, after the script has run.
    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn read_only_survives_a_multi_statement_script() {
        // Deliberately a *valid* INSERT: every NOT NULL column (id, title, ensemble, duration) is supplied,
        // so if the guardrail leaks, this row really does land and the test really does fail.
        let script = format!(
            "SELECT 1; \
             INSERT INTO tracks (id, title, ensemble, duration, tag) \
                 VALUES ({PROBE_SCRIPT}, 'ESCAPED', 'duo', 1, 'wrote-anyway'); \
             SELECT 2"
        );
        rt().block_on(async {
            delete_probe_row(PROBE_SCRIPT).await;

            // `allow_multi_statement: true` — the point is to prove the *server* stops the write
            // even when our own multi-statement speed bump is out of the way.
            let sets = run(true, &script, DbRunMode::Script, limits(500, true)).await;

            // THE assertion. Nothing about the shape of `sets` is evidence on its own.
            assert_eq!(
                scalar(&format!(
                    "SELECT tag FROM tracks WHERE id = {PROBE_SCRIPT} AND tag = 'wrote-anyway'"
                ))
                .await,
                None,
                "a statement in a multi-statement script ESCAPED the read-only session — the \
                 read-only SET has probably been folded into the same batch as the user's SQL"
            );

            // Secondary, and only meaningful because the assertion above passed: the batch was
            // refused with the server's own reason, attributed to a statement.
            let refusal = sets
                .iter()
                .find(|s| s.kind == DbResultKind::Message)
                .unwrap_or_else(|| panic!("expected a refusal among {sets:#?}"));
            let notice = refusal.notice.clone().unwrap_or_default();
            assert!(
                notice.to_lowercase().contains("read-only"),
                "refused for the wrong reason — an error that is not about read-only is not \
                 evidence the guardrail fired: {notice}"
            );

            delete_probe_row(PROBE_SCRIPT).await;
        });
    }

    /// The read-write counterpart, so the test above cannot pass because writes never work at all.
    /// Without this, a broken connection string or a permission problem would make
    /// `read_only_survives_a_multi_statement_script` green for entirely the wrong reason.
    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn the_same_write_succeeds_on_a_read_write_session() {
        let insert = format!(
            "INSERT INTO tracks (id, title, ensemble, duration, tag) \
             VALUES ({PROBE_CONTROL}, 'ESCAPED', 'duo', 1, 'control')"
        );
        rt().block_on(async {
            delete_probe_row(PROBE_CONTROL).await;
            let sets = run(false, &insert, DbRunMode::Statement, limits(500, false)).await;
            assert_eq!(sets.len(), 1, "{sets:#?}");
            assert_eq!(
                sets[0].kind,
                DbResultKind::Affected,
                "an INSERT is an `affected` result: {sets:#?}"
            );
            assert_eq!(sets[0].rows_affected, Some(1));
            assert_eq!(
                scalar(&format!(
                    "SELECT tag FROM tracks WHERE id = {PROBE_CONTROL}"
                ))
                .await,
                Some("control".to_string()),
                "the control write did not land, so the read-only tests prove nothing"
            );
            delete_probe_row(PROBE_CONTROL).await;
            assert_eq!(
                scalar(&format!("SELECT id FROM tracks WHERE id = {PROBE_CONTROL}")).await,
                None,
                "cleanup failed — the fixture is no longer reusable without a reset"
            );
        });
    }

    /* ─────────────────────────── redaction, for real ─────────────────────────── */

    /// `sqlx` and libpq echo connection strings — and therefore passwords — into their error text.
    /// This proves the redaction against a **real** authentication failure rather than a synthetic
    /// string, with a deliberately hostile password: characters that percent-encode, so a
    /// redactor matching only the raw bytes would pass while the secret shipped.
    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn a_wrong_password_never_appears_in_the_error() {
        const HOSTILE: &str = "p@ss:w/o?rd#\\ünïcode ✓";
        let err = rt().block_on(async {
            let engine = engine_for(DbEngineId::Postgres).unwrap();
            engine
                .open(&config(true, HOSTILE))
                .await
                .map(|_| ())
                .expect_err("the fixture must reject a wrong password")
        });

        // It failed for the right reason — otherwise this test could pass on a server that was
        // simply unreachable, and would then prove nothing about redaction.
        assert_eq!(
            err.code,
            agent_studio_scaffold_lib::db::error::DbErrorCode::Auth,
            "expected an auth failure, got {}: {}",
            err.code.as_str(),
            err.message
        );

        assert!(
            !err.message.contains(HOSTILE),
            "the password reached the error message: {}",
            err.message
        );
        // The percent-encoded form too: a driver echoing a DSN has already encoded it, so the raw
        // bytes may simply not be present and matching only those is the classic false pass.
        let encoded = agent_studio_scaffold_lib::db::url::encode_userinfo(HOSTILE);
        assert!(
            !err.message.contains(&encoded),
            "the percent-encoded password reached the error message: {}",
            err.message
        );
        // And the distinctive fragments, in case a driver quotes only part of it.
        for fragment in ["p@ss", "w/o?rd", "ünïcode"] {
            assert!(
                !err.message.contains(fragment),
                "`{fragment}` of the password survived in: {}",
                err.message
            );
        }
    }

    /* ──────────────────────────── the row cap ──────────────────────────── */

    /// Truncation is **measured**, not inferred from `rows.len() == row_limit` — which is wrong
    /// exactly when the table happens to hold that many rows. `tall` has 2000, so the shipped
    /// default of 500 is a real cut, and a 500-row cap on a 500-row read must NOT be flagged.
    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn the_row_cap_is_measured_rather_than_inferred() {
        let r = rt();
        let cut = r.block_on(run(
            true,
            "SELECT id, n, label FROM tall ORDER BY id",
            DbRunMode::Statement,
            limits(500, false),
        ));
        assert_eq!(cut[0].rows.len(), 500);
        assert!(cut[0].truncated, "2000 rows under a 500 cap is truncated");
        assert_eq!(cut[0].row_limit, 500);

        let exact = r.block_on(run(
            true,
            "SELECT id FROM tall ORDER BY id LIMIT 500",
            DbRunMode::Statement,
            limits(500, false),
        ));
        assert_eq!(exact[0].rows.len(), 500);
        assert!(
            !exact[0].truncated,
            "exactly 500 rows under a 500 cap is NOT truncated — this is the inference bug"
        );
    }

    /// 200 columns, one row (the grid's horizontal case). Reading every cell as text means the column
    /// count is not a per-type problem, and this is the cheapest possible proof of that.
    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn a_two_hundred_column_row_comes_back_whole() {
        let sets = rt().block_on(run(
            true,
            "SELECT * FROM wide",
            DbRunMode::Statement,
            limits(500, false),
        ));
        assert_eq!(sets[0].columns.len(), 200);
        assert_eq!(sets[0].rows.len(), 1);
        assert_eq!(sets[0].rows[0].len(), 200);
        assert_eq!(sets[0].rows[0][0], Some("1".to_string()));
        assert_eq!(sets[0].rows[0][199], Some("200".to_string()));
    }

    /* ─────────────────── the console contract: an error is a result ─────────────────── */

    /// A syntax error resolves as a `message` result carrying the statement it came from, rather
    /// than rejecting the command — the `http_send`/`grpc_send` contract. A console whose
    /// typos throw exceptions is a console that loses the results of everything that worked.
    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn a_syntax_error_is_a_result_and_not_a_rejection() {
        let sets = rt().block_on(run(
            true,
            "SELCT 1",
            DbRunMode::Statement,
            limits(500, false),
        ));
        assert_eq!(sets.len(), 1);
        assert_eq!(sets[0].kind, DbResultKind::Message);
        assert_eq!(sets[0].statement, "SELCT 1", "attributed to its statement");
        assert!(sets[0]
            .notice
            .as_deref()
            .unwrap_or_default()
            .to_lowercase()
            .contains("syntax error"));
    }

    /* ─────────────── the whole command path, end to end ─────────────── */

    /// **The integration this feature is actually for**: save a connection with a typed password,
    /// then open it *by id* and run a query — the exact sequence the dialog and the console will
    /// perform, through the same functions the `#[tauri::command]`s call.
    ///
    /// It also asserts the two secret properties on real files, which is the only place they can be
    /// asserted honestly:
    ///
    /// * `db-connections.json` holds **no password**, only a `{{VAR}}` reference.
    /// * the password is in the **Vault** (`api-store.json`), the one secret store this feature is
    ///   allowed to use, and `db_open` finds it there without the caller passing it.
    ///
    /// Both files live in a temp directory injected via `db::Paths::in_dir`. Nothing here can touch
    /// the developer's real config directory, which is the whole point.
    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn the_whole_command_path_saves_a_connection_then_opens_and_queries_it() {
        let dir = std::env::temp_dir().join(format!("agentstudio-db-live-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        let paths = agent_studio_scaffold_lib::db::Paths::in_dir(&dir);

        let draft: agent_studio_scaffold_lib::db::model::DbConnectionInput =
            serde_json::from_str(&format!(
                r#"{{"name":"Fixture Maestro","engine":"postgres","host":"{HOST}","port":{PORT},
                    "database":"{DATABASE}","user":"{USER}","passwordRef":"",
                    "savePassword":"forever","sslMode":"prefer","options":{{}},
                    "readOnly":true,"rowLimit":500,"timeoutMs":30000}}"#
            ))
            .expect("the draft is the contract's shape");

        let saved = agent_studio_scaffold_lib::db::upsert(&paths, draft, Some(PASSWORD))
            .unwrap_or_else(|e| panic!("upsert failed: {}", e.message));

        // A reference, minted from the connection's name and shown to the user.
        assert_eq!(saved.password_ref, "{{FIXTURE_MAESTRO_PASSWORD}}");
        assert!(!saved.id.is_empty(), "Rust mints the id");
        assert!(saved.read_only, "a new connection is read-only");

        // …and on disk: the store has the reference and not the secret; the Vault has the secret.
        let store_text = std::fs::read_to_string(&paths.store).expect("the store was written");
        assert!(
            !store_text.contains(PASSWORD),
            "the connection file contains the password:\n{store_text}"
        );
        assert!(store_text.contains("{{FIXTURE_MAESTRO_PASSWORD}}"));
        let vault_text = std::fs::read_to_string(&paths.vault).expect("the Vault was written");
        assert!(
            vault_text.contains(PASSWORD),
            "the password did not reach the Vault, so nothing could ever connect"
        );

        // Open BY ID, with no password argument. If the Vault lookup did not work, this
        // fails with an auth error — so a green run is the proof the whole chain closed.
        let sets = rt().block_on(async {
            let opened = agent_studio_scaffold_lib::db::open(&paths, &saved.id, None)
                .await
                .unwrap_or_else(|e| panic!("open failed: {} ({})", e.message, e.code.as_str()));
            // 🔴 **One dial returns BOTH the session and what answered.** The store
            // used to spend an entire second dial — DNS, TLS handshake, authentication — on
            // `db_test_connection` purely to learn this string, and then throw that connection
            // away. Against a remote cluster that roughly doubles the time to open.
            //
            // Asserted against a REAL server here because the frontend half (that the store now
            // calls nothing else) is a mock-level claim: only this proves there is something true
            // to return.
            assert!(
                opened.server_version.starts_with("PostgreSQL "),
                "open must report the real server, got {:?}",
                opened.server_version
            );
            assert!(
                opened.latency_ms > 0,
                "the whole open is measured, not defaulted to zero"
            );
            let session_id = opened.session_id;
            let sets = agent_studio_scaffold_lib::db::query(
                &session_id,
                "SELECT title, tag FROM tracks WHERE id IN (2, 3) ORDER BY id".to_string(),
                DbRunMode::Statement,
                None,
            )
            .await
            .unwrap_or_else(|e| panic!("query failed: {}", e.message));
            agent_studio_scaffold_lib::db::db_close(session_id).await;
            sets
        });

        assert_eq!(sets.len(), 1);
        assert_eq!(
            sets[0].rows,
            vec![
                vec![Some("Bluewater".to_string()), None],
                vec![Some("Cinderglass".to_string()), Some(String::new())],
            ],
            "NULL and the empty string, through the real command path"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /* ──────────────── a credential in the QUERY STRING ──────────────── */

    /// **The half that makes the query-string change a feature rather than a saved string.**
    ///
    /// A `?password=` parameter stays part of the connection string,
    /// because every database system accepts it there. So `db_connection_upsert` no longer rejects a
    /// pasted string carrying `?password=`; it puts the value in the Vault and leaves
    /// `?password={{VAR}}` in the same parameter. This test is the proof that the resolved value
    /// really reaches the server **in that parameter**: it saves such a connection, opens it *by
    /// id* with no password argument, and reads real rows back.
    ///
    /// Measured first, with `psql`, before any code was written:
    ///
    /// ```text
    /// psql "postgresql://agentstudio@postgres:5432/maestro?password=agentstudio-test-pw"
    ///    → works: agentstudio
    /// psql "postgresql://agentstudio@postgres:5432/maestro?password=wrong-pw"
    ///    → FATAL:  password authentication failed for user "agentstudio"
    /// ```
    ///
    /// ⚠️ **The route is load-bearing, and it is the trap here.** This fixture's `pg_hba.conf` is
    /// the stock image one, whose first rules are `local … trust` and
    /// `host all all 127.0.0.1/32 trust`. A client running *inside* the container and dialling
    /// `127.0.0.1` therefore authenticates with **trust** — a wrong password succeeds and proves
    /// nothing. Only the last rule, `host all all all scram-sha-256`, actually checks a password.
    /// Two routes reach it: the service name `postgres:5432` from inside the compose network, or
    /// the **host-mapped port** — which is what these tests use, because a connection from the
    /// host arrives over the Docker bridge (a `172.x`/`192.x` source address), not over the
    /// container's loopback. That is why `127.0.0.1:55432` from `cargo test` is a real
    /// authentication and `127.0.0.1:5432` from inside the container is not.
    /// **The fresh-paste path against a real server — the `?password=` rule, proven.**
    ///
    /// The test above pastes a string that still CARRIES the credential. That is not what the
    /// dialog sends: `db_url_parse` strips the value out and discards it, so upsert receives a
    /// credential-free URL plus the typed password and a `passwordParam` hint. Nothing in the
    /// string says `?password=` any more, and until `DbConnectionInput::password_param` existed
    /// the reference was written into the `user:password@` userinfo instead.
    ///
    /// This is the version a user actually performs, and it has to authenticate — the unit tests
    /// prove the *string* is rebuilt correctly, and only a real server proves that string works.
    /// The fixture enforces scram-sha-256 on this route, so a green run means Postgres accepted
    /// a password that travelled paste → strip → Vault → re-render → dial.
    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn a_stripped_paste_with_a_param_hint_authenticates_against_the_real_server() {
        let dir =
            std::env::temp_dir().join(format!("agentstudio-db-live-hint-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        let paths = agent_studio_scaffold_lib::db::Paths::in_dir(&dir);

        // Exactly the dialog's post-paste state: the stripped string, and the parameter name.
        let stripped = format!("postgresql://{USER}@{HOST}:{PORT}/{DATABASE}?sslmode=prefer");
        let draft: agent_studio_scaffold_lib::db::model::DbConnectionInput =
            serde_json::from_str(&format!(
                r#"{{"name":"Fixture Hint","engine":"postgres","host":"{HOST}","port":{PORT},
                    "database":"{DATABASE}","user":"{USER}","passwordRef":"",
                    "savePassword":"forever","sslMode":"prefer","options":{{}},
                    "readOnly":true,"rowLimit":500,"timeoutMs":30000,
                    "passwordParam":"password","url":{url}}}"#,
                url = serde_json::to_string(&stripped).unwrap(),
            ))
            .expect("the draft is the contract's shape");

        // The password travels as the SEPARATE argument, the way the dialog sends what was typed.
        let saved = agent_studio_scaffold_lib::db::upsert(&paths, draft, Some(PASSWORD))
            .unwrap_or_else(|e| panic!("upsert refused the stripped paste: {}", e.message));

        let url = saved.url.clone().expect("a url");
        assert!(
            url.contains("password={{FIXTURE_HINT_PASSWORD}}"),
            "the reference did not go into the parameter the paste named: {url}"
        );
        assert!(
            !url.contains(&format!("{USER}:{{{{FIXTURE_HINT_PASSWORD}}}}@")),
            "the reference was moved into the userinfo: {url}"
        );

        let sets = rt().block_on(async {
            let opened = agent_studio_scaffold_lib::db::open(&paths, &saved.id, None)
                .await
                .unwrap_or_else(|e| {
                    panic!(
                        "open failed — the re-rendered ?password= did not authenticate: {} ({})",
                        e.message,
                        e.code.as_str()
                    )
                });
            let session_id = opened.session_id;
            let sets = agent_studio_scaffold_lib::db::query(
                &session_id,
                "SELECT title, tag FROM tracks WHERE id IN (2, 3) ORDER BY id".to_string(),
                DbRunMode::Statement,
                None,
            )
            .await
            .unwrap_or_else(|e| panic!("query failed: {}", e.message));
            agent_studio_scaffold_lib::db::db_close(session_id).await;
            sets
        });

        // Named seed rows, never `count(*)` — this tier shares a mutable fixture.
        assert_eq!(sets.len(), 1);
        assert_eq!(
            sets[0].rows,
            vec![
                vec![Some("Bluewater".to_string()), None],
                vec![Some("Cinderglass".to_string()), Some(String::new())],
            ]
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn a_connection_saved_from_a_query_string_password_connects_and_returns_rows() {
        // Its own directory: `cargo test` parallelises, and a shared temp dir between live tests
        // is the same class of bug as the shared row id the constants above are about.
        let dir =
            std::env::temp_dir().join(format!("agentstudio-db-live-qs-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        let paths = agent_studio_scaffold_lib::db::Paths::in_dir(&dir);

        // The pasted string, credential and all — exactly what a user copies out of a runbook.
        // No `password` argument is passed to `upsert`, so the URL is the ONLY source of the
        // secret; if the query parameter were dropped, nothing below could authenticate.
        let pasted = format!(
            "postgresql://{USER}@{HOST}:{PORT}/{DATABASE}?sslmode=prefer&password={PASSWORD}"
        );
        let draft: agent_studio_scaffold_lib::db::model::DbConnectionInput =
            serde_json::from_str(&format!(
                r#"{{"name":"Fixture QS","engine":"postgres","host":"{HOST}","port":{PORT},
                    "database":"{DATABASE}","user":"{USER}","passwordRef":"",
                    "savePassword":"forever","sslMode":"prefer","options":{{}},
                    "readOnly":true,"rowLimit":500,"timeoutMs":30000,
                    "url":{url}}}"#,
                url = serde_json::to_string(&pasted).unwrap(),
            ))
            .expect("the draft is the contract's shape");

        let saved = agent_studio_scaffold_lib::db::upsert(&paths, draft, None)
            .unwrap_or_else(|e| panic!("upsert refused a query-string credential: {}", e.message));

        // The reference took the value's place, in the same parameter, under its own name.
        assert_eq!(
            saved.url.as_deref(),
            Some(
                format!(
                    "postgresql://{USER}@{HOST}:{PORT}/{DATABASE}\
                     ?sslmode=prefer&password={{{{FIXTURE_QS_PASSWORD}}}}"
                )
                .as_str()
            )
        );
        assert_eq!(saved.password_ref, "{{FIXTURE_QS_PASSWORD}}");

        // On disk: the store has no secret, the Vault has it.
        let store_text = std::fs::read_to_string(&paths.store).expect("the store was written");
        assert!(
            !store_text.contains(PASSWORD),
            "the connection file contains the password:\n{store_text}"
        );
        let vault_text = std::fs::read_to_string(&paths.vault).expect("the Vault was written");
        assert!(
            vault_text.contains(PASSWORD),
            "the password did not reach the Vault, so nothing could ever connect"
        );

        // …and it connects. `open` by id, no password argument: the `{{VAR}}` is resolved from the
        // Vault and spliced back into the query parameter inside Rust. A green run here is the
        // proof the server received it — the fixture enforces scram-sha-256 on this route.
        let sets = rt().block_on(async {
            let opened = agent_studio_scaffold_lib::db::open(&paths, &saved.id, None)
                .await
                .unwrap_or_else(|e| {
                    panic!(
                        "open failed — the query-string password did not reach the server: {} ({})",
                        e.message,
                        e.code.as_str()
                    )
                });
            let session_id = opened.session_id;
            // **Named seed rows, never `count(*)`.** The first version of this test asserted
            // `count(*) = 6` and failed with `7`: the fixture is shared, `cargo test` runs this
            // tier in parallel, and one of the write probes' rows (ids 9001–9003) was live in
            // `tracks` at that instant. A count over a mutable table is a flake — the same class
            // of bug as the shared probe id the constants at the top of this file exist to avoid.
            let sets = agent_studio_scaffold_lib::db::query(
                &session_id,
                "SELECT title, tag FROM tracks WHERE id IN (2, 3) ORDER BY id".to_string(),
                DbRunMode::Statement,
                None,
            )
            .await
            .unwrap_or_else(|e| panic!("query failed: {}", e.message));
            agent_studio_scaffold_lib::db::db_close(session_id).await;
            sets
        });

        // Real rows, not merely a socket that opened — and the NULL/`''` pair while we are
        // here, through a connection whose password came out of a query parameter.
        assert_eq!(sets.len(), 1);
        assert_eq!(sets[0].kind, DbResultKind::Rows);
        assert_eq!(
            sets[0].rows,
            vec![
                vec![Some("Bluewater".to_string()), None],
                vec![Some("Cinderglass".to_string()), Some(String::new())],
            ]
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The wrong-password counterpart, so the test above cannot be green because authentication is
    /// not happening at all — and redaction for the new position.
    ///
    /// The wrong value is deliberately **hostile** (`&`, `=`, `?`, `#`, `/`, `:`, unicode): those
    /// are the characters a naive splice would let terminate the parameter, and a mangled string
    /// fails with something *other* than `auth` — a missing database, an unparseable URL, a
    /// different host. So `code == auth` is itself evidence that the whole value arrived at the
    /// server as one parameter, and the absence of the value from the message is redaction.
    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn a_wrong_query_string_password_is_an_auth_failure_that_never_echoes_it() {
        const WRONG: &str = "p@ss:w/rd#1&x=2?y-ünïcode-✓";
        let dir =
            std::env::temp_dir().join(format!("agentstudio-db-live-qs-bad-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        let paths = agent_studio_scaffold_lib::db::Paths::in_dir(&dir);

        let pasted = format!(
            "postgresql://{USER}@{HOST}:{PORT}/{DATABASE}?sslmode=prefer&password={}",
            agent_studio_scaffold_lib::db::url::encode_userinfo(WRONG)
        );
        let draft: agent_studio_scaffold_lib::db::model::DbConnectionInput =
            serde_json::from_str(&format!(
                r#"{{"name":"Fixture QS Bad","engine":"postgres","host":"{HOST}","port":{PORT},
                    "database":"{DATABASE}","user":"{USER}","passwordRef":"",
                    "savePassword":"forever","sslMode":"prefer","options":{{}},
                    "readOnly":true,"rowLimit":500,"timeoutMs":30000,
                    "url":{url}}}"#,
                url = serde_json::to_string(&pasted).unwrap(),
            ))
            .expect("the draft is the contract's shape");

        let saved = agent_studio_scaffold_lib::db::upsert(&paths, draft, None)
            .unwrap_or_else(|e| panic!("upsert failed: {}", e.message));
        let store_text = std::fs::read_to_string(&paths.store).expect("the store was written");
        assert!(
            !store_text.contains(WRONG),
            "the connection file contains the password:\n{store_text}"
        );

        let err = rt().block_on(async {
            agent_studio_scaffold_lib::db::open(&paths, &saved.id, None)
                .await
                .expect_err("the fixture must reject a wrong password on this route")
        });

        assert_eq!(
            err.code,
            agent_studio_scaffold_lib::db::error::DbErrorCode::Auth,
            "expected an auth failure — anything else means the spliced value mangled the \
             string instead of reaching the server as one parameter: {}",
            err.message
        );
        assert!(
            !err.message.contains(WRONG),
            "the password reached the error message: {}",
            err.message
        );
        let encoded = agent_studio_scaffold_lib::db::url::encode_userinfo(WRONG);
        assert!(
            !err.message.contains(&encoded),
            "the percent-encoded password reached the error message: {}",
            err.message
        );
        for fragment in ["p@ss", "w/rd", "x=2", "ünïcode"] {
            assert!(
                !err.message.contains(fragment),
                "`{fragment}` of the password survived in: {}",
                err.message
            );
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The multi-statement speed bump, against a real server: a script is refused *before*
    /// anything is sent when the connection has not opted in. Refused by us, not by the server —
    /// stated plainly here because that is the difference between this control and read-only.
    /// 🔴 **The escape the read-only badge did not cover, measured against the fixture.**
    ///
    /// Postgres refuses `SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE; INSERT …` inside
    /// ONE batch, because a batch is a single implicit transaction whose access mode is already
    /// fixed. That made it look safe. It is not: across **two round trips on the same session**
    /// — which is exactly what this console does, one `run` per press of ⌘⏎ — the pair succeeds.
    /// Measured against the fixture before the fix:
    ///
    /// ```text
    /// psql -c 'SET … READ ONLY' -c 'SET … READ WRITE' -c 'INSERT …'   → SET / SET / INSERT 0 1
    /// ```
    ///
    /// `guard::read_only_escape` refuses the statement, on both engines. It is a client-side
    /// speed bump and is documented as one — the unconditional boundary is a read-only account.
    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn a_statement_that_would_turn_read_only_off_is_refused() {
        rt().block_on(async {
            delete_probe_row(PROBE_ESCAPE).await;
            let engine = engine_for(DbEngineId::Postgres).expect("postgres is wired");
            let mut session = engine.open(&config(true, PASSWORD)).await.expect("open");

            // Round trip 1: the escape, alone — the shape that SUCCEEDS on a bare session.
            let escape = session
                .run(
                    &Script {
                        text: "SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE".to_string(),
                        mode: DbRunMode::Statement,
                    },
                    &limits(500, false),
                )
                .await;
            let err = escape.expect_err("the access-mode change must be refused");
            assert_eq!(
                err.code,
                agent_studio_scaffold_lib::db::error::DbErrorCode::Blocked
            );

            // Round trip 2: the write it was meant to enable. Still refused by the server,
            // because round trip 1 never reached it — this is the assertion that the two-trip
            // path is closed and not merely the one-batch path.
            let after = session
                .run(
                    &Script {
                        text: format!(
                            "INSERT INTO tracks (id, title, ensemble, duration, tag) \
                             VALUES ({PROBE_ESCAPE}, 'ESCAPED', 'duo', 1, 'wrote-anyway')"
                        ),
                        mode: DbRunMode::Statement,
                    },
                    &limits(500, false),
                )
                .await
                .expect("a refused write is a result, not a rejection");
            session.close().await;

            assert_eq!(
                scalar(&format!("SELECT tag FROM tracks WHERE id = {PROBE_ESCAPE}")).await,
                None,
                "the write landed after an access-mode change: {after:?}"
            );
            delete_probe_row(PROBE_ESCAPE).await;
        });
    }

    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn a_script_is_refused_when_the_connection_did_not_opt_in() {
        let err = rt().block_on(async {
            let engine = engine_for(DbEngineId::Postgres).unwrap();
            let mut s = engine.open(&config(true, PASSWORD)).await.expect("open");
            let err = s
                .run(
                    &Script {
                        text: "SELECT 1; SELECT 2".to_string(),
                        mode: DbRunMode::Script,
                    },
                    &limits(500, false),
                )
                .await
                .map(|_| ())
                .expect_err("two statements without the opt-in must be refused");
            s.close().await;
            err
        });
        assert_eq!(
            err.code,
            agent_studio_scaffold_lib::db::error::DbErrorCode::Blocked
        );
        // Updated with the rewritten refusal: it now names the SETTING that lifts it rather than
        // the internal term "multi-statement", because the old sentence did not say which guard
        // had fired or what to do about it.
        assert!(
            err.message.contains("Allow multiple statements"),
            "the refusal must name the setting that lifts it: {}",
            err.message
        );
        assert!(err.message.contains("2 statements"), "{}", err.message);
    }

    /* ─────────────── the URL override and the password typed beside it ─────────────── */

    /// 🔴 **The dropped-password bug, end to end against a real PostgreSQL.**
    ///
    /// The configuration was `Connection type: URL only` with
    /// `postgresql://gazelle@localhost:5433/orders` — a string our own importer had *stripped*
    /// the password out of, leaving no `{{VAR}}` behind — plus the password typed into the field
    /// the dialog points at. Every engine but ClickHouse read "a URL is present" as "ignore the
    /// password field", so the app dialled with **no password**. Nothing covered that pairing, which
    /// is exactly why it shipped.
    ///
    /// Three claims, and the second is what makes the first mean anything:
    ///
    /// 1. a URL carrying **no** credential plus a typed password connects and returns a row;
    /// 2. the same URL with the typed password **wrong** fails as `auth` — without this the test
    ///    would pass against a server that accepts anything, which is not hypothetical here
    ///    (the stock `pg_hba.conf` trusts loopback, which is why every password assertion in
    ///    this file arrives on the host-mapped port over the Docker bridge);
    /// 3. a URL that **does** carry a password keeps its own, proved by making the typed one wrong
    ///    and the connection succeeding anyway.
    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn a_url_with_no_password_uses_the_one_typed_beside_it_and_a_url_with_one_keeps_its_own() {
        const WRONG: &str = "definitely-not-the-password";
        let bare = format!("postgresql://{USER}@{HOST}:{PORT}/{DATABASE}");
        let with_password = format!("postgresql://{USER}:{PASSWORD}@{HOST}:{PORT}/{DATABASE}");

        // The host and port FIELDS point at nothing, so a row can only come back if the override is
        // what dialled — the fields cannot be quietly doing the work. `.invalid` is RFC 2606's
        // guaranteed-NXDOMAIN TLD, so a regression fails fast instead of reaching anything.
        let dial = |url: String, password: &'static str| async move {
            let mut cfg = config(true, password);
            cfg.host = "postgres.invalid".to_string();
            cfg.port = Some(9);
            cfg.url = Some(url);
            let mut session = engine_for(DbEngineId::Postgres)
                .expect("postgres is wired")
                .open(&cfg)
                .await?;
            let out = session
                .run(
                    &Script {
                        text: "SELECT 1 AS one".to_string(),
                        mode: DbRunMode::Statement,
                    },
                    &limits(500, false),
                )
                .await;
            session.close().await;
            out
        };

        // 1. The pairing that used to fail.
        let sets = rt()
            .block_on(dial(bare.clone(), PASSWORD))
            .unwrap_or_else(|e| {
                panic!(
                    "a URL with no password plus a typed one must connect: {} ({})",
                    e.message,
                    e.code.as_str()
                )
            });
        assert_eq!(sets[0].rows, vec![vec![Some("1".to_string())]]);

        // 2. The negative control.
        let err = rt()
            .block_on(dial(bare, WRONG))
            .expect_err("a wrong typed password must not connect");
        assert_eq!(
            err.code,
            agent_studio_scaffold_lib::db::error::DbErrorCode::Auth,
            "expected an auth failure, got {}: {}",
            err.code.as_str(),
            err.message
        );
        // The SECOND finding, against the real server: the message names the account from
        // OUR field instead of relying on the server's echo surviving redaction.
        assert!(
            err.message.contains(&format!("as user `{USER}`")),
            "an auth failure must name the account it dialled as: {}",
            err.message
        );
        assert!(!err.message.contains(WRONG), "{}", err.message);

        // 3. Precedence: the string speaks for itself, so the wrong typed password is ignored.
        let sets = rt()
            .block_on(dial(with_password, WRONG))
            .unwrap_or_else(|e| {
                panic!(
                    "the URL's own password must win over the field: {} ({})",
                    e.message,
                    e.code.as_str()
                )
            });
        assert_eq!(sets[0].rows, vec![vec![Some("1".to_string())]]);
    }
}

/// **The MySQL family, against the real MySQL 8.4.6 in `docker/db-fixtures`.**
///
/// A separate module rather than a parameterised version of `db_live` above, for one reason worth
/// stating: the two engines' *claims* differ, and a shared harness would push those differences
/// into flags until the tests stopped saying anything specific. In particular
/// `max_execution_time` is SELECT-only on MySQL while Postgres's `statement_timeout` is not, and
/// MySQL refuses a same-batch write that Postgres runs — the asymmetries are the interesting part.
///
/// Probe ids live in the **9100** range so nothing here can collide with the Postgres module's
/// 9000s even though they hit different servers (one shared mutable row between parallel tests
/// is a flake, and the fix is disjoint ids, not coordination).
mod db_live_mysql {
    use super::*;

    const HOST: &str = "127.0.0.1";
    const PORT: u16 = 53306;
    const USER: &str = "agentstudio";
    /// TEST FIXTURE ONLY — published in this repo, bound to localhost.
    const PASSWORD: &str = "agentstudio-test-pw";
    const DATABASE: &str = "maestro";

    const PROBE_READ_ONLY: i32 = 9101;
    const PROBE_SCRIPT: i32 = 9102;
    const PROBE_CONTROL: i32 = 9103;
    /// Its OWN id, not `PROBE_SCRIPT`'s. An earlier version of the access-mode-escape test reused
    /// 9102, and the two tests run in parallel against one server — a shared-mutable-row flake
    /// that looks exactly like a product bug.
    const PROBE_ESCAPE: i32 = 9104;

    pub(super) fn config(read_only: bool, password: &str) -> ResolvedConfig {
        ResolvedConfig {
            engine: DbEngineId::Mysql,
            family: DbFamily::Mysql,
            host: HOST.to_string(),
            port: Some(PORT),
            srv: false,
            database: DATABASE.to_string(),
            user: USER.to_string(),
            password: password.to_string(),
            // `Prefer` for the same reason as the Postgres module: it encrypts when the server
            // offers it (MySQL 8.4 auto-generates a self-signed cert, so it does) without
            // verifying a chain no fixture can have. This is also what makes the run below proof
            // that `caching_sha2_password` completes WITHOUT the forbidden `mysql-rsa` feature:
            // MySQL 8.4 disables `mysql_native_password`, and full sha2 auth needs either RSA
            // key exchange or a TLS tunnel. `agentstudio` is a `caching_sha2_password` account.
            ssl_mode: SslMode::Prefer,
            ca_pem: None,
            options: Default::default(),
            url: None,
            read_only,
            row_limit: 500,
            timeout_ms: 30_000,
            allow_multi_statement: false,
        }
    }

    fn limits(row_limit: u32, allow_multi_statement: bool) -> Limits {
        Limits {
            row_limit,
            timeout_ms: 30_000,
            allow_multi_statement,
        }
    }

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Runtime::new().expect("a tokio runtime")
    }

    async fn run(read_only: bool, sql: &str, mode: DbRunMode, lim: Limits) -> Vec<DbResultSet> {
        let engine = engine_for(DbEngineId::Mysql).expect("mysql is wired");
        let mut session = engine
            .open(&config(read_only, PASSWORD))
            .await
            .unwrap_or_else(|e| {
                panic!(
                    "could not open {HOST}:{PORT} — is `npm run db:fixtures:up` running? {}",
                    e.message
                )
            });
        let out = session
            .run(
                &Script {
                    text: sql.to_string(),
                    mode,
                },
                &lim,
            )
            .await;
        session.close().await;
        out.unwrap_or_else(|e| panic!("run failed: {} ({})", e.message, e.code.as_str()))
    }

    /// Delete a probe row through a read-WRITE session, so a failed assertion cannot leave the
    /// fixture dirty for the next run.
    async fn cleanup(id: i32) {
        let engine = engine_for(DbEngineId::Mysql).expect("mysql is wired");
        if let Ok(mut s) = engine.open(&config(false, PASSWORD)).await {
            let _ = s
                .run(
                    &Script {
                        text: format!("DELETE FROM tracks WHERE id = {id}"),
                        mode: DbRunMode::Statement,
                    },
                    &limits(500, false),
                )
                .await;
            s.close().await;
        }
    }

    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn a_real_select_runs_against_a_real_mysql() {
        let sets = rt().block_on(run(
            true,
            "SELECT title, tag FROM tracks WHERE id IN (2, 3) ORDER BY id",
            DbRunMode::Statement,
            limits(500, false),
        ));
        assert_eq!(sets.len(), 1);
        assert_eq!(sets[0].kind, DbResultKind::Rows);
        // The NULL-vs-empty pair, on MySQL this time: SQL NULL and the empty string must not collapse
        // into one another on the way through the text protocol.
        assert_eq!(
            sets[0].rows,
            vec![
                vec![Some("Bluewater".to_string()), None],
                vec![Some("Cinderglass".to_string()), Some(String::new())],
            ]
        );
    }

    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn probe_reports_the_real_server_version() {
        let info = rt().block_on(async {
            let engine = engine_for(DbEngineId::Mysql).expect("mysql is wired");
            let mut s = engine
                .open(&config(true, PASSWORD))
                .await
                .unwrap_or_else(|e| panic!("open failed: {}", e.message));
            let info = s.probe().await.expect("probe");
            s.close().await;
            info
        });
        // Prefixed by the engine, because `version()` alone returns a bare number that says
        // nothing about which of three configured engines answered.
        assert!(
            info.version.starts_with("MySQL 8."),
            "unexpected version string: {}",
            info.version
        );
        // MySQL's connection id, narrowed into the shared `backend_pid` field. Present means the
        // narrowing worked; `cancel` does not depend on this field.
        assert!(info.backend_pid.is_some(), "no connection id was reported");
    }

    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn the_declared_type_drives_the_cell_kind_not_the_value() {
        let sets = rt().block_on(run(
            true,
            "SELECT id, title, ok, payload, raw FROM tracks WHERE id = 1",
            DbRunMode::Statement,
            limits(500, false),
        ));
        let cols = &sets[0].columns;
        let names: Vec<&str> = cols.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["id", "title", "ok", "payload", "raw"]);
        // The server's OWN type names, verbatim. `ok` is a MySQL `boolean`, which the
        // server reports as `TINYINT` — asserted as what it really says rather than what the
        // column was declared as in the seed, because the latter is not what arrives.
        let types: Vec<&str> = cols.iter().map(|c| c.type_name.as_str()).collect();
        assert!(
            types[0].eq_ignore_ascii_case("INT") || types[0].eq_ignore_ascii_case("INTEGER"),
            "id's type name was {:?}",
            types[0]
        );
        // ⚠️ `BOOLEAN`, not `TINYINT`. The seed's comment says MySQL reports `boolean` as
        // `tinyint(1)` — true of the mysql CLI, and NOT of what arrives here: sqlx's
        // `MySqlTypeInfo` normalises it back to `BOOLEAN`. An earlier version of this assertion
        // expected TINYINT and failed, which is the test correcting an assumption rather than
        // finding a bug. Asserted as what the driver really reports, since that is what the
        // column header will show the user.
        assert_eq!(
            types[2].to_ascii_uppercase(),
            "BOOLEAN",
            "ok's type name was {:?}",
            types[2]
        );
        // A `blob` whose bytes ARE valid UTF-8 comes through as that text — row 1's
        // `X'48656C6C6F'` is literally "Hello". An earlier version asserted hex here and failed
        // with `left: "Hello"`: the byte fallback is reached by *undecodable* bytes, not by the
        // column being declared `blob`. The test corrected the assumption.
        assert_eq!(
            sets[0].rows[0][4].clone().expect("raw is not NULL"),
            "Hello"
        );

        // Row 2's `X'00FF10'` is NOT valid UTF-8, so it must arrive as visible hex — never as
        // SQL NULL (which would be the app lying about the data) and never as a lossy
        // replacement-character string, which is worse because it still looks like data.
        let undecodable = rt().block_on(run(
            true,
            "SELECT raw FROM tracks WHERE id = 2",
            DbRunMode::Statement,
            limits(500, false),
        ));
        assert_eq!(
            undecodable[0].rows[0][0].clone().expect("raw is not NULL"),
            "\\x00ff10"
        );
    }

    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn read_only_is_server_enforced() {
        let sets = rt().block_on(run(
            true,
            &format!("INSERT INTO tracks (id, title, ensemble, duration) VALUES ({PROBE_READ_ONLY}, 'RO', 'duo', 1)"),
            DbRunMode::Statement,
            limits(500, false),
        ));
        // A database error is a RESULT, not a rejection (the `http_send` contract).
        assert_eq!(sets.len(), 1);
        assert_eq!(sets[0].kind, DbResultKind::Message);
        let msg = sets[0].notice.clone().unwrap_or_default();
        // The message is OURS, not MySQL's echo — the `blocked` code was
        // made uniform in provenance so the frontend could stop discarding it, which meant the
        // server's own words ("read only", error 1792) no longer travel. The refusal is still
        // proven; what changed is whose sentence describes it.
        assert!(
            msg.to_lowercase().contains("read-only"),
            "the server did not refuse the write: {msg}"
        );
        assert!(
            msg.contains("Read-only") && msg.contains("settings"),
            "the refusal must name the setting that lifts it: {msg}"
        );
        // And the row really is absent — the refusal is the *mechanism*, this is the *effect*.
        let check = rt().block_on(run(
            true,
            &format!("SELECT id FROM tracks WHERE id = {PROBE_READ_ONLY}"),
            DbRunMode::Statement,
            limits(500, false),
        ));
        assert!(check[0].rows.is_empty(), "the write landed anyway");
        rt().block_on(cleanup(PROBE_READ_ONLY));
    }

    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn the_same_write_succeeds_on_a_read_write_session() {
        // The negative control, and the reason the test above proves anything at all (a
        // refusal is only evidence if the same statement succeeds when the guardrail is off —
        // otherwise the test could be measuring a typo).
        let sets = rt().block_on(run(
            false,
            &format!(
                "INSERT INTO tracks (id, title, ensemble, duration) VALUES ({PROBE_CONTROL}, 'RW', 'duo', 1)"
            ),
            DbRunMode::Statement,
            limits(500, false),
        ));
        assert_eq!(sets[0].kind, DbResultKind::Affected);
        assert_eq!(sets[0].rows_affected, Some(1));
        rt().block_on(cleanup(PROBE_CONTROL));
    }

    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn read_only_survives_a_multi_statement_script() {
        // A plain multi-statement script must not slip a write past the guardrail. (The
        // deliberate *escape* — a statement that turns read-only off — is the next test.)
        let sets = rt().block_on(run(
            true,
            &format!(
                "SELECT 1; \
                 INSERT INTO tracks (id, title, ensemble, duration) VALUES ({PROBE_SCRIPT}, 'ESC', 'duo', 1); \
                 SELECT 2"
            ),
            DbRunMode::Script,
            limits(500, true),
        ));
        let check = rt().block_on(run(
            true,
            &format!("SELECT id FROM tracks WHERE id = {PROBE_SCRIPT}"),
            DbRunMode::Statement,
            limits(500, false),
        ));
        assert!(
            check[0].rows.is_empty(),
            "a script escaped the read-only guardrail: {sets:?}"
        );
        rt().block_on(cleanup(PROBE_SCRIPT));
    }

    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn a_statement_that_would_turn_read_only_off_is_refused() {
        // 🔴 **The finding this test exists for, measured against the fixture.** MySQL applies
        // `SET SESSION TRANSACTION READ WRITE` immediately, so the very next autocommit
        // statement writes — the fixture accepted `rows_affected: Some(1)` before
        // `guard::read_only_escape` existed. (Postgres refuses that *same batch*, because a
        // batch is one implicit transaction whose access mode is already fixed — but it accepts
        // the same pair across two round trips, which is what our console does. Both engines
        // are affected; see the Postgres module's version of this test.)
        let out = rt().block_on(async {
            let engine = engine_for(DbEngineId::Mysql).expect("mysql is wired");
            let mut s = engine.open(&config(true, PASSWORD)).await.expect("open");
            let out = s
                .run(
                    &Script {
                        text: format!(
                            "SET SESSION TRANSACTION READ WRITE; \
                             INSERT INTO tracks (id, title, ensemble, duration) VALUES ({PROBE_ESCAPE}, 'ESC', 'duo', 1)"
                        ),
                        mode: DbRunMode::Script,
                    },
                    &limits(500, true),
                )
                .await;
            s.close().await;
            out
        });
        let err = out.expect_err("the access-mode change must be refused");
        assert_eq!(
            err.code,
            agent_studio_scaffold_lib::db::error::DbErrorCode::Blocked
        );
        // Refused as a WHOLE — nothing ran, so the row cannot exist. A per-statement refusal
        // would have let the script execute halfway.
        let check = rt().block_on(run(
            true,
            &format!("SELECT id FROM tracks WHERE id = {PROBE_ESCAPE}"),
            DbRunMode::Statement,
            limits(500, false),
        ));
        assert!(check[0].rows.is_empty(), "the write landed anyway");
        rt().block_on(cleanup(PROBE_ESCAPE));
    }

    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn a_script_is_refused_when_the_connection_did_not_opt_in() {
        let out = rt().block_on(async {
            let engine = engine_for(DbEngineId::Mysql).expect("mysql is wired");
            let mut s = engine.open(&config(true, PASSWORD)).await.expect("open");
            let out = s
                .run(
                    &Script {
                        text: "SELECT 1; SELECT 2".to_string(),
                        mode: DbRunMode::Script,
                    },
                    &limits(500, false),
                )
                .await;
            s.close().await;
            out
        });
        let err = out.expect_err("a script must be refused without the opt-in");
        assert_eq!(
            err.code,
            agent_studio_scaffold_lib::db::error::DbErrorCode::Blocked
        );
    }

    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn a_syntax_error_is_a_result_and_not_a_rejection() {
        let sets = rt().block_on(run(
            true,
            "SELECT FROM WHERE",
            DbRunMode::Statement,
            limits(500, false),
        ));
        assert_eq!(sets.len(), 1);
        assert_eq!(sets[0].kind, DbResultKind::Message);
        assert!(sets[0].notice.is_some(), "the error text was dropped");
    }

    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn the_row_cap_is_measured_rather_than_inferred() {
        // `tall` holds 2000 rows. A cap of exactly 3 with 3 rows returned must NOT report
        // truncation, and a cap of 3 against 2000 must — inferring it from `rows.len() == cap`
        // is wrong exactly when the table has that many rows.
        let capped = rt().block_on(run(
            true,
            "SELECT n FROM tall ORDER BY n LIMIT 3",
            DbRunMode::Statement,
            limits(3, false),
        ));
        assert_eq!(capped[0].rows.len(), 3);
        assert!(
            !capped[0].truncated,
            "3 rows under a cap of 3 is not truncation"
        );

        let truncated = rt().block_on(run(
            true,
            "SELECT n FROM tall ORDER BY n",
            DbRunMode::Statement,
            limits(3, false),
        ));
        assert_eq!(truncated[0].rows.len(), 3);
        assert!(truncated[0].truncated, "2000 rows under a cap of 3 is");
    }

    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn a_wrong_password_never_appears_in_the_error() {
        // Redaction: sqlx and libmysqlclient both echo connection details into error text. The wrong
        // password must not be one of them, and `auth` must be the classification — "check the
        // network" would send the user looking in the wrong place.
        let err = rt().block_on(async {
            let engine = engine_for(DbEngineId::Mysql).expect("mysql is wired");
            engine
                .open(&config(true, "definitely-not-the-password"))
                .await
                .map(|_| ())
                .expect_err("a wrong password must not connect")
        });
        assert!(
            !err.message.contains("definitely-not-the-password"),
            "the password leaked into the error: {}",
            err.message
        );
        assert_eq!(
            err.code,
            agent_studio_scaffold_lib::db::error::DbErrorCode::Auth,
            "wrong password classified as {:?}: {}",
            err.code,
            err.message
        );
    }

    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn aurora_mysql_dials_the_same_wire_and_reports_its_own_label() {
        // Aurora MySQL is registered against the same engine type. This proves the *pairing* is
        // right — the descriptor is Aurora's — while dialling the only MySQL-compatible server
        // this repo ships. Stated plainly: no Aurora cluster was contacted, so nothing here
        // claims anything about Aurora's failover or reader-endpoint behaviour.
        let engine = engine_for(DbEngineId::AuroraMysql).expect("aurora mysql is wired");
        assert_eq!(engine.spec().label, "Amazon Aurora MySQL");

        let mut cfg = config(true, PASSWORD);
        cfg.engine = DbEngineId::AuroraMysql;
        let version = rt().block_on(async {
            let mut s = engine
                .open(&cfg)
                .await
                .unwrap_or_else(|e| panic!("open failed: {}", e.message));
            let info = s.probe().await.expect("probe");
            s.close().await;
            info.version
        });
        assert!(version.starts_with("MySQL 8."), "{version}");
    }

    /* ─────────────── the URL override and the password typed beside it ─────────────── */

    /// 🔴 **The dropped-password bug, end to end against a real MySQL.**
    ///
    /// The configuration was `Connection type: URL only` with
    /// `postgresql://gazelle@localhost:5433/orders` — a string our own importer had *stripped*
    /// the password out of, leaving no `{{VAR}}` behind — plus the password typed into the field
    /// the dialog points at. Every engine but ClickHouse read "a URL is present" as "ignore the
    /// password field", so the app dialled with **no password**. Nothing covered that pairing, which
    /// is exactly why it shipped.
    ///
    /// Three claims, and the second is what makes the first mean anything:
    ///
    /// 1. a URL carrying **no** credential plus a typed password connects and returns a row;
    /// 2. the same URL with the typed password **wrong** fails as `auth` — without this the test
    ///    would pass against a server that accepts anything, which is not hypothetical here
    ///    (the stock `pg_hba.conf` trusts loopback, which is why every password assertion in
    ///    this file arrives on the host-mapped port over the Docker bridge);
    /// 3. a URL that **does** carry a password keeps its own, proved by making the typed one wrong
    ///    and the connection succeeding anyway.
    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn a_url_with_no_password_uses_the_one_typed_beside_it_and_a_url_with_one_keeps_its_own() {
        const WRONG: &str = "definitely-not-the-password";
        let bare = format!("mysql://{USER}@{HOST}:{PORT}/{DATABASE}");
        let with_password = format!("mysql://{USER}:{PASSWORD}@{HOST}:{PORT}/{DATABASE}");

        let dial = |url: String, password: &'static str| async move {
            let mut cfg = config(true, password);
            cfg.host = "mysql.invalid".to_string();
            cfg.port = Some(9);
            cfg.url = Some(url);
            let mut session = engine_for(DbEngineId::Mysql)
                .expect("mysql is wired")
                .open(&cfg)
                .await?;
            let out = session
                .run(
                    &Script {
                        text: "SELECT 1 AS one".to_string(),
                        mode: DbRunMode::Statement,
                    },
                    &limits(500, false),
                )
                .await;
            session.close().await;
            out
        };

        let sets = rt()
            .block_on(dial(bare.clone(), PASSWORD))
            .unwrap_or_else(|e| {
                panic!(
                    "a URL with no password plus a typed one must connect: {} ({})",
                    e.message,
                    e.code.as_str()
                )
            });
        assert_eq!(sets[0].rows, vec![vec![Some("1".to_string())]]);

        let err = rt()
            .block_on(dial(bare, WRONG))
            .expect_err("a wrong typed password must not connect");
        assert_eq!(
            err.code,
            agent_studio_scaffold_lib::db::error::DbErrorCode::Auth,
            "expected an auth failure, got {}: {}",
            err.code.as_str(),
            err.message
        );
        assert!(
            err.message.contains(&format!("as user `{USER}`")),
            "an auth failure must name the account it dialled as: {}",
            err.message
        );
        assert!(!err.message.contains(WRONG), "{}", err.message);

        let sets = rt()
            .block_on(dial(with_password, WRONG))
            .unwrap_or_else(|e| {
                panic!(
                    "the URL's own password must win over the field: {} ({})",
                    e.message,
                    e.code.as_str()
                )
            });
        assert_eq!(sets[0].rows, vec![vec![Some("1".to_string())]]);
    }
}

/// **ClickHouse, against the real 25.6 in `docker/db-fixtures`, over its HTTP interface.**
///
/// The fixture publishes only port 8123 (HTTP), so these run with `SslMode::Disable`. The TLS
/// ladder is exercised by the unit tests in `db/clickhouse.rs` and by the live TLS smokes in
/// `http.rs` — nothing here claims ClickHouse-over-TLS was proven, because this repo ships no
/// ClickHouse with a certificate.
///
/// Probe ids live in the **9200** range (disjoint from the 9000s and 9100s).
mod db_live_clickhouse {
    use super::*;

    const HOST: &str = "127.0.0.1";
    const PORT: u16 = 58123;
    const USER: &str = "agentstudio";
    /// TEST FIXTURE ONLY — published in this repo, bound to localhost.
    const PASSWORD: &str = "agentstudio-test-pw";
    const DATABASE: &str = "maestro";

    const PROBE_READ_ONLY: u32 = 9201;
    const PROBE_CONTROL: u32 = 9202;

    pub(super) fn config(read_only: bool, password: &str) -> ResolvedConfig {
        ResolvedConfig {
            engine: DbEngineId::Clickhouse,
            family: DbFamily::Clickhouse,
            host: HOST.to_string(),
            port: Some(PORT),
            srv: false,
            database: DATABASE.to_string(),
            user: USER.to_string(),
            password: password.to_string(),
            // The fixture is HTTP-only. `Disable` is the honest mode for it, and it is what makes
            // `scheme()` pick `http://`.
            ssl_mode: SslMode::Disable,
            ca_pem: None,
            options: Default::default(),
            url: None,
            read_only,
            row_limit: 500,
            timeout_ms: 30_000,
            allow_multi_statement: false,
        }
    }

    fn limits(row_limit: u32, allow_multi_statement: bool) -> Limits {
        Limits {
            row_limit,
            timeout_ms: 30_000,
            allow_multi_statement,
        }
    }

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Runtime::new().expect("a tokio runtime")
    }

    async fn run(read_only: bool, sql: &str, mode: DbRunMode, lim: Limits) -> Vec<DbResultSet> {
        let engine = engine_for(DbEngineId::Clickhouse).expect("clickhouse is wired");
        let mut session = engine
            .open(&config(read_only, PASSWORD))
            .await
            .unwrap_or_else(|e| {
                panic!(
                    "could not open {HOST}:{PORT} — is `npm run db:fixtures:up` running? {}",
                    e.message
                )
            });
        let out = session
            .run(
                &Script {
                    text: sql.to_string(),
                    mode,
                },
                &lim,
            )
            .await;
        session.close().await;
        out.unwrap_or_else(|e| panic!("run failed: {} ({})", e.message, e.code.as_str()))
    }

    /// 🔴 **The `url` override really dials; an earlier version IGNORED it.**
    ///
    /// The dialog's URL box says *"Overrides settings above"*; this engine read `host`/`port` and
    /// nothing else, so pasting a URL did literally nothing. A unit test proves the string we build;
    /// only this proves the built string is what reaches a real server — so the `host` field is set
    /// to a host that does not exist, and the run can only succeed if the override won.
    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn a_url_override_is_what_actually_dials() {
        let sets = rt().block_on(async {
            let engine = engine_for(DbEngineId::Clickhouse).expect("clickhouse is wired");
            let mut cfg = config(true, PASSWORD);
            cfg.host = "clickhouse.invalid".to_string();
            cfg.port = Some(9);
            cfg.url = Some(format!("http://{HOST}:{PORT}"));
            let mut session = engine.open(&cfg).await.unwrap_or_else(|e| {
                panic!(
                    "the override did not dial (host/port would have failed): {} ({})",
                    e.message,
                    e.code.as_str()
                )
            });
            let out = session
                .run(
                    &Script {
                        text: "SELECT 1".to_string(),
                        mode: DbRunMode::Statement,
                    },
                    &limits(500, false),
                )
                .await;
            session.close().await;
            out.expect("select through the override")
        });
        assert_eq!(sets[0].rows, vec![vec![Some("1".to_string())]]);

        // The negative control: the SAME unreachable host/port with no override must
        // fail, or this test would pass even if the override were still ignored.
        let refused = rt().block_on(async {
            let engine = engine_for(DbEngineId::Clickhouse).expect("clickhouse is wired");
            let mut cfg = config(true, PASSWORD);
            cfg.host = "clickhouse.invalid".to_string();
            cfg.port = Some(9);
            cfg.options
                .insert("connectTimeout".to_string(), "3".to_string());
            engine.open(&cfg).await.map(|_| ())
        });
        assert!(
            refused.is_err(),
            "the control must fail, or the override proves nothing"
        );
    }

    /// Remove a probe row through a read-WRITE session. ClickHouse's `DELETE` is a mutation and
    /// is asynchronous by default, so this asks for it synchronously — otherwise the next test
    /// can see the row that was "deleted".
    async fn cleanup(id: u32) {
        let engine = engine_for(DbEngineId::Clickhouse).expect("clickhouse is wired");
        if let Ok(mut s) = engine.open(&config(false, PASSWORD)).await {
            let _ = s
                .run(
                    &Script {
                        text: format!(
                            "SET mutations_sync = 2; ALTER TABLE tracks DELETE WHERE id = {id}"
                        ),
                        mode: DbRunMode::Script,
                    },
                    &limits(500, true),
                )
                .await;
            s.close().await;
        }
    }

    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn a_real_select_runs_against_a_real_clickhouse() {
        let sets = rt().block_on(run(
            true,
            "SELECT title, tag FROM tracks WHERE id IN (2, 3) ORDER BY id",
            DbRunMode::Statement,
            limits(500, false),
        ));
        assert_eq!(sets.len(), 1);
        assert_eq!(sets[0].kind, DbResultKind::Rows);
        // The NULL-vs-empty pair on a third engine, and the one that justified choosing `JSONCompact`
        // over `JSONCompactStrings` (which renders NULL as the literal string "ᴺᵁᴸᴸ").
        assert_eq!(
            sets[0].rows,
            vec![
                vec![Some("Bluewater".to_string()), None],
                vec![Some("Cinderglass".to_string()), Some(String::new())],
            ]
        );
    }

    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn probe_reports_the_real_server_version() {
        let info = rt().block_on(async {
            let engine = engine_for(DbEngineId::Clickhouse).expect("clickhouse is wired");
            let mut s = engine
                .open(&config(true, PASSWORD))
                .await
                .unwrap_or_else(|e| panic!("open failed: {}", e.message));
            let info = s.probe().await.expect("probe");
            s.close().await;
            info
        });
        assert!(
            info.version.starts_with("ClickHouse 2"),
            "unexpected version string: {}",
            info.version
        );
        // No backend pid exists for ClickHouse, and inventing one would be a lie the cancel path
        // would then depend on.
        assert!(info.backend_pid.is_none());
    }

    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn open_really_dials_so_a_bad_host_fails_at_connect_time() {
        // 🔴 HTTP is stateless, so `open` could return a struct without contacting anything —
        // and then Test Connection would report success for a host that does not exist. This is
        // the test that keeps `open`'s probe round trip in place.
        let mut cfg = config(true, PASSWORD);
        cfg.port = Some(1); // nothing listens here
        cfg.options
            .insert("connectTimeout".to_string(), "2".to_string());
        let err = rt().block_on(async {
            engine_for(DbEngineId::Clickhouse)
                .expect("wired")
                .open(&cfg)
                .await
                .map(|_| ())
                .expect_err("open must fail when nothing is listening")
        });
        assert_eq!(
            err.code,
            agent_studio_scaffold_lib::db::error::DbErrorCode::Network,
            "classified as {:?}: {}",
            err.code,
            err.message
        );
    }

    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn the_declared_type_arrives_verbatim_with_its_wrappers() {
        let sets = rt().block_on(run(
            true,
            "SELECT id, duration, tag, flags, ok FROM tracks WHERE id = 1",
            DbRunMode::Statement,
            limits(500, false),
        ));
        let types: Vec<&str> = sets[0]
            .columns
            .iter()
            .map(|c| c.type_name.as_str())
            .collect();
        // The server's own spelling, wrappers and spacing included — this is the string
        // `cell_kind`'s ClickHouse arm has to survive, and the column header shows.
        assert_eq!(
            types,
            vec![
                "UInt32",
                "Nullable(Decimal(12, 4))",
                "Nullable(String)",
                "Array(String)",
                "Bool"
            ]
        );
        // A Decimal reaches us as exact text, not through an f64 — the whole point of
        // `output_format_json_quote_decimals=1`.
        assert_eq!(sets[0].rows[0][1], Some("0.5".to_string()));
        // A composite renders as compact one-line JSON in the cell.
        assert_eq!(sets[0].rows[0][3], Some(r#"["1","2","3"]"#.to_string()));
        assert_eq!(sets[0].rows[0][4], Some("true".to_string()));
    }

    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn a_big_int64_survives_without_an_f64_round_trip() {
        // 9007199254740993 is 2^53 + 1: the smallest integer an f64 cannot represent. If any
        // part of this path parsed the value as a float, it would come back as …92.
        let sets = rt().block_on(run(
            true,
            "SELECT toInt64(9007199254740993) AS big, toDecimal64(0.30000000000000004, 17) AS d",
            DbRunMode::Statement,
            limits(500, false),
        ));
        assert_eq!(sets[0].rows[0][0], Some("9007199254740993".to_string()));
        assert_eq!(sets[0].rows[0][1], Some("0.30000000000000004".to_string()));
    }

    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn read_only_is_server_enforced() {
        let sets = rt().block_on(run(
            true,
            &format!(
                "INSERT INTO tracks (id, title, ensemble, ok, at) \
                 VALUES ({PROBE_READ_ONLY}, 'RO', 'duo', 1, now())"
            ),
            DbRunMode::Statement,
            limits(500, false),
        ));
        // A refused statement is a RESULT, and the server's own reason reaches the user.
        assert_eq!(sets[0].kind, DbResultKind::Message);
        let msg = sets[0].notice.clone().unwrap_or_default();
        assert!(
            msg.contains("readonly") || msg.contains("READONLY"),
            "the server did not refuse the write: {msg}"
        );
        let check = rt().block_on(run(
            true,
            &format!("SELECT id FROM tracks WHERE id = {PROBE_READ_ONLY}"),
            DbRunMode::Statement,
            limits(500, false),
        ));
        assert!(check[0].rows.is_empty(), "the write landed anyway");
        rt().block_on(cleanup(PROBE_READ_ONLY));
    }

    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn the_same_write_succeeds_on_a_read_write_session() {
        // The negative control: without it, the refusal above could be a typo.
        let sets = rt().block_on(run(
            false,
            &format!(
                "INSERT INTO tracks (id, title, ensemble, ok, at) \
                 VALUES ({PROBE_CONTROL}, 'RW', 'duo', 1, now())"
            ),
            DbRunMode::Statement,
            limits(500, false),
        ));
        // ClickHouse answers an INSERT with a 200 and an empty body — `Affected` with no count,
        // because the HTTP interface does not send one and inventing 0 would be a lie.
        assert_eq!(sets[0].kind, DbResultKind::Affected);
        let check = rt().block_on(run(
            false,
            &format!("SELECT title FROM tracks WHERE id = {PROBE_CONTROL}"),
            DbRunMode::Statement,
            limits(500, false),
        ));
        assert_eq!(check[0].rows, vec![vec![Some("RW".to_string())]]);
        rt().block_on(cleanup(PROBE_CONTROL));
    }

    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn read_only_cannot_be_turned_off_by_sql_here_and_the_server_says_so() {
        // 🔴 The contrast with the SQL engines. On Postgres and MySQL a session's read-only is a
        // *default for later transactions* that the user's own SQL can change, which is why
        // `guard::read_only_escape` exists. ClickHouse sends `readonly=1` on EVERY request and
        // the server refuses to modify the setting — so the escape does not exist, and this is
        // the test that proves the difference rather than assuming it.
        let sets = rt().block_on(run(
            true,
            "SET readonly = 0",
            DbRunMode::Statement,
            limits(500, false),
        ));
        assert_eq!(sets[0].kind, DbResultKind::Message);
        let msg = sets[0].notice.clone().unwrap_or_default();
        assert!(
            msg.contains("readonly"),
            "expected the server to refuse the settings change: {msg}"
        );
    }

    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn a_script_runs_as_sequential_posts_and_stops_at_the_first_failure() {
        // ClickHouse's HTTP interface takes one statement per request, so a script is N POSTs.
        // Statement 2 fails, and statement 3 must NOT run — same visible behaviour as the SQL
        // engines' single-batch break, reached differently.
        let sets = rt().block_on(run(
            true,
            "SELECT 1; SELECT bogus_function(); SELECT 3",
            DbRunMode::Script,
            limits(500, true),
        ));
        assert_eq!(sets.len(), 2, "statement 3 ran after a failure: {sets:#?}");
        assert_eq!(sets[0].kind, DbResultKind::Rows);
        assert_eq!(sets[1].kind, DbResultKind::Message);
    }

    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn the_row_cap_is_measured_rather_than_inferred() {
        // `tall` holds 2000 rows. 3 rows under a cap of 3 is not truncation; 2000 under 3 is.
        let capped = rt().block_on(run(
            true,
            "SELECT n FROM tall ORDER BY n LIMIT 3",
            DbRunMode::Statement,
            limits(3, false),
        ));
        assert_eq!(capped[0].rows.len(), 3);
        assert!(!capped[0].truncated);

        let truncated = rt().block_on(run(
            true,
            "SELECT n FROM tall ORDER BY n",
            DbRunMode::Statement,
            limits(3, false),
        ));
        assert_eq!(truncated[0].rows.len(), 3);
        assert!(truncated[0].truncated);
    }

    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn a_wrong_password_is_auth_and_never_appears_in_the_error() {
        let err = rt().block_on(async {
            engine_for(DbEngineId::Clickhouse)
                .expect("wired")
                .open(&config(true, "definitely-not-the-password"))
                .await
                .map(|_| ())
                .expect_err("a wrong password must not connect")
        });
        assert!(
            !err.message.contains("definitely-not-the-password"),
            "the password leaked into the error: {}",
            err.message
        );
        assert_eq!(
            err.code,
            agent_studio_scaffold_lib::db::error::DbErrorCode::Auth,
            "classified as {:?}: {}",
            err.code,
            err.message
        );
    }

    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn a_syntax_error_is_a_result_and_not_a_rejection() {
        let sets = rt().block_on(run(
            true,
            "SELECT FROM WHERE",
            DbRunMode::Statement,
            limits(500, false),
        ));
        assert_eq!(sets[0].kind, DbResultKind::Message);
        let msg = sets[0].notice.clone().unwrap_or_default();
        assert!(!msg.is_empty());
        // The version suffix ClickHouse appends to every exception is noise in a toast.
        assert!(!msg.contains("(version "), "{msg}");
    }
}

/// **The connection tree, walked against all three real engines.**
///
/// One module rather than three, because the *point* is that the same walk works on engines whose
/// hierarchies differ — and the differences are asserted rather than smoothed over: PostgreSQL has
/// a schema level and can only see the database it is connected to, while MySQL and ClickHouse
/// list every database on the server and have no schemas.
mod db_live_tree {
    use super::*;
    use agent_studio_scaffold_lib::db::tree::{DbGroup, DbNodeKind, DbNodeRef};

    /// TEST FIXTURE ONLY — published in this repo, bound to localhost.
    const PASSWORD: &str = "agentstudio-test-pw";

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Runtime::new().expect("a tokio runtime")
    }

    fn config(engine: DbEngineId) -> ResolvedConfig {
        let (family, port, ssl) = match engine {
            DbEngineId::Postgres => (DbFamily::Postgres, 55432, SslMode::Prefer),
            DbEngineId::Mysql => (DbFamily::Mysql, 53306, SslMode::Prefer),
            DbEngineId::Clickhouse => (DbFamily::Clickhouse, 58123, SslMode::Disable),
            other => panic!("the tree tier does not cover {other:?}"),
        };
        ResolvedConfig {
            engine,
            family,
            host: "127.0.0.1".to_string(),
            port: Some(port),
            srv: false,
            database: "maestro".to_string(),
            user: "agentstudio".to_string(),
            password: PASSWORD.to_string(),
            ssl_mode: ssl,
            ca_pem: None,
            options: Default::default(),
            url: None,
            read_only: true,
            row_limit: 500,
            timeout_ms: 30_000,
            allow_multi_statement: false,
        }
    }

    /// Walk one level, on a fresh session.
    async fn children(
        engine: DbEngineId,
        node: DbNodeRef,
    ) -> Vec<agent_studio_scaffold_lib::db::tree::DbNode> {
        let e = engine_for(engine).expect("wired");
        let mut session = e
            .open(&config(engine))
            .await
            .unwrap_or_else(|err| panic!("{engine:?}: open failed — fixture up? {}", err.message));
        let out = session.children(&node).await;
        session.close().await;
        out.unwrap_or_else(|err| panic!("{engine:?}: children failed: {}", err.message))
    }

    fn labels(nodes: &[agent_studio_scaffold_lib::db::tree::DbNode]) -> Vec<String> {
        nodes.iter().map(|n| n.label.clone()).collect()
    }

    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn postgres_walks_root_to_schema_to_tables_to_columns() {
        rt().block_on(async {
            // Root: the connected database ONLY, and it says why. Listing `pg_database` would give
            // nodes that fail on expand, since a PG connection cannot read another's catalog.
            let root = children(DbEngineId::Postgres, DbNodeRef::Root).await;
            assert_eq!(labels(&root), vec!["maestro"]);
            assert_eq!(root[0].sub_label.as_deref(), Some("the connected database"));

            // Database → schemas. `public` is there and the server's own bookkeeping is not.
            let schemas = children(
                DbEngineId::Postgres,
                DbNodeRef::Database {
                    name: "maestro".into(),
                },
            )
            .await;
            assert!(
                labels(&schemas).contains(&"public".to_string()),
                "{:?}",
                labels(&schemas)
            );
            for hidden in ["pg_catalog", "pg_toast", "information_schema"] {
                assert!(
                    !labels(&schemas).contains(&hidden.to_string()),
                    "{hidden} should not be listed"
                );
            }

            // Schema → the two groups, with measured counts.
            let groups = children(
                DbEngineId::Postgres,
                DbNodeRef::Schema {
                    database: "maestro".into(),
                    name: "public".into(),
                },
            )
            .await;
            assert_eq!(labels(&groups), vec!["Tables", "Views"]);
            assert!(groups.iter().all(|g| g.kind == DbNodeKind::Group));
            // The fixture seeds `tracks` + `tall` and one view, so neither group is empty.
            assert_ne!(groups[0].sub_label.as_deref(), Some("empty"));

            // Group → tables.
            let tables = children(
                DbEngineId::Postgres,
                DbNodeRef::Group {
                    database: "maestro".into(),
                    schema: Some("public".into()),
                    group: DbGroup::Tables,
                },
            )
            .await;
            assert!(
                labels(&tables).contains(&"tracks".to_string()),
                "{:?}",
                labels(&tables)
            );
            assert!(tables
                .iter()
                .all(|t| t.kind == DbNodeKind::Table && t.expandable));

            // A view is a VIEW, not a table — the icon depends on it.
            let views = children(
                DbEngineId::Postgres,
                DbNodeRef::Group {
                    database: "maestro".into(),
                    schema: Some("public".into()),
                    group: DbGroup::Views,
                },
            )
            .await;
            assert!(!views.is_empty(), "the fixture seeds a view");
            assert!(views.iter().all(|v| v.kind == DbNodeKind::View));

            // Table → columns, with the server's OWN type spelling.
            let columns = children(
                DbEngineId::Postgres,
                DbNodeRef::Table {
                    database: "maestro".into(),
                    schema: Some("public".into()),
                    name: "tracks".into(),
                },
            )
            .await;
            assert!(columns
                .iter()
                .all(|c| c.kind == DbNodeKind::Column && !c.expandable));
            let tag = columns
                .iter()
                .find(|c| c.label == "tag")
                .expect("the nullable text column");
            // The Postgres seed declares `tag` as `text` (the MySQL one uses `varchar(64)` — an
            // earlier version of this assertion copied that and failed with `left: Some("text")`).
            assert_eq!(tag.sub_label.as_deref(), Some("text"));
            // `format_type`'s value shows on a column that HAS a length: `title` is `varchar(16)`,
            // where `information_schema` would have said `character varying` and hidden the 16.
            let title = columns.iter().find(|c| c.label == "title").expect("title");
            assert_eq!(
                title.sub_label.as_deref(),
                Some("character varying(16) · not null")
            );
            // And NOT NULL is called out — the difference between a column that can hold the NULL
            // this app distinguishes from '' and one that cannot.
            let id = columns.iter().find(|c| c.label == "id").expect("id");
            assert_eq!(id.sub_label.as_deref(), Some("integer · not null"));
        });
    }

    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn mysql_has_no_schema_level_and_lists_every_database() {
        rt().block_on(async {
            let root = children(DbEngineId::Mysql, DbNodeRef::Root).await;
            let names = labels(&root);
            // Every database on the server, which is the difference from PostgreSQL…
            assert!(names.contains(&"maestro".to_string()), "{names:?}");
            // …and the server's own are hidden.
            for hidden in ["mysql", "information_schema", "performance_schema", "sys"] {
                assert!(
                    !names.contains(&hidden.to_string()),
                    "{hidden} should not be listed"
                );
            }
            // The connected one is marked, or it is indistinguishable from the rest.
            let maestro = root.iter().find(|n| n.label == "maestro").unwrap();
            assert_eq!(maestro.sub_label.as_deref(), Some("connected"));

            // A database expands STRAIGHT into groups — MySQL's schemata are its databases.
            let groups = children(
                DbEngineId::Mysql,
                DbNodeRef::Database {
                    name: "maestro".into(),
                },
            )
            .await;
            assert_eq!(labels(&groups), vec!["Tables", "Views"]);

            let tables = children(
                DbEngineId::Mysql,
                DbNodeRef::Group {
                    database: "maestro".into(),
                    schema: None,
                    group: DbGroup::Tables,
                },
            )
            .await;
            assert!(
                labels(&tables).contains(&"tracks".to_string()),
                "{:?}",
                labels(&tables)
            );

            let columns = children(
                DbEngineId::Mysql,
                DbNodeRef::Table {
                    database: "maestro".into(),
                    schema: None,
                    name: "tracks".into(),
                },
            )
            .await;
            let tag = columns.iter().find(|c| c.label == "tag").expect("tag");
            // `column_type`, not `data_type`: the length is part of what the user needs to see.
            assert_eq!(tag.sub_label.as_deref(), Some("varchar(64)"));
            let ensemble = columns
                .iter()
                .find(|c| c.label == "ensemble")
                .expect("ensemble");
            assert!(
                ensemble
                    .sub_label
                    .as_deref()
                    .unwrap_or("")
                    .starts_with("enum("),
                "an ENUM must show its members: {:?}",
                ensemble.sub_label
            );
        });
    }

    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn clickhouse_walks_databases_to_tables_to_columns() {
        rt().block_on(async {
            let root = children(DbEngineId::Clickhouse, DbNodeRef::Root).await;
            let names = labels(&root);
            assert!(names.contains(&"maestro".to_string()), "{names:?}");
            for hidden in ["system", "information_schema", "INFORMATION_SCHEMA"] {
                assert!(
                    !names.contains(&hidden.to_string()),
                    "{hidden} should not be listed"
                );
            }

            let groups = children(
                DbEngineId::Clickhouse,
                DbNodeRef::Database {
                    name: "maestro".into(),
                },
            )
            .await;
            assert_eq!(labels(&groups), vec!["Tables", "Views"]);

            let tables = children(
                DbEngineId::Clickhouse,
                DbNodeRef::Group {
                    database: "maestro".into(),
                    schema: None,
                    group: DbGroup::Tables,
                },
            )
            .await;
            assert!(
                labels(&tables).contains(&"tracks".to_string()),
                "{:?}",
                labels(&tables)
            );

            let columns = children(
                DbEngineId::Clickhouse,
                DbNodeRef::Table {
                    database: "maestro".into(),
                    schema: None,
                    name: "tracks".into(),
                },
            )
            .await;
            // ClickHouse has no `is_nullable`: the `Nullable(…)` wrapper IS the nullability, and
            // the type is shown with it, which is what the tree means by verbatim.
            let tag = columns.iter().find(|c| c.label == "tag").expect("tag");
            assert_eq!(tag.sub_label.as_deref(), Some("Nullable(String)"));
            let id = columns.iter().find(|c| c.label == "id").expect("id");
            assert_eq!(id.sub_label.as_deref(), Some("UInt32 · not null"));
        });
    }

    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn a_table_that_does_not_exist_yields_no_columns_rather_than_an_error() {
        // A stale tree node — the table was dropped while the panel had it expanded. An empty
        // level is the honest answer; an error toast for a node the user is merely collapsing is
        // noise, and the refresh that follows shows the truth.
        rt().block_on(async {
            for engine in [
                DbEngineId::Postgres,
                DbEngineId::Mysql,
                DbEngineId::Clickhouse,
            ] {
                let columns = children(
                    engine,
                    DbNodeRef::Table {
                        database: "maestro".into(),
                        schema: Some("public".into()),
                        name: "no_such_table_9999".into(),
                    },
                )
                .await;
                assert!(columns.is_empty(), "{engine:?} invented columns");
            }
        });
    }

    /// 🔴 **A catalog query must not be splice-able.** The tree passes names that came from the
    /// server back into the next query, and a table created as `x'; DROP …` would otherwise be
    /// injected. Every engine binds them (ClickHouse via `{name:String}` parameters), so a hostile
    /// name is *data* — it simply matches nothing.
    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn a_hostile_object_name_is_data_and_not_sql() {
        rt().block_on(async {
            let hostile = "x'; SELECT 1; --".to_string();
            for engine in [
                DbEngineId::Postgres,
                DbEngineId::Mysql,
                DbEngineId::Clickhouse,
            ] {
                // If this were interpolated, the statement would either error (a syntax failure
                // reaching the caller as `children` returning Err) or run the injected SQL. It
                // must do neither: an empty level is the correct answer for a table with that name.
                let columns = children(
                    engine,
                    DbNodeRef::Table {
                        database: "maestro".into(),
                        schema: Some(hostile.clone()),
                        name: hostile.clone(),
                    },
                )
                .await;
                assert!(columns.is_empty(), "{engine:?}: {columns:#?}");
            }
        });
    }
}

/// **MongoDB, against the real 8.0 in `docker/db-fixtures`, through the official driver.**
///
/// The fixture publishes no TLS listener, so these run with `SslMode::Disable`. Nothing here
/// claims MongoDB-over-TLS was proven — the ladder is exercised by the unit tests in
/// `db/mongo.rs`, and this repo ships no MongoDB with a certificate.
///
/// Probe ids live in the **9300** range (disjoint from the 9000s, 9100s and 9200s),
/// spelled as ObjectIds so they sort after the seed's `oid(1..6)` and cannot collide with it.
///
/// 🔴 **Two fixture constraints shape every write here.**
///
/// 1. **No test may create a collection.** `compose.yaml`'s healthcheck asserts
///    `db.getCollectionNames().length === 6` every two seconds, so a seventh collection — even for
///    a moment — makes the container `unhealthy` and blocks the *whole* database tier for every
///    engine (an untested engine must never block the tier). Write probes therefore go into
///    the existing `tracks`, and the `$merge` control targets the existing, deliberately-empty
///    `studios`.
/// 2. **That is also why `$out` has no read-write control.** `$out` stages through a temporary
///    `tmp.agg_out.*` collection, which would appear in that count. The `$merge` test below is the
///    negative control that proves the refusal is our filter and not a typo; `$out`
///    is only proved refused.
mod db_live_mongo {
    use super::*;
    use agent_studio_scaffold_lib::db::tree::{DbGroup, DbNodeKind, DbNodeRef};

    const HOST: &str = "127.0.0.1";
    const PORT: u16 = 57017;
    const USER: &str = "agentstudio";
    /// TEST FIXTURE ONLY — published in this repo, bound to localhost.
    const PASSWORD: &str = "agentstudio-test-pw";
    const DATABASE: &str = "maestro";

    /// The insert probe (allowlist refusal + its read-write control).
    const PROBE_INSERT: &str = "000000000000000000009301";
    /// The `$merge` probe, which lands in `studios` and is deleted again.
    const PROBE_MERGE: &str = "000000000000000000009302";

    /// The seed's deterministic ids, so an assertion names a stable value.
    const DOC2: &str = "000000000000000000000002";
    const DOC3: &str = "000000000000000000000003";
    const DOC6: &str = "000000000000000000000006";

    pub(super) fn config(read_only: bool, password: &str) -> ResolvedConfig {
        let mut options = std::collections::BTreeMap::new();
        // The fixture's user is the image's `MONGO_INITDB_ROOT_USERNAME`, which lives in `admin` —
        // the descriptor's own default, and the reason that default is `admin` and not the queried
        // database.
        options.insert("authSource".to_string(), "admin".to_string());
        ResolvedConfig {
            engine: DbEngineId::Mongodb,
            family: DbFamily::Mongodb,
            host: HOST.to_string(),
            port: Some(PORT),
            srv: false,
            database: DATABASE.to_string(),
            user: USER.to_string(),
            password: password.to_string(),
            // The fixture speaks plaintext on a loopback port. `Disable` is the honest mode.
            ssl_mode: SslMode::Disable,
            ca_pem: None,
            options,
            url: None,
            read_only,
            row_limit: 500,
            timeout_ms: 30_000,
            allow_multi_statement: false,
        }
    }

    fn limits(row_limit: u32) -> Limits {
        Limits {
            row_limit,
            timeout_ms: 30_000,
            allow_multi_statement: false,
        }
    }

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Runtime::new().expect("a tokio runtime")
    }

    async fn open(read_only: bool) -> Box<dyn agent_studio_scaffold_lib::db::engine::DbSession> {
        engine_for(DbEngineId::Mongodb)
            .expect("mongodb is wired")
            .open(&config(read_only, PASSWORD))
            .await
            .unwrap_or_else(|e| {
                panic!(
                    "could not open {HOST}:{PORT} — is `npm run db:fixtures:up` running? {}",
                    e.message
                )
            })
    }

    /// Run one command document on a fresh session. `read_only` picks which guardrail the session
    /// was opened under, which is the variable most of these tests are about.
    async fn run(read_only: bool, command: &str) -> Vec<DbResultSet> {
        let mut session = open(read_only).await;
        let out = session
            .run(
                &Script {
                    text: command.to_string(),
                    mode: DbRunMode::Statement,
                },
                &limits(500),
            )
            .await;
        session.close().await;
        out.unwrap_or_else(|e| panic!("run failed: {} ({})", e.message, e.code.as_str()))
    }

    /// The same, but keeping the `Err` — for the guardrail tests, where the refusal IS the result.
    async fn try_run(
        read_only: bool,
        command: &str,
    ) -> Result<Vec<DbResultSet>, agent_studio_scaffold_lib::db::error::DbError> {
        let mut session = open(read_only).await;
        let out = session
            .run(
                &Script {
                    text: command.to_string(),
                    mode: DbRunMode::Statement,
                },
                &limits(500),
            )
            .await;
        session.close().await;
        out
    }

    /// Which column a name is in, so an assertion does not hard-code a position that the column
    /// union decides.
    fn column(set: &DbResultSet, name: &str) -> usize {
        set.columns
            .iter()
            .position(|c| c.name == name)
            .unwrap_or_else(|| {
                panic!(
                    "no `{name}` column in {:?}",
                    set.columns.iter().map(|c| &c.name).collect::<Vec<_>>()
                )
            })
    }

    /// Delete a probe document through a read-WRITE session, so the fixture stays reusable without
    /// a reset. Never creates or drops a collection — see the module doc.
    async fn cleanup(collection: &str, oid: &str) {
        let mut session = open(false).await;
        let _ = session
            .run(
                &Script {
                    text: format!(
                        r#"{{"delete": "{collection}", "deletes": [{{"q": {{"_id": {{"$oid": "{oid}"}}}}, "limit": 1}}]}}"#
                    ),
                    mode: DbRunMode::Statement,
                },
                &limits(500),
            )
            .await;
        session.close().await;
    }

    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn a_real_find_returns_the_fixture_documents() {
        let sets = rt().block_on(run(
            true,
            &format!(
                r#"{{"find": "tracks",
                     "filter": {{"_id": {{"$in": [{{"$oid": "{DOC2}"}}, {{"$oid": "{DOC3}"}}]}}}},
                     "projection": {{"_id": 0, "title": 1, "tag": 1}},
                     "sort": {{"title": 1}}}}"#
            ),
        ));
        assert_eq!(sets.len(), 1, "one command per run: {sets:#?}");
        assert_eq!(sets[0].kind, DbResultKind::Rows);
        let names: Vec<&str> = sets[0].columns.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["title", "tag"]);
        // The NULL-vs-empty pair on a fourth engine: Bluewater's `tag` is an explicit null,
        // Cinderglass's is the empty string, and the two must not collapse.
        assert_eq!(
            sets[0].rows,
            vec![
                vec![Some("Bluewater".to_string()), None],
                vec![Some("Cinderglass".to_string()), Some(String::new())],
            ]
        );
        // Both documents have both projected fields, so there is nothing to warn about.
        assert_eq!(sets[0].notice, None, "{:?}", sets[0].notice);
    }

    /// 🔴 **A SQL statement, RUN against a real MongoDB.**
    ///
    /// The whole history in one test. `select * from …` first failed as if the *connection* were
    /// broken (a code→sentence mapper discarding the engine's message), then was refused with an
    /// honest explanation that MongoDB has no SQL. SQL-first tools run that exact statement — they
    /// translate client-side — so this app does too, and the assertion below is the reverse of
    /// what this test first asserted.
    ///
    /// Only a live run proves the translation is a command the SERVER accepts; the unit tests pin
    /// the document, and this pins that MongoDB agrees with it. Against the Docker fixture only,
    /// never anyone's real cluster.
    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn a_select_star_is_translated_and_really_runs() {
        let sets = rt().block_on(run(true, "select * from tracks limit 2"));
        assert_eq!(sets.len(), 1);
        assert_eq!(sets[0].kind, DbResultKind::Rows);
        assert_eq!(sets[0].rows.len(), 2, "LIMIT 2 reached the server");

        // WHERE, checked against named seed rows rather than a count — the fixture is shared and
        // this tier runs in parallel.
        let filtered = rt().block_on(run(true, "select * from tracks where title = 'Bluewater'"));
        let title = column(&filtered[0], "title");
        assert!(!filtered[0].rows.is_empty(), "the seed has a Bluewater row");
        assert!(
            filtered[0]
                .rows
                .iter()
                .all(|r| r[title].as_deref() == Some("Bluewater")),
            "the WHERE reached the server rather than being dropped"
        );

        // And the `db.collection` qualifier decides the DATABASE — the shape of
        // `ARCHIVEDB.temp_playlists`. Pointed at a database where that collection does not exist,
        // so the qualifier's effect is observable: empty, and the notice says which database.
        let elsewhere = rt().block_on(run(true, "select * from admin.tracks"));
        assert!(elsewhere[0].rows.is_empty());
        let notice = elsewhere[0].notice.as_deref().unwrap_or_default();
        assert!(
            notice.contains("no collection `tracks`") && notice.contains("admin"),
            "the qualifier must decide the database, and an empty result must name it: {notice}"
        );
    }

    /// 🔴 A translation that changes meaning must say so in the RESULT.
    ///
    /// `IS NULL` becomes `{"f": null}`, which in MongoDB matches an **absent** field as well as a
    /// null one — a real difference from SQL that a person reading the rows would never learn from
    /// the rows.
    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn a_translation_that_changes_meaning_says_so_in_the_result() {
        let sets = rt().block_on(run(true, "select * from tracks where tag is null"));
        let notice = sets[0].notice.as_deref().unwrap_or_default();
        assert!(
            notice.contains("absent") || notice.contains("missing"),
            "the IS NULL asymmetry must be reported: {notice}"
        );

        // The control: a query with no such gap carries no such notice, or the warning is
        // decoration rather than a finding.
        let plain = rt().block_on(run(true, "select * from tracks where title = 'Bluewater'"));
        let plain_notice = plain[0].notice.as_deref().unwrap_or_default();
        assert!(!plain_notice.contains("absent"), "{plain_notice}");
    }

    /// 🔴 **`{"count": "temp_playlists"}`, against a real server.**
    ///
    /// It showed `clusterTime`, `signature`, `hash` and `keyId` in the grid — MongoDB's session
    /// envelope, which rides on **every** reply — with the answer pushed off the side. Only a live
    /// test can prove this: the envelope is added by the server, so a hand-built fixture document
    /// would not have it and the bug would be invisible.
    /// 🔴 **`$db` reaches another database, against a real server.**
    ///
    /// A connection made from an SRV URI with no `/dbname` was bound to `admin`, so its
    /// `find` searched a database nobody named and answered with an empty cursor and no error.
    /// This proves the escape hatch works: the session is bound to `maestro`, and `$db` sends the
    /// command somewhere else.
    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn a_db_override_runs_the_command_against_another_database() {
        // Bound to `maestro` (see `config`), asking `admin` about itself.
        let sets = rt().block_on(run(true, r#"{"dbStats": 1, "$db": "admin"}"#));
        assert_eq!(sets[0].kind, DbResultKind::Rows);
        let db = column(&sets[0], "db");
        assert_eq!(
            sets[0].rows[0][db].as_deref(),
            Some("admin"),
            "the command must run where `$db` says, not where the session is bound"
        );

        // The control: the same command with no override reports the session's own database, so
        // the assertion above is the override working and not a coincidence.
        let bound = rt().block_on(run(true, r#"{"dbStats": 1}"#));
        assert_eq!(
            bound[0].rows[0][column(&bound[0], "db")].as_deref(),
            Some("maestro")
        );
    }

    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn a_count_shows_its_number_and_not_the_protocol_envelope() {
        let sets = rt().block_on(run(true, r#"{"count": "tracks"}"#));
        assert_eq!(sets[0].kind, DbResultKind::Rows);
        let names: Vec<&str> = sets[0].columns.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["n"], "the answer alone: {names:?}");
        // The seed's row count, so this also proves the number survived.
        assert_eq!(sets[0].rows[0][0].as_deref(), Some("6"));
        // Hidden, and SAID to be hidden.
        let notice = sets[0].notice.as_deref().unwrap_or_default();
        assert!(notice.contains("protocol envelope"), "{notice}");
        assert!(notice.contains("ok"), "{notice}");
        // 🔴 `$clusterTime`/`operationTime` — the fields the bug actually showed — are **absent
        // here on purpose**: they are causal-consistency metadata that only a REPLICA SET sends,
        // and this fixture is a standalone `mongod`. An Atlas cluster is a replica set, which is
        // why the bug was visible there and cannot be reproduced against this container. The unit
        // test `a_command_reply_shows_its_answer_and_not_the_protocol_envelope` carries that case
        // with a synthesised reply — said out loud, because "the live test passed" would otherwise
        // read as coverage of the exact thing it cannot reach.
    }

    /// 🔴 **An empty result explains itself now.**
    ///
    /// `{"find": "temp_playlists", "limit": 10}` answered *"No rows. The statement ran and matched
    /// nothing"* — true whether the collection is empty, absent, or in a different database. Mongo
    /// returns an empty cursor for a missing collection **with no error**, so silence is the one
    /// thing the server will never explain.
    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn an_empty_result_says_whether_the_collection_is_even_there() {
        // Absent: the case that used to say nothing. The notice must name the database AND say it
        // is not there.
        let missing = rt().block_on(run(true, r#"{"find": "temp_playlists", "limit": 10}"#));
        assert!(missing[0].rows.is_empty());
        let notice = missing[0].notice.as_deref().unwrap_or_default();
        assert!(
            notice.contains("no collection `temp_playlists`"),
            "an absent collection must say so: {notice}"
        );
        assert!(
            notice.contains("maestro"),
            "and name the database: {notice}"
        );

        // Present but matching nothing — the OTHER fact, which must read differently or the notice
        // is just decoration.
        //
        // 🔴 A FILTER that matches nothing, not the "deliberately empty" `studios` collection: an
        // earlier version used `studios` and failed, because the `$merge` tests write a probe
        // document into it and `cargo test` runs this tier in parallel — an assertion about a shared
        // fixture's contents is a flake by construction.
        let empty = rt().block_on(run(
            true,
            r#"{"find": "tracks", "filter": {"title": "NO-SUCH-TITLE-EVER"}, "limit": 10}"#,
        ));
        assert!(empty[0].rows.is_empty());
        let notice = empty[0].notice.as_deref().unwrap_or_default();
        assert!(
            notice.contains("`tracks` exists in database")
                && notice.contains("no document matched"),
            "a collection that IS there must read differently from a missing one: {notice}"
        );

        // And a result WITH rows carries no such notice — the diagnosis costs a round trip and
        // must only be paid when there is nothing to show.
        let rows = rt().block_on(run(true, r#"{"find": "tracks", "limit": 2}"#));
        assert!(!rows[0].rows.is_empty());
        let notice = rows[0].notice.as_deref().unwrap_or_default();
        assert!(!notice.contains("exists in database"), "{notice}");
    }

    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn probe_reports_the_real_server_version() {
        let info = rt().block_on(async {
            let mut s = open(true).await;
            let info = s.probe().await.expect("probe");
            s.close().await;
            info
        });
        assert!(
            info.version.starts_with("MongoDB 8."),
            "unexpected version string: {}",
            info.version
        );
        // MongoDB has no per-session backend id, and inventing one would be a lie `cancel` would
        // then appear to depend on.
        assert!(info.backend_pid.is_none());
    }

    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn open_really_dials_so_a_bad_host_fails_at_connect_time() {
        // 🔴 `Client::with_options` only VALIDATES — the driver dials lazily — so without the
        // probe round trip in `open`, this would "succeed" for a host that does not exist and Test
        // Connection would report a working connection. This is the test that keeps it there.
        let mut cfg = config(true, PASSWORD);
        cfg.port = Some(1); // nothing listens here
        cfg.options
            .insert("connectTimeout".to_string(), "2".to_string());
        let err = rt().block_on(async {
            engine_for(DbEngineId::Mongodb)
                .expect("wired")
                .open(&cfg)
                .await
                .map(|_| ())
                .expect_err("open must fail when nothing is listening")
        });
        assert_eq!(
            err.code,
            agent_studio_scaffold_lib::db::error::DbErrorCode::Network,
            "classified as {:?}: {}",
            err.code,
            err.message
        );
    }

    /// 🔴 **The three states, from one query, and the honest half of the finding.**
    ///
    /// `tag: null` (doc 2), `tag: ""` (doc 3) and `tempo` **absent** (doc 6) are three distinct
    /// MongoDB states, and `Vec<Vec<Option<String>>>` has two cells. Null and the empty string
    /// stay distinct; **absent collapses into the null cell**, and the result's `notice` is what
    /// carries the difference. See `db/mongo.rs`'s module doc for the proof that no encoding into
    /// the current contract can do better, and for the one extra field that would fix it.
    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn all_three_null_states_come_back_and_the_notice_names_the_absent_field() {
        let sets = rt().block_on(run(
            true,
            &format!(
                r#"{{"find": "tracks",
                     "filter": {{"_id": {{"$in": [
                        {{"$oid": "{DOC2}"}}, {{"$oid": "{DOC3}"}}, {{"$oid": "{DOC6}"}}]}}}},
                     "sort": {{"_id": 1}}}}"#
            ),
        ));
        let set = &sets[0];
        let (tag, tempo, raw, payload) = (
            column(set, "tag"),
            column(set, "tempo"),
            column(set, "raw"),
            column(set, "payload"),
        );

        // 1. An explicit BSON null.
        assert_eq!(set.rows[0][tag], None, "doc 2's tag is an explicit null");
        // 2. The empty string, which must NOT collapse into null.
        assert_eq!(
            set.rows[1][tag],
            Some(String::new()),
            "doc 3's tag is the empty string"
        );
        // 3. Absent. The cell is indistinguishable from #1 — that is the collapse…
        assert_eq!(set.rows[2][tempo], None, "doc 6 has no `tempo` at all");
        assert_eq!(set.rows[2][raw], None, "doc 6 has no `raw` at all");
        // …and doc 6's `payload` is a REAL null, in the very same cell shape, which is exactly why
        // the notice has to exist.
        assert_eq!(set.rows[2][payload], None, "doc 6's payload IS null");

        let notice = set
            .notice
            .clone()
            .expect("an absent field MUST produce a notice — the grid cannot say it");
        assert!(notice.contains("`tempo` in 1 of 3"), "{notice}");
        assert!(notice.contains("`raw` in 1 of 3"), "{notice}");
        assert!(
            notice.contains("absent field is NOT a null"),
            "the notice must name the collapse: {notice}"
        );

        // The negative control for the notice itself: the same query over documents
        // that all have every field must produce NO notice, or "a notice appears" would be true of
        // every result and would prove nothing about absence.
        let complete = rt().block_on(run(
            true,
            &format!(
                r#"{{"find": "tracks",
                     "filter": {{"_id": {{"$in": [{{"$oid": "{DOC2}"}}, {{"$oid": "{DOC3}"}}]}}}},
                     "sort": {{"_id": 1}}}}"#
            ),
        ));
        assert_eq!(complete[0].notice, None, "{:?}", complete[0].notice);
    }

    /// 🔴 **`Decimal128` must not round-trip through an `f64`.**
    ///
    /// The trailing zeros are the tell: `0.5000` would be `0.5` and `-2.5000` would be
    /// `-2.5` if anything on this path parsed the value as a float. `seq` is the same point for
    /// `Int64`: 2^53 + 1 is the smallest integer an `f64` cannot represent, and `mongosh`'s own
    /// *relaxed* extended JSON gets it wrong (it prints …992), so this asserts a value our
    /// renderer is measurably more exact about than the reference tool.
    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn decimal128_and_int64_arrive_with_their_exact_digits() {
        let sets = rt().block_on(run(
            true,
            r#"{"find": "tracks",
                "filter": {},
                "projection": {"_id": 1, "duration": 1, "seq": 1},
                "sort": {"_id": 1}}"#,
        ));
        let set = &sets[0];
        let (id, duration) = (column(set, "_id"), column(set, "duration"));
        // An ObjectId as `mongosh` prints it, not as `{"$oid": …}`.
        assert_eq!(
            set.rows[0][id],
            Some("000000000000000000000001".to_string())
        );
        assert_eq!(set.rows[0][duration], Some("0.5000".to_string()));
        // The negative sign and the trailing zeros both survive (document 6).
        assert_eq!(set.rows[5][duration], Some("-2.5000".to_string()));
        assert_eq!(set.columns[duration].type_name, "decimal");

        // Only document 1 has `seq`, so this also re-proves the absence notice from the other side.
        let seq = column(set, "seq");
        assert_eq!(set.rows[0][seq], Some("9007199254740993".to_string()));
        assert_eq!(set.columns[seq].type_name, "long");
    }

    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn the_read_only_allowlist_refuses_a_write_and_the_read_write_session_performs_it() {
        let insert = format!(
            r#"{{"insert": "tracks", "documents": [
                 {{"_id": {{"$oid": "{PROBE_INSERT}"}}, "title": "RO-PROBE", "ensemble": "duo"}}]}}"#
        );

        // Read-only: refused in Rust, before anything reaches the server. `insert` is not on
        // the read-only allowlist, and the command name is quoted so the user knows what was stopped.
        let err = rt()
            .block_on(try_run(true, &insert))
            .map(|_| ())
            .expect_err("a read-only session must refuse `insert`");
        assert_eq!(
            err.code,
            agent_studio_scaffold_lib::db::error::DbErrorCode::Blocked,
            "{}",
            err.message
        );
        assert!(err.message.contains("`insert`"), "{}", err.message);

        // …and it really did not land.
        let check = rt().block_on(run(
            true,
            &format!(r#"{{"find": "tracks", "filter": {{"_id": {{"$oid": "{PROBE_INSERT}"}}}}}}"#),
        ));
        assert!(check[0].rows.is_empty(), "the write landed anyway");

        // 🔴 The negative control. Without it, the refusal above could be a typo in
        // the command rather than the guardrail working.
        let sets = rt().block_on(run(false, &insert));
        assert_eq!(sets[0].kind, DbResultKind::Rows);
        let n = column(&sets[0], "n");
        assert_eq!(sets[0].rows[0][n], Some("1".to_string()), "{:#?}", sets[0]);

        let check = rt().block_on(run(
            false,
            &format!(
                r#"{{"find": "tracks", "filter": {{"_id": {{"$oid": "{PROBE_INSERT}"}}}},
                      "projection": {{"_id": 0, "title": 1}}}}"#
            ),
        ));
        assert_eq!(check[0].rows, vec![vec![Some("RO-PROBE".to_string())]]);
        rt().block_on(cleanup("tracks", PROBE_INSERT));
    }

    /// 🔴 **The structural `$out`/`$merge` refusal, and the string-search trap.**
    ///
    /// `aggregate` IS on the read-only allowlist, so the only thing that can stop a `$out` stage is
    /// the walk over the parsed BSON. Both spellings below are refused; the second one is the case
    /// a `text.contains("$out")` implementation cannot catch, because JSON's `$` escape means
    /// the request body never contains the substring at all.
    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn a_write_stage_is_refused_structurally_including_one_a_string_search_cannot_see() {
        let plain = r#"{"aggregate": "tracks", "pipeline": [{"$limit": 1}, {"$out": "studios"}], "cursor": {}}"#;
        let escaped = r#"{"aggregate": "tracks", "pipeline": [{"$limit": 1}, {"\u0024out": "studios"}], "cursor": {}}"#;
        assert!(
            !escaped.contains("$out"),
            "this test is only meaningful while the escaped form has no `$out` in its text"
        );

        for command in [plain, escaped] {
            let err = rt()
                .block_on(try_run(true, command))
                .map(|_| ())
                .expect_err("a read-only session must refuse a $out pipeline");
            assert_eq!(
                err.code,
                agent_studio_scaffold_lib::db::error::DbErrorCode::Blocked,
                "{command}: {}",
                err.message
            );
            assert!(err.message.contains("$out"), "{command}: {}", err.message);
        }

        // A read that merely MENTIONS `$out` in a string value is not a write, and must run —
        // which is the assertion a string search fails (the other direction).
        let sets = rt().block_on(run(
            true,
            r#"{"aggregate": "tracks", "pipeline": [{"$match": {"tag": "$out"}}], "cursor": {}}"#,
        ));
        assert_eq!(sets[0].kind, DbResultKind::Rows);
        assert!(sets[0].rows.is_empty(), "no fixture document has that tag");
    }

    /// The read-write control for the write-stage guard, using `$merge` rather than `$out`.
    ///
    /// `$merge` writes in place, so it cannot create the temporary collection that would trip the
    /// fixture's exactly-six healthcheck (see the module doc). The target is `studios`, the seed's
    /// deliberately-empty collection, and the probe document is deleted again — so `studios` is left
    /// empty, which is what the seed comment says it is for.
    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn the_same_write_stage_succeeds_on_a_read_write_session() {
        let merge = format!(
            r#"{{"aggregate": "tracks", "pipeline": [
                 {{"$limit": 1}},
                 {{"$project": {{"_id": {{"$literal": {{"$oid": "{PROBE_MERGE}"}}}},
                                 "probe": {{"$literal": "rw-control"}}}}}},
                 {{"$merge": {{"into": "studios", "whenMatched": "replace"}}}}
               ], "cursor": {{}}}}"#
        );

        // Refused read-only, structurally, exactly like `$out`.
        let err = rt()
            .block_on(try_run(true, &merge))
            .map(|_| ())
            .expect_err("a read-only session must refuse a $merge pipeline");
        assert_eq!(
            err.code,
            agent_studio_scaffold_lib::db::error::DbErrorCode::Blocked
        );
        assert!(err.message.contains("$merge"), "{}", err.message);

        // 🔴 And the SAME pipeline writes on a read-write session, which is what proves the refusal
        // above is our filter rather than an invalid command.
        let sets = rt().block_on(run(false, &merge));
        assert_ne!(
            sets[0].kind,
            DbResultKind::Message,
            "the $merge failed on a read-write session: {:#?}",
            sets[0]
        );
        let check = rt().block_on(run(
            false,
            &format!(
                r#"{{"find": "studios", "filter": {{"_id": {{"$oid": "{PROBE_MERGE}"}}}},
                      "projection": {{"_id": 0, "probe": 1}}}}"#
            ),
        ));
        assert_eq!(check[0].rows, vec![vec![Some("rw-control".to_string())]]);
        rt().block_on(cleanup("studios", PROBE_MERGE));

        // Left as found: `studios` is empty again, because the seed says an empty collection is
        // what it is there to exercise.
        let after = rt().block_on(run(false, r#"{"find": "studios", "filter": {}}"#));
        assert!(
            after[0].rows.is_empty(),
            "studios was left dirty: {:#?}",
            after[0]
        );
    }

    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn a_wrong_password_is_auth_and_never_appears_in_the_error() {
        let err = rt().block_on(async {
            engine_for(DbEngineId::Mongodb)
                .expect("wired")
                .open(&config(true, "definitely-not-the-password"))
                .await
                .map(|_| ())
                .expect_err("a wrong password must not connect")
        });
        assert!(
            !err.message.contains("definitely-not-the-password"),
            "the password leaked into the error: {}",
            err.message
        );
        assert_eq!(
            err.code,
            agent_studio_scaffold_lib::db::error::DbErrorCode::Auth,
            "classified as {:?}: {}",
            err.code,
            err.message
        );
    }

    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn a_command_error_is_a_result_and_not_a_rejection() {
        // `find` is allowed, the filter is nonsense — so the SERVER refuses it. That is a normal
        // console outcome and must arrive as a `message` result beside the statement, not as a
        // rejected command (the `http_send` contract).
        let sets = rt().block_on(run(
            true,
            r#"{"find": "tracks", "filter": {"$nosuchoperator": 1}}"#,
        ));
        assert_eq!(sets[0].kind, DbResultKind::Message, "{:#?}", sets[0]);
        let message = sets[0].notice.clone().unwrap_or_default();
        assert!(!message.is_empty(), "a message result needs its prose");
    }

    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn the_row_cap_is_measured_rather_than_inferred() {
        // `tall` holds 2000 documents. 3 under a cap of 3 is NOT truncation; 2000 under 3 is.
        let capped = rt().block_on(async {
            let mut s = open(true).await;
            let out = s
                .run(
                    &Script {
                        text: r#"{"find": "tall", "filter": {"_id": {"$lte": 3}}, "sort": {"_id": 1}}"#
                            .to_string(),
                        mode: DbRunMode::Statement,
                    },
                    &limits(3),
                )
                .await
                .expect("run");
            s.close().await;
            out
        });
        assert_eq!(capped[0].rows.len(), 3);
        assert!(
            !capped[0].truncated,
            "exactly a full page is not truncation"
        );

        let truncated = rt().block_on(async {
            let mut s = open(true).await;
            let out = s
                .run(
                    &Script {
                        text: r#"{"find": "tall", "filter": {}, "sort": {"_id": 1}}"#.to_string(),
                        mode: DbRunMode::Statement,
                    },
                    &limits(3),
                )
                .await
                .expect("run");
            s.close().await;
            out
        });
        assert_eq!(truncated[0].rows.len(), 3);
        assert!(truncated[0].truncated, "2000 documents under a cap of 3 is");
    }

    /// Two documents: neither runs, and the report says which problem it is.
    ///
    /// **Changed deliberately, and the old assertion was the weaker one.** This used to require a
    /// *rejection* carrying `invalid-config`, and it asserted only the code — while its name
    /// promised "rather than running the first", which it never checked (a test named after a
    /// guarantee is not a test of that guarantee).
    ///
    /// It is now an `invalid-statement` **message result**, for a reason specific to this engine:
    /// one command document per request is a property of the MongoDB wire protocol, not a policy.
    /// `allowMultiStatement` cannot switch it on, so reporting it as `blocked` — the code the SQL
    /// engines' multi-statement guard uses — would tell the user to change a setting that would
    /// not help. What they need is the sentence, and this is the shape that carries it.
    ///
    /// The guarantee in the name is now actually tested: a `find` that had run would return rows.
    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn a_second_command_document_is_refused_rather_than_running_the_first() {
        let sets = rt().block_on(run(
            true,
            r#"{"find": "tracks", "limit": 1} {"find": "cues"}"#,
        ));

        assert_eq!(sets.len(), 1);
        assert_eq!(sets[0].kind, DbResultKind::Message);
        let notice = sets[0].notice.as_deref().unwrap_or_default();
        assert!(notice.contains("one command document"), "{notice}");
        // 🔴 The actual guarantee: nothing was sent, so there are no rows and no columns. A
        // `{"find": "tracks", "limit": 1}` that had reached the server would return exactly one.
        assert!(sets[0].rows.is_empty(), "the first command must not run");
        assert!(sets[0].columns.is_empty(), "{:?}", sets[0].columns);
    }

    /// The tree, walked root → database → **Collections** → collection → fields.
    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn the_tree_walks_root_to_database_to_collections_to_a_collection_to_its_fields() {
        rt().block_on(async {
            let mut session = open(true).await;

            let root = session.children(&DbNodeRef::Root).await.expect("root");
            let names: Vec<String> = root.iter().map(|n| n.label.clone()).collect();
            assert!(names.contains(&"maestro".to_string()), "{names:?}");
            // MongoDB's own bookkeeping databases are hidden.
            for hidden in ["admin", "local", "config"] {
                assert!(
                    !names.contains(&hidden.to_string()),
                    "{hidden} should not be listed: {names:?}"
                );
            }
            let maestro = root.iter().find(|n| n.label == "maestro").unwrap();
            assert_eq!(maestro.sub_label.as_deref(), Some("connected"));

            // Database → ONE group, the collections. The fixture has exactly six, which is what
            // `compose.yaml`'s healthcheck and the seed's own assertion both enforce.
            let groups = session
                .children(&DbNodeRef::Database {
                    name: "maestro".into(),
                })
                .await
                .expect("groups");
            assert_eq!(groups.len(), 1, "{groups:#?}");
            assert_eq!(groups[0].kind, DbNodeKind::Group);
            // ⚠️ FINDING, recorded rather than worked around: one could expect the literal
            // string `collections (6)`, but the implemented node shape is a `label` plus a
            // `sub_label` and `tree::count_label` spells the count as "6 collections". Rather than
            // hand-rolling a second label function (which would then disagree with every other
            // engine's group rows), this asserts what the shared helpers actually produce.
            assert_eq!(groups[0].label, "Collections");
            assert_eq!(groups[0].sub_label.as_deref(), Some("6 collections"));
            assert!(groups[0].expandable);

            // Group → the six collections.
            let collections = session
                .children(&DbNodeRef::Group {
                    database: "maestro".into(),
                    schema: None,
                    group: DbGroup::Collections,
                })
                .await
                .expect("collections");
            let labels: Vec<String> = collections.iter().map(|n| n.label.clone()).collect();
            assert_eq!(
                labels,
                vec!["catalog", "cues", "journal", "studios", "tall", "tracks"],
                "the seed's exactly-six, sorted"
            );
            // A collection is a COLLECTION, not a table — the icon depends on it.
            assert!(collections
                .iter()
                .all(|c| c.kind == DbNodeKind::Collection && c.expandable));

            // Collection → its sampled fields, in first-seen order.
            let fields = session
                .children(&DbNodeRef::Table {
                    database: "maestro".into(),
                    schema: None,
                    name: "tracks".into(),
                })
                .await
                .expect("fields");
            let names: Vec<String> = fields.iter().map(|f| f.label.clone()).collect();
            assert_eq!(
                names,
                vec![
                    "_id", "title", "ensemble", "duration", "tempo", "ok", "seq", "small", "flags",
                    "payload", "raw", "at", "tag"
                ],
                "the union of the six documents' top-level fields, first-seen order"
            );
            assert!(fields
                .iter()
                .all(|f| f.kind == DbNodeKind::Column && !f.expandable));

            // The server's own type names…
            let field = |name: &str| -> String {
                fields
                    .iter()
                    .find(|f| f.label == name)
                    .and_then(|f| f.sub_label.clone())
                    .unwrap_or_default()
            };
            assert_eq!(field("_id"), "objectId");
            assert_eq!(field("duration"), "decimal");
            assert_eq!(field("at"), "date");
            // …and the absent-vs-present distinction, which a TREE sub-label can carry even though
            // a result cell cannot: `tempo` is missing from document 6 and `seq` is only in document 1.
            assert_eq!(field("tempo"), "double · in 5/6 sampled");
            assert_eq!(field("seq"), "long · in 1/6 sampled");
            // `payload` is a document in five of six and a real null in the sixth, so both BSON
            // types are reported rather than one of them being guessed away.
            assert_eq!(field("payload"), "object | null");

            // A collection that no longer exists yields no fields rather than an error: a stale
            // tree node is not something the user can act on.
            let gone = session
                .children(&DbNodeRef::Table {
                    database: "maestro".into(),
                    schema: None,
                    name: "no_such_collection_9399".into(),
                })
                .await
                .expect("an empty level, not an error");
            assert!(gone.is_empty(), "{gone:#?}");

            session.close().await;
        });
    }

    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn it_hands_out_no_cancel_handle_because_it_has_no_server_side_cancel() {
        // Dropping the cursor is not a cancel, and a real `killOp` needs `currentOp`
        // privileges. A Stop button that silently does nothing is worse than one that says so.
        //
        // 🔴 The refusal is STRUCTURAL — `cancel_handle()` returns `None`
        // rather than every call returning a runtime error. That lets `db_cancel` say so
        // without a round trip, and it keeps "cannot" distinct from "tried and failed".
        rt().block_on(async {
            let session = open(true).await;
            assert!(
                session.cancel_handle().is_none(),
                "an engine with no server-side cancel must hand out no handle"
            );
            session.close().await;
        });
    }

    /* ─────────────── the URL override and the password typed beside it ─────────────── */

    /// 🔴 **The dropped-password bug, end to end against a real MongoDB.**
    ///
    /// The configuration was `Connection type: URL only` with
    /// `postgresql://gazelle@localhost:5433/orders` — a string our own importer had *stripped*
    /// the password out of, leaving no `{{VAR}}` behind — plus the password typed into the field
    /// the dialog points at. Every engine but ClickHouse read "a URL is present" as "ignore the
    /// password field", so the app dialled with **no password**. Nothing covered that pairing, which
    /// is exactly why it shipped.
    ///
    /// Three claims, and the second is what makes the first mean anything:
    ///
    /// 1. a URL carrying **no** credential plus a typed password connects and returns a row;
    /// 2. the same URL with the typed password **wrong** fails as `auth` — without this the test
    ///    would pass against a server that accepts anything, which is not hypothetical here
    ///    (the stock `pg_hba.conf` trusts loopback, which is why every password assertion in
    ///    this file arrives on the host-mapped port over the Docker bridge);
    /// 3. a URL that **does** carry a password keeps its own, proved by making the typed one wrong
    ///    and the connection succeeding anyway.
    ///
    /// ⚠️ `authSource=admin` is written into the URI rather than left to the `options` map: the
    /// URL branch hands the *string* to the driver, so a setting that is not in the string is not in
    /// the credential. That is the pre-existing shape of this engine and it is not what was fixed
    /// here — noted so the URI below does not read as superstition.
    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn a_uri_with_no_password_uses_the_one_typed_beside_it_and_a_uri_with_one_keeps_its_own() {
        const WRONG: &str = "definitely-not-the-password";
        let bare = format!("mongodb://{USER}@{HOST}:{PORT}/{DATABASE}?authSource=admin");
        let with_password =
            format!("mongodb://{USER}:{PASSWORD}@{HOST}:{PORT}/{DATABASE}?authSource=admin");

        let dial = |url: String, password: &'static str| async move {
            let mut cfg = config(true, password);
            cfg.host = "mongo.invalid".to_string();
            cfg.port = Some(9);
            cfg.url = Some(url);
            let mut session = engine_for(DbEngineId::Mongodb)
                .expect("mongodb is wired")
                .open(&cfg)
                .await?;
            let out = session
                .run(
                    &Script {
                        // A seeded document this test does not write, addressed by its own id —
                        // never an aggregate over a fixture other tests are mutating.
                        text: format!(
                            r#"{{"find": "tracks", "filter": {{"_id": {{"$oid": "{DOC2}"}}}}}}"#
                        ),
                        mode: DbRunMode::Statement,
                    },
                    &limits(500),
                )
                .await;
            session.close().await;
            out
        };

        let sets = rt()
            .block_on(dial(bare.clone(), PASSWORD))
            .unwrap_or_else(|e| {
                panic!(
                    "a URI with no password plus a typed one must connect: {} ({})",
                    e.message,
                    e.code.as_str()
                )
            });
        assert_eq!(sets[0].rows.len(), 1, "the seeded document by id");

        let err = rt()
            .block_on(dial(bare, WRONG))
            .expect_err("a wrong typed password must not connect");
        assert_eq!(
            err.code,
            agent_studio_scaffold_lib::db::error::DbErrorCode::Auth,
            "expected an auth failure, got {}: {}",
            err.code.as_str(),
            err.message
        );
        assert!(!err.message.contains(WRONG), "{}", err.message);

        let sets = rt()
            .block_on(dial(with_password, WRONG))
            .unwrap_or_else(|e| {
                panic!(
                    "the URI's own password must win over the field: {} ({})",
                    e.message,
                    e.code.as_str()
                )
            });
        assert_eq!(sets[0].rows.len(), 1);
    }

    /// 🔴 **A connection that opens but returns nothing.**
    ///
    /// The quietest bug in this feature so far, and MongoDB is where it did the most damage.
    /// `MongoSession.database` was `cfg.database` — the *form field* — while the connection had been
    /// made from the URI. Under `Connection type: URL only` that field is empty, and
    /// `command_database()` falls back to **`admin`**, which exists and answers. So the connection
    /// opened, the probe passed, the command succeeded, and `{"find": "tracks"}` returned **zero
    /// documents and no error**: an empty grid with nothing anywhere saying why.
    ///
    /// That is why this asserts on a **row that must be there**. An assertion that the call merely
    /// succeeded is exactly the assertion that passed all along.
    ///
    /// The negative control is the second half: pointed at a database that really has no `tracks`,
    /// the same query must come back empty — otherwise this test would pass on an engine that
    /// ignored the database entirely and searched everything.
    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn a_uri_that_names_the_database_queries_that_database_and_not_admin() {
        let find = format!(r#"{{"find": "tracks", "filter": {{"_id": {{"$oid": "{DOC2}"}}}}}}"#);

        let query = |url: String, database: &'static str| {
            let find = find.clone();
            async move {
                let mut cfg = config(true, PASSWORD);
                // The FIELD is emptied — the "URL only" shape. Before the fix this is what
                // sent every command to `admin`.
                cfg.database = database.to_string();
                cfg.host = "mongo.invalid".to_string();
                cfg.port = Some(9);
                cfg.url = Some(url);
                let mut session = engine_for(DbEngineId::Mongodb)
                    .expect("mongodb is wired")
                    .open(&cfg)
                    .await?;
                let out = session
                    .run(
                        &Script {
                            text: find,
                            mode: DbRunMode::Statement,
                        },
                        &limits(500),
                    )
                    .await;
                session.close().await;
                out
            }
        };

        // The URI names the database, the field says nothing.
        let sets = rt()
            .block_on(query(
                format!("mongodb://{USER}:{PASSWORD}@{HOST}:{PORT}/{DATABASE}?authSource=admin"),
                "",
            ))
            .unwrap_or_else(|e| panic!("the seeded document must come back: {}", e.message));
        assert_eq!(
            sets[0].rows.len(),
            1,
            "the URI's database was ignored — this is the empty grid the fix removed"
        );

        // The negative control: a URI naming a database with no `tracks` really is empty, so the
        // assertion above is about WHICH database was queried and not merely that one was.
        let sets = rt()
            .block_on(query(
                format!("mongodb://{USER}:{PASSWORD}@{HOST}:{PORT}/admin?authSource=admin"),
                "",
            ))
            .expect("admin answers, it just has no `tracks`");
        assert!(
            sets[0].rows.is_empty(),
            "`admin` has no tracks collection, so this must be empty: {:?}",
            sets[0].rows
        );
    }
}

/// **An empty port field, proven against real servers — plus the honest limits of that proof**
/// (for `DbConnection::port: Option<u16>` and `DbConnection::srv`).
///
/// ## Why there is a loopback forwarder in here
///
/// The whole point of the change is that a record with **no port** dials the engine's standard port
/// (5432 / 3306). The fixture is deliberately published on 55432 / 53306 — non-default *precisely*
/// so it cannot be mistaken for a developer's own database (`docker/db-fixtures/compose.yaml` says
/// so: a development machine commonly already has something on 5432 and 3306). So
/// there is nothing listening on the port a no-port record dials, and the only way to *prove* the
/// behaviour rather than assert it is to put a byte pump on the standard port and let the driver
/// find it there.
///
/// That is a real proof, not a stand-in: the record round-trips through a real file, `db::open`
/// resolves the password out of the Vault, the sqlx driver picks the port itself, a real TCP
/// connection is made **to 5432**, and a real server answers a real query. The forwarder copies
/// bytes and knows nothing about the protocol — if the driver dialled any other port, the pump would
/// never see a connection and the test would fail to open.
///
/// ## When 5432 / 3306 are already taken, this test SKIPS — loudly
///
/// A developer with their own PostgreSQL on 5432 cannot lend it to us, and `npm run verify` treats
/// this file as a **blocking** tier. Failing there would make the gate red for a reason that has
/// nothing to do with the code — a permanently-red gate gets waved through, and an untested engine
/// must never block the tier. So an `AddrInUse` prints a named
/// SKIPPED line and returns. The port-resolution logic itself is pinned **hermetically and
/// unconditionally** by `engine.rs`'s `an_empty_port_field_dials_the_engines_standard_port`, so a
/// skip here loses the end-to-end evidence and none of the coverage.
///
/// ## What is NOT in this module, deliberately
///
/// **No test dials MongoDB Atlas.** `mongodb+srv://` is how Atlas is reached and the fix that makes
/// it representable is real, but there is no Atlas cluster in this fixture and this tier must not
/// depend on a third party's DNS or uptime. The SRV evidence is therefore hermetic and stops where
/// the honesty does — see `db::mongo`'s module doc for the table of what is and is not proven.
mod db_live_port_and_srv {
    use super::*;
    use tokio::net::{TcpListener, TcpStream};

    const HOST: &str = "127.0.0.1";
    /// TEST FIXTURE ONLY — published in this repo, bound to localhost.
    const PASSWORD: &str = "agentstudio-test-pw";
    const USER: &str = "agentstudio";
    const DATABASE: &str = "maestro";

    /// PostgreSQL's standard port (what an empty port field must dial) → the fixture's published one.
    const PG_STANDARD: u16 = 5432;
    const PG_FIXTURE: u16 = 55432;
    /// MySQL's, likewise.
    const MYSQL_STANDARD: u16 = 3306;
    const MYSQL_FIXTURE: u16 = 53306;

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Runtime::new().expect("a tokio runtime")
    }

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "agentstudio-db-live-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    /// Bind `listen` and pump every connection to `to`, until the returned handle is dropped.
    ///
    /// `Ok(None)` means the port is already in use — see the module doc for why that is a skip and
    /// not a failure. Everything else is a real error and panics.
    async fn forward(listen: u16, to: u16) -> Option<tokio::task::JoinHandle<()>> {
        let listener = match TcpListener::bind((HOST, listen)).await {
            Ok(l) => l,
            Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => return None,
            Err(e) => panic!("could not bind {HOST}:{listen}: {e}"),
        };
        Some(tokio::spawn(async move {
            // A loop rather than one `accept`: a driver is free to open more than one socket, and a
            // pump that served exactly one would turn that into a hang instead of a result.
            while let Ok((mut inbound, _)) = listener.accept().await {
                tokio::spawn(async move {
                    if let Ok(mut outbound) = TcpStream::connect((HOST, to)).await {
                        let _ = tokio::io::copy_bidirectional(&mut inbound, &mut outbound).await;
                    }
                });
            }
        }))
    }

    /// The two seeded rows every module here reads: `id 2` has `tag IS NULL`, `id 3` has `tag = ''`.
    /// Named rows, never a `count(*)` — this tier shares one mutable fixture.
    fn expected_rows() -> Vec<Vec<Option<String>>> {
        vec![
            vec![Some("Bluewater".to_string()), None],
            vec![Some("Cinderglass".to_string()), Some(String::new())],
        ]
    }

    const SEED_QUERY: &str = "SELECT title, tag FROM tracks WHERE id IN (2, 3) ORDER BY id";

    /// Save a draft with **no port**, open it by id, and read real rows back.
    ///
    /// Everything after the draft is the production path: `upsert` → the file on disk → `open`
    /// (which resolves the Vault reference itself) → `query`. The only thing the test supplies is a
    /// listener on the standard port.
    fn no_port_connects(tag: &str, engine: &str, standard: u16, fixture: u16, ssl_mode: &str) {
        let dir = temp_dir(tag);
        let paths = agent_studio_scaffold_lib::db::Paths::in_dir(&dir);

        // NOTE the absent `port` key — this is the dialog's empty port box, and in the previous
        // shape this draft could not be expressed at all (`port` was a required `u16`).
        let draft: agent_studio_scaffold_lib::db::model::DbConnectionInput =
            serde_json::from_str(&format!(
                r#"{{"name":"No Port {engine}","engine":"{engine}","host":"{HOST}",
                    "database":"{DATABASE}","user":"{USER}","passwordRef":"",
                    "savePassword":"forever","sslMode":"{ssl_mode}","options":{{}},
                    "readOnly":true,"rowLimit":500,"timeoutMs":30000}}"#
            ))
            .expect("a draft with no port must deserialise");

        let saved = agent_studio_scaffold_lib::db::upsert(&paths, draft, Some(PASSWORD))
            .unwrap_or_else(|e| panic!("upsert refused an empty port: {}", e.message));
        assert_eq!(saved.port, None, "a port was invented on the way to disk");
        let text = std::fs::read_to_string(&paths.store).expect("the store was written");
        assert!(
            text.contains("\"port\": null"),
            "the record must carry no port: {text}"
        );

        let sets = rt().block_on(async {
            let Some(pump) = forward(standard, fixture).await else {
                eprintln!(
                    "SKIPPED {tag}: {HOST}:{standard} is already in use, so the standard-port dial \
                     cannot be observed on this machine. The port resolution itself is pinned \
                     hermetically by engine.rs::an_empty_port_field_dials_the_engines_standard_port."
                );
                return None;
            };
            let opened = agent_studio_scaffold_lib::db::open(&paths, &saved.id, None)
                .await
                .unwrap_or_else(|e| {
                    panic!(
                        "open failed — an empty port did not dial {standard}: {} ({})",
                        e.message,
                        e.code.as_str()
                    )
                });
            let session_id = opened.session_id;
            let sets = agent_studio_scaffold_lib::db::query(
                &session_id,
                SEED_QUERY.to_string(),
                DbRunMode::Statement,
                None,
            )
            .await
            .unwrap_or_else(|e| panic!("query failed: {}", e.message));
            agent_studio_scaffold_lib::db::db_close(session_id).await;
            pump.abort();
            Some(sets)
        });

        if let Some(sets) = sets {
            assert_eq!(sets.len(), 1);
            assert_eq!(
                sets[0].rows,
                expected_rows(),
                "the rows must come from the real server, through the standard port"
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 🔴 PostgreSQL: a saved connection with an **empty port** reaches a real server on 5432.
    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn a_connection_with_no_port_connects_to_postgres_on_5432_and_returns_rows() {
        no_port_connects("noport-pg", "postgres", PG_STANDARD, PG_FIXTURE, "prefer");
    }

    /// 🔴 MySQL: the same claim against the second driver. Two engines because a default that is
    /// right on one and wrong on the other is a coin toss, not a rule (a second implementation is
    /// the cheapest audit of the first).
    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn a_connection_with_no_port_connects_to_mysql_on_3306_and_returns_rows() {
        no_port_connects(
            "noport-mysql",
            "mysql",
            MYSQL_STANDARD,
            MYSQL_FIXTURE,
            "prefer",
        );
    }

    /// 🔴 **A record written by the previous build still works.** Not "still parses" — *connects*.
    ///
    /// The port went from `u16` to `Option<u16>` and `srv` did not exist, so every connection
    /// already on a user's disk is in the old shape. The file below is written by hand, key for key,
    /// as the old serialiser would have produced it: a bare number for `port` and no `srv` at all. A
    /// fixture generated by today's code could not express the old shape, which is the point.
    ///
    /// If `#[serde(default)]` were missing on either new field, `store::load` would fall back to an
    /// empty store — and the user's connection list would be silently gone. That failure arrives as
    /// silence, so it gets a test that ends in real rows.
    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn a_record_in_the_previous_shape_still_loads_and_queries() {
        let dir = temp_dir("old-shape");
        let paths = agent_studio_scaffold_lib::db::Paths::in_dir(&dir);

        // The Vault entry the old record's `{{VAR}}` points at. Created through the ordinary save
        // path — `api_store::save` is `pub(crate)` and this is a separate crate, which is the right
        // way round: the Vault file is written by the real writer, and the reference name comes back
        // from `upsert` instead of being a guess about how names are minted.
        let seed: agent_studio_scaffold_lib::db::model::DbConnectionInput =
            serde_json::from_str(&format!(
                r#"{{"name":"Old Fixture","engine":"postgres","host":"{HOST}","port":{PG_FIXTURE},
                    "database":"{DATABASE}","user":"{USER}","passwordRef":"",
                    "savePassword":"forever","sslMode":"prefer","options":{{}},
                    "readOnly":true,"rowLimit":500,"timeoutMs":30000}}"#
            ))
            .expect("draft");
        let reference = agent_studio_scaffold_lib::db::upsert(&paths, seed, Some(PASSWORD))
            .expect("seed the vault")
            .password_ref;
        assert!(
            reference.starts_with("{{"),
            "expected a reference: {reference}"
        );

        // …and now the connection file is REPLACED with the previous shape, so what `open`
        // reads below is a file today's serialiser cannot produce.
        std::fs::write(
            &paths.store,
            format!(
                r#"{{"connections":[{{"id":"01JOLDRECORD","name":"Old Fixture",
                "engine":"postgres","family":"postgres","host":"{HOST}","port":{PG_FIXTURE},
                "database":"{DATABASE}","user":"{USER}",
                "passwordRef":"{reference}","savePassword":"forever",
                "url":null,"sslMode":"prefer","caSummary":null,"options":{{}},
                "readOnly":true,"rowLimit":500,"timeoutMs":30000,
                "allowMultiStatement":false,"createdAt":7,"updatedAt":8}}],"version":1}}"#
            ),
        )
        .expect("write the old-shape store");

        let loaded = agent_studio_scaffold_lib::db::store::load(&paths.store);
        assert_eq!(
            loaded.connections.len(),
            1,
            "the old file loaded as an EMPTY store — every saved connection would have vanished"
        );
        assert_eq!(
            loaded.connections[0].port,
            Some(PG_FIXTURE),
            "the number in the old file must still be the port"
        );
        assert!(
            !loaded.connections[0].srv,
            "an absent `srv` is the ordinary single-host form, not unknown"
        );

        let sets = rt().block_on(async {
            let opened = agent_studio_scaffold_lib::db::open(&paths, "01JOLDRECORD", None)
                .await
                .unwrap_or_else(|e| {
                    panic!(
                        "an existing record no longer connects: {} ({})",
                        e.message,
                        e.code.as_str()
                    )
                });
            let session_id = opened.session_id;
            let sets = agent_studio_scaffold_lib::db::query(
                &session_id,
                SEED_QUERY.to_string(),
                DbRunMode::Statement,
                None,
            )
            .await
            .unwrap_or_else(|e| panic!("query failed: {}", e.message));
            agent_studio_scaffold_lib::db::db_close(session_id).await;
            sets
        });
        assert_eq!(sets.len(), 1);
        assert_eq!(sets[0].rows, expected_rows());

        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// **Redis, against the real 8.2.1 in `docker/db-fixtures`, through `redis-rs`.**
///
/// The fixture publishes no TLS listener, so these run with `SslMode::Disable` — nothing here
/// claims Redis-over-TLS was proven. `redis.rs`'s unit tests exercise which `ConnectionAddr` each
/// SSL mode asks for; a `rediss://` handshake is not proven anywhere and is stated as such.
///
/// Probe keys live under the **`probe:9400:`** prefix (every other engine's probe ids are numeric
/// row ids, and a prefix is Redis's equivalent of owning your own rows).
///
/// 🔴 **Unlike Mongo's, this fixture's healthcheck does NOT count keys** — it tests one marker key
/// (`EXISTS fixture:seeded`), so creating a key here cannot take the tier down. The
/// read-write probe still deletes what it writes, because the next run reads the same database.
mod db_live_redis {
    use super::*;
    use agent_studio_scaffold_lib::db::tree::{DbGroup, DbNodeKind, DbNodeRef};

    const HOST: &str = "127.0.0.1";
    const PORT: u16 = 56379;
    /// TEST FIXTURE ONLY — published in this repo, bound to localhost.
    const PASSWORD: &str = "agentstudio-test-pw";
    /// The write probe's key. Deleted by the test that creates it.
    const PROBE_KEY: &str = "probe:9400:write";

    pub(super) fn config(read_only: bool, password: &str) -> ResolvedConfig {
        ResolvedConfig {
            engine: DbEngineId::Redis,
            family: DbFamily::Redis,
            host: HOST.to_string(),
            port: Some(PORT),
            srv: false,
            // Redis names databases by number; the fixture seeds db 0.
            database: String::new(),
            // `requirepass` only, so there is no ACL username — the pre-6 shape, which is exactly
            // the case `connection_info` must not send an empty username for.
            user: String::new(),
            password: password.to_string(),
            ssl_mode: SslMode::Disable,
            ca_pem: None,
            options: std::collections::BTreeMap::new(),
            url: None,
            read_only,
            row_limit: 500,
            timeout_ms: 30_000,
            allow_multi_statement: false,
        }
    }

    fn limits(row_limit: u32) -> Limits {
        Limits {
            row_limit,
            timeout_ms: 30_000,
            allow_multi_statement: false,
        }
    }

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Runtime::new().expect("a tokio runtime")
    }

    async fn open(read_only: bool) -> Box<dyn agent_studio_scaffold_lib::db::engine::DbSession> {
        engine_for(DbEngineId::Redis)
            .expect("redis is wired")
            .open(&config(read_only, PASSWORD))
            .await
            .unwrap_or_else(|e| {
                panic!(
                    "could not open {HOST}:{PORT} — is `npm run db:fixtures:up` running? {}",
                    e.message
                )
            })
    }

    async fn run(read_only: bool, command: &str) -> Vec<DbResultSet> {
        let mut session = open(read_only).await;
        let out = session
            .run(
                &Script {
                    text: command.to_string(),
                    mode: DbRunMode::Statement,
                },
                &limits(500),
            )
            .await;
        session.close().await;
        out.unwrap_or_else(|e| panic!("run failed: {} ({})", e.message, e.code.as_str()))
    }

    async fn try_run(
        read_only: bool,
        command: &str,
    ) -> Result<Vec<DbResultSet>, agent_studio_scaffold_lib::db::error::DbError> {
        let mut session = open(read_only).await;
        let out = session
            .run(
                &Script {
                    text: command.to_string(),
                    mode: DbRunMode::Statement,
                },
                &limits(500),
            )
            .await;
        session.close().await;
        out
    }

    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn a_real_get_returns_the_seeded_value() {
        let sets = rt().block_on(run(true, "GET fixture:string"));
        assert_eq!(sets.len(), 1);
        assert_eq!(sets[0].kind, DbResultKind::Rows);
        assert_eq!(sets[0].rows, vec![vec![Some("hello".to_string())]]);
    }

    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn probe_reports_the_real_server_version() {
        let info = rt().block_on(async {
            let mut s = open(true).await;
            let info = s.probe().await.expect("probe");
            s.close().await;
            info
        });
        assert!(
            info.version.starts_with("Redis 8."),
            "unexpected version string: {}",
            info.version
        );
        // Redis has no per-session id a cancel could act on, and inventing one would make `cancel`
        // look implementable.
        assert!(info.backend_pid.is_none());
    }

    /// 🔴 An absent key and a key holding `""` are DIFFERENT answers, against the real
    /// server rather than against a synthesised `Value`.
    ///
    /// The fixture seeds `fixture:empty` as the empty string and deliberately never creates
    /// `fixture:absent`, so this is the one assertion that proves the whole `Option<String>` cell
    /// model survives a real RESP round trip in the engine where it is easiest to lose.
    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn an_absent_key_and_an_empty_value_are_not_the_same_answer() {
        let absent = rt().block_on(run(true, "GET fixture:absent"));
        assert_eq!(absent[0].rows, vec![vec![None]], "an absent key is NULL");

        let empty = rt().block_on(run(true, "GET fixture:empty"));
        assert_eq!(
            empty[0].rows,
            vec![vec![Some(String::new())]],
            "a key holding the empty string is not NULL"
        );
    }

    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn a_non_utf8_value_comes_back_as_hex_rather_than_replacement_characters() {
        // The seed stores `\x00\xff\x10`. A Redis value is a byte string, so a console that
        // rendered it as U+FFFD would silently corrupt the data it was asked to show.
        let sets = rt().block_on(run(true, "GET fixture:binary"));
        assert_eq!(sets[0].rows, vec![vec![Some("\\x00ff10".to_string())]]);
    }

    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn a_quoted_key_with_spaces_reaches_the_server_whole() {
        // The tokeniser's reason to exist, proven end to end: the seed's key really does contain a
        // space and a colon, and only correct quoting can read it.
        let sets = rt().block_on(run(true, r#"GET "fixture:key with spaces""#));
        assert_eq!(sets[0].rows, vec![vec![Some("ok".to_string())]]);
    }

    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn every_seeded_type_comes_back_as_rows() {
        // One command per RESP type the seed creates, so "results are tabular" is measured against
        // the engine that most stresses it rather than assumed.
        let cases: &[(&str, usize)] = &[
            ("HGETALL fixture:hash", 6), // RESP2 flattens a hash to field, value, field, value…
            ("LRANGE fixture:list 0 -1", 3),
            ("SMEMBERS fixture:set", 3),
            ("ZRANGE fixture:zset 0 -1", 3),
            ("TYPE fixture:hash", 1),
        ];
        for (command, want_rows) in cases {
            let sets = rt().block_on(run(true, command));
            assert_eq!(sets[0].kind, DbResultKind::Rows, "{command}");
            assert_eq!(sets[0].rows.len(), *want_rows, "{command}");
        }
    }

    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn a_stream_reply_is_nested_and_the_notice_says_so_rather_than_dropping_it() {
        // `XRANGE` is the shape `DbResultSet` genuinely cannot hold (entry → [id, [field, value]]),
        // so the loss is reported in the output, and nothing is dropped.
        let sets = rt().block_on(run(true, "XRANGE fixture:stream - +"));
        assert_eq!(sets[0].rows.len(), 1);
        let cell = sets[0].rows[0][0].as_deref().unwrap_or_default();
        assert!(cell.contains("event") && cell.contains("play"), "{cell}");
        assert!(cell.contains("Amberline"), "{cell}");
        assert!(
            sets[0]
                .notice
                .as_deref()
                .unwrap_or_default()
                .contains("nested"),
            "{:?}",
            sets[0].notice
        );
    }

    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn the_row_cap_is_measured_against_the_five_thousand_seeded_keys() {
        let sets = rt().block_on(async {
            let mut s = open(true).await;
            let out = s
                .run(
                    &Script {
                        text: "SCAN 0 COUNT 1000".to_string(),
                        mode: DbRunMode::Statement,
                    },
                    &limits(3),
                )
                .await
                .expect("scan");
            s.close().await;
            out
        });
        // `SCAN` returns [cursor, [keys…]] — nested, so it renders as two rows (cursor, key list)
        // under a cap of 3. The point of the assertion is that the cap is honoured at all.
        assert!(sets[0].rows.len() <= 3, "{} rows", sets[0].rows.len());
    }

    /// 🔴 The read-only allowlist, with the read-WRITE control beside it.
    ///
    /// A refusal test alone cannot tell "our guard stopped it" from "that command never works
    /// here" — so the same `SET` is run on a read-write session and must land, then be cleaned up.
    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn read_only_refuses_a_write_and_the_read_write_session_performs_it() {
        let refused = rt()
            .block_on(try_run(true, &format!("SET {PROBE_KEY} 1")))
            .map(|_| ())
            .expect_err("a read-only session must refuse SET");
        assert_eq!(
            refused.code,
            agent_studio_scaffold_lib::db::error::DbErrorCode::Blocked
        );
        assert!(refused.message.contains("SET"), "{}", refused.message);

        // The control: the same command, on a read-write session, really writes.
        let wrote = rt().block_on(run(false, &format!("SET {PROBE_KEY} 1")));
        assert_eq!(wrote[0].kind, DbResultKind::Message);
        assert_eq!(wrote[0].notice.as_deref(), Some("OK"));
        let read_back = rt().block_on(run(true, &format!("GET {PROBE_KEY}")));
        assert_eq!(read_back[0].rows, vec![vec![Some("1".to_string())]]);

        // Cleanup, so the fixture stays reusable without a reset.
        rt().block_on(run(false, &format!("DEL {PROBE_KEY}")));
        let gone = rt().block_on(run(true, &format!("GET {PROBE_KEY}")));
        assert_eq!(gone[0].rows, vec![vec![None]]);
    }

    /// 🔴 `KEYS` is refused on a **read-write** session too, against the real server.
    ///
    /// The rule is about blocking a single-threaded server, not about writes, so testing it only in
    /// read-only mode would miss the half that matters on a production database — and `KEYS` is on
    /// the read-only allowlist precisely so this test has something to prove.
    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn keys_is_refused_even_on_a_read_write_session() {
        for read_only in [true, false] {
            // `expect_err`, not `unwrap_or_else`: an earlier version of this test panicked on the
            // Err arm — i.e. on the correct refusal — an inverted-combinator bug that is easy to
            // write. A test that passes only when the guard FAILS is worse than no test.
            let err = rt()
                .block_on(try_run(read_only, "KEYS *"))
                .map(|_| ())
                .expect_err("KEYS must be refused in BOTH modes");
            assert_eq!(
                err.code,
                agent_studio_scaffold_lib::db::error::DbErrorCode::Blocked,
                "KEYS with read_only={read_only}"
            );
            assert!(err.message.contains("SCAN"), "{}", err.message);
        }
    }

    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn a_wrong_type_command_is_a_result_carrying_the_servers_own_words() {
        // `WRONGTYPE` is an answer about the statement, not a broken connection — the same rule as
        // a SQL syntax error, and the misattribution fix applied to a third engine.
        let sets = rt().block_on(run(true, "LRANGE fixture:hash 0 -1"));
        assert_eq!(sets[0].kind, DbResultKind::Message);
        let notice = sets[0].notice.as_deref().unwrap_or_default();
        assert!(notice.contains("WRONGTYPE"), "{notice}");
        // The session survived it: the next command still works on a fresh session.
        let ok = rt().block_on(run(true, "GET fixture:string"));
        assert_eq!(ok[0].rows, vec![vec![Some("hello".to_string())]]);
    }

    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn a_wrong_password_is_an_auth_failure_that_never_echoes_it() {
        let err = rt()
            .block_on(async {
                engine_for(DbEngineId::Redis)
                    .expect("redis is wired")
                    .open(&config(true, "definitely-not-the-password"))
                    .await
                    .map(|_| ())
            })
            .expect_err("a wrong password must not connect");
        assert_eq!(
            err.code,
            agent_studio_scaffold_lib::db::error::DbErrorCode::Auth
        );
        assert!(
            !err.message.contains("definitely-not-the-password"),
            "the password must never appear in an error: {}",
            err.message
        );
    }

    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn open_really_dials_so_a_bad_port_fails_at_connect_time() {
        // Without the `INFO` round trip in `open`, a multiplexed connection is lazy and Test
        // Connection would report success for a port nothing listens on.
        let mut cfg = config(true, PASSWORD);
        cfg.port = Some(1);
        cfg.timeout_ms = 3_000;
        let err = rt()
            .block_on(async {
                engine_for(DbEngineId::Redis)
                    .expect("redis is wired")
                    .open(&cfg)
                    .await
                    .map(|_| ())
            })
            .expect_err("nothing listens on port 1");
        assert!(
            matches!(
                err.code,
                agent_studio_scaffold_lib::db::error::DbErrorCode::Network
                    | agent_studio_scaffold_lib::db::error::DbErrorCode::Timeout
            ),
            "{:?}: {}",
            err.code,
            err.message
        );
    }

    /// The tree, walked root → db0 → **Keys** → keys, against 5000+ seeded keys.
    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn the_tree_walks_root_to_the_connected_database_to_its_keys() {
        rt().block_on(async {
            let mut session = open(true).await;

            let root = session.children(&DbNodeRef::Root).await.expect("root");
            assert_eq!(
                root.len(),
                1,
                "a Redis connection sees ONE database: its own"
            );
            assert_eq!(root[0].label, "db0");
            assert_eq!(root[0].kind, DbNodeKind::Database);

            let groups = session
                .children(&DbNodeRef::Database {
                    name: "db0".to_string(),
                })
                .await
                .expect("groups");
            assert_eq!(groups.len(), 1);
            assert_eq!(groups[0].label, DbGroup::Keys.label());
            // `DBSIZE` counts the seed's 5000 `k:*` keys plus the typed fixtures and the marker.
            let sub = groups[0].sub_label.clone().unwrap_or_default();
            assert!(sub.ends_with(" keys"), "{sub}");

            let keys = session
                .children(&DbNodeRef::Group {
                    database: "db0".to_string(),
                    schema: None,
                    group: DbGroup::Keys,
                })
                .await
                .expect("keys");
            // Bounded by KEY_PAGE, not by the keyspace: 5000+ keys must not arrive in one reply.
            assert_eq!(
                keys.len(),
                500,
                "one page, so a real keyspace cannot flood the rail"
            );
            assert!(keys.iter().all(|k| k.kind == DbNodeKind::Key));
            // Every key carries the server's own TYPE, pipelined in one round trip.
            assert!(
                keys.iter().all(|k| k.sub_label.is_some()),
                "a key node without a type sub-label means the TYPE pipeline was skipped"
            );
            assert!(keys.iter().all(|k| !k.expandable), "a key is a leaf");

            session.close().await;
        });
    }

    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn it_hands_out_no_cancel_handle_because_it_has_no_server_side_cancel() {
        // 🔴 The refusal is STRUCTURAL — `cancel_handle()` returns `None`
        // rather than every call returning a runtime error. `db_cancel` then refuses
        // without a round trip, and "cannot" stays distinct from "tried and failed".
        rt().block_on(async {
            let session = open(true).await;
            assert!(
                session.cancel_handle().is_none(),
                "an engine with no server-side cancel must hand out no handle"
            );
            session.close().await;
        });
    }

    /* ─────────────── the URL override and the password typed beside it ─────────────── */

    /// 🔴 **The dropped-password bug, end to end against a real Redis.**
    ///
    /// The configuration was `Connection type: URL only` with
    /// `postgresql://gazelle@localhost:5433/orders` — a string our own importer had *stripped*
    /// the password out of, leaving no `{{VAR}}` behind — plus the password typed into the field
    /// the dialog points at. Every engine but ClickHouse read "a URL is present" as "ignore the
    /// password field", so the app dialled with **no password**. Nothing covered that pairing, which
    /// is exactly why it shipped.
    ///
    /// Three claims, and the second is what makes the first mean anything:
    ///
    /// 1. a URL carrying **no** credential plus a typed password connects and returns a row;
    /// 2. the same URL with the typed password **wrong** fails as `auth` — without this the test
    ///    would pass against a server that accepts anything, which is not hypothetical here
    ///    (the stock `pg_hba.conf` trusts loopback, which is why every password assertion in
    ///    this file arrives on the host-mapped port over the Docker bridge);
    /// 3. a URL that **does** carry a password keeps its own, proved by making the typed one wrong
    ///    and the connection succeeding anyway.
    ///
    /// ⚠️ The fixture is a `requirepass` server with **no ACL user**, so the credential the string
    /// carries is `redis://:password@…` — an empty user position. That is the pre-6 shape and the
    /// one this engine must keep working, so it is what the precedence case uses.
    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn a_url_with_no_password_uses_the_one_typed_beside_it_and_a_url_with_one_keeps_its_own() {
        const WRONG: &str = "definitely-not-the-password";
        let bare = format!("redis://{HOST}:{PORT}/0");
        let with_password = format!("redis://:{PASSWORD}@{HOST}:{PORT}/0");

        let dial = |url: String, password: &'static str| async move {
            let mut cfg = config(true, password);
            cfg.host = "redis.invalid".to_string();
            cfg.port = Some(9);
            cfg.url = Some(url);
            let mut session = engine_for(DbEngineId::Redis)
                .expect("redis is wired")
                .open(&cfg)
                .await?;
            let out = session
                .run(
                    &Script {
                        text: "GET fixture:string".to_string(),
                        mode: DbRunMode::Statement,
                    },
                    &limits(500),
                )
                .await;
            session.close().await;
            out
        };

        let sets = rt()
            .block_on(dial(bare.clone(), PASSWORD))
            .unwrap_or_else(|e| {
                panic!(
                    "a URL with no password plus a typed one must connect: {} ({})",
                    e.message,
                    e.code.as_str()
                )
            });
        assert_eq!(sets[0].rows, vec![vec![Some("hello".to_string())]]);

        let err = rt()
            .block_on(dial(bare, WRONG))
            .expect_err("a wrong typed password must not connect");
        assert_eq!(
            err.code,
            agent_studio_scaffold_lib::db::error::DbErrorCode::Auth,
            "expected an auth failure, got {}: {}",
            err.code.as_str(),
            err.message
        );
        assert!(!err.message.contains(WRONG), "{}", err.message);

        let sets = rt()
            .block_on(dial(with_password, WRONG))
            .unwrap_or_else(|e| {
                panic!(
                    "the URL's own password must win over the field: {} ({})",
                    e.message,
                    e.code.as_str()
                )
            });
        assert_eq!(sets[0].rows, vec![vec![Some("hello".to_string())]]);
    }
}

/// **DynamoDB, against `amazon/dynamodb-local` in `docker/db-fixtures`, through our own SigV4.**
///
/// 🔴 **What these tests CANNOT prove, stated first because it decides how to read them.** DynamoDB
/// Local **does not verify signatures** — it accepts any credentials — so every test here would pass
/// with a completely broken signer. They prove the *request shape*, the PartiQL round trip, the
/// result shaping and the guardrails. The signing itself is pinned in `db/dynamodb.rs`'s unit tests
/// against **AWS's published SigV4 vectors**, and that split is deliberate (a positive result is
/// not evidence the mechanism under test is engaged).
///
/// Write probes go into the deliberately-empty `studios` table and delete what they write, so the
/// seeded `tracks` rows stay stable for the next run (own your own rows).
mod db_live_dynamodb {
    use super::*;

    const ENDPOINT: &str = "http://127.0.0.1:58000";
    const REGION: &str = "eu-west-1";
    /// DynamoDB Local ignores credentials entirely; these exist so the header is well-formed.
    const KEY_ID: &str = "fixture";
    /// TEST FIXTURE ONLY — and this one is not even checked by the server.
    const SECRET: &str = "fixture-secret-not-verified-by-dynamodb-local";

    fn config(read_only: bool) -> ResolvedConfig {
        let mut options = std::collections::BTreeMap::new();
        options.insert("region".to_string(), REGION.to_string());
        options.insert("endpoint".to_string(), ENDPOINT.to_string());
        ResolvedConfig {
            engine: DbEngineId::Dynamodb,
            family: DbFamily::Dynamodb,
            // A DynamoDB connection has no host: the endpoint override is an option, and the
            // region is what addresses the real service.
            host: String::new(),
            port: None,
            srv: false,
            database: String::new(),
            user: KEY_ID.to_string(),
            password: SECRET.to_string(),
            // The local endpoint is plain HTTP, which the override's scheme says outright.
            ssl_mode: SslMode::Disable,
            ca_pem: None,
            options,
            url: None,
            read_only,
            row_limit: 500,
            timeout_ms: 30_000,
            allow_multi_statement: false,
        }
    }

    fn limits(row_limit: u32) -> Limits {
        Limits {
            row_limit,
            timeout_ms: 30_000,
            allow_multi_statement: false,
        }
    }

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Runtime::new().expect("a tokio runtime")
    }

    async fn open(read_only: bool) -> Box<dyn agent_studio_scaffold_lib::db::engine::DbSession> {
        engine_for(DbEngineId::Dynamodb)
            .expect("dynamodb is wired")
            .open(&config(read_only))
            .await
            .unwrap_or_else(|e| {
                panic!(
                    "could not open {ENDPOINT} — is `npm run db:fixtures:up` running? {}",
                    e.message
                )
            })
    }

    async fn run(read_only: bool, statement: &str) -> Vec<DbResultSet> {
        let mut session = open(read_only).await;
        let out = session
            .run(
                &Script {
                    text: statement.to_string(),
                    mode: DbRunMode::Statement,
                },
                &limits(500),
            )
            .await;
        session.close().await;
        out.unwrap_or_else(|e| panic!("run failed: {} ({})", e.message, e.code.as_str()))
    }

    fn col(set: &DbResultSet, name: &str) -> usize {
        set.columns
            .iter()
            .position(|c| c.name == name)
            .unwrap_or_else(|| {
                panic!(
                    "no `{name}` column in {:?}",
                    set.columns.iter().map(|c| &c.name).collect::<Vec<_>>()
                )
            })
    }

    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn a_real_partiql_select_returns_the_seeded_items() {
        let sets = rt().block_on(run(true, r#"SELECT * FROM "tracks""#));
        assert_eq!(sets.len(), 1);
        assert_eq!(sets[0].kind, DbResultKind::Rows);
        assert_eq!(sets[0].rows.len(), 4, "the seed writes four items");
        // Every seeded item has a `title`, so the union must contain it.
        let title = col(&sets[0], "title");
        let mut titles: Vec<String> = sets[0]
            .rows
            .iter()
            .filter_map(|r| r[title].clone())
            .collect();
        titles.sort();
        assert_eq!(
            titles,
            vec!["Amberline", "Bluewater", "Cinderglass", "Driftwood"]
        );
    }

    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn probe_proves_the_credentials_are_accepted_and_names_the_endpoint() {
        let info = rt().block_on(async {
            let mut s = open(true).await;
            let info = s.probe().await.expect("probe");
            s.close().await;
            info
        });
        // No invented version number: DynamoDB is a managed service with none to report, and the
        // string says what a probe really established.
        assert!(info.version.starts_with("DynamoDB · "), "{}", info.version);
        assert!(info.version.contains(REGION), "{}", info.version);
        assert!(info.backend_pid.is_none());
    }

    /// 🔴 A 38-digit DynamoDB number survives EXACTLY, against the real server.
    ///
    /// The seed stores `12345678901234567890123456789012345678` — far beyond what an `f64` can
    /// represent. A client that parsed the wire value to re-render it would silently corrupt a
    /// decimal column, which is the same failure ClickHouse's decimal quoting exists to prevent.
    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn a_38_digit_number_round_trips_without_going_through_a_float() {
        let sets = rt().block_on(run(
            true,
            r#"SELECT duration FROM "tracks" WHERE title = 'Amberline' AND ts = 1"#,
        ));
        assert_eq!(sets[0].rows.len(), 1);
        assert_eq!(
            sets[0].rows[0][col(&sets[0], "duration")],
            Some("12345678901234567890123456789012345678".to_string())
        );
    }

    /// 🔴 All THREE states of an attribute, from a real reply: NULL, the empty string, and absent.
    ///
    /// The contract's cell has two states and the data has three, so the third is reported in the
    /// notice rather than collapsed silently. The seed was built to contain all three
    /// precisely so this cannot be hand-waved.
    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn null_empty_and_absent_are_three_different_things_and_the_notice_names_the_third() {
        let sets = rt().block_on(run(true, r#"SELECT title, tag FROM "tracks""#));
        let (title, tag) = (col(&sets[0], "title"), col(&sets[0], "tag"));
        let of = |name: &str| -> Option<String> {
            sets[0]
                .rows
                .iter()
                .find(|r| r[title].as_deref() == Some(name))
                .and_then(|r| r[tag].clone())
        };
        assert_eq!(
            of("Bluewater"),
            None,
            "an explicit NULL attribute is a NULL cell"
        );
        assert_eq!(
            of("Cinderglass"),
            Some(String::new()),
            "an empty string is NOT a null"
        );
        // Driftwood has no `tag` at all. It reads as NULL because the cell has nowhere else to go —
        // and that is exactly what the notice must say out loud.
        assert_eq!(of("Driftwood"), None);
        let notice = sets[0].notice.as_deref().unwrap_or_default();
        assert!(notice.contains("`tag`"), "{notice}");
        assert!(notice.contains("is NOT a null"), "{notice}");
    }

    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn a_set_and_a_map_come_back_as_json_cells() {
        let sets = rt().block_on(run(
            true,
            r#"SELECT tags, meta FROM "tracks" WHERE title = 'Amberline' AND ts = 1"#,
        ));
        let tags = sets[0].rows[0][col(&sets[0], "tags")]
            .clone()
            .unwrap_or_default();
        assert!(tags.contains('a') && tags.contains('b'), "{tags}");
        let meta = sets[0].rows[0][col(&sets[0], "meta")]
            .clone()
            .unwrap_or_default();
        assert!(meta.contains("gain"), "{meta}");
    }

    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn the_row_cap_is_measured_rather_than_inferred() {
        let sets = rt().block_on(async {
            let mut s = open(true).await;
            let out = s
                .run(
                    &Script {
                        text: r#"SELECT * FROM "tracks""#.to_string(),
                        mode: DbRunMode::Statement,
                    },
                    &limits(2),
                )
                .await
                .expect("select");
            s.close().await;
            out
        });
        assert_eq!(sets[0].rows.len(), 2);
        assert!(sets[0].truncated, "4 items under a cap of 2 is truncated");
    }

    /// 🔴 The read-only filter, with the read-WRITE control beside it.
    ///
    /// Without the control, "the INSERT was refused" cannot be told apart from "an INSERT never
    /// works here". The write goes into the deliberately-empty `studios` table and is deleted again.
    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn read_only_refuses_a_write_and_the_read_write_session_performs_it() {
        let insert = r#"INSERT INTO "studios" VALUE {'name': 'probe-9500'}"#;

        let refused = rt().block_on(async {
            let mut s = open(true).await;
            let out = s
                .run(
                    &Script {
                        text: insert.to_string(),
                        mode: DbRunMode::Statement,
                    },
                    &limits(500),
                )
                .await;
            s.close().await;
            out.map(|_| ())
                .expect_err("a read-only session must refuse INSERT")
        });
        assert_eq!(
            refused.code,
            agent_studio_scaffold_lib::db::error::DbErrorCode::Blocked
        );
        // The message must name IAM, because that is the only real boundary here.
        assert!(refused.message.contains("IAM"), "{}", refused.message);

        // The control: the same statement on a read-write session really writes.
        rt().block_on(run(false, insert));
        let found = rt().block_on(run(
            true,
            r#"SELECT name FROM "studios" WHERE name = 'probe-9500'"#,
        ));
        assert_eq!(found[0].rows.len(), 1);

        // Cleanup, so the table is empty again for the next run.
        rt().block_on(run(
            false,
            r#"DELETE FROM "studios" WHERE name = 'probe-9500'"#,
        ));
        let gone = rt().block_on(run(
            true,
            r#"SELECT name FROM "studios" WHERE name = 'probe-9500'"#,
        ));
        assert!(gone[0].rows.is_empty(), "the probe must be cleaned up");
    }

    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn a_bad_statement_is_a_result_carrying_the_services_own_words() {
        // A PartiQL error is an answer about the statement, not a broken connection — the
        // misattribution fix, applied to the fourth engine.
        let sets = rt().block_on(run(true, r#"SELECT * FROM "no_such_table""#));
        assert_eq!(sets[0].kind, DbResultKind::Message);
        let notice = sets[0].notice.as_deref().unwrap_or_default();
        assert!(!notice.is_empty(), "the service's words must survive");
        // The session still works afterwards.
        let ok = rt().block_on(run(true, r#"SELECT * FROM "tracks""#));
        assert_eq!(ok[0].rows.len(), 4);
    }

    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn open_really_dials_so_a_bad_endpoint_fails_at_connect_time() {
        // HTTP is stateless, so without the `ListTables` round trip in `open`, Test Connection
        // would report success for an endpoint nothing listens on (the ClickHouse lesson).
        let mut cfg = config(true);
        cfg.options
            .insert("endpoint".to_string(), "http://127.0.0.1:1".to_string());
        cfg.timeout_ms = 3_000;
        let err = rt()
            .block_on(async {
                engine_for(DbEngineId::Dynamodb)
                    .expect("dynamodb is wired")
                    .open(&cfg)
                    .await
                    .map(|_| ())
            })
            .expect_err("nothing listens on port 1");
        assert!(
            matches!(
                err.code,
                agent_studio_scaffold_lib::db::error::DbErrorCode::Network
                    | agent_studio_scaffold_lib::db::error::DbErrorCode::Timeout
            ),
            "{:?}: {}",
            err.code,
            err.message
        );
    }

    /// The flat tree: root → **Tables** → the seeded tables → a table's key schema and indexes.
    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn the_tree_is_flat_and_a_table_shows_its_keys_and_indexes() {
        use agent_studio_scaffold_lib::db::tree::{DbGroup, DbNodeKind, DbNodeRef};
        rt().block_on(async {
            let mut session = open(true).await;

            let root = session.children(&DbNodeRef::Root).await.expect("root");
            // No database level and no schema level: a region contains tables.
            assert_eq!(root.len(), 1);
            assert_eq!(root[0].label, DbGroup::Tables.label());
            assert_eq!(root[0].sub_label.as_deref(), Some(REGION));

            let tables = session
                .children(&DbNodeRef::Group {
                    database: String::new(),
                    schema: None,
                    group: DbGroup::Tables,
                })
                .await
                .expect("tables");
            let names: Vec<&str> = tables.iter().map(|t| t.label.as_str()).collect();
            assert!(names.contains(&"tracks"), "{names:?}");
            assert!(names.contains(&"studios"), "{names:?}");

            let inside = session
                .children(&DbNodeRef::Table {
                    database: String::new(),
                    schema: None,
                    name: "tracks".to_string(),
                })
                .await
                .expect("describe");
            let labelled: Vec<(String, String)> = inside
                .iter()
                .map(|n| (n.label.clone(), n.sub_label.clone().unwrap_or_default()))
                .collect();
            // The seed's key schema, in the service's own order, with OUR words for the roles —
            // "HASH" tells a user nothing about which value a PartiQL WHERE has to pin.
            assert!(
                labelled
                    .iter()
                    .any(|(l, s)| l == "title" && s.starts_with("partition key")),
                "{labelled:?}"
            );
            assert!(
                labelled
                    .iter()
                    .any(|(l, s)| l == "ts" && s.starts_with("sort key")),
                "{labelled:?}"
            );
            assert!(
                labelled
                    .iter()
                    .any(|(l, s)| l == "by-studio" && s.contains("global secondary index")),
                "{labelled:?}"
            );
            assert!(inside.iter().any(|n| n.kind == DbNodeKind::View));

            session.close().await;
        });
    }

    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn it_hands_out_no_cancel_handle_because_it_has_no_server_side_cancel() {
        // 🔴 The refusal is STRUCTURAL — `cancel_handle()` returns `None`
        // rather than every call returning a runtime error. `db_cancel` then refuses
        // without a round trip, and "cannot" stays distinct from "tried and failed".
        rt().block_on(async {
            let session = open(true).await;
            assert!(
                session.cancel_handle().is_none(),
                "an engine with no server-side cancel must hand out no handle"
            );
            session.close().await;
        });
    }
}

/// **Cancel, against real servers.**
///
/// 🔴 This module is the point of the whole `db_cancel` change, and it is deliberately the last
/// thing in this file: PostgreSQL, MySQL and ClickHouse have had correct cancel implementations
/// since their engines shipped, and **no caller could reach them** — `db::query` holds the session
/// mutex for the whole of `run`, so anything behind that lock is unreachable exactly while a query
/// is running. The hermetic half of the fix is proven in `db::session`'s tests (a handle usable
/// while the lock is held; the old shape deadlocks). This is the other half: that the request the
/// handle sends actually stops a real query on a real server.
///
/// Each test runs a **genuinely slow** statement, cancels it from another task, and asserts the
/// query came back early *and* said it was cancelled. A test that only checked "the cancel call
/// returned Ok" would pass against a cancel that did nothing at all.
mod db_live_cancel {
    use super::*;
    use agent_studio_scaffold_lib::db::engine::DbCancel;
    use agent_studio_scaffold_lib::db::error::DbErrorCode;
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    /// Long enough that a cancel is unambiguous, short enough that a BROKEN cancel does not hang
    /// the suite — the assertion is on elapsed time, so both directions are visible.
    const SLEEP_SECONDS: u32 = 30;
    /// Give the query a moment to actually reach the server before cancelling it. Cancelling a
    /// statement that has not started yet would prove nothing.
    const LET_IT_START: Duration = Duration::from_millis(700);

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Runtime::new().expect("a tokio runtime")
    }

    fn limits() -> Limits {
        Limits {
            row_limit: 500,
            // Deliberately far longer than the sleep: if the query ends early it is because the
            // CANCEL ended it, not because it timed out.
            timeout_ms: 120_000,
            allow_multi_statement: false,
        }
    }

    /// Open a session, take its cancel handle, run `sql`, and cancel it mid-flight.
    ///
    /// Returns `(elapsed, the run's outcome)`. The handle is taken **before** the run, exactly as
    /// `session::insert` does — that ordering is the fix.
    async fn run_and_cancel(
        engine: DbEngineId,
        cfg: ResolvedConfig,
        sql: &str,
    ) -> (
        Duration,
        Result<Vec<DbResultSet>, agent_studio_scaffold_lib::db::error::DbError>,
    ) {
        let eng = engine_for(engine).expect("engine is wired");
        let mut session = eng.open(&cfg).await.unwrap_or_else(|e| {
            panic!(
                "could not open — is `npm run db:fixtures:up` running? {}",
                e.message
            )
        });

        let handle: Arc<dyn DbCancel> = session
            .cancel_handle()
            .expect("pg/mysql/clickhouse all hand out a cancel handle");

        let canceller = tokio::spawn(async move {
            tokio::time::sleep(LET_IT_START).await;
            handle.cancel().await
        });

        let started = Instant::now();
        let outcome = session
            .run(
                &Script {
                    text: sql.to_string(),
                    mode: DbRunMode::Statement,
                },
                &limits(),
            )
            .await;
        let elapsed = started.elapsed();

        let cancel_result = canceller.await.expect("the cancel task did not panic");
        assert!(
            cancel_result.is_ok(),
            "the cancel request itself failed: {:?}",
            cancel_result.err().map(|e| e.message)
        );
        session.close().await;
        (elapsed, outcome)
    }

    /// The assertion every engine shares — and it is **two-sided on purpose**.
    ///
    /// 🔴 The upper bound alone is not enough, and this is not hypothetical: the first ClickHouse
    /// version of this test **passed with the cancel disabled**, because its statement was refused
    /// instantly under `readonly=1` and returned in ~0ms. An upper-bound-only assertion cannot tell
    /// "cancelled after 700ms" from "never ran at all", and the second one silently proves nothing.
    ///
    /// So: it must have taken at least as long as the delay before the cancel was sent (the query
    /// really was in flight), and much less than the sleep it asked for (the cancel really stopped
    /// it).
    fn assert_stopped_early(elapsed: Duration, label: &str) {
        assert!(
            elapsed >= LET_IT_START,
            "{label}: the query returned in {elapsed:?}, before the cancel was even sent — it never \
             ran, so this test proves nothing about cancelling. Check the statement is actually \
             accepted by this engine under these settings."
        );
        assert!(
            elapsed < Duration::from_secs(u64::from(SLEEP_SECONDS) / 2),
            "{label}: the query ran {elapsed:?} of a {SLEEP_SECONDS}s sleep — the cancel did not \
             stop it. A cancel that returns Ok and changes nothing is the failure this test exists \
             for."
        );
    }

    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn postgres_really_cancels_a_running_query() {
        rt().block_on(async {
            let (elapsed, outcome) = run_and_cancel(
                DbEngineId::Postgres,
                super::db_live::config(true, "agentstudio-test-pw"),
                &format!("SELECT pg_sleep({SLEEP_SECONDS})"),
            )
            .await;
            assert_stopped_early(elapsed, "postgres");
            // Postgres reports the cancellation as a statement error, so it arrives as a `message`
            // result (the `http_send` contract) rather than a rejection.
            match outcome {
                Ok(sets) => {
                    let notice = sets
                        .iter()
                        .filter_map(|s| s.notice.as_deref())
                        .collect::<Vec<_>>()
                        .join(" ");
                    assert!(
                        notice.to_lowercase().contains("cancel"),
                        "the result must say it was cancelled, got: {notice}"
                    );
                }
                Err(e) => assert_eq!(
                    e.code,
                    DbErrorCode::Cancelled,
                    "an Err path must classify as cancelled, got: {} / {}",
                    e.code.as_str(),
                    e.message
                ),
            }
        });
    }

    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn mysql_really_cancels_a_running_query() {
        rt().block_on(async {
            // `KILL QUERY` ends the statement and LEAVES THE CONNECTION OPEN — the reason bare
            // `KILL` is not used. That distinction is what makes a cancel survivable.
            let (elapsed, outcome) = run_and_cancel(
                DbEngineId::Mysql,
                super::db_live_mysql::config(true, "agentstudio-test-pw"),
                &format!("SELECT SLEEP({SLEEP_SECONDS})"),
            )
            .await;
            assert_stopped_early(elapsed, "mysql");
            let _ = outcome; // MySQL reports the interruption either way; the timing is the proof.
        });
    }

    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn clickhouse_really_cancels_a_running_query() {
        rt().block_on(async {
            // 🔴 Also the regression test for the KILL matching ITSELF: the killer session takes a
            // FRESH ULID prefix, so `KILL QUERY WHERE query_id LIKE '<prefix>-%'` cannot match the
            // KILL's own id. With a derived `<prefix>-kill` it could.
            // 🔴 A big SCAN, not a sleep — and this took three attempts, each caught by the
            // lower-bound assertion rather than by review:
            //   `SETTINGS max_block_size = 1` → refused under `readonly=1`, returned in ~0ms.
            //   `sleepEachRow(1)`             → accepted and returns in ~10ms; ClickHouse does not
            //                                   honour it the way the name suggests.
            //   counting 50e9 numbers         → genuinely ~50s of work, and read-only permits it.
            // Measured against the fixture: 20e9 takes ~19.6s, so 50e9 is comfortably longer than
            // the 15s ceiling `assert_stopped_early` allows.
            let (elapsed, outcome) = run_and_cancel(
                DbEngineId::Clickhouse,
                super::db_live_clickhouse::config(true, "agentstudio-test-pw"),
                "SELECT count() FROM numbers(50000000000)",
            )
            .await;
            assert_stopped_early(elapsed, "clickhouse");
            let _ = outcome;
        });
    }

    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn the_engines_without_a_server_side_cancel_hand_out_no_handle() {
        // 🔴 `None`, not a runtime error: `db_cancel` can then refuse without a round trip and name
        // the bound that still applies. Asserted against the real sessions, because the claim is
        // about what these engines can do, not about what a struct says.
        rt().block_on(async {
            for (engine, cfg, label) in [
                (
                    DbEngineId::Mongodb,
                    super::db_live_mongo::config(true, "agentstudio-test-pw"),
                    "mongodb",
                ),
                (
                    DbEngineId::Redis,
                    super::db_live_redis::config(true, "agentstudio-test-pw"),
                    "redis",
                ),
            ] {
                let eng = engine_for(engine).expect("engine is wired");
                let session = eng.open(&cfg).await.unwrap_or_else(|e| {
                    panic!("{label}: could not open — fixtures up? {}", e.message)
                });
                assert!(
                    session.cancel_handle().is_none(),
                    "{label} has no server-side cancel, so it must hand out no handle"
                );
                session.close().await;
            }
        });
    }
}

/// **The stale cached connection — reproduced, then fixed.**
///
/// 🔴 With PostgreSQL, Test Connection succeeded but queries would not run, failing with
/// `(expected to read 5 bytes, got 0 bytes at EOF)` — and then the decisive half: after restarting
/// Agent Studio, queries worked again.
///
/// A session is one connection cached in the process for the life of the app, and nothing ever
/// asked whether its socket was still there. A laptop suspend, a pooler's idle timeout, a NAT entry
/// expiring, a server restart — each of them closes that socket, and each turned every later
/// `db_query` into a write to a corpse. Test Connection kept working the entire time because it
/// dials a *fresh* connection every call and never touches the cache, so the one diagnostic the user
/// reaches for agreed with them that the server was fine. Restarting the app empties the map, which
/// is why a restart "fixed" it.
///
/// `pg_terminate_backend` from a sibling connection is that failure, exactly: the server closes the
/// socket out from under a client that is not looking. **A stub could not have produced this** — the
/// EOF only exists because a real backend really went away — which is why this tier is where the fix
/// has to be proven.
mod db_live_reconnect {
    use super::*;
    use agent_studio_scaffold_lib::db::session;
    use std::time::{Duration, Instant};

    /// TEST FIXTURE ONLY — published in this repo, bound to localhost. Spelled out here rather than
    /// reached for across modules, exactly as `db_live_cancel` does.
    const PASSWORD: &str = "agentstudio-test-pw";

    /// This module's own write probe id. Nothing in the seed uses the 9000 range and every probe
    /// owns exactly one id — three probes that shared 9001 once reddened each other under
    /// `cargo test`'s parallelism.
    const PROBE_RECONNECT: i32 = 9005;

    /// Long enough that a cancel is unambiguous, short enough that a broken one does not hang the
    /// suite. Same pair, and same reasoning, as `db_live_cancel`.
    const SLEEP_SECONDS: u32 = 30;
    const LET_IT_START: Duration = Duration::from_millis(700);

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Runtime::new().expect("a tokio runtime")
    }

    /// A session budget far longer than `SLEEP_SECONDS`, so a query that ends early ended because
    /// something *stopped* it and not because it timed out.
    fn limits() -> Limits {
        Limits {
            row_limit: 500,
            timeout_ms: 120_000,
            allow_multi_statement: false,
        }
    }

    fn config(read_only: bool) -> ResolvedConfig {
        let mut cfg = super::db_live::config(read_only, PASSWORD);
        // `open` turns this into `SET statement_timeout`, and `ensure_live` re-applies it. It has to
        // agree with `limits()` or the reconnected session would carry a different bound from the
        // one it was opened with — which is itself worth having identical in a test about reconnects.
        cfg.timeout_ms = 120_000;
        cfg
    }

    /// Open a session and register it, exactly as `db_open` does — the cache is the subject here, so
    /// the test has to go through it rather than around it.
    async fn open_registered(read_only: bool) -> String {
        let engine = engine_for(DbEngineId::Postgres).expect("postgres is wired");
        let session = engine
            .open(&config(read_only))
            .await
            .unwrap_or_else(|e| panic!("could not open — fixtures up? {}", e.message));
        session::insert("live-reconnect", limits(), session)
    }

    /// The backend this session is sitting on **right now**, read through the very command that
    /// could not run.
    async fn backend_pid(session_id: &str) -> i32 {
        let sets = agent_studio_scaffold_lib::db::query(
            session_id,
            "SELECT pg_backend_pid()".to_string(),
            DbRunMode::Statement,
            None,
        )
        .await
        .unwrap_or_else(|e| {
            panic!(
                "the session could not answer: {} ({}) — this is the stale-connection bug",
                e.message,
                e.code.as_str()
            )
        });
        assert_eq!(sets.len(), 1, "{sets:#?}");
        sets[0]
            .rows
            .first()
            .and_then(|r| r[0].clone())
            .expect("a backend pid")
            .parse()
            .expect("pg_backend_pid() is an integer")
    }

    /// Run `sql` on a **sibling** connection. The whole reproduction depends on the kill arriving
    /// from somewhere else: a connection cannot terminate itself and then report what happened.
    async fn on_a_sibling(sql: &str) -> Vec<DbResultSet> {
        let engine = engine_for(DbEngineId::Postgres).expect("postgres is wired");
        let mut s = engine
            .open(&super::db_live::config(false, PASSWORD))
            .await
            .unwrap_or_else(|e| panic!("could not open a sibling — fixtures up? {}", e.message));
        let out = s
            .run(
                &Script {
                    text: sql.to_string(),
                    mode: DbRunMode::Statement,
                },
                &limits(),
            )
            .await
            .unwrap_or_else(|e| panic!("the sibling could not run `{sql}`: {}", e.message));
        s.close().await;
        out
    }

    /// Kill `pid` and **wait for it to actually be gone**.
    ///
    /// The two-argument form is PostgreSQL 14+ and the fixture pins 17.6: with a timeout it blocks
    /// until the backend has exited and returns `t`, or gives up and returns `f`. That is what makes
    /// the negative half of a two-sided assertion available here — a kill that silently did nothing is
    /// distinguishable from one that worked, so this test cannot go green on a no-op.
    async fn terminate_and_confirm(pid: i32) {
        let sets = on_a_sibling(&format!("SELECT pg_terminate_backend({pid}, 5000)")).await;
        let answer = sets
            .first()
            .and_then(|s| s.rows.first())
            .and_then(|r| r[0].clone());
        assert_eq!(
            answer.as_deref(),
            Some("t"),
            "backend {pid} was not terminated, so nothing was reproduced and a green run here would \
             mean nothing at all"
        );
    }

    /* ───────────────────────────── the reproduction ───────────────────────────── */

    /// 🔴 **THE test.** Open a session, use it, have the server kill it, and use it again.
    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn a_session_whose_backend_is_killed_keeps_answering_on_the_same_session_id() {
        rt().block_on(async {
            let id = open_registered(true).await;

            // 1. It works — otherwise step 3 proves nothing about recovery.
            let before = backend_pid(&id).await;

            // 2. The server closes it, the way a pooler or an idle timeout would.
            terminate_and_confirm(before).await;

            // 3. The SAME session id must still answer. Before the fix this is where
            //    `(expected to read 5 bytes, got 0 bytes at EOF)` came out, and the only cure was
            //    restarting the app.
            let after = backend_pid(&id).await;

            // Two-sided: the kill really happened, so this cannot pass by the kill
            // silently failing and the original connection simply still being alive.
            assert_ne!(
                before, after,
                "the session came back on the SAME backend pid ({before}), which means the \
                 terminate did not take effect and no reconnect was exercised"
            );

            agent_studio_scaffold_lib::db::db_close(id).await;
        });
    }

    /// The tree browses over the same cached connection, so it carries the same defect — expanding a
    /// node after the laptop wakes up must not report a dead socket as a broken database.
    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn the_tree_also_survives_the_server_closing_the_connection() {
        rt().block_on(async {
            let id = open_registered(true).await;
            let before = backend_pid(&id).await;
            terminate_and_confirm(before).await;

            let nodes = agent_studio_scaffold_lib::db::children(
                &id,
                &agent_studio_scaffold_lib::db::tree::DbNodeRef::Root,
            )
            .await
            .unwrap_or_else(|e| panic!("the tree could not expand: {}", e.message));
            assert_eq!(
                nodes.len(),
                1,
                "postgres roots at its one database: {nodes:#?}"
            );

            assert_ne!(before, backend_pid(&id).await, "no reconnect was exercised");
            agent_studio_scaffold_lib::db::db_close(id).await;
        });
    }

    /// 🔴 **A reconnect is a NEW server session, and `SET SESSION CHARACTERISTICS AS TRANSACTION
    /// READ ONLY` died with the old one.**
    ///
    /// If `ensure_live` did not re-apply the guardrail, the user would silently be handed a
    /// read-write connection on a connection they had configured as read-only — a worse bug than the
    /// one being fixed, and one nothing else in this suite would notice, because every other
    /// read-only test opens a fresh session that never lost its socket.
    ///
    /// Asserted on **the absence of the row**, not on the presence of an error: the first attempt at
    /// the original read-only measurement failed with a NOT NULL violation, which looks exactly like
    /// the guard working while the guard had in fact let the write through.
    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn the_read_only_guardrail_is_re_applied_after_a_reconnect() {
        let insert = format!(
            "INSERT INTO tracks (id, title, ensemble, duration, tag) \
             VALUES ({PROBE_RECONNECT}, 'ESCAPED', 'duo', 1, 'after-reconnect')"
        );
        let exists = format!("SELECT id FROM tracks WHERE id = {PROBE_RECONNECT}");
        let cleanup = format!("DELETE FROM tracks WHERE id = {PROBE_RECONNECT}");

        rt().block_on(async {
            on_a_sibling(&cleanup).await;

            let id = open_registered(true).await;
            let before = backend_pid(&id).await;
            terminate_and_confirm(before).await;

            // The first statement after the kill is the one that reconnects, and it is the write.
            let sets = agent_studio_scaffold_lib::db::query(
                &id,
                insert.clone(),
                DbRunMode::Statement,
                None,
            )
            .await
            .unwrap_or_else(|e| panic!("the reconnect itself failed: {}", e.message));

            // The server's refusal arrives as a `message` result, not a rejected command.
            assert_eq!(sets.len(), 1, "{sets:#?}");
            assert_eq!(sets[0].kind, DbResultKind::Message, "{sets:#?}");
            let notice = sets[0].notice.clone().unwrap_or_default();
            assert!(
                notice.to_lowercase().contains("read-only"),
                "the refusal must say why: {notice}"
            );

            // …and the row is not there. This is the assertion that actually matters.
            let landed = on_a_sibling(&exists)
                .await
                .first()
                .and_then(|s| s.rows.first())
                .and_then(|r| r[0].clone());
            assert_eq!(
                landed, None,
                "a session that had been re-established wrote a row — the read-only guardrail was \
                 not re-applied to the new connection"
            );

            // Proof the reconnect really happened, so a green run cannot come from the kill failing.
            assert_ne!(before, backend_pid(&id).await, "no reconnect was exercised");

            agent_studio_scaffold_lib::db::db_close(id).await;
            on_a_sibling(&cleanup).await;
        });
    }

    /// 🔴 **The cancel handle must follow the reconnect, not fire at the backend that died.**
    ///
    /// `LiveSession::cancel` is captured once, at `session::insert`, and outlives every reconnect.
    /// PostgreSQL's cancel here is `SELECT pg_cancel_backend(pid)` — a SQL call against whichever
    /// backend holds that pid **now**, not libpq's cancel-key handshake, which is the thing that
    /// would have made a frozen handle harmlessly inert. Backend pids are OS pids and OS pids get
    /// recycled, and `pg_cancel_backend` succeeds for any backend the same role owns — including
    /// this app's own other session on the same database. So a frozen pid is not a stale curiosity,
    /// it is a Stop button that interrupts a stranger.
    ///
    /// Two-sided, and both halves do work: the query must have been genuinely in flight when the
    /// cancel was sent (a lower bound — a ClickHouse test without one once passed with the cancel
    /// disabled), and it must have come back long before its own sleep. A handle still
    /// holding the dead pid cancels nothing, the sleep runs its full 30 s, and the upper bound fails.
    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn the_cancel_handle_targets_the_backend_the_session_reconnected_onto() {
        rt().block_on(async {
            let id = open_registered(true).await;
            // Taken BEFORE the reconnect, exactly as `session::insert` does — that is the point.
            let handle = session::get(&id)
                .expect("registered")
                .cancel
                .expect("postgres hands out a cancel handle");

            let before = backend_pid(&id).await;
            terminate_and_confirm(before).await;
            let after = backend_pid(&id).await;
            assert_ne!(before, after, "no reconnect was exercised");

            let running = id.clone();
            let query = tokio::spawn(async move {
                let started = Instant::now();
                let outcome = agent_studio_scaffold_lib::db::query(
                    &running,
                    format!("SELECT pg_sleep({SLEEP_SECONDS})"),
                    DbRunMode::Statement,
                    None,
                )
                .await;
                (started.elapsed(), outcome)
            });

            tokio::time::sleep(LET_IT_START).await;
            handle
                .cancel()
                .await
                .unwrap_or_else(|e| panic!("the cancel request itself failed: {}", e.message));

            let (elapsed, _) = query.await.expect("the query task did not panic");
            assert!(
                elapsed >= LET_IT_START,
                "the query returned in {elapsed:?}, before the cancel was even sent — it never ran, \
                 so this proves nothing about which backend was cancelled"
            );
            assert!(
                elapsed < Duration::from_secs(u64::from(SLEEP_SECONDS) / 2),
                "the query ran {elapsed:?} of a {SLEEP_SECONDS}s sleep — the cached cancel handle is \
                 still aimed at backend {before}, which no longer exists. On a busy server that pid \
                 belongs to someone else by now."
            );

            agent_studio_scaffold_lib::db::db_close(id).await;
        });
    }
}

/// **MySQL's half of the same fix.** [`db_live_reconnect`] is where the reasoning lives; this
/// exists because `MySqlSession::ensure_live` is a *separate* override, and an override proven only
/// by "it compiles" is exactly the kind that quietly stops working. `KILL <connection_id>` from a
/// sibling is MySQL's `pg_terminate_backend`: it drops the whole session rather than one statement,
/// which is precisely the failure a pooler or an idle timeout produces.
mod db_live_mysql_reconnect {
    use super::*;
    use agent_studio_scaffold_lib::db::session;

    /// TEST FIXTURE ONLY — published in this repo, bound to localhost.
    const PASSWORD: &str = "agentstudio-test-pw";

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Runtime::new().expect("a tokio runtime")
    }

    fn limits() -> Limits {
        Limits {
            row_limit: 500,
            timeout_ms: 30_000,
            allow_multi_statement: false,
        }
    }

    async fn connection_id(session_id: &str) -> u64 {
        let sets = agent_studio_scaffold_lib::db::query(
            session_id,
            "SELECT CONNECTION_ID()".to_string(),
            DbRunMode::Statement,
            None,
        )
        .await
        .unwrap_or_else(|e| panic!("the session could not answer: {}", e.message));
        sets[0]
            .rows
            .first()
            .and_then(|r| r[0].clone())
            .expect("a connection id")
            .parse()
            .expect("CONNECTION_ID() is an integer")
    }

    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn a_session_whose_connection_is_killed_keeps_answering_on_the_same_session_id() {
        rt().block_on(async {
            let engine = engine_for(DbEngineId::Mysql).expect("mysql is wired");
            let s = engine
                .open(&super::db_live_mysql::config(true, PASSWORD))
                .await
                .unwrap_or_else(|e| panic!("could not open — fixtures up? {}", e.message));
            let id = session::insert("live-reconnect-mysql", limits(), s);

            let before = connection_id(&id).await;

            // 🔴 Bare `KILL`, not `KILL QUERY` — the point is to lose the whole connection, which is
            // exactly what `MySqlCancel` deliberately does NOT do.
            let mut sibling = engine
                .open(&super::db_live_mysql::config(false, PASSWORD))
                .await
                .unwrap_or_else(|e| panic!("could not open a sibling: {}", e.message));
            sibling
                .run(
                    &Script {
                        text: format!("KILL {before}"),
                        mode: DbRunMode::Statement,
                    },
                    &limits(),
                )
                .await
                .unwrap_or_else(|e| panic!("the sibling could not KILL {before}: {}", e.message));
            sibling.close().await;

            let after = connection_id(&id).await;
            // Two-sided: a new connection id is the proof the KILL landed and that a
            // reconnect — not the original socket — answered.
            assert_ne!(
                before, after,
                "the session came back on the SAME connection id ({before}), so the KILL did not \
                 take effect and no reconnect was exercised"
            );

            agent_studio_scaffold_lib::db::db_close(id).await;
        });
    }
}

/// 🔴 **A simple URL with no password could not connect.**
///
/// The plainest connection string there is, against a local auth-less `mongod`, came back as
/// *"No MongoDB server could be reached — check the host, the port, and whether a VPN or firewall
/// is in the way. (Server selection timeout: … Error: Kind: I/O error: **tls handshake eof** …)"*
/// — about a server that was listening, reachable, and speaking plaintext. Two defects in one
/// message, and this module is the tier that can fail on either:
///
/// 1. **We forced TLS onto a string that never asked for it.** `client_options` applied the
///    *form's* SSL ladder whenever the driver had left `opts.tls` unset — and the driver leaves it
///    unset for a plain `mongodb://` URL precisely because the connection-string spec says that
///    scheme defaults to `tls=false` (only the SRV scheme defaults to true). The MongoDB row's
///    descriptor default is `SslMode::Require`, `tls_for(Require)` is `Tls::Enabled`, so a pasted
///    plaintext URL was dialled over TLS, the server dropped the handshake, and the driver said
///    `tls handshake eof`. It also broke the dialog's own promise: *"Overrides the fields above —
///    Agent Studio sends this string to the driver as-is."*
/// 2. **The sentence then pointed at the one thing that was fine.** A handshake EOF means the TCP
///    connection was established and the server refused/failed TLS: the host and the port are
///    demonstrably reachable. This is the misattribution `db/error.rs` already fixed once for
///    Postgres's `UnexpectedEof` (see the comment there — same reasoning, same voice).
///
/// **Why this fixture is the right server to prove it against:** its `mongod` publishes no TLS
/// listener at all, so "the ladder was applied to a pasted string" and "the ladder was not" are
/// visibly different outcomes rather than two ways of succeeding.
///
/// ⚠️ Every test here that must FAIL sets `connectTimeout` to a few seconds. The failure is a
/// *server selection* timeout — the driver retries the handshake for the whole window — so the
/// default 10s would be paid four times over for nothing.
mod db_live_mongo_plain_url {
    use super::*;
    use agent_studio_scaffold_lib::db::error::DbErrorCode;

    const HOST: &str = "127.0.0.1";
    const PORT: u16 = 57017;
    /// A loopback port with nothing on it — the negative control for defect 2. A
    /// genuinely unreachable server must still be told it is unreachable.
    const CLOSED_PORT: u16 = 57018;
    const USER: &str = "agentstudio";
    /// TEST FIXTURE ONLY — published in this repo, bound to localhost.
    const PASSWORD: &str = "agentstudio-test-pw";
    const DATABASE: &str = "maestro";

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Runtime::new().expect("a tokio runtime")
    }

    fn limits() -> Limits {
        Limits {
            row_limit: 500,
            timeout_ms: 30_000,
            allow_multi_statement: false,
        }
    }

    /// A config carrying the MongoDB row's **descriptor default** SSL mode — `Require`, which is
    /// what a freshly-created record holds and what the failing case had. Writing `Disable` here
    /// would make every test below pass against the bug, so it is spelled out rather than
    /// inherited.
    fn requiring_tls(read_only: bool) -> ResolvedConfig {
        let mut cfg = super::db_live_mongo::config(read_only, PASSWORD);
        cfg.ssl_mode = SslMode::Require;
        cfg
    }

    /// The same, with the host/port fields pointed at nothing: on the URL path a green result must
    /// be the *string's* doing, never the form's.
    fn url_only(url: String) -> ResolvedConfig {
        let mut cfg = requiring_tls(true);
        cfg.host = "mongo.invalid".to_string();
        cfg.port = Some(9);
        cfg.database = String::new();
        cfg.url = Some(url);
        cfg
    }

    fn impatient(cfg: &mut ResolvedConfig, seconds: &str) {
        cfg.options
            .insert("connectTimeout".to_string(), seconds.to_string());
    }

    fn column(set: &DbResultSet, name: &str) -> usize {
        set.columns
            .iter()
            .position(|c| c.name == name)
            .unwrap_or_else(|| {
                panic!(
                    "no `{name}` column in {:?}",
                    set.columns.iter().map(|c| &c.name).collect::<Vec<_>>()
                )
            })
    }

    async fn open(
        cfg: &ResolvedConfig,
    ) -> Result<
        Box<dyn agent_studio_scaffold_lib::db::engine::DbSession>,
        agent_studio_scaffold_lib::db::error::DbError,
    > {
        engine_for(DbEngineId::Mongodb)
            .expect("mongodb is wired")
            .open(cfg)
            .await
    }

    /// 🔴 **The exact failing case.** A plain `mongodb://127.0.0.1:PORT/db` with **no
    /// credentials anywhere** — not in the string, not in the fields — connects and runs a command.
    ///
    /// `{"hello": 1}` is the trivial command on purpose: it is on this engine's read-only allowlist
    /// *and* it is one of the handful `mongod` answers before authentication, so the assertion is
    /// about the transport and never about the fixture's `admin` user. (Measured against the
    /// fixture: `hello` and `buildInfo` answer unauthenticated, `find` comes back `Unauthorized`.)
    ///
    /// **Seen red before the fix** with exactly the failing text — `No MongoDB server could be
    /// reached … Kind: I/O error: tls handshake eof` — which is the whole reason it exists.
    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn a_plain_mongodb_url_with_no_credentials_connects_and_runs_a_command() {
        let sets = rt().block_on(async {
            let mut cfg = url_only(format!("mongodb://{HOST}:{PORT}/{DATABASE}"));
            // No user, no password: the simple, password-free URL of the report.
            cfg.user = String::new();
            cfg.password = String::new();

            let mut session = open(&cfg).await.unwrap_or_else(|e| {
                panic!(
                    "the plainest connection string there is must connect: {} ({})",
                    e.message,
                    e.code.as_str()
                )
            });
            let out = session
                .run(
                    &Script {
                        text: r#"{"hello": 1}"#.to_string(),
                        mode: DbRunMode::Statement,
                    },
                    &limits(),
                )
                .await;
            session.close().await;
            out.unwrap_or_else(|e| {
                panic!("`hello` must answer: {} ({})", e.message, e.code.as_str())
            })
        });

        assert_eq!(sets[0].kind, DbResultKind::Rows);
        // A real `mongod` answered, not merely a socket: the standalone fixture is writable primary.
        assert_eq!(
            sets[0].rows[0][column(&sets[0], "isWritablePrimary")].as_deref(),
            Some("true"),
            "{:?}",
            sets[0].rows
        );
    }

    /// **The control for defect 1: the fix removed the forced default, not TLS support.** The same
    /// plaintext server, the same plain scheme, but the string itself says `tls=true` — and the
    /// string is what we promised to honour, so this must still fail at the handshake.
    ///
    /// `ssl_mode` is `Disable` here deliberately: the *form's* ladder says plaintext and the
    /// **string** says TLS. If the fields had been allowed to win, this would connect.
    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn a_url_that_asks_for_tls_still_gets_tls_and_therefore_still_fails_here() {
        let err = rt().block_on(async {
            let mut cfg = url_only(format!("mongodb://{HOST}:{PORT}/{DATABASE}?tls=true"));
            cfg.user = String::new();
            cfg.password = String::new();
            cfg.ssl_mode = SslMode::Disable;
            impatient(&mut cfg, "4");
            open(&cfg)
                .await
                .err()
                .expect("a plaintext server cannot complete a TLS handshake")
        });

        // Defect 2: the code and the sentence both say TLS, and neither sends anyone to the port.
        assert_eq!(err.code, DbErrorCode::Tls, "{}", err.message);
        assert!(
            err.message.contains("did not complete a TLS handshake"),
            "{}",
            err.message
        );
        assert!(
            err.message.contains("SSL mode to Disable"),
            "the message must name the fix: {}",
            err.message
        );
    }

    /// **The FORM path is untouched: the ladder still applies where there is no string to respect.**
    ///
    /// Two-sided by construction — `Disable` connects to this plaintext server and `Require` cannot,
    /// against the identical record. A fix that had disabled the ladder everywhere would pass the
    /// first half and fail the second.
    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn the_form_paths_ssl_ladder_still_decides_when_there_is_no_url() {
        // Disable: plaintext, which is what this fixture speaks.
        let version = rt().block_on(async {
            let mut cfg = requiring_tls(true);
            cfg.ssl_mode = SslMode::Disable;
            assert!(cfg.url.is_none(), "this is the FORM path");
            let mut session = open(&cfg).await.unwrap_or_else(|e| {
                panic!("the form path with `disable` must connect: {}", e.message)
            });
            let info = session.probe().await.expect("a probe on an open session");
            session.close().await;
            info.version
        });
        assert!(version.starts_with("MongoDB "), "{version}");

        // Require: the ladder asks for TLS, the server has none, and the message says so.
        let err = rt().block_on(async {
            let mut cfg = requiring_tls(true);
            impatient(&mut cfg, "4");
            open(&cfg)
                .await
                .err()
                .expect("`require` against a plaintext server must fail")
        });
        assert_eq!(err.code, DbErrorCode::Tls, "{}", err.message);
        assert!(
            err.message.contains("did not complete a TLS handshake"),
            "{}",
            err.message
        );
        // Redaction: the fixture password must not ride out inside a driver string.
        assert!(!err.message.contains(PASSWORD), "{}", err.message);
    }

    /// 🔴 **The other side of defect 2.** A server that really is not there must still
    /// be reported as not there. Rewriting the reachability sentence would be worthless if it also
    /// swallowed the case it was written for.
    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn a_genuinely_unreachable_server_is_still_told_it_is_unreachable() {
        let err = rt().block_on(async {
            let mut cfg = requiring_tls(true);
            // Plaintext, so nothing about TLS is in play — the only problem is that nobody answers.
            cfg.ssl_mode = SslMode::Disable;
            cfg.port = Some(CLOSED_PORT);
            impatient(&mut cfg, "4");
            open(&cfg)
                .await
                .err()
                .expect("nothing listens on the closed port")
        });
        assert_eq!(err.code, DbErrorCode::Network, "{}", err.message);
        assert!(
            err.message.contains("port"),
            "a real unreachable server must still send the user to the host and the port: {}",
            err.message
        );
        assert!(
            !err.message.contains("TLS handshake"),
            "a refused connection is not a handshake failure: {}",
            err.message
        );
    }

    /// The URL path still authenticates when the string carries credentials — i.e. dropping the
    /// forced-TLS default did not quietly drop anything else the URL branch does. The fixture's own
    /// user, over the plain scheme, reading a seeded document by id.
    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn a_plain_url_with_credentials_still_authenticates_and_reads() {
        let sets = rt().block_on(async {
            let cfg = url_only(format!(
                "mongodb://{USER}:{PASSWORD}@{HOST}:{PORT}/{DATABASE}?authSource=admin"
            ));
            let mut session = open(&cfg).await.unwrap_or_else(|e| {
                panic!("a credentialled plain URL must connect: {}", e.message)
            });
            let out = session
                .run(
                    &Script {
                        text: r#"{"count": "tracks"}"#.to_string(),
                        mode: DbRunMode::Statement,
                    },
                    &limits(),
                )
                .await;
            session.close().await;
            out.unwrap_or_else(|e| panic!("count failed: {}", e.message))
        });
        // The seed's row count, so this proves the query reached `maestro` and not `admin`.
        assert_eq!(sets[0].rows[0][column(&sets[0], "n")].as_deref(), Some("6"));
    }
}

/* ───────────────────────────────────────────────────────────────────────────────────────────
The stale-tree fix: **does DDL actually arrive as `affected`?**
─────────────────────────────────────────────────────────────────────────────────────────── */

/// The frontend's automatic object-tree refresh fires on `kind === "affected"` and on nothing
/// else, so the entire fix for the stale tree — a database edit that the object tree did not
/// reflect — rests on one claim about the wire: a `CREATE TABLE` — a statement that affects **zero
/// rows** — comes back as `Affected` and not as `Message`.
///
/// `engine.rs` says so in code (`saw_rows || is_row_returning(stmt)` → `Rows`, otherwise
/// `Affected`) and `the_same_write_succeeds_on_a_read_write_session` says so for an INSERT. But
/// DML is not DDL, and DDL is the statement that was run. Reading the classifier and believing
/// it is prose; this is the assertion. If it ever stops holding, the tree silently goes back to
/// showing yesterday's schema and nothing else in the suite notices.
///
/// **Safe to create a table here, and that was checked rather than assumed**: the
/// Postgres fixture's healthcheck is `SELECT count(*) FROM tracks` — it counts ROWS IN ONE TABLE,
/// not schema objects, so an extra table cannot mark the container unhealthy. (Mongo's
/// `getCollectionNames().length === 6` is the check that can, which is why nothing here goes near
/// Mongo.) The tree tests next door assert `labels(&tables).contains("tracks")`, never an exact
/// list, so a transient neighbour cannot redden them under `cargo test`'s parallelism either.
mod db_live_ddl_kind {
    use super::*;

    /// TEST FIXTURE ONLY — published in this repo, bound to localhost. Spelled out here rather
    /// than reached for across modules, exactly as `db_live_cancel` and `db_live_reconnect` do.
    const PASSWORD: &str = "agentstudio-test-pw";

    /// This module's own probe object, in the 9000 range nothing in the seed uses.
    /// Every other probe here owns one id for the same reason: these tests run in parallel
    /// against one server, and a shared mutable object is the same bug as a shared temp file.
    const PROBE_TABLE: &str = "probe_ddl_9006";

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Runtime::new().expect("a tokio runtime")
    }

    fn limits() -> Limits {
        Limits {
            row_limit: 500,
            timeout_ms: 30_000,
            allow_multi_statement: false,
        }
    }

    /// Run each statement on ONE read-write session, in order, and return their result sets.
    ///
    /// One session rather than one per statement because the sequence is a story — drop, create,
    /// read, drop — and running it across four connections would let another test's session
    /// interleave in the middle of it.
    async fn run_each(statements: &[&str]) -> Vec<DbResultSet> {
        let engine = engine_for(DbEngineId::Postgres).expect("postgres is wired");
        let mut session = engine
            // `read_only: false`: DDL is the subject, and a read-only session would refuse it —
            // which would make this test pass or fail for a reason that is not about `kind`.
            .open(&super::db_live::config(false, PASSWORD))
            .await
            .unwrap_or_else(|e| {
                panic!(
                    "could not open — is `npm run db:fixtures:up` running? {}",
                    e.message
                )
            });
        let mut out = Vec::new();
        for text in statements {
            let sets = session
                .run(
                    &Script {
                        text: (*text).to_string(),
                        mode: DbRunMode::Statement,
                    },
                    &limits(),
                )
                .await
                .unwrap_or_else(|e| panic!("`{text}` failed: {} ({})", e.message, e.code.as_str()));
            assert_eq!(sets.len(), 1, "one statement, one result set: {sets:#?}");
            out.push(sets[0].clone());
        }
        session.close().await;
        out
    }

    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn ddl_on_postgres_is_an_affected_result_with_zero_rows() {
        let create = format!("CREATE TABLE {PROBE_TABLE} (id integer primary key)");
        let drop = format!("DROP TABLE IF EXISTS {PROBE_TABLE}");
        // The leading DROP makes the sequence idempotent: a previous run that panicked between
        // its CREATE and its DROP must not make this one fail for a reason that is not the
        // subject. The trailing DROP is the cleanup, so the fixture stays reusable without a
        // reset — the same discipline as `delete_probe_row`.
        let sets =
            rt().block_on(async { run_each(&[&drop, &create, "SELECT 1 AS n", &drop]).await });

        // THE assertion, and the whole reason the frontend is allowed to key on the kind.
        assert_eq!(
            sets[1].kind,
            DbResultKind::Affected,
            "a CREATE TABLE must be an `affected` result — if it is a `message`, the tree's \
             post-write refresh silently misses every DDL statement, which is the exact bug it \
             was built for: {:#?}",
            sets[1]
        );
        // …and it affected NOTHING, which is why the trigger keys on the kind and never on
        // `rows_affected > 0`. A count-based trigger would be green on the INSERT test next
        // door and dead on the statement that was actually run.
        assert_eq!(
            sets[1].rows_affected,
            Some(0),
            "a CREATE TABLE affects zero rows: {:#?}",
            sets[1]
        );

        // The two-sided half. Without it, a server that reported EVERYTHING as
        // `Affected` would satisfy the assertion above, and the app would re-read the whole
        // catalogue after every SELECT — the cost the tree cache exists to avoid.
        assert_eq!(
            sets[2].kind,
            DbResultKind::Rows,
            "a SELECT is not a write: {:#?}",
            sets[2]
        );

        // And the other half of the gesture: dropping an object must invalidate the
        // tree just as creating one does.
        assert_eq!(
            sets[3].kind,
            DbResultKind::Affected,
            "a DROP TABLE must be an `affected` result too: {:#?}",
            sets[3]
        );
    }
}

/// `agent-studio db connect <url>` against the real Postgres fixture: what an agent does when the
/// user says "connect me to this database". The URL carries the password, the way a user pastes it
/// into a conversation; it must come out tested, saved read-only, with the password in the Vault,
/// and open from the saved record alone.
mod db_live_agent_ctl {
    const HOST: &str = "127.0.0.1";
    const PORT: u16 = 55432;
    const USER: &str = "agentstudio";
    /// TEST FIXTURE ONLY — published in this repo, bound to localhost.
    const PASSWORD: &str = "agentstudio-test-pw";
    const DATABASE: &str = "maestro";

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }

    fn temp_paths(tag: &str) -> (std::path::PathBuf, agent_studio_scaffold_lib::db::Paths) {
        let dir = std::env::temp_dir().join(format!(
            "agentstudio-db-live-ctl-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let paths = agent_studio_scaffold_lib::db::Paths::in_dir(&dir);
        (dir, paths)
    }

    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn an_agents_url_is_tested_saved_read_only_and_opens_from_the_vault() {
        let (dir, paths) = temp_paths("ok");
        let url = format!("postgresql://{USER}:{PASSWORD}@{HOST}:{PORT}/{DATABASE}");
        rt().block_on(async {
            let report =
                agent_studio_scaffold_lib::agent_ctl::db_connect(&paths, &url, None, false)
                    .await
                    .unwrap_or_else(|e| panic!("db connect refused the fixture: {e}"));
            assert!(report.created);
            let test = report.test.clone().expect("a fresh connection is tested");
            assert!(test.ok, "{test:?}");
            assert!(
                test.server_version
                    .as_deref()
                    .unwrap_or("")
                    .contains("PostgreSQL"),
                "{test:?}"
            );
            let c = &report.connection;
            assert_eq!(c.name, format!("{DATABASE}@{HOST}"));
            assert!(c.read_only);
            let store = std::fs::read_to_string(&paths.store).unwrap();
            assert!(
                !store.contains(PASSWORD),
                "the password reached the connection store"
            );

            // The saved record alone opens: the password comes back out of the Vault.
            let opened = agent_studio_scaffold_lib::db::open(&paths, &c.id, None)
                .await
                .unwrap_or_else(|e| panic!("the saved connection did not open: {}", e.message));
            assert!(opened.server_version.contains("PostgreSQL"));
            agent_studio_scaffold_lib::db::db_close(opened.session_id.clone()).await;

            // Asking again changes nothing and says so.
            let again = agent_studio_scaffold_lib::agent_ctl::db_connect(&paths, &url, None, false)
                .await
                .unwrap();
            assert!(!again.created);
            assert_eq!(again.connection.id, c.id);
        });
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn a_wrong_password_is_reported_by_the_server_and_nothing_is_saved() {
        let (dir, paths) = temp_paths("bad");
        let url = format!("postgresql://{USER}:wrong-pw@{HOST}:{PORT}/{DATABASE}");
        rt().block_on(async {
            let err = agent_studio_scaffold_lib::agent_ctl::db_connect(&paths, &url, None, false)
                .await
                .unwrap_err();
            assert!(err.contains("Nothing was saved"), "{err}");
            assert!(
                !err.contains("wrong-pw"),
                "the password leaked into the error: {err}"
            );
        });
        assert!(
            !paths.store.exists()
                || std::fs::read_to_string(&paths.store)
                    .unwrap()
                    .contains("[]")
        );
        assert!(
            !paths.vault.exists(),
            "a refused connection wrote the Vault"
        );
        let _ = std::fs::remove_dir_all(dir);
    }
}
