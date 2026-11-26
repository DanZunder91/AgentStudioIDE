//! The database client's live tier against real Docker servers: `npm run db:fixtures:up`, then
//! `cargo test … -- --ignored db_live` (tests sit in `mod db_live` so that filter matches).
//! Only the host-mapped port checks passwords: in-container loopback is `trust` in pg_hba.

use agent_studio_scaffold_lib::db::engine::{engine_for, Limits, ResolvedConfig, Script};
use agent_studio_scaffold_lib::db::model::{DbEngineId, DbFamily, DbRunMode, SslMode};
use agent_studio_scaffold_lib::db::result::{DbResultKind, DbResultSet};

/// Hermetic guard: the live tier may only dial our own loopback containers, never real
/// databases or credentials. Scans this file's code (not names, not comments) for anything else.
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

    // 2. Nothing that could reach a real service (pasted hostnames, the Atlas SRV scheme). Needles
    //    are built with `concat!` and comments are stripped, so the list and prose never trip it.
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

    /// A distinct 9000-range id per write probe, each deleted afterwards: tests run in parallel,
    /// so a shared mutable row is a flake.
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

    /// The decision the feature rests on: every value comes back from the text protocol as
    /// `Option<String>`, across types a binary decoder would need branches for, and NULL (`None`)
    /// stays distinct from `''` (`Some("")`) with no sentinel.
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

        // Declared type names drive rendering only. Measured: a user-defined type (the ENUM) comes
        // back as `"?"` (simple protocol, no `Describe`); values are unaffected. This line must
        // change if an OID → name lookup at connect lands.
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

    /// Prepending `SET … READ ONLY` to a batch does not bind it (its implicit transaction already
    /// began); it must be its own round trip. Asserts the row's ABSENCE from another session: an
    /// error (e.g. NOT NULL) once looked like the guard working while the write had gone through.
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

    /// `sqlx`/libpq echo connection strings into errors: proves redaction on a REAL auth failure
    /// with a password that percent-encodes, which a raw-bytes redactor would miss.
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

    /// Save with a typed password, open by id and query, through the commands' own functions. Real
    /// temp files (`db::Paths::in_dir`): `db-connections.json` holds only a `{{VAR}}`, the
    /// password sits in the Vault (`api-store.json`); never the developer's config dir.
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
            // One dial returns the session AND the server version; asserted against a real
            // server since the frontend half is only a mock-level claim.
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

    /// The dialog's path: `db_url_parse` strips the password; upsert gets a credential-free URL,
    /// the typed password and a `passwordParam` hint. Green means Postgres accepted a password
    /// that went paste → strip → Vault → re-render → dial (scram on the host-mapped port).
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
            // Named seed rows, never `count(*)`: parallel write probes make a count over
            // `tracks` flaky.
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

    /// Wrong-password control for the test above, plus redaction. The hostile value (`&=?#/:`,
    /// unicode) would make a naive splice fail as something other than `auth`, so `auth` proves
    /// it arrived as one parameter.
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

    /// Measured: Postgres refuses `SET … READ WRITE; INSERT` in one batch but accepts it across two
    /// round trips on one session (what the console does). `guard::read_only_escape` refuses it;
    /// a client-side speed bump, the real boundary is a read-only account.
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

    /// A URL without a credential uses the typed password; a wrong typed one fails as `auth` (so
    /// auth really happens); a URL carrying its own password keeps it.
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

/// MySQL 8.4 live tier, separate from `db_live` because the engines' claims differ (e.g.
/// `max_execution_time` is SELECT-only, same-batch writes are refused). Probe ids in the 9100s.
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
            // `Prefer` encrypts with the server's self-signed cert without verifying a chain,
            // which also lets `caching_sha2_password` complete without the `mysql-rsa` feature.
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
        // `BOOLEAN`, not `TINYINT`: sqlx's `MySqlTypeInfo` normalises `tinyint(1)` back, and
        // the header shows what the driver reports.
        assert_eq!(
            types[2].to_ascii_uppercase(),
            "BOOLEAN",
            "ok's type name was {:?}",
            types[2]
        );
        // A `blob` of valid UTF-8 comes through as text ("Hello"); only undecodable bytes fall
        // back to hex.
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
        // The `blocked` message is ours, not MySQL's ("read only", error 1792).
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
        // Measured: MySQL applies `SET SESSION TRANSACTION READ WRITE` at once, so the next
        // autocommit statement writes; `guard::read_only_escape` must refuse it (Postgres too,
        // across round trips).
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
        // Proves Aurora's descriptor is paired with this engine, against plain MySQL; no Aurora
        // cluster was contacted, so nothing is claimed about failover or reader endpoints.
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

    /// A URL without a credential uses the typed password; a wrong typed one fails as `auth` (so
    /// auth really happens); a URL carrying its own password keeps it.
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

/// ClickHouse 25.6 over HTTP (port 8123, `SslMode::Disable`): TLS is NOT proven here (unit
/// tests in `db/clickhouse.rs` and `http.rs`'s smokes cover the ladder). Probe ids: 9200s.
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

    /// The `url` override must really dial: `host` points nowhere, so success means the URL won.
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
        // Unlike Postgres/MySQL, ClickHouse sends `readonly=1` on EVERY request and the server
        // refuses to change it, so there is no read-only escape; this proves it.
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

/// The connection tree walked on all three SQL engines, differences asserted: Postgres has
/// schemas and sees only its database; MySQL and ClickHouse list every database, no schemas.
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

    /// Server-supplied names are bound, never spliced (ClickHouse via `{name:String}`), so a
    /// table named `x'; DROP …` is data that matches nothing.
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

/// MongoDB 8.0 via the official driver (`SslMode::Disable`; TLS not proven); probe ids in the
/// 9300s as ObjectIds. Never create a collection: the healthcheck requires exactly 6, so writes
/// use `tracks`/`studios`, and `$out` (stages a temp collection) has no read-write control.
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

    /// SQL is translated client-side and RUN; only a live run proves the server accepts the
    /// translated command (unit tests pin the document). Docker fixture only.
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

    /// `IS NULL` → `{"f": null}` also matches ABSENT fields in MongoDB, so the result must say so.
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

    /// `$db` sends the command to a database other than the session's (`maestro`); without it a
    /// URI with no `/dbname` silently searched `admin`.
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

    /// The session envelope rides on every reply and only a real server adds it, so a
    /// hand-built fixture document could never show the bug.
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
        // `$clusterTime`/`operationTime` come only from a replica set, not this standalone
        // `mongod`; the unit test `a_command_reply_shows_its_answer_and_not_the_protocol_envelope`
        // covers them with a synthesised reply.
    }

    /// Mongo returns an empty cursor with no error for a missing collection, so an empty result
    /// must say whether the collection exists.
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

        // Present but matching nothing must read differently. Uses a non-matching FILTER, not
        // `studios`: parallel `$merge` tests write into it.
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

    /// Null, `""` and ABSENT are three MongoDB states but the cell has two: absent collapses into
    /// null and the `notice` carries it (see `db/mongo.rs`'s module doc).
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

    /// Trailing zeros (`0.5000`) and 2^53 + 1 would be lost through an `f64`; `mongosh`'s relaxed
    /// JSON gets the latter wrong.
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

    /// `aggregate` is allowlisted, so only the BSON walk stops `$out`; the escaped spelling has
    /// no `$out` substring, which a `text.contains` check would miss.
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

    /// Read-write control via `$merge` (writes in place, no temp collection to trip the
    /// exactly-six healthcheck) into empty `studios`; the probe is deleted again.
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

    /// One command document per request is a wire-protocol property, not a policy, so this is an
    /// `invalid-statement` message (not `blocked`, which suggests a setting). A run `find` would
    /// return rows.
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
            // `tree::count_label` spells the count "6 collections"; assert the shared helper's
            // output rather than add a second label function.
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
        // Dropping a cursor is not a cancel and `killOp` needs privileges, so cancel is
        // STRUCTURALLY absent (`cancel_handle()` is `None`): "cannot", not "tried and failed".
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

    /// A URL without a credential uses the typed password; a wrong typed one fails as `auth`; a
    /// URL with its own keeps it. `authSource=admin` is in the URI: the URL is sent as-is.
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

    /// Under `URL only` the form's database is empty, and falling back to `admin` returned zero
    /// documents with no error. So assert a row that must be there, and emptiness elsewhere.
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

/// A record with no port dials the standard port (5432/3306): a byte pump there forwards to the
/// fixture, so only that dial can connect. Port taken → a loud SKIP (the logic is pinned in
/// `engine.rs`). No test dials Atlas; SRV evidence is hermetic (`db::mongo`).
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

    /// Pump every connection on `listen` to `to` until the handle drops; `None` = port in use
    /// (a skip, see the module doc). Other errors panic.
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

    /// Save a draft with no port, then the production path (`upsert` → file → `open` → `query`);
    /// the test supplies only the listener on the standard port.
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

    /// A hand-written previous-shape record (numeric `port`, no `srv`) must connect: without
    /// `#[serde(default)]`, `store::load` would silently fall back to an empty store.
    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn a_record_in_the_previous_shape_still_loads_and_queries() {
        let dir = temp_dir("old-shape");
        let paths = agent_studio_scaffold_lib::db::Paths::in_dir(&dir);

        // Seed the Vault through the ordinary save path (`api_store::save` is `pub(crate)`), so
        // the reference name comes from `upsert`, not a guess.
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

/// Redis 8.2.1 via `redis-rs` (`SslMode::Disable`; `rediss://` not proven). Probe keys under
/// `probe:9400:`; the healthcheck tests one marker key, but probes still delete what they write.
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

    /// Absent vs `""` over a real RESP round trip (`fixture:absent` is never created).
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

    /// The read-WRITE control tells "our guard stopped it" from "never works here".
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

    /// `KEYS` blocks a single-threaded server, so it is refused on read-write sessions too.
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

    /// A URL without a credential uses the typed password; a wrong typed one fails as `auth`; a
    /// URL with its own keeps it. The fixture is `requirepass`, no ACL user: `redis://:pw@…`.
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

/// DynamoDB Local via our SigV4. It does NOT verify signatures, so these prove request shape,
/// PartiQL, result shaping and guardrails only; signing is pinned against AWS's vectors in
/// `db/dynamodb.rs`. Writes go into empty `studios` and are deleted.
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

    /// The seed's 38-digit number exceeds `f64`; re-rendering a parsed value would corrupt it.
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

    /// The cell has two states and the data three, so absent is named in the notice.
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

    /// The read-WRITE control tells "refused" from "never works here"; the write into `studios`
    /// is deleted again.
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

/// Cancel against real servers: the request a handle sends must stop a real query
/// (`db::session`'s tests prove the handle works while the lock is held). Each test asserts
/// the query came back early AND said cancelled; "cancel returned Ok" proves nothing.
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

    /// Run `sql` and cancel it mid-flight; the handle is taken BEFORE the run, as
    /// `session::insert` does (that ordering is the fix). Returns `(elapsed, outcome)`.
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

    /// Two-sided: at least the pre-cancel delay (it was in flight; an instantly refused statement
    /// once passed) and well under its own sleep (the cancel stopped it).
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
            // The killer takes a FRESH ULID prefix so `KILL QUERY … LIKE '<prefix>-%'` can't match
            // itself. A big scan, not a sleep (`max_block_size` is refused read-only and
            // `sleepEachRow` returns fast): 50e9 numbers ≈ 50 s, well past the 15 s ceiling.
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

/// A cached session's socket can die (suspend, pooler timeout, server restart) while Test
/// Connection, which dials fresh, still passes. `pg_terminate_backend` from a sibling
/// reproduces the real EOF; a stub could not.
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

    /// Kill `pid` and wait until it is gone (`pg_terminate_backend(pid, 5000)`, PG 14+), so a
    /// no-op kill is distinguishable and the test can't go green on one.
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

    /// A reconnect is a NEW server session, so `ensure_live` must re-apply READ ONLY. Asserts the
    /// row's absence, not an error (a NOT NULL error once masked a write that went through).
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

    /// The cancel handle (captured at `session::insert`) must follow the reconnect: a stale pid
    /// could cancel a recycled pid's query. Two-sided: really in flight, and back well before 30 s.
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

/// MySQL's half of [`db_live_reconnect`]: `MySqlSession::ensure_live` is a separate override.
/// `KILL <connection_id>` from a sibling drops the whole session, like a pooler timeout.
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

/// A plain `mongodb://` URL must not get the form's TLS ladder (the scheme defaults to
/// `tls=false`), and a handshake EOF must not be blamed on host/port. The fixture has no TLS
/// listener, so the outcomes differ visibly. Failing tests use a short `connectTimeout`.
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

    /// The MongoDB row's descriptor default `Require` (what new records hold and the failing case
    /// had); `Disable` here would let every test pass against the bug.
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

    /// No credentials anywhere; `{"hello": 1}` is allowlisted and answered before auth, so this
    /// tests the transport (a wrongly applied TLS ladder fails with `tls handshake eof`).
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

    /// The string's `tls=true` must still win over the form's `Disable`, so it fails at the
    /// handshake against this plaintext server.
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

    /// Two-sided on the identical record: `Disable` connects, `Require` cannot.
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

/// The tree auto-refreshes only on `kind === "affected"`, so a zero-row `CREATE TABLE` must
/// come back `Affected`, not `Message`. Safe here: the Postgres healthcheck counts `tracks`
/// rows, not schema objects, and tree tests never assert exact lists.
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

    /// Run statements in order on ONE read-write session, so another test can't interleave.
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
        // Leading DROP keeps a panicked earlier run from failing this one; trailing DROP cleans
        // up so the fixture stays reusable.
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

/// `agent-studio db connect <url>` against Postgres: a pasted URL with its password must come
/// out tested, saved read-only with the password in the Vault, and open from the record alone.
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
            let report = agent_studio_scaffold_lib::agent_ctl::commands::db::db_connect(
                &paths, &url, None, false,
            )
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
            let again = agent_studio_scaffold_lib::agent_ctl::commands::db::db_connect(
                &paths, &url, None, false,
            )
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
            let err = agent_studio_scaffold_lib::agent_ctl::commands::db::db_connect(
                &paths, &url, None, false,
            )
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

    /* ── the tools after `db connect`: an agent browsing and querying the saved connection ── */

    use agent_studio_scaffold_lib::agent_ctl::commands::db::db_run;
    use agent_studio_scaffold_lib::agent_ctl::{self, CtlEvent, CtlResponse, ToolCtx, UiSink};

    /// A write probe of this module's own, in the 9000 range the seed never uses.
    const PROBE_AGENT_WRITE: i32 = 9101;

    #[derive(Default)]
    struct Events(std::sync::Mutex<Vec<CtlEvent>>);

    impl UiSink for Events {
        fn emit(&self, event: CtlEvent) {
            self.0.lock().unwrap().push(event);
        }
    }

    /// The fixture saved the way an agent saves it (`db connect`, read-only), in a temp dir.
    async fn saved(tag: &str) -> (std::path::PathBuf, agent_studio_scaffold_lib::db::Paths) {
        let (dir, paths) = temp_paths(tag);
        let url = format!("postgresql://{USER}:{PASSWORD}@{HOST}:{PORT}/{DATABASE}");
        agent_studio_scaffold_lib::agent_ctl::commands::db::db_connect(
            &paths,
            &url,
            Some("Maestro"),
            false,
        )
        .await
        .unwrap_or_else(|e| panic!("db connect refused the fixture: {e}"));
        (dir, paths)
    }

    /// One tool call through the real dispatcher, as the CLI or MCP would make it.
    async fn tool(
        dir: &std::path::Path,
        name: &str,
        args: serde_json::Value,
    ) -> (u16, CtlResponse, Vec<CtlEvent>) {
        let events = std::sync::Arc::new(Events::default());
        let ctx = ToolCtx {
            dir: dir.to_path_buf(),
            terminal_id: "term-live".into(),
            ui: events.clone(),
        };
        let body = serde_json::to_vec(&serde_json::json!({"tool": name, "args": args})).unwrap();
        let (status, reply) = agent_ctl::handle(ctx, &body).await;
        assert!(
            !reply.message.contains(PASSWORD) && !reply.data.to_string().contains(PASSWORD),
            "the password reached an agent: {}",
            reply.message
        );
        let seen = events.0.lock().unwrap().clone();
        assert!(
            !serde_json::to_string(&seen).unwrap().contains(PASSWORD),
            "the password reached the UI: {seen:?}"
        );
        (status, reply, seen)
    }

    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn an_agent_tests_and_browses_the_saved_connection_level_by_level() {
        rt().block_on(async {
            let (dir, _paths) = saved("schema").await;
            let (status, r, _) = tool(
                &dir,
                "db_test",
                serde_json::json!({"connection": "maestro"}),
            )
            .await;
            assert_eq!(status, 200, "{}", r.message);
            assert!(r.message.contains(": PostgreSQL "), "{}", r.message);

            let (status, r, _) = tool(
                &dir,
                "db_schema",
                serde_json::json!({"connection": "MAESTRO"}),
            )
            .await;
            assert_eq!(status, 200, "{}", r.message);
            assert!(
                r.message
                    .contains("database  maestro  — the connected database"),
                "{}",
                r.message
            );

            let (_, r, _) = tool(
                &dir,
                "db_schema",
                serde_json::json!({"connection": "Maestro", "path": "maestro/public"}),
            )
            .await;
            let names: Vec<&str> = r.data["items"]
                .as_array()
                .unwrap()
                .iter()
                .map(|i| i["name"].as_str().unwrap())
                .collect();
            assert_eq!(names, ["Tables", "Views"], "{}", r.message);

            let (_, r, _) = tool(
                &dir,
                "db_schema",
                serde_json::json!({"connection": "Maestro", "path": "maestro/public/Tables"}),
            )
            .await;
            for table in ["tall", "tracks", "wide"] {
                assert!(
                    r.message.contains(&format!("table  {table}")),
                    "{}",
                    r.message
                );
            }

            // The folder level left out, and the columns with the server's own type names.
            let (status, r, _) = tool(
                &dir,
                "db_schema",
                serde_json::json!({"connection": "Maestro", "path": "maestro/public/tracks"}),
            )
            .await;
            assert_eq!(status, 200, "{}", r.message);
            assert_eq!(r.data["path"], "maestro/public/Tables/tracks");
            assert!(
                r.message
                    .contains("column  title  — character varying(16) · not null"),
                "{}",
                r.message
            );
            assert!(r.message.contains("11 items."), "{}", r.message);
            let _ = std::fs::remove_dir_all(dir);
        });
    }

    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn an_agent_searches_table_view_and_column_names() {
        rt().block_on(async {
            let (dir, _paths) = saved("search").await;
            let (status, r, _) = tool(
                &dir,
                "db_search",
                serde_json::json!({"connection": "maestro", "pattern": "TRACK"}),
            )
            .await;
            assert_eq!(status, 200, "{}", r.message);
            let paths: Vec<&str> = r.data["matches"]
                .as_array()
                .unwrap()
                .iter()
                .map(|m| m["path"].as_str().unwrap())
                .collect();
            assert!(
                paths.contains(&"maestro/public/Tables/tracks"),
                "{paths:?}"
            );
            assert!(
                paths.contains(&"maestro/public/Views/v_tracks"),
                "{paths:?}"
            );
            assert_eq!(r.data["complete"], true, "{}", r.message);

            let (_, r, _) = tool(
                &dir,
                "db_search",
                serde_json::json!({"connection": "maestro", "pattern": "label"}),
            )
            .await;
            assert!(
                r.message.contains("column  maestro/public/Tables/tall/label"),
                "{}",
                r.message
            );

            // 200 columns of `wide` match "c1": the walk stops at its match limit and says so.
            let (_, r, _) = tool(
                &dir,
                "db_search",
                serde_json::json!({"connection": "maestro", "pattern": "c", "path": "maestro/public/wide"}),
            )
            .await;
            assert_eq!(r.data["matches"].as_array().unwrap().len(), 200);
            assert_eq!(r.data["cutShort"], "matches", "{}", r.message);
            assert!(r.message.contains("The search stopped early"), "{}", r.message);
            let _ = std::fs::remove_dir_all(dir);
        });
    }

    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn an_agent_queries_rows_and_the_user_is_shown_the_run() {
        rt().block_on(async {
            let (dir, _paths) = saved("query").await;
            let (status, r, events) = tool(
                &dir,
                "db_query",
                serde_json::json!({
                    "connection": "maestro",
                    "query": "SELECT id, title, tag FROM tracks ORDER BY id",
                }),
            )
            .await;
            assert_eq!(status, 200, "{}", r.message);
            assert!(
                r.message.starts_with(
                    "Ran on \"Maestro\" (PostgreSQL at 127.0.0.1:55432/maestro, read-only)"
                ),
                "{}",
                r.message
            );
            assert!(r.message.contains("(6 rows)"), "{}", r.message);
            assert!(
                r.message.contains("2  | Bluewater   | NULL"),
                "{}",
                r.message
            );
            assert!(
                r.message
                    .contains("4  | Driftwood   | ünïcode ✓ 中文\\tand a\\nnewline"),
                "{}",
                r.message
            );
            // NULL and '' stay apart in the data (rows 2 and 3).
            assert_eq!(r.data["results"][0]["rows"][1][2], serde_json::Value::Null);
            assert_eq!(r.data["results"][0]["rows"][2][2], "");
            assert_eq!(
                r.data["results"][0]["columns"],
                serde_json::json!(["id", "title", "tag"])
            );

            assert_eq!(events.len(), 1);
            let e = serde_json::to_value(&events[0]).unwrap();
            assert_eq!(e["kind"], "dbQueryRun");
            assert_eq!(e["terminalId"], "term-live");
            assert_eq!(e["results"][0]["rows"].as_array().unwrap().len(), 6);

            // A `{{…}}` in a query is text, never a Vault lookup.
            let (_, r, _) = tool(
                &dir,
                "db_query",
                serde_json::json!({"connection": "maestro", "query": "SELECT '{{PROD_PW}}' AS t"}),
            )
            .await;
            assert_eq!(
                r.data["results"][0]["rows"],
                serde_json::json!([["{{PROD_PW}}"]])
            );
            let _ = std::fs::remove_dir_all(dir);
        });
    }

    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn the_row_limit_and_the_byte_cap_are_measured_and_said() {
        rt().block_on(async {
            let (dir, _paths) = saved("limits").await;
            let (_, r, _) = tool(
                &dir,
                "db_query",
                serde_json::json!({"connection": "maestro", "query": "SELECT id FROM tall ORDER BY id"}),
            )
            .await;
            assert_eq!(r.data["results"][0]["rows"].as_array().unwrap().len(), 100, "the default");
            assert_eq!(r.data["truncated"], true);
            assert!(r.message.contains("(100 rows, more exist)"), "{}", r.message);

            let (_, r, _) = tool(
                &dir,
                "db_query",
                serde_json::json!({"connection": "maestro", "query": "SELECT id FROM tall ORDER BY id", "limit": 10}),
            )
            .await;
            assert_eq!(r.data["results"][0]["rows"].as_array().unwrap().len(), 10);
            assert_eq!(r.data["results"][0]["rows"][9][0], "10");
            assert!(
                r.message
                    .contains("Only the first 10 rows were read: that is the limit (10)."),
                "{}",
                r.message
            );

            let (_, r, _) = tool(
                &dir,
                "db_query",
                serde_json::json!({"connection": "maestro", "query": "SELECT id FROM tall", "limit": 5000}),
            )
            .await;
            assert_eq!(r.data["results"][0]["rows"].as_array().unwrap().len(), 1000);
            assert!(r.message.contains("--limit 5000 was lowered to 1000"));

            // 500 rows of 1000 characters (1010 bytes each with the cell's and the row's own
            // cost): what fits in 64 KB, and a sentence for the rest.
            let (_, r, _) = tool(
                &dir,
                "db_query",
                serde_json::json!({
                    "connection": "maestro",
                    "query": "SELECT repeat('x', 1000) AS v FROM generate_series(1, 500)",
                    "limit": 500,
                }),
            )
            .await;
            assert_eq!(r.data["results"][0]["rows"].as_array().unwrap().len(), 64);
            assert!(
                r.message.contains(
                    "Rows after the first 64 (of 500 read) were left out: the reply is capped at 64 KB."
                ),
                "{}",
                &r.message[r.message.len().saturating_sub(400)..]
            );
            assert!(r.message.len() <= 64 * 1024 + 4096);
            let _ = std::fs::remove_dir_all(dir);
        });
    }

    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn a_write_through_a_read_only_connection_is_refused_and_the_row_is_absent() {
        rt().block_on(async {
            let (dir, _paths) = saved("ro").await;
            let insert = format!(
                "INSERT INTO tracks (id, title, ensemble, duration, tag) \
                 VALUES ({PROBE_AGENT_WRITE}, 'agent', 'duo', 1, 'agent-write')"
            );
            let (status, r, events) = tool(
                &dir,
                "db_query",
                serde_json::json!({"connection": "maestro", "query": insert}),
            )
            .await;
            assert_eq!(status, 200, "the server's refusal is a result: {}", r.message);
            assert!(
                r.message.contains("The database said: The server refused that statement because the transaction is read-only"),
                "{}",
                r.message
            );
            assert_eq!(events.len(), 1, "the attempt is shown to the user");

            // The guard's half: an access-mode change is refused before it is sent.
            let (status, r, events) = tool(
                &dir,
                "db_query",
                serde_json::json!({
                    "connection": "maestro",
                    "query": "SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE",
                }),
            )
            .await;
            assert_eq!(status, 422, "{}", r.message);
            assert!(r.message.contains("would change its access mode"), "{}", r.message);
            assert!(events[0].payload["error"].as_str().unwrap().contains("access mode"));

            // Two statements on a connection that allows one.
            let (status, r, _) = tool(
                &dir,
                "db_query",
                serde_json::json!({"connection": "maestro", "query": "SELECT 1; SELECT 2"}),
            )
            .await;
            assert_eq!(status, 422);
            assert!(r.message.contains("That is 2 statements"), "{}", r.message);

            // Proven by absence, not by the error.
            let (_, r, _) = tool(
                &dir,
                "db_query",
                serde_json::json!({
                    "connection": "maestro",
                    "query": format!("SELECT count(*) FROM tracks WHERE id = {PROBE_AGENT_WRITE}"),
                }),
            )
            .await;
            assert_eq!(r.data["results"][0]["rows"], serde_json::json!([["0"]]), "{}", r.message);
            let _ = std::fs::remove_dir_all(dir);
        });
    }

    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn a_query_past_the_deadline_is_cancelled_on_the_server() {
        rt().block_on(async {
            let (dir, paths) = saved("deadline").await;
            let started = std::time::Instant::now();
            let (_, result) = db_run::run(
                &paths,
                "maestro",
                "SELECT pg_sleep(25) AS agent_deadline_probe",
                None,
                std::time::Duration::from_secs(1),
            )
            .await;
            let err = result.unwrap_err();
            assert!(err.contains("stopped waiting for the query"), "{err}");
            assert!(started.elapsed() < std::time::Duration::from_secs(10));

            // The statement is gone from the server, not left running for 25 s.
            let mut still = String::new();
            for _ in 0..30 {
                let (_, r, _) = tool(
                    &dir,
                    "db_query",
                    serde_json::json!({
                        "connection": "maestro",
                        "query": "SELECT count(*) FROM pg_stat_activity \
                                  WHERE query LIKE 'SELECT pg_sleep(25) AS agent_deadline_probe%' \
                                  AND state = 'active'",
                    }),
                )
                .await;
                still = r.data["results"][0]["rows"][0][0]
                    .as_str()
                    .unwrap_or("?")
                    .to_string();
                if still == "0" {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
            assert_eq!(still, "0", "the abandoned statement is still running");
            let _ = std::fs::remove_dir_all(dir);
        });
    }

    /// The same tools on an engine without SQL: the Redis fixture (`127.0.0.1:56379`,
    /// `requirepass` only), saved by `db connect` from a `redis://:password@…` URL.
    #[test]
    #[ignore = "needs the Docker fixture (redis) — run with --ignored"]
    fn an_agent_reads_redis_and_its_read_only_list_refuses_a_write_before_it_is_sent() {
        const REDIS_PORT: u16 = 56379;
        rt().block_on(async {
            let (dir, paths) = temp_paths("redis");
            let url = format!("redis://:{PASSWORD}@{HOST}:{REDIS_PORT}/0");
            agent_studio_scaffold_lib::agent_ctl::commands::db::db_connect(
                &paths,
                &url,
                Some("Cache"),
                false,
            )
            .await
            .unwrap_or_else(|e| panic!("db connect refused the redis fixture: {e}"));

            let (status, r, _) = tool(
                &dir,
                "db_query",
                serde_json::json!({"connection": "cache", "query": "GET fixture:string"}),
            )
            .await;
            assert_eq!(status, 200, "{}", r.message);
            assert_eq!(r.data["results"][0]["rows"], serde_json::json!([["hello"]]));

            let (status, r, _) = tool(
                &dir,
                "db_query",
                serde_json::json!({"connection": "cache", "query": "SET fixture:agent-probe x"}),
            )
            .await;
            assert_eq!(status, 422, "{}", r.message);
            assert!(
                r.message.contains("not on this app's read-only list"),
                "{}",
                r.message
            );
            let (_, r, _) = tool(
                &dir,
                "db_query",
                serde_json::json!({"connection": "cache", "query": "EXISTS fixture:agent-probe"}),
            )
            .await;
            assert_eq!(
                r.data["results"][0]["rows"],
                serde_json::json!([["0"]]),
                "{}",
                r.message
            );

            // The fixture holds ~5000 keys and the tree reads one page of 500: both tools must
            // say so rather than let a name past the page read as a name that does not exist.
            let (status, r, _) = tool(
                &dir,
                "db_schema",
                serde_json::json!({"connection": "cache", "path": "db0/Keys"}),
            )
            .await;
            assert_eq!(status, 200, "{}", r.message);
            assert_eq!(r.data["items"].as_array().unwrap().len(), 500);
            assert_eq!(r.data["items"][0]["kind"], "key");
            assert!(
                r.data["partial"].as_str().unwrap().starts_with("500 of "),
                "{}",
                r.data
            );
            assert!(
                r.message.contains("This level lists 500 of "),
                "{}",
                r.message
            );

            let (status, r, _) = tool(
                &dir,
                "db_search",
                serde_json::json!({"connection": "cache", "pattern": "fixture:"}),
            )
            .await;
            assert_eq!(status, 200, "{}", r.message);
            assert_eq!(r.data["complete"], false, "{}", r.message);
            assert!(
                r.message
                    .contains("1 level list only one page of what the database holds"),
                "{}",
                r.message
            );
            assert!(r.message.contains("\"db0/Keys\" (500 of "), "{}", r.message);

            // What the tree cannot page through, the console's own command can.
            let (status, r, _) = tool(
                &dir,
                "db_query",
                serde_json::json!({
                    "connection": "cache",
                    "query": "SCAN 0 MATCH \"fixture:key with*\" COUNT 10000",
                }),
            )
            .await;
            assert_eq!(status, 200, "{}", r.message);
            assert!(
                r.message.contains("fixture:key with spaces"),
                "{}",
                r.message
            );
            let _ = std::fs::remove_dir_all(dir);
        });
    }

    /* ── an agent is a hostile client: no password out, no write through read-only ── */

    use agent_studio_scaffold_lib::db::engine::{engine_for, Limits, ResolvedConfig, Script};
    use agent_studio_scaffold_lib::db::model::DbRunMode;
    use agent_studio_scaffold_lib::db::result::DbResultSet;

    const REDIS_PORT: u16 = 56379;
    const MYSQL_PORT: u16 = 53306;
    /// This module's PostgreSQL write probes (the module above uses 9101).
    const PG_PROBE_DO_COMMIT: i32 = 9111;
    const PG_PROBE_FUNCTION: i32 = 9112;
    const PG_PROBE_CALL: i32 = 9113;
    const PG_PROBE_SMUGGLED: i32 = 9115;
    const PG_PROBE_WRITABLE: i32 = 9116;
    /// Rows of the measured exploits: a forged run marker, the same from a function, and a
    /// program run by `COPY … TO PROGRAM`.
    const PG_PROBE_FORGED: i32 = 9131;
    const PG_PROBE_FORGED_IN_CODE: i32 = 9134;
    const PG_PROBE_PROGRAM: i32 = 9132;
    /// This module's MySQL write probes (`db_live_mysql` uses 9101–9104).
    const MY_PROBE_SMUGGLED: i32 = 9121;
    const MY_PROBE_EXECUTE: i32 = 9122;
    const MY_PROBE_SCRIPT_COMMIT: i32 = 9123;
    const MY_PROBE_CALL: i32 = 9124;
    const MY_PROBE_EXEC_COMMENT: i32 = 9125;
    /// The row of a `CALL` hidden behind `--` and a control character.
    const MY_PROBE_HIDDEN_CALL: i32 = 9133;

    /// A script on a read-WRITE session of a fixture, outside the tools: set-up, clean-up, and the
    /// check that a probe row is absent (from a session of its own, so nothing the agent's run left
    /// behind can answer it).
    async fn admin(cfg: ResolvedConfig, sql: &str) -> Vec<DbResultSet> {
        let mut s = engine_for(cfg.engine)
            .unwrap()
            .open(&cfg)
            .await
            .unwrap_or_else(|e| panic!("the fixture did not open: {}", e.message));
        let out = s
            .run(
                &Script {
                    text: sql.to_string(),
                    mode: DbRunMode::Script,
                },
                &Limits {
                    row_limit: 500,
                    timeout_ms: 30_000,
                    allow_multi_statement: true,
                },
            )
            .await;
        s.close().await;
        out.unwrap_or_else(|e| panic!("{sql}: {}", e.message))
    }

    async fn pg_admin(sql: &str) -> Vec<DbResultSet> {
        admin(super::db_live::config(false, PASSWORD), sql).await
    }

    async fn my_admin(sql: &str) -> Vec<DbResultSet> {
        admin(super::db_live_mysql::config(false, PASSWORD), sql).await
    }

    async fn rows_with(admin_sql: impl std::future::Future<Output = Vec<DbResultSet>>) -> String {
        let sets = admin_sql.await;
        sets[0].rows[0][0].clone().unwrap_or_default()
    }

    fn insert(id: i32) -> String {
        format!(
            "INSERT INTO tracks (id, title, ensemble, duration, tag) \
             VALUES ({id}, 'agent', 'duo', 1, 'agent-write')"
        )
    }

    /// Change every saved connection the way the user would in the DB panel's Edit dialog.
    fn edit_saved(
        paths: &agent_studio_scaffold_lib::db::Paths,
        edit: impl Fn(&mut agent_studio_scaffold_lib::db::model::DbConnection),
    ) {
        use agent_studio_scaffold_lib::db::store;
        let mut saved = store::load(&paths.store);
        saved.connections.iter_mut().for_each(edit);
        store::save(&paths.store, &saved).unwrap();
    }

    /// Let the saved connection run several statements per call (the console's Script button).
    fn allow_scripts(paths: &agent_studio_scaffold_lib::db::Paths) {
        edit_saved(paths, |c| c.allow_multi_statement = true);
    }

    #[test]
    #[ignore = "needs the Docker fixture (redis) — run with --ignored"]
    fn redis_never_hands_an_agent_the_password_it_was_opened_with() {
        rt().block_on(async {
            // The exploit is real: on the console's path the fixture answers with the password.
            let direct = admin(
                super::db_live_redis::config(false, PASSWORD),
                "CONFIG GET requirepass",
            )
            .await;
            assert!(
                format!("{direct:?}").contains(PASSWORD),
                "the fixture is expected to answer CONFIG GET with its password: {direct:?}"
            );

            let (dir, paths) = temp_paths("redis-secret");
            let url = format!("redis://:{PASSWORD}@{HOST}:{REDIS_PORT}/0");
            agent_studio_scaffold_lib::agent_ctl::commands::db::db_connect(
                &paths,
                &url,
                Some("Secrets"),
                false,
            )
            .await
            .unwrap_or_else(|e| panic!("db connect refused the redis fixture: {e}"));

            // Every way to read it is refused before anything is sent (`tool` asserts the
            // password is in no reply, data or event).
            for query in [
                "CONFIG GET requirepass",
                "CONFIG GET *",
                "config get masterauth",
                "\"CONFIG\" GET *pass*",
                "ACL LIST",
                "ACL GETUSER default",
                "AUTH wrong-guess",
                "HELLO 3 AUTH default wrong-guess",
                "MONITOR",
            ] {
                let (status, r, events) = tool(
                    &dir,
                    "db_query",
                    serde_json::json!({"connection": "secrets", "query": query}),
                )
                .await;
                assert_eq!(status, 422, "{query}: {}", r.message);
                assert!(
                    r.message.contains("is not available to an agent"),
                    "{query}: {}",
                    r.message
                );
                assert_eq!(events.len(), 1, "the user is shown the attempt");
            }

            // The backstop: a value that IS the password comes back masked, to the agent and to
            // the console alike. It expires on its own, so a failed run leaves nothing behind.
            let key = format!("agent:secret-probe:{}", std::process::id());
            admin(
                super::db_live_redis::config(false, PASSWORD),
                &format!("SET {key} {PASSWORD} EX 60"),
            )
            .await;
            let (status, r, events) = tool(
                &dir,
                "db_query",
                serde_json::json!({"connection": "secrets", "query": format!("GET {key}")}),
            )
            .await;
            admin(
                super::db_live_redis::config(false, PASSWORD),
                &format!("DEL {key}"),
            )
            .await;
            assert_eq!(status, 200, "{}", r.message);
            let mask = agent_studio_scaffold_lib::db::error::MASK;
            assert_eq!(r.data["results"][0]["rows"], serde_json::json!([[mask]]));
            assert_eq!(
                events[0].payload["results"][0]["rows"],
                serde_json::json!([[mask]])
            );
            let _ = std::fs::remove_dir_all(dir);
        });
    }

    /// A plpgsql function the fixture's admin creates, so its body is out of every text check an
    /// agent's query passes: what a database the agent did not write may already hold.
    async fn pg_function(name: &str, body: &str) {
        pg_admin(&format!(
            "CREATE OR REPLACE FUNCTION {name}() RETURNS void LANGUAGE plpgsql AS $$ BEGIN \
             {body} END $$"
        ))
        .await;
    }

    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn a_hostile_statement_cannot_write_through_a_read_only_postgres_connection() {
        rt().block_on(async {
            let probes = [PG_PROBE_DO_COMMIT, PG_PROBE_FUNCTION, PG_PROBE_CALL];
            let ids = format!("{}, {}, {}", probes[0], probes[1], probes[2]);
            pg_admin(&format!("DELETE FROM tracks WHERE id IN ({ids})")).await;
            let (dir, _paths) = saved("ro-hostile").await;
            let query = |q: String| {
                let dir = dir.clone();
                async move {
                    tool(
                        &dir,
                        "db_query",
                        serde_json::json!({"connection": "maestro", "query": q}),
                    )
                    .await
                }
            };

            // Reads run as before, each in its own read-only transaction, every column type
            // included (the server's one-statement check describes them all).
            let (status, r, _) =
                query("SELECT * FROM tracks WHERE id < 9000 ORDER BY id".into()).await;
            assert_eq!(status, 200, "{}", r.message);
            assert_eq!(
                r.data["results"][0]["rows"].as_array().unwrap().len(),
                6,
                "{}",
                r.message
            );

            // The first exploit: a DO block that turns the default off, commits and writes. DO
            // runs SQL no check can read, so it is refused before anything is sent.
            let (status, r, events) = query(format!(
                "DO $$ BEGIN PERFORM set_config('default_transaction_read_only', 'off', false); \
                 COMMIT; {}; END $$",
                insert(PG_PROBE_DO_COMMIT)
            ))
            .await;
            assert_eq!(status, 422, "{}", r.message);
            assert!(r.message.contains("`DO` is not available"), "{}", r.message);
            assert_eq!(events.len(), 1, "the user is shown the attempt");
            let (status, r, _) =
                query("SELECT set_config('transaction_read_only', 'off', false)".to_string()).await;
            assert_eq!(status, 422, "{}", r.message);

            // The same moves from code the database already holds, which no text check sees:
            // the server refuses them inside the statement's read-only transaction.
            let function = format!("agent_probe_rw_{}", std::process::id());
            pg_function(
                &function,
                &format!(
                    "PERFORM set_config('transaction_read_only', 'off', false); {};",
                    insert(PG_PROBE_FUNCTION)
                ),
            )
            .await;
            let (status, r, _) = query(format!("SELECT {function}()")).await;
            pg_admin(&format!("DROP FUNCTION IF EXISTS {function}()")).await;
            assert_eq!(status, 200, "a database error is a result: {}", r.message);
            assert!(r.message.contains("The database said:"), "{}", r.message);

            let proc_name = format!("agent_probe_commit_write_{}", std::process::id());
            pg_admin(&format!(
                "CREATE OR REPLACE PROCEDURE {proc_name}() LANGUAGE plpgsql AS $$ BEGIN \
                 PERFORM set_config('default_transaction_read_only', 'off', false); COMMIT; \
                 {}; END $$",
                insert(PG_PROBE_CALL)
            ))
            .await;
            let (status, r, _) = query(format!("CALL {proc_name}()")).await;
            pg_admin(&format!("DROP PROCEDURE IF EXISTS {proc_name}()")).await;
            assert_eq!(status, 200, "{}", r.message);
            assert!(
                r.message.contains("invalid transaction termination"),
                "{}",
                r.message
            );

            // A bare COMMIT ends only its own statement's transaction, which holds nothing.
            let (status, r, _) = query("COMMIT".to_string()).await;
            assert_eq!(status, 200, "{}", r.message);

            // Proven by absence.
            assert_eq!(
                rows_with(pg_admin(&format!(
                    "SELECT count(*) FROM tracks WHERE id IN ({ids})"
                )))
                .await,
                "0",
                "a probe row was written"
            );
            let _ = std::fs::remove_dir_all(dir);
        });
    }

    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn a_hostile_script_cannot_write_through_a_read_only_postgres_connection() {
        rt().block_on(async {
            let ids = format!("{PG_PROBE_FORGED}, {PG_PROBE_FORGED_IN_CODE}, {PG_PROBE_SMUGGLED}");
            pg_admin(&format!("DELETE FROM tracks WHERE id IN ({ids})")).await;
            let (dir, paths) = saved("ro-script").await;
            allow_scripts(&paths);
            let script = |q: String| {
                let dir = dir.clone();
                async move {
                    tool(
                        &dir,
                        "db_query",
                        serde_json::json!({"connection": "maestro", "query": q}),
                    )
                    .await
                }
            };

            // A measured exploit, as written: copy a run-scoped marker into the session, turn
            // the default off, COMMIT, write. set_config is refused before anything is sent.
            let (status, r, events) = script(format!(
                "SELECT set_config('agent_studio.read_only_run', \
                 current_setting('agent_studio.read_only_run', true), false), \
                 set_config('default_transaction_read_only', 'off', false); COMMIT; {}",
                insert(PG_PROBE_FORGED)
            ))
            .await;
            assert_eq!(status, 422, "{}", r.message);
            assert!(
                r.message.contains("`set_config` is not available"),
                "{}",
                r.message
            );
            assert!(events[0].payload["error"].is_string());

            // The same exploit from a function the database already holds, out of every text
            // check: each statement's transaction is rolled back, so nothing the function did to
            // the session reaches the INSERT's own read-only transaction, COMMIT or not.
            let forge = format!("agent_probe_forge_{}", std::process::id());
            pg_function(
                &forge,
                "PERFORM set_config('agent_studio.read_only_run', \
                 coalesce(current_setting('agent_studio.read_only_run', true), ''), false); \
                 PERFORM set_config('default_transaction_read_only', 'off', false);",
            )
            .await;
            let (status, r, _) = script(format!(
                "SELECT {forge}(); COMMIT; {}",
                insert(PG_PROBE_FORGED_IN_CODE)
            ))
            .await;
            assert_eq!(status, 200, "{}", r.message);
            assert!(
                r.message.contains("because the transaction is read-only"),
                "{}",
                r.message
            );

            // Statements smuggled past the splitter: it reads `texte'\'…` as an escape string,
            // the server (standard_conforming_strings on) as a typed literal, so the splitter
            // sees one statement where the server sees four. The server is asked first.
            let smuggled = format!(
                "SELECT texte'\\'; SELECT {forge}(); COMMIT; INSERT INTO tracks (id, title, \
                 ensemble, duration, tag) VALUES ({PG_PROBE_SMUGGLED}, $$agent$$, $$duo$$, 1, \
                 $$agent-write$$); SELECT 'x'"
            );
            assert_eq!(
                agent_studio_scaffold_lib::db::guard::split_statements(&smuggled).len(),
                1,
                "the splitter is fooled, which is the point of this probe"
            );
            let (status, r, _) = script(smuggled).await;
            pg_admin(&format!("DROP FUNCTION IF EXISTS {forge}()")).await;
            assert_eq!(status, 200, "{}", r.message);
            assert!(
                r.message.contains("more than one statement"),
                "{}",
                r.message
            );

            assert_eq!(
                rows_with(pg_admin(&format!(
                    "SELECT count(*) FROM tracks WHERE id IN ({ids})"
                )))
                .await,
                "0",
                "a probe row was written"
            );

            // Negative control: once the user makes the connection writable, the same path
            // writes — the transaction holds read-only, it does not invent it.
            edit_saved(&paths, |c| c.read_only = false);
            let (status, r, _) = tool(
                &dir,
                "db_query",
                serde_json::json!({"connection": "maestro", "query": insert(PG_PROBE_WRITABLE)}),
            )
            .await;
            let written = rows_with(pg_admin(&format!(
                "SELECT count(*) FROM tracks WHERE id = {PG_PROBE_WRITABLE}"
            )))
            .await;
            pg_admin(&format!(
                "DELETE FROM tracks WHERE id = {PG_PROBE_WRITABLE}"
            ))
            .await;
            assert_eq!(status, 200, "{}", r.message);
            assert!(r.message.contains("OK: 1 row affected."), "{}", r.message);
            assert_eq!(written, "1");
            let _ = std::fs::remove_dir_all(dir);
        });
    }

    #[test]
    #[ignore = "needs the Docker fixture — run with --ignored"]
    fn an_agent_cannot_reach_the_postgres_servers_programs_or_files() {
        rt().block_on(async {
            pg_admin(&format!("DELETE FROM tracks WHERE id = {PG_PROBE_PROGRAM}")).await;
            let reversed: String = PASSWORD.chars().rev().collect();
            let environ = "SELECT reverse(split_part(split_part(encode(pg_read_binary_file(\
                           '/proc/1/environ'), 'escape'), 'POSTGRES_PASSWORD=', 2), '\\000', 1)) \
                           AS x";
            // The exploits are real on this account: the fixture's user is a superuser, as local
            // accounts often are, and the console's own path reads the server's environment.
            let direct = pg_admin(environ).await;
            assert!(
                format!("{direct:?}").contains(&reversed),
                "the fixture is expected to read its own environment: {direct:?}"
            );

            let (dir, paths) = saved("server-side").await;
            let program = format!(
                "COPY (SELECT 1) TO PROGRAM 'psql -h 127.0.0.1 -U {USER} -d {DATABASE} -c \
                 \"INSERT INTO tracks (id, title, ensemble, duration, tag) VALUES \
                 ({PG_PROBE_PROGRAM}, ''agent'', ''duo'', 1, ''agent-write'')\"'"
            );
            // Read-only first, then writable: read-only is not what stops these.
            for writable in [false, true] {
                edit_saved(&paths, |c| c.read_only = !writable);
                for (q, what) in [
                    (program.as_str(), "`COPY` is not available"),
                    (environ, "`pg_read_binary_file` is not available"),
                    (
                        "/* x */ copy (select 1) to program 'true'",
                        "`COPY` is not available",
                    ),
                    (
                        "SELECT \"pg_read_file\"('/etc/hostname')",
                        "`pg_read_file` is not available",
                    ),
                ] {
                    let (status, r, events) = tool(
                        &dir,
                        "db_query",
                        serde_json::json!({"connection": "maestro", "query": q}),
                    )
                    .await;
                    assert_eq!(status, 422, "writable={writable} {q}: {}", r.message);
                    assert!(r.message.contains(what), "{}", r.message);
                    assert!(
                        r.message
                            .contains("an agent acts with the database account's privileges"),
                        "{}",
                        r.message
                    );
                    let seen = serde_json::to_string(&events).unwrap();
                    assert!(
                        !r.message.contains(&reversed)
                            && !r.data.to_string().contains(&reversed)
                            && !seen.contains(&reversed),
                        "the password reached the agent or the UI in another form"
                    );
                }
            }
            assert_eq!(
                rows_with(pg_admin(&format!(
                    "SELECT count(*) FROM tracks WHERE id = {PG_PROBE_PROGRAM}"
                )))
                .await,
                "0",
                "a program on the server wrote the probe row"
            );

            // Positive control: an ordinary read on the same connection runs.
            let (status, r, _) = tool(
                &dir,
                "db_query",
                serde_json::json!({"connection": "maestro", "query": "SELECT count(*) FROM tracks WHERE id < 9000"}),
            )
            .await;
            assert_eq!(status, 200, "{}", r.message);
            assert_eq!(r.data["results"][0]["rows"], serde_json::json!([["6"]]));
            let _ = std::fs::remove_dir_all(dir);
        });
    }

    /// The MySQL fixture's root, for what its ordinary account may not create (a stored function,
    /// with binary logging on). TEST FIXTURE ONLY — published in this repo, bound to localhost.
    async fn my_root(sql: &str) -> Vec<DbResultSet> {
        let mut cfg = super::db_live_mysql::config(false, "agentstudio-root-test-pw");
        cfg.user = "root".to_string();
        admin(cfg, sql).await
    }

    #[test]
    #[ignore = "needs the Docker fixture (mysql) — run with --ignored"]
    fn a_hostile_statement_cannot_write_through_a_read_only_mysql_connection() {
        rt().block_on(async {
            let ids = format!(
                "{MY_PROBE_SMUGGLED}, {MY_PROBE_EXECUTE}, {MY_PROBE_SCRIPT_COMMIT}, \
                 {MY_PROBE_CALL}, {MY_PROBE_EXEC_COMMENT}, {MY_PROBE_HIDDEN_CALL}"
            );
            let ddl_probe = format!("agent_probe_ddl_{}", std::process::id());
            let ddl_absent = || async {
                rows_with(my_admin(&format!(
                    "SELECT count(*) FROM information_schema.tables WHERE table_name = '{ddl_probe}'"
                )))
                .await
            };
            my_admin(&format!(
                "DELETE FROM tracks WHERE id IN ({ids}); DROP TABLE IF EXISTS {ddl_probe}"
            ))
            .await;
            let (dir, paths) = temp_paths("mysql-hostile");
            let url = format!("mysql://{USER}:{PASSWORD}@{HOST}:{MYSQL_PORT}/{DATABASE}");
            agent_studio_scaffold_lib::agent_ctl::commands::db::db_connect(
                &paths,
                &url,
                Some("Shop"),
                false,
            )
            .await
            .unwrap_or_else(|e| panic!("db connect refused the mysql fixture: {e}"));
            let replies = std::sync::Mutex::new(Vec::<String>::new());
            let query = |q: String| {
                let dir = dir.clone();
                let replies = &replies;
                async move {
                    let out = tool(
                        &dir,
                        "db_query",
                        serde_json::json!({"connection": "shop", "query": q}),
                    )
                    .await;
                    replies.lock().unwrap().push(out.1.message.clone());
                    out
                }
            };

            // Reads run, each in its read-only transaction, every column type included.
            let (status, r, _) = query("SELECT count(*) FROM tracks WHERE id < 9000".into()).await;
            assert_eq!(status, 200, "{}", r.message);
            assert_eq!(r.data["results"][0]["rows"], serde_json::json!([["6"]]));
            let (status, r, _) =
                query("SELECT * FROM tracks WHERE id < 9000 ORDER BY id".into()).await;
            assert_eq!(status, 200, "{}", r.message);
            assert_eq!(r.data["results"][0]["rows"].as_array().unwrap().len(), 6);
            // MySQL cannot prepare SHOW WARNINGS (1295): it is still one statement, and it runs.
            let (status, r, _) = query("SHOW WARNINGS".into()).await;
            assert_eq!(status, 200, "{}", r.message);
            assert_eq!(r.data["results"][0]["kind"], "rows", "{}", r.message);

            // One statement to the splitter (MySQL reads \' as an escaped quote, the splitter
            // does not), five to the server — COMMIT, read-write, write. The server is asked first.
            let smuggled = format!(
                "SELECT '\\'' ; COMMIT; SET SESSION TRANSACTION READ WRITE; INSERT INTO tracks \
                 (id, title, ensemble, duration, tag) VALUES ({MY_PROBE_SMUGGLED}, CHAR(97), \
                 CHAR(100,117,111), 1, CHAR(120)); SELECT 'x'"
            );
            assert_eq!(
                agent_studio_scaffold_lib::db::guard::split_statements(&smuggled).len(),
                1,
                "the splitter is fooled, which is the point of this probe"
            );
            let (status, r, _) = query(smuggled).await;
            assert_eq!(status, 200, "{}", r.message);
            assert!(r.message.contains("The database said:"), "{}", r.message);

            // An executable comment hides SQL from every check that reads the text.
            let (status, r, _) = query(format!(
                "SELECT 1 /*!50000 ; COMMIT; SET SESSION TRANSACTION READ WRITE; {} */",
                insert(MY_PROBE_EXEC_COMMENT)
            ))
            .await;
            assert_eq!(status, 422, "{}", r.message);
            assert!(r.message.contains("/*! … */"), "{}", r.message);

            // A procedure may COMMIT in MySQL: refused before it is called — also behind a `--`
            // the server reads as a comment because a control character follows it.
            let proc_name = format!("agent_probe_commit_write_{}", std::process::id());
            my_admin(&format!(
                "DROP PROCEDURE IF EXISTS {proc_name}; \
                 CREATE PROCEDURE {proc_name}() BEGIN COMMIT; SET SESSION TRANSACTION READ \
                 WRITE; {}; END",
                insert(MY_PROBE_CALL)
            ))
            .await;
            let mut calls = vec![format!("CALL {proc_name}()")];
            for hide in ["--\u{1}\n", "--\u{7f}\n", "--\r\n", "# x\n", "/* x */"] {
                calls.push(format!("{hide}CALL {proc_name}()"));
            }
            for call in calls {
                let (status, r, _) = query(call.clone()).await;
                assert_eq!(status, 422, "{call:?}: {}", r.message);
                assert!(r.message.contains("cannot `CALL`"), "{call:?}: {}", r.message);
            }
            // The measured bypass, exactly: its own procedure and probe row.
            let hidden = format!("agent_probe_hidden_call_{}", std::process::id());
            my_admin(&format!(
                "DROP PROCEDURE IF EXISTS {hidden}; \
                 CREATE PROCEDURE {hidden}() BEGIN COMMIT; SET SESSION TRANSACTION READ \
                 WRITE; {}; END",
                insert(MY_PROBE_HIDDEN_CALL)
            ))
            .await;
            let (status, r, _) = query(format!("--\u{1}\nCALL {hidden}()")).await;
            my_admin(&format!(
                "DROP PROCEDURE IF EXISTS {proc_name}; DROP PROCEDURE IF EXISTS {hidden}"
            ))
            .await;
            assert_eq!(status, 422, "{}", r.message);

            // Scripts: a prepared mode change, and a COMMIT between statements.
            allow_scripts(&paths);
            let (status, r, _) = query(format!(
                "PREPARE s FROM 'SET SESSION TRANSACTION READ WRITE'; EXECUTE s; COMMIT; {}",
                insert(MY_PROBE_EXECUTE)
            ))
            .await;
            assert_eq!(status, 422, "{}", r.message);
            assert!(r.message.contains("cannot `EXECUTE`"), "{}", r.message);
            // COMMIT ends only its own statement's transaction; the INSERT's is read-only.
            let (status, r, _) = query(format!(
                "SELECT 1; COMMIT; {}",
                insert(MY_PROBE_SCRIPT_COMMIT)
            ))
            .await;
            assert_eq!(status, 200, "{}", r.message);
            assert!(
                r.message.contains("because the transaction is read-only"),
                "{}",
                r.message
            );

            // A stored function can flip the SESSION read-write (ROLLBACK doesn't undo it in
            // MySQL) and DDL's implicit commit would then write; checked before each statement.
            let flip = format!("agent_probe_flip_{}", std::process::id());
            my_root(&format!(
                "DROP FUNCTION IF EXISTS {flip}; CREATE FUNCTION {flip}() RETURNS INT \
                 DETERMINISTIC NO SQL BEGIN SET SESSION TRANSACTION READ WRITE; RETURN 1; END"
            ))
            .await;
            let (status, r, _) =
                query(format!("SELECT {flip}(); CREATE TABLE {ddl_probe} (a INT)")).await;
            my_root(&format!("DROP FUNCTION IF EXISTS {flip}")).await;
            assert_eq!(status, 422, "{}", r.message);
            assert!(
                r.message.contains("turned this session's read-only off"),
                "{}",
                r.message
            );
            assert_eq!(ddl_absent().await, "0", "the DDL ran read-write");

            // What reaches the server's files or settings is refused, read-only or not.
            for q in [
                "SELECT LOAD_FILE('/etc/hostname')",
                "SELECT 1 INTO OUTFILE '/tmp/agent-probe'",
                "SET GLOBAL max_connections = 151",
            ] {
                let (status, r, _) = query(q.to_string()).await;
                assert_eq!(status, 422, "{q}: {}", r.message);
                assert!(r.message.contains("is not available to an agent"), "{}", r.message);
            }

            // No reply claims a rollback that this run did not measure.
            for reply in replies.lock().unwrap().iter() {
                assert!(!reply.contains("rolled back"), "{reply}");
            }
            assert_eq!(
                rows_with(my_admin(&format!(
                    "SELECT count(*) FROM tracks WHERE id IN ({ids})"
                )))
                .await,
                "0",
                "a probe row was written"
            );
            let _ = std::fs::remove_dir_all(dir);
        });
    }
}
