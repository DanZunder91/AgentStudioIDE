# `docker/db-fixtures` — real databases for the database-client integration tier

Five real database servers, on non-default localhost ports, seeded with a tiny
fixture dataset, so the **database client** can be proven against
actual engines instead of mocks: the client is tested against databases running
in Docker, and this is that tier.

Each driver has something real to prove itself against, instead of a mock that
agrees with whatever the driver already does.

---

## Read this first: Docker is a DEVELOPER dependency, never a product one

**The shipped app does not need Docker, and must never need it.** The
zero-install principle (installing the app is all a user should need to start
working) applies to the product: the database client uses pure-Rust/native drivers
(`sqlx`, `mongodb`, `redis`, `reqwest`) and talks to whatever server the user
points it at. This directory exists only so *our tests* have a server to talk to.

Nothing here runs in the default quality gates, and that is deliberate:

* `cargo test` and `npm test` are **hermetic** by rule — no network, no daemon,
  no developer environment.
* A Docker-dependent test in the default path turns a red gate into *"probably just
  Docker again"*, and a gate that is permanently red gets waved through along with
  whatever real failure is standing next to it. A signal that is always on carries
  zero bits.

So the Rust tests that use this stack are `#[ignore]`d and run on demand — the
pattern the repo already established with
`usage.rs::live_smoke_reads_real_usage_from_the_cli` and the live TLS smokes in
`http.rs` / `ws.rs` / `grpc.rs`. Nothing here is wired into `.github/workflows/`.

---

## Commands

```bash
npm run db:fixtures:up        # start all five, block until every one is HEALTHY (= seeded)
npm run db:fixtures:smoke     # "is my fixture healthy?" — 33 checks across all five engines
npm run db:fixtures:status    # docker compose ps
npm run db:fixtures:logs      # last 80 lines per service
npm run db:fixtures:reset     # down -v + up  →  a guaranteed-clean, freshly seeded stack
npm run db:fixtures:down      # stop and REMOVE VOLUMES
```

Then the opt-in Rust tier (see *What the Rust tier encodes* below):

```bash
npm run db:fixtures:up
cargo test --manifest-path src-tauri/Cargo.toml -- --ignored db_live
npm run db:fixtures:down
```

`up` uses `--wait`, which blocks on the healthchecks — **no test ever needs a
`sleep`**. And because every healthcheck queries the *seed data* rather than just
the port (see below), `up` returning means the stack is queryable **and loaded**.

### Always tear down with `-v`

`db:fixtures:down` passes `-v`. No named volumes are declared here, so each image's
own `VOLUME` becomes an *anonymous* volume; `-v` removes them, which is what makes
the next `up` re-run every seed script. A plain `docker compose down` keeps those
volumes and **the seeds will not re-run** — you get yesterday's data with today's
schema. Data is ephemeral by design; there is nothing here worth keeping.

---

## Port map

Deliberately **non-default** and bound to **127.0.0.1 only**, so this fixture
cannot collide with — or worse, be mistaken for — a developer's own local database.
That is not hypothetical: development machines commonly already have containers
parked on 5432, 3306, 27017 and 6379.

| Engine | Host port | Container port | Notes |
|---|---|---|---|
| PostgreSQL | **55432** | 5432 | |
| MySQL | **53306** | 3306 | |
| ClickHouse | **58123** | 8123 | HTTP interface only. The product talks to ClickHouse over HTTP with the `reqwest` already in the tree, so the native port 9000 is deliberately **not** published — publishing it would invite a test to use a protocol the product does not speak. |
| MongoDB | **57017** | 27017 | |
| Redis | **56379** | 6379 | |

## Credentials

> ### ⚠️ TEST FIXTURE ONLY — THROWAWAY CREDENTIALS
> Every value below is fake, published in this repo, and bound to localhost.
> **Never reuse any of them anywhere real.** They are spelled `*-test-pw` on
> purpose, so a grep across a real deployment can find and reject them.

| Engine | User | Password | Database |
|---|---|---|---|
| PostgreSQL | `agentstudio` | `agentstudio-test-pw` | `maestro` |
| MySQL | `agentstudio` | `agentstudio-test-pw` | `maestro` |
| MySQL (root) | `root` | `agentstudio-root-test-pw` | — |
| MySQL (auth-plugin probes) | `agentstudio_sha2` / `agentstudio_native` | `agentstudio-sha2-test-pw` / `agentstudio-native-test-pw` | `maestro`, SELECT only |
| ClickHouse | `agentstudio` | `agentstudio-test-pw` | `maestro` |
| MongoDB | `agentstudio` | `agentstudio-test-pw` | `maestro` (auth source `admin`) |
| Redis | *(none — password only)* | `agentstudio-test-pw` | db `0` |

They are declared **once**, as YAML anchors at the top of
[`compose.yaml`](./compose.yaml), and healthchecks read them out of the container
environment via `$$VAR`, so no password string is duplicated anywhere.

They are **not** in a `.env` file on purpose: `.env*` is `.gitignore`d, so a fresh
clone would come up broken.

### On `src-tauri/tests/fixtures_no_secrets.rs`

That scanner — the repo's belt-and-braces denylist over committed fixtures — walks
`src-tauri/tests/fixtures/**` for `*.json` / `*.jsonl`. This tree is outside it on
**both** axes (different root, non-JSON extensions), so it needs no allowlist entry —
always prefer that to teaching a secret-scanner to ignore something.

Stated plainly for anyone who might widen that scan later: `compose.yaml` **does**
match its `secret kv` pattern
(`(?i)(password|secret|api[_-]?key|token)\s*[:=]\s*\S{6,}`) and this README matches
its `conn string` pattern (`(postgres|mysql|mongodb|redis)://`). The correct
response is to keep the scan narrow — **not** to shorten these passwords to dodge a
regex. A fixture password you cannot recognise as fake at a glance is worse than
one a scanner would flag.

---

## Pinned images, and why these versions

Every tag is pinned to an **explicit patch**. Never `:latest`, and never a bare
`:17` — an unpinned tag makes a test that passes today fail tomorrow for reasons
that have nothing to do with our code.

| Service | Image | Why this version | Size (arm64) | Resolved digest |
|---|---|---|---|---|
| postgres | `postgres:17.6-alpine` | Current 17.x patch line. `-alpine` is the smallest official variant (385 MB vs 660 MB) and is genuinely multi-arch. | 385 MB | `sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94` |
| mysql | `mysql:8.4.6` | Current **8.4 LTS** patch. 8.4 rather than 8.0 **because its defaults bite us**: `caching_sha2_password` is the default auth plugin and `mysql_native_password` is disabled by default — precisely the auth-plugin situation the driver must handle. A friendlier 8.0 would hide the bug. | 1.07 GB | `sha256:869218921e61d6c3c89820955d63cca42971f0e3e6c1e2792247bbd944ebc6e9` |
| clickhouse | `clickhouse/clickhouse-server:25.6-alpine` | Pinned minor on the current line; alpine for size (760 MB vs 975 MB). | 760 MB | `sha256:aa13b8b9ac1aa22fbae3ee98a0c954bfc2037bb5b1ce3182390507cf72600009` |
| mongo | `mongo:8.0.15` | Pinned patch on the current GA line; the `mongodb` 3.8 crate targets 8.x. Ships `mongosh`, which the healthcheck and the smoke both use. | 1.2 GB | `sha256:f4d54619262ae3bc6a0a8efbebcef970b87b8ad70697479a75ce308a6f400158` |
| redis | `redis:8.2.1-alpine` | Pinned patch, alpine. | 98.8 MB | `sha256:987c376c727652f99625c7d205a1cba3cb2c53b92b0b62aade2bd48ee1593232` |

Digests recorded for the `linux/arm64` variants, so a future
"did the tag move under us?" question is answerable. The compose file pins tags
rather than digests deliberately: a digest is per-architecture, and pinning one
would break the fixture for every developer not on the same arch as whoever
committed it. If reproducibility ever needs to be absolute, pin per-arch digests in
a separate override file rather than in `compose.yaml`.

---

## "Healthy" means "seeded", on purpose

Every service's healthcheck queries the **seed data**, not just the port:

| Service | The healthcheck asserts |
|---|---|
| postgres | `SELECT count(*) FROM tracks` is `6`, over **TCP** (`-h 127.0.0.1`) |
| mysql | `SELECT count(*) FROM tracks` is `6`, over TCP |
| clickhouse | `SELECT count() FROM tracks` is `6`, dialled via the **service name** |
| mongo | `db.getCollectionNames().length` is `6` |
| redis | the `fixture:seeded` marker key exists (set **last**, after a key-count assertion) |

Two subtleties this buys:

* **No false green during initialisation.** Every one of these images runs a
  *temporary* server to execute its init scripts. `pg_isready` or `redis-cli ping`
  can pass against that temporary server, before the real listener and before the
  seed. Postgres and MySQL are probed over TCP (their init-phase servers are
  socket-only / `--skip-networking`); ClickHouse is probed via the container's own
  **service name**, because its init-phase server binds loopback only, so dialling
  the bridge IP is the same thing a real client does.
* **A broken seed fails loudly at `up`**, not silently at assert time three tests
  later.

---

## Seed data, and which design-critical case each row exercises

Tiny and readable on purpose — this is a fixture, not a benchmark. Every row exists
to exercise one case the database client has to handle.

### The shared `tracks` shape (postgres / mysql / clickhouse / mongo)

Six rows, identical in meaning across all four engines, so one Rust test body can
assert the same shape everywhere:

| Row | What it is for |
|---|---|
| 1 | Baseline: every `DbCellKind` populated — number, text, bool, json, binary, datetime. |
| 2 | **`tag` is NULL** → must arrive as JSON `null` (Rust `None`). |
| 3 | **`tag` is the EMPTY STRING** → must arrive as JSON `""` (Rust `Some("")`). |
| 4 | Non-ASCII (`ünïcode ✓ 中文`) plus an **embedded tab and newline**, so the grid's row/column geometry cannot be broken by whitespace inside a cell. |
| 5 | A **text** value that *looks* like Postgres' bytea hex encoding (`\x4142`), sitting next to a **real** binary column. Proves `DbCellKind` comes from the **column's declared type** and is never sniffed from the value — otherwise the app would be lying about the data. |
| 6 | **JSON `null` as a value** while other columns are **SQL NULL**. The two nulls must not collapse. Also a negative number and `false`. |

**Rows 2 and 3 together are the single most important thing in this fixture.** The
whole no-type-mapping design (every value is read as text) rests on NULL and `""` being distinguished *by
construction*, and a driver upgrade is exactly the kind of change that could
quietly collapse them.

### Per engine

| Engine | Tables / collections / keys | Design-critical extras |
|---|---|---|
| **PostgreSQL** | `tracks` (6), `v_tracks` (view), `tall` (2000), `wide` (200 cols × 1) | A user-defined **`ENUM`** and an **`int[]` array** — types a per-OID binary decoder has never heard of, which the text path renders for free. `numeric(12,4)` proves no `rust_decimal`/`bigdecimal` is needed. `bytea` exercises the non-UTF-8 → `Vec<u8>` → hex fallback. Server timezone forced to **UTC** so expected timestamp strings are stable (the client never reformats a timestamp). |
| **MySQL** | `tracks` (6), `v_tracks` (view), `tall` (2000) | Same shape through the **MySQL text protocol** (`COM_QUERY`). `enum`, `json`, `blob`, `decimal(12,4)`, `timestamp(6)`, `--default-time-zone=+00:00`. Plus **three accounts** covering the auth-plugin fork — see below. |
| **ClickHouse** | `tracks` (6), `v_tracks` (view), `tall` (2000) | `LowCardinality(String)`, `Enum8`, `Nullable(Decimal(12,4))`, `DateTime64(3,'UTC')`, `Array(String)` — a genuinely different type system, which is the point. Views are reported through `system.tables.engine = 'View'`, **not** `information_schema`, so `db_children` needs a different query here. |
| **MongoDB** | exactly **6 collections**: `tracks` (6 docs), `tall` (2000), `cues`, `catalog`, `journal`, `studios` (empty) | `ObjectId`, `ISODate`, `BinData`, `Decimal128`, `NumberLong` past IEEE-754 exactness, `NumberInt`, a 3-level nested subdocument, an index (`title_at`) for `listIndexes`, one deliberately empty collection, and **three** null-ish states: explicit `null` (doc 2), `""` (doc 3), and **absent fields** (doc 6 omits `tempo` and `raw`) — because Mongo has three where SQL has two, and the column-union projection must handle all of them. |
| **Redis** | 12 `fixture:*` keys + **5000** `k:*` keys | One key per RESP type (string, hash, list, set, zset, stream); an **empty-string value** beside a deliberately-absent key (`fixture:absent`) — Redis's form of the NULL/`""` distinction; a **non-UTF-8 value** (`\x00\xff\x10`) forcing the hex fallback; a key name containing a space and colons; a key with a TTL. The 5000 `k:*` keys make the tree's key browse need **several `SCAN` round trips** — the console refuses `KEYS` in both modes because it is O(N) and blocks the single-threaded server. |

`tall` has **2000 rows** everywhere, comfortably past the shipped default
`rowLimit` of 500, so `truncated` is provable at the real default and not
only at a contrived cap of 10.

### The three MySQL accounts

sqlx's `mysql-rsa` feature cannot be enabled (RUSTSEC-2023-0071, no fixed version),
so `caching_sha2_password` full authentication only works inside a TLS tunnel. The
fixture ships one account per code path so the Rust test can prove **both branches**
instead of asserting a captured error string:

| Account | Plugin | What it proves |
|---|---|---|
| `agentstudio` | `caching_sha2_password` | The normal path. Works over TLS; works over plaintext only on the *fast* (server-cached) path. |
| `agentstudio_sha2` | `caching_sha2_password` | Used by nothing else, so a test can hit it **uncached** over plaintext and assert the *"RSA auth backend disabled … or use TLS"* mapping. **`FLUSH PRIVILEGES` first** — it clears the caching_sha2 credential cache; otherwise a prior successful TLS login makes the plaintext attempt pass. |
| `agentstudio_native` | `mysql_native_password` | The control case: authenticates over plaintext, proving the failure above is about the auth plugin and not about our connection code. Needs `--mysql-native-password=ON`, which `compose.yaml` sets (8.4 disables the plugin by default). |

---

## "Is my fixture healthy?" — the documented procedure

```bash
npm run db:fixtures:smoke
```

33 checks across all five engines, each asserting a **literal** expected value
(never "whatever the fixture happens to contain"). It runs the client
that already lives inside each container (`psql`, `mysql`, `clickhouse-client`,
`mongosh`, `redis-cli`) through `docker compose exec`, so it needs nothing installed
on the host but Docker, and it works **before any Rust driver exists**.

That is deliberately the opposite of how the product connects — the product never
shells out to a CLI. `smoke.mjs` is a developer tool for validating the *fixture*
and must never become a substitute for the `#[ignore]`d Rust tier that exercises the
real drivers.

Beyond reachability and seed integrity it also pins three things an engine would
otherwise have to discover the hard way: that **read-only is genuinely
server-enforced** on Postgres/MySQL/ClickHouse, that the **cancel plumbing
exists** (`pg_stat_activity` + `pg_backend_pid()`, `information_schema.processlist`
+ `CONNECTION_ID()`, `system.processes` + `queryID()`), and that MySQL's
**TLS really works** (a negotiated cipher, not a flag — note `@@have_ssl` was
*removed* in MySQL 8.4).

### If you prefer to poke at it by hand

```bash
# Postgres — PGPASSWORD is already in the container's environment
docker compose -f docker/db-fixtures/compose.yaml exec postgres \
  psql -h 127.0.0.1 -U agentstudio -d maestro -c 'TABLE tracks'

# MySQL — pass the password per invocation (see the MYSQL_PWD warning in compose.yaml)
docker compose -f docker/db-fixtures/compose.yaml exec mysql sh -c \
  'MYSQL_PWD="$MYSQL_PASSWORD" mysql -h127.0.0.1 -uagentstudio maestro -e "SELECT * FROM tracks"'

# ClickHouse — over HTTP, from the HOST, with nothing installed but curl.
# The NULL-vs-empty distinction in one command: `[2, null]` vs `[3, ""]`.
curl -sS -H 'X-ClickHouse-User: agentstudio' -H 'X-ClickHouse-Key: agentstudio-test-pw' \
  'http://127.0.0.1:58123/?database=maestro&query=SELECT%20id,tag%20FROM%20tracks%20WHERE%20id%20IN%20(2,3)%20ORDER%20BY%20id%20FORMAT%20JSONCompact'

# MongoDB
docker compose -f docker/db-fixtures/compose.yaml exec mongo sh -c \
  'mongosh --quiet -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" \
     --authenticationDatabase admin maestro --eval "db.tracks.find().limit(2)"'

# Redis — REDISCLI_AUTH is already in the container's environment
docker compose -f docker/db-fixtures/compose.yaml exec redis redis-cli --no-raw GET fixture:empty
```

---

## Measured cost (Apple silicon, arm64)

| | Measured |
|---|---|
| **Cold start, images already pulled** (`npm run db:fixtures:up` → all five healthy) | **≈ 6 s** |
| **`db:fixtures:reset`** (`down -v` + `up`, i.e. full re-init and re-seed) | **≈ 13 s** |
| **First-ever cold start** (image pull + up) | **≈ 55 s** (48 s of it is the pull) |
| **Disk, images** | ≈ 3.5 GB (385 MB + 1.07 GB + 760 MB + 1.2 GB + 98.8 MB) |
| **Disk, data** | negligible — a few MB of anonymous volumes; `down -v` reclaims all of it |
| **Memory, steady state, idle** | **≈ 900 MiB total**: clickhouse 567 MiB · mysql 195 MiB · mongo 107 MiB · postgres 17 MiB · redis 10 MiB |

Every service has a `mem_limit` (postgres 256m, mysql 768m, clickhouse 1g,
mongo 512m, redis 128m) so a runaway query gets a clean engine-level
"memory limit exceeded" rather than an exit 137 the developer has to guess at.
The engines are also tuned down individually — `shared_buffers=32MB`,
`innodb-buffer-pool-size=64M --performance-schema=OFF`,
`--wiredTigerCacheSizeGB=0.25`, `--maxmemory 64mb`, and for ClickHouse
[`conf/clickhouse-footprint.xml`](./conf/clickhouse-footprint.xml) plus a
`MALLOC_CONF` that stops jemalloc retaining freed pages (724 MiB → 609 MiB →
567 MiB, measured).

The cold-start numbers are fast because init is CPU-bound and the measuring machine
had 16 cores. On a smaller machine expect MySQL's first-boot initialisation to dominate;
its healthcheck allows 90 × 2 s and `up` allows 300 s in total, so a slow laptop
waits rather than fails.

Docker Hub rate-limits unauthenticated pulls, so a first-ever `up` can fail with
`429 Too Many Requests` — that is the registry, not this fixture. Retry, or
`docker login`.

---

## Files

| File | What it is |
|---|---|
| [`compose.yaml`](./compose.yaml) | The five services. Credentials, port map, footprint caps, and the seeded-data healthchecks. Read the header comment first. |
| [`seed/postgres.sql`](./seed/postgres.sql) | Postgres schema + 6 rows + view + `tall` + `wide`. |
| [`seed/mysql.sql`](./seed/mysql.sql) | The same shape in MySQL, plus the three auth-plugin accounts. |
| [`seed/clickhouse.sql`](./seed/clickhouse.sql) | The same shape in ClickHouse's type system. **One `INSERT` per row** — ClickHouse's Values-format reader rejects SQL comments between tuples (`Code: 27`). |
| [`seed/mongo.js`](./seed/mongo.js) | Six collections, run by mongosh. Fails loudly if the collection count ever drifts from 6. |
| [`seed/redis.txt`](./seed/redis.txt) | A `redis-cli` command list. Comments are stripped by the entrypoint — `redis-cli` has no comment syntax. |
| [`seed/redis-entrypoint.sh`](./seed/redis-entrypoint.sh) | Starts redis, applies the seed, asserts the key count, then sets the `fixture:seeded` marker. Forwards `SIGTERM` so `down` is fast. |
| [`conf/clickhouse-footprint.xml`](./conf/clickhouse-footprint.xml) | Cache/memory caps and disabled `system.*_log` tables. |
| [`smoke.mjs`](./smoke.mjs) | The 33-check connectivity smoke. Zero dependencies. |

---

## What the Rust tier encodes

The tests live in `src-tauri/tests/db_live.rs`, every one `#[ignore]`d with a
doc-comment naming the exact command to run it, mirroring
`usage.rs::live_smoke_reads_real_usage_from_the_cli`.

Two engine behaviours those tests encode:

1. **`SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY` does not protect
   statements sent in the same simple-query batch as the `SET`.** Measured: Postgres
   wraps a multi-statement simple query in one implicit transaction that began
   *before* the `SET` took effect, so the new default does not apply to it —
   `psql -c "SET …; INSERT …"` **inserts the row**, while `psql -c "SET …" -c
   "INSERT …"` correctly errors with *"cannot execute INSERT in a read-only
   transaction"*. Setting read-only "at connect" is right; but `sqlx::raw_sql()`
   accepts multiple `;`-separated statements, so prepending the `SET` to the
   user's script in one call is a natural implementation that would **silently
   disable the read-only boundary**. This needs its own named test.
2. **ClickHouse's JSON output formats cannot return non-UTF-8 bytes byte-exact.**
   Rows 2 and 4 of `tracks` hold deliberately invalid UTF-8, so the asymmetry with
   Postgres/MySQL (which hand us raw bytes we hex ourselves) is visible rather than
   hidden behind UTF-8-clean test data. What a binary cell should render as on
   ClickHouse is still open; whichever answer is chosen must be pinned in an
   assertion.
