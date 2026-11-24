// ═════════════════════════════════════════════════════════════════════════════
//  MongoDB seed — Agent Studio database-client fixture
//  Run once by the image's entrypoint via mongosh, with `db` = `maestro`.
//  TEST FIXTURE ONLY.
//
//  Two things are load-bearing here and are easy to lose if this file is edited:
//
//  1. There are EXACTLY SIX collections. The tree shows the count ("6
//     collections"), and both the smoke check ("collections (6)") and the live
//     tests assert it literally. compose.yaml's healthcheck also counts 6, so
//     adding a seventh collection breaks `up --wait` immediately rather than one
//     test later. If you need another collection, change all three places
//     together and say so in the commit.
//  2. `tracks` covers explicit-null AND missing-field AND empty-string, which in
//     Mongo are three distinct states, not two. Document 2 has `tag: null`,
//     document 3 has `tag: ""`, document 6 OMITS `tempo` and `raw` entirely —
//     so the column-union projection the results grid needs is exercised by the
//     data instead of being assumed.
// ═════════════════════════════════════════════════════════════════════════════

const maestro = db.getSiblingDB("maestro");

// Deterministic ObjectIds so a test can address a document by _id without first
// querying for it — and so a failure message names a stable value.
const oid = (n) => ObjectId(String(n).padStart(24, "0"));

maestro.tracks.insertMany([
  // 1 — baseline: every BSON type the grid has to render.
  {
    _id: oid(1),
    title: "Amberline",
    ensemble: "duo",
    duration: Decimal128.fromString("0.5000"), // Decimal128 → no rust_decimal
    tempo: 120.5, // double
    ok: true, // bool
    seq: NumberLong("9007199254740993"), // Int64 beyond IEEE-754 exactness: must NOT
    //   round-trip through a JS number anywhere
    small: NumberInt(7), // Int32, a different BSON type from the above
    flags: ["1", "2", "3"],
    // A three-level nested subdocument: relaxed extended JSON must render the
    // whole tree into one cell, and ValueInspector expands it.
    payload: { studio: "harbor", mix: { gain: 0.25, eq: { bass: 0.5 } } },
    raw: BinData(0, "SGVsbG8="), // "Hello" — BSON Binary, subtype 0
    at: ISODate("2026-07-29T10:00:00.000Z"),
    tag: "normal",
  },

  // 2 — tag is EXPLICITLY null.
  {
    _id: oid(2),
    title: "Bluewater",
    ensemble: "trio",
    duration: Decimal128.fromString("12.2500"),
    tempo: 96.25,
    ok: false,
    flags: [],
    payload: { studio: "central" },
    raw: BinData(0, "AP8Q"), // 0x00FF10 — deliberately NOT valid UTF-8
    at: ISODate("2026-07-29T10:00:01.000Z"),
    tag: null,
  },

  // 3 — tag is THE EMPTY STRING. Documents 2 and 3 together are the
  //     null-vs-empty distinction; document 6 adds the third Mongo state.
  {
    _id: oid(3),
    title: "Cinderglass",
    ensemble: "duo",
    duration: Decimal128.fromString("400.0000"),
    tempo: 72.75,
    ok: true,
    flags: ["7"],
    payload: { studio: "lakeside" },
    raw: BinData(0, ""),
    at: ISODate("2026-07-29T10:00:02.000Z"),
    tag: "",
  },

  // 4 — non-ASCII plus an embedded tab and newline.
  {
    _id: oid(4),
    title: "Driftwood",
    ensemble: "trio",
    duration: Decimal128.fromString("3.1416"),
    tempo: 140.125,
    ok: true,
    flags: ["4", "5"],
    payload: { note: "ünïcode ✓ 中文" },
    raw: BinData(0, "3q2+7w=="), // 0xDEADBEEF
    at: ISODate("2026-07-29T10:00:03.000Z"),
    tag: "ünïcode ✓ 中文\tand a\nnewline",
  },

  // 5 — a STRING that looks like a hex-encoded blob, beside a real Binary.
  //     DbCellKind is inferred from the field's BSON type, never from the text.
  {
    _id: oid(5),
    title: "Emberfall",
    ensemble: "duo",
    duration: Decimal128.fromString("10000.0000"),
    tempo: 88.5,
    ok: false,
    flags: ["0"],
    payload: { studio: "summit" },
    raw: BinData(0, "QUI="), // 0x4142
    at: ISODate("2026-07-29T10:00:04.000Z"),
    tag: "\\x4142",
  },

  // 6 — `tempo` and `raw` are ABSENT, not null. A missing field is Mongo's third
  //     state and the column union must still emit those columns for this row.
  //     `payload` is JSON null as a VALUE, so it must not collapse into "absent".
  {
    _id: oid(6),
    title: "Fernlight",
    ensemble: "trio",
    duration: Decimal128.fromString("-2.5000"),
    ok: false,
    flags: [],
    payload: null,
    at: ISODate("2026-07-29T10:00:05.000Z"),
    tag: "json-null-vs-sql-null",
  },
]);

// An index, so `listIndexes` (on the read-only allowlist) returns more than the
// implicit _id_ entry and the tree's index node has content.
maestro.tracks.createIndex({ title: 1, at: -1 }, { name: "title_at" });

// `tall`: more documents than the DEFAULT rowLimit of 500, so `truncated` is
// provable at the shipped default and via `maxTimeMS`-bounded cursor paging.
const tall = [];
for (let i = 1; i <= 2000; i += 1) {
  tall.push({ _id: i, n: i * 3, label: `row-${i}` });
}
maestro.tall.insertMany(tall);

// Four more collections, to reach exactly six. Small on purpose — they exist so
// the tree has a realistic sibling list, and one is empty so an empty collection
// renders as an empty grid rather than an error.
maestro.cues.insertMany([
  { _id: "AMB-001", points: [[12, 0.4]], markers: [[14, 1.1]] },
  { _id: "BLU-001", points: [[31, 2.0]], markers: [[32, 0.5]] },
]);
maestro.catalog.insertMany([
  { _id: "AMB-001", series: "AMB", issue: "001", active: true },
  { _id: "BLU-001", series: "BLU", issue: "001", active: true },
  { _id: "LUX-001", series: "LUX", issue: "001", active: false },
]);
maestro.journal.insertMany([
  { _id: oid(101), at: ISODate("2026-07-29T09:59:00.000Z"), msg: "fixture seeded" },
]);
maestro.createCollection("studios"); // deliberately EMPTY

// Fail the seed loudly if the count ever drifts, instead of letting compose's
// healthcheck report a mysterious unhealthy container: fail loudly rather than
// let a broken state read as something else.
const names = maestro.getCollectionNames().sort();
if (names.length !== 6) {
  throw new Error(
    `fixture expects exactly 6 collections (the tree asserts "collections (6)"), got ${names.length}: ${names.join(", ")}`,
  );
}
print(`[db-fixtures] mongo seeded: ${names.join(", ")}`);
