//! `db_connect` / `db_list` against temp stores: the URL → connection mapping, the refusals,
//! test-before-save, `force`, the duplicate check, and the replies and events through the dispatcher.
use super::*;
use crate::db::model::{DbEngineId, SslMode};

/// A fresh temp dir with every store in it — never the user's config dir.
fn temp_paths() -> (std::path::PathBuf, Paths) {
    let dir = std::env::temp_dir().join(format!("agentstudio-ctl-{}", ulid::Ulid::new()));
    std::fs::create_dir_all(&dir).unwrap();
    let paths = Paths::in_dir(&dir);
    (dir, paths)
}

/// A port nothing listens on (bound, then released).
fn dead_port() -> u16 {
    let l = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    l.local_addr().unwrap().port()
}

fn spec(id: DbEngineId) -> &'static EngineSpec {
    engines::spec_for(id).unwrap()
}

fn mapped(text: &str, name: Option<&str>) -> Result<DbConnectionInput, String> {
    let parsed = url::parse(text).unwrap();
    let split = url::split_url_credentials(text).unwrap();
    input_from_parsed(&parsed, &split, spec(parsed.engine.unwrap()), name)
}

#[test]
fn a_postgres_url_becomes_a_read_only_connection_without_its_password() {
    let input = mapped("postgres://app:s3cret@db.example.com:6543/shop", None).unwrap();
    assert_eq!(input.engine, DbEngineId::Postgres);
    assert_eq!(input.name, "shop@db.example.com");
    assert_eq!(input.host, "db.example.com");
    assert_eq!(input.port, Some(6543));
    assert_eq!(input.database, "shop");
    assert_eq!(input.user, "app");
    assert!(
        input.read_only,
        "an agent's connection must start read-only"
    );
    assert_eq!(input.save_password, SavePassword::Forever);
    assert!(input.password_ref.is_empty());
    let url = input.url.as_deref().unwrap();
    assert!(
        !url.contains("s3cret"),
        "the password stayed in the URL: {url}"
    );
    let pg = spec(DbEngineId::Postgres);
    assert_eq!(input.row_limit, pg.defaults.row_limit);
    assert_eq!(input.timeout_ms, pg.defaults.timeout_ms);
    assert_eq!(input.ssl_mode, pg.defaults.ssl_mode);
}

#[test]
fn a_query_parameter_password_keeps_its_placement_hint_and_a_name_wins() {
    let input = mapped(
        "postgresql://app@db.example.com/shop?password=s3cret&sslmode=require",
        Some("  Shop prod  "),
    )
    .unwrap();
    assert_eq!(input.name, "Shop prod");
    assert_eq!(input.password_param.as_deref(), Some("password"));
    assert_eq!(input.ssl_mode, SslMode::Require);
    assert!(!input.url.as_deref().unwrap().contains("s3cret"));
}

#[test]
fn an_engine_without_users_or_databases_gets_neither_and_is_named_by_host() {
    let input = mapped("redis://cache.internal:6380", None).unwrap();
    assert_eq!(input.engine, DbEngineId::Redis);
    assert!(input.user.is_empty());
    assert_eq!(input.name, "cache.internal");
}

#[test]
fn an_ssl_mode_the_engine_does_not_offer_is_refused_not_downgraded() {
    // Any engine that lacks some mode, and a parse that asks for exactly that mode.
    let all = [
        SslMode::Disable,
        SslMode::Prefer,
        SslMode::Require,
        SslMode::VerifyCa,
        SslMode::VerifyFull,
    ];
    let (s, missing) = engines::ENGINES
        .iter()
        .find_map(|s| {
            all.iter()
                .find(|m| !s.ssl_modes.contains(m))
                .map(|m| (s, *m))
        })
        .expect("some engine offers fewer than every mode");
    let parsed = ParsedUrl {
        engine: Some(s.id),
        family: Some(s.family),
        host: "h".into(),
        port: None,
        srv: false,
        database: String::new(),
        user: String::new(),
        had_password: false,
        password_param: None,
        ssl_mode: Some(missing),
        url: "x://h".into(),
        options: Default::default(),
    };
    let split = url::split_url_credentials("postgres://h/db").unwrap();
    let err = input_from_parsed(&parsed, &split, s, None).unwrap_err();
    assert!(err.contains("does not offer the SSL mode"), "{err}");
}

#[tokio::test]
async fn a_vault_reference_anywhere_in_the_url_is_refused_and_nothing_is_written() {
    let (dir, paths) = temp_paths();
    for text in [
        "postgres://app:{{PROD_PW}}@evil.example.com/shop",
        "postgres://app@evil.example.com/shop?password={{PROD_PW}}",
        "postgres://{{USER}}@evil.example.com/shop",
    ] {
        let err = db_connect(&paths, text, None, true).await.unwrap_err();
        assert!(err.contains("Vault variable"), "{text}: {err}");
    }
    assert!(db::store::load(&paths.store).connections.is_empty());
    assert!(!paths.vault.exists(), "the Vault was touched");
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn an_empty_or_unknown_url_is_explained() {
    let (dir, paths) = temp_paths();
    let err = db_connect(&paths, "   ", None, false).await.unwrap_err();
    assert!(err.contains("Give a connection URL"), "{err}");
    let err = db_connect(&paths, "oracle://h/db", None, false)
        .await
        .unwrap_err();
    assert!(!err.is_empty());
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn a_connection_that_fails_its_test_is_not_saved_unless_forced() {
    let (dir, paths) = temp_paths();
    let port = dead_port();
    let text = format!("postgres://app:s3cret@127.0.0.1:{port}/shop");

    let err = db_connect(&paths, &text, None, false).await.unwrap_err();
    assert!(err.starts_with("Could not connect to PostgreSQL"), "{err}");
    assert!(err.contains("Nothing was saved"), "{err}");
    assert!(err.contains("--force"), "{err}");
    assert!(
        !err.contains("s3cret"),
        "the password leaked into the error: {err}"
    );
    assert!(db::store::load(&paths.store).connections.is_empty());
    assert!(
        !paths.vault.exists(),
        "a refused connection wrote the Vault"
    );

    let report = db_connect(&paths, &text, None, true).await.unwrap();
    assert!(report.created);
    assert!(!report.test.as_ref().unwrap().ok);
    let saved = db::store::load(&paths.store).connections;
    assert_eq!(saved.len(), 1);
    let c = &saved[0];
    assert!(c.read_only);
    assert_eq!(c.password_ref, "{{SHOP_127_0_0_1_PASSWORD}}");

    // The password is in the Vault under that name, and in no file the connection lives in.
    let vault = crate::api_store::load(&paths.vault);
    assert_eq!(
        crate::db::secret::resolve(&c.password_ref, &vault).unwrap(),
        "s3cret"
    );
    let store_text = std::fs::read_to_string(&paths.store).unwrap();
    assert!(!store_text.contains("s3cret"), "{store_text}");

    // What the agent is shown names the Vault variable and never the value.
    let message = report.message();
    assert!(
        message.contains("WITHOUT a working connection"),
        "{message}"
    );
    assert!(message.contains("{{SHOP_127_0_0_1_PASSWORD}}"), "{message}");
    assert!(message.contains("read-only"), "{message}");
    let data = report.data().to_string();
    assert!(!message.contains("s3cret") && !data.contains("s3cret"));
    assert!(
        !data.contains("PASSWORD"),
        "the summary carries no reference: {data}"
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn an_already_saved_target_is_reported_and_left_exactly_as_it_was() {
    let (dir, paths) = temp_paths();
    let port = dead_port();
    let first = db_connect(
        &paths,
        &format!("postgres://app:one@127.0.0.1:{port}/shop"),
        Some("Mine"),
        true,
    )
    .await
    .unwrap();
    let before = std::fs::read(&paths.store).unwrap();
    let vault_before = std::fs::read(&paths.vault).unwrap();

    // Same server, database and user — another password, another case, no name.
    let again = db_connect(
        &paths,
        &format!("postgres://app:two@127.0.0.1:{port}/shop"),
        None,
        true,
    )
    .await
    .unwrap();
    assert!(!again.created);
    assert_eq!(again.connection.id, first.connection.id);
    assert!(again.test.is_none());
    assert!(again
        .message()
        .contains("Already in Agent Studio as \"Mine\""));
    assert_eq!(
        std::fs::read(&paths.store).unwrap(),
        before,
        "the store changed"
    );
    assert_eq!(
        std::fs::read(&paths.vault).unwrap(),
        vault_before,
        "the Vault changed"
    );

    // Another user on the same server is another connection.
    let other = db_connect(
        &paths,
        &format!("postgres://reporting:x@127.0.0.1:{port}/shop"),
        None,
        true,
    )
    .await
    .unwrap();
    assert!(other.created);
    assert_eq!(db::store::load(&paths.store).connections.len(), 2);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn the_default_port_and_an_explicit_one_are_the_same_target() {
    let pg = spec(DbEngineId::Postgres);
    let a = mapped("postgres://app@db.example.com/shop", None).unwrap();
    let b = mapped("postgres://app@DB.example.com:5432/shop", None).unwrap();
    let record = |i: &DbConnectionInput| DbConnection {
        id: "x".into(),
        name: i.name.clone(),
        engine: i.engine,
        family: pg.family,
        host: i.host.clone(),
        port: i.port,
        database: i.database.clone(),
        user: i.user.clone(),
        password_ref: String::new(),
        save_password: i.save_password,
        url: i.url.clone(),
        srv: i.srv,
        ssl_mode: i.ssl_mode,
        ca_summary: None,
        options: Default::default(),
        read_only: true,
        row_limit: 1,
        timeout_ms: 1,
        allow_multi_statement: false,
        created_at: 0,
        updated_at: 0,
    };
    assert!(same_target(&record(&a), &b, pg));
    let c = mapped("postgres://app@db.example.com:5433/shop", None).unwrap();
    assert!(!same_target(&record(&a), &c, pg));
}

#[test]
fn a_long_server_banner_is_cut_to_its_product_and_version() {
    assert_eq!(
        short_version("PostgreSQL 16.4 on aarch64-unknown-linux-musl, compiled by gcc"),
        "PostgreSQL 16.4"
    );
    assert_eq!(short_version("8.4.2"), "8.4.2");
}

#[tokio::test]
async fn the_tools_answer_through_the_dispatcher_and_emit_the_panel_event() {
    let (dir, _paths) = temp_paths();
    let (ctx, rec) = crate::agent_ctl::tests::ctx(&dir, "term-7");
    let call = |tool: &str, args: serde_json::Value| {
        serde_json::to_vec(&serde_json::json!({"tool": tool, "args": args})).unwrap()
    };

    let (status, empty) =
        crate::agent_ctl::handle(ctx.clone(), &call("db_list", serde_json::json!({}))).await;
    assert_eq!(status, 200);
    assert!(empty.message.starts_with("No database connections"));
    assert_eq!(empty.data, serde_json::json!([]));

    let (status, refused) = crate::agent_ctl::handle(
        ctx.clone(),
        &call(
            "db_connect",
            serde_json::json!({"url": "postgres://a:{{X}}@h/db"}),
        ),
    )
    .await;
    assert_eq!(status, 422);
    assert!(refused.message.contains("Vault variable"));
    assert!(rec.0.lock().unwrap().is_empty(), "a refusal emits nothing");

    let port = dead_port();
    let (status, created) = crate::agent_ctl::handle(
        ctx.clone(),
        &call(
            "db_connect",
            serde_json::json!({"url": format!("postgres://app:pw@127.0.0.1:{port}/shop"), "force": true}),
        ),
    )
    .await;
    assert_eq!(status, 200, "{:?}", created);
    let id = created.data["connection"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let events = rec.0.lock().unwrap().clone();
    assert_eq!(events.len(), 1);
    assert_eq!(
        serde_json::to_value(&events[0]).unwrap(),
        serde_json::json!({
            "kind": "dbConnection",
            "terminalId": "term-7",
            "connectionId": id,
            "created": true,
        })
    );

    let (_, listed) = crate::agent_ctl::handle(ctx, &call("db_list", serde_json::json!({}))).await;
    assert!(listed
        .message
        .contains("1 database connection in Agent Studio:"));
    assert!(listed.message.contains("shop@127.0.0.1"));
    assert_eq!(listed.data.as_array().unwrap().len(), 1);
    assert!(!listed.data.to_string().contains("pw"));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn the_details_name_every_scheme_the_registry_parses() {
    let details = TOOLS
        .iter()
        .find(|t| t.name == "db_connect")
        .unwrap()
        .details;
    for spec in engines::ENGINES {
        for scheme in spec.url_schemes {
            assert!(
                details.contains(&format!("{scheme}://")),
                "{scheme} missing"
            );
        }
    }
}

/// The help an agent (and the user reading over its shoulder) gets must not promise more than the
/// code holds: read-only stops data writes, the text refusals are not a boundary, the mask covers
/// two forms of the password, and the account's privileges are the real limit.
#[test]
fn the_query_help_states_the_real_boundary_and_claims_nothing_more() {
    let details = |name: &str| TOOLS.iter().find(|t| t.name == name).unwrap().details;
    let query = details("db_query");
    for said in [
        "each statement runs in a read-only transaction of its own, ended (with a rollback) \
         before the next one starts",
        "Read-only stops data writes, not everything",
        "an agent acts with the database account's privileges",
        "use a least-privileged account for agent work",
        "A text check, not a boundary",
        "where it appears as written or URL-encoded",
        "can still read secrets the server holds",
    ] {
        assert!(query.contains(said), "db_query's help does not say: {said}");
    }
    for overclaim in ["never appears", "cannot commit", "never reaches"] {
        assert!(
            !query.contains(overclaim),
            "db_query's help claims: {overclaim}"
        );
    }
    let console = details("db_console");
    assert!(console.contains("left as it is"), "{console}");
    assert!(!console.contains("added below"), "{console}");
}
