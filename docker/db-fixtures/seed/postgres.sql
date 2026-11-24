-- ═════════════════════════════════════════════════════════════════════════════
--  PostgreSQL seed — Agent Studio database-client fixture
--  Runs once, as `agentstudio`, against database `maestro`.
--  TEST FIXTURE ONLY. Tiny and readable on purpose: every row below exists to
--  exercise one case the database client has to handle, and nothing else.
-- ═════════════════════════════════════════════════════════════════════════════

-- A user-defined ENUM. The client reads every value through the text protocol,
-- so it renders types a per-OID binary decoder has never heard of; this is one,
-- and so is the int[] column below. If `SELECT * FROM tracks` ever fails on these
-- two columns, the no-type-mapping design is broken.
CREATE TYPE track_ensemble AS ENUM ('duo', 'trio');

CREATE TABLE tracks (
  id       integer PRIMARY KEY,      -- kind: number
  title    varchar(16) NOT NULL,     -- kind: text  (typeName shown verbatim as `varchar(16)`)
  ensemble track_ensemble NOT NULL, -- user-defined ENUM
  duration numeric(12,4) NOT NULL,  -- arbitrary precision, WITHOUT rust_decimal/bigdecimal
  tempo    double precision,        -- kind: number, float
  ok       boolean,                 -- kind: bool
  flags    integer[],               -- array type
  payload  jsonb,                   -- kind: json
  raw      bytea,                   -- kind: binary → Postgres text mode gives `\x…`, hex-rendered
  at       timestamptz,             -- kind: datetime. Server TZ is UTC; we never reformat
  tag      text                     -- THE nullable text column. See rows 2 and 3.
);

INSERT INTO tracks (id, title, ensemble, duration, tempo, ok, flags, payload, raw, at, tag) VALUES
  -- 1 — baseline: every kind populated, nothing exotic.
  (1, 'Amberline', 'duo',  '0.5000', 120.5,  true,  '{1,2,3}',
      '{"studio":"harbor","mix":{"gain":0.25}}'::jsonb,
      '\x48656c6c6f'::bytea, '2026-07-29T10:00:00Z', 'normal'),

  -- 2 — tag IS NULL. Must arrive as JSON `null` (Rust `None`).
  (2, 'Bluewater', 'trio', '12.2500', 96.25, false, '{}',
      '{"studio":"central"}'::jsonb,
      '\x00ff10'::bytea, '2026-07-29T10:00:01Z', NULL),

  -- 3 — tag IS THE EMPTY STRING. Must arrive as JSON `""` (Rust `Some("")`).
  --     Rows 2 and 3 together are the assertion the whole no-type-mapping
  --     design rests on: NULL and '' are distinguished by construction, not by a
  --     sentinel a value could collide with.
  (3, 'Cinderglass', 'duo',  '400.0000', 72.75, true,  '{7}',
      '{"studio":"lakeside"}'::jsonb,
      ''::bytea, '2026-07-29T10:00:02Z', ''),

  -- 4 — non-ASCII plus a tab and a newline inside a cell: the grid must not
  --     break its row/column geometry on embedded whitespace.
  (4, 'Driftwood', 'trio', '3.1416', 140.125, true,  '{4,5}',
      '{"note":"ünïcode ✓ 中文"}'::jsonb,
      '\xdeadbeef'::bytea, '2026-07-29T10:00:03Z',
      E'ünïcode ✓ 中文\tand a\nnewline'),

  -- 5 — a TEXT value that LOOKS like Postgres' bytea hex encoding, next to a
  --     real bytea column. Proves DbCellKind comes from the COLUMN's declared
  --     type and is never sniffed from the value — otherwise this cell would
  --     render as binary and the app would be lying about the data.
  (5, 'Emberfall', 'duo',  '10000.0000', 88.5, false, '{0}',
      '{"studio":"summit"}'::jsonb,
      '\x4142'::bytea, '2026-07-29T10:00:04Z', '\x4142'),

  -- 6 — JSON `null` in `payload` (a real JSON value) while `raw` and `tempo` are
  --     SQL NULL. The two nulls must not collapse into each other: payload
  --     renders as the four characters `null`, raw and tempo render as absent.
  --     Also carries a negative number and `ok = false`.
  (6, 'Fernlight', 'trio', '-2.5000', NULL, false, NULL,
      'null'::jsonb, NULL, '2026-07-29T10:00:05Z', 'json-null-vs-sql-null');

-- A VIEW, so the tree's tables-vs-views split (`tables (n)` / `views (n)`) has
-- something to distinguish. Kept trivial — its content is not the point.
CREATE VIEW v_tracks AS
  SELECT id, title, ensemble, duration FROM tracks WHERE ok;

-- `tall`: more rows than the DEFAULT row cap (rowLimit = 500), so `truncated`
-- can be proven at the shipped default and not only at a contrived cap of 10.
-- The engine reads cap+1 and reports having seen the extra row.
CREATE TABLE tall (
  id    integer PRIMARY KEY,
  n     integer NOT NULL,
  label text    NOT NULL
);
INSERT INTO tall (id, n, label)
  SELECT i, i * 3, 'row-' || i FROM generate_series(1, 2000) AS i;

-- `wide`: 200 columns, one row — the horizontal half of the grid's virtualisation
-- window. Generated rather than typed out, so this file stays readable.
DO $$
DECLARE
  defs text;
  vals text;
BEGIN
  SELECT string_agg(format('c%s integer', i), ', ' ORDER BY i),
         string_agg(i::text,                ', ' ORDER BY i)
    INTO defs, vals
    FROM generate_series(1, 200) AS i;
  EXECUTE format('CREATE TABLE wide (%s)', defs);
  EXECUTE format('INSERT INTO wide VALUES (%s)', vals);
END $$;
