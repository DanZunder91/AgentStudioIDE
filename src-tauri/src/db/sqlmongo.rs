//! SQL → MongoDB command document. **Client-side translation, refusal-first.**
//!
//! ## Why this exists
//!
//! Other tools accept SQL such as `select * from ARCHIVEDB.temp_playlists LIMIT 10;` in a MongoDB
//! console and translate it client-side; so does this one. The server does not help with any of
//! it: **MongoDB's wire protocol has no SQL at all**, so the translation happens in the client.
//! This module is that translation.
//!
//! ## The subset, stated once, so nothing here can drift from it
//!
//! ```text
//! SELECT * FROM [database.]collection [WHERE <condition>] [LIMIT <n>]
//! ```
//!
//! and **nothing else** — narrowed to exactly this on purpose: the query is
//! always `select * from`, with or without a WHERE clause and with or without a LIMIT, and
//! ORDER BY is out of scope for now. The output shape is therefore only ever
//!
//! ```text
//! {"find": "<collection>", "filter": {…}?, "limit": <n>?}
//! ```
//!
//! plus a separate [`Translated::database`], which is how `ARCHIVEDB.temp_playlists` reaches the
//! right database (the caller puts it on the `$db` key `mongo.rs` already honours). There is no
//! `projection`, no `sort`, no `skip`, and no `count` command, because the narrower this is, the
//! less there is to be silently wrong about.
//!
//! The `WHERE` operator set is kept whole — a `WHERE` clause without operators is not a feature:
//! `= != <> < <= > >= AND OR NOT IN, NOT IN, IS NULL, IS NOT NULL, LIKE, NOT LIKE, BETWEEN`.
//!
//! ## 🔴 The rule that shapes every line below: never guess
//!
//! Anything outside the subset is an [`DbErrorCode::InvalidStatement`](crate::db::error::DbErrorCode::InvalidStatement)
//! that **names the construct that was not understood**. This is not politeness. A translator that
//! silently produces a *different* query returns wrong data **with no error** — the user reads a
//! grid, believes it, and nothing anywhere says the question they asked was not the question that
//! ran. A refusal costs one confused minute; an approximation costs a decision made on a lie. So:
//! prefer refusing over approximating, every time, and where an approximation is unavoidable, put
//! the loss in the output rather than in a comment nobody will read.
//!
//! ## The semantic gaps, and what is done about each
//!
//! | SQL | MongoDB | what this module does |
//! |---|---|---|
//! | `IS NULL` | `{"f": null}` matches null **and absent** | translate, and push a [`Translated::notices`] entry naming the field |
//! | `!=`, `NOT IN`, `NOT LIKE`, `NOT` | `$ne`/`$nin`/`$nor` match **absent** fields | translate, and push one notice about negation |
//! | `= NULL` | `{"f": null}` would *match*; SQL never does | **refused** — `IS NULL` is the thing they meant |
//! | `LIMIT 0` | `limit: 0` means *no limit*; SQL means *no rows* | **refused** by name |
//! | `LIKE 'a%'` | no `LIKE` | `^a.*$` with every regex metacharacter in the literal escaped |
//!
//! `_id` is not special-cased anywhere: a value stays the type the SQL gave it, because the
//! `_id`s seen in practice are UUID **strings** and a translator that "helpfully" made them
//! ObjectIds would match nothing while looking like it worked.
//!
//! ## Bounds, because `recursive-protection` is off on purpose
//!
//! `sqlparser` is pulled in with `default-features = false, features = ["std"]` — one package, no
//! vendored C. That leaves the `recursive-protection` feature (stack-overflow guards on the deeply
//! recursive parse functions) **off**, so pathological input has to be refused by a bound instead:
//! [`MAX_SQL_CHARS`] caps the text, and [`MAX_PARSE_DEPTH`] caps nesting via the parser's own
//! `RecursionCounter` — which, with `std` on, is real and returns `RecursionLimitExceeded` rather
//! than growing the stack. That second bound is load-bearing twice: it is also what bounds *our*
//! recursion over the AST below, since the tree cannot be deeper than the parser allowed.

use crate::db::error::DbError;
use bson::{doc, Bson, Document};
use sqlparser::ast::{
    BinaryOperator, Expr, LimitClause, Query, Select, SelectItem, SetExpr, Statement, TableFactor,
    UnaryOperator, Value,
};
use sqlparser::dialect::GenericDialect;
use sqlparser::parser::{Parser, ParserError};

/// The longest statement this translator will even tokenize.
///
/// Generous for a console (a hand-written `IN` list of a few hundred ids fits) and far below
/// anything that could make the parser interesting. Measured in **chars**, not bytes, so a
/// statement full of non-ASCII is judged the same as one that is not.
pub const MAX_SQL_CHARS: usize = 8_192;

/// The parser's recursion budget, shared across statement / query / table / expression nesting.
///
/// Set explicitly rather than left at the crate default (50) so the bound is *ours* and a
/// dependency bump cannot quietly change it. Deep enough that no query in the supported subset can
/// reach it — proved by [`tests::a_realistic_where_clause_is_nowhere_near_the_depth_bound`].
pub const MAX_PARSE_DEPTH: usize = 32;

/// A translated statement: the command to run, the database it named, and what was lost.
#[derive(Debug, Clone, PartialEq)]
pub struct Translated {
    /// The MongoDB command document, first key first — `{"find": …}`.
    pub command: Document,
    /// The `db` half of `FROM db.collection`, when the FROM was qualified. The caller maps this
    /// onto `$db`; it is deliberately *not* written into `command` here, because `$db` is a field
    /// the driver also supplies and only the caller knows which one wins.
    pub database: Option<String>,
    /// Places where MongoDB's answer is not exactly SQL's. Never empty for no reason: every entry
    /// is a difference the person reading the grid would otherwise never learn about.
    pub notices: Vec<String>,
}

/// Translate one SQL statement into one MongoDB command document.
///
/// Pure and synchronous — no I/O, no clock, no globals — so every claim about it is a unit test.
pub fn translate(sql: &str) -> Result<Translated, DbError> {
    let trimmed = sql.trim();
    if trimmed.is_empty() {
        return Err(DbError::invalid_statement("There is nothing to translate."));
    }
    let chars = trimmed.chars().count();
    if chars > MAX_SQL_CHARS {
        return Err(DbError::invalid_statement(format!(
            "That statement is {chars} characters long, and this translator refuses anything over \
             {MAX_SQL_CHARS}. Nothing was parsed: an unbounded input is the one way a parser with \
             no stack guard can fail badly rather than politely."
        )));
    }

    let dialect = GenericDialect {};
    let mut parser = Parser::new(&dialect)
        .with_recursion_limit(MAX_PARSE_DEPTH)
        .try_with_sql(trimmed)
        .map_err(map_parse_error)?;
    let statements = parser.parse_statements().map_err(map_parse_error)?;

    let statement = match statements.len() {
        0 => return Err(DbError::invalid_statement("There is nothing to translate.")),
        1 => &statements[0],
        n => {
            return Err(unsupported(&format!(
                "more than one statement in one run ({n} were found)"
            )))
        }
    };

    let Statement::Query(query) = statement else {
        return Err(unsupported(&format!(
            "the `{}` statement",
            leading_word(trimmed)
        )));
    };

    translate_query(query)
}

/* ────────────────────────────── the statement ────────────────────────────── */

/// `Query` → the command. Every clause the subset does not contain is checked here, by name.
fn translate_query(query: &Query) -> Result<Translated, DbError> {
    if query.with.is_some() {
        return Err(unsupported("a WITH clause (a common table expression)"));
    }
    if query.fetch.is_some() {
        return Err(unsupported("FETCH"));
    }
    if !query.locks.is_empty() {
        return Err(unsupported("FOR UPDATE / FOR SHARE"));
    }
    if query.for_clause.is_some() {
        return Err(unsupported("FOR XML / FOR JSON"));
    }
    if query.settings.is_some() {
        return Err(unsupported("SETTINGS"));
    }
    if query.format_clause.is_some() {
        return Err(unsupported("FORMAT"));
    }
    if !query.pipe_operators.is_empty() {
        return Err(unsupported("a pipe operator (`|>`)"));
    }
    // 🔴 Explicitly excluded: ORDER BY is out of scope for now. Emitting a `sort`
    // anyway would be the friendliest possible way to run a different query.
    if query.order_by.is_some() {
        return Err(unsupported("ORDER BY"));
    }

    let select = match query.body.as_ref() {
        SetExpr::Select(select) => select.as_ref(),
        SetExpr::SetOperation { op, .. } => return Err(unsupported(&format!("{op}"))),
        SetExpr::Query(_) => {
            return Err(unsupported(
                "a parenthesised subquery as the whole statement",
            ))
        }
        SetExpr::Values(_) => return Err(unsupported("VALUES")),
        SetExpr::Table(_) => return Err(unsupported("the TABLE command")),
        SetExpr::Insert(_) => return Err(unsupported("an INSERT inside a query")),
        SetExpr::Update(_) => return Err(unsupported("an UPDATE inside a query")),
        SetExpr::Delete(_) => return Err(unsupported("a DELETE inside a query")),
        SetExpr::Merge(_) => return Err(unsupported("a MERGE inside a query")),
    };

    check_select_clauses(select)?;
    require_bare_star(select)?;
    let (database, collection) = from_target(select)?;

    let mut notices = Notices::default();
    let filter = match &select.selection {
        Some(where_clause) => Some(condition(where_clause, &mut notices)?),
        None => None,
    };
    let limit = limit_value(query.limit_clause.as_ref())?;

    // Built in this order on purpose: the command name must be the FIRST key of the document
    // (key order is the protocol here, not cosmetics).
    let mut command = Document::new();
    command.insert("find", collection);
    if let Some(filter) = filter {
        command.insert("filter", filter);
    }
    if let Some(limit) = limit {
        command.insert("limit", Bson::Int64(limit));
    }

    Ok(Translated {
        command,
        database,
        notices: notices.into_vec(),
    })
}

/// Every `SELECT` clause outside the subset, refused by its own name.
fn check_select_clauses(select: &Select) -> Result<(), DbError> {
    if select.distinct.is_some() {
        return Err(unsupported("DISTINCT"));
    }
    if select.top.is_some() {
        return Err(unsupported("TOP"));
    }
    if select.into.is_some() {
        return Err(unsupported("SELECT … INTO"));
    }
    if select.prewhere.is_some() {
        return Err(unsupported("PREWHERE"));
    }
    if select.having.is_some() {
        return Err(unsupported("HAVING"));
    }
    if select.qualify.is_some() {
        return Err(unsupported("QUALIFY"));
    }
    if !select.named_window.is_empty() {
        return Err(unsupported("WINDOW"));
    }
    if !select.cluster_by.is_empty() {
        return Err(unsupported("CLUSTER BY"));
    }
    if !select.distribute_by.is_empty() {
        return Err(unsupported("DISTRIBUTE BY"));
    }
    if !select.sort_by.is_empty() {
        return Err(unsupported("SORT BY"));
    }
    if !select.lateral_views.is_empty() {
        return Err(unsupported("a LATERAL VIEW"));
    }
    if !select.connect_by.is_empty() {
        return Err(unsupported("CONNECT BY"));
    }
    if select.exclude.is_some() {
        return Err(unsupported("EXCLUDE"));
    }
    if select.value_table_mode.is_some() {
        return Err(unsupported("SELECT AS STRUCT / SELECT AS VALUE"));
    }
    if select.select_modifiers.is_some() {
        return Err(unsupported("a MySQL SELECT modifier"));
    }
    if !select.optimizer_hints.is_empty() {
        return Err(unsupported("an optimizer hint"));
    }
    let group_by_present = match &select.group_by {
        sqlparser::ast::GroupByExpr::All(_) => true,
        sqlparser::ast::GroupByExpr::Expressions(exprs, modifiers) => {
            !exprs.is_empty() || !modifiers.is_empty()
        }
    };
    if group_by_present {
        return Err(unsupported("GROUP BY"));
    }
    if select.flavor != sqlparser::ast::SelectFlavor::Standard {
        return Err(unsupported("a FROM-first SELECT"));
    }
    Ok(())
}

/// The projection must be exactly `*`, with no wildcard modifiers attached to it.
fn require_bare_star(select: &Select) -> Result<(), DbError> {
    let column_list = || unsupported("a column list (only `SELECT *` is supported)");
    let [item] = select.projection.as_slice() else {
        // Zero items cannot happen (the parser demands one); more than one is a column list.
        return Err(column_list());
    };
    match item {
        SelectItem::Wildcard(options) => {
            if options.opt_ilike.is_some() {
                return Err(unsupported("`* ILIKE …`"));
            }
            if options.opt_exclude.is_some() {
                return Err(unsupported("`* EXCLUDE …`"));
            }
            if options.opt_except.is_some() {
                return Err(unsupported("`* EXCEPT …`"));
            }
            if options.opt_replace.is_some() {
                return Err(unsupported("`* REPLACE …`"));
            }
            if options.opt_rename.is_some() {
                return Err(unsupported("`* RENAME …`"));
            }
            if options.opt_alias.is_some() {
                return Err(unsupported("an alias on `*`"));
            }
            Ok(())
        }
        SelectItem::QualifiedWildcard(..) => Err(unsupported("a qualified wildcard (`t.*`)")),
        SelectItem::ExprWithAlias { .. } | SelectItem::ExprWithAliases { .. } => {
            Err(unsupported("a column alias (`AS`)"))
        }
        // A single named thing is still a column list as far as the subset is concerned — except
        // for a function call, which deserves to be named as itself because `COUNT(*)` is the one
        // people reach for first.
        SelectItem::UnnamedExpr(expr) => match peel(expr) {
            Expr::Function(function) => {
                Err(unsupported(&format!("the function `{}`", function.name)))
            }
            _ => Err(column_list()),
        },
    }
}

/// `FROM [database.]collection` → `(database, collection)`.
///
/// Identifiers travel **verbatim**: `sqlparser` keeps the source text of an identifier (quoted or
/// not) and nothing here folds case, because MongoDB collection names are case-sensitive and a
/// database named `ARCHIVEDB` is not `archivedb`.
fn from_target(select: &Select) -> Result<(Option<String>, String), DbError> {
    let [table] = select.from.as_slice() else {
        if select.from.is_empty() {
            return Err(unsupported("a SELECT with no FROM clause"));
        }
        // `FROM a, b` — a comma join. Named as a JOIN because that is what it is.
        return Err(unsupported("a JOIN (more than one table in FROM)"));
    };
    if !table.joins.is_empty() {
        return Err(unsupported("a JOIN"));
    }
    let TableFactor::Table {
        name,
        alias,
        args,
        with_hints,
        version,
        with_ordinality,
        partitions,
        json_path,
        sample,
        index_hints,
    } = &table.relation
    else {
        return match &table.relation {
            TableFactor::Derived { .. } => Err(unsupported("a subquery in FROM (a derived table)")),
            TableFactor::TableFunction { .. } | TableFactor::Function { .. } => {
                Err(unsupported("a table function in FROM"))
            }
            TableFactor::UNNEST { .. } => Err(unsupported("UNNEST")),
            TableFactor::NestedJoin { .. } => Err(unsupported("a nested JOIN")),
            TableFactor::Pivot { .. } => Err(unsupported("PIVOT")),
            TableFactor::Unpivot { .. } => Err(unsupported("UNPIVOT")),
            TableFactor::MatchRecognize { .. } => Err(unsupported("MATCH_RECOGNIZE")),
            TableFactor::OpenJsonTable { .. } => Err(unsupported("OPENJSON")),
            TableFactor::JsonTable { .. } | TableFactor::XmlTable { .. } => {
                Err(unsupported("a JSON_TABLE / XMLTABLE source"))
            }
            // Catch-all rather than a `TableFactor::Table` arm plus `unreachable!()`: a plain table
            // cannot reach here (the let-else above took it), and `sqlparser` grows variants on
            // every release — a wildcard keeps a dependency bump from turning into a build break
            // *or*, worse, into a silently-accepted source we never meant to support.
            other => Err(unsupported(&format!("`{other}` as a FROM source"))),
        };
    };
    if alias.is_some() {
        return Err(unsupported("a table alias"));
    }
    if args.is_some() {
        return Err(unsupported("table-function arguments in FROM"));
    }
    if !with_hints.is_empty() {
        return Err(unsupported("a table hint (`WITH (…)`)"));
    }
    if version.is_some() {
        return Err(unsupported("a table version (`FOR SYSTEM_TIME`)"));
    }
    if *with_ordinality {
        return Err(unsupported("WITH ORDINALITY"));
    }
    if !partitions.is_empty() {
        return Err(unsupported("a PARTITION selector"));
    }
    if json_path.is_some() {
        return Err(unsupported("a JSON path on a table name"));
    }
    if sample.is_some() {
        return Err(unsupported("TABLESAMPLE"));
    }
    if !index_hints.is_empty() {
        return Err(unsupported("an index hint"));
    }

    let mut parts = Vec::with_capacity(name.0.len());
    for part in &name.0 {
        let Some(ident) = part.as_ident() else {
            return Err(unsupported("a function call inside a table name"));
        };
        parts.push(ident.value.clone());
    }
    match parts.len() {
        1 => {
            let collection = parts.pop().unwrap_or_default();
            Ok((None, check_collection(collection)?))
        }
        2 => {
            let collection = parts.pop().unwrap_or_default();
            let database = parts.pop().unwrap_or_default();
            if database.trim().is_empty() {
                return Err(unsupported("an empty database name in FROM"));
            }
            Ok((Some(database), check_collection(collection)?))
        }
        _ => Err(unsupported(&format!(
            "a table name with {} parts (only `collection` and `database.collection` are understood)",
            parts.len()
        ))),
    }
}

/// A collection name that MongoDB would read as something other than a name is not a name.
fn check_collection(name: String) -> Result<String, DbError> {
    if name.trim().is_empty() {
        return Err(unsupported("an empty collection name"));
    }
    if name.starts_with('$') {
        return Err(unsupported(
            "a collection name beginning with `$` (MongoDB reserves that prefix)",
        ));
    }
    Ok(name)
}

/// `LIMIT n` → `Some(n)`. Everything else about the clause is refused by name.
fn limit_value(clause: Option<&LimitClause>) -> Result<Option<i64>, DbError> {
    let Some(clause) = clause else {
        return Ok(None);
    };
    let (limit, offset, limit_by) = match clause {
        LimitClause::OffsetCommaLimit { .. } => {
            return Err(unsupported("`LIMIT <offset>, <count>`"))
        }
        LimitClause::LimitOffset {
            limit,
            offset,
            limit_by,
        } => (limit, offset, limit_by),
    };
    if !limit_by.is_empty() {
        return Err(unsupported("LIMIT BY"));
    }
    // 🔴 OFFSET is out of the subset — and it would be meaningless here anyway, because without an
    // ORDER BY there is no defined order for it to skip *into*.
    if offset.is_some() {
        return Err(unsupported("OFFSET"));
    }
    // `LIMIT ALL` means "no limit", which is exactly what an absent `limit` key is — so this is a
    // translation, not an approximation. Measured, because the shape is surprising: `sqlparser`
    // folds a bare `LIMIT ALL` into **no limit clause at all**, so a `None` surviving to here can
    // only come from `LIMIT ALL` written alongside an `OFFSET` or a `BY`, both already refused
    // above. The arm stays anyway rather than becoming an `unreachable!()`: a dependency bump that
    // changes the folding must not turn into a panic in a console.
    let Some(limit) = limit else {
        return Ok(None);
    };
    let n = match peel(limit) {
        Expr::Value(v) => match &v.value {
            Value::Number(text, _) => text.parse::<i64>().map_err(|_| {
                unsupported(&format!(
                    "a LIMIT of `{text}` (it has to be a whole number that fits in 64 bits)"
                ))
            })?,
            other => {
                return Err(unsupported(&format!(
                    "a LIMIT of `{other}` (it has to be a whole number)"
                )))
            }
        },
        other => {
            return Err(unsupported(&format!(
                "a LIMIT of {} (it has to be a whole number)",
                describe(other)
            )))
        }
    };
    // 🔴 `LIMIT 0` is the trap in this clause: SQL means *no rows*, MongoDB's `find` reads
    // `limit: 0` as *no limit at all*. Translating it would turn "show me nothing" into "show me
    // everything" — the exact silent-wrong-answer this module exists to refuse.
    if n == 0 {
        return Err(unsupported(
            "`LIMIT 0` (SQL means no rows, but MongoDB reads `limit: 0` as NO LIMIT, so this would \
             return the whole collection)",
        ));
    }
    if n < 0 {
        return Err(unsupported(&format!("a negative LIMIT (`{n}`)")));
    }
    Ok(Some(n))
}

/* ────────────────────────────── the WHERE clause ────────────────────────────── */

/// Deduplicated notices, in first-encounter order.
#[derive(Debug, Default)]
struct Notices(Vec<String>);

impl Notices {
    fn push(&mut self, text: String) {
        if !self.0.contains(&text) {
            self.0.push(text);
        }
    }

    /// The one notice every negative operator shares. Pushed once however many there are.
    fn negation(&mut self) {
        self.push(
            "MongoDB's negative operators (`$ne`, `$nin`, `$nor`) also match documents where the \
             field is ABSENT, because a field that is not there is not equal to anything. SQL has \
             no absent field, so a negated condition can return rows the same SQL would not."
                .to_string(),
        );
    }

    fn into_vec(self) -> Vec<String> {
        self.0
    }
}

/// One boolean expression → one MongoDB query document.
///
/// Recursion is bounded by [`MAX_PARSE_DEPTH`]: the parser refused anything nested deeper, so this
/// walk cannot outrun the stack even though `recursive-protection` is off.
fn condition(expr: &Expr, notices: &mut Notices) -> Result<Document, DbError> {
    match peel(expr) {
        Expr::BinaryOp { left, op, right } => match op {
            BinaryOperator::And => Ok(doc! { "$and": join(expr, &BinaryOperator::And, notices)? }),
            BinaryOperator::Or => Ok(doc! { "$or": join(expr, &BinaryOperator::Or, notices)? }),
            _ => comparison(left, op, right, notices),
        },
        Expr::UnaryOp {
            op: UnaryOperator::Not,
            expr: inner,
        } => {
            notices.negation();
            Ok(doc! { "$nor": [ condition(inner, notices)? ] })
        }
        Expr::IsNull(inner) => {
            let field = field_name(inner)?;
            // The loss goes in the OUTPUT, not in a design note.
            notices.push(format!(
                "`IS NULL` on `{field}` became `{{\"{field}\": null}}`. In MongoDB that matches \
                 documents where `{field}` is null AND documents where `{field}` is absent \
                 entirely. SQL has no absent field, so this can return rows the same SQL would not."
            ));
            Ok(doc! { field: Bson::Null })
        }
        Expr::IsNotNull(inner) => {
            let field = field_name(inner)?;
            Ok(doc! { field: { "$ne": Bson::Null } })
        }
        Expr::InList {
            expr: inner,
            list,
            negated,
        } => {
            let field = field_name(inner)?;
            let mut values = Vec::with_capacity(list.len());
            for item in list {
                let value = literal(item)?;
                if value == Bson::Null {
                    return Err(unsupported(
                        "NULL inside an IN list (in SQL a NULL there never matches; MongoDB's \
                         `$in` would match nulls and absent fields)",
                    ));
                }
                values.push(value);
            }
            if *negated {
                notices.negation();
                Ok(doc! { field: { "$nin": values } })
            } else {
                Ok(doc! { field: { "$in": values } })
            }
        }
        Expr::Between {
            expr: inner,
            negated,
            low,
            high,
        } => {
            let field = field_name(inner)?;
            let low = non_null_literal(low, "BETWEEN")?;
            let high = non_null_literal(high, "BETWEEN")?;
            let range = doc! { "$gte": low, "$lte": high };
            if *negated {
                notices.negation();
                Ok(doc! { "$nor": [ doc! { field: range } ] })
            } else {
                Ok(doc! { field: range })
            }
        }
        Expr::Like {
            negated,
            any,
            expr: inner,
            pattern,
            escape_char,
        } => {
            if *any {
                return Err(unsupported("LIKE ANY"));
            }
            if escape_char.is_some() {
                return Err(unsupported("the ESCAPE clause of LIKE"));
            }
            let field = field_name(inner)?;
            let Expr::Value(value) = peel(pattern) else {
                return Err(unsupported(&format!(
                    "a LIKE pattern that is {} (it has to be a string literal)",
                    describe(peel(pattern))
                )));
            };
            let text = match &value.value {
                Value::SingleQuotedString(s) | Value::DoubleQuotedString(s) => s,
                other => {
                    return Err(unsupported(&format!(
                        "a LIKE pattern of `{other}` (it has to be a string literal)"
                    )))
                }
            };
            let matcher = doc! { "$regex": like_to_regex(text), "$options": "s" };
            if *negated {
                notices.negation();
                Ok(doc! { "$nor": [ doc! { field: matcher } ] })
            } else {
                Ok(doc! { field: matcher })
            }
        }
        other => Err(unsupported(&format!(
            "{} in a WHERE clause",
            describe(other)
        ))),
    }
}

/// Flatten a chain of one boolean operator into a list, so `a AND b AND c` is a single `$and` of
/// three rather than a nest of two — same meaning, but a document a person can read.
fn join(
    expr: &Expr,
    want: &BinaryOperator,
    notices: &mut Notices,
) -> Result<Vec<Document>, DbError> {
    let mut parts = Vec::new();
    collect(expr, want, &mut parts);
    let mut out = Vec::with_capacity(parts.len());
    for part in parts {
        out.push(condition(part, notices)?);
    }
    Ok(out)
}

fn collect<'a>(expr: &'a Expr, want: &BinaryOperator, out: &mut Vec<&'a Expr>) {
    if let Expr::BinaryOp { left, op, right } = peel(expr) {
        if op == want {
            collect(left, want, out);
            collect(right, want, out);
            return;
        }
    }
    out.push(expr);
}

/// `<column> <op> <literal>` — in either order, because `5 < duration` is ordinary SQL.
///
/// Flipping the operator when the literal is on the left is exact arithmetic, not a guess: `<`
/// becomes `>` and the meaning is identical. Anything with a non-literal on both sides, or a
/// literal on both sides, is refused rather than approximated.
fn comparison(
    left: &Expr,
    op: &BinaryOperator,
    right: &Expr,
    notices: &mut Notices,
) -> Result<Document, DbError> {
    let left_literal = literal(left).ok();
    let right_literal = literal(right).ok();
    let (field, op, value) = match (left_literal, right_literal) {
        (None, Some(value)) => (field_name(left)?, op.clone(), value),
        (Some(value), None) => {
            let flipped = flip(op).ok_or_else(|| unsupported(&format!("the operator `{op}`")))?;
            (field_name(right)?, flipped, value)
        }
        (Some(_), Some(_)) => {
            return Err(unsupported(
                "a comparison between two literals (neither side names a field)",
            ))
        }
        (None, None) => {
            return match (field_name(left), field_name(right)) {
                (Ok(_), Ok(_)) => Err(unsupported(
                    "a comparison with a column on both sides — one side has to be a literal",
                )),
                (Err(e), _) | (Ok(_), Err(e)) => Err(e),
            }
        }
    };
    // 🔴 `x = NULL` is never true in SQL, and `{"x": null}` in MongoDB matches both nulls and
    // absent fields. Translating it would turn a query that matches nothing into one that matches
    // a lot. `IS NULL` is what they meant, and it is supported.
    if value == Bson::Null {
        return Err(unsupported(
            "a comparison against NULL (in SQL `= NULL` never matches anything; write `IS NULL` \
             or `IS NOT NULL`)",
        ));
    }
    match op {
        BinaryOperator::Eq => Ok(doc! { field: value }),
        BinaryOperator::NotEq => {
            // `$ne` matches documents that do not have the field at all. SQL has no such row.
            notices.negation();
            Ok(doc! { field: { "$ne": value } })
        }
        BinaryOperator::Lt => Ok(doc! { field: { "$lt": value } }),
        BinaryOperator::LtEq => Ok(doc! { field: { "$lte": value } }),
        BinaryOperator::Gt => Ok(doc! { field: { "$gt": value } }),
        BinaryOperator::GtEq => Ok(doc! { field: { "$gte": value } }),
        other => Err(unsupported(&format!("the operator `{other}`"))),
    }
}

/// The mirror of a comparison operator, or `None` when there is not one — which is the same set as
/// "the operators this translator understands", so a `None` here is always a refusal.
fn flip(op: &BinaryOperator) -> Option<BinaryOperator> {
    Some(match op {
        BinaryOperator::Eq => BinaryOperator::Eq,
        BinaryOperator::NotEq => BinaryOperator::NotEq,
        BinaryOperator::Lt => BinaryOperator::Gt,
        BinaryOperator::LtEq => BinaryOperator::GtEq,
        BinaryOperator::Gt => BinaryOperator::Lt,
        BinaryOperator::GtEq => BinaryOperator::LtEq,
        _ => return None,
    })
}

/// A plain, unqualified column name.
///
/// A name is a **field path** to MongoDB, so a quoted `"a.b"` addresses a nested field — that is a
/// feature and it is left alone. A name starting with `$` is not: MongoDB would read it as an
/// operator, so it is refused rather than sent.
fn field_name(expr: &Expr) -> Result<String, DbError> {
    match peel(expr) {
        Expr::Identifier(ident) => {
            let name = ident.value.clone();
            if name.trim().is_empty() {
                return Err(unsupported("an empty column name"));
            }
            if name.starts_with('$') {
                return Err(unsupported(
                    "a column name beginning with `$` (MongoDB would read it as an operator, not \
                     a field)",
                ));
            }
            Ok(name)
        }
        other => Err(unsupported(&format!(
            "{} in a WHERE comparison",
            describe(other)
        ))),
    }
}

/// A literal, or an error naming whatever was there instead.
///
/// Integers are **always** [`Bson::Int64`]. One rule rather than "int32 when it fits", because
/// MongoDB compares Int32 / Int64 / Double inside a single numeric bracket — an Int64 filter value
/// matches an Int32 stored value — so a width-picking branch could only ever be a source of
/// surprise, never of correctness.
fn literal(expr: &Expr) -> Result<Bson, DbError> {
    match peel(expr) {
        Expr::Value(value) => value_to_bson(&value.value),
        // `-5` arrives as a unary minus over a positive number, and a leading `+` is legal too.
        Expr::UnaryOp {
            op: op @ (UnaryOperator::Minus | UnaryOperator::Plus),
            expr: inner,
        } => match peel(inner) {
            Expr::Value(value) => match &value.value {
                Value::Number(text, _) => {
                    let signed = match op {
                        UnaryOperator::Minus => format!("-{text}"),
                        _ => text.clone(),
                    };
                    number_to_bson(&signed)
                }
                other => Err(unsupported(&format!(
                    "the literal `{op}{other}` (a sign is only understood in front of a number)"
                ))),
            },
            other => Err(unsupported(&format!(
                "the unary operator `{op}` applied to {}",
                describe(other)
            ))),
        },
        other => Err(unsupported(&format!(
            "{} where a literal was expected",
            describe(other)
        ))),
    }
}

/// A literal that is not NULL, for the clauses where a NULL bound would silently change the query.
fn non_null_literal(expr: &Expr, clause: &str) -> Result<Bson, DbError> {
    let value = literal(expr)?;
    if value == Bson::Null {
        return Err(unsupported(&format!(
            "NULL as a bound of {clause} (in SQL that never matches; MongoDB's `$gte`/`$lte` \
             against null would match null and absent fields)"
        )));
    }
    Ok(value)
}

fn value_to_bson(value: &Value) -> Result<Bson, DbError> {
    match value {
        Value::Number(text, _) => number_to_bson(text),
        Value::SingleQuotedString(s) | Value::DoubleQuotedString(s) => Ok(Bson::String(s.clone())),
        Value::Boolean(b) => Ok(Bson::Boolean(*b)),
        Value::Null => Ok(Bson::Null),
        Value::Placeholder(p) => Err(unsupported(&format!(
            "the placeholder `{p}` (this console has nothing to bind it to)"
        ))),
        other => Err(unsupported(&format!(
            "the literal `{other}` (only strings, numbers, TRUE/FALSE and NULL are understood)"
        ))),
    }
}

fn number_to_bson(text: &str) -> Result<Bson, DbError> {
    if let Ok(n) = text.parse::<i64>() {
        return Ok(Bson::Int64(n));
    }
    match text.parse::<f64>() {
        Ok(n) if n.is_finite() => Ok(Bson::Double(n)),
        _ => Err(unsupported(&format!(
            "the number `{text}` (it does not fit a 64-bit integer or a finite double)"
        ))),
    }
}

/* ────────────────────────────── LIKE → $regex ────────────────────────────── */

/// Every character PCRE gives a meaning to outside a character class.
///
/// Escaped by an explicit list rather than "escape everything non-alphanumeric": in PCRE a
/// backslash before a *letter* is a special escape (`\d`, `\A`, `\Q`), so a blunt rule would turn
/// a non-ASCII literal into something else entirely.
const REGEX_META: &[char] = &[
    '\\', '^', '$', '.', '|', '?', '*', '+', '(', ')', '[', ']', '{', '}',
];

/// SQL `LIKE` pattern → an anchored PCRE pattern with the same meaning.
///
/// * `%` → `.*`, `_` → `.`, and **every other character is a literal**, escaped when PCRE would
///   otherwise read it as syntax. This is the half that matters: `LIKE '50%_off'` must stay a
///   match on "50", then anything, then one character, then "off" — and `LIKE 'a.b'` must NOT
///   become a pattern where `.` matches any character.
/// * Anchored `^…$`, because SQL's `LIKE` matches the **whole** value while a MongoDB `$regex`
///   searches anywhere in it. Without the anchors `LIKE 'abc'` would match `"xabcx"`.
/// * The caller pairs this with the `s` option so `.` matches a newline, which is what SQL's `_`
///   and `%` do.
///
/// **The one divergence, stated rather than hidden:** PCRE's `$` also matches immediately before a
/// trailing newline, so `LIKE 'ab'` matches the value `"ab\n"` here and would not in SQL. Every
/// alternative (`\z`) tracks that for a pattern most people cannot read; the case is vanishingly
/// rare in a document store and this comment is the record of the choice.
fn like_to_regex(pattern: &str) -> String {
    let mut out = String::with_capacity(pattern.len() + 8);
    out.push('^');
    for ch in pattern.chars() {
        match ch {
            '%' => out.push_str(".*"),
            '_' => out.push('.'),
            c => {
                if REGEX_META.contains(&c) {
                    out.push('\\');
                }
                out.push(c);
            }
        }
    }
    out.push('$');
    out
}

/* ────────────────────────────── naming things ────────────────────────────── */

/// The refusal. **Every** one of them names the construct, because a refusal that does not is just
/// a wall.
fn unsupported(construct: &str) -> DbError {
    DbError::invalid_statement(format!(
        "This console translates only `SELECT * FROM [database.]collection [WHERE …] [LIMIT n]` \
         into a MongoDB command, and {construct} is not part of that. Nothing was sent: guessing a \
         translation would run a DIFFERENT query and hand back wrong data with no error at all. \
         Write the command document instead — e.g. {{\"find\": \"tracks\", \"limit\": 10}}."
    ))
}

fn map_parse_error(error: ParserError) -> DbError {
    match error {
        ParserError::RecursionLimitExceeded => DbError::invalid_statement(format!(
            "That statement is nested more deeply than {MAX_PARSE_DEPTH} levels, and this \
             translator refuses to follow it that far. Nothing was parsed."
        )),
        other => DbError::invalid_statement(format!(
            "That is not SQL this console can read. ({other}) It translates \
             `SELECT * FROM [database.]collection [WHERE …] [LIMIT n]`, and nothing else."
        )),
    }
}

/// Strip redundant parentheses. Grouping changes no meaning, so peeling it lets every match below
/// be written once instead of once per nesting depth.
fn peel(expr: &Expr) -> &Expr {
    let mut current = expr;
    while let Expr::Nested(inner) = current {
        current = inner;
    }
    current
}

/// A short, human name for whatever this expression is — the thing the refusal message quotes.
fn describe(expr: &Expr) -> String {
    match peel(expr) {
        Expr::Identifier(ident) => format!("the column `{}`", ident.value),
        Expr::CompoundIdentifier(parts) => format!(
            "the qualified column name `{}`",
            parts
                .iter()
                .map(|p| p.value.as_str())
                .collect::<Vec<_>>()
                .join(".")
        ),
        Expr::Function(function) => format!("the function `{}`", function.name),
        Expr::Subquery(_) => "a subquery".to_string(),
        Expr::InSubquery { .. } => "an IN subquery".to_string(),
        Expr::Exists { .. } => "an EXISTS subquery".to_string(),
        Expr::ILike { .. } => "ILIKE".to_string(),
        Expr::SimilarTo { .. } => "SIMILAR TO".to_string(),
        Expr::RLike { .. } => "RLIKE".to_string(),
        Expr::AnyOp { .. } => "ANY".to_string(),
        Expr::AllOp { .. } => "ALL".to_string(),
        Expr::Case { .. } => "CASE".to_string(),
        Expr::Cast { .. } => "CAST".to_string(),
        Expr::Convert { .. } => "CONVERT".to_string(),
        Expr::Extract { .. } => "EXTRACT".to_string(),
        Expr::Substring { .. } => "SUBSTRING".to_string(),
        Expr::Position { .. } => "POSITION".to_string(),
        Expr::Trim { .. } => "TRIM".to_string(),
        Expr::Collate { .. } => "COLLATE".to_string(),
        Expr::Interval(_) => "INTERVAL".to_string(),
        Expr::IsTrue(_) | Expr::IsNotTrue(_) => "IS TRUE / IS NOT TRUE".to_string(),
        Expr::IsFalse(_) | Expr::IsNotFalse(_) => "IS FALSE / IS NOT FALSE".to_string(),
        Expr::IsUnknown(_) | Expr::IsNotUnknown(_) => "IS UNKNOWN".to_string(),
        Expr::IsDistinctFrom(..) | Expr::IsNotDistinctFrom(..) => "IS DISTINCT FROM".to_string(),
        Expr::InUnnest { .. } => "IN UNNEST".to_string(),
        Expr::Array(_) => "an array literal".to_string(),
        Expr::Tuple(_) => "a tuple".to_string(),
        Expr::Struct { .. } => "a struct literal".to_string(),
        Expr::Map(_) => "a map literal".to_string(),
        Expr::Dictionary(_) => "a dictionary literal".to_string(),
        Expr::JsonAccess { .. } => "a JSON access operator".to_string(),
        Expr::CompoundFieldAccess { .. } => "a compound field access".to_string(),
        Expr::MatchAgainst { .. } => "MATCH … AGAINST".to_string(),
        Expr::BinaryOp { op, .. } => format!("the operator `{op}`"),
        Expr::UnaryOp { op, .. } => format!("the unary operator `{op}`"),
        Expr::Value(value) => match &value.value {
            Value::Placeholder(p) => format!("the placeholder `{p}`"),
            other => format!("the literal `{}`", snippet(&other.to_string())),
        },
        other => format!("`{}`", snippet(&other.to_string())),
    }
}

/// The first word of the statement, for naming a non-SELECT by what the user actually typed. Kept
/// short and stripped of anything that is not a letter, so a hostile input cannot smuggle a
/// sentence into an error message.
fn leading_word(sql: &str) -> String {
    let word: String = sql
        .chars()
        .skip_while(|c| c.is_whitespace())
        .take_while(|c| c.is_alphanumeric() || *c == '_')
        .take(24)
        .collect();
    if word.is_empty() {
        "unrecognised".to_string()
    } else {
        word.to_uppercase()
    }
}

fn snippet(text: &str) -> String {
    let count = text.chars().count();
    if count <= 40 {
        return text.to_string();
    }
    let head: String = text.chars().take(39).collect();
    format!("{head}…")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Translate, or panic with the refusal — for the cases that must succeed.
    fn ok(sql: &str) -> Translated {
        translate(sql).unwrap_or_else(|e| panic!("{sql}\n  refused: {}", e.message))
    }

    /// Refuse, or panic with the command it wrongly produced.
    fn refused(sql: &str) -> DbError {
        match translate(sql) {
            Err(e) => e,
            Ok(t) => panic!(
                "{sql}\n  was translated instead of refused: {:?}",
                t.command
            ),
        }
    }

    /* ───────────────────────── the motivating query ───────────────────────── */

    /// 🔴 **The example from the module docs**, the query this module exists for. The expectation
    /// is hand-built with `doc!` — never derived from the translator, because an expectation
    /// computed from the code under test proves only that the plumbing runs.
    #[test]
    fn the_motivating_query_becomes_a_find_on_the_qualified_database() {
        let translated = ok("select * from ARCHIVEDB.temp_playlists LIMIT 10;");
        assert_eq!(
            translated.command,
            doc! { "find": "temp_playlists", "limit": 10_i64 }
        );
        assert_eq!(translated.database.as_deref(), Some("ARCHIVEDB"));
        assert!(
            translated.notices.is_empty(),
            "nothing was lost here: {:?}",
            translated.notices
        );
        // The command name has to be the FIRST key or MongoDB reads a different command entirely.
        assert_eq!(
            translated.command.keys().collect::<Vec<_>>(),
            vec!["find", "limit"]
        );
    }

    #[test]
    fn an_unqualified_from_leaves_the_database_to_the_session() {
        let translated = ok("SELECT * FROM temp_playlists");
        assert_eq!(translated.command, doc! { "find": "temp_playlists" });
        assert_eq!(translated.database, None);
    }

    /// Keywords are case-insensitive; identifiers are **not** touched. MongoDB collection names are
    /// case-sensitive and the example database is `ARCHIVEDB`, so folding either would send the
    /// query somewhere that does not exist.
    #[test]
    fn keywords_are_case_insensitive_and_identifiers_survive_verbatim() {
        for sql in [
            "select * from ARCHIVEDB.Temp_Playlists",
            "SELECT * FROM ARCHIVEDB.Temp_Playlists",
            "SeLeCt * FrOm ARCHIVEDB.Temp_Playlists",
        ] {
            let translated = ok(sql);
            assert_eq!(
                translated.command,
                doc! { "find": "Temp_Playlists" },
                "{sql}"
            );
            assert_eq!(translated.database.as_deref(), Some("ARCHIVEDB"), "{sql}");
        }
        // Quoted identifiers keep their text and lose only the quotes.
        let translated = ok(r#"SELECT * FROM "My DB"."My Coll" WHERE "First Name" = 'Ada'"#);
        assert_eq!(
            translated.command,
            doc! { "find": "My Coll", "filter": { "First Name": "Ada" } }
        );
        assert_eq!(translated.database.as_deref(), Some("My DB"));
    }

    /* ───────────────────────── the WHERE operator set ───────────────────────── */

    /// Every supported operator, against a **hand-written** expected document. The table is the
    /// spec; the expectations are literals, not anything the translator computed.
    #[test]
    fn each_supported_operator_becomes_the_document_written_here_by_hand() {
        let cases: &[(&str, Document)] = &[
            ("title = 'Amberline'", doc! { "title": "Amberline" }),
            ("duration = 5", doc! { "duration": 5_i64 }),
            ("tempo = 96.25", doc! { "tempo": 96.25_f64 }),
            ("ok = TRUE", doc! { "ok": true }),
            ("duration != 5", doc! { "duration": { "$ne": 5_i64 } }),
            ("duration <> 5", doc! { "duration": { "$ne": 5_i64 } }),
            ("duration < 5", doc! { "duration": { "$lt": 5_i64 } }),
            ("duration <= 5", doc! { "duration": { "$lte": 5_i64 } }),
            ("duration > 5", doc! { "duration": { "$gt": 5_i64 } }),
            ("duration >= 5", doc! { "duration": { "$gte": 5_i64 } }),
            ("duration = -5", doc! { "duration": -5_i64 }),
            (
                "title IN ('Amberline', 'Bluewater')",
                doc! { "title": { "$in": ["Amberline", "Bluewater"] } },
            ),
            (
                "title NOT IN ('Amberline')",
                doc! { "title": { "$nin": ["Amberline"] } },
            ),
            ("tag IS NULL", doc! { "tag": Bson::Null }),
            ("tag IS NOT NULL", doc! { "tag": { "$ne": Bson::Null } }),
            (
                "duration BETWEEN 1 AND 10",
                doc! { "duration": { "$gte": 1_i64, "$lte": 10_i64 } },
            ),
            (
                "duration NOT BETWEEN 1 AND 10",
                doc! { "$nor": [ { "duration": { "$gte": 1_i64, "$lte": 10_i64 } } ] },
            ),
            (
                "title LIKE 'Amb%'",
                doc! { "title": { "$regex": "^Amb.*$", "$options": "s" } },
            ),
            (
                "title NOT LIKE 'Amb%'",
                doc! { "$nor": [ { "title": { "$regex": "^Amb.*$", "$options": "s" } } ] },
            ),
            (
                "a = 1 AND b = 2",
                doc! { "$and": [ { "a": 1_i64 }, { "b": 2_i64 } ] },
            ),
            (
                "a = 1 OR b = 2",
                doc! { "$or": [ { "a": 1_i64 }, { "b": 2_i64 } ] },
            ),
            ("NOT a = 1", doc! { "$nor": [ { "a": 1_i64 } ] }),
        ];
        for (where_clause, expected) in cases {
            let translated = ok(&format!("SELECT * FROM t WHERE {where_clause}"));
            assert_eq!(
                translated.command,
                doc! { "find": "t", "filter": expected.clone() },
                "WHERE {where_clause}"
            );
        }
    }

    /// A literal on the LEFT is ordinary SQL, and flipping the operator is exact arithmetic rather
    /// than a guess — so it is supported, and the direction is pinned here because getting it
    /// backwards is the obvious way to be silently wrong.
    #[test]
    fn a_literal_on_the_left_flips_the_operator_rather_than_the_meaning() {
        let cases: &[(&str, Document)] = &[
            ("5 < duration", doc! { "duration": { "$gt": 5_i64 } }),
            ("5 <= duration", doc! { "duration": { "$gte": 5_i64 } }),
            ("5 > duration", doc! { "duration": { "$lt": 5_i64 } }),
            ("5 >= duration", doc! { "duration": { "$lte": 5_i64 } }),
            ("5 = duration", doc! { "duration": 5_i64 }),
            ("5 != duration", doc! { "duration": { "$ne": 5_i64 } }),
        ];
        for (where_clause, expected) in cases {
            let translated = ok(&format!("SELECT * FROM t WHERE {where_clause}"));
            assert_eq!(
                translated.command.get_document("filter").expect("a filter"),
                expected,
                "WHERE {where_clause}"
            );
        }
    }

    /// `a AND b AND c` is one `$and` of three, not a nest of two — and parentheses group without
    /// changing the meaning.
    #[test]
    fn and_and_or_chains_flatten_and_parentheses_group() {
        let translated = ok("SELECT * FROM t WHERE a = 1 AND b = 2 AND c = 3");
        assert_eq!(
            translated.command.get_document("filter").expect("a filter"),
            &doc! { "$and": [ { "a": 1_i64 }, { "b": 2_i64 }, { "c": 3_i64 } ] }
        );

        let translated = ok("SELECT * FROM t WHERE (a = 1 AND b = 2) OR c = 3");
        assert_eq!(
            translated.command.get_document("filter").expect("a filter"),
            &doc! { "$or": [ { "$and": [ { "a": 1_i64 }, { "b": 2_i64 } ] }, { "c": 3_i64 } ] }
        );
    }

    /// A quoted identifier with a dot addresses a **nested** field in MongoDB. That is a feature,
    /// and it is left alone — while `a.b` written unquoted is a *qualified column* to SQL and is
    /// refused, because the two mean different things and only one of them was typed.
    #[test]
    fn a_quoted_dotted_name_is_a_nested_path_while_an_unquoted_one_is_a_qualified_column() {
        let translated = ok(r#"SELECT * FROM t WHERE "mix.gain" = 0.25"#);
        assert_eq!(
            translated.command.get_document("filter").expect("a filter"),
            &doc! { "mix.gain": 0.25_f64 }
        );
        let message = refused("SELECT * FROM t WHERE mix.gain = 0.25").message;
        assert!(message.contains("qualified column name"), "{message}");
    }

    /* ───────────────────────── LIKE → $regex ───────────────────────── */

    /// 🔴 **The escaping is the whole point.** A `LIKE` whose literal contains regex syntax must not
    /// become a different query, and the pattern is anchored because SQL's `LIKE` matches the whole
    /// value while a `$regex` searches anywhere inside it. Exact strings, written by hand.
    #[test]
    fn like_becomes_an_anchored_regex_with_every_metacharacter_escaped() {
        let cases: &[(&str, &str)] = &[
            // The everyday case: `%` and `_` are the WILDCARDS, everything else is literal.
            ("50%_off", "^50.*.off$"),
            // No wildcards at all — an exact match, which is why the anchors have to be there.
            ("abc", "^abc$"),
            ("a%", "^a.*$"),
            ("%a", "^.*a$"),
            ("%a%", "^.*a.*$"),
            ("a_c", "^a.c$"),
            // Every PCRE metacharacter, escaped one by one.
            ("a.b", r"^a\.b$"),
            ("a+b", r"^a\+b$"),
            ("a*b", r"^a\*b$"),
            ("a?b", r"^a\?b$"),
            ("a|b", r"^a\|b$"),
            ("a^b", r"^a\^b$"),
            ("a$b", r"^a\$b$"),
            (r"a\b", r"^a\\b$"),
            ("a(b)c", r"^a\(b\)c$"),
            ("a[b]c", r"^a\[b\]c$"),
            ("a{2}b", r"^a\{2\}b$"),
            // A pattern that is entirely regex syntax must stay entirely literal.
            (".*", r"^\.\*$"),
            // Non-ASCII is never backslash-escaped: `\é` is not a PCRE escape.
            ("café", "^café$"),
        ];
        for (pattern, expected) in cases {
            assert_eq!(&like_to_regex(pattern), expected, "LIKE '{pattern}'");
        }
    }

    /// …and the same, through the whole translator, so the escaping is not merely a private helper
    /// that the real path bypasses (test the thing, not a name).
    #[test]
    fn a_like_with_regex_syntax_in_it_reaches_the_command_escaped() {
        let translated = ok("SELECT * FROM t WHERE label LIKE '50%_off'");
        assert_eq!(
            translated.command.get_document("filter").expect("a filter"),
            &doc! { "label": { "$regex": "^50.*.off$", "$options": "s" } }
        );
        // The `.` in a literal dot must be escaped, or `a.b` would match `axb`.
        let translated = ok(r"SELECT * FROM t WHERE host LIKE 'a.b'");
        assert_eq!(
            translated.command.get_document("filter").expect("a filter"),
            &doc! { "host": { "$regex": r"^a\.b$", "$options": "s" } }
        );
    }

    /* ───────────────────────── the notices ───────────────────────── */

    /// `{"tag": null}` matches a null value **and a missing field**. That is a real difference from
    /// SQL, and the discipline is that the loss goes in the OUTPUT — not in a design note.
    #[test]
    fn is_null_carries_a_notice_that_names_the_field_and_the_difference() {
        let translated = ok("SELECT * FROM t WHERE tag IS NULL");
        assert_eq!(
            translated.command.get_document("filter").expect("a filter"),
            &doc! { "tag": Bson::Null }
        );
        assert_eq!(translated.notices.len(), 1, "{:?}", translated.notices);
        let notice = &translated.notices[0];
        assert!(notice.contains("tag"), "{notice}");
        assert!(notice.contains("absent"), "{notice}");

        // `IS NOT NULL` is `$ne: null`, which excludes both null AND missing — the SQL meaning —
        // so it must NOT carry the notice. The control that proves the notice is about the
        // asymmetry and not about the word "null" appearing anywhere.
        let translated = ok("SELECT * FROM t WHERE tag IS NOT NULL");
        assert!(translated.notices.is_empty(), "{:?}", translated.notices);
    }

    /// Every negative operator shares one notice, pushed **once** no matter how many there are —
    /// a warning repeated five times is a warning nobody reads.
    #[test]
    fn negative_operators_carry_exactly_one_shared_notice() {
        for where_clause in [
            "a != 1",
            "a <> 1",
            "a NOT IN (1, 2)",
            "a NOT LIKE 'x%'",
            "a NOT BETWEEN 1 AND 2",
            "NOT a = 1",
        ] {
            let translated = ok(&format!("SELECT * FROM t WHERE {where_clause}"));
            assert_eq!(
                translated.notices.len(),
                1,
                "{where_clause}: {:?}",
                translated.notices
            );
            assert!(
                translated.notices[0].contains("ABSENT"),
                "{where_clause}: {}",
                translated.notices[0]
            );
        }
        // Four negatives in one statement, still one notice.
        let translated =
            ok("SELECT * FROM t WHERE a != 1 AND b NOT IN (2) AND c NOT LIKE 'x' AND NOT d = 4");
        assert_eq!(translated.notices.len(), 1, "{:?}", translated.notices);

        // …and a statement with no negation has none at all, which is what makes the notice
        // informative rather than decoration.
        let translated = ok("SELECT * FROM t WHERE a = 1 AND b > 2");
        assert!(translated.notices.is_empty(), "{:?}", translated.notices);
    }

    /* ───────────────────────── LIMIT ───────────────────────── */

    #[test]
    fn limit_becomes_an_int64_and_the_two_traps_are_refused_by_name() {
        assert_eq!(
            ok("SELECT * FROM t LIMIT 1").command,
            doc! { "find": "t", "limit": 1_i64 }
        );
        assert_eq!(
            ok("SELECT * FROM t LIMIT 9007199254740993").command,
            doc! { "find": "t", "limit": 9_007_199_254_740_993_i64 },
            "a limit past 2^53 must not go through a double"
        );

        // 🔴 `LIMIT 0` means NO ROWS in SQL and NO LIMIT in MongoDB. Translating it would turn
        // "show me nothing" into "show me the whole collection".
        let message = refused("SELECT * FROM t LIMIT 0").message;
        assert!(message.contains("LIMIT 0"), "{message}");
        assert!(message.contains("NO LIMIT"), "{message}");

        let message = refused("SELECT * FROM t LIMIT 1.5").message;
        assert!(message.contains("whole number"), "{message}");
    }

    /// `LIMIT ALL` means "no limit", and that is exactly what an absent `limit` key is — so it is
    /// translated rather than refused. Pinned because the mechanism is surprising and nothing in
    /// our code produces it: `sqlparser` folds a bare `LIMIT ALL` into **no limit clause at all**,
    /// so this test is the record that the behaviour was measured rather than assumed.
    #[test]
    fn limit_all_means_no_limit_which_is_an_absent_limit_key() {
        assert_eq!(
            ok("SELECT * FROM t LIMIT ALL").command,
            doc! { "find": "t" }
        );
    }

    /* ───────────────────────── the refusals ───────────────────────── */

    /// 🔴 **One row per construct that is not in the subset, and the message must NAME it.**
    ///
    /// The needles are hand-written literals; nothing here is derived from the code that produces
    /// the message. A refusal that does not name the construct is a wall, and a translation that
    /// guessed instead of refusing is the failure this whole module is built to avoid.
    #[test]
    fn every_unsupported_construct_is_refused_by_name() {
        let cases: &[(&str, &str)] = &[
            // ── the narrowed scope ──
            ("SELECT id, title FROM t", "column list"),
            ("SELECT title FROM t", "column list"),
            ("SELECT COUNT(*) FROM t", "COUNT"),
            ("SELECT count(*) FROM t", "count"),
            ("SELECT MAX(tempo) FROM t", "MAX"),
            ("SELECT * FROM t ORDER BY title", "ORDER BY"),
            ("SELECT * FROM t ORDER BY title DESC LIMIT 10", "ORDER BY"),
            ("SELECT * FROM t LIMIT 10 OFFSET 5", "OFFSET"),
            ("SELECT * FROM t OFFSET 5", "OFFSET"),
            ("SELECT * FROM t LIMIT 5, 10", "LIMIT <offset>, <count>"),
            ("SELECT * FROM t LIMIT ALL OFFSET 5", "OFFSET"),
            ("SELECT t.* FROM t", "qualified wildcard"),
            ("SELECT title AS name FROM t", "alias"),
            // ── the joins, sets and subqueries ──
            ("SELECT * FROM a JOIN b ON a.id = b.id", "JOIN"),
            ("SELECT * FROM a LEFT JOIN b ON a.id = b.id", "JOIN"),
            ("SELECT * FROM a, b", "JOIN"),
            ("SELECT * FROM a UNION SELECT * FROM b", "UNION"),
            ("SELECT * FROM a INTERSECT SELECT * FROM b", "INTERSECT"),
            ("SELECT * FROM a EXCEPT SELECT * FROM b", "EXCEPT"),
            ("SELECT * FROM (SELECT * FROM t) x", "subquery"),
            ("SELECT * FROM t WHERE id IN (SELECT id FROM u)", "subquery"),
            ("SELECT * FROM t WHERE EXISTS (SELECT 1 FROM u)", "subquery"),
            ("SELECT * FROM t WHERE id = (SELECT 1)", "subquery"),
            ("WITH x AS (SELECT * FROM t) SELECT * FROM x", "WITH"),
            // ── the aggregate shape ──
            ("SELECT * FROM t GROUP BY title", "GROUP BY"),
            ("SELECT * FROM t HAVING title = 'x'", "HAVING"),
            ("SELECT DISTINCT * FROM t", "DISTINCT"),
            // ── aliases and qualified names ──
            ("SELECT * FROM t AS x", "table alias"),
            ("SELECT * FROM t x", "table alias"),
            (
                "SELECT * FROM t WHERE t.title = 'x'",
                "qualified column name",
            ),
            // ── not a SELECT at all ──
            ("INSERT INTO t VALUES (1)", "INSERT"),
            ("UPDATE t SET a = 1", "UPDATE"),
            ("DELETE FROM t", "DELETE"),
            ("DROP TABLE t", "DROP"),
            ("CREATE TABLE t (a INT)", "CREATE"),
            ("TRUNCATE TABLE t", "TRUNCATE"),
            ("SHOW TABLES", "SHOW"),
            // ── more than one of them ──
            (
                "SELECT * FROM t; SELECT * FROM u",
                "more than one statement",
            ),
            // ── expressions the WHERE clause does not take ──
            ("SELECT * FROM t WHERE a = b", "both sides"),
            ("SELECT * FROM t WHERE a + 1 = 2", "the operator `+`"),
            ("SELECT * FROM t WHERE 1 = 1", "two literals"),
            (
                "SELECT * FROM t WHERE UPPER(a) = 'X'",
                "the function `UPPER`",
            ),
            ("SELECT * FROM t WHERE a ILIKE 'x%'", "ILIKE"),
            ("SELECT * FROM t WHERE a SIMILAR TO 'x'", "SIMILAR TO"),
            ("SELECT * FROM t WHERE a IS TRUE", "IS TRUE"),
            (
                "SELECT * FROM t WHERE a IS DISTINCT FROM 1",
                "IS DISTINCT FROM",
            ),
            ("SELECT * FROM t WHERE CAST(a AS INT) = 1", "CAST"),
            (
                "SELECT * FROM t WHERE a = CASE WHEN b THEN 1 ELSE 2 END",
                "CASE",
            ),
            ("SELECT * FROM t WHERE a LIKE 'x' ESCAPE '!'", "ESCAPE"),
            ("SELECT * FROM t WHERE a = ?", "placeholder"),
            ("SELECT * FROM t WHERE a LIKE 5", "string literal"),
            // ── the NULL traps: SQL matches nothing, MongoDB would match plenty ──
            ("SELECT * FROM t WHERE a = NULL", "NULL"),
            ("SELECT * FROM t WHERE a != NULL", "NULL"),
            ("SELECT * FROM t WHERE a IN (1, NULL)", "NULL"),
            ("SELECT * FROM t WHERE a BETWEEN NULL AND 2", "NULL"),
            // ── names MongoDB would read as something else ──
            (
                r#"SELECT * FROM t WHERE "$where" = 1"#,
                "beginning with `$`",
            ),
            (r#"SELECT * FROM "$cmd""#, "beginning with `$`"),
            ("SELECT * FROM a.b.c", "3 parts"),
            // ── not SQL at all ──
            ("{\"find\": \"tracks\"}", "not SQL this console can read"),
            ("select * from", "not SQL this console can read"),
        ];
        for (sql, needle) in cases {
            let error = refused(sql);
            assert_eq!(
                error.code,
                crate::db::error::DbErrorCode::InvalidStatement,
                "{sql}"
            );
            assert!(
                error.message.contains(needle),
                "{sql}\n  message does not name {needle:?}:\n  {}",
                error.message
            );
        }
    }

    /// An empty run is not a refusal about a construct — it is nothing to do.
    #[test]
    fn empty_input_says_there_is_nothing_to_translate() {
        for sql in ["", "   ", "\n\t "] {
            let error = refused(sql);
            assert_eq!(error.message, "There is nothing to translate.");
        }
        // A lone `;` parses to zero statements rather than failing, and lands on the same sentence.
        assert_eq!(refused(";").message, "There is nothing to translate.");
    }

    /* ───────────────────────── the bounds ───────────────────────── */

    /// 🔴 `recursive-protection` is deliberately OFF (it would pull a vendored stack-probing
    /// dependency for a console feature), so absurd input has to be refused by a bound rather than
    /// survived by a stack guard. Both bounds are exercised here.
    #[test]
    fn absurdly_long_input_is_refused_before_it_is_ever_parsed() {
        // Valid SQL, just far too much of it: a legal `IN` list of 30 000 characters.
        let ids = (0..6_000)
            .map(|n| n.to_string())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!("SELECT * FROM t WHERE id IN ({ids})");
        assert!(sql.chars().count() > MAX_SQL_CHARS, "{}", sql.len());
        let message = refused(&sql).message;
        assert!(message.contains("characters long"), "{message}");
        assert!(
            message.contains(&MAX_SQL_CHARS.to_string()),
            "the message must say the bound: {message}"
        );

        // The control: the same shape just under the cap is translated, so the
        // refusal above is the CAP firing and not "long IN lists never work".
        let ids = (0..500)
            .map(|n| n.to_string())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!("SELECT * FROM t WHERE id IN ({ids})");
        assert!(sql.chars().count() < MAX_SQL_CHARS);
        let translated = ok(&sql);
        let values = translated
            .command
            .get_document("filter")
            .and_then(|f| f.get_document("id"))
            .and_then(|i| i.get_array("$in"))
            .expect("an $in list");
        assert_eq!(values.len(), 500);
    }

    #[test]
    fn deeply_nested_sql_is_refused_by_the_depth_bound_rather_than_crashing() {
        let depth = 200;
        let sql = format!(
            "SELECT * FROM t WHERE {}a = 1{}",
            "(".repeat(depth),
            ")".repeat(depth)
        );
        assert!(
            sql.chars().count() < MAX_SQL_CHARS,
            "the LENGTH cap must not be what fires here"
        );
        let message = refused(&sql).message;
        assert!(message.contains("nested more deeply"), "{message}");
        assert!(
            message.contains(&MAX_PARSE_DEPTH.to_string()),
            "the message must say the bound: {message}"
        );
    }

    /// The other half of the bound: it must not bite anything a person would actually type.
    #[test]
    fn a_realistic_where_clause_is_nowhere_near_the_depth_bound() {
        let translated = ok("SELECT * FROM ARCHIVEDB.temp_playlists \
             WHERE (status = 'active' AND booking >= 100) \
                OR (status = 'pending' AND created_at > '2026-01-01' AND tag IS NULL) \
                OR (owner IN ('a', 'b', 'c') AND label LIKE 'vip-%' AND NOT locked = TRUE) \
             LIMIT 25");
        assert_eq!(
            translated.command.get_i64("limit").ok(),
            Some(25),
            "{:?}",
            translated.command
        );
        assert_eq!(translated.database.as_deref(), Some("ARCHIVEDB"));
        assert_eq!(translated.notices.len(), 2, "{:?}", translated.notices);
    }

    /* ───────────────────────── the emitted shape ───────────────────────── */

    /// The shape is only ever `{"find": …, "filter"?, "limit"?}` — no `projection`, no `sort`, no
    /// `skip`, no `count`. Asserted as a whole document so a stray key cannot slip in unnoticed.
    #[test]
    fn the_command_is_only_ever_find_filter_limit() {
        let translated =
            ok("SELECT * FROM ARCHIVEDB.temp_playlists WHERE title = 'Amberline' LIMIT 10");
        assert_eq!(
            translated.command,
            doc! {
                "find": "temp_playlists",
                "filter": { "title": "Amberline" },
                "limit": 10_i64,
            }
        );
        assert_eq!(
            translated.command.keys().collect::<Vec<_>>(),
            vec!["find", "filter", "limit"],
            "the command name must come first, and nothing else may appear"
        );
        // No WHERE, no LIMIT: the two optional keys are genuinely absent, not empty.
        let translated = ok("SELECT * FROM t");
        assert_eq!(translated.command, doc! { "find": "t" });
    }

    /// `_id` gets no special treatment: real ids are often UUID **strings**, and a translator
    /// that turned them into ObjectIds would match nothing while looking like it worked.
    #[test]
    fn id_values_keep_the_type_the_sql_gave_them() {
        let translated = ok("SELECT * FROM t WHERE _id = '018f3a2b-0000-7000-8000-000000000001'");
        assert_eq!(
            translated.command.get_document("filter").expect("a filter"),
            &doc! { "_id": "018f3a2b-0000-7000-8000-000000000001" }
        );
        let translated = ok("SELECT * FROM t WHERE _id = 7");
        assert_eq!(
            translated.command.get_document("filter").expect("a filter"),
            &doc! { "_id": 7_i64 }
        );
    }

    /// A trailing semicolon is one statement, not two — the motivating query has one.
    #[test]
    fn a_trailing_semicolon_is_not_a_second_statement() {
        assert_eq!(ok("SELECT * FROM t;").command, doc! { "find": "t" });
        assert_eq!(ok("SELECT * FROM t ;  ").command, doc! { "find": "t" });
    }
}
