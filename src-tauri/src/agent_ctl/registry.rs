//! The tool registry. One [`ToolSpec`] per action feeds the CLI parser, its help and the MCP tool
//! list, so adding a tool touches no front door. Secrets never go in a [`ToolOk`] or an error:
//! see each command module for its rules.

use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;

use serde_json::{Map, Value};

/// What a tool returns: the sentence the agent reads, and structured data (`--json`, MCP).
#[derive(Debug, Clone, PartialEq)]
pub struct ToolOk {
    pub message: String,
    pub data: Value,
}

impl ToolOk {
    pub fn new(message: impl Into<String>, data: Value) -> Self {
        Self {
            message: message.into(),
            data,
        }
    }
}

/// A tool's future. `Err` is the sentence the agent is shown (no secrets, no stack).
pub type ToolFuture = Pin<Box<dyn Future<Output = Result<ToolOk, String>> + Send>>;

/// The value kinds a parameter can take. The CLI converts its strings to these before sending,
/// so the app always validates JSON values.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParamKind {
    String,
    /// A whole number (JSON integer).
    Integer,
    /// A flag on the CLI (`--force`), `true`/`false` in MCP.
    Bool,
    /// Any JSON value; on the CLI, a JSON string that is parsed (`--body '{"a":1}'`).
    Json,
    /// A list of strings; on the CLI, a repeatable flag (`--header 'A: 1' --header 'B: 2'`).
    StringList,
}

impl ParamKind {
    fn json_type(self) -> Value {
        match self {
            ParamKind::String => serde_json::json!({"type": "string"}),
            ParamKind::Integer => serde_json::json!({"type": "integer"}),
            ParamKind::Bool => serde_json::json!({"type": "boolean"}),
            ParamKind::Json => serde_json::json!({}),
            ParamKind::StringList => {
                serde_json::json!({"type": "array", "items": {"type": "string"}})
            }
        }
    }
}

/// One parameter. `name` is snake_case (the MCP and wire name); the CLI flag is the same with
/// hyphens (`row_limit` → `--row-limit`).
#[derive(Debug, Clone, Copy)]
pub struct Param {
    pub name: &'static str,
    pub kind: ParamKind,
    pub required: bool,
    /// Taken from the command line's bare words, in declaration order, instead of a flag.
    pub positional: bool,
    pub help: &'static str,
}

impl Param {
    pub const fn new(name: &'static str, kind: ParamKind, help: &'static str) -> Self {
        Self {
            name,
            kind,
            required: false,
            positional: false,
            help,
        }
    }

    pub const fn required(mut self) -> Self {
        self.required = true;
        self
    }

    pub const fn positional(mut self) -> Self {
        self.positional = true;
        self
    }

    /// The CLI flag for this parameter.
    pub fn flag(&self) -> String {
        format!("--{}", self.name.replace('_', "-"))
    }
}

/// One tool.
#[derive(Debug, Clone, Copy)]
pub struct ToolSpec {
    /// snake_case, unique: the MCP tool name and the wire name (`db_query`).
    pub name: &'static str,
    /// The command-line words (`["db", "query"]`).
    pub cli: &'static [&'static str],
    /// One line: the help listing and the start of the MCP description.
    pub summary: &'static str,
    /// More help (rules, limits, examples), or `""`.
    pub details: &'static str,
    pub params: &'static [Param],
    pub run: fn(ToolCtx, Args) -> ToolFuture,
}

/// What a tool learns from the UI side when it runs: where the app keeps its files, which
/// terminal asked, and where to send a UI event.
#[derive(Clone)]
pub struct ToolCtx {
    /// The app config dir: every store lives here (`db-connections.json`, `api-store.json`, …).
    /// Tests pass a temp dir.
    pub dir: PathBuf,
    /// The terminal the request came from. An agent's id is its terminal's id.
    pub terminal_id: String,
    pub ui: Arc<dyn UiSink>,
}

impl ToolCtx {
    /// The database client's stores in [`Self::dir`].
    pub fn db_paths(&self) -> crate::db::Paths {
        crate::db::Paths::in_dir(&self.dir)
    }

    /// Tell the webview what happened (`kind` picks the frontend handler).
    pub fn emit(&self, kind: &str, payload: Value) {
        let payload = match payload {
            Value::Object(m) => m,
            Value::Null => Map::new(),
            other => {
                let mut m = Map::new();
                m.insert("value".into(), other);
                m
            }
        };
        self.ui.emit(super::CtlEvent {
            kind: kind.to_string(),
            terminal_id: self.terminal_id.clone(),
            payload,
        });
    }
}

/// Where UI events go: the webview in the app, a recorder in tests.
pub trait UiSink: Send + Sync {
    fn emit(&self, event: super::CtlEvent);
}

/// A UI sink that drops everything (tools that need no UI, tests that do not look).
pub struct NoUi;

impl UiSink for NoUi {
    fn emit(&self, _event: super::CtlEvent) {}
}

/// Validated arguments: every key is a declared parameter of the right kind.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Args(pub Map<String, Value>);

impl Args {
    pub fn str(&self, name: &str) -> Option<&str> {
        self.0.get(name).and_then(Value::as_str)
    }

    /// A required string, trimmed, non-empty.
    pub fn req_str(&self, name: &str) -> Result<&str, String> {
        self.str(name)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| format!("`{name}` is required."))
    }

    pub fn bool(&self, name: &str) -> bool {
        self.0.get(name).and_then(Value::as_bool).unwrap_or(false)
    }

    pub fn int(&self, name: &str) -> Option<i64> {
        self.0.get(name).and_then(Value::as_i64)
    }

    pub fn json(&self, name: &str) -> Option<&Value> {
        self.0.get(name)
    }

    pub fn list(&self, name: &str) -> Vec<String> {
        self.0
            .get(name)
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default()
    }
}

/// Every tool, in help order.
pub fn all() -> Vec<&'static ToolSpec> {
    let tables: [&'static [ToolSpec]; 3] = [
        super::commands::db::TOOLS,
        super::commands::http::TOOLS,
        super::commands::stream::TOOLS,
    ];
    tables.iter().flat_map(|t| t.iter()).collect()
}

pub fn find(name: &str) -> Option<&'static ToolSpec> {
    all().into_iter().find(|t| t.name == name)
}

/// The tool whose command-line words start `words`, the longest match first.
pub fn find_cli(words: &[String]) -> Option<&'static ToolSpec> {
    all()
        .into_iter()
        .filter(|t| {
            t.cli.len() <= words.len() && t.cli.iter().zip(words).all(|(a, b)| *a == b.as_str())
        })
        .max_by_key(|t| t.cli.len())
}

/// The first command-line words of every tool (`db`, `http`, …): what puts the binary in
/// command mode.
pub fn groups() -> Vec<&'static str> {
    let mut g: Vec<&'static str> = all()
        .iter()
        .filter_map(|t| t.cli.first().copied())
        .collect();
    g.dedup();
    g
}

/// Check `raw` against `spec`: no unknown keys, every required one present, every value of its
/// kind.
pub fn validate(spec: &ToolSpec, raw: Map<String, Value>) -> Result<Args, String> {
    for key in raw.keys() {
        if !spec.params.iter().any(|p| p.name == key) {
            return Err(format!("`{}` does not take `{key}`.", spec.name));
        }
    }
    for p in spec.params {
        match raw.get(p.name) {
            None | Some(Value::Null) if p.required => {
                return Err(format!("`{}` needs `{}`.", spec.name, p.name))
            }
            None | Some(Value::Null) => {}
            Some(v) => {
                let ok = match p.kind {
                    ParamKind::String => v.is_string(),
                    ParamKind::Integer => v.is_i64() || v.is_u64(),
                    ParamKind::Bool => v.is_boolean(),
                    ParamKind::Json => true,
                    ParamKind::StringList => {
                        v.as_array().is_some_and(|a| a.iter().all(Value::is_string))
                    }
                };
                if !ok {
                    return Err(format!(
                        "`{}` must be {}.",
                        p.name,
                        match p.kind {
                            ParamKind::String => "a string",
                            ParamKind::Integer => "a whole number",
                            ParamKind::Bool => "true or false",
                            ParamKind::Json => "JSON",
                            ParamKind::StringList => "a list of strings",
                        }
                    ));
                }
            }
        }
    }
    Ok(Args(raw))
}

/// The MCP `inputSchema` for a tool.
pub fn json_schema(spec: &ToolSpec) -> Value {
    let mut props = Map::new();
    for p in spec.params {
        let mut schema = p.kind.json_type();
        if let Value::Object(m) = &mut schema {
            m.insert("description".into(), Value::String(p.help.to_string()));
        }
        props.insert(p.name.to_string(), schema);
    }
    let required: Vec<Value> = spec
        .params
        .iter()
        .filter(|p| p.required)
        .map(|p| Value::String(p.name.to_string()))
        .collect();
    serde_json::json!({
        "type": "object",
        "properties": props,
        "required": required,
        "additionalProperties": false,
    })
}

/// The MCP description: the summary, then the details.
pub fn description(spec: &ToolSpec) -> String {
    if spec.details.is_empty() {
        spec.summary.to_string()
    } else {
        format!("{}\n\n{}", spec.summary, spec.details)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_names_and_command_words_are_unique_and_well_formed() {
        let tools = all();
        assert!(!tools.is_empty());
        let mut names = std::collections::HashSet::new();
        let mut words = std::collections::HashSet::new();
        for t in &tools {
            assert!(names.insert(t.name), "duplicate tool {}", t.name);
            assert!(words.insert(t.cli.join(" ")), "duplicate words {:?}", t.cli);
            assert!(
                t.name.chars().all(|c| c.is_ascii_lowercase() || c == '_'),
                "{} is not snake_case",
                t.name
            );
            assert_eq!(t.name, t.cli.join("_"), "the name is the words joined");
            assert!(
                !t.summary.is_empty() && t.summary.len() <= 160,
                "{}",
                t.name
            );
            let mut seen_optional_positional = false;
            for p in t.params {
                assert!(
                    p.name.chars().all(|c| c.is_ascii_lowercase() || c == '_'),
                    "{}.{}",
                    t.name,
                    p.name
                );
                assert_ne!(p.name, "json", "--json is the CLI's output flag");
                assert_ne!(p.name, "help", "--help is the CLI's help flag");
                if p.positional {
                    assert!(
                        !(seen_optional_positional && p.required),
                        "{}: a required positional after an optional one",
                        t.name
                    );
                    seen_optional_positional |= !p.required;
                    assert!(
                        matches!(p.kind, ParamKind::String | ParamKind::Integer),
                        "{}.{}: positionals are strings or numbers",
                        t.name,
                        p.name
                    );
                }
            }
        }
    }

    #[test]
    fn validation_refuses_unknown_missing_and_mistyped_arguments() {
        let spec = find("db_connect").unwrap();
        let ok = |v: Value| validate(spec, v.as_object().unwrap().clone());
        assert!(ok(serde_json::json!({"url": "postgres://h/d"})).is_ok());
        assert!(ok(serde_json::json!({"url": "x", "force": true, "name": "N"})).is_ok());
        assert!(ok(serde_json::json!({}))
            .unwrap_err()
            .contains("needs `url`"));
        assert!(ok(serde_json::json!({"url": "x", "bogus": 1}))
            .unwrap_err()
            .contains("does not take `bogus`"));
        assert!(ok(serde_json::json!({"url": 5}))
            .unwrap_err()
            .contains("must be a string"));
        assert!(ok(serde_json::json!({"url": "x", "force": "yes"}))
            .unwrap_err()
            .contains("true or false"));
    }

    #[test]
    fn the_schema_lists_every_parameter_and_the_required_ones() {
        let spec = find("db_connect").unwrap();
        let s = json_schema(spec);
        assert_eq!(s["type"], "object");
        assert_eq!(s["additionalProperties"], false);
        assert_eq!(s["properties"]["url"]["type"], "string");
        assert_eq!(s["properties"]["force"]["type"], "boolean");
        assert_eq!(s["required"], serde_json::json!(["url"]));
        assert!(description(spec).starts_with(spec.summary));
    }

    #[test]
    fn command_words_find_the_longest_matching_tool() {
        let w = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(
            find_cli(&w(&["db", "connect", "postgres://x"])).map(|t| t.name),
            Some("db_connect")
        );
        assert_eq!(find_cli(&w(&["db"])).map(|t| t.name), None);
        assert_eq!(find_cli(&w(&["nope", "x"])).map(|t| t.name), None);
        assert!(groups().contains(&"db"));
    }

    #[test]
    fn args_read_each_kind_and_default_quietly() {
        let a = Args(
            serde_json::json!({"s": " v ", "b": true, "i": 7, "l": ["a", "b"], "j": {"k": 1}})
                .as_object()
                .unwrap()
                .clone(),
        );
        assert_eq!(a.str("s"), Some(" v "));
        assert_eq!(a.req_str("s").unwrap(), "v");
        assert!(a.req_str("missing").unwrap_err().contains("`missing`"));
        assert!(a.bool("b") && !a.bool("missing"));
        assert_eq!(a.int("i"), Some(7));
        assert_eq!(a.list("l"), vec!["a", "b"]);
        assert!(a.list("missing").is_empty());
        assert_eq!(a.json("j").unwrap()["k"], 1);
        assert_eq!(
            Param::new("row_limit", ParamKind::Integer, "").flag(),
            "--row-limit"
        );
    }
}
