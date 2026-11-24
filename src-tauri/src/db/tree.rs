//! The connection tree's wire types — what `db_children` returns.
//!
//! Deliberately shaped like `read_dir`/`FsEntry`: one level per call, each node saying
//! whether it can be expanded further. The Files tree already works this way, so the frontend's
//! lazy-expand, cache and error-note behaviour is a pattern that exists rather than one invented
//! here.
//!
//! ## Why there is no `hierarchy` table on `EngineSpec`
//!
//! A `hierarchy: &[NodeLevel]` field was considered so a descriptor could declare
//! "database → schema → tables". It is **not** implemented, on purpose: the levels an engine has
//! are decided by the code that walks them ([`crate::db::engine::DbSession::children`]), and a
//! data table beside that code is a second source of truth that can disagree with it. The tree is
//! driven entirely by what `children` returns plus each node's `expandable` flag, so an engine
//! whose shape differs — and they all differ — cannot get out of step with its own descriptor.
//!
//! ## The engines genuinely differ, and Postgres is the odd one
//!
//! * **MySQL / ClickHouse** — one connection can see every database on the server, so the root
//!   lists databases and each expands into its tables.
//! * **PostgreSQL** — a connection is bound to ONE database and cannot read another's catalog.
//!   Listing every database from `pg_database` would produce nodes that fail when expanded, so
//!   the root shows the connected database only, and says so in its sub-label.

use serde::{Deserialize, Serialize};

/// Which node in the tree. Mirrors a filesystem path: enough to fetch this node's children
/// without server-side cursor state, because the webview may ask in any order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DbNodeRef {
    /// The connection itself — what a first expand asks for.
    Root,
    Database {
        name: String,
    },
    #[serde(rename_all = "camelCase")]
    Schema {
        database: String,
        name: String,
    },
    /// A folder of same-kind children ("Tables", "Views"). Present so a database with 400 tables
    /// and 3 views does not bury the views.
    #[serde(rename_all = "camelCase")]
    Group {
        database: String,
        /// `None` for engines with no schema level (MySQL, ClickHouse).
        schema: Option<String>,
        group: DbGroup,
    },
    /// A table, view or collection — expands into its columns.
    #[serde(rename_all = "camelCase")]
    Table {
        database: String,
        schema: Option<String>,
        name: String,
    },
    /// The connection's saved queries — "double-click the connection and see the list". Answered by the store, never by the server, so it works with no session.
    SavedQueries,
    /// One saved query. Carries its id because that is what "open this one" needs; a label would
    /// not be enough, since two queries may legitimately share a name.
    SavedQuery {
        id: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DbGroup {
    Tables,
    Views,
    Collections,
    Keys,
}

impl DbGroup {
    /// The label a group node shows. Title case because it is a folder, not a type name.
    pub fn label(self) -> &'static str {
        match self {
            Self::Tables => "Tables",
            Self::Views => "Views",
            Self::Collections => "Collections",
            Self::Keys => "Keys",
        }
    }
}

/// What a node *is*, which drives its icon. Distinct from [`DbNodeRef`] because a `Table` ref can
/// describe a table, a view or a collection, and the icon must differ.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DbNodeKind {
    Database,
    Schema,
    Group,
    Table,
    View,
    Collection,
    Column,
    Key,
    SavedQuery,
}

/// One row in the tree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbNode {
    pub node_ref: DbNodeRef,
    /// What the user reads: `"tracks"`, `"public"`, `"Tables"`.
    pub label: String,
    /// The dim text beside it: `"varchar(64)"`, `"12 tables"`, `"the connected database"`.
    /// `None` when there is nothing true to add — never a filler like `"table"`.
    pub sub_label: Option<String>,
    pub kind: DbNodeKind,
    /// Whether expanding it will call `db_children` again. A column is a leaf; an empty schema is
    /// **still expandable**, because "expand it and find nothing" is the honest answer and
    /// pre-counting every level would cost a query per node just to draw a chevron.
    pub expandable: bool,
}

impl DbNode {
    pub fn new(
        node_ref: DbNodeRef,
        label: impl Into<String>,
        kind: DbNodeKind,
        expandable: bool,
    ) -> Self {
        Self {
            node_ref,
            label: label.into(),
            sub_label: None,
            kind,
            expandable,
        }
    }

    pub fn with_sub_label(mut self, sub: impl Into<String>) -> Self {
        self.sub_label = Some(sub.into());
        self
    }

    /// A column node: a leaf whose sub-label is the server's own type name (shown verbatim).
    pub fn column(
        database: &str,
        schema: Option<&str>,
        table: &str,
        name: &str,
        type_name: &str,
        nullable: bool,
    ) -> Self {
        let _ = (database, schema, table);
        Self {
            // A column has no ref of its own: nothing can be fetched *below* it, and inventing a
            // `Column` variant would add a case every consumer must handle to no purpose. It
            // borrows its table's ref, which is what a double-click would act on anyway.
            node_ref: DbNodeRef::Table {
                database: database.to_string(),
                schema: schema.map(str::to_string),
                name: table.to_string(),
            },
            label: name.to_string(),
            // `NOT NULL` is worth the space: it is the difference between a column that can hold
            // the NULL this whole app is careful about and one that cannot.
            sub_label: Some(if nullable {
                type_name.to_string()
            } else {
                format!("{type_name} · not null")
            }),
            kind: DbNodeKind::Column,
            expandable: false,
        }
    }
}

/// `"12 tables"` / `"1 table"` / `"empty"` — the sub-label for a group or schema.
///
/// Its own function because "1 tables" is the kind of thing that ships, and because `"empty"`
/// reads better than `"0 tables"` on a schema someone is about to create in.
pub fn count_label(n: usize, singular: &str) -> String {
    match n {
        0 => "empty".to_string(),
        1 => format!("1 {singular}"),
        _ => format!("{n} {singular}s"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_wire_shape_is_camel_case_and_tagged_by_kind() {
        // The frontend switches on `kind`, so the tag has to be there and has to be camelCase.
        let json = serde_json::to_value(DbNodeRef::Schema {
            database: "maestro".into(),
            name: "public".into(),
        })
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "kind": "schema", "database": "maestro", "name": "public" })
        );

        let group = serde_json::to_value(DbNodeRef::Group {
            database: "maestro".into(),
            schema: None,
            group: DbGroup::Tables,
        })
        .unwrap();
        assert_eq!(
            group,
            serde_json::json!({
                "kind": "group", "database": "maestro", "schema": null, "group": "tables"
            })
        );
    }

    #[test]
    fn a_node_serialises_with_the_field_names_the_frontend_reads() {
        let node = DbNode::new(
            DbNodeRef::Database {
                name: "maestro".into(),
            },
            "maestro",
            DbNodeKind::Database,
            true,
        )
        .with_sub_label("3 tables");
        let json = serde_json::to_value(&node).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "nodeRef": { "kind": "database", "name": "maestro" },
                "label": "maestro",
                "subLabel": "3 tables",
                "kind": "database",
                "expandable": true,
            })
        );
    }

    #[test]
    fn a_ref_round_trips_so_the_webview_can_send_back_what_it_was_given() {
        // The frontend holds a node's ref and passes it to `db_children` verbatim. If the
        // serialisation were not symmetric, the second level of the tree would fail — and it
        // would fail as a deserialisation error nobody could read.
        for r in [
            DbNodeRef::Root,
            DbNodeRef::SavedQueries,
            DbNodeRef::Database {
                name: "maestro".into(),
            },
            DbNodeRef::Schema {
                database: "maestro".into(),
                name: "public".into(),
            },
            DbNodeRef::Group {
                database: "maestro".into(),
                schema: Some("public".into()),
                group: DbGroup::Views,
            },
            DbNodeRef::Table {
                database: "maestro".into(),
                schema: None,
                name: "tracks".into(),
            },
            DbNodeRef::SavedQuery { id: "Q1".into() },
        ] {
            let text = serde_json::to_string(&r).unwrap();
            let back: DbNodeRef = serde_json::from_str(&text).unwrap();
            assert_eq!(back, r, "{text}");
        }
    }

    #[test]
    fn a_column_reports_the_servers_type_name_and_whether_it_can_be_null() {
        let nullable = DbNode::column(
            "maestro",
            Some("public"),
            "tracks",
            "tag",
            "varchar(64)",
            true,
        );
        assert_eq!(nullable.label, "tag");
        assert_eq!(nullable.sub_label.as_deref(), Some("varchar(64)"));
        assert!(!nullable.expandable, "a column is a leaf");

        // NOT NULL is called out, because it is the difference between a column that can hold the
        // NULL this app distinguishes from '' and one that cannot.
        let required = DbNode::column("maestro", None, "tracks", "id", "int", false);
        assert_eq!(required.sub_label.as_deref(), Some("int · not null"));
    }

    #[test]
    fn count_labels_are_not_written_as_one_tables() {
        assert_eq!(count_label(0, "table"), "empty");
        assert_eq!(count_label(1, "table"), "1 table");
        assert_eq!(count_label(12, "table"), "12 tables");
        assert_eq!(count_label(2, "view"), "2 views");
    }

    #[test]
    fn group_labels_are_folder_names_not_type_names() {
        assert_eq!(DbGroup::Tables.label(), "Tables");
        assert_eq!(DbGroup::Views.label(), "Views");
        assert_eq!(DbGroup::Collections.label(), "Collections");
        assert_eq!(DbGroup::Keys.label(), "Keys");
    }
}
