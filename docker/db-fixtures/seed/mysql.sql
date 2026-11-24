-- ═════════════════════════════════════════════════════════════════════════════
--  MySQL 8.4 seed — Agent Studio database-client fixture
--  Runs once, as root, with `maestro` already selected.
--  TEST FIXTURE ONLY. Mirrors seed/postgres.sql row-for-row so one Rust test body
--  can assert the same shape against both sqlx families.
-- ═════════════════════════════════════════════════════════════════════════════

USE maestro;

CREATE TABLE tracks (
  id       int          NOT NULL PRIMARY KEY,  -- kind: number
  title    varchar(16)  NOT NULL,              -- kind: text
  ensemble enum('duo','trio') NOT NULL,        -- MySQL ENUM; the text protocol renders it free
  duration decimal(12,4) NOT NULL,             -- arbitrary precision, no rust_decimal
  tempo    double       NULL,                  -- kind: number, float
  ok       boolean      NULL,                  -- kind: bool. NB: reported as `tinyint(1)` — the
                                               --   server's own type name, shown verbatim
  flags    json         NULL,                  -- MySQL has no array type; a JSON array stands in
  payload  json         NULL,                  -- kind: json
  raw      blob         NULL,                  -- kind: binary → not valid UTF-8, so the
                                               --   try_get::<Vec<u8>> fallback + hex render
  at       timestamp(6) NULL,                  -- kind: datetime. --default-time-zone=+00:00
  tag      varchar(64)  NULL                   -- THE nullable text column. See rows 2 and 3.
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO tracks (id, title, ensemble, duration, tempo, ok, flags, payload, raw, at, tag) VALUES
  -- 1 — baseline.
  (1, 'Amberline', 'duo',  0.5000, 120.5, TRUE,  '[1,2,3]',
      '{"studio":"harbor","mix":{"gain":0.25}}', X'48656C6C6F',
      '2026-07-29 10:00:00.000000', 'normal'),

  -- 2 — tag IS NULL → JSON `null` on the wire.
  (2, 'Bluewater', 'trio', 12.2500, 96.25, FALSE, '[]',
      '{"studio":"central"}', X'00FF10',
      '2026-07-29 10:00:01.000000', NULL),

  -- 3 — tag IS THE EMPTY STRING → JSON `""`. Rows 2+3 are the NULL-vs-empty
  --     assertion; if a driver upgrade ever collapses them, this is the row pair
  --     that catches it.
  (3, 'Cinderglass', 'duo',  400.0000, 72.75, TRUE,  '[7]',
      '{"studio":"lakeside"}', X'',
      '2026-07-29 10:00:02.000000', ''),

  -- 4 — non-ASCII plus an embedded tab and newline.
  (4, 'Driftwood', 'trio', 3.1416, 140.125, TRUE, '[4,5]',
      '{"note":"ünïcode ✓ 中文"}', X'DEADBEEF',
      '2026-07-29 10:00:03.000000', 'ünïcode ✓ 中文\tand a\nnewline'),

  -- 5 — a TEXT value that looks like a hex-encoded blob, beside a real blob.
  --     DbCellKind must come from the column, never from the value.
  (5, 'Emberfall', 'duo',  10000.0000, 88.5, FALSE, '[0]',
      '{"studio":"summit"}', X'4142',
      '2026-07-29 10:00:04.000000', '\\x4142'),

  -- 6 — JSON `null` in `payload` while `raw`/`tempo`/`flags` are SQL NULL. The
  --     two nulls must not collapse: payload is the string `null`, the others absent.
  (6, 'Fernlight', 'trio', -2.5000, NULL, FALSE, NULL,
      CAST('null' AS JSON), NULL,
      '2026-07-29 10:00:05.000000', 'json-null-vs-sql-null');

-- A VIEW, for the tree's tables-vs-views split.
CREATE VIEW v_tracks AS
  SELECT id, title, ensemble, duration FROM tracks WHERE ok = TRUE;

-- `tall`: more rows than the DEFAULT rowLimit of 500, so `truncated` is
-- provable at the shipped default. No `wide` table here: the grid's horizontal
-- virtualisation is pure frontend math, unit-tested in the default gates, and one
-- 200-column table (Postgres) is enough to prove the driver side end to end.
CREATE TABLE tall (
  id    int          NOT NULL PRIMARY KEY,
  n     int          NOT NULL,
  label varchar(32)  NOT NULL
) ENGINE=InnoDB;

SET SESSION cte_max_recursion_depth = 100000;   -- default 1000 < our 2000 rows
INSERT INTO tall (id, n, label)
WITH RECURSIVE s(i) AS (
  SELECT 1 UNION ALL SELECT i + 1 FROM s WHERE i < 2000
)
SELECT i, i * 3, CONCAT('row-', i) FROM s;

-- ── The auth-plugin accounts ────────────────────────────────────────────────
-- MySQL 8.4 defaults to `caching_sha2_password`, and we cannot enable sqlx's
-- `mysql-rsa` feature (RUSTSEC-2023-0071, no fixed version), so full auth for
-- such an account only works inside a TLS tunnel. The fixture ships one account
-- per code path so the Rust test can prove BOTH branches rather than assert a
-- captured error string:
--
--   `agentstudio`         caching_sha2_password  (created by the image) → needs TLS,
--                     or the fast path if the server has cached the credential.
--   `agentstudio_sha2`    caching_sha2_password, never used by anything else, so a
--                     test can hit it *uncached* over plaintext and assert the
--                     "RSA auth backend disabled … or use TLS" mapping.
--                     NB for the test author: `FLUSH PRIVILEGES` clears the
--                     caching_sha2 credential cache — do that first, or a prior
--                     successful TLS login makes the plaintext attempt pass.
--   `agentstudio_native`  mysql_native_password (needs --mysql-native-password=ON,
--                     set in compose.yaml) → authenticates over plaintext, which
--                     is the control case proving the failure above is about the
--                     auth plugin and not about our connection code.
--
-- All three are read-only (SELECT only) so the read-only guard can be
-- tested both server-enforced (SET SESSION … READ ONLY) and by privilege.
CREATE USER 'agentstudio_sha2'@'%'
  IDENTIFIED WITH caching_sha2_password BY 'agentstudio-sha2-test-pw';
GRANT SELECT ON maestro.* TO 'agentstudio_sha2'@'%';

CREATE USER 'agentstudio_native'@'%'
  IDENTIFIED WITH mysql_native_password BY 'agentstudio-native-test-pw';
GRANT SELECT ON maestro.* TO 'agentstudio_native'@'%';
