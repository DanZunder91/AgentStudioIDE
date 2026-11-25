//! gRPC message shapes for an agent: what a method takes and returns, field by field, and an
//! example request body it can edit and send. Built from a reflected [`DescriptorPool`].
//!
//! Field names are the protobuf-JSON names (`lowerCamelCase`), the ones a response uses; a
//! request may use either those or the `.proto` names.
//!
//! A schema comes from the server, so it may be huge or built to blow up a naive walk (a message
//! with hundreds of fields of its own type grows as fields^depth). Everything here is bounded by
//! construction, never cut after the fact: at most [`MAX_METHODS`] methods, [`MAX_MESSAGES`]
//! messages, [`MAX_FIELDS`] fields each and [`MAX_ENUM_VALUES`] values per enum are described; the
//! examples of one answer hold at most [`EXAMPLE_NODES`] values ([`EXAMPLE_BYTES`]) together,
//! nest [`EXAMPLE_DEPTH`] deep, and write `{}` where a message would nest inside itself; the text
//! stops at [`TEXT_BYTES`] and the data at [`DATA_BYTES`]. Every cut is said, in the text and in
//! the data.

use std::collections::{BTreeSet, HashSet, VecDeque};

use prost_reflect::{
    DescriptorPool, EnumDescriptor, FieldDescriptor, Kind, MessageDescriptor, MethodDescriptor,
    ServiceDescriptor,
};
use serde_json::{json, Map, Value};

/// Messages described in one answer.
pub const MAX_MESSAGES: usize = 40;
/// Fields listed per message.
pub const MAX_FIELDS: usize = 200;
/// Enum values listed per enum.
pub const MAX_ENUM_VALUES: usize = 20;
/// Methods described in one answer (a service's).
pub const MAX_METHODS: usize = 100;
/// How deep an example nests messages.
pub const EXAMPLE_DEPTH: usize = 4;
/// Values in all the example JSON of one answer together.
pub const EXAMPLE_NODES: usize = 2_000;
/// Bytes (about) of all the example JSON of one answer together.
pub const EXAMPLE_BYTES: usize = 32 * 1024;
/// The description's text, notes included.
pub const TEXT_BYTES: usize = 64 * 1024;
/// The description's data, serialized.
pub const DATA_BYTES: usize = 256 * 1024;
/// Room kept in a text budget for the closing note that says it was cut.
const NOTE_ROOM: usize = 512;
/// Names listed in a note (messages that nest inside themselves).
const NOTE_NAMES: usize = 5;

/// What a name resolved to.
#[derive(Debug, Clone)]
pub enum Found {
    Service(ServiceDescriptor),
    Method(MethodDescriptor),
    Message(MessageDescriptor),
    Enum(EnumDescriptor),
}

/// Find `name` in `pool`: `pkg.Service/Method`, `pkg.Service.Method`, a service, a message or an
/// enum, all fully qualified.
pub fn resolve(pool: &DescriptorPool, name: &str) -> Option<Found> {
    let name = name.trim().trim_start_matches('/').trim_start_matches('.');
    if let Some((service, method)) = name.split_once('/') {
        return find_method(pool, service, method).map(Found::Method);
    }
    if let Some(s) = pool.get_service_by_name(name) {
        return Some(Found::Service(s));
    }
    if let Some(m) = pool.get_message_by_name(name) {
        return Some(Found::Message(m));
    }
    if let Some(e) = pool.get_enum_by_name(name) {
        return Some(Found::Enum(e));
    }
    let (service, method) = name.rsplit_once('.')?;
    find_method(pool, service, method).map(Found::Method)
}

fn find_method(pool: &DescriptorPool, service: &str, method: &str) -> Option<MethodDescriptor> {
    pool.get_service_by_name(service)?
        .methods()
        .find(|m| m.name() == method)
}

// ─────────────────────────────────────────────────────────────────────────────
// Budgets: text and data kept within a size, each cut said.
// ─────────────────────────────────────────────────────────────────────────────

/// Lines of text kept within a byte budget. Once a line does not fit, nothing more is kept and
/// [`Lines::is_cut`] says so; callers check it before building more, so the work stops too.
#[derive(Debug)]
pub struct Lines {
    lines: Vec<String>,
    left: usize,
    cut: bool,
}

impl Lines {
    /// Room for `bytes` of text in all, a closing note included.
    pub fn new(bytes: usize) -> Self {
        Self {
            lines: Vec::new(),
            left: bytes.saturating_sub(NOTE_ROOM),
            cut: false,
        }
    }

    /// Keep `line` if it fits; false once one did not.
    pub fn push(&mut self, line: impl Into<String>) -> bool {
        let line = line.into();
        if self.cut || line.len() + 1 > self.left {
            self.cut = true;
            return false;
        }
        self.left -= line.len() + 1;
        self.lines.push(line);
        true
    }

    /// Whether a line was left out.
    pub fn is_cut(&self) -> bool {
        self.cut
    }

    /// The kept lines, then `note` when something was cut (the room for it was kept).
    pub fn finish(mut self, note: impl FnOnce() -> String) -> String {
        if self.cut {
            let note = note();
            let (note, _) = crate::ws::cut_text(&note, NOTE_ROOM - 1);
            self.lines.push(note.to_string());
        }
        self.lines.join("\n")
    }
}

/// Room left for JSON data, counted as its serialized size. Like [`Lines`]: once a value does not
/// fit, none after it is admitted.
#[derive(Debug)]
pub struct DataBudget {
    left: usize,
    cut: bool,
}

impl DataBudget {
    pub fn new(bytes: usize) -> Self {
        Self {
            left: bytes,
            cut: false,
        }
    }

    /// Whether `value` fits, spending its size (and a separator's) when it does.
    pub fn admit(&mut self, value: &Value) -> bool {
        let size = serde_json::to_string(value).map_or(usize::MAX, |s| s.len() + 1);
        if self.cut || size > self.left {
            self.cut = true;
            return false;
        }
        self.left -= size;
        true
    }

    /// Whether a value was left out.
    pub fn is_cut(&self) -> bool {
        self.cut
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Names and labels.
// ─────────────────────────────────────────────────────────────────────────────

/// `pkg.Service/Method`: the form `grpc call` takes.
pub fn method_path(m: &MethodDescriptor) -> String {
    format!("{}/{}", m.parent_service().full_name(), m.name())
}

/// `rpc pkg.Service/Method(pkg.Req) returns (stream pkg.Res)`.
pub fn signature(m: &MethodDescriptor) -> String {
    let stream = |s: bool| if s { "stream " } else { "" };
    format!(
        "rpc {}({}{}) returns ({}{})",
        method_path(m),
        stream(m.is_client_streaming()),
        m.input().full_name(),
        stream(m.is_server_streaming()),
        m.output().full_name()
    )
}

/// Whether `grpc call` can make this call.
pub fn is_unary(m: &MethodDescriptor) -> bool {
    !m.is_client_streaming() && !m.is_server_streaming()
}

/// A method as structured data.
pub fn method_data(m: &MethodDescriptor) -> Value {
    json!({
        "method": method_path(m),
        "input": m.input().full_name(),
        "output": m.output().full_name(),
        "clientStreaming": m.is_client_streaming(),
        "serverStreaming": m.is_server_streaming(),
    })
}

/// The protobuf-JSON form of a well-known type, which is not its fields: a description and an
/// example.
fn well_known(m: &MessageDescriptor) -> Option<(&'static str, Value)> {
    Some(match m.full_name() {
        "google.protobuf.Timestamp" => ("an RFC 3339 string", json!("1970-01-01T00:00:00Z")),
        "google.protobuf.Duration" => ("a string of seconds, like \"1.5s\"", json!("0s")),
        "google.protobuf.Empty" => ("{}", json!({})),
        "google.protobuf.Struct" => ("any JSON object", json!({})),
        "google.protobuf.Value" => ("any JSON value", Value::Null),
        "google.protobuf.ListValue" => ("any JSON array", json!([])),
        "google.protobuf.FieldMask" => ("a comma-separated string of field paths", json!("")),
        "google.protobuf.Any" => (
            "{\"@type\": \"type.googleapis.com/<message>\", ...that message's fields}",
            json!({"@type": "type.googleapis.com/<message>"}),
        ),
        "google.protobuf.DoubleValue" | "google.protobuf.FloatValue" => ("a number", json!(0.0)),
        "google.protobuf.Int64Value" | "google.protobuf.UInt64Value" => {
            ("a string of digits", json!("0"))
        }
        "google.protobuf.Int32Value" | "google.protobuf.UInt32Value" => ("a number", json!(0)),
        "google.protobuf.BoolValue" => ("true or false", json!(false)),
        "google.protobuf.StringValue" => ("a string", json!("")),
        "google.protobuf.BytesValue" => ("a base64 string", json!("")),
        _ => return None,
    })
}

/// A scalar's or a reference's name, with the JSON form when it is not the obvious one.
fn kind_label(kind: &Kind) -> String {
    match kind {
        Kind::Double => "double".into(),
        Kind::Float => "float".into(),
        Kind::Int32 => "int32".into(),
        Kind::Sint32 => "sint32".into(),
        Kind::Sfixed32 => "sfixed32".into(),
        Kind::Uint32 => "uint32".into(),
        Kind::Fixed32 => "fixed32".into(),
        Kind::Int64 => "int64 (JSON: a string of digits)".into(),
        Kind::Sint64 => "sint64 (JSON: a string of digits)".into(),
        Kind::Sfixed64 => "sfixed64 (JSON: a string of digits)".into(),
        Kind::Uint64 => "uint64 (JSON: a string of digits)".into(),
        Kind::Fixed64 => "fixed64 (JSON: a string of digits)".into(),
        Kind::Bool => "bool".into(),
        Kind::String => "string".into(),
        Kind::Bytes => "bytes (JSON: a base64 string)".into(),
        Kind::Enum(e) => format!("enum {} ({})", e.full_name(), enum_values(e)),
        Kind::Message(m) => match well_known(m) {
            Some((form, _)) => format!("{} (JSON: {form})", m.full_name()),
            None => m.full_name().to_string(),
        },
    }
}

/// `A | B | C`, at most [`MAX_ENUM_VALUES`] of them.
fn enum_values(e: &EnumDescriptor) -> String {
    let mut shown = e
        .values()
        .take(MAX_ENUM_VALUES)
        .map(|v| v.name().to_string())
        .collect::<Vec<_>>()
        .join(" | ");
    let more = e.values().len().saturating_sub(MAX_ENUM_VALUES);
    if more > 0 {
        shown.push_str(&format!(" | …{more} more"));
    }
    shown
}

/// `repeated X`, `map<K, V>` or `X`.
pub fn type_label(f: &FieldDescriptor) -> String {
    if let (true, Kind::Message(entry)) = (f.is_map(), f.kind()) {
        return format!(
            "map<{}, {}>",
            kind_label(&entry.map_entry_key_field().kind()),
            kind_label(&entry.map_entry_value_field().kind())
        );
    }
    if f.is_list() {
        format!("repeated {}", kind_label(&f.kind()))
    } else {
        kind_label(&f.kind())
    }
}

/// The real oneof a field belongs to (not proto3 `optional`'s synthetic one).
fn oneof(f: &FieldDescriptor) -> Option<String> {
    f.containing_oneof()
        .filter(|o| !o.is_synthetic())
        .map(|o| o.name().to_string())
}

/// One field line: `jsonName: type  [notes]`.
fn field_line(f: &FieldDescriptor) -> String {
    let mut notes = Vec::new();
    if f.json_name() != f.name() {
        notes.push(format!("proto name {}", f.name()));
    }
    if let Some(o) = oneof(f) {
        notes.push(format!("oneof {o}: set at most one"));
    }
    let notes = if notes.is_empty() {
        String::new()
    } else {
        format!("  [{}]", notes.join("; "))
    };
    format!("  {}: {}{notes}", f.json_name(), type_label(f))
}

fn field_data(f: &FieldDescriptor) -> Value {
    json!({
        "name": f.json_name(),
        "protoName": f.name(),
        "type": type_label(f),
        "oneof": oneof(f),
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// Examples.
// ─────────────────────────────────────────────────────────────────────────────

/// What the examples of one answer may still spend, and what they had to leave out. One budget
/// is shared by every example in an answer, so a service with many methods costs no more than
/// one method.
#[derive(Debug)]
pub struct Examples {
    nodes: usize,
    bytes: usize,
    /// The budget ran out: some example stops short.
    pub cut: bool,
    /// Messages written as `{}` where they would nest inside themselves.
    pub recursive: BTreeSet<String>,
}

impl Default for Examples {
    fn default() -> Self {
        Self::new(EXAMPLE_NODES, EXAMPLE_BYTES)
    }
}

impl Examples {
    pub fn new(nodes: usize, bytes: usize) -> Self {
        Self {
            nodes,
            bytes,
            cut: false,
            recursive: BTreeSet::new(),
        }
    }

    /// Spend one value of about `bytes`; false, and nothing more is spent, once that is too much.
    fn spend(&mut self, bytes: usize) -> bool {
        if self.cut || self.nodes == 0 || bytes > self.bytes {
            self.cut = true;
            return false;
        }
        self.nodes -= 1;
        self.bytes -= bytes;
        true
    }

    /// An example value for `message`: every field at a placeholder value, the first member of
    /// each oneof only (setting two is an error), nested messages down to [`EXAMPLE_DEPTH`]
    /// levels, `{}` where a message would nest inside itself or the budget ran out.
    pub fn example(&mut self, message: &MessageDescriptor) -> Value {
        self.message(message, EXAMPLE_DEPTH, &mut Vec::new())
    }

    fn message(
        &mut self,
        message: &MessageDescriptor,
        depth: usize,
        path: &mut Vec<String>,
    ) -> Value {
        if let Some((_, value)) = well_known(message) {
            return value;
        }
        let mut map = Map::new();
        let name = message.full_name();
        if path.iter().any(|p| p == name) {
            self.recursive.insert(name.to_string());
            return Value::Object(map);
        }
        if depth == 0 {
            return Value::Object(map);
        }
        path.push(name.to_string());
        let mut oneofs = HashSet::new();
        for f in message.fields().take(MAX_FIELDS) {
            if let Some(o) = oneof(&f) {
                if !oneofs.insert(o) {
                    continue;
                }
            }
            // The key with its quotes, colon and comma, and room for a scalar or a wrapper.
            if !self.spend(f.json_name().len() + 16) {
                break;
            }
            let value = self.field(&f, depth - 1, path);
            map.insert(f.json_name().to_string(), value);
        }
        path.pop();
        Value::Object(map)
    }

    fn field(&mut self, f: &FieldDescriptor, depth: usize, path: &mut Vec<String>) -> Value {
        if let (true, Kind::Message(entry)) = (f.is_map(), f.kind()) {
            let key = match entry.map_entry_key_field().kind() {
                Kind::String => "key",
                Kind::Bool => "true",
                _ => "0",
            };
            let mut m = Map::new();
            m.insert(
                key.to_string(),
                self.kind(&entry.map_entry_value_field().kind(), depth, path),
            );
            return Value::Object(m);
        }
        let one = self.kind(&f.kind(), depth, path);
        if f.is_list() {
            json!([one])
        } else {
            one
        }
    }

    fn kind(&mut self, kind: &Kind, depth: usize, path: &mut Vec<String>) -> Value {
        match kind {
            Kind::Double | Kind::Float => json!(0.0),
            Kind::Int32 | Kind::Sint32 | Kind::Sfixed32 | Kind::Uint32 | Kind::Fixed32 => json!(0),
            Kind::Int64 | Kind::Sint64 | Kind::Sfixed64 | Kind::Uint64 | Kind::Fixed64 => {
                json!("0")
            }
            Kind::Bool => json!(false),
            Kind::String | Kind::Bytes => json!(""),
            // The first value's name, or its number when the name is more than the budget has.
            Kind::Enum(e) => match e.values().next() {
                Some(v) if self.spend(v.name().len() + 2) => json!(v.name()),
                Some(v) => json!(v.number()),
                None => json!(0),
            },
            Kind::Message(m) => self.message(m, depth, path),
        }
    }

    /// What the examples left out, as sentences for the text.
    fn notes(&self) -> Vec<String> {
        let mut notes = Vec::new();
        if !self.recursive.is_empty() {
            let names: Vec<&str> = self
                .recursive
                .iter()
                .take(NOTE_NAMES)
                .map(String::as_str)
                .collect();
            let more = self.recursive.len().saturating_sub(NOTE_NAMES);
            let more = if more > 0 {
                format!(" and {more} more")
            } else {
                String::new()
            };
            notes.push(format!(
                "(Recursive: {}{more} {}; the example writes {{}} where a message would nest \
                 inside itself.)",
                names.join(", "),
                if self.recursive.len() == 1 {
                    "contains itself"
                } else {
                    "contain themselves"
                }
            ));
        }
        if self.cut {
            notes.push(format!(
                "(The example JSON is cut short: one answer's examples hold at most \
                 {EXAMPLE_NODES} values. The field lists above are complete; describe a single \
                 method or message for a fuller example.)"
            ));
        }
        notes
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Describing.
// ─────────────────────────────────────────────────────────────────────────────

/// The messages to spell out, starting from `roots`, breadth first: each one's message-typed
/// fields after it, well-known types and map entries left out (their form is in the field
/// line). Returns them and whether [`MAX_MESSAGES`] cut the walk short.
fn reachable(roots: Vec<MessageDescriptor>) -> (Vec<MessageDescriptor>, bool) {
    fn push(queue: &mut VecDeque<MessageDescriptor>, kind: Kind) {
        if let Kind::Message(m) = kind {
            queue.push_back(m);
        }
    }
    let mut queue: VecDeque<MessageDescriptor> = roots.into();
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    while let Some(m) = queue.pop_front() {
        if well_known(&m).is_some() || !seen.insert(m.full_name().to_string()) {
            continue;
        }
        if m.is_map_entry() {
            // A map's entry is not a message anyone writes; its value type may be.
            push(&mut queue, m.map_entry_value_field().kind());
            continue;
        }
        if out.len() == MAX_MESSAGES {
            return (out, true);
        }
        for f in m.fields().take(MAX_FIELDS) {
            push(&mut queue, f.kind());
        }
        out.push(m);
    }
    (out, false)
}

/// The note that closes a text cut at [`TEXT_BYTES`], saying whether the data was cut as well.
fn text_cut_note(data_cut: bool) -> String {
    format!(
        "…the description is cut at {} KiB ({}); describe one method or message by name for \
         the rest.",
        TEXT_BYTES / 1024,
        if data_cut {
            "--json is cut too"
        } else {
            "--json has the rest"
        }
    )
}

/// An enum: its values, in order.
fn describe_enum(e: &EnumDescriptor) -> (String, Value) {
    let mut text = Lines::new(TEXT_BYTES);
    text.push(format!("enum {} {{ {} }}", e.full_name(), enum_values(e)));
    text.push("In JSON, use the value's name as a string.");
    let mut budget = DataBudget::new(DATA_BYTES);
    let mut values = Vec::new();
    for v in e.values().take(MAX_ENUM_VALUES) {
        let value = json!({"name": v.name(), "number": v.number()});
        if !budget.admit(&value) {
            break;
        }
        values.push(value);
    }
    let more = e.values().len().saturating_sub(values.len());
    (
        text.finish(|| text_cut_note(budget.is_cut())),
        json!({
            "enum": e.full_name(),
            "values": values,
            "moreValues": more,
            "truncated": budget.is_cut(),
        }),
    )
}

/// The description of what `found` names: text for the agent, and the same as data, both
/// bounded (see the module docs) and each saying what it left out.
pub fn describe(found: &Found) -> (String, Value) {
    let (methods, total_methods): (Vec<MethodDescriptor>, usize) = match found {
        Found::Enum(e) => return describe_enum(e),
        Found::Service(s) => (s.methods().take(MAX_METHODS).collect(), s.methods().len()),
        Found::Method(m) => (vec![m.clone()], 1),
        Found::Message(_) => (Vec::new(), 0),
    };
    let more_methods = total_methods - methods.len();
    let roots: Vec<MessageDescriptor> = match found {
        Found::Message(m) => vec![m.clone()],
        _ => methods
            .iter()
            .flat_map(|m| [m.input(), m.output()])
            .collect(),
    };

    // Each example is built once, from one budget, and used for the text and the data alike.
    let mut budget = Examples::default();
    let examples: Vec<(String, Value)> = match found {
        Found::Message(m) => vec![(m.full_name().to_string(), budget.example(m))],
        _ => methods
            .iter()
            .filter(|m| is_unary(m))
            .map(|m| (method_path(m), budget.example(&m.input())))
            .collect(),
    };

    // The data: the methods (with their examples) first, as what an agent calls; then the
    // messages, while the budget lasts.
    let mut data_budget = DataBudget::new(DATA_BYTES);
    let mut unary_examples = examples.iter().map(|(_, v)| v);
    let mut method_data_out = Vec::new();
    for m in &methods {
        let mut d = method_data(m);
        if is_unary(m) {
            if let Some(example) = unary_examples.next() {
                d["requestExample"] = example.clone();
            }
        }
        if !data_budget.admit(&d) {
            break;
        }
        method_data_out.push(d);
    }
    let message_example = match found {
        Found::Message(_) => examples
            .first()
            .map(|(_, v)| v.clone())
            .filter(|v| data_budget.admit(v))
            .unwrap_or(Value::Null),
        _ => Value::Null,
    };

    let mut text = Lines::new(TEXT_BYTES);
    if let Found::Service(s) = found {
        text.push(format!(
            "service {} ({} method{})",
            s.full_name(),
            total_methods,
            if total_methods == 1 { "" } else { "s" }
        ));
    }
    for m in &methods {
        if !text.push(signature(m)) {
            break;
        }
    }
    if more_methods > 0 {
        text.push(format!(
            "…{more_methods} more methods not described; describe one by name \
             (package.Service/Method)."
        ));
    }
    if !methods.iter().all(is_unary) {
        text.push("(`grpc call` makes unary calls only; a stream method cannot be called.)");
    }

    let (messages, messages_cut) = reachable(roots);
    let mut message_data = Vec::new();
    for m in &messages {
        if text.is_cut() && data_budget.is_cut() {
            break;
        }
        let more = m.fields().len().saturating_sub(MAX_FIELDS);
        text.push(String::new());
        text.push(format!("message {} {{", m.full_name()));
        let mut fields = Vec::new();
        for f in m.fields().take(MAX_FIELDS) {
            if text.is_cut() && data_budget.is_cut() {
                break;
            }
            if !text.is_cut() {
                text.push(field_line(&f));
            }
            if !data_budget.is_cut() {
                fields.push(field_data(&f));
            }
        }
        if more > 0 {
            text.push(format!("  …{more} more fields not listed"));
        }
        text.push("}");
        let item = json!({
            "name": m.full_name(),
            "fields": fields,
            "moreFields": more,
        });
        if data_budget.admit(&item) {
            message_data.push(item);
        }
    }
    if messages_cut {
        text.push(String::new());
        text.push(format!(
            "…only the first {MAX_MESSAGES} messages are spelled out; describe a message by name \
             for the rest."
        ));
    }

    for (name, value) in &examples {
        text.push(String::new());
        text.push(format!(
            "Example JSON for {name} (every field is optional; drop what you do not need):"
        ));
        text.push(value.to_string());
    }
    let notes = budget.notes();
    if !notes.is_empty() {
        text.push(String::new());
        for note in notes {
            text.push(note);
        }
    }

    let data = json!({
        "methods": method_data_out,
        "moreMethods": more_methods,
        "messages": message_data,
        "messagesCut": messages_cut,
        "example": message_example,
        "exampleCut": budget.cut,
        "recursive": budget.recursive.iter().take(NOTE_NAMES).collect::<Vec<_>>(),
        "truncated": data_budget.is_cut(),
    });
    let data_cut = data_budget.is_cut();
    (
        text.finish(|| text_cut_note(data_cut))
            .trim_start()
            .to_string(),
        data,
    )
}
