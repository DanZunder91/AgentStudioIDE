-- ═════════════════════════════════════════════════════════════════════════════
--  ClickHouse seed — Agent Studio database-client fixture
--  Runs once, as `agentstudio`, with `maestro` as the default database.
--  TEST FIXTURE ONLY. Same six-row shape as postgres/mysql, re-typed in
--  ClickHouse's type system so the "every engine produces the same
--  Vec<Vec<Option<String>>>" claim is tested against a genuinely different one.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE maestro.tracks
(
  id       UInt32,                        -- kind: number
  title    LowCardinality(String),        -- a ClickHouse-only type name; shown verbatim
  ensemble Enum8('duo' = 1, 'trio' = 2),  -- ENUM again, third dialect
  duration Nullable(Decimal(12, 4)),      -- arbitrary precision, no rust_decimal
  tempo    Nullable(Float64),             -- kind: number, float
  ok       Bool,                          -- kind: bool (JSONCompact renders it as true/false)
  flags    Array(String),                 -- kind: json-ish; a nested type in a flat cell
  payload  String,                        -- kind: json — JSON carried as text over HTTP
  raw      String,                        -- kind: binary. ClickHouse has no bytea; String holds
                                          --   arbitrary bytes. See the WARNING below.
  at       DateTime64(3, 'UTC'),          -- kind: datetime, explicit UTC
  tag      Nullable(String)               -- THE nullable text column. See rows 2 and 3.
)
ENGINE = MergeTree
ORDER BY id;

-- ⚠️  KNOWN ASYMMETRY (ClickHouse over HTTP + JSONCompact):
--     ClickHouse's JSON output formats must emit valid JSON, so a String column
--     holding non-UTF-8 bytes (row 2's 0x00FF10, row 4's 0xDEADBEEF) cannot come
--     back byte-exact — ClickHouse substitutes replacement characters. Postgres
--     and MySQL hand us raw bytes and we hex them ourselves. This is a REAL
--     asymmetry in the "read every value as text" premise, and the fixture
--     deliberately contains the rows that expose it rather than only
--     UTF-8-clean bytes that would let it pass unnoticed. What a binary cell
--     should render as on ClickHouse is still open (candidates:
--     `FORMAT JSONCompact` + `hex(raw)` in the projection, or accepting lossy
--     display for binary columns and saying so in the UI); whichever is chosen
--     must be pinned in an assertion.

-- NB: ClickHouse parses an `INSERT … VALUES` data section with the *Values*
-- format reader, which does NOT accept SQL comments between tuples — a single
-- INSERT with per-row `--` comments fails with
-- `Code: 27 … CANNOT_PARSE_INPUT_ASSERTION_FAILED`. So one INSERT per row, which
-- keeps each comment next to the case it documents. Six tiny parts is irrelevant
-- for a 6-row fixture.

-- 1 — baseline.
INSERT INTO maestro.tracks VALUES
  (1, 'Amberline', 'duo', 0.5, 120.5, true, ['1','2','3'],
   '{"studio":"harbor","mix":{"gain":0.25}}', unhex('48656C6C6F'),
   '2026-07-29 10:00:00.000', 'normal');

-- 2 — tag IS NULL → JSON `null`.
INSERT INTO maestro.tracks VALUES
  (2, 'Bluewater', 'trio', 12.25, 96.25, false, [],
   '{"studio":"central"}', unhex('00FF10'),
   '2026-07-29 10:00:01.000', NULL);

-- 3 — tag IS THE EMPTY STRING → JSON `""`. Rows 2+3 = the NULL-vs-empty assertion.
INSERT INTO maestro.tracks VALUES
  (3, 'Cinderglass', 'duo', 400, 72.75, true, ['7'],
   '{"studio":"lakeside"}', '',
   '2026-07-29 10:00:02.000', '');

-- 4 — non-ASCII plus an embedded tab and newline.
INSERT INTO maestro.tracks VALUES
  (4, 'Driftwood', 'trio', 3.1416, 140.125, true, ['4','5'],
   '{"note":"ünïcode ✓ 中文"}', unhex('DEADBEEF'),
   '2026-07-29 10:00:03.000', 'ünïcode ✓ 中文\tand a\nnewline');

-- 5 — a TEXT value shaped like hex, beside a binary column.
INSERT INTO maestro.tracks VALUES
  (5, 'Emberfall', 'duo', 10000, 88.5, false, ['0'],
   '{"studio":"summit"}', unhex('4142'),
   '2026-07-29 10:00:04.000', '\\x4142');

-- 6 — JSON `null` as a payload VALUE while duration/tempo are SQL NULL: the two
--     must not collapse into one another on the wire.
INSERT INTO maestro.tracks VALUES
  (6, 'Fernlight', 'trio', NULL, NULL, false, [],
   'null', '',
   '2026-07-29 10:00:05.000', 'json-null-vs-sql-null');

-- A VIEW, for the tree's tables-vs-views split. ClickHouse reports views
-- in `system.tables` with engine = 'View', which is how `db_children` must tell
-- them apart — a different mechanism from information_schema, hence a real test.
CREATE VIEW maestro.v_tracks AS
  SELECT id, title, ensemble, duration FROM maestro.tracks WHERE ok;

-- `tall`: more rows than the DEFAULT rowLimit of 500. Note ClickHouse can
-- also cap server-side (`max_result_rows` + `result_overflow_mode=break`),
-- so this table lets the test compare our client-side cap+1 count against the
-- server's own truncation and confirm `truncated` is measured, not inferred.
CREATE TABLE maestro.tall
(
  id    UInt32,
  n     UInt32,
  label String
)
ENGINE = MergeTree
ORDER BY id;

INSERT INTO maestro.tall
  SELECT number + 1 AS id, (number + 1) * 3 AS n, concat('row-', toString(number + 1)) AS label
  FROM numbers(2000);
