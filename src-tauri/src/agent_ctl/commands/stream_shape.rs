//! gRPC message shapes for an agent: what a method takes and returns, field by field, and an
//! example request body it can edit and send. Built from a reflected [`DescriptorPool`].
//!
//! Field names are the protobuf-JSON names (`lowerCamelCase`), the ones a response uses; a
//! request may use either those or the `.proto` names.
//!
//! A schema comes from the server, so it may be huge or built to blow up a naive walk: a message
//! with hundreds of fields of its own type grows as fields^depth, and a name declared once (an
//! enum's values, a oneof, a package) is repeated in every field that refers to it. Everything
//! here is bounded by construction, never cut after the fact:
//! * the walk visits at most [`MAX_VISITS`] schema nodes (messages, fields, enum values), and
//!   describes at most [`MAX_METHODS`] methods, [`MAX_MESSAGES`] messages, [`MAX_FIELDS`] fields
//!   each and [`MAX_ENUM_VALUES`] values per enum;
//! * a server-chosen name is written whole up to [`NAME_BYTES`] and cut past it, and a field's
//!   type lists about [`VALUES_BYTES`] of its enum's values, so no line of text and no entry of
//!   data is more than a few KiB, whatever the schema;
//! * the examples of one answer hold at most [`EXAMPLE_NODES`] values ([`EXAMPLE_BYTES`])
//!   together, nest [`EXAMPLE_DEPTH`] deep, and write `{}` where a message would nest inside
//!   itself;
//! * the text ([`TEXT_BYTES`]) and the data ([`DATA_BYTES`]) are checked line by line and entry
//!   by entry — each field on its own — before the next is built, so the work stops where the
//!   budgets do.
//!
//! Every cut is said, in the text and in the data.

use std::borrow::Cow;
use std::collections::{HashSet, VecDeque};
use std::hash::{Hash, Hasher};
use std::io;

use prost_reflect::{
    DescriptorPool, EnumDescriptor, FieldDescriptor, Kind, MessageDescriptor, MethodDescriptor,
    OneofDescriptor, ServiceDescriptor,
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
/// Schema nodes (messages, fields, enum values, example values) one answer visits, whatever the
/// schema. Lower than what the counts above allow together, so it is the bound that holds.
pub const MAX_VISITS: usize = 6_000;
/// The longest server-chosen name written whole; a longer one is cut and ends in `…`.
pub const NAME_BYTES: usize = 256;
/// Bytes (about) of enum values written into one field's type.
pub const VALUES_BYTES: usize = 1024;
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
/// Room kept in a data budget for an answer's own keys and flags, around the entries it admits.
pub const ENVELOPE_ROOM: usize = 512;
/// Room kept in a text budget for the closing notes that say what was cut.
const NOTE_ROOM: usize = 1024;
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
// Budgets: text and data kept within a size, names within a length, the walk within a count.
// ─────────────────────────────────────────────────────────────────────────────

/// Lines of text kept within a byte budget. Once a line does not fit, nothing more is kept and
/// [`Lines::is_cut`] says so; callers check it before building a line, so the work stops too.
#[derive(Debug)]
pub struct Lines {
    lines: Vec<String>,
    left: usize,
    cut: bool,
}

impl Lines {
    /// Room for `bytes` of text in all, the closing notes included.
    pub fn new(bytes: usize) -> Self {
        Self {
            lines: Vec::new(),
            left: bytes.saturating_sub(NOTE_ROOM),
            cut: false,
        }
    }

    /// Keep `line` if it fits; false once one did not.
    pub fn push(&mut self, line: impl Into<String>) -> bool {
        if self.cut {
            return false;
        }
        let line = line.into();
        if line.len() + 1 > self.left {
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

    /// The kept lines, then the closing notes `closing` gives — told whether a line was left out
    /// — in the room kept for them.
    pub fn finish(mut self, closing: impl FnOnce(bool) -> Vec<String>) -> String {
        let mut room = NOTE_ROOM;
        for note in closing(self.cut) {
            if room < 2 {
                break;
            }
            let (note, _) = crate::ws::cut_text(&note, room - 1);
            room -= note.len() + 1;
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

    /// Whether `value` fits, spending its size (and a separator's) when it does. It is measured
    /// as it is written out, and the measuring stops as soon as it is past what is left.
    pub fn admit(&mut self, value: &Value) -> bool {
        if self.cut {
            return false;
        }
        let mut counter = Counter {
            bytes: 0,
            max: self.left,
        };
        if serde_json::to_writer(&mut counter, value).is_err() || counter.bytes >= self.left {
            self.cut = true;
            return false;
        }
        self.left -= counter.bytes + 1;
        true
    }

    /// Whether a value was left out.
    pub fn is_cut(&self) -> bool {
        self.cut
    }
}

/// Counts the bytes written to it, and refuses them once they pass `max`.
struct Counter {
    bytes: usize,
    max: usize,
}

impl io::Write for Counter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.bytes += buf.len();
        if self.bytes > self.max {
            return Err(io::Error::other("past the budget"));
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// Server-chosen names as they are written into an answer: whole up to [`NAME_BYTES`], cut and
/// ended with `…` past it. Remembers a cut, and counts the bytes it wrote — what building an
/// answer cost in names, kept or not.
#[derive(Debug, Default)]
pub struct Names {
    cut: bool,
    written: usize,
}

impl Names {
    /// `name` as written into an answer.
    pub fn show<'a>(&mut self, name: &'a str) -> Cow<'a, str> {
        let (head, cut) = crate::ws::cut_text(name, NAME_BYTES);
        self.written += head.len();
        if cut {
            self.cut = true;
            Cow::Owned(format!("{head}…"))
        } else {
            Cow::Borrowed(head)
        }
    }

    /// Whether a name was cut.
    pub fn any_cut(&self) -> bool {
        self.cut
    }

    /// Bytes of names written so far.
    pub fn written(&self) -> usize {
        self.written
    }
}

/// The note for an answer whose names were cut.
pub fn names_cut_note() -> String {
    format!(
        "(Names longer than {NAME_BYTES} bytes are cut and end in …, in the text and in --json.)"
    )
}

/// Schema nodes an answer may still visit: once they run out, the walk stops where it is.
#[derive(Debug)]
pub struct Visits {
    left: usize,
    used: usize,
    cut: bool,
}

impl Visits {
    pub fn new(nodes: usize) -> Self {
        Self {
            left: nodes,
            used: 0,
            cut: false,
        }
    }

    /// Visit one node; false, and nothing more is visited, once they ran out.
    fn take(&mut self) -> bool {
        if self.left == 0 {
            self.cut = true;
            return false;
        }
        self.left -= 1;
        self.used += 1;
        true
    }

    /// Whether the walk ran out of nodes.
    pub fn is_cut(&self) -> bool {
        self.cut
    }
}

/// What building one answer cost: the schema nodes it visited and the bytes of server-chosen
/// names it wrote (into the text and the data, kept or not). Both are bounded by the constants
/// above, whatever the schema.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cost {
    pub visits: usize,
    pub name_bytes: usize,
}

/// A message as a set member: equal as a descriptor (a pool and an index), hashed by the address
/// of the one copy of its name the pool keeps — so a server's long name is neither hashed nor
/// copied, however often the message is met.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Msg(MessageDescriptor);

impl Hash for Msg {
    fn hash<H: Hasher>(&self, state: &mut H) {
        std::ptr::hash(self.0.full_name().as_ptr(), state);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Names and labels. Every server-chosen name goes through [`Names::show`].
// ─────────────────────────────────────────────────────────────────────────────

/// `pkg.Service/Method`: the form `grpc call` takes.
pub fn method_path(m: &MethodDescriptor, names: &mut Names) -> String {
    format!(
        "{}/{}",
        names.show(m.parent_service().full_name()),
        names.show(m.name())
    )
}

/// `rpc pkg.Service/Method(pkg.Req) returns (stream pkg.Res)`.
pub fn signature(m: &MethodDescriptor, names: &mut Names) -> String {
    let stream = |s: bool| if s { "stream " } else { "" };
    format!(
        "rpc {}({}{}) returns ({}{})",
        method_path(m, names),
        stream(m.is_client_streaming()),
        names.show(m.input().full_name()),
        stream(m.is_server_streaming()),
        names.show(m.output().full_name())
    )
}

/// Whether `grpc call` can make this call.
pub fn is_unary(m: &MethodDescriptor) -> bool {
    !m.is_client_streaming() && !m.is_server_streaming()
}

/// A method as structured data.
pub fn method_data(m: &MethodDescriptor, names: &mut Names) -> Value {
    json!({
        "method": method_path(m, names),
        "input": names.show(m.input().full_name()),
        "output": names.show(m.output().full_name()),
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

/// A map field's key and value fields. A server's schema may mark a message as a map entry
/// without giving it both, so they are looked up, never assumed.
fn map_parts(f: &FieldDescriptor) -> Option<(FieldDescriptor, FieldDescriptor)> {
    match f.kind() {
        Kind::Message(entry) if f.is_map() => Some((entry.get_field(1)?, entry.get_field(2)?)),
        _ => None,
    }
}

/// A scalar's or a reference's name, with the JSON form when it is not the obvious one.
fn kind_label(kind: &Kind, names: &mut Names) -> String {
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
        Kind::Enum(e) => format!(
            "enum {} ({})",
            names.show(e.full_name()),
            enum_values(e, names, VALUES_BYTES)
        ),
        Kind::Message(m) => match well_known(m) {
            Some((form, _)) => format!("{} (JSON: {form})", m.full_name()),
            None => names.show(m.full_name()).into_owned(),
        },
    }
}

/// `A | B | C`: at most [`MAX_ENUM_VALUES`] values and about `max_bytes` of them (the first is
/// always there), the rest counted.
fn enum_values(e: &EnumDescriptor, names: &mut Names, max_bytes: usize) -> String {
    let mut shown = String::new();
    let mut count = 0;
    for v in e.values().take(MAX_ENUM_VALUES) {
        if count > 0 {
            if shown.len() + v.name().len().min(NAME_BYTES) > max_bytes {
                break;
            }
            shown.push_str(" | ");
        }
        shown.push_str(&names.show(v.name()));
        count += 1;
    }
    let more = e.values().len().saturating_sub(count);
    if more > 0 {
        shown.push_str(&format!(" | …{more} more"));
    }
    shown
}

/// Whether a field holds a list: a repeated field, or a map whose entry lacks its fields
/// ([`map_parts`]) and so is the list of entries it is on the wire.
fn is_repeated(f: &FieldDescriptor) -> bool {
    f.is_list() || f.is_map()
}

/// `repeated X`, `map<K, V>` or `X`.
fn type_label(f: &FieldDescriptor, names: &mut Names) -> String {
    if let Some((key, value)) = map_parts(f) {
        return format!(
            "map<{}, {}>",
            kind_label(&key.kind(), names),
            kind_label(&value.kind(), names)
        );
    }
    if is_repeated(f) {
        format!("repeated {}", kind_label(&f.kind(), names))
    } else {
        kind_label(&f.kind(), names)
    }
}

/// The real oneof a field belongs to (not proto3 `optional`'s synthetic one).
fn real_oneof(f: &FieldDescriptor) -> Option<OneofDescriptor> {
    f.containing_oneof().filter(|o| !o.is_synthetic())
}

/// One field line: `jsonName: type  [notes]`.
fn field_line(f: &FieldDescriptor, names: &mut Names) -> String {
    let mut notes = Vec::new();
    if f.json_name() != f.name() {
        notes.push(format!("proto name {}", names.show(f.name())));
    }
    if let Some(o) = real_oneof(f) {
        notes.push(format!("oneof {}: set at most one", names.show(o.name())));
    }
    let notes = if notes.is_empty() {
        String::new()
    } else {
        format!("  [{}]", notes.join("; "))
    };
    format!(
        "  {}: {}{notes}",
        names.show(f.json_name()),
        type_label(f, names)
    )
}

fn field_data(f: &FieldDescriptor, names: &mut Names) -> Value {
    json!({
        "name": names.show(f.json_name()),
        "protoName": names.show(f.name()),
        "type": type_label(f, names),
        "oneof": real_oneof(f).map(|o| names.show(o.name()).into_owned()),
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
    /// The first [`NOTE_NAMES`] messages written as `{}` where they would nest inside themselves.
    recursive: Vec<MessageDescriptor>,
    /// Every such message, counted once.
    recursive_seen: HashSet<Msg>,
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
            recursive: Vec::new(),
            recursive_seen: HashSet::new(),
        }
    }

    /// Spend one value of about `bytes`, and a visit; false, and nothing more is spent, once
    /// either is too much.
    fn spend(&mut self, visits: &mut Visits, bytes: usize) -> bool {
        if self.cut || self.nodes == 0 || bytes > self.bytes || !visits.take() {
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
    pub fn example(&mut self, visits: &mut Visits, message: &MessageDescriptor) -> Value {
        self.message(visits, message, EXAMPLE_DEPTH, &mut Vec::new())
    }

    fn message(
        &mut self,
        visits: &mut Visits,
        message: &MessageDescriptor,
        depth: usize,
        path: &mut Vec<MessageDescriptor>,
    ) -> Value {
        if let Some((_, value)) = well_known(message) {
            return value;
        }
        let mut map = Map::new();
        if path.contains(message) {
            if self.recursive_seen.insert(Msg(message.clone())) && self.recursive.len() < NOTE_NAMES
            {
                self.recursive.push(message.clone());
            }
            return Value::Object(map);
        }
        if depth == 0 {
            return Value::Object(map);
        }
        path.push(message.clone());
        for f in message.fields().take(MAX_FIELDS) {
            // A oneof is written as its first member.
            if let Some(o) = real_oneof(&f) {
                if o.fields().next().as_ref() != Some(&f) {
                    continue;
                }
            }
            // The key with its quotes, colon and comma, and room for a scalar or a wrapper.
            if !self.spend(visits, f.json_name().len() + 16) {
                break;
            }
            let value = self.field(visits, &f, depth - 1, path);
            map.insert(f.json_name().to_string(), value);
        }
        path.pop();
        Value::Object(map)
    }

    fn field(
        &mut self,
        visits: &mut Visits,
        f: &FieldDescriptor,
        depth: usize,
        path: &mut Vec<MessageDescriptor>,
    ) -> Value {
        if let Some((key, value)) = map_parts(f) {
            let key = match key.kind() {
                Kind::String => "key",
                Kind::Bool => "true",
                _ => "0",
            };
            let mut m = Map::new();
            m.insert(
                key.to_string(),
                self.kind(visits, &value.kind(), depth, path),
            );
            return Value::Object(m);
        }
        let one = self.kind(visits, &f.kind(), depth, path);
        if is_repeated(f) {
            json!([one])
        } else {
            one
        }
    }

    fn kind(
        &mut self,
        visits: &mut Visits,
        kind: &Kind,
        depth: usize,
        path: &mut Vec<MessageDescriptor>,
    ) -> Value {
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
                Some(v) if self.spend(visits, v.name().len() + 2) => json!(v.name()),
                Some(v) => json!(v.number()),
                None => json!(0),
            },
            Kind::Message(m) => self.message(visits, m, depth, path),
        }
    }

    /// Messages written as `{}` where they would nest inside themselves, counted once each.
    fn recursive_count(&self) -> usize {
        self.recursive_seen.len()
    }

    /// What the examples left out, as sentences for the text.
    fn notes(&self, names: &mut Names) -> Vec<String> {
        let mut notes = Vec::new();
        if !self.recursive.is_empty() {
            let shown: Vec<String> = self
                .recursive
                .iter()
                .map(|m| names.show(m.full_name()).into_owned())
                .collect();
            let more = self.recursive_count().saturating_sub(shown.len());
            let more = if more > 0 {
                format!(" and {more} more")
            } else {
                String::new()
            };
            notes.push(format!(
                "(Recursive: {}{more} {}; the example writes {{}} where a message would nest \
                 inside itself.)",
                shown.join(", "),
                if self.recursive_count() == 1 {
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

/// Queue the message a field of `kind` refers to, to be spelled out once: not a well-known type
/// (its form is in the field line), and for a map, its value type (nobody writes the entry).
fn enqueue(
    queue: &mut VecDeque<MessageDescriptor>,
    queued: &mut HashSet<Msg>,
    f: &FieldDescriptor,
) {
    let kind = match map_parts(f) {
        Some((_, value)) => value.kind(),
        None => f.kind(),
    };
    enqueue_kind(queue, queued, kind);
}

fn enqueue_kind(queue: &mut VecDeque<MessageDescriptor>, queued: &mut HashSet<Msg>, kind: Kind) {
    if let Kind::Message(m) = kind {
        if well_known(&m).is_none() && queued.insert(Msg(m.clone())) {
            queue.push_back(m);
        }
    }
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

/// The note for an answer whose walk ran out of [`MAX_VISITS`].
fn walk_cut_note() -> String {
    format!(
        "(The schema is too large to walk whole: this description stopped after {MAX_VISITS} \
         schema nodes; describe one method or message by name.)"
    )
}

/// The closing notes of a description: the text's cut, the walk's, the names'.
fn closing_notes(text_cut: bool, data_cut: bool, walk_cut: bool, names_cut: bool) -> Vec<String> {
    let mut notes = Vec::new();
    if text_cut {
        notes.push(text_cut_note(data_cut));
    }
    if walk_cut {
        notes.push(walk_cut_note());
    }
    if names_cut {
        notes.push(names_cut_note());
    }
    notes
}

/// The description of what `found` names: text for the agent, and the same as data, both
/// bounded (see the module docs) and each saying what it left out.
pub fn describe(found: &Found) -> (String, Value) {
    let (text, data, _) = describe_costed(found);
    (text, data)
}

/// [`describe`], and what it cost to build.
pub fn describe_costed(found: &Found) -> (String, Value, Cost) {
    let mut names = Names::default();
    let mut visits = Visits::new(MAX_VISITS);
    let (text, data) = match found {
        Found::Enum(e) => describe_enum(e, &mut names, &mut visits),
        _ => describe_messages(found, &mut names, &mut visits),
    };
    let cost = Cost {
        visits: visits.used,
        name_bytes: names.written(),
    };
    (text, data, cost)
}

/// An enum: its values, in order.
fn describe_enum(e: &EnumDescriptor, names: &mut Names, visits: &mut Visits) -> (String, Value) {
    let mut text = Lines::new(TEXT_BYTES);
    text.push(format!(
        "enum {} {{ {} }}",
        names.show(e.full_name()),
        enum_values(e, names, MAX_ENUM_VALUES * (NAME_BYTES + 8))
    ));
    text.push("In JSON, use the value's name as a string.");
    let mut data = DataBudget::new(DATA_BYTES - ENVELOPE_ROOM);
    let name = names.show(e.full_name()).into_owned();
    data.admit(&json!(name));
    let mut values = Vec::new();
    for v in e.values().take(MAX_ENUM_VALUES) {
        if data.is_cut() || !visits.take() {
            break;
        }
        let value = json!({"name": names.show(v.name()), "number": v.number()});
        if !data.admit(&value) {
            break;
        }
        values.push(value);
    }
    let more = e.values().len().saturating_sub(values.len());
    let (data_cut, walk_cut, names_cut) = (data.is_cut(), visits.is_cut(), names.any_cut());
    (
        text.finish(|text_cut| closing_notes(text_cut, data_cut, walk_cut, names_cut)),
        json!({
            "enum": name,
            "values": values,
            "moreValues": more,
            "namesCut": names_cut,
            "walkCut": walk_cut,
            "truncated": data_cut || walk_cut || names_cut,
        }),
    )
}

/// A service, a method or a message: the methods, then the messages they take and return,
/// breadth first, each checked against the budgets before it is built.
fn describe_messages(found: &Found, names: &mut Names, visits: &mut Visits) -> (String, Value) {
    let (methods, total_methods): (Vec<MethodDescriptor>, usize) = match found {
        Found::Service(s) => (s.methods().take(MAX_METHODS).collect(), s.methods().len()),
        Found::Method(m) => (vec![m.clone()], 1),
        Found::Message(_) | Found::Enum(_) => (Vec::new(), 0),
    };
    let more_methods = total_methods - methods.len();

    // Each example is built once, from one budget, and used for the text and the data alike.
    let mut examples = Examples::default();
    let mut built: Vec<(String, Value)> = Vec::new();
    match found {
        Found::Message(m) => {
            let example = examples.example(visits, m);
            built.push((names.show(m.full_name()).into_owned(), example));
        }
        _ => {
            for m in methods.iter().filter(|m| is_unary(m)) {
                let example = examples.example(visits, &m.input());
                built.push((method_path(m, names), example));
            }
        }
    }

    // The data: the methods (with their examples) first, as what an agent calls; then the
    // messages, while the budget lasts.
    let mut data = DataBudget::new(DATA_BYTES - ENVELOPE_ROOM);
    let mut unary_examples = built.iter().map(|(_, v)| v);
    let mut method_out = Vec::new();
    for m in &methods {
        if data.is_cut() {
            break;
        }
        let mut d = method_data(m, names);
        if is_unary(m) {
            if let Some(example) = unary_examples.next() {
                d["requestExample"] = example.clone();
            }
        }
        if !data.admit(&d) {
            break;
        }
        method_out.push(d);
    }
    let message_example = match (found, built.first()) {
        (Found::Message(_), Some((_, v))) if data.admit(v) => v.clone(),
        _ => Value::Null,
    };

    let mut text = Lines::new(TEXT_BYTES);
    if let Found::Service(s) = found {
        text.push(format!(
            "service {} ({} method{})",
            names.show(s.full_name()),
            total_methods,
            if total_methods == 1 { "" } else { "s" }
        ));
    }
    for m in &methods {
        if text.is_cut() {
            break;
        }
        text.push(signature(m, names));
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

    // The messages, breadth first from what the methods take and return (or the message named),
    // each spelled out once. The walk is done as the messages are written, so it stops with them.
    let mut queue = VecDeque::new();
    let mut queued = HashSet::new();
    match found {
        Found::Message(m) => enqueue_kind(&mut queue, &mut queued, Kind::Message(m.clone())),
        _ => {
            for m in &methods {
                enqueue_kind(&mut queue, &mut queued, Kind::Message(m.input()));
                enqueue_kind(&mut queue, &mut queued, Kind::Message(m.output()));
            }
        }
    }
    let mut listed = 0;
    let mut messages_cut = false;
    let mut message_data = Vec::new();
    while let Some(m) = queue.pop_front() {
        if text.is_cut() && data.is_cut() {
            break;
        }
        if listed == MAX_MESSAGES {
            messages_cut = true;
            break;
        }
        if !visits.take() {
            break;
        }
        listed += 1;
        let more = m.fields().len().saturating_sub(MAX_FIELDS);
        let name = names.show(m.full_name()).into_owned();
        if !text.is_cut() {
            text.push(String::new());
            text.push(format!("message {name} {{"));
        }
        // The message's entry is admitted before any field is built, then each field on its
        // own: nothing is built past the budget.
        let in_data = data.admit(&json!({"name": name, "fields": [], "moreFields": more}));
        let mut fields = Vec::new();
        for f in m.fields().take(MAX_FIELDS) {
            if text.is_cut() && (!in_data || data.is_cut()) {
                break;
            }
            if !visits.take() {
                break;
            }
            if !text.is_cut() {
                text.push(field_line(&f, names));
            }
            if in_data && !data.is_cut() {
                let d = field_data(&f, names);
                if data.admit(&d) {
                    fields.push(d);
                }
            }
            enqueue(&mut queue, &mut queued, &f);
        }
        if more > 0 && !text.is_cut() {
            text.push(format!("  …{more} more fields not listed"));
        }
        if !text.is_cut() {
            text.push("}");
        }
        if in_data {
            message_data.push(json!({"name": name, "fields": fields, "moreFields": more}));
        }
    }
    if messages_cut {
        text.push(String::new());
        text.push(format!(
            "…only the first {MAX_MESSAGES} messages are spelled out; describe a message by name \
             for the rest."
        ));
    }

    for (name, value) in &built {
        if text.is_cut() {
            break;
        }
        text.push(String::new());
        text.push(format!(
            "Example JSON for {name} (every field is optional; drop what you do not need):"
        ));
        text.push(value.to_string());
    }
    if !text.is_cut() {
        let notes = examples.notes(names);
        if !notes.is_empty() {
            text.push(String::new());
            for note in notes {
                text.push(note);
            }
        }
    }
    let mut recursive = Vec::new();
    for m in &examples.recursive {
        let name = json!(names.show(m.full_name()));
        if !data.admit(&name) {
            break;
        }
        recursive.push(name);
    }

    let (data_cut, walk_cut, names_cut) = (data.is_cut(), visits.is_cut(), names.any_cut());
    let json = json!({
        "methods": method_out,
        "moreMethods": more_methods,
        "messages": message_data,
        "messagesCut": messages_cut,
        "example": message_example,
        "exampleCut": examples.cut,
        "recursive": recursive,
        "moreRecursive": examples.recursive_count() - recursive.len(),
        "namesCut": names_cut,
        "walkCut": walk_cut,
        "truncated": data_cut || walk_cut || names_cut,
    });
    (
        text.finish(|text_cut| closing_notes(text_cut, data_cut, walk_cut, names_cut))
            .trim_start()
            .to_string(),
        json,
    )
}
