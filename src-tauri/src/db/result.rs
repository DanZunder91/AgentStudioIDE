//! Result-set wire types. Every value is `Option<String>` from the text protocol (`None` = NULL,
//! `Some("")` = empty), so there is no per-type decoder. [`DbCellKind`] drives alignment only and
//! comes from the column's declared type, never the value; unknown names render as plain text.

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
    /// Cells that are absent rather than null (MongoDB/DynamoDB can omit a field), parallel to
    /// `rows`. `None`, and off the wire, for engines without that state; the frontend renders a
    /// masked cell as `undefined` (`missing`).
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

/// Map a server type name onto a render kind by prefix/contains on the lower-cased name, so
/// unseen domain or extension types fall to `Unknown`. Arrays are text, not their element kind.
pub fn cell_kind(type_name: &str) -> DbCellKind {
    let t = type_name.trim().to_ascii_lowercase();

    // ── ClickHouse wrappers first: `Nullable(…)`/`LowCardinality(…)` are unwrapped (nullability is
    // the cell being `None`), so `Nullable(Decimal(20, 8))` is a number.
    for wrapper in ["nullable(", "lowcardinality("] {
        if let Some(inner) = t.strip_prefix(wrapper).and_then(|r| r.strip_suffix(')')) {
            return cell_kind(inner);
        }
    }
    // Only `SimpleAggregateFunction(fn, Type)` splits on the comma: splitting other wrappers would
    // break `Decimal(20, 8)`.
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

    // A heterogeneous column (`mongo.rs` spells it `"int | string"`) is `Unknown`; checked before
    // the `starts_with("int")` arm below would call it a number.
    if t.contains(" | ") {
        return DbCellKind::Unknown;
    }

    // ── ClickHouse's parameterised spellings (`Decimal(20, 8)`, `FixedString(16)`, `Enum8(…)`),
    // LAST on purpose: before the tables above, `starts_with("int")` would swallow Postgres's
    // `int4[]`.
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

    /// Written from the names `mongo.rs` actually emits, not a summary table (which omits eight).
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

    /// `mongo.rs` also guards this at its call site, so the arm needs its own test here.
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
