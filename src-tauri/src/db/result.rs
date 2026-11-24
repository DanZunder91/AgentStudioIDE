//! Result-set wire types, and the one piece of shaping they need.
//!
//! ## Why there is no per-type decoder here
//!
//! This is the decision the whole feature rests on: **every value comes back as
//! `Option<String>`**, read out of the driver's *text* protocol. `None` is SQL NULL,
//! `Some("")` is the empty string, and the two are distinguished *by construction* rather
//! than by a sentinel a value could collide with. The consequence is that this module has no
//! `match` on type OIDs, no `chrono`/`uuid`/`rust_decimal` feature flags, and no
//! `<unsupported type>` cell — a Postgres enum, an `int[]`, a PostGIS geometry and a type an
//! extension invented this morning all arrive as exactly the string `psql` would print.
//!
//! ## So what is [`DbCellKind`] for?
//!
//! Alignment and rendering, and it comes from the **column**, never from the value.
//! That distinction is load-bearing and the fixture proves it: `tracks` row 5 has a `text`
//! column whose *value* is the literal `\x4142`, sitting next to a real `bytea` column. Sniff
//! the value and the app renders that text cell as binary — i.e. lies about the data. Read the
//! declared type name and it cannot.
//!
//! Unrecognised type names map to [`DbCellKind::Unknown`], which renders as plain text. That
//! is the honest default: the grid does not need to know what a `tsrange` is to show what the
//! server said it was.

use serde::Serialize;

/// How a column should RENDER. Presentation only — never parsing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DbCellKind {
    Text,
    Number,
    Bool,
    Json,
    Binary,
    Datetime,
    Unknown,
}

/// One column of a result set. `type_name` is the **server's own** spelling, shown verbatim.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbColumn {
    pub name: String,
    pub type_name: String,
    pub kind: DbCellKind,
}

/// What a statement produced.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DbResultKind {
    /// A row set, even an empty one.
    Rows,
    /// A write: `rows_affected` is the payload.
    Affected,
    /// Prose — a server notice, or a **database error**, which is a normal outcome of a
    /// console and therefore a result rather than a rejection (the `http_send` contract).
    Message,
}

/// One statement's outcome. A script yields one of these per statement, so a syntax error in
/// statement 3 still shows the results of statements 1 and 2.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbResultSet {
    pub kind: DbResultKind,
    /// Which statement produced this.
    pub statement: String,
    pub columns: Vec<DbColumn>,
    /// `None` = SQL NULL, `Some("")` = the empty string.
    pub rows: Vec<Vec<Option<String>>>,
    pub rows_affected: Option<i64>,
    /// True iff the row cap cut the result — **measured** (we read cap+1 and saw the extra
    /// row), never inferred from `rows.len() == row_limit`, which is wrong exactly when the
    /// table happens to have that many rows.
    pub truncated: bool,
    pub row_limit: u32,
    pub duration_ms: u64,
    /// Server notices/warnings.
    pub notice: Option<String>,
    /// Which cells are **absent** rather than null.
    ///
    /// A cell has two states (`Some(text)` and `None`) and two engines have three: MongoDB documents
    /// and DynamoDB items can *omit* a field entirely, which is a different fact from holding null.
    /// The engine reported the loss in `notice` and painted those cells as NULL, which is the app
    /// stating something the data does not say.
    ///
    /// So: a parallel mask, `absent[row][col] == true` where the field was missing. Same shape as
    /// `rows`, `None` for every engine that cannot produce the state (all six SQL/Redis rows), which
    /// keeps it off the wire entirely for them (`skip_serializing_if`). Truncating the row array
    /// instead was **not** an option — an absent field is usually interior, with real values after it.
    ///
    /// The frontend needed no new rendering for this: `renderCell(undefined)` has always produced a
    /// `missing` display distinct from `null`, so the mask's only job is to turn a masked cell into
    /// `undefined` before it reaches that function.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub absent: Option<Vec<Vec<bool>>>,
}

impl DbResultSet {
    /// A `message` result — a server notice, or a database error rendered as an outcome.
    pub fn message(statement: impl Into<String>, text: impl Into<String>, row_limit: u32) -> Self {
        Self {
            kind: DbResultKind::Message,
            statement: statement.into(),
            columns: Vec::new(),
            rows: Vec::new(),
            rows_affected: None,
            truncated: false,
            row_limit,
            duration_ms: 0,
            notice: Some(text.into()),
            absent: None,
        }
    }
}

/// Map a server type name onto a render kind.
///
/// Deliberately a **prefix/contains** match on the lower-cased name rather than an exact
/// table: Postgres reports `varchar`, `_int4`, `numeric`, `timestamptz`; a domain or an
/// extension type reports something we have never seen. An exact table would put the long
/// tail in `Unknown` *and* need editing for every new engine; this puts the long tail in
/// `Unknown` and gets the common cases right for the whole postgres/mysql family at once.
///
/// Arrays are **text**, not their element's kind: `{1,2,3}` right-aligned as a number would
/// be a lie about a value that is not one.
pub fn cell_kind(type_name: &str) -> DbCellKind {
    let t = type_name.trim().to_ascii_lowercase();

    // ── ClickHouse type names, handled first because they WRAP ────────────────────────
    // `Nullable(String)` and `LowCardinality(String)` are decorations around the type that
    // decides the kind; nullability is carried by the cell being `None`, never by the kind.
    // Unwrapped before anything else so `Nullable(Decimal(20, 8))` is a number, not text.
    for wrapper in ["nullable(", "lowcardinality("] {
        if let Some(inner) = t.strip_prefix(wrapper).and_then(|r| r.strip_suffix(')')) {
            return cell_kind(inner);
        }
    }
    // `SimpleAggregateFunction(sum, UInt64)` puts the function first and the type last, so this
    // one — and ONLY this one — splits on the comma. An earlier version applied the split to every
    // wrapper, which turned `Nullable(Decimal(20, 8))` into ` 8)` and made a decimal column
    // Unknown; the type-name test caught it with `left: Unknown, right: Number`.
    if let Some(inner) = t
        .strip_prefix("simpleaggregatefunction(")
        .and_then(|r| r.strip_suffix(')'))
    {
        return cell_kind(inner.rsplit(',').next().unwrap_or(inner).trim());
    }
    // Composites render as compact JSON in a cell, so JSON is the honest kind — it is
    // what tells the grid not to right-align them or treat them as scalars.
    if t.starts_with("array(") || t.starts_with("map(") || t.starts_with("tuple(") {
        return DbCellKind::Json;
    }

    // Postgres spells an array type `_int4` (and `int4[]` when quoted); either way the cell
    // holds the `{…}` literal, which is text.
    if t.starts_with('_') || t.ends_with("[]") {
        return DbCellKind::Text;
    }
    if t.starts_with("bool") {
        return DbCellKind::Bool;
    }
    if t == "json" || t == "jsonb" {
        return DbCellKind::Json;
    }
    if t.starts_with("bytea") || t.contains("blob") || t.starts_with("binary") || t == "varbinary" {
        return DbCellKind::Binary;
    }
    if t.starts_with("timestamp") || t.starts_with("date") || t.starts_with("time") {
        return DbCellKind::Datetime;
    }
    if matches!(
        t.as_str(),
        "int2"
            | "int4"
            | "int8"
            | "smallint"
            | "integer"
            | "int"
            | "bigint"
            | "tinyint"
            | "mediumint"
            | "float4"
            | "float8"
            | "real"
            | "double"
            | "double precision"
            | "numeric"
            | "decimal"
            | "money"
            | "oid"
            | "serial"
            | "bigserial"
    ) {
        return DbCellKind::Number;
    }
    if matches!(
        t.as_str(),
        "text"
            | "varchar"
            | "char"
            | "bpchar"
            | "name"
            | "citext"
            | "uuid"
            | "xml"
            | "inet"
            // ClickHouse's one text type. Not a Postgres or MySQL spelling, so adding it here
            // cannot change either of those engines' mappings.
            | "string"
    ) || t.starts_with("varchar(")
        || t.starts_with("char(")
    {
        return DbCellKind::Text;
    }

    // ── MongoDB's BSON type names ──────────────────────────────────────────────
    // Exact matches, and they must come BEFORE the prefix arms below for the same
    // order-is-load-bearing reason those arms are last: `objectId` starts with "object".
    if matches!(t.as_str(), "double" | "long" | "int" | "decimal" | "number") {
        return DbCellKind::Number;
    }
    if matches!(
        t.as_str(),
        "objectid" | "regex" | "javascript" | "symbol" | "dbpointer"
    ) {
        return DbCellKind::Text;
    }
    if t == "bindata" {
        return DbCellKind::Binary;
    }
    if matches!(t.as_str(), "object" | "array") {
        return DbCellKind::Json;
    }
    if matches!(t.as_str(), "date" | "timestamp") {
        return DbCellKind::Datetime;
    }
    // `null`, `undefined`, `minKey`, `maxKey` deliberately fall through to `Unknown`: none of
    // them describes how a COLUMN renders, and a column whose only observed type is `null` has
    // told us nothing about the values that will arrive next.

    // 🔴 A HETEROGENEOUS column, which only MongoDB produces: `mongo.rs` spells a field seen
    // with more than one BSON type as `"int | string"`. That must be `Unknown`, and it very
    // nearly was not — the `starts_with("int")` arm below matched it and returned `Number`, so a
    // column of mixed ints and strings would have been right-aligned as numeric. Found by the
    // MongoDB engine's author while pinning this function's behaviour, not by a failing feature.
    // Checked here rather than at the call site because any future engine that spells a union
    // this way inherits the fix.
    if t.contains(" | ") {
        return DbCellKind::Unknown;
    }

    // ── ClickHouse's parameterised spellings, LAST on purpose ─────────────────────────
    // These are prefix matches, because the exact-match tables above cannot enumerate
    // `Decimal(20, 8)` / `Decimal64(3)` / `FixedString(16)` / `Enum8('duo' = 1, …)`.
    //
    // ⚠️ They must stay *after* every table above. An earlier version put them first and
    // `starts_with("int")` swallowed Postgres's `int4[]` — an array became a right-aligned
    // Number, caught immediately by `an_array_is_text_because_its_cell_holds_a_brace_literal`.
    // Order is load-bearing here, so the array/binary/datetime checks get to answer first.
    if t.starts_with("decimal") || t.starts_with("uint") || t.starts_with("int") {
        return DbCellKind::Number;
    }
    if t.starts_with("float") {
        return DbCellKind::Number;
    }
    if t.starts_with("fixedstring") || t.starts_with("enum") || t.starts_with("ipv") {
        return DbCellKind::Text;
    }
    DbCellKind::Unknown
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_common_postgres_type_names_map_to_the_kind_the_grid_needs() {
        for (name, want) in [
            ("int4", DbCellKind::Number),
            ("INT8", DbCellKind::Number),
            ("numeric", DbCellKind::Number),
            ("float8", DbCellKind::Number),
            ("bool", DbCellKind::Bool),
            ("jsonb", DbCellKind::Json),
            ("json", DbCellKind::Json),
            ("bytea", DbCellKind::Binary),
            ("timestamptz", DbCellKind::Datetime),
            ("date", DbCellKind::Datetime),
            ("text", DbCellKind::Text),
            ("varchar", DbCellKind::Text),
            ("uuid", DbCellKind::Text),
        ] {
            assert_eq!(cell_kind(name), want, "{name}");
        }
    }

    #[test]
    fn an_array_is_text_because_its_cell_holds_a_brace_literal() {
        // `_int4` is how Postgres names `int4[]`. Right-aligning `{1,2,3}` as a number would
        // be a lie about a value that is not one.
        assert_eq!(cell_kind("_int4"), DbCellKind::Text);
        assert_eq!(cell_kind("int4[]"), DbCellKind::Text);
    }

    /// ClickHouse's type names, taken **verbatim from a server's `JSONCompact` `meta[]`**
    /// (25.6.13, the fixture) rather than from the docs — the parameterisation and
    /// the wrappers are exactly what arrives, quoting and spacing included.
    #[test]
    fn clickhouse_type_names_map_including_their_wrappers() {
        for (name, want) in [
            ("UInt32", DbCellKind::Number),
            ("Int64", DbCellKind::Number),
            ("Float64", DbCellKind::Number),
            ("Decimal(20, 8)", DbCellKind::Number),
            // The wrappers: nullability is carried by the CELL being None, never by the kind,
            // so `Nullable(Decimal(…))` has to be a number or the grid stops right-aligning a
            // column the moment one row is NULL.
            ("Nullable(Decimal(20, 8))", DbCellKind::Number),
            ("Nullable(String)", DbCellKind::Text),
            ("LowCardinality(String)", DbCellKind::Text),
            ("Nullable(Float64)", DbCellKind::Number),
            // Composites render as compact JSON in the cell.
            ("Array(String)", DbCellKind::Json),
            ("Map(String, UInt8)", DbCellKind::Json),
            ("Tuple(UInt8, String)", DbCellKind::Json),
            ("Array(Nullable(String))", DbCellKind::Json),
            ("Bool", DbCellKind::Bool),
            ("String", DbCellKind::Text),
            ("FixedString(16)", DbCellKind::Text),
            ("UUID", DbCellKind::Text),
            ("IPv4", DbCellKind::Text),
            // The enum renders as its label, and the label is text.
            ("Enum8('duo' = 1, 'trio' = 2)", DbCellKind::Text),
            ("DateTime64(3, 'UTC')", DbCellKind::Datetime),
            ("Date", DbCellKind::Datetime),
        ] {
            assert_eq!(cell_kind(name), want, "{name}");
        }
    }

    /// MongoDB's BSON type names, and the two traps in them.
    ///
    /// Written from what `mongo.rs` actually puts in a column's `type_name`, not from a summary
    /// table — such a table names only `binData` and `object`, and the engine produces eight more.
    #[test]
    fn mongo_bson_type_names_map_and_a_heterogeneous_column_stays_unknown() {
        for (name, want) in [
            ("double", DbCellKind::Number),
            ("long", DbCellKind::Number),
            ("int", DbCellKind::Number),
            ("decimal", DbCellKind::Number),
            ("string", DbCellKind::Text),
            // `objectId` starts with "object" — if the composite arm ran first it would be Json.
            ("objectId", DbCellKind::Text),
            ("object", DbCellKind::Json),
            ("array", DbCellKind::Json),
            ("binData", DbCellKind::Binary),
            ("date", DbCellKind::Datetime),
            ("timestamp", DbCellKind::Datetime),
            ("bool", DbCellKind::Bool),
            // Nothing about how a column RENDERS is implied by these.
            ("null", DbCellKind::Unknown),
            ("minKey", DbCellKind::Unknown),
        ] {
            assert_eq!(cell_kind(name), want, "{name}");
        }
    }

    /// 🔴 The bug this arm exists for. `mongo.rs` spells a field seen with more than one BSON
    /// type as `"int | string"`, and the ClickHouse prefix arm matched `starts_with("int")` and
    /// returned `Number` — so a column of mixed ints and strings was right-aligned as numeric.
    /// Latent: the MongoDB engine guards against it at its own call site too, so no feature was
    /// visibly broken, which is exactly why it needed a test here rather than a comment there.
    #[test]
    fn a_heterogeneous_column_is_never_typed_by_its_first_alternative() {
        for name in [
            "int | string",
            "string | int",
            "double | null",
            "object | array",
        ] {
            assert_eq!(cell_kind(name), DbCellKind::Unknown, "{name}");
        }
    }

    #[test]
    fn an_unknown_type_is_unknown_rather_than_guessed() {
        // A user-defined ENUM (`track_ensemble` in the fixture), a PostGIS geometry and a range
        // type all land here — and all render as the exact text the server sent.
        for name in ["track_ensemble", "geometry", "tsrange", "hstore", ""] {
            assert_eq!(cell_kind(name), DbCellKind::Unknown, "{name}");
        }
    }

    #[test]
    fn the_wire_shape_is_camel_case_and_distinguishes_null_from_empty() {
        let set = DbResultSet {
            kind: DbResultKind::Rows,
            statement: "SELECT tag FROM tracks".into(),
            columns: vec![DbColumn {
                name: "tag".into(),
                type_name: "text".into(),
                kind: DbCellKind::Text,
            }],
            rows: vec![vec![None], vec![Some(String::new())]],
            rows_affected: None,
            truncated: false,
            row_limit: 500,
            duration_ms: 3,
            notice: None,
            absent: None,
        };
        let json = serde_json::to_string(&set).unwrap();
        assert!(json.contains("\"rowsAffected\":null"));
        assert!(json.contains("\"rowLimit\":500"));
        assert!(json.contains("\"durationMs\":3"));
        assert!(json.contains("\"typeName\":\"text\""));
        // The NULL-vs-empty invariant, on the wire: `null` and `""` are two different cells.
        assert!(
            json.contains("\"rows\":[[null],[\"\"]]"),
            "NULL and the empty string must not collapse: {json}"
        );
        // 🔴 An engine with no absent-vs-null distinction sends **no `absent` key at all**, rather
        // than a null or a mask of `false`s. Six of the eight engines are in that class, and a field
        // they can never populate should not be on their wire.
        assert!(!json.contains("absent"), "{json}");
    }

    /// The presence mask on the wire, and what it is for.
    #[test]
    fn the_absent_mask_travels_only_when_a_cell_really_is_missing() {
        let base = DbResultSet {
            kind: DbResultKind::Rows,
            statement: r#"{"find": "tracks"}"#.into(),
            columns: vec![DbColumn {
                name: "tag".into(),
                type_name: "string".into(),
                kind: DbCellKind::Text,
            }],
            // 🔴 Both cells are `None` — that is the whole problem. The rows alone cannot tell "the
            // field holds null" from "the document does not have the field", and painting both as
            // NULL is the app stating something the data never said.
            rows: vec![vec![None], vec![None]],
            rows_affected: None,
            truncated: false,
            row_limit: 500,
            duration_ms: 1,
            notice: None,
            absent: Some(vec![vec![false], vec![true]]),
        };
        let json = serde_json::to_string(&base).unwrap();
        assert!(json.contains("\"absent\":[[false],[true]]"), "{json}");
        // The mask is the SAME SHAPE as the rows, or a consumer cannot index it.
        let mask = base.absent.as_ref().expect("a mask");
        assert_eq!(mask.len(), base.rows.len());
        assert_eq!(mask[0].len(), base.rows[0].len());
    }

    #[test]
    fn a_message_result_carries_its_statement_and_its_prose() {
        let m = DbResultSet::message("SELCT 1", "syntax error at or near \"SELCT\"", 500);
        assert_eq!(m.kind, DbResultKind::Message);
        assert_eq!(m.statement, "SELCT 1");
        assert!(m.rows.is_empty() && m.columns.is_empty());
        assert!(m.notice.unwrap().contains("syntax error"));
    }
}
