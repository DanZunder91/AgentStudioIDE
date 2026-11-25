//! What an agent's SQL may not reach on any connection, read-only or not: the database server's
//! files and programs, connections of its own, other sessions, and the server's own settings.
//!
//! # Why read-only does not cover it
//!
//! A read-only transaction stops **data writes**. It does not stop a statement that acts on the
//! server rather than on its data, and a privileged account (a PostgreSQL superuser or a member of
//! `pg_read_server_files` / `pg_execute_server_program`, a MySQL account with `FILE`) can run them
//! inside one. Measured against the fixture, whose account is a superuser as local accounts often
//! are: `COPY (SELECT 1) TO PROGRAM 'psql … -c "INSERT …"'` wrote a row through a read-only
//! connection, and `pg_read_binary_file('/proc/1/environ')` read the very password Agent Studio
//! dialled with, which a `reverse()` carried past the reply's password mask. So these are refused
//! for an agent on every PostgreSQL and MySQL connection before a session is opened.
//!
//! # A text check, so a speed bump — and the help says so
//!
//! Read with [`crate::db::sql_words`], which does not trust the splitter: every word of the text
//! (strings and comments included) is checked against the function lists, and every place a
//! statement can start — the text's start and after every `;` — against the statement lists. So a
//! refusal can be a false alarm (`SELECT 'copy the program'`), and a way out these lists do not
//! name is not caught: a function the database already has that does the same under another name,
//! or SQL a function the database already has builds at run time. Those run with the database
//! account's privileges, and the only boundary for them is the account. `db_query`'s help says to
//! use a least-privileged account for agent work.

use crate::db::model::DbFamily;
use crate::db::sql_words::{self, Dialect};

/// A word in the text that is refused wherever it appears. A trailing `*` matches every word that
/// starts with the rest (`dblink*`: `dblink`, `dblink_exec`, …).
type Word = (&'static str, &'static str);

/// A statement refused by its keyword, and — when the keyword alone is not enough — by one more
/// word that must follow it somewhere in the statement (`""`: the keyword alone).
type Statement = (&'static str, &'static str, &'static str);

const PG_FILES: &str = "it reads or writes the database server's own files";
const PG_LARGE_OBJECT: &str =
    "it writes a large object, or moves one between the database and the server's disk";
const PG_OUTSIDE: &str =
    "it opens a connection of its own, outside this run's transaction and its read-only";
const PG_SERVER: &str =
    "it acts on the database server itself, which a read-only transaction does not stop";
const PG_SECRETS: &str = "it holds passwords or password hashes the server keeps";
const PG_DYNAMIC: &str = "it runs SQL given as text, where no check can read it";

const PG_WORDS: &[Word] = &[
    ("pg_read_file", PG_FILES),
    ("pg_read_binary_file", PG_FILES),
    ("pg_stat_file", PG_FILES),
    ("pg_ls_*", PG_FILES),
    ("pg_file_*", PG_FILES),
    ("pg_logdir_ls", PG_FILES),
    ("lo_import", PG_LARGE_OBJECT),
    ("lo_export", PG_LARGE_OBJECT),
    ("lo_from_bytea", PG_LARGE_OBJECT),
    ("lo_put", PG_LARGE_OBJECT),
    ("lo_create", PG_LARGE_OBJECT),
    ("lo_creat", PG_LARGE_OBJECT),
    ("lo_unlink", PG_LARGE_OBJECT),
    ("lo_truncate*", PG_LARGE_OBJECT),
    ("lowrite", PG_LARGE_OBJECT),
    ("dblink*", PG_OUTSIDE),
    ("postgres_fdw*", PG_OUTSIDE),
    ("pg_background*", PG_OUTSIDE),
    ("pg_user_mapping*", PG_SECRETS),
    ("pg_authid", PG_SECRETS),
    ("pg_shadow", PG_SECRETS),
    ("pg_terminate_backend", "it ends another session"),
    ("pg_cancel_backend", "it stops another session's statement"),
    ("pg_reload_conf", PG_SERVER),
    ("pg_rotate_logfile", PG_SERVER),
    ("pg_promote", PG_SERVER),
    ("pg_switch_wal", PG_SERVER),
    ("pg_create_restore_point", PG_SERVER),
    ("pg_log_backend_memory_contexts", PG_SERVER),
    ("pg_stat_reset*", PG_SERVER),
    ("pg_create_physical_replication_slot", PG_SERVER),
    ("pg_create_logical_replication_slot", PG_SERVER),
    ("pg_drop_replication_slot", PG_SERVER),
    ("pg_copy_physical_replication_slot", PG_SERVER),
    ("pg_copy_logical_replication_slot", PG_SERVER),
    ("pg_replication_origin_*", PG_SERVER),
    (
        "set_config",
        "it changes the session's settings, its role and access mode among them",
    ),
    ("query_to_xml*", PG_DYNAMIC),
];

const PG_STATEMENTS: &[Statement] = &[
    (
        "copy",
        "",
        "COPY … TO/FROM PROGRAM runs a program on the database server, and COPY to or from a \
         file reads or writes its files; a read-only transaction stops neither. Read rows with \
         SELECT",
    ),
    (
        "do",
        "",
        "a DO block runs code, and SQL it builds at run time, where no check can read it",
    ),
    ("load", "", "it loads a library into the database server"),
    (
        "prepare",
        "transaction",
        "it leaves a transaction on the server after the session ends",
    ),
    (
        "set",
        "role",
        "it changes whose privileges the session runs with",
    ),
    (
        "set",
        "authorization",
        "it changes whose privileges the session runs with",
    ),
    (
        "set",
        "session_authorization",
        "it changes whose privileges the session runs with",
    ),
    ("alter", "system", "it rewrites the server's configuration"),
    ("alter", "role", "it changes a database account"),
    ("alter", "user", "it changes a database account"),
];

const MY_FILES: &str = "it reads or writes the database server's own files";
const MY_SERVER: &str =
    "it acts on the database server itself, which a read-only transaction does not stop";

const MY_WORDS: &[Word] = &[
    (
        "outfile",
        "SELECT … INTO OUTFILE writes a file on the database server",
    ),
    (
        "dumpfile",
        "SELECT … INTO DUMPFILE writes a file on the database server",
    ),
    ("load_file", MY_FILES),
];

const MY_STATEMENTS: &[Statement] = &[
    (
        "load",
        "",
        "LOAD DATA and LOAD XML read a file into a table",
    ),
    ("kill", "", "it ends another session or its statement"),
    ("shutdown", "", "it stops the database server"),
    ("restart", "", "it restarts the database server"),
    ("install", "", "it loads code into the database server"),
    ("uninstall", "", "it unloads code from the database server"),
    ("clone", "", MY_SERVER),
    ("flush", "", MY_SERVER),
    ("purge", "", "it deletes the server's binary logs"),
    ("reset", "", MY_SERVER),
    ("change", "", "it changes the server's replication"),
    ("stop", "", "it stops the server's replication"),
    ("start", "replica", "it starts the server's replication"),
    ("start", "slave", "it starts the server's replication"),
    (
        "start",
        "group_replication",
        "it starts the server's replication",
    ),
    (
        "set",
        "global",
        "it changes the server's settings for every session",
    ),
    (
        "set",
        "persist",
        "it changes the server's settings for every session",
    ),
    (
        "set",
        "persist_only",
        "it changes the server's settings for every session",
    ),
    (
        "set",
        "password",
        "it changes a database account's password",
    ),
    ("alter", "user", "it changes a database account"),
];

/// `Some(reason)` when `text`, sent to a `family` connection by an agent, reaches something this
/// module refuses (see the module doc). `None` for every other family: their tools have their own
/// checks (Redis's credential commands, the engines' read-only allowlists).
pub fn sql_refusal(family: DbFamily, text: &str) -> Option<String> {
    let (dialect, words, statements) = match family {
        DbFamily::Postgres => (Dialect::Postgres, PG_WORDS, PG_STATEMENTS),
        DbFamily::Mysql => (Dialect::Mysql, MY_WORDS, MY_STATEMENTS),
        _ => return None,
    };
    if family == DbFamily::Mysql && sql_words::has_executable_comment(text) {
        return Some(refused(
            "/*! … */",
            "MySQL and MariaDB run what is inside an executable comment, where no check reads it",
        ));
    }
    if family == DbFamily::Postgres && text.to_ascii_lowercase().contains("u&\"") {
        return Some(refused(
            "U&\"…\"",
            "a Unicode-escaped identifier can spell any name, where no check can read it",
        ));
    }
    for found in sql_words::statements(text, dialect) {
        let keyword = found[0].as_str();
        let hit = statements.iter().find(|(k, then, _)| {
            *k == keyword && (then.is_empty() || found[1..].iter().any(|w| w == then))
        });
        if let Some((k, then, why)) = hit {
            let shown = if then.is_empty() {
                k.to_ascii_uppercase()
            } else {
                format!("{} {}", k.to_ascii_uppercase(), then.to_ascii_uppercase())
            };
            return Some(refused(&shown, why));
        }
    }
    let all = sql_words::words(text);
    if family == DbFamily::Postgres
        && all.iter().any(|w| w == "program")
        && all.iter().any(|w| w == "copy")
    {
        return Some(refused("COPY … PROGRAM", PG_STATEMENTS[0].2));
    }
    for w in &all {
        let hit = words.iter().find(|(name, _)| match name.strip_suffix('*') {
            Some(prefix) => w.starts_with(prefix),
            None => w == name,
        });
        if let Some((_, why)) = hit {
            return Some(refused(w, why));
        }
    }
    None
}

fn refused(what: &str, why: &str) -> String {
    format!(
        "`{what}` is not available to an agent: {why}. A read-only connection stops data \
         writes, not this, and an agent acts with the database account's privileges."
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pg(text: &str) -> Option<String> {
        sql_refusal(DbFamily::Postgres, text)
    }

    fn my(text: &str) -> Option<String> {
        sql_refusal(DbFamily::Mysql, text)
    }

    #[test]
    fn postgres_ways_to_the_servers_files_programs_and_sessions_are_refused_in_every_spelling() {
        for text in [
            // The measured exploits: a shell command, and the server's environment read back.
            "COPY (SELECT 1) TO PROGRAM 'psql -c \"INSERT …\"'",
            "SELECT reverse(encode(pg_read_binary_file('/proc/1/environ'), 'escape'))",
            // COPY in any case, after comments of every kind, after a `;` the splitter would read
            // as inside a string, and to or from a file.
            "copy t to program 'x'",
            "/* /* nested */ */ COPY t TO '/tmp/x'",
            "-- why\nCOPY t FROM '/etc/passwd'",
            "SELECT texte'\\'; COPY t TO PROGRAM 'x'; SELECT 'x'",
            "COPY t TO STDOUT",
            // Functions, however they are written.
            "SELECT pg_read_file('/etc/hostname')",
            "SELECT PG_CATALOG.PG_READ_FILE('/etc/hostname')",
            "SELECT \"pg_read_file\"('/etc/hostname')",
            "SELECT pg_read_file/**/('/etc/hostname')",
            "SELECT U&\"pg\\005fread\\005ffile\"('/etc/hostname')",
            "SELECT u&\"x\"()",
            "SELECT pg_ls_dir('.')",
            "SELECT pg_ls_waldir()",
            "SELECT pg_stat_file('x')",
            "SELECT lo_import('/etc/passwd')",
            "SELECT lo_export(1, '/tmp/x')",
            "SELECT lo_from_bytea(0, 'x')",
            "SELECT dblink('host=x', 'INSERT …')",
            "SELECT dblink_exec('x')",
            "SELECT postgres_fdw_disconnect_all()",
            "SELECT umoptions FROM pg_user_mapping",
            "SELECT * FROM pg_user_mappings",
            "SELECT rolpassword FROM pg_authid",
            "SELECT pg_terminate_backend(42)",
            "SELECT pg_cancel_backend(42)",
            "SELECT pg_reload_conf()",
            "SELECT pg_stat_reset()",
            "SELECT set_config('role', 'postgres', false)",
            "SELECT query_to_xml('SELECT 1', true, true, '')",
            // Statements that act on the server or the session's identity.
            "DO $$ BEGIN EXECUTE 'CO' || 'PY t TO PROGRAM ''x'''; END $$",
            "LOAD 'plpgsql'",
            "PREPARE TRANSACTION 'x'",
            "SET ROLE postgres",
            "set local role postgres",
            "SET SESSION AUTHORIZATION postgres",
            "SET session_authorization = 'postgres'",
            "ALTER SYSTEM SET archive_command = 'x'",
            "ALTER ROLE current_user PASSWORD 'x'",
            "ALTER USER me PASSWORD 'x'",
        ] {
            assert!(pg(text).is_some(), "{text:?} was not refused");
        }
    }

    #[test]
    fn ordinary_postgres_reads_and_writes_are_not_refused() {
        for text in [
            "SELECT * FROM tracks WHERE id < 9000 ORDER BY id",
            "WITH x AS (SELECT 1) SELECT * FROM x",
            "EXPLAIN SELECT count(*) FROM tracks",
            "SELECT current_setting('server_version')",
            "INSERT INTO t (a) VALUES (1)",
            "PREPARE p AS SELECT 1",
            "SET search_path = app",
            "ALTER TABLE t ADD COLUMN c int",
            "SELECT 'copy' AS word",
            "SELECT doc, loader, settings FROM t",
            "CALL refresh_totals()",
        ] {
            assert!(pg(text).is_none(), "{text:?} was refused: {:?}", pg(text));
        }
    }

    #[test]
    fn mysql_ways_to_the_servers_files_and_settings_are_refused_in_every_spelling() {
        for text in [
            "SELECT LOAD_FILE('/etc/hostname')",
            "SELECT 1 INTO OUTFILE '/var/lib/mysql-files/x'",
            "SELECT 1 INTO DUMPFILE '/tmp/x'",
            "LOAD DATA INFILE '/etc/passwd' INTO TABLE t",
            "--\u{1}\nKILL 42",
            "# x\nKILL QUERY 42",
            "SHUTDOWN",
            "INSTALL PLUGIN x SONAME 'x.so'",
            "FLUSH TABLES WITH READ LOCK",
            "PURGE BINARY LOGS BEFORE NOW()",
            "RESET MASTER",
            "STOP REPLICA",
            "START REPLICA",
            "SET GLOBAL read_only = 0",
            "SET @@GLOBAL.read_only = 0",
            "SET PERSIST max_connections = 1",
            "SET PASSWORD = 'x'",
            "ALTER USER USER() IDENTIFIED BY 'x'",
            "SELECT 1 /*!50000 , LOAD_FILE('/etc/hostname') */",
            "/*M!100000 KILL 42 */",
        ] {
            assert!(my(text).is_some(), "{text:?} was not refused");
        }
        for text in [
            "SELECT * FROM tracks",
            "SELECT @@GLOBAL.version",
            "SHOW WARNINGS",
            "START TRANSACTION READ ONLY",
            "SET @x = 1",
            "SET SESSION sql_mode = ''",
            "SELECT killed, loader FROM t",
            "/*+ MAX_EXECUTION_TIME(10) */ SELECT 1",
            "--1",
        ] {
            assert!(my(text).is_none(), "{text:?} was refused: {:?}", my(text));
        }
    }

    #[test]
    fn a_refusal_names_what_was_refused_and_the_real_boundary() {
        let why = pg("COPY t TO PROGRAM 'x'").unwrap();
        assert!(
            why.starts_with("`COPY` is not available to an agent:"),
            "{why}"
        );
        assert!(
            why.contains("an agent acts with the database account's privileges"),
            "{why}"
        );
        assert!(pg("PREPARE TRANSACTION 'x'")
            .unwrap()
            .starts_with("`PREPARE TRANSACTION` is not"));
        assert!(pg("SELECT dblink_exec('x')")
            .unwrap()
            .starts_with("`dblink_exec` is not"));
        // COPY hidden from every statement start still has its two words in the text.
        assert!(pg("SELECT 1 /* ; */ ; x COPY t TO PROGRAM 'x'")
            .unwrap()
            .starts_with("`COPY … PROGRAM` is not"));
        assert!(my("SELECT 1 /*! , 2 */")
            .unwrap()
            .starts_with("`/*! … */` is not"));
    }

    #[test]
    fn other_engines_have_checks_of_their_own() {
        for family in [
            DbFamily::Redis,
            DbFamily::Mongodb,
            DbFamily::Clickhouse,
            DbFamily::Dynamodb,
        ] {
            assert!(sql_refusal(family, "COPY t TO PROGRAM 'x'").is_none());
        }
    }
}
