#!/usr/bin/env node
/**
 * Connectivity smoke for the database-client integration fixture.
 *
 * ── What this is for ─────────────────────────────────────────────────────────
 * "Is my fixture healthy?", answerable BEFORE any Rust driver exists. It talks to
 * each engine with the client that already lives inside that engine's container
 * (`psql`, `mysql`, `clickhouse-client`, `mongosh`, `redis-cli`) via
 * `docker compose exec`, so it needs nothing installed on the host but Docker.
 *
 * That is deliberately the opposite of how the PRODUCT connects: the product
 * never shells out to a CLI, and its drivers are pure-Rust. This script is a
 * developer tool for validating the fixture, and it is not — and must never
 * become — a substitute for the `#[ignore]`d Rust tier that exercises the real
 * drivers (`src-tauri/tests/db_live.rs`).
 *
 * ── Why it is NOT in `npm test` ──────────────────────────────────────────────
 * It needs a running Docker daemon. `npm test` and `cargo test` are hermetic by
 * rule (no network, no daemon, no signed-in CLI), and a Docker-dependent test in
 * the default path turns a red gate into "probably just Docker again". Run it
 * with `npm run db:fixtures:smoke`, on demand.
 *
 * Every check below asserts a LITERAL expected value, never "whatever the fixture
 * happens to contain": a smoke test that reads its expectation from the thing
 * under test proves only that the plumbing is connected.
 */

import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const composeFile = path.join(here, "compose.yaml");

/**
 * @typedef {{ service: string, name: string, why: string, sh: string, expect: string }} Check
 */

/** @type {Check[]} */
const CHECKS = [
  /* ── PostgreSQL ─────────────────────────────────────────────────────────── */
  {
    service: "postgres",
    name: "reachable + seeded",
    why: "the six-row tracks table exists and is queryable over TCP",
    sh: `psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT count(*) FROM tracks"`,
    expect: "6",
  },
  {
    service: "postgres",
    name: "NULL vs empty string",
    why: "the NULL-vs-empty distinction the whole no-type-mapping design rests on",
    sh: `psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT (SELECT count(*) FROM tracks WHERE tag IS NULL) || '/' || (SELECT count(*) FROM tracks WHERE tag = '')"`,
    expect: "1/1",
  },
  {
    service: "postgres",
    name: "exotic types render as text",
    why: "an ENUM and an int[] must come back as text, not <unsupported>",
    sh: `psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT ensemble::text || ' ' || flags::text || ' ' || encode(raw,'hex') FROM tracks WHERE id = 1"`,
    expect: "duo {1,2,3} 48656c6c6f",
  },
  {
    service: "postgres",
    name: "row cap has something to cut",
    why: "`truncated` must be provable at the DEFAULT rowLimit of 500",
    sh: `psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT count(*) FROM tall"`,
    expect: "2000",
  },
  {
    service: "postgres",
    name: "table + view are distinguishable",
    why: "the tree splits `tables (n)` from `views (n)`",
    sh: `psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT string_agg(table_name || ':' || table_type, ',' ORDER BY table_name) FROM information_schema.tables WHERE table_schema='public'"`,
    expect: "tall:BASE TABLE,tracks:BASE TABLE,v_tracks:VIEW,wide:BASE TABLE",
  },
  {
    service: "postgres",
    name: "wide table is 200 columns",
    why: "the horizontal half of the grid's virtualisation window",
    sh: `psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT count(*) FROM information_schema.columns WHERE table_name='wide'"`,
    expect: "200",
  },
  {
    service: "postgres",
    name: "read-only is SERVER-enforced (separate round trip)",
    why: "the read-only boundary, proved against the server rather than asserted",
    // ⚠️  A measured trap the engine must not fall into:
    //     `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY` does NOT protect
    //     statements sent in the SAME simple-query batch as the SET. Postgres wraps
    //     a multi-statement simple query in one implicit transaction that began
    //     BEFORE the SET took effect, so the new default does not apply to it:
    //
    //       psql -tAc "SET SESSION CHARACTERISTICS …; INSERT …"   →  SET / INSERT 0 1
    //       psql -c   "SET SESSION CHARACTERISTICS …" -c "INSERT …"
    //                                                           →  SET / ERROR: cannot
    //                                                              execute INSERT in a
    //                                                              read-only transaction
    //
    //     Setting read-only "at connect" is correct — but `sqlx::raw_sql()` happily
    //     takes multiple `;`-separated statements, so prepending the SET to
    //     the user's script in one call is a natural implementation that would
    //     silently disable the guardrail. Hence two `-c` flags here: this check
    //     asserts the mechanism the app must actually use.
    //
    // If this ever prints 0 the INSERT SUCCEEDED and the fixture now has a 7th
    // tracks row, so "reachable + seeded" above starts failing too. That is the
    // intended blast radius: a broken read-only boundary must be loud.
    sh: `psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tA -c "SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY" -c "INSERT INTO tracks (id,title,ensemble,duration) VALUES (99,'NOPE','duo',1)" 2>&1 | grep -ci "read-only transaction"`,
    expect: "1",
  },
  {
    service: "postgres",
    name: "the cancel test's plumbing exists",
    why: "cancel is pg_backend_pid() at open + pg_cancel_backend() on a sibling connection",
    sh: `psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT count(*) FROM pg_stat_activity WHERE pid = pg_backend_pid()"`,
    expect: "1",
  },

  /* ── MySQL ──────────────────────────────────────────────────────────────── */
  {
    service: "mysql",
    name: "reachable + seeded",
    why: "the same six rows, second sqlx family",
    sh: `MYSQL_PWD="$MYSQL_PASSWORD" mysql -h127.0.0.1 -u"$MYSQL_USER" -N -B -e "SELECT count(*) FROM tracks" "$MYSQL_DATABASE"`,
    expect: "6",
  },
  {
    service: "mysql",
    name: "NULL vs empty string",
    why: "NULL vs '' across the MySQL text protocol (COM_QUERY)",
    sh: `MYSQL_PWD="$MYSQL_PASSWORD" mysql -h127.0.0.1 -u"$MYSQL_USER" -N -B -e "SELECT CONCAT((SELECT count(*) FROM tracks WHERE tag IS NULL), '/', (SELECT count(*) FROM tracks WHERE tag = ''))" "$MYSQL_DATABASE"`,
    expect: "1/1",
  },
  {
    service: "mysql",
    name: "row cap has something to cut",
    why: "`truncated` must be provable at the DEFAULT rowLimit of 500",
    sh: `MYSQL_PWD="$MYSQL_PASSWORD" mysql -h127.0.0.1 -u"$MYSQL_USER" -N -B -e "SELECT count(*) FROM tall" "$MYSQL_DATABASE"`,
    expect: "2000",
  },
  {
    service: "mysql",
    name: "table + view are distinguishable",
    why: "the tree splits `tables (n)` from `views (n)`",
    sh: `MYSQL_PWD="$MYSQL_PASSWORD" mysql -h127.0.0.1 -u"$MYSQL_USER" -N -B -e "SELECT GROUP_CONCAT(CONCAT(table_name,':',table_type) ORDER BY table_name) FROM information_schema.tables WHERE table_schema='maestro'" "$MYSQL_DATABASE"`,
    expect: "tall:BASE TABLE,tracks:BASE TABLE,v_tracks:VIEW",
  },
  {
    service: "mysql",
    name: "the auth-plugin accounts exist",
    why: "caching_sha2 (TLS-only full auth) + native (plaintext) — both code paths",
    sh: `MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -h127.0.0.1 -uroot -N -B -e "SELECT GROUP_CONCAT(CONCAT(user,'=',plugin) ORDER BY user) FROM mysql.user WHERE user LIKE 'agentstudio%'"`,
    expect:
      "agentstudio=caching_sha2_password,agentstudio_native=mysql_native_password,agentstudio_sha2=caching_sha2_password",
  },
  {
    service: "mysql",
    name: "server TLS really works",
    why: "caching_sha2 full auth needs an encrypted connection, so the fixture must actually offer one",
    // NB: `@@have_ssl` was REMOVED in MySQL 8.4 (deprecated in 8.0.26), so reading
    // the variable is not an option here. This connects with --ssl-mode=REQUIRED
    // and reads the negotiated cipher, which proves the tunnel rather than a flag.
    sh: `MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql --ssl-mode=REQUIRED -h127.0.0.1 -uroot -N -B -e "SHOW SESSION STATUS LIKE 'Ssl_cipher'" | awk -F'\\t' '{print ($2 != "") ? "tls-active" : "plaintext"}'`,
    expect: "tls-active",
  },
  {
    service: "mysql",
    name: "read-only is SERVER-enforced",
    why: "the read-only boundary, proved against the server rather than asserted",
    sh: `MYSQL_PWD="$MYSQL_PASSWORD" mysql -h127.0.0.1 -u"$MYSQL_USER" -N -B "$MYSQL_DATABASE" -e "SET SESSION TRANSACTION READ ONLY; INSERT INTO tracks (id,title,ensemble,duration) VALUES (99,'NOPE','duo',1)" 2>&1 | grep -ci "read only transaction"`,
    expect: "1",
  },
  {
    service: "mysql",
    name: "the cancel test's plumbing exists",
    why: "cancel is CONNECTION_ID() + KILL QUERY, verified against processlist",
    // --performance-schema=OFF (compose.yaml, for footprint) does NOT take
    // information_schema.processlist or SHOW PROCESSLIST away. Checked here so
    // the MySQL engine does not discover it the hard way.
    sh: `MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -h127.0.0.1 -uroot -N -B -e "SELECT count(*) FROM information_schema.processlist WHERE id = CONNECTION_ID()"`,
    expect: "1",
  },

  /* ── ClickHouse ─────────────────────────────────────────────────────────── */
  {
    service: "clickhouse",
    name: "reachable + seeded (HTTP interface)",
    why: "the product speaks ClickHouse over HTTP/8123, so smoke it there",
    sh: `wget -qO- --header="X-ClickHouse-User: $CLICKHOUSE_USER" --header="X-ClickHouse-Key: $CLICKHOUSE_PASSWORD" "http://127.0.0.1:8123/?database=$CLICKHOUSE_DB&query=SELECT%20count()%20FROM%20tracks"`,
    expect: "6",
  },
  {
    service: "clickhouse",
    name: "NULL vs empty string",
    why: "NULL vs \"\" in JSONCompact, where they are literally different JSON",
    sh: `clickhouse-client --host clickhouse --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --database "$CLICKHOUSE_DB" --query "SELECT concat(toString(countIf(tag IS NULL)), '/', toString(countIf(tag = ''))) FROM tracks"`,
    expect: "1/1",
  },
  {
    service: "clickhouse",
    name: "JSONCompact carries column types",
    why: "meta[].type is what drives DbCellKind for ClickHouse",
    sh: `wget -qO- --header="X-ClickHouse-User: $CLICKHOUSE_USER" --header="X-ClickHouse-Key: $CLICKHOUSE_PASSWORD" "http://127.0.0.1:8123/?database=$CLICKHOUSE_DB&query=SELECT%20tag%20FROM%20tracks%20WHERE%20id%3D2%20FORMAT%20JSONCompact" | tr -d ' \\n' | grep -o '"type":"[^"]*"'`,
    expect: '"type":"Nullable(String)"',
  },
  {
    service: "clickhouse",
    name: "row cap has something to cut",
    why: "`truncated` must be provable at the DEFAULT rowLimit of 500",
    sh: `clickhouse-client --host clickhouse --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --database "$CLICKHOUSE_DB" --query "SELECT count() FROM tall"`,
    expect: "2000",
  },
  {
    service: "clickhouse",
    name: "table + view are distinguishable",
    why: "ClickHouse reports this via system.tables.engine, not information_schema",
    sh: `clickhouse-client --host clickhouse --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --query "SELECT arrayStringConcat(arraySort(groupArray(concat(name, ':', engine))), ',') FROM system.tables WHERE database = '$CLICKHOUSE_DB'"`,
    expect: "tall:MergeTree,tracks:MergeTree,v_tracks:View",
  },
  {
    service: "clickhouse",
    name: "readonly=1 is SERVER-enforced",
    why: "ClickHouse's read-only boundary is a request setting, so prove the setting bites",
    sh: `clickhouse-client --host clickhouse --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --database "$CLICKHOUSE_DB" --readonly=1 --query "INSERT INTO tracks VALUES (99,'NOPE','duo',1,1,true,[],'{}','','2026-07-29 00:00:00.000','x')" 2>&1 | grep -ci "readonly"`,
    expect: "1",
  },
  {
    service: "clickhouse",
    name: "the cancel test's plumbing exists",
    why: "cancel is a client-chosen query_id + KILL QUERY WHERE query_id = …",
    sh: `clickhouse-client --host clickhouse --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --query "SELECT count() FROM system.processes WHERE query_id = queryID()"`,
    expect: "1",
  },

  /* ── MongoDB ────────────────────────────────────────────────────────────── */
  {
    service: "mongo",
    name: "reachable + seeded",
    why: "the same six documents",
    sh: `mongosh --quiet --host 127.0.0.1 -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin maestro --eval "print(db.tracks.countDocuments({}))"`,
    expect: "6",
  },
  {
    service: "mongo",
    name: "explicit null vs empty string vs MISSING",
    why: "Mongo has three states where SQL has two; all three are seeded",
    sh: `mongosh --quiet --host 127.0.0.1 -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin maestro --eval "print([db.tracks.countDocuments({tag:null,_id:{\\$ne:null}}), db.tracks.countDocuments({tag:''}), db.tracks.countDocuments({tempo:{\\$exists:false}})].join('/'))"`,
    expect: "1/1/1",
  },
  {
    service: "mongo",
    name: 'the tree label is literally "collections (6)"',
    why: "the label asserted rather than approximated",
    sh: `mongosh --quiet --host 127.0.0.1 -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin maestro --eval "print('collections (' + db.getCollectionNames().length + ')')"`,
    expect: "collections (6)",
  },
  {
    service: "mongo",
    name: "row cap has something to cut",
    why: "`truncated` must be provable at the DEFAULT rowLimit of 500",
    sh: `mongosh --quiet --host 127.0.0.1 -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin maestro --eval "print(db.tall.countDocuments({}))"`,
    expect: "2000",
  },
  {
    service: "mongo",
    name: "BSON types survive to extended JSON",
    why: "Decimal128/Binary/ISODate/Int64 must all become text, none dropped",
    sh: `mongosh --quiet --host 127.0.0.1 -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin maestro --eval "const d=db.tracks.findOne({_id:ObjectId('000000000000000000000001')}); print([d.duration.constructor.name, d.raw.constructor.name, d.at.constructor.name, d.seq.constructor.name].join(','))"`,
    expect: "Decimal128,Binary,Date,Long",
  },

  /* ── Redis ──────────────────────────────────────────────────────────────── */
  {
    service: "redis",
    name: "reachable + seeded",
    why: "the marker key the healthcheck waits on",
    sh: `redis-cli GET fixture:seeded`,
    expect: "1",
  },
  {
    service: "redis",
    name: "absent key vs empty-string value",
    why: "the Redis form of NULL vs '': nil is not \"\"",
    sh: `redis-cli --no-raw GET fixture:absent; redis-cli --no-raw GET fixture:empty`,
    expect: '(nil)\n""',
  },
  {
    service: "redis",
    name: "one key per RESP type",
    why: "the tree's per-key sub-label is driven by TYPE",
    sh: `for k in string hash list set zset stream; do redis-cli TYPE "fixture:$k"; done | tr '\\n' ' '`,
    expect: "string hash list set zset stream",
  },
  {
    service: "redis",
    name: "SCAN needs several round trips",
    why: "KEYS is refused in both modes; the tree must use a cursor",
    sh: `redis-cli DBSIZE`,
    expect: "5013",
  },
  {
    service: "redis",
    name: "binary-unsafe value is really binary",
    why: "the hex fallback has a value that forces it",
    sh: `redis-cli --no-raw GET fixture:binary`,
    expect: '"\\x00\\xff\\x10"',
  },
];

/** @param {string[]} args */
function run(args) {
  return new Promise((resolve) => {
    execFile(
      "docker",
      args,
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr });
      },
    );
  });
}

const GREEN = "[32m";
const RED = "[31m";
const DIM = "[2m";
const OFF = "[0m";

async function main() {
  console.log(`db-fixtures smoke — ${composeFile}`);
  console.log(`${DIM}TEST FIXTURE ONLY. Docker is a developer dependency here, never a product one.${OFF}\n`);

  let failures = 0;
  let lastService = "";

  for (const check of CHECKS) {
    if (check.service !== lastService) {
      console.log(`\n── ${check.service} ${"─".repeat(Math.max(0, 62 - check.service.length))}`);
      lastService = check.service;
    }
    const { code, stdout, stderr } = await run([
      "compose",
      "-f",
      composeFile,
      "exec",
      "-T",
      check.service,
      "sh",
      "-c",
      check.sh,
    ]);
    const actual = stdout.replace(/\r/g, "").trim();
    const ok = code === 0 && actual === check.expect;
    if (!ok) failures += 1;
    console.log(
      `${ok ? `${GREEN}  PASS${OFF}` : `${RED}  FAIL${OFF}`}  ${check.name}\n` +
        `        ${DIM}${check.why}${OFF}\n` +
        `        got: ${JSON.stringify(actual)}` +
        (ok ? "" : `\n        ${RED}expected: ${JSON.stringify(check.expect)}${OFF}` +
          (stderr.trim() ? `\n        ${RED}stderr: ${stderr.trim().split("\n").slice(0, 4).join(" | ")}${OFF}` : "")),
    );
  }

  console.log(
    `\n${failures === 0 ? GREEN : RED}${CHECKS.length - failures}/${CHECKS.length} checks passed${OFF}`,
  );
  if (failures > 0) {
    console.log(
      `${DIM}If the stack is not up: npm run db:fixtures:up. If it is up but stale: npm run db:fixtures:reset.${OFF}`,
    );
  }
  process.exit(failures === 0 ? 0 : 1);
}

await main();
