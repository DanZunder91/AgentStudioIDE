//! The database tools after `db_connect`, hermetically.
//!
//! Two kinds of test, both without Docker or a network:
//! * the pure parts — which connection a name means, the tree walk and search over an in-memory
//!   tree, the caps and the table — against fixed inputs;
//! * the tools end to end, through the real dispatcher, the real DB client (`db::open`,
//!   `db::query`, `db::children`) and the real Redis engine, against a small RESP server in this
//!   process. Redis because its driver speaks raw TCP: no HTTP proxy in the environment can sit
//!   between the test and its server. It records every command it receives, which is what lets a
//!   refusal be proven by **absence**: the write never reached the server.
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::db_browse::{self, CutShort, SearchLimits, TreeSource};
use super::db_run::{self, QueryReport};
use super::db_saved;
use super::db_target;
use super::*;
use crate::db::error::DbError;
use crate::db::model::{DbEngineId, DbRunMode};
use crate::db::result::{DbCellKind, DbColumn, DbResultKind, DbResultSet};
use crate::db::tree::{DbGroup, DbNode, DbNodeKind, DbNodeRef};

/* ───────────────────────────── fixtures ───────────────────────────── */

fn temp_paths() -> (std::path::PathBuf, Paths) {
    let dir = std::env::temp_dir().join(format!("agentstudio-dbtools-{}", ulid::Ulid::new()));
    std::fs::create_dir_all(&dir).unwrap();
    let paths = Paths::in_dir(&dir);
    (dir, paths)
}

fn dead_port() -> u16 {
    let l = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    l.local_addr().unwrap().port()
}

/// Save a connection the way `db connect` maps a URL, with the access and multi-statement
/// settings a test needs. `url` may carry a password; it goes to the Vault.
fn save(paths: &Paths, url_text: &str, name: &str, read_only: bool, multi: bool) -> DbConnection {
    let parsed = url::parse(url_text).unwrap();
    let split = url::split_url_credentials(url_text).unwrap();
    let spec = engines::spec_for(parsed.engine.unwrap()).unwrap();
    let mut input = input_from_parsed(&parsed, &split, spec, Some(name)).unwrap();
    input.read_only = read_only;
    input.allow_multi_statement = multi;
    db::upsert(paths, input, split.password.as_deref()).unwrap()
}

fn conn(id: &str, name: &str) -> DbConnection {
    DbConnection {
        id: id.into(),
        name: name.into(),
        engine: DbEngineId::Postgres,
        family: engines::spec_for(DbEngineId::Postgres).unwrap().family,
        host: "db.example.com".into(),
        port: Some(5432),
        database: "shop".into(),
        user: "app".into(),
        password_ref: "{{SHOP_PASSWORD}}".into(),
        save_password: SavePassword::Forever,
        url: Some("postgresql://app:{{SHOP_PASSWORD}}@db.example.com/shop".into()),
        srv: false,
        ssl_mode: engines::spec_for(DbEngineId::Postgres)
            .unwrap()
            .defaults
            .ssl_mode,
        ca_summary: None,
        options: Default::default(),
        read_only: true,
        row_limit: 500,
        timeout_ms: 30_000,
        allow_multi_statement: false,
        created_at: 0,
        updated_at: 0,
    }
}

/// A RESP2 server in this process: enough of Redis for the engine's open (`INFO`), the tree
/// (`DBSIZE`, `SCAN`, `TYPE`) and a few reads. Every command it receives is recorded.
struct FakeRedis {
    port: u16,
    seen: Arc<Mutex<Vec<String>>>,
}

impl FakeRedis {
    async fn start() -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen: Arc<Mutex<Vec<String>>> = Arc::default();
        let s = seen.clone();
        tokio::spawn(async move {
            while let Ok((sock, _)) = listener.accept().await {
                tokio::spawn(serve(sock, s.clone()));
            }
        });
        Self { port, seen }
    }

    fn url(&self) -> String {
        format!("redis://127.0.0.1:{}", self.port)
    }

    /// The command names received so far, upper-cased.
    fn names(&self) -> Vec<String> {
        self.seen
            .lock()
            .unwrap()
            .iter()
            .map(|c| c.split(' ').next().unwrap_or_default().to_ascii_uppercase())
            .collect()
    }
}

/// The password a test connection to the fake can carry. It goes to the Vault like any other,
/// and the fake hands it back — from `GET leak` and inside a key's name — so the masking of every
/// reply can be seen.
const FAKE_PW: &str = "fake-redis-pw-7Q";

/// The keys the fake holds: `greeting` (a string), `big` (a 1500-item list), `slow` (a string
/// whose `GET` never answers in time), `user/1` (a name with a `/` in it) and one named after
/// [`FAKE_PW`].
fn keys() -> BTreeMap<&'static str, &'static str> {
    BTreeMap::from([
        ("big", "list"),
        ("greeting", "string"),
        ("slow", "string"),
        ("token:fake-redis-pw-7Q", "string"),
        ("user/1", "hash"),
    ])
}

async fn serve(mut sock: tokio::net::TcpStream, seen: Arc<Mutex<Vec<String>>>) {
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        while let Some((cmd, used)) = parse_resp(&buf) {
            buf.drain(..used);
            seen.lock().unwrap().push(cmd.join(" "));
            let reply = answer(&cmd).await;
            if sock.write_all(&reply).await.is_err() {
                return;
            }
        }
        match sock.read(&mut chunk).await {
            Ok(0) | Err(_) => return,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
    }
}

/// One complete command at the head of `buf` (an array of bulk strings), and its length.
fn parse_resp(buf: &[u8]) -> Option<(Vec<String>, usize)> {
    let line = |from: usize| -> Option<(&[u8], usize)> {
        let end = buf.get(from..)?.windows(2).position(|w| w == b"\r\n")? + from;
        Some((&buf[from..end], end + 2))
    };
    let (head, mut pos) = line(0)?;
    let n: usize = std::str::from_utf8(head.get(1..)?).ok()?.parse().ok()?;
    let mut out = Vec::with_capacity(n);
    for _ in 0..n {
        let (h, next) = line(pos)?;
        let len: usize = std::str::from_utf8(h.get(1..)?).ok()?.parse().ok()?;
        let data = buf.get(next..next + len)?;
        buf.get(next + len..next + len + 2)?;
        out.push(String::from_utf8_lossy(data).into_owned());
        pos = next + len + 2;
    }
    Some((out, pos))
}

fn bulk(s: &str) -> Vec<u8> {
    format!("${}\r\n{s}\r\n", s.len()).into_bytes()
}

fn array(items: &[String]) -> Vec<u8> {
    let mut out = format!("*{}\r\n", items.len()).into_bytes();
    for i in items {
        out.extend(bulk(i));
    }
    out
}

async fn answer(cmd: &[String]) -> Vec<u8> {
    let arg = |i: usize| cmd.get(i).map(String::as_str).unwrap_or_default();
    match cmd[0].to_ascii_uppercase().as_str() {
        "INFO" => bulk("# Server\r\nredis_version:7.4.0\r\n"),
        "PING" => b"+PONG\r\n".to_vec(),
        "GET" if arg(1) == "slow" => {
            tokio::time::sleep(Duration::from_secs(30)).await;
            bulk("late")
        }
        "GET" if arg(1) == "greeting" => bulk("hello\tworld"),
        "GET" if arg(1) == "leak" => bulk(FAKE_PW),
        "CONFIG" => array(&["requirepass".to_string(), FAKE_PW.to_string()]),
        "GET" => b"$-1\r\n".to_vec(),
        "DBSIZE" => format!(":{}\r\n", keys().len()).into_bytes(),
        "SCAN" => {
            let mut out = b"*2\r\n".to_vec();
            out.extend(bulk("0"));
            out.extend(array(
                &keys().keys().map(|k| k.to_string()).collect::<Vec<_>>(),
            ));
            out
        }
        "TYPE" => format!("+{}\r\n", keys().get(arg(1)).unwrap_or(&"none")).into_bytes(),
        "LRANGE" => array(
            &(1..=1500)
                .map(|i| format!("item-{i:04}"))
                .collect::<Vec<_>>(),
        ),
        _ => b"+OK\r\n".to_vec(),
    }
}

/// Call a tool through the real dispatcher with a recording UI.
async fn call(
    dir: &std::path::Path,
    tool: &str,
    args: serde_json::Value,
) -> (
    u16,
    crate::agent_ctl::CtlResponse,
    Vec<crate::agent_ctl::CtlEvent>,
) {
    let (ctx, rec) = crate::agent_ctl::tests::ctx(dir, "term-4");
    let body = serde_json::to_vec(&serde_json::json!({"tool": tool, "args": args})).unwrap();
    let (status, reply) = crate::agent_ctl::handle(ctx, &body).await;
    let events = rec.0.lock().unwrap().clone();
    (status, reply, events)
}

/* ───────────────────────── which connection ───────────────────────── */

#[test]
fn a_connection_is_found_by_id_or_by_name_in_any_case() {
    let saved = vec![
        conn("01HAAA", "Orders"),
        conn("01HBBB", "Analytics"),
        conn("01HCCC", "  Cache "),
    ];
    assert_eq!(db_target::resolve(&saved, "01hbbb").unwrap().id, "01HBBB");
    assert_eq!(db_target::resolve(&saved, "orders").unwrap().id, "01HAAA");
    assert_eq!(db_target::resolve(&saved, " ORDERS ").unwrap().id, "01HAAA");
    assert_eq!(db_target::resolve(&saved, "cache").unwrap().id, "01HCCC");
}

#[test]
fn an_unknown_or_ambiguous_name_is_refused_with_the_saved_names_never_guessed() {
    let saved = vec![
        conn("01HAAA", "Orders"),
        conn("01HBBB", "orders"),
        conn("01HCCC", "Analytics"),
    ];
    let err = db_target::resolve(&saved, "ORDERS").unwrap_err();
    assert!(err.contains("names 2 saved connections"), "{err}");
    assert!(
        err.contains("01HAAA") && err.contains("01HBBB"),
        "both ids: {err}"
    );
    assert!(err.contains("Use the id"), "{err}");

    let err = db_target::resolve(&saved, "billing").unwrap_err();
    assert!(
        err.contains("no saved connection named \"billing\""),
        "{err}"
    );
    assert!(
        err.contains("\"Orders\"") && err.contains("\"Analytics\""),
        "{err}"
    );

    let err = db_target::resolve(&saved, "  ").unwrap_err();
    assert!(err.starts_with("Name a saved connection"), "{err}");

    let err = db_target::resolve(&[], "orders").unwrap_err();
    assert!(
        err.starts_with("No database connections are saved"),
        "{err}"
    );

    // A long list is bounded and says how many it left out.
    let many: Vec<DbConnection> = (0..45)
        .map(|i| conn(&format!("id{i}"), &format!("db{i}")))
        .collect();
    let err = db_target::resolve(&many, "nope").unwrap_err();
    assert!(err.contains("and 15 more"), "{err}");

    // Nothing an error names is a secret: the reference and the URL never appear.
    for e in [
        db_target::resolve(&saved, "ORDERS").unwrap_err(),
        db_target::resolve(&saved, "x").unwrap_err(),
    ] {
        assert!(!e.contains("{{") && !e.contains("postgresql://"), "{e}");
    }
}

#[test]
fn a_connection_without_a_stored_password_explains_why_an_agent_cannot_open_it() {
    let mut c = conn("01HAAA", "Orders");
    let plain = db_target::connect_failure(&c, "refused.");
    assert!(plain.starts_with("Could not connect to \"Orders\" (PostgreSQL at db.example.com:5432/shop, read-only): refused."), "{plain}");
    assert!(!plain.contains("Vault"), "{plain}");
    c.save_password = SavePassword::Never;
    assert!(db_target::connect_failure(&c, "auth.").contains("does not keep its password"));
    assert!(
        db_target::stopped_waiting("the query", Duration::from_millis(10)).contains("after 1 s")
    );
}

/* ──────────────────────── the tree, in memory ──────────────────────── */

/// A PostgreSQL-shaped tree: maestro › {public, audit} › {Tables, Views} › tables › columns.
/// `audit` cannot be read. `delay` slows every level; `calls` counts them.
struct FakeTree {
    levels: Vec<(DbNodeRef, Result<Vec<DbNode>, String>)>,
    delay: Duration,
    calls: usize,
}

fn table_ref(name: &str) -> DbNodeRef {
    DbNodeRef::Table {
        database: "maestro".into(),
        schema: Some("public".into()),
        name: name.into(),
    }
}

fn group_ref(group: DbGroup) -> DbNodeRef {
    DbNodeRef::Group {
        database: "maestro".into(),
        schema: Some("public".into()),
        group,
    }
}

fn column(table: &str, name: &str, ty: &str) -> DbNode {
    DbNode::column("maestro", Some("public"), table, name, ty, true)
}

fn fake_tree() -> FakeTree {
    let db = DbNodeRef::Database {
        name: "maestro".into(),
    };
    let public = DbNodeRef::Schema {
        database: "maestro".into(),
        name: "public".into(),
    };
    let audit = DbNodeRef::Schema {
        database: "maestro".into(),
        name: "audit".into(),
    };
    FakeTree {
        levels: vec![
            (
                DbNodeRef::Root,
                Ok(vec![DbNode::new(
                    db.clone(),
                    "maestro",
                    DbNodeKind::Database,
                    true,
                )
                .with_sub_label("the connected database")]),
            ),
            (
                db,
                Ok(vec![
                    DbNode::new(audit.clone(), "audit", DbNodeKind::Schema, true),
                    DbNode::new(public.clone(), "public", DbNodeKind::Schema, true),
                ]),
            ),
            (audit, Err("permission denied for schema audit".into())),
            (
                public,
                Ok(vec![
                    DbNode::new(
                        group_ref(DbGroup::Tables),
                        "Tables",
                        DbNodeKind::Group,
                        true,
                    ),
                    DbNode::new(group_ref(DbGroup::Views), "Views", DbNodeKind::Group, true),
                ]),
            ),
            (
                group_ref(DbGroup::Tables),
                Ok(vec![
                    DbNode::new(table_ref("tall"), "tall", DbNodeKind::Table, true),
                    DbNode::new(table_ref("tracks"), "tracks", DbNodeKind::Table, true),
                ]),
            ),
            (
                group_ref(DbGroup::Views),
                Ok(vec![DbNode::new(
                    table_ref("v_tracks"),
                    "v_tracks",
                    DbNodeKind::View,
                    true,
                )]),
            ),
            (
                table_ref("tracks"),
                Ok(vec![
                    column("tracks", "id", "integer"),
                    column("tracks", "title", "varchar(16)"),
                    column("tracks", "track_no", "integer"),
                ]),
            ),
            (table_ref("tall"), Ok(vec![column("tall", "label", "text")])),
            (
                table_ref("v_tracks"),
                Ok(vec![column("v_tracks", "id", "integer")]),
            ),
        ],
        delay: Duration::ZERO,
        calls: 0,
    }
}

#[async_trait]
impl TreeSource for FakeTree {
    async fn children(&mut self, node: &DbNodeRef) -> Result<Vec<DbNode>, DbError> {
        self.calls += 1;
        if !self.delay.is_zero() {
            tokio::time::sleep(self.delay).await;
        }
        match self.levels.iter().find(|(r, _)| r == node) {
            Some((_, Ok(kids))) => Ok(kids.clone()),
            Some((_, Err(e))) => Err(DbError::not_found(e.clone())),
            None => Ok(Vec::new()),
        }
    }
}

#[tokio::test]
async fn a_path_walks_down_by_label_in_any_case_and_through_folders_it_leaves_out() {
    let mut tree = fake_tree();
    let (node, path, stated) = db_browse::walk_to(&mut tree, "").await.unwrap();
    assert_eq!((node, path.as_str(), stated), (DbNodeRef::Root, "", None));

    let (node, path, _) = db_browse::walk_to(&mut tree, "maestro/public/Tables/tracks")
        .await
        .unwrap();
    assert_eq!(node, table_ref("tracks"));
    assert_eq!(path, "maestro/public/Tables/tracks");

    // Any case, stray slashes, and the folder level left out: the reply names the real path.
    let (node, path, _) = db_browse::walk_to(&mut tree, "/MAESTRO/Public//v_tracks/")
        .await
        .unwrap();
    assert_eq!(node, table_ref("v_tracks"));
    assert_eq!(path, "maestro/public/Views/v_tracks");
}

#[tokio::test]
async fn a_path_that_goes_nowhere_says_what_is_there_instead() {
    let mut tree = fake_tree();
    let err = db_browse::walk_to(&mut tree, "maestro/nope")
        .await
        .unwrap_err();
    assert_eq!(
        err,
        "There is no \"nope\" in \"maestro\". It has: audit, public."
    );
    let err = db_browse::walk_to(&mut tree, "nope").await.unwrap_err();
    assert!(err.contains("in the top level. It has: maestro"), "{err}");
    let err = db_browse::walk_to(&mut tree, "maestro/public/tracks/title")
        .await
        .unwrap_err();
    assert_eq!(
        err,
        "\"maestro/public/Tables/tracks/title\" is a column and has nothing below it."
    );
    let err = db_browse::walk_to(&mut tree, "maestro/audit/x")
        .await
        .unwrap_err();
    assert_eq!(
        err,
        "Could not read \"maestro/audit\": permission denied for schema audit"
    );
    let err = db_browse::walk_to(&mut tree, "maestro/public/tracks/x/y")
        .await
        .unwrap_err();
    assert!(err.contains("It has: id, title, track_no"), "{err}");

    // A folder that cannot be read while looking through it is reported, not skipped.
    let mut broken = fake_tree();
    broken
        .levels
        .retain(|(r, _)| *r != group_ref(DbGroup::Tables));
    broken
        .levels
        .push((group_ref(DbGroup::Tables), Err("gone".into())));
    let err = db_browse::walk_to(&mut broken, "maestro/public/tracks")
        .await
        .unwrap_err();
    assert_eq!(err, "Could not read \"Tables\": gone");
}

#[tokio::test]
async fn a_level_lists_names_kinds_details_and_the_path_inside_each() {
    let c = conn("01HAAA", "Orders");
    let mut tree = fake_tree();
    let (message, data) = db_browse::schema(&mut tree, &c, "maestro/public/tracks")
        .await
        .unwrap();
    assert!(message.starts_with(
        "\"Orders\" (PostgreSQL at db.example.com:5432/shop, read-only) › maestro/public/Tables/tracks:"
    ), "{message}");
    assert!(message.contains("  column  id  — integer"), "{message}");
    assert!(message.contains("3 items."), "{message}");
    assert!(
        !message.contains("Look inside"),
        "columns are leaves: {message}"
    );
    assert_eq!(data["path"], "maestro/public/Tables/tracks");
    assert_eq!(data["items"][1]["name"], "title");
    assert_eq!(data["items"][1]["kind"], "column");
    assert_eq!(data["items"][1]["detail"], "varchar(16)");
    assert_eq!(
        data["items"][1]["path"],
        "maestro/public/Tables/tracks/title"
    );
    assert_eq!(data["truncated"], false);
    assert!(!data.to_string().contains("{{"), "no Vault reference");

    let (message, data) = db_browse::schema(&mut tree, &c, "").await.unwrap();
    assert!(message.contains("› top level:"), "{message}");
    assert!(
        message.contains("database  maestro  — the connected database"),
        "{message}"
    );
    assert!(message.contains("1 item."), "{message}");
    assert!(
        message.contains("agent-studio db schema 'Orders' --path 'maestro'"),
        "{message}"
    );
    assert_eq!(data["items"][0]["expandable"], true);

    let (message, _) = db_browse::schema(&mut tree, &c, "maestro/public/tall")
        .await
        .unwrap();
    assert!(message.contains("1 item."), "{message}");

    // An empty level, and an unreadable one.
    let mut empty = fake_tree();
    empty.levels.retain(|(r, _)| *r != table_ref("tall"));
    let (message, data) = db_browse::schema(&mut empty, &c, "maestro/public/tall")
        .await
        .unwrap();
    assert!(message.ends_with("Nothing here."), "{message}");
    assert_eq!(data["total"], 0);
    assert!(db_browse::schema(&mut tree, &c, "maestro/audit")
        .await
        .unwrap_err()
        .contains("Could not read \"maestro/audit\""));
}

#[tokio::test]
async fn a_huge_level_is_capped_at_500_items_and_says_so() {
    let c = conn("01HAAA", "Orders");
    let mut tree = fake_tree();
    let wide: Vec<DbNode> = (0..1200)
        .map(|i| column("tall", &format!("c{i:04}_{}", "x".repeat(60)), "integer"))
        .collect();
    tree.levels.retain(|(r, _)| *r != table_ref("tall"));
    tree.levels.push((table_ref("tall"), Ok(wide)));
    let (message, data) = db_browse::schema(&mut tree, &c, "maestro/public/tall")
        .await
        .unwrap();
    assert!(message.contains("1200 items."), "{message}");
    assert!(
        message.contains("Only the first 500 are listed"),
        "{message}"
    );
    assert_eq!(data["items"].as_array().unwrap().len(), 500);
    assert_eq!(data["truncated"], true);
    assert!(message.len() <= TEXT_BUDGET + 4096);
}

#[tokio::test]
async fn search_finds_every_table_before_any_column_and_reports_what_it_could_not_read() {
    let c = conn("01HAAA", "Orders");
    let mut tree = fake_tree();
    let out = db_browse::search(
        &mut tree,
        DbNodeRef::Root,
        "",
        None,
        "TRACK",
        SearchLimits::default(),
    )
    .await;
    let paths: Vec<&str> = out.found.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(
        paths,
        [
            "maestro/public/Tables/tracks",
            "maestro/public/Views/v_tracks",
            "maestro/public/Tables/tracks/track_no",
        ]
    );
    assert_eq!(out.cut, None);
    assert_eq!(out.unreadable_count, 1);
    // Folders are not matches even when their label contains the text.
    let folders = db_browse::search(
        &mut fake_tree(),
        DbNodeRef::Root,
        "",
        None,
        "tables",
        SearchLimits::default(),
    )
    .await;
    assert!(folders.found.is_empty());

    let (message, data) = db_browse::search_reply(
        &c,
        "TRACK",
        "",
        &out,
        SearchLimits::default(),
        Duration::from_millis(300),
    );
    assert!(
        message.starts_with("3 matches for \"TRACK\" in \"Orders\""),
        "{message}"
    );
    assert!(
        message.contains("  table   maestro/public/Tables/tracks"),
        "{message}"
    );
    assert!(
        message.contains("  column  maestro/public/Tables/tracks/track_no  — integer"),
        "{message}"
    );
    assert!(
        message.contains(
            "1 level could not be read: \"maestro/audit\": permission denied for schema audit"
        ),
        "{message}"
    );
    assert_eq!(
        data["complete"], false,
        "an unreadable level is not complete"
    );
    assert_eq!(data["cutShort"], serde_json::Value::Null);
    assert_eq!(data["matches"][2]["kind"], "column");

    let none = db_browse::search(
        &mut fake_tree(),
        table_ref("tracks"),
        "maestro/public/Tables/tracks",
        None,
        "zzz",
        SearchLimits::default(),
    )
    .await;
    let (message, data) = db_browse::search_reply(
        &c,
        "zzz",
        "maestro/public/Tables/tracks",
        &none,
        SearchLimits::default(),
        Duration::from_millis(5),
    );
    assert!(message.starts_with("0 matches for \"zzz\" in \"Orders\" (PostgreSQL at db.example.com:5432/shop, read-only) under \"maestro/public/Tables/tracks\" (1 level read"), "{message}");
    assert!(message.ends_with("s)."), "{message}");
    assert_eq!(data["complete"], true);
}

#[tokio::test]
async fn a_search_that_stops_early_says_why_and_never_reads_past_its_limits() {
    let c = conn("01HAAA", "Orders");
    let limits = SearchLimits {
        lookups: 3,
        ..SearchLimits::default()
    };
    let mut tree = fake_tree();
    let out = db_browse::search(&mut tree, DbNodeRef::Root, "", None, "t", limits).await;
    assert_eq!(out.cut, Some(CutShort::Lookups));
    assert_eq!(tree.calls, 3);
    let (message, data) =
        db_browse::search_reply(&c, "t", "", &out, limits, Duration::from_secs(1));
    assert!(
        message.contains("The search stopped early: it read its limit of 3 levels."),
        "{message}"
    );
    assert_eq!(data["cutShort"], "lookups");

    // Exactly enough lookups to read everything is not a cut.
    let enough = SearchLimits {
        lookups: 9,
        ..SearchLimits::default()
    };
    let out = db_browse::search(&mut fake_tree(), DbNodeRef::Root, "", None, "zzz", enough).await;
    assert_eq!((out.cut, out.lookups), (None, 9));

    let few = SearchLimits {
        matches: 2,
        ..SearchLimits::default()
    };
    let out = db_browse::search(&mut fake_tree(), DbNodeRef::Root, "", None, "t", few).await;
    assert_eq!(out.cut, Some(CutShort::Matches));
    assert_eq!(out.found.len(), 2);
    let (message, _) = db_browse::search_reply(&c, "t", "", &out, few, Duration::ZERO);
    assert!(
        message.contains("it found its limit of 2 matches"),
        "{message}"
    );

    let quick = SearchLimits {
        time: Duration::from_millis(60),
        ..SearchLimits::default()
    };
    let mut slow = fake_tree();
    slow.delay = Duration::from_millis(400);
    let started = std::time::Instant::now();
    let out = db_browse::search(&mut slow, DbNodeRef::Root, "", None, "t", quick).await;
    assert_eq!(out.cut, Some(CutShort::Time));
    assert!(
        started.elapsed() < Duration::from_millis(350),
        "the time limit was not kept"
    );
    let (message, data) = db_browse::search_reply(&c, "t", "", &out, quick, Duration::ZERO);
    assert!(message.contains("it ran for its limit of 0 s"), "{message}");
    assert_eq!(data["cutShort"], "time");

    // A limit already spent before a level starts.
    let spent = SearchLimits {
        time: Duration::ZERO,
        ..SearchLimits::default()
    };
    let out = db_browse::search(&mut fake_tree(), DbNodeRef::Root, "", None, "t", spent).await;
    assert_eq!((out.cut, out.lookups), (Some(CutShort::Time), 0));

    // Depth: a search that may not go below the top finds only what the top level holds.
    let shallow = SearchLimits {
        depth: 1,
        ..SearchLimits::default()
    };
    let out = db_browse::search(&mut fake_tree(), DbNodeRef::Root, "", None, "a", shallow).await;
    assert_eq!(out.lookups, 1);
    assert_eq!(out.found.len(), 1, "{:?}", out.found);
}

#[tokio::test]
async fn a_level_the_tree_lists_only_one_page_of_is_said_in_schema_and_search() {
    let c = conn("01HAAA", "Orders");
    let public = DbNodeRef::Schema {
        database: "maestro".into(),
        name: "public".into(),
    };
    // The folder says 5013 and lists one: the Redis shape (one SCAN page per level).
    let mut tree = fake_tree();
    tree.levels
        .retain(|(r, _)| *r != group_ref(DbGroup::Tables) && *r != public);
    tree.levels.push((
        public,
        Ok(vec![DbNode::new(
            group_ref(DbGroup::Tables),
            "Tables",
            DbNodeKind::Group,
            true,
        )
        .with_sub_label("5013 tables")]),
    ));
    tree.levels.push((
        group_ref(DbGroup::Tables),
        Ok(vec![DbNode::new(
            table_ref("tracks"),
            "tracks",
            DbNodeKind::Table,
            true,
        )]),
    ));
    let (message, data) = db_browse::schema(&mut tree, &c, "maestro/public/Tables")
        .await
        .unwrap();
    assert!(
        message.contains("This level lists 1 of 5013: the tree reads one page of it"),
        "{message}"
    );
    assert_eq!(data["partial"], "1 of 5013");
    assert_eq!(data["truncated"], true);

    let out = db_browse::search(
        &mut tree,
        DbNodeRef::Root,
        "",
        None,
        "zzz",
        SearchLimits::default(),
    )
    .await;
    assert_eq!(out.partial, ["\"maestro/public/Tables\" (1 of 5013)"]);
    let (message, data) =
        db_browse::search_reply(&c, "zzz", "", &out, SearchLimits::default(), Duration::ZERO);
    assert!(
        message.contains(
            "1 level list only one page of what the database holds, so names past that page \
             were not searched: \"maestro/public/Tables\" (1 of 5013)."
        ),
        "{message}"
    );
    assert_eq!(data["complete"], false);

    // Starting the search AT the partial folder still says so.
    let (start, from, stated) = db_browse::walk_to(&mut tree, "maestro/public/Tables")
        .await
        .unwrap();
    assert_eq!(stated, Some(5013));
    let out = db_browse::search(
        &mut tree,
        start,
        &from,
        stated,
        "track",
        SearchLimits::default(),
    )
    .await;
    // `tracks`, and its column `track_no`.
    assert_eq!((out.found.len(), out.partial_count), (2, 1));

    // Items that mark themselves as a first page (DynamoDB's tables).
    let page: Vec<DbNode> = (0..12)
        .map(|i| {
            DbNode::new(
                table_ref(&format!("t{i}")),
                format!("t{i}"),
                DbNodeKind::Table,
                true,
            )
            .with_sub_label("first 100 tables in this region")
        })
        .collect();
    assert_eq!(
        db_browse::shortfall(None, &page).as_deref(),
        Some("12 (first 100 tables in this region)")
    );
    // A count that is met, a non-folder, and a label that is not a count are not shortfalls.
    let folder = DbNode::new(group_ref(DbGroup::Views), "Views", DbNodeKind::Group, true);
    assert_eq!(db_browse::stated_count(&folder), None);
    assert_eq!(
        db_browse::stated_count(&folder.clone().with_sub_label("empty")),
        None
    );
    assert_eq!(
        db_browse::stated_count(&folder.with_sub_label("2 views")),
        Some(2)
    );
    let table = DbNode::new(table_ref("x"), "x", DbNodeKind::Table, true).with_sub_label("3 rows");
    assert_eq!(db_browse::stated_count(&table), None);
    let plain: Vec<DbNode> = page
        .iter()
        .cloned()
        .map(|mut n| {
            n.sub_label = None;
            n
        })
        .collect();
    assert_eq!(db_browse::shortfall(Some(12), &plain), None);
    assert_eq!(db_browse::shortfall(None, &plain), None);
}

#[tokio::test]
async fn many_partial_levels_keep_ten_and_count_the_rest() {
    let mut tree = fake_tree();
    let folders: Vec<DbNode> = (0..12)
        .map(|i| {
            DbNode::new(
                group_ref(DbGroup::Collections),
                format!("g{i}"),
                DbNodeKind::Group,
                true,
            )
            .with_sub_label("9 collections")
        })
        .collect();
    tree.levels
        .retain(|(r, _)| *r != group_ref(DbGroup::Tables));
    tree.levels.push((group_ref(DbGroup::Tables), Ok(folders)));
    let out = db_browse::search(
        &mut tree,
        DbNodeRef::Root,
        "",
        None,
        "zzz",
        SearchLimits::default(),
    )
    .await;
    assert_eq!((out.partial_count, out.partial.len()), (12, 10));
    let (message, _) = db_browse::search_reply(
        &conn("a", "A"),
        "zzz",
        "",
        &out,
        SearchLimits::default(),
        Duration::ZERO,
    );
    assert!(
        message.contains("12 levels list only one page"),
        "{message}"
    );
}

#[tokio::test]
async fn many_unreadable_levels_keep_ten_reasons_and_count_the_rest() {
    let mut tree = fake_tree();
    let tables: Vec<DbNode> = (0..15)
        .map(|i| {
            DbNode::new(
                table_ref(&format!("t{i}")),
                format!("t{i}"),
                DbNodeKind::Table,
                true,
            )
        })
        .collect();
    tree.levels
        .retain(|(r, _)| *r != group_ref(DbGroup::Tables));
    tree.levels.push((group_ref(DbGroup::Tables), Ok(tables)));
    for i in 0..15 {
        tree.levels
            .push((table_ref(&format!("t{i}")), Err("denied".into())));
    }
    let out = db_browse::search(
        &mut tree,
        DbNodeRef::Root,
        "",
        None,
        "x",
        SearchLimits::default(),
    )
    .await;
    assert_eq!(out.unreadable_count, 16);
    assert_eq!(out.unreadable.len(), 10);
    assert_eq!(db_browse::kind_word(DbNodeKind::SavedQuery), "saved query");
    assert_eq!(db_browse::kind_word(DbNodeKind::Collection), "collection");
    assert_eq!(db_browse::kind_word(DbNodeKind::Key), "key");
}

/* ─────────────────────── the caps and the table ─────────────────────── */

fn rows_set(columns: &[&str], rows: Vec<Vec<Option<String>>>) -> DbResultSet {
    DbResultSet {
        kind: DbResultKind::Rows,
        statement: "SELECT * FROM t".into(),
        columns: columns
            .iter()
            .map(|c| DbColumn {
                name: c.to_string(),
                type_name: "text".into(),
                kind: DbCellKind::Text,
            })
            .collect(),
        rows,
        rows_affected: None,
        truncated: false,
        row_limit: 100,
        duration_ms: 3,
        notice: None,
        absent: None,
    }
}

fn report(results: Vec<DbResultSet>, notes: Vec<String>) -> QueryReport {
    QueryReport {
        connection: conn("01HAAA", "Orders"),
        query: "SELECT 1".into(),
        limit: 100,
        results,
        notes,
        elapsed: Duration::from_millis(7),
    }
}

#[test]
fn the_row_limit_defaults_to_100_and_never_exceeds_1000() {
    assert_eq!(db_run::effective_limit(None).unwrap(), (100, None));
    assert_eq!(db_run::effective_limit(Some(250)).unwrap(), (250, None));
    let (n, note) = db_run::effective_limit(Some(5000)).unwrap();
    assert_eq!(n, 1000);
    assert!(note.unwrap().contains("lowered to 1000"));
    assert!(db_run::effective_limit(Some(0))
        .unwrap_err()
        .contains("at least 1"));
    assert!(db_run::effective_limit(Some(-3)).is_err());

    let mut c = conn("x", "x");
    assert_eq!(db_run::mode_for(&c), DbRunMode::Statement);
    c.allow_multi_statement = true;
    assert_eq!(db_run::mode_for(&c), DbRunMode::Script);
    assert_eq!(db_run::app_deadline(), TOOL_DEADLINE);
}

#[test]
fn rows_past_the_byte_budget_are_dropped_with_a_note_and_long_values_are_cut() {
    // 100 rows of 1000 bytes, each costing 1010 with its cell and brackets: 64 fit in 64 KB.
    let rows: Vec<Vec<Option<String>>> = (0..100).map(|_| vec![Some("x".repeat(1000))]).collect();
    let mut set = rows_set(&["v"], rows);
    set.absent = Some(vec![vec![false]; 100]);
    let (sets, notes) = db_run::bound(vec![set], 100);
    assert_eq!(sets[0].rows.len(), 64);
    assert_eq!(
        sets[0].absent.as_ref().unwrap().len(),
        64,
        "the mask is cut with the rows"
    );
    assert!(sets[0].truncated);
    assert_eq!(
        notes,
        ["Rows after the first 64 (of 100 read) were left out: the reply is capped at 64 KB."]
    );

    // A value longer than 2000 characters is cut, marked, and counted.
    let long = vec![
        vec![Some("é".repeat(2500)), None],
        vec![Some("short".into()), Some("y".repeat(3000))],
    ];
    let (sets, notes) = db_run::bound(vec![rows_set(&["a", "b"], long)], 100);
    let cell = sets[0].rows[0][0].as_deref().unwrap();
    assert_eq!(cell.chars().count(), 2001);
    assert!(cell.ends_with('…'));
    assert_eq!(sets[0].rows[0][1], None, "NULL stays NULL");
    assert_eq!(notes, ["2 long values were cut to 2000 characters."]);
    assert!(!sets[0].truncated);

    let one = vec![vec![Some("z".repeat(2001))]];
    let (_, notes) = db_run::bound(vec![rows_set(&["a"], one)], 100);
    assert_eq!(notes, ["1 long value was cut to 2000 characters."]);
}

#[test]
fn the_limit_the_engine_measured_and_the_result_count_are_both_said() {
    let mut a = rows_set(&["v"], vec![vec![Some("1".into())]; 5]);
    a.truncated = true;
    let mut sets = vec![a];
    for _ in 0..24 {
        let mut s = rows_set(&["v"], vec![]);
        s.notice = Some("n".repeat(2500));
        sets.push(s);
    }
    let (sets, notes) = db_run::bound(sets, 5);
    assert_eq!(sets.len(), 20);
    assert_eq!(notes[0], "Only the first 20 of 25 results are included.");
    assert!(notes[1].starts_with(
        "Only the first 5 rows of result 1 were read: that is the limit (5). More rows exist"
    ));
    assert_eq!(sets[1].notice.as_deref().unwrap().chars().count(), 2001);

    // Once the budget is spent, later results keep no rows and say so.
    let big: Vec<Vec<Option<String>>> = (0..70).map(|_| vec![Some("x".repeat(1000))]).collect();
    let (sets, notes) = db_run::bound(
        vec![
            rows_set(&["v"], big),
            rows_set(&["v"], vec![vec![Some("y".repeat(1000))]]),
        ],
        100,
    );
    assert_eq!(sets[1].rows.len(), 0);
    assert!(notes
        .iter()
        .any(|n| n.starts_with("Rows after the first 0 of result 2")));
}

#[test]
fn a_cell_reads_null_absent_and_escapes_its_control_characters() {
    assert_eq!(db_run::display_cell(None, false), "NULL");
    assert_eq!(db_run::display_cell(None, true), "(absent)");
    assert_eq!(db_run::display_cell(Some(""), false), "");
    assert_eq!(
        db_run::display_cell(Some("a\nb\tc\rd\u{7}"), false),
        "a\\nb\\tc\\rd?"
    );
    let long = db_run::display_cell(Some(&"ü".repeat(500)), false);
    assert_eq!(long.chars().count(), 41);
    assert!(long.ends_with('…'));
}

#[test]
fn a_result_reads_as_an_aligned_table() {
    let mut set = rows_set(
        &["id", "title"],
        vec![
            vec![Some("1".into()), Some("Amberline".into())],
            vec![Some("22".into()), None],
            vec![Some("3".into())],
        ],
    );
    set.absent = Some(vec![
        vec![false, false],
        vec![false, false],
        vec![false, true],
    ]);
    assert_eq!(
        db_run::table(&set),
        [
            "id | title",
            "---+----------",
            "1  | Amberline",
            "22 | NULL",
            "3  | (absent)",
        ]
    );
}

#[test]
fn the_message_shows_each_result_and_every_note() {
    let mut rows = rows_set(&["v"], vec![vec![Some("a".into())]]);
    rows.notice = Some("3 documents lacked `tag`".into());
    let affected = DbResultSet {
        kind: DbResultKind::Affected,
        rows_affected: Some(3),
        columns: vec![],
        ..rows_set(&[], vec![])
    };
    let one = DbResultSet {
        rows_affected: Some(1),
        ..affected.clone()
    };
    let none = DbResultSet {
        rows_affected: None,
        ..affected.clone()
    };
    let said = DbResultSet::message("SELECT nope", "relation \"nope\" does not exist", 100);
    let silent = DbResultSet {
        notice: None,
        ..said.clone()
    };
    let empty = rows_set(&[], vec![]);
    let mut more = rows_set(&["v"], vec![vec![Some("x".into())]; 2]);
    more.truncated = true;
    let r = report(
        vec![rows, affected, one, none, said, silent, empty, more],
        vec!["a note".into()],
    );
    let m = r.message();
    assert!(
        m.starts_with(
            "Ran on \"Orders\" (PostgreSQL at db.example.com:5432/shop, read-only) in 7 ms."
        ),
        "{m}"
    );
    for want in [
        "\n[1] SELECT * FROM t\nv\n-\na\n(1 row)\nNotice: 3 documents lacked `tag`",
        "[2] SELECT * FROM t\nOK: 3 rows affected.",
        "OK: 1 row affected.",
        "\nOK.\n",
        "The database said: relation \"nope\" does not exist",
        "The database said: (no text)",
        "(0 rows)",
        "(2 rows, more exist)",
        "\n\na note",
    ] {
        assert!(m.contains(want), "missing {want:?} in:\n{m}");
    }
    let single = report(vec![rows_set(&["v"], vec![])], vec![]).message();
    assert!(!single.contains("[1]"), "{single}");
    assert!(report(vec![], vec![])
        .message()
        .ends_with("The database returned nothing."));
}

#[test]
fn null_and_empty_cells_count_toward_the_budget() {
    // 1000 rows of 300 NULL or empty columns: no text at all, and still far past 64 KB as JSON.
    let rows: Vec<Vec<Option<String>>> = (0..1000)
        .map(|i| {
            (0..300)
                .map(|j| ((i + j) % 2 == 0).then(String::new))
                .collect()
        })
        .collect();
    let columns: Vec<String> = (0..300).map(|j| format!("c{j}")).collect();
    let names: Vec<&str> = columns.iter().map(String::as_str).collect();
    let (sets, notes) = db_run::bound(vec![rows_set(&names, rows)], 1000);
    // 2 + 300 × 8 bytes a row.
    let kept = TEXT_BUDGET / (2 + 300 * db_run::CELL_COST);
    assert_eq!(sets[0].rows.len(), kept);
    assert!(sets[0].truncated);
    assert_eq!(
        notes,
        [format!(
            "Rows after the first {kept} (of 1000 read) were left out: the reply is capped at 64 KB."
        )]
    );
    let r = report(sets, notes);
    let data = r.data().to_string();
    assert!(
        data.len() <= TEXT_BUDGET + 4096,
        "the data is bounded as JSON: {} bytes",
        data.len()
    );
}

#[test]
fn a_table_longer_than_64_kb_is_cut_in_the_message_and_whole_in_the_data() {
    // Two 20-byte columns of tabs: 58 bytes a row in the data (1000 rows fit its 64 KB), while
    // the table shows each tab as `\t`, and its 76-byte lines do not fit the message's.
    let cell = |i: usize| Some(format!("{i:04}{}", "\t".repeat(16)));
    let rows: Vec<Vec<Option<String>>> = (0..1000).map(|i| vec![cell(i), cell(i)]).collect();
    let (sets, notes) = db_run::bound(vec![rows_set(&["a", "b"], rows)], 1000);
    assert!(notes.is_empty(), "{notes:?}");
    let r = report(sets, notes);
    let m = r.message();
    assert!(m.len() <= TEXT_BUDGET + 4096, "{}", m.len());
    assert!(
        m.contains("rows (64 KB text cap); --json carries all 1000."),
        "{}",
        &m[m.len() - 300..]
    );
    let data = r.data();
    assert_eq!(data["results"][0]["rows"].as_array().unwrap().len(), 1000);
    assert_eq!(data["results"][0]["rowCount"], 1000);
    assert_eq!(data["results"][0]["columns"], serde_json::json!(["a", "b"]));
    assert!(
        data.get("rows").is_none(),
        "the rows are in their result, once"
    );
}

#[test]
fn the_data_carries_names_types_rows_the_mask_and_no_secret() {
    let mut set = rows_set(&["id"], vec![vec![None]]);
    set.absent = Some(vec![vec![true]]);
    let r = report(
        vec![DbResultSet::message("x", "y", 100), set],
        vec!["n".into()],
    );
    let d = r.data();
    assert_eq!(d["connection"]["name"], "Orders");
    assert_eq!(d["limit"], 100);
    assert_eq!(d["results"][1]["columns"], serde_json::json!(["id"]));
    assert_eq!(d["results"][1]["rows"], serde_json::json!([[null]]));
    assert!(
        d.get("rows").is_none() && d.get("columns").is_none(),
        "no second copy of the rows: {d}"
    );
    assert_eq!(d["results"][1]["columnTypes"], serde_json::json!(["text"]));
    assert_eq!(d["results"][1]["absent"], serde_json::json!([[true]]));
    assert!(d["results"][0].get("absent").is_none());
    assert_eq!(d["results"][0]["kind"], "message");
    assert_eq!(d["notes"], serde_json::json!(["n"]));
    assert_eq!(d["elapsedMs"], 7);
    let text = d.to_string();
    assert!(
        !text.contains("{{") && !text.contains("postgresql://"),
        "{text}"
    );
}

#[test]
fn text_is_cut_by_whole_lines_and_finally_at_a_character_boundary() {
    let mut lines = vec!["aaaa".to_string(), "bbbb".to_string(), "cc".to_string()];
    assert_eq!(text_budget_cut(&mut lines, 10), 1);
    assert_eq!(lines, ["aaaa", "bbbb"]);
    let mut none = vec!["x".to_string()];
    assert_eq!(text_budget_cut(&mut none, 0), 1);
    assert!(none.is_empty());

    let short = "fine".to_string();
    assert_eq!(hard_cap(short.clone()), short);
    let long = "€".repeat(40_000); // 120 KB of 3-byte characters
    let cut = hard_cap(long);
    assert!(cut.len() <= TEXT_BUDGET + 100);
    assert!(cut.ends_with("(cut at 64 KB; --json carries the structured data.)"));
}

/* ─────────────────────── saved queries and the console ─────────────────────── */

fn saved_query(i: usize, sql: &str) -> crate::db::queries::SavedQuery {
    crate::db::queries::SavedQuery {
        id: format!("Q{i}"),
        connection_id: "01HAAA".into(),
        name: format!("query {i}"),
        sql: sql.into(),
        created_at_ms: 0,
        updated_at_ms: 0,
    }
}

#[test]
fn saved_queries_are_listed_with_their_text_and_bounded() {
    let c = conn("01HAAA", "Orders");
    let (message, data) = db_saved::queries_reply(&c, &[]);
    assert!(
        message.starts_with("No queries are saved for \"Orders\""),
        "{message}"
    );
    assert_eq!(data["total"], 0);

    let qs = vec![
        saved_query(1, "SELECT 1\nFROM dual"),
        saved_query(2, &"y".repeat(3000)),
    ];
    let (message, data) = db_saved::queries_reply(&c, &qs);
    assert!(
        message.starts_with("2 saved queries for \"Orders\""),
        "{message}"
    );
    assert!(
        message.contains("• query 1  (id Q1)\n    SELECT 1\n    FROM dual"),
        "{message}"
    );
    assert!(
        message.contains("… (cut; --json has the whole text)"),
        "{message}"
    );
    assert_eq!(data["queries"][1]["query"].as_str().unwrap().len(), 3000);
    assert_eq!(data["queries"][1]["cut"], false);

    let one = db_saved::queries_reply(&c, &qs[..1]).0;
    assert!(one.starts_with("1 saved query for"), "{one}");

    let many: Vec<_> = (0..260).map(|i| saved_query(i, &"z".repeat(500))).collect();
    let (message, data) = db_saved::queries_reply(&c, &many);
    assert!(
        message.contains("Only the newest 200 are listed."),
        "{message}"
    );
    assert!(
        message.contains("(The rest is left out: 64 KB text cap."),
        "{message}"
    );
    assert!(message.len() <= TEXT_BUDGET + 4096);
    // The data's query text shares the 64 KB budget too: 200 queries of 500 bytes do not fit.
    let listed = data["queries"].as_array().unwrap().len();
    assert!((100..200).contains(&listed), "{listed}");
    assert!(
        message.contains(&format!(
            "The data lists the first {listed}: query text is capped at 64 KB."
        )),
        "{message}"
    );
    assert_eq!(data["truncated"], true);
    assert_eq!(data["total"], 260);
    assert!(data.to_string().len() <= TEXT_BUDGET + 32 * 1024);

    // Cut in bytes, at a character boundary: 2-byte characters past the budget.
    let huge = vec![saved_query(1, &"é".repeat(db_run::MAX_QUERY_BYTES))];
    let (_, data) = db_saved::queries_reply(&c, &huge);
    assert_eq!(data["queries"][0]["cut"], true);
    let text = data["queries"][0]["query"].as_str().unwrap();
    assert!(text.len() <= TEXT_BUDGET + '…'.len_utf8(), "{}", text.len());
    assert!(text.ends_with('…'));
}

#[test]
fn an_agent_adds_saved_queries_and_never_overwrites_one() {
    let (dir, paths) = temp_paths();
    let c = save(
        &paths,
        &format!("postgres://app:s3cret@127.0.0.1:{}/shop", dead_port()),
        "Shop",
        true,
        false,
    );

    let first = db_saved::db_save_query(&paths, "shop", "Top customers", "SELECT 1").unwrap();
    assert_eq!(first.same_name, 0);
    assert!(first
        .message()
        .starts_with("Saved \"Top customers\" in the saved queries of \"Shop\""));
    let second = db_saved::db_save_query(&paths, &c.id, " top CUSTOMERS ", "SELECT 2").unwrap();
    assert_ne!(second.saved.id, first.saved.id);
    assert_eq!(second.same_name, 1);
    assert!(second
        .message()
        .contains("1 other saved query already had that name; it was left as it was, and this one was saved beside it."));
    let third = db_saved::db_save_query(&paths, "Shop", "Top customers", "SELECT 3").unwrap();
    assert!(third
        .message()
        .contains("2 other saved queries already had that name; they were left as they were"));
    assert_eq!(third.data()["sameName"], 2);
    assert_eq!(third.data()["query"]["query"], "SELECT 3");

    let all = crate::db::queries::for_connection(&crate::db::queries::load(&paths.queries), &c.id);
    let mut texts: Vec<&str> = all.iter().map(|q| q.sql.as_str()).collect();
    texts.sort();
    assert_eq!(
        texts,
        ["SELECT 1", "SELECT 2", "SELECT 3"],
        "nothing was overwritten"
    );

    for (name, sql, want) in [
        ("", "SELECT 1", "Give the saved query a name."),
        ("n", "  ", "Give the query text to save."),
    ] {
        assert_eq!(
            db_saved::db_save_query(&paths, "shop", name, sql).unwrap_err(),
            want
        );
    }
    let long_name = "n".repeat(201);
    assert!(
        db_saved::db_save_query(&paths, "shop", &long_name, "SELECT 1")
            .unwrap_err()
            .contains("keep it to 200")
    );
    let long_sql = "s".repeat(db_run::MAX_QUERY_BYTES + 1);
    assert!(db_saved::db_save_query(&paths, "shop", "n", &long_sql)
        .unwrap_err()
        .contains("the most an agent can save is 256 KB"));
    let before = std::fs::read(&paths.queries).unwrap();
    assert!(db_saved::db_save_query(&paths, "billing", "n", "SELECT 1")
        .unwrap_err()
        .contains("no saved connection named \"billing\""));
    assert_eq!(
        std::fs::read(&paths.queries).unwrap(),
        before,
        "a refusal wrote nothing"
    );

    let (message, data) = db_saved::db_queries(&paths, "SHOP").unwrap();
    assert!(
        message.starts_with("3 saved queries for \"Shop\""),
        "{message}"
    );
    assert!(!message.contains("s3cret") && !data.to_string().contains("s3cret"));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_console_is_checked_here_and_opened_by_the_app() {
    let (dir, paths) = temp_paths();
    save(
        &paths,
        &format!("redis://127.0.0.1:{}", dead_port()),
        "Cache",
        true,
        false,
    );
    let c = db_saved::db_console(&paths, "cache", Some("GET a")).unwrap();
    assert_eq!(c.name, "Cache");
    assert!(db_saved::console_message(&c, true).contains("It was NOT run"));
    let plain = db_saved::console_message(&c, false);
    assert!(
        plain.starts_with("Opened a query console for \"Cache\" (Redis at 127.0.0.1:"),
        "{plain}"
    );
    assert!(plain.ends_with("read-only) in Agent Studio."), "{plain}");
    assert!(db_saved::db_console(
        &paths,
        "cache",
        Some(&"x".repeat(db_run::MAX_QUERY_BYTES + 1))
    )
    .unwrap_err()
    .contains("too long"));
    assert!(db_saved::db_console(&paths, "nope", None).is_err());
    let _ = std::fs::remove_dir_all(dir);
}

/* ────────────── the tools end to end, against a RESP server ────────────── */

#[tokio::test]
async fn a_query_runs_through_the_console_path_and_the_user_is_shown_it() {
    let redis = FakeRedis::start().await;
    let (dir, paths) = temp_paths();
    let c = save(&paths, &redis.url(), "Cache", true, false);

    let (status, reply, events) = call(
        &dir,
        "db_query",
        serde_json::json!({"connection": "cache", "query": "GET greeting"}),
    )
    .await;
    assert_eq!(status, 200, "{}", reply.message);
    assert!(
        reply
            .message
            .starts_with("Ran on \"Cache\" (Redis at 127.0.0.1:"),
        "{}",
        reply.message
    );
    assert!(
        reply
            .message
            .contains("value\n------------\nhello\\tworld\n(1 row)"),
        "{}",
        reply.message
    );
    assert_eq!(
        reply.data["results"][0]["rows"],
        serde_json::json!([["hello\tworld"]])
    );
    assert_eq!(reply.data["connection"]["readOnly"], true);
    assert!(redis.names().contains(&"GET".to_string()));

    assert_eq!(events.len(), 1);
    let e = serde_json::to_value(&events[0]).unwrap();
    assert_eq!(e["kind"], "dbQueryRun");
    assert_eq!(e["terminalId"], "term-4");
    assert_eq!(e["connectionId"], c.id);
    assert_eq!(e["query"], "GET greeting");
    assert_eq!(e["error"], serde_json::Value::Null);
    assert_eq!(
        e["results"][0]["rows"],
        serde_json::json!([["hello\tworld"]])
    );
    assert_eq!(e["results"][0]["kind"], "rows");

    // The agent's session is closed when the call ends: nothing is left in the registry.
    assert!(crate::db::session::take_for_connection(&c.id).is_empty());
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn a_write_on_a_read_only_connection_is_refused_before_it_reaches_the_server() {
    let redis = FakeRedis::start().await;
    let (dir, paths) = temp_paths();
    let c = save(&paths, &redis.url(), "Cache", true, false);

    let (status, reply, events) = call(
        &dir,
        "db_query",
        serde_json::json!({"connection": c.id, "query": "SET greeting pwned"}),
    )
    .await;
    assert_eq!(status, 422);
    assert!(
        reply
            .message
            .starts_with("Agent Studio did not run that on \"Cache\""),
        "{}",
        reply.message
    );
    assert!(reply.message.contains("read-only"), "{}", reply.message);
    assert!(
        !redis.names().contains(&"SET".to_string()),
        "the write reached the server: {:?}",
        redis.names()
    );
    // The user is shown the attempt.
    assert_eq!(events.len(), 1);
    let e = serde_json::to_value(&events[0]).unwrap();
    assert_eq!(e["kind"], "dbQueryRun");
    assert!(e["error"].as_str().unwrap().contains("read-only"));
    assert_eq!(e["results"], serde_json::json!([]));

    // Negative control: the same write on a read-write connection does reach the server.
    save(
        &paths,
        &format!("redis://127.0.0.1:{}/1", redis.port),
        "Writable",
        false,
        false,
    );
    let (status, reply, _) = call(
        &dir,
        "db_query",
        serde_json::json!({"connection": "writable", "query": "SET greeting hi"}),
    )
    .await;
    assert_eq!(status, 200, "{}", reply.message);
    assert!(redis.names().contains(&"SET".to_string()));
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn several_statements_need_the_connections_multi_statement_setting() {
    let redis = FakeRedis::start().await;
    let (dir, paths) = temp_paths();
    save(&paths, &redis.url(), "One", true, false);
    save(
        &paths,
        &format!("redis://127.0.0.1:{}/2", redis.port),
        "Many",
        true,
        true,
    );

    let (status, reply, _) = call(
        &dir,
        "db_query",
        serde_json::json!({"connection": "one", "query": "GET greeting\nGET other"}),
    )
    .await;
    assert_eq!(status, 422);
    assert!(
        reply.message.contains("That is 2 statements"),
        "{}",
        reply.message
    );

    let (status, reply, _) = call(
        &dir,
        "db_query",
        serde_json::json!({"connection": "many", "query": "GET greeting\nGET other"}),
    )
    .await;
    assert_eq!(status, 200, "{}", reply.message);
    assert!(
        reply.message.contains("[1] GET greeting"),
        "{}",
        reply.message
    );
    assert!(reply.message.contains("[2] GET other"), "{}", reply.message);
    assert_eq!(reply.data["results"].as_array().unwrap().len(), 2);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn the_row_limit_is_measured_and_said() {
    let redis = FakeRedis::start().await;
    let (dir, paths) = temp_paths();
    save(&paths, &redis.url(), "Cache", true, false);

    let (status, reply, _) = call(
        &dir,
        "db_query",
        serde_json::json!({"connection": "cache", "query": "LRANGE big 0 -1"}),
    )
    .await;
    assert_eq!(status, 200, "{}", reply.message);
    assert_eq!(
        reply.data["results"][0]["rows"].as_array().unwrap().len(),
        100
    );
    assert_eq!(reply.data["truncated"], true);
    assert!(
        reply.message.contains("(100 rows, more exist)"),
        "{}",
        reply.message
    );
    assert!(
        reply
            .message
            .contains("Only the first 100 rows were read: that is the limit (100)."),
        "{}",
        reply.message
    );

    let (_, reply, _) = call(
        &dir,
        "db_query",
        serde_json::json!({"connection": "cache", "query": "LRANGE big 0 -1", "limit": 5000}),
    )
    .await;
    assert_eq!(reply.data["limit"], 1000);
    assert_eq!(
        reply.data["results"][0]["rows"].as_array().unwrap().len(),
        1000
    );
    assert!(
        reply.message.contains("--limit 5000 was lowered to 1000"),
        "{}",
        reply.message
    );

    let (status, reply, events) = call(
        &dir,
        "db_query",
        serde_json::json!({"connection": "cache", "query": "GET greeting", "limit": 0}),
    )
    .await;
    assert_eq!(status, 422);
    assert!(reply.message.contains("at least 1"));
    assert_eq!(
        events.len(),
        1,
        "a refused run on a known connection is shown too"
    );

    for (query, want) in [("   ", "Give the query to run.")] {
        let (status, reply, _) = call(
            &dir,
            "db_query",
            serde_json::json!({"connection": "cache", "query": query}),
        )
        .await;
        assert_eq!((status, reply.message.as_str()), (422, want));
    }
    let (status, reply, _) = call(
        &dir,
        "db_query",
        serde_json::json!({"connection": "cache", "query": "x".repeat(db_run::MAX_QUERY_BYTES + 1)}),
    )
    .await;
    assert_eq!(status, 422);
    assert!(reply
        .message
        .contains("the most an agent can send is 256 KB"));
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn a_query_that_outlasts_the_deadline_is_abandoned_and_its_session_closed() {
    let redis = FakeRedis::start().await;
    let (dir, paths) = temp_paths();
    let c = save(&paths, &redis.url(), "Cache", true, false);

    let started = std::time::Instant::now();
    let (target, result) = db_run::run(
        &paths,
        "cache",
        "GET slow",
        None,
        Duration::from_millis(400),
    )
    .await;
    assert_eq!(target.unwrap().id, c.id);
    let err = result.unwrap_err();
    assert!(
        err.starts_with("Agent Studio stopped waiting for the query after 1 s"),
        "{err}"
    );
    assert!(started.elapsed() < Duration::from_secs(5));
    assert!(
        crate::db::session::take_for_connection(&c.id).is_empty(),
        "the abandoned session was left open"
    );

    // An unknown connection: no target, so nothing to show the user.
    let (target, result) = db_run::run(&paths, "nope", "GET a", None, Duration::from_secs(1)).await;
    assert!(target.is_none());
    assert!(result.unwrap_err().contains("no saved connection named"));
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn a_session_abandoned_mid_call_is_closed_in_the_background() {
    let redis = FakeRedis::start().await;
    let (dir, paths) = temp_paths();
    let c = save(&paths, &redis.url(), "Cache", true, false);
    let sess = db_target::ToolSession::open(&paths, &c).await.unwrap();
    assert!(sess.server_version.contains("Redis 7.4.0"));
    assert!(crate::db::session::get(sess.id()).is_ok());
    let id = sess.id().to_string();
    drop(sess);
    assert!(
        crate::db::session::get(&id).is_err(),
        "dropped, so out of the registry"
    );
    tokio::task::yield_now().await;
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn test_schema_and_search_read_the_real_engines_tree() {
    let redis = FakeRedis::start().await;
    let (dir, paths) = temp_paths();
    let c = save(&paths, &redis.url(), "Cache", true, false);

    let (status, reply, events) =
        call(&dir, "db_test", serde_json::json!({"connection": "cache"})).await;
    assert_eq!(status, 200, "{}", reply.message);
    assert!(
        reply.message.starts_with("Connected to \"Cache\""),
        "{}",
        reply.message
    );
    assert!(
        reply.message.contains("Redis 7.4.0 in "),
        "{}",
        reply.message
    );
    assert_eq!(reply.data["ok"], true);
    assert!(
        events.is_empty(),
        "a test changes nothing the user needs to see"
    );

    let (status, reply, _) = call(
        &dir,
        "db_schema",
        serde_json::json!({"connection": "cache"}),
    )
    .await;
    assert_eq!(status, 200, "{}", reply.message);
    assert!(
        reply
            .message
            .contains("database  db0  — the connected database"),
        "{}",
        reply.message
    );

    let (_, reply, _) = call(
        &dir,
        "db_schema",
        serde_json::json!({"connection": "cache", "path": "db0/Keys"}),
    )
    .await;
    assert!(
        reply.message.contains("  key  greeting  — string"),
        "{}",
        reply.message
    );
    assert_eq!(reply.data["items"].as_array().unwrap().len(), keys().len());

    let (status, reply, _) = call(
        &dir,
        "db_schema",
        serde_json::json!({"connection": "cache", "path": "db0/greeting"}),
    )
    .await;
    assert_eq!(status, 422);
    assert_eq!(
        reply.message,
        "\"db0/Keys/greeting\" is a key and has nothing below it."
    );

    let (status, reply, _) = call(
        &dir,
        "db_search",
        serde_json::json!({"connection": "cache", "pattern": "GREET"}),
    )
    .await;
    assert_eq!(status, 200, "{}", reply.message);
    assert!(
        reply
            .message
            .starts_with("1 match for \"GREET\" in \"Cache\""),
        "{}",
        reply.message
    );
    assert!(
        reply.message.contains("key  db0/Keys/greeting  — string"),
        "{}",
        reply.message
    );
    assert_eq!(reply.data["complete"], true);

    let (status, reply, _) = call(
        &dir,
        "db_search",
        serde_json::json!({"connection": "cache", "pattern": "item", "path": "db0/nothing"}),
    )
    .await;
    assert_eq!(status, 422);
    assert!(
        reply.message.contains("There is no \"nothing\""),
        "{}",
        reply.message
    );
    let (status, reply, _) = call(
        &dir,
        "db_search",
        serde_json::json!({"connection": "cache", "pattern": "  "}),
    )
    .await;
    assert_eq!(status, 422);
    assert!(reply.message.starts_with("Give a text to look for"));
    assert!(crate::db::session::take_for_connection(&c.id).is_empty());
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn an_unreachable_connection_is_reported_without_its_password() {
    let (dir, paths) = temp_paths();
    let port = dead_port();
    save(
        &paths,
        &format!("postgres://app:s3cret@127.0.0.1:{port}/shop"),
        "Shop",
        true,
        false,
    );
    for (tool, args) in [
        ("db_test", serde_json::json!({"connection": "shop"})),
        ("db_schema", serde_json::json!({"connection": "shop"})),
        (
            "db_search",
            serde_json::json!({"connection": "shop", "pattern": "x"}),
        ),
        (
            "db_query",
            serde_json::json!({"connection": "shop", "query": "SELECT 1"}),
        ),
    ] {
        let (status, reply, _) = call(&dir, tool, args).await;
        assert_eq!(status, 422, "{tool}");
        assert!(
            reply
                .message
                .starts_with("Could not connect to \"Shop\" (PostgreSQL at 127.0.0.1:"),
            "{tool}: {}",
            reply.message
        );
        assert!(
            !reply.message.contains("s3cret"),
            "{tool}: {}",
            reply.message
        );
        assert!(!reply.message.contains("{{"), "{tool}: {}", reply.message);
    }
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn saved_queries_and_the_console_answer_through_the_dispatcher_with_their_events() {
    let (dir, paths) = temp_paths();
    let c = save(
        &paths,
        &format!("redis://127.0.0.1:{}", dead_port()),
        "Cache",
        true,
        false,
    );

    let (status, reply, events) = call(
        &dir,
        "db_save_query",
        serde_json::json!({"connection": "cache", "name": "Greeting", "query": "GET greeting"}),
    )
    .await;
    assert_eq!(status, 200, "{}", reply.message);
    let id = reply.data["query"]["id"].as_str().unwrap().to_string();
    assert_eq!(
        serde_json::to_value(&events[0]).unwrap(),
        serde_json::json!({"kind": "dbSavedQuery", "terminalId": "term-4", "connectionId": c.id, "queryId": id})
    );

    let (status, reply, events) = call(
        &dir,
        "db_queries",
        serde_json::json!({"connection": "Cache"}),
    )
    .await;
    assert_eq!(status, 200);
    assert!(reply.message.contains("• Greeting"), "{}", reply.message);
    assert!(events.is_empty());

    let (status, reply, events) = call(
        &dir,
        "db_console",
        serde_json::json!({"connection": "cache", "query": "GET greeting"}),
    )
    .await;
    assert_eq!(status, 200, "{}", reply.message);
    assert_eq!(reply.data["run"], false);
    assert_eq!(
        serde_json::to_value(&events[0]).unwrap(),
        serde_json::json!({"kind": "dbConsole", "terminalId": "term-4", "connectionId": c.id, "query": "GET greeting"})
    );

    let (_, reply, events) = call(
        &dir,
        "db_console",
        serde_json::json!({"connection": "cache", "query": "  "}),
    )
    .await;
    assert!(
        reply.message.ends_with("in Agent Studio."),
        "{}",
        reply.message
    );
    assert_eq!(events[0].payload["query"], serde_json::Value::Null);

    let (status, _, events) = call(
        &dir,
        "db_console",
        serde_json::json!({"connection": "nope"}),
    )
    .await;
    assert_eq!(status, 422);
    assert!(events.is_empty(), "a refusal opens nothing");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn no_tool_can_make_a_connection_writable_edit_or_delete_one_or_export_a_secret() {
    let names: Vec<&str> = TOOLS.iter().map(|t| t.name).collect();
    assert_eq!(
        names,
        [
            "db_connect",
            "db_list",
            "db_test",
            "db_schema",
            "db_search",
            "db_query",
            "db_console",
            "db_queries",
            "db_save_query",
        ]
    );
    for t in TOOLS {
        for p in t.params {
            assert!(
                !["read_only", "writable", "password", "delete"].contains(&p.name),
                "{}.{}",
                t.name,
                p.name
            );
        }
    }
}

/* ────────────────── secrets: refused where they are asked for, masked everywhere ────────────────── */

#[test]
fn redis_commands_that_read_credentials_are_recognised_in_every_spelling() {
    for refused in [
        "CONFIG GET requirepass",
        "config get *",
        "Config Get masterauth",
        "CONFIG",
        "CONFIG SET requirepass x",
        "\"CONFIG\" GET *",
        "'config' 'get' '*pass*'",
        "C\\ONFIG GET *",
        "   CONFIG    GET   requirepass   ",
        "ACL LIST",
        "acl getuser default",
        "ACL WHOAMI",
        "AUTH default guess",
        "auth guess",
        "HELLO 3 AUTH default guess",
        "hello 2 auth default guess setname x",
        "MONITOR",
        "SENTINEL masters",
        "GET greeting\nCONFIG GET requirepass",
        "MULTI\nconfig get *\nEXEC",
        "# a comment\nACL LIST",
    ] {
        let why =
            db_run::redis_refusal(refused).unwrap_or_else(|| panic!("{refused:?} was not refused"));
        assert!(why.contains("is not available to an agent"), "{why}");
        assert!(
            why.contains("Vault never reaches an agent") || why.contains("HELLO"),
            "{why}"
        );
    }
    for allowed in [
        "GET greeting",
        "GET config",
        "HELLO",
        "HELLO 2",
        "SCAN 0 MATCH config:* COUNT 100",
        "HGET auth token",
        "SET acl 1",
        "",
        "# CONFIG GET * in a comment",
        // An unclosed quote: the engine refuses the whole run before anything is sent.
        "GET \"x",
    ] {
        assert_eq!(db_run::redis_refusal(allowed), None, "{allowed:?}");
    }
}

#[tokio::test]
async fn redis_credential_commands_never_reach_the_server_on_any_connection() {
    let redis = FakeRedis::start().await;
    let (dir, paths) = temp_paths();
    save(
        &paths,
        &format!("redis://:{FAKE_PW}@127.0.0.1:{}/0", redis.port),
        "Cache",
        true,
        true,
    );
    save(
        &paths,
        &format!("redis://:{FAKE_PW}@127.0.0.1:{}/1", redis.port),
        "Writable",
        false,
        true,
    );
    for connection in ["cache", "writable"] {
        for query in [
            "CONFIG GET requirepass",
            "config get *",
            "ACL LIST",
            "AUTH default guess",
            "HELLO 3 AUTH default guess",
            "MONITOR",
            "MULTI\nCONFIG GET *\nEXEC",
        ] {
            let (status, reply, events) = call(
                &dir,
                "db_query",
                serde_json::json!({"connection": connection, "query": query}),
            )
            .await;
            assert_eq!(status, 422, "{query}: {}", reply.message);
            assert!(
                reply.message.contains("is not available to an agent"),
                "{}",
                reply.message
            );
            assert!(!reply.message.contains(FAKE_PW), "{}", reply.message);
            assert_eq!(events.len(), 1, "the user is shown the attempt");
            assert!(!serde_json::to_string(&events).unwrap().contains(FAKE_PW));
        }
    }
    assert!(
        redis.names().is_empty(),
        "nothing reached the server, not even a connect: {:?}",
        redis.names()
    );

    // Negative control: HELLO without AUTH is a read like any other, and does reach it.
    let (status, reply, _) = call(
        &dir,
        "db_query",
        serde_json::json!({"connection": "cache", "query": "HELLO 2"}),
    )
    .await;
    assert_eq!(status, 200, "{}", reply.message);
    assert!(redis.names().contains(&"HELLO".to_string()));
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn the_connections_password_is_masked_in_every_reply_and_event_whatever_the_server_sends() {
    use crate::db::error::MASK;
    let redis = FakeRedis::start().await;
    let (dir, paths) = temp_paths();
    save(
        &paths,
        &format!("redis://:{FAKE_PW}@127.0.0.1:{}/0", redis.port),
        "Cache",
        true,
        false,
    );
    let everything =
        |reply: &crate::agent_ctl::CtlResponse, events: &[crate::agent_ctl::CtlEvent]| -> String {
            format!(
                "{}\n{}\n{}",
                reply.message,
                reply.data,
                serde_json::to_string(events).unwrap()
            )
        };

    // A value that IS the password (what `CONFIG GET requirepass` would have answered).
    let (status, reply, events) = call(
        &dir,
        "db_query",
        serde_json::json!({"connection": "cache", "query": "GET leak"}),
    )
    .await;
    assert_eq!(status, 200, "{}", reply.message);
    assert!(
        !everything(&reply, &events).contains(FAKE_PW),
        "{}",
        everything(&reply, &events)
    );
    assert_eq!(
        reply.data["results"][0]["rows"],
        serde_json::json!([[MASK]])
    );
    assert_eq!(
        events[0].payload["results"][0]["rows"],
        serde_json::json!([[MASK]])
    );
    assert!(reply.message.contains(MASK), "{}", reply.message);
    // The engine really dialled with it: the fake saw the real password, the agent never did.
    assert!(redis
        .seen
        .lock()
        .unwrap()
        .iter()
        .any(|c| c.contains(FAKE_PW)));

    // A key named after it, in the tree and in a search.
    let (status, reply, events) = call(
        &dir,
        "db_schema",
        serde_json::json!({"connection": "cache", "path": "db0/Keys"}),
    )
    .await;
    assert_eq!(status, 200, "{}", reply.message);
    assert!(!everything(&reply, &events).contains(FAKE_PW));
    assert!(
        reply.message.contains(&format!("key  token:{MASK}")),
        "{}",
        reply.message
    );
    let (status, reply, events) = call(
        &dir,
        "db_search",
        serde_json::json!({"connection": "cache", "pattern": "token"}),
    )
    .await;
    assert_eq!(status, 200, "{}", reply.message);
    assert!(!everything(&reply, &events).contains(FAKE_PW));
    assert_eq!(reply.data["matches"][0]["name"], format!("token:{MASK}"));

    // And in the agent's own text, echoed back.
    let (_, reply, events) = call(
        &dir,
        "db_query",
        serde_json::json!({"connection": "cache", "query": format!("GET {FAKE_PW}")}),
    )
    .await;
    assert!(!everything(&reply, &events).contains(FAKE_PW));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_connections_secrets_are_its_vault_password_and_any_password_its_url_carries() {
    let (dir, paths) = temp_paths();
    let c = save(
        &paths,
        &format!("postgres://app:s3cret-pw@127.0.0.1:{}/shop", dead_port()),
        "Shop",
        true,
        false,
    );
    assert!(c.password_ref.starts_with("{{"), "moved to the Vault");
    assert_eq!(db_target::secrets_of(&paths, &c), ["s3cret-pw"]);

    // A record edited by hand: a literal password in the URL, or in the reference field.
    let mut literal = conn("01HLIT", "Literal");
    literal.url = Some("postgresql://app:in-the-url@db.example.com/shop".into());
    literal.password_ref = "in-the-field".into();
    assert_eq!(
        db_target::secrets_of(&paths, &literal),
        ["in-the-field", "in-the-url"]
    );
    // A reference the Vault has no value for is nothing to mask, and no password is nothing.
    let mut missing = conn("01HNONE", "None");
    missing.password_ref = "{{NO_SUCH_VAR}}".into();
    missing.url = Some("postgresql://app:{{NO_SUCH_VAR}}@db.example.com/shop".into());
    assert!(db_target::secrets_of(&paths, &missing).is_empty());
    missing.password_ref = String::new();
    missing.url = None;
    assert!(db_target::secrets_of(&paths, &missing).is_empty());

    let mut v = serde_json::json!({"a": ["x s3cret-pw y", {"s3cret-pw": "s3cret%2Dpw"}], "n": 1});
    db_target::redact_json(&mut v, &["s3cret-pw".to_string()]);
    assert_eq!(
        v,
        serde_json::json!({"a": ["x •••• y", {"••••": "s3cret%2Dpw"}], "n": 1})
    );
    let _ = std::fs::remove_dir_all(dir);
}

/* ──────────────────────── a name with a `/` in it ──────────────────────── */

#[test]
fn a_label_with_a_slash_or_a_backslash_is_one_segment_and_round_trips() {
    for label in [
        "user/1",
        "a/b/c",
        "back\\slash",
        "\\/",
        "/",
        "\\",
        "plain",
        "",
    ] {
        let path = db_browse::join("db0/Keys", label);
        assert_eq!(
            db_browse::split_path(&path),
            ["db0", "Keys", label],
            "{label:?} → {path:?}"
        );
    }
    assert_eq!(db_browse::escape_label("user/1"), "user\\/1");
    assert_eq!(db_browse::escape_label("a\\b"), "a\\\\b");
    assert_eq!(
        db_browse::split_path("a\\"),
        ["a\\"],
        "a trailing lone backslash is kept"
    );
}

#[tokio::test]
async fn schema_and_search_paths_with_a_slash_in_a_name_can_be_passed_back_as_they_are() {
    let c = conn("01HAAA", "Orders");
    let slashed = table_ref("a/b");
    let mut tree = fake_tree();
    for (r, kids) in tree.levels.iter_mut() {
        if *r == group_ref(DbGroup::Tables) {
            kids.as_mut().unwrap().push(DbNode::new(
                slashed.clone(),
                "a/b",
                DbNodeKind::Table,
                true,
            ));
        }
    }
    tree.levels
        .push((slashed, Ok(vec![column("a/b", "x/y", "integer")])));

    let (_, data) = db_browse::schema(&mut tree, &c, "maestro/public/Tables")
        .await
        .unwrap();
    let item = data["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["name"] == "a/b")
        .unwrap()
        .clone();
    let path = item["path"].as_str().unwrap();
    assert_eq!(path, "maestro/public/Tables/a\\/b");

    // The printed path, passed back as it is, opens that table.
    let (message, data) = db_browse::schema(&mut tree, &c, path).await.unwrap();
    assert_eq!(data["path"], "maestro/public/Tables/a\\/b");
    assert_eq!(
        data["items"][0]["path"],
        "maestro/public/Tables/a\\/b/x\\/y"
    );
    assert!(message.contains("column  x/y  — integer"), "{message}");
    // The folder can still be left out.
    let (_, data) = db_browse::schema(&mut tree, &c, "maestro/public/a\\/b")
        .await
        .unwrap();
    assert_eq!(data["path"], "maestro/public/Tables/a\\/b");

    let out = db_browse::search(
        &mut tree,
        DbNodeRef::Root,
        "",
        None,
        "/",
        SearchLimits::default(),
    )
    .await;
    let found: Vec<&str> = out.found.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(
        found,
        [
            "maestro/public/Tables/a\\/b",
            "maestro/public/Tables/a\\/b/x\\/y"
        ]
    );
    // An unescaped slash is two levels, and the error shows how the name is written.
    let err = db_browse::walk_to(&mut tree, "maestro/public/Tables/a/b")
        .await
        .unwrap_err();
    assert!(err.contains("There is no \"a\""), "{err}");
    assert!(err.contains("a\\/b"), "{err}");
}

#[tokio::test]
async fn a_redis_key_with_a_slash_round_trips_between_schema_search_and_path() {
    let redis = FakeRedis::start().await;
    let (dir, paths) = temp_paths();
    save(&paths, &redis.url(), "Cache", true, false);

    let (_, reply, _) = call(
        &dir,
        "db_schema",
        serde_json::json!({"connection": "cache", "path": "db0/Keys"}),
    )
    .await;
    let item = reply.data["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["name"] == "user/1")
        .unwrap()
        .clone();
    assert_eq!(item["path"], "db0/Keys/user\\/1");

    let (_, reply, _) = call(
        &dir,
        "db_search",
        serde_json::json!({"connection": "cache", "pattern": "user/"}),
    )
    .await;
    assert_eq!(reply.data["matches"][0]["path"], "db0/Keys/user\\/1");

    // Passed back as `--path`, it names the key (a leaf), not a "user" level that is not there.
    let (status, reply, _) = call(
        &dir,
        "db_schema",
        serde_json::json!({"connection": "cache", "path": item["path"]}),
    )
    .await;
    assert_eq!(status, 422);
    assert_eq!(
        reply.message,
        "\"db0/Keys/user\\/1\" is a key and has nothing below it."
    );
    let _ = std::fs::remove_dir_all(dir);
}
