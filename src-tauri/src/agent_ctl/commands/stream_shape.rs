//! gRPC message shapes for an agent: what a method takes and returns, field by field, and an
//! example request body it can edit and send. Built from a reflected [`DescriptorPool`].
//!
//! Field names are the protobuf-JSON names (`lowerCamelCase`), the ones a response uses; a
//! request may use either those or the `.proto` names. Bounded: at most [`MAX_MESSAGES`]
//! messages, [`MAX_FIELDS`] fields each, [`MAX_ENUM_VALUES`] values per enum, and examples nested
//! [`EXAMPLE_DEPTH`] deep (a recursive message ends in `{}`); the description says what it left
//! out.

use std::collections::{HashSet, VecDeque};

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
/// How deep an example nests messages.
pub const EXAMPLE_DEPTH: usize = 4;

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
    let names: Vec<String> = e.values().map(|v| v.name().to_string()).collect();
    let mut shown = names
        .iter()
        .take(MAX_ENUM_VALUES)
        .cloned()
        .collect::<Vec<_>>()
        .join(" | ");
    if names.len() > MAX_ENUM_VALUES {
        shown.push_str(&format!(" | …{} more", names.len() - MAX_ENUM_VALUES));
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

/// An example value for `message`: every field at a placeholder value, the first member of each
/// oneof only (setting two is an error), nested messages down to `depth` levels.
pub fn example(message: &MessageDescriptor, depth: usize) -> Value {
    if let Some((_, value)) = well_known(message) {
        return value;
    }
    let mut map = Map::new();
    if depth == 0 {
        return Value::Object(map);
    }
    let mut oneofs = HashSet::new();
    for f in message.fields().take(MAX_FIELDS) {
        if let Some(o) = oneof(&f) {
            if !oneofs.insert(o) {
                continue;
            }
        }
        map.insert(f.json_name().to_string(), field_example(&f, depth - 1));
    }
    Value::Object(map)
}

fn field_example(f: &FieldDescriptor, depth: usize) -> Value {
    if let (true, Kind::Message(entry)) = (f.is_map(), f.kind()) {
        let key = match entry.map_entry_key_field().kind() {
            Kind::String => "key",
            Kind::Bool => "true",
            _ => "0",
        };
        let mut m = Map::new();
        m.insert(
            key.to_string(),
            kind_example(&entry.map_entry_value_field().kind(), depth),
        );
        return Value::Object(m);
    }
    let one = kind_example(&f.kind(), depth);
    if f.is_list() {
        json!([one])
    } else {
        one
    }
}

fn kind_example(kind: &Kind, depth: usize) -> Value {
    match kind {
        Kind::Double | Kind::Float => json!(0.0),
        Kind::Int32 | Kind::Sint32 | Kind::Sfixed32 | Kind::Uint32 | Kind::Fixed32 => json!(0),
        Kind::Int64 | Kind::Sint64 | Kind::Sfixed64 | Kind::Uint64 | Kind::Fixed64 => json!("0"),
        Kind::Bool => json!(false),
        Kind::String | Kind::Bytes => json!(""),
        Kind::Enum(e) => e.values().next().map_or(json!(0), |v| json!(v.name())),
        Kind::Message(m) => example(m, depth),
    }
}

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

/// An enum: its values, in order.
fn describe_enum(e: &EnumDescriptor) -> (String, Value) {
    let values: Vec<Value> = e
        .values()
        .take(MAX_ENUM_VALUES)
        .map(|v| json!({"name": v.name(), "number": v.number()}))
        .collect();
    let more = e.values().count().saturating_sub(MAX_ENUM_VALUES);
    (
        format!(
            "enum {} {{ {} }}\nIn JSON, use the value's name as a string.",
            e.full_name(),
            enum_values(e)
        ),
        json!({"enum": e.full_name(), "values": values, "moreValues": more}),
    )
}

/// The description of what `found` names: text for the agent, and the same as data.
pub fn describe(found: &Found) -> (String, Value) {
    let (methods, roots): (Vec<MethodDescriptor>, Vec<MessageDescriptor>) = match found {
        Found::Enum(e) => return describe_enum(e),
        Found::Service(s) => {
            let methods: Vec<_> = s.methods().collect();
            let roots = methods
                .iter()
                .flat_map(|m| [m.input(), m.output()])
                .collect();
            (methods, roots)
        }
        Found::Method(m) => (vec![m.clone()], vec![m.input(), m.output()]),
        Found::Message(m) => (Vec::new(), vec![m.clone()]),
    };

    let mut text = Vec::new();
    if let Found::Service(s) = found {
        text.push(format!(
            "service {} ({} method{})",
            s.full_name(),
            methods.len(),
            if methods.len() == 1 { "" } else { "s" }
        ));
    }
    for m in &methods {
        text.push(signature(m));
    }
    if !methods.iter().all(is_unary) {
        text.push("(`grpc call` makes unary calls only; a stream method cannot be called.)".into());
    }

    let (messages, cut) = reachable(roots);
    let mut message_data = Vec::new();
    for m in &messages {
        let fields: Vec<FieldDescriptor> = m.fields().collect();
        text.push(String::new());
        text.push(format!("message {} {{", m.full_name()));
        text.extend(fields.iter().take(MAX_FIELDS).map(field_line));
        let more = fields.len().saturating_sub(MAX_FIELDS);
        if more > 0 {
            text.push(format!("  …{more} more fields not listed"));
        }
        text.push("}".to_string());
        message_data.push(json!({
            "name": m.full_name(),
            "fields": fields.iter().take(MAX_FIELDS).map(field_data).collect::<Vec<_>>(),
            "moreFields": more,
        }));
    }
    if cut {
        text.push(String::new());
        text.push(format!(
            "…only the first {MAX_MESSAGES} messages are spelled out; describe a message by name \
             for the rest."
        ));
    }

    let examples: Vec<(String, Value)> = match found {
        Found::Message(m) => vec![(m.full_name().to_string(), example(m, EXAMPLE_DEPTH))],
        _ => methods
            .iter()
            .filter(|m| is_unary(m))
            .map(|m| (method_path(m), example(&m.input(), EXAMPLE_DEPTH)))
            .collect(),
    };
    for (name, value) in &examples {
        text.push(String::new());
        text.push(format!(
            "Example JSON for {name} (every field is optional; drop what you do not need):"
        ));
        text.push(value.to_string());
    }

    let methods: Vec<Value> = methods
        .iter()
        .map(|m| {
            let mut d = method_data(m);
            if is_unary(m) {
                d["requestExample"] = example(&m.input(), EXAMPLE_DEPTH);
            }
            d
        })
        .collect();
    let data = json!({
        "methods": methods,
        "messages": message_data,
        "messagesCut": cut,
        "example": match found {
            Found::Message(m) => example(m, EXAMPLE_DEPTH),
            _ => Value::Null,
        },
    });
    (text.join("\n").trim_start().to_string(), data)
}
