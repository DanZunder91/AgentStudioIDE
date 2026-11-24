#!/bin/sh
# ═════════════════════════════════════════════════════════════════════════════
#  Redis entrypoint + seeder — Agent Studio database-client fixture
#  TEST FIXTURE ONLY.
#
#  The official redis image has no /docker-entrypoint-initdb.d hook, so this
#  wrapper does what the postgres/mysql/mongo/clickhouse entrypoints do for us:
#  start the server, apply seed/redis.txt, and only then publish the
#  `fixture:seeded` marker that compose.yaml's healthcheck tests. That ordering is
#  the whole point — it makes `docker compose up --wait` mean "seeded", so no test
#  ever needs a `sleep`, and a broken seed shows up as an unhealthy container at
#  `up` rather than as a confusing assertion failure minutes later.
#
#  Passwords come from the environment (compose.yaml), never from this file.
# ═════════════════════════════════════════════════════════════════════════════
set -eu

: "${REDIS_PASSWORD:?REDIS_PASSWORD must be set by compose.yaml}"
# REDISCLI_AUTH is also set by compose.yaml; redis-cli reads it, which keeps the
# password off every command line in `ps` and avoids the -a warning entirely.

SEED_FILE=/seed/redis.txt

# Persistence OFF: this fixture's data is ephemeral by design (see compose.yaml),
# and an RDB/AOF file would survive a container restart and make the seed
# non-idempotent.
redis-server \
  --requirepass "$REDIS_PASSWORD" \
  --save '' \
  --appendonly no \
  --maxmemory 64mb \
  --maxmemory-policy noeviction &
server_pid=$!

# Forward SIGTERM so `docker compose down` is fast. Without this, sh (PID 1) eats
# the signal and every teardown waits out the 5s grace period before SIGKILL.
trap 'kill -TERM "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true; exit 0' TERM INT

# Wait for the server rather than sleeping at it.
tries=0
until redis-cli PING >/dev/null 2>&1; do
  tries=$((tries + 1))
  if [ "$tries" -ge 150 ]; then           # 150 * 0.2s = 30s
    echo "[db-fixtures] redis-server did not accept connections within 30s" >&2
    exit 1
  fi
  sleep 0.2
done

# Strip comments and blank lines FIRST. redis-cli has no
# comment syntax — it sends `#` lines to the server as commands, which come back
# as `ERR unknown command '#'`, and any apostrophe in the prose ("the tree's …")
# leaves an unbalanced quote and prints `Invalid argument(s)`. None of that is
# fatal on its own, which is precisely why it has to be removed rather than
# tolerated: the error check below must only ever fire on a REAL seed failure.
#
# Apply the seed and FAIL LOUDLY on any error. redis-cli exits 0 even when the
# server rejects a command, so the output has to be inspected: a silent
# half-seeded fixture is a false green, which is worse than a red one.
seed_output="$(sed -e 's/^[[:space:]]*#.*$//' -e '/^[[:space:]]*$/d' "$SEED_FILE" | redis-cli)"
printf '%s\n' "$seed_output"
if printf '%s\n' "$seed_output" | grep -qi '(error)\|WRONGTYPE\|NOAUTH\|Invalid argument'; then
  echo "[db-fixtures] redis seed reported errors (above) — refusing to mark seeded" >&2
  exit 1
fi

# 12 fixture:* keys + 5000 k:* keys = 5012, checked BEFORE the marker is set.
# Asserted rather than trusted, so an edit to redis.txt that silently drops a
# command cannot pass as healthy.
expected=5012
actual="$(redis-cli DBSIZE)"
if [ "$actual" != "$expected" ]; then
  echo "[db-fixtures] expected $expected keys after seeding, found $actual" >&2
  echo "[db-fixtures] (update BOTH this number and seed/redis.txt together)" >&2
  exit 1
fi

# LAST: the marker the healthcheck waits on.
redis-cli SET fixture:seeded 1 >/dev/null
echo "[db-fixtures] redis seeded: $actual keys, marker set"

wait "$server_pid"
