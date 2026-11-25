//! The built-in API client's gRPC engine — **native and in-process** (no `grpcurl`
//! shell-out).
//!
//! The requirement: the gRPC client must NOT require the user to install any
//! external binary. So instead of shelling out to `grpcurl`, we speak gRPC directly
//! from the Rust core with `tonic` (HTTP/2 transport) + `prost-reflect` (a runtime
//! `DescriptorPool` + `DynamicMessage` ⇄ canonical-protobuf-JSON), which makes
//! **arbitrary services chosen at runtime** callable with no codegen. Descriptors are
//! pulled over the standard **gRPC server-reflection** protocol (`tonic-reflection`'s
//! generated client, `grpc.reflection.v1` with a `v1alpha` fallback).
//!
//! The pleasant surprise: `tonic 0.14` shares the exact hyper 1.x + h2 + tower stack that
//! `reqwest`/`ws.rs` already resolve, so this adds **no second HTTP/2 stack** and TLS
//! stays on rustls — no native-tls/OpenSSL — matching the `http.rs` hygiene.
//!
//! **TLS** follows the app-wide policy in [`crate::tls`]: the single `ring`
//! crypto provider (`tls-ring`, now genuinely the only backend in the binary), and a
//! `grpcs://` root store that is the **union of the operating system's trust anchors and
//! the bundled Mozilla set** (`with_enabled_roots()` over `tls-native-roots` +
//! `tls-webpki-roots`). So an internal `grpcs://` behind a corporate CA verifies, exactly
//! as `http_send` and `ws_connect` do.
//!
//! **Contract, mirroring `http.rs`:** a **non-OK gRPC `Status` is a normal response**
//! ([`GrpcResponse`] with `statusCode != 0`), not a rejected promise — only a failure
//! to *connect* (dial/TLS/reflection) is `Err`. The command surface + serde wire types
//! are **pinned** (the frontend builds against exactly these). Native gRPC is always
//! available (no external tool), so there is no probe/degrade command — unlike a
//! `grpcurl` shell-out, which would need one.
//!
//! The risky logic is kept pure and unit-testable **without a server**: endpoint→URI
//! building, the `Code`→(number, name) mapping over all 17 codes, metadata→header
//! construction, and the JSON ⇄ `DynamicMessage` round-trip against a hand-built
//! descriptor. The reflection + live-call paths need a real server and are exercised in
//! the running app; a couple of `#[ignore]`d integration tests
//! document how.
//!
//! **Scope (v1):** unary + reflection only. `.proto`/protoset upload (protox) and all
//! streaming are DEFERRED — clear TODO seams are marked below, not implemented.
//!
//! **Network view.** One `grpc` flow per `grpc_send`, recorded through
//! [`crate::netcap::record`]: pending from the start with path `/pkg.Service/Method` and the
//! request headers as tonic sends them (the user's metadata, lowercased, then `te: trailers`
//! and `content-type: application/grpc`; tonic's own `user-agent` is not reconstructed), the
//! request as its canonical JSON once parsed, then either status 200 + `grpcStatus 0` + the
//! response JSON, or the gRPC status with its trailers (`done` — a status is a response), or
//! `error` for a dial/reflection/transport failure or a deadline that passed. The reflection
//! round-trips that resolve the method are not separate rows. Sizes are protobuf payload bytes
//! (see the record module).
//!
//! **Rust API.** The two commands are thin over [`Reflection`] (a reflection session and its
//! descriptor pool) and [`call`] (a recorded unary call with a deadline, returning the server's
//! metadata too). An agent's `grpc_services` / `grpc_describe` / `grpc_call` tools
//! (`agent_ctl::commands::stream`) use the same two, so a call an agent makes is the call the
//! console makes, recorded the same way.

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use prost::Message as _;
use prost_reflect::{DescriptorPool, DynamicMessage, MessageDescriptor};
use prost_types::FileDescriptorProto;
use serde::{Deserialize, Serialize};
use tonic::codec::{Codec, DecodeBuf, Decoder, EncodeBuf, Encoder};
use tonic::codegen::http::uri::PathAndQuery;
use tonic::metadata::{AsciiMetadataKey, AsciiMetadataValue, MetadataMap};
use tonic::transport::{Channel, ClientTlsConfig};
use tonic::{Code, Status};
use tonic_reflection::pb;

use crate::netcap::headers::capture_headers;
use crate::netcap::record::{Flow, Tap};
use crate::netcap::FlowProto;

/// Each request's deadline on a channel (the reflection round trips and the call alike) when
/// the caller set no limit of its own. A wedged endpoint is bounded rather than hanging the UI.
/// Mirrors `http.rs`'s `REQUEST_TIMEOUT`.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// Dial deadline — a stuck TCP/TLS handshake is bounded separately from the call.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

/// How far past a caller's whole-call limit the channel's own per-request timeout is set.
const LIMIT_GRACE: Duration = Duration::from_secs(1);

/// The channel's per-request timeout: `default` (the app passes [`REQUEST_TIMEOUT`]), or, for a
/// call with a whole-call `limit` of its own, just past that limit. A channel timeout under the
/// limit would cut the call short of the deadline its caller was promised; past it, the caller's
/// deadline — which started first, before the dial — is always the one that fires.
fn channel_timeout(limit: Option<Duration>, default: Duration) -> Duration {
    limit.map_or(default, |limit| limit + LIMIT_GRACE)
}

/// Response-size sanity cap for a decoded message (mirrors `http.rs`'s body cap in
/// spirit). tonic's default is 4 MiB; we allow more so large reflected descriptors and
/// fat responses still come through, but a runaway response can't exhaust memory.
const MAX_DECODING_MESSAGE_BYTES: usize = 16 * 1024 * 1024;

/// Descriptor files one reflection session fetches at most — a request counts as one even when
/// its answer holds none — and their bytes. A server answers each `import` with whatever file it
/// likes, which may import one more, so following imports is bounded here rather than by how long
/// the server keeps answering.
pub const MAX_REFLECTED_FILES: usize = 500;
pub const MAX_REFLECTED_BYTES: usize = 16 * 1024 * 1024;

// ─────────────────────────────────────────────────────────────────────────────
// Wire contract (PINNED — the frontend builds against exactly these; camelCase).
// ─────────────────────────────────────────────────────────────────────────────

/// One metadata entry (a gRPC header). `value` may be a live secret (token). Applied to
/// the request as an HTTP/2 header, in-process — it never touches a process argv.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrpcHeader {
    pub name: String,
    pub value: String,
}

/// A unary request. `endpoint` is `host:port` (a scheme is added per `plaintext`);
/// `service`/`method` name the RPC; the `message` is the request body as JSON text.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrpcRequest {
    pub endpoint: String,
    pub service: String,
    pub method: String,
    /// Request message as JSON text (empty/blank is treated as `{}`).
    pub message: String,
    pub metadata: Vec<GrpcHeader>,
    /// `true` → h2c cleartext (`http://`); `false` → TLS (`https://`).
    pub plaintext: bool,
}

/// A unary response. A non-OK gRPC status resolves here (like a 404 in `http.rs`),
/// carrying `statusCode != 0`, `statusName`, and `error`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GrpcResponse {
    /// Response message as JSON text. Empty on a non-OK status.
    pub message: String,
    /// Numeric gRPC status code (`0` = OK, else `1..=16`).
    pub status_code: u32,
    /// Canonical status name, e.g. `"OK"`, `"NotFound"`, `"Unavailable"`.
    pub status_name: String,
    /// Error message on a non-OK status (the gRPC status message); `None` on OK.
    pub error: Option<String>,
}

/// A gRPC method, from reflection.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GrpcMethod {
    pub name: String,
}

/// One reflected service.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GrpcService {
    pub name: String,
    pub methods: Vec<GrpcMethod>,
}

/// The reflected schema of a server (all services + their methods).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GrpcSchema {
    pub services: Vec<GrpcService>,
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure logic (a): endpoint → URI (plaintext vs TLS scheme).
// ─────────────────────────────────────────────────────────────────────────────

/// Turn a `host:port` (grpcurl-style) endpoint into a tonic URI. An explicit scheme is
/// preserved; otherwise `http://` (plaintext / h2c) or `https://` (TLS) is prepended.
fn endpoint_uri(endpoint: &str, plaintext: bool) -> String {
    let e = endpoint.trim();
    if e.contains("://") {
        e.to_string()
    } else if plaintext {
        format!("http://{e}")
    } else {
        format!("https://{e}")
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure logic (b): tonic `Code` → (numeric code, canonical name).
// ─────────────────────────────────────────────────────────────────────────────

/// The numeric gRPC status code (`0..=16`) for a tonic [`Code`].
fn code_number(code: Code) -> u32 {
    i32::from(code) as u32
}

/// The full 17-code gRPC status table (`0..=16`), using the Go/grpcurl canonical names
/// (note `Canceled`, one `l`) the frontend has always displayed — kept identical so the
/// switch from grpcurl to native is invisible to the UI. Unknown numbers → `"Unknown"`.
fn status_name_for(code: u32) -> &'static str {
    match code {
        0 => "OK",
        1 => "Canceled",
        2 => "Unknown",
        3 => "InvalidArgument",
        4 => "DeadlineExceeded",
        5 => "NotFound",
        6 => "AlreadyExists",
        7 => "PermissionDenied",
        8 => "ResourceExhausted",
        9 => "FailedPrecondition",
        10 => "Aborted",
        11 => "OutOfRange",
        12 => "Unimplemented",
        13 => "Internal",
        14 => "Unavailable",
        15 => "DataLoss",
        16 => "Unauthenticated",
        _ => "Unknown",
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure logic (c): metadata (gRPC headers) → tonic MetadataMap.
// ─────────────────────────────────────────────────────────────────────────────

/// Build a [`MetadataMap`] from the request headers. Keys are lowercased (gRPC requires
/// it); duplicates are appended (not overwritten). A bad key/value is a hard error so
/// the user learns why a header didn't take.
///
/// v1 handles **ASCII** metadata only. Binary metadata (`-bin` keys, which carry
/// base64-encoded bytes) is rejected with a clear message — a DEFER seam.
fn build_metadata(headers: &[GrpcHeader]) -> Result<MetadataMap, String> {
    let mut map = MetadataMap::new();
    for h in headers {
        let name = h.name.trim().to_ascii_lowercase();
        // TODO(defer): support binary (`-bin`) metadata (base64 → BinaryMetadataValue).
        if name.ends_with("-bin") {
            return Err(format!(
                "binary metadata ({:?}) is not supported yet",
                h.name
            ));
        }
        let key = AsciiMetadataKey::from_bytes(name.as_bytes())
            .map_err(|_| format!("invalid metadata key: {:?}", h.name))?;
        let value = AsciiMetadataValue::try_from(h.value.as_str())
            .map_err(|_| format!("invalid metadata value for {:?}", h.name))?;
        map.append(key, value);
    }
    Ok(map)
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure logic (d): JSON ⇄ DynamicMessage (canonical protobuf-JSON mapping).
// ─────────────────────────────────────────────────────────────────────────────

/// Parse the user's request JSON into a [`DynamicMessage`] for `descriptor`. A blank
/// message is treated as an empty message (`{}`). Trailing garbage after the JSON is a
/// hard error.
fn json_to_dynamic(descriptor: MessageDescriptor, json: &str) -> Result<DynamicMessage, String> {
    let trimmed = json.trim();
    let source = if trimmed.is_empty() { "{}" } else { trimmed };
    let mut de = serde_json::Deserializer::from_str(source);
    let msg = DynamicMessage::deserialize(descriptor, &mut de)
        .map_err(|e| format!("invalid request JSON: {e}"))?;
    de.end().map_err(|e| format!("invalid request JSON: {e}"))?;
    Ok(msg)
}

/// Serialize a response [`DynamicMessage`] to its canonical protobuf-JSON text.
fn dynamic_to_json(msg: &DynamicMessage) -> Result<String, String> {
    let mut buf = Vec::new();
    let mut ser = serde_json::Serializer::new(&mut buf);
    msg.serialize(&mut ser)
        .map_err(|e| format!("failed to encode response JSON: {e}"))?;
    String::from_utf8(buf).map_err(|e| format!("response JSON was not valid UTF-8: {e}"))
}

// ─────────────────────────────────────────────────────────────────────────────
// The dynamic codec — the crux of a codegen-free gRPC client.
// ─────────────────────────────────────────────────────────────────────────────

/// A tonic [`Codec`] over [`DynamicMessage`]. Encoding needs no descriptor (a
/// `DynamicMessage` carries its own, and implements `prost::Message`); decoding needs
/// the method's **output** descriptor to construct the right message shape.
#[derive(Debug, Clone)]
struct DynamicCodec {
    output: MessageDescriptor,
}

/// Encodes an outbound request [`DynamicMessage`] (uses its embedded descriptor).
#[derive(Debug, Clone)]
struct DynamicEncoder;

/// Decodes an inbound response [`DynamicMessage`] against the output descriptor.
#[derive(Debug, Clone)]
struct DynamicDecoder {
    output: MessageDescriptor,
}

impl Codec for DynamicCodec {
    type Encode = DynamicMessage;
    type Decode = DynamicMessage;
    type Encoder = DynamicEncoder;
    type Decoder = DynamicDecoder;

    fn encoder(&mut self) -> Self::Encoder {
        DynamicEncoder
    }

    fn decoder(&mut self) -> Self::Decoder {
        DynamicDecoder {
            output: self.output.clone(),
        }
    }
}

impl Encoder for DynamicEncoder {
    type Item = DynamicMessage;
    type Error = Status;

    fn encode(&mut self, item: Self::Item, dst: &mut EncodeBuf<'_>) -> Result<(), Self::Error> {
        item.encode(dst)
            .map_err(|e| Status::internal(format!("failed to encode request message: {e}")))
    }
}

impl Decoder for DynamicDecoder {
    type Item = DynamicMessage;
    type Error = Status;

    fn decode(&mut self, src: &mut DecodeBuf<'_>) -> Result<Option<Self::Item>, Self::Error> {
        // tonic hands us exactly one message's bytes; `DynamicMessage::decode` consumes
        // the whole buffer, merging into a fresh message of the output shape.
        DynamicMessage::decode(self.output.clone(), src)
            .map(Some)
            .map_err(|e| Status::internal(format!("failed to decode response message: {e}")))
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Transport: connect a tonic Channel (plaintext h2c or rustls TLS).
// ─────────────────────────────────────────────────────────────────────────────

/// Dial the endpoint and return a connected [`Channel`] whose requests time out after
/// `request_timeout`. TLS (rustls, `ring`, OS ∪ Mozilla roots) unless `plaintext`. A dial/TLS
/// failure is `Err`.
async fn connect_channel(
    endpoint: &str,
    plaintext: bool,
    request_timeout: Duration,
) -> Result<Channel, String> {
    // One provider for the whole process. tonic checks
    // `CryptoProvider::get_default()` before falling back to its own `tls-ring` feature,
    // so installing here is what keeps `grpcs://` provably on the same backend as
    // `http_send`/`ws_connect`. Idempotent; also done at startup in `run()`.
    crate::tls::install_crypto_provider();

    let uri = endpoint_uri(endpoint, plaintext);
    let mut ep = Channel::from_shared(uri).map_err(|e| format!("invalid endpoint: {e}"))?;
    if !plaintext {
        // TODO(defer): custom CA / mTLS / skip-verify. Until then `with_enabled_roots()`
        // is what stops an internal `grpcs://` behind a corporate CA from being
        // unreachable: with `tls-native-roots` + `tls-webpki-roots` both on, it unions the
        // OS trust anchors with the bundled Mozilla set (see `crate::tls`) — the
        // same trust story as `http.rs`/`ws.rs`, still no native-tls/OpenSSL.
        let tls = ClientTlsConfig::new().with_enabled_roots();
        ep = ep
            .tls_config(tls)
            .map_err(|e| format!("TLS configuration failed: {e}"))?;
    }
    ep = ep.connect_timeout(CONNECT_TIMEOUT).timeout(request_timeout);
    ep.connect()
        .await
        .map_err(|e| format!("could not connect to {endpoint}: {e}"))
}

// ─────────────────────────────────────────────────────────────────────────────
// Reflection: pull descriptors over grpc.reflection.v1 (fallback v1alpha).
// ─────────────────────────────────────────────────────────────────────────────

/// A reflection query independent of the wire version.
enum FileQuery {
    /// Find the file that declares a fully-qualified symbol (a service).
    Symbol(String),
    /// Find a file by its proto path (for chasing `import` dependencies).
    Filename(String),
}

/// Error from a reflection round-trip, distinguishing "this reflection version isn't
/// implemented" (→ try the older one) from everything else.
enum ReflectError {
    Unimplemented,
    Other(String),
}

impl ReflectError {
    fn into_string(self) -> String {
        match self {
            ReflectError::Unimplemented => "server does not implement gRPC reflection".to_string(),
            ReflectError::Other(e) => e,
        }
    }
}

fn status_to_reflect_err(status: Status) -> ReflectError {
    if status.code() == Code::Unimplemented {
        ReflectError::Unimplemented
    } else {
        ReflectError::Other(format!("reflection failed: {}", status.message()))
    }
}

/// Generate the two per-wire-version reflection drivers (`grpc.reflection.v1` and
/// `v1alpha`). The generated `list_services`/`fetch_files` return only primitive types
/// (`Vec<String>` / raw descriptor bytes), so the version-specific generated protobuf
/// types never leak past this macro — the caller ([`Reflect`]) just dispatches.
///
/// Each call opens a fresh bidi `ServerReflectionInfo` stream, sends one request, and
/// reads the single matching response.
macro_rules! reflection_driver {
    ($ver:ident, $list_fn:ident, $files_fn:ident) => {
        async fn $list_fn(
            client: &mut pb::$ver::server_reflection_client::ServerReflectionClient<Channel>,
        ) -> Result<Vec<String>, ReflectError> {
            use pb::$ver::server_reflection_request::MessageRequest;
            use pb::$ver::server_reflection_response::MessageResponse;
            use pb::$ver::ServerReflectionRequest;

            let request = ServerReflectionRequest {
                host: String::new(),
                message_request: Some(MessageRequest::ListServices(String::new())),
            };
            let mut stream = client
                .server_reflection_info(futures_util::stream::iter(vec![request]))
                .await
                .map_err(status_to_reflect_err)?
                .into_inner();
            match stream.message().await.map_err(status_to_reflect_err)? {
                Some(resp) => match resp.message_response {
                    Some(MessageResponse::ListServicesResponse(list)) => {
                        Ok(list.service.into_iter().map(|s| s.name).collect())
                    }
                    Some(MessageResponse::ErrorResponse(e)) => Err(ReflectError::Other(format!(
                        "reflection error ({}): {}",
                        e.error_code, e.error_message
                    ))),
                    _ => Err(ReflectError::Other(
                        "unexpected reflection response to ListServices".to_string(),
                    )),
                },
                None => Err(ReflectError::Other(
                    "reflection stream produced no response".to_string(),
                )),
            }
        }

        async fn $files_fn(
            client: &mut pb::$ver::server_reflection_client::ServerReflectionClient<Channel>,
            query: &FileQuery,
        ) -> Result<Vec<Vec<u8>>, ReflectError> {
            use pb::$ver::server_reflection_request::MessageRequest;
            use pb::$ver::server_reflection_response::MessageResponse;
            use pb::$ver::ServerReflectionRequest;

            let message_request = match query {
                FileQuery::Symbol(s) => MessageRequest::FileContainingSymbol(s.clone()),
                FileQuery::Filename(f) => MessageRequest::FileByFilename(f.clone()),
            };
            let request = ServerReflectionRequest {
                host: String::new(),
                message_request: Some(message_request),
            };
            let mut stream = client
                .server_reflection_info(futures_util::stream::iter(vec![request]))
                .await
                .map_err(status_to_reflect_err)?
                .into_inner();
            match stream.message().await.map_err(status_to_reflect_err)? {
                Some(resp) => match resp.message_response {
                    Some(MessageResponse::FileDescriptorResponse(f)) => Ok(f.file_descriptor_proto),
                    Some(MessageResponse::ErrorResponse(e)) => Err(ReflectError::Other(format!(
                        "reflection error ({}): {}",
                        e.error_code, e.error_message
                    ))),
                    _ => Err(ReflectError::Other(
                        "unexpected reflection response to a file query".to_string(),
                    )),
                },
                None => Err(ReflectError::Other(
                    "reflection stream produced no response".to_string(),
                )),
            }
        }
    };
}

reflection_driver!(v1, list_services_v1, fetch_files_v1);
reflection_driver!(v1alpha, list_services_v1alpha, fetch_files_v1alpha);

/// A reflection client bound to a wire version, negotiated once per connection.
enum Reflect {
    V1(pb::v1::server_reflection_client::ServerReflectionClient<Channel>),
    V1Alpha(pb::v1alpha::server_reflection_client::ServerReflectionClient<Channel>),
}

impl Reflect {
    /// Negotiate the reflection version: probe `v1` with a `ListServices`; if the server
    /// reports it `Unimplemented`, fall back to `v1alpha`. Any other failure is fatal.
    async fn negotiate(channel: Channel) -> Result<Reflect, String> {
        let mut v1 = pb::v1::server_reflection_client::ServerReflectionClient::new(channel.clone());
        match list_services_v1(&mut v1).await {
            Ok(_) => Ok(Reflect::V1(v1)),
            Err(ReflectError::Unimplemented) => Ok(Reflect::V1Alpha(
                pb::v1alpha::server_reflection_client::ServerReflectionClient::new(channel),
            )),
            Err(other) => Err(other.into_string()),
        }
    }

    async fn list_services(&mut self) -> Result<Vec<String>, ReflectError> {
        match self {
            Reflect::V1(c) => list_services_v1(c).await,
            Reflect::V1Alpha(c) => list_services_v1alpha(c).await,
        }
    }

    async fn fetch_files(&mut self, query: &FileQuery) -> Result<Vec<Vec<u8>>, ReflectError> {
        match self {
            Reflect::V1(c) => fetch_files_v1(c, query).await,
            Reflect::V1Alpha(c) => fetch_files_v1alpha(c, query).await,
        }
    }
}

/// A server-reflection session on one connection, and the descriptors it has loaded so far in
/// one pool. What [`grpc_reflect`], [`grpc_send`] and the agent tools
/// (`agent_ctl::commands::stream`) share, so a schema means the same thing to all of them.
pub struct Reflection {
    reflect: Reflect,
    pool: DescriptorPool,
    fetched: Fetched,
}

/// What a reflection session has fetched, against [`MAX_REFLECTED_FILES`] and
/// [`MAX_REFLECTED_BYTES`].
#[derive(Debug, Default)]
struct Fetched {
    files: usize,
    bytes: usize,
    /// A limit was reached: nothing more is fetched.
    stopped: bool,
}

impl Fetched {
    /// Count one request about to go out; refused once the limit is reached.
    fn request(&mut self) -> Result<(), String> {
        if self.stopped || self.files >= MAX_REFLECTED_FILES {
            return Err(self.stop());
        }
        self.files += 1;
        Ok(())
    }

    /// Count the files of one answer (its request already counted one); refused past a limit.
    fn answer(&mut self, raw_files: &[Vec<u8>]) -> Result<(), String> {
        self.files += raw_files.len().saturating_sub(1);
        self.bytes = raw_files
            .iter()
            .fold(self.bytes, |sum, f| sum.saturating_add(f.len()));
        if self.files > MAX_REFLECTED_FILES || self.bytes > MAX_REFLECTED_BYTES {
            return Err(self.stop());
        }
        Ok(())
    }

    fn stop(&mut self) -> String {
        self.stopped = true;
        format!(
            "reflection stopped: the server's descriptors go past what one reflection loads \
             ({MAX_REFLECTED_FILES} files or {} MiB)",
            MAX_REFLECTED_BYTES / (1024 * 1024)
        )
    }
}

impl Reflection {
    /// Dial `endpoint` (TLS unless `plaintext`) and negotiate the reflection version (`v1`,
    /// else `v1alpha`).
    pub async fn connect(endpoint: &str, plaintext: bool) -> Result<Self, String> {
        Self::over(connect_channel(endpoint, plaintext, REQUEST_TIMEOUT).await?).await
    }

    /// The same, over a channel that is already connected.
    async fn over(channel: Channel) -> Result<Self, String> {
        Ok(Self {
            reflect: Reflect::negotiate(channel).await?,
            pool: DescriptorPool::new(),
            fetched: Fetched::default(),
        })
    }

    /// Every service the server lists, fully qualified.
    pub async fn list_services(&mut self) -> Result<Vec<String>, String> {
        self.reflect
            .list_services()
            .await
            .map_err(|e| e.into_string())
    }

    /// Load the file that declares `symbol` (a service, method, message or enum, fully
    /// qualified), with its imports, into [`Self::pool`] — nothing to fetch when an earlier load
    /// brought it. At most [`MAX_REFLECTED_FILES`] files ([`MAX_REFLECTED_BYTES`]) are fetched in
    /// one session; past that every load fails, saying so.
    pub async fn load(&mut self, symbol: &str) -> Result<(), String> {
        let known = self.pool.get_service_by_name(symbol).is_some()
            || self.pool.get_message_by_name(symbol).is_some()
            || self.pool.get_enum_by_name(symbol).is_some();
        if known {
            return Ok(());
        }
        build_pool_into(&mut self.reflect, symbol, &mut self.pool, &mut self.fetched).await
    }

    /// Whether this session reached its limit, so a load failed for that reason.
    pub fn stopped(&self) -> bool {
        self.fetched.stopped
    }

    /// Everything loaded so far.
    pub fn pool(&self) -> &DescriptorPool {
        &self.pool
    }
}

/// Turn a fully-reflected [`DescriptorPool`] into the pinned [`GrpcSchema`] (services +
/// their method names).
fn schema_from_pool(pool: &DescriptorPool, service_names: &[String]) -> GrpcSchema {
    let services = service_names
        .iter()
        .filter_map(|name| {
            let service = pool.get_service_by_name(name)?;
            let methods = service
                .methods()
                .map(|m| GrpcMethod {
                    name: m.name().to_string(),
                })
                .collect();
            Some(GrpcService {
                name: name.clone(),
                methods,
            })
        })
        .collect();
    GrpcSchema { services }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tauri commands (registered in `lib.rs`).
// ─────────────────────────────────────────────────────────────────────────────

/// List a server's services + methods via gRPC server reflection.
/// Frontend: `invoke<GrpcSchema>('grpc_reflect', { endpoint, plaintext })`.
///
/// Rejects (`Err<String>`) on connect/reflection failure (unreachable host, reflection
/// disabled) — there is no schema to show.
#[tauri::command]
pub async fn grpc_reflect(endpoint: String, plaintext: bool) -> Result<GrpcSchema, String> {
    let mut reflection = Reflection::connect(&endpoint, plaintext).await?;
    let service_names = reflection.list_services().await?;

    // Reflect each service's file to enumerate its methods. A service whose descriptor
    // can't be fetched degrades to an empty method list rather than failing the reflect.
    for name in &service_names {
        let _ = reflection.load(name).await;
    }

    Ok(schema_from_pool(reflection.pool(), &service_names))
}

/// Fetch `symbol`'s file (and imports) into an existing pool. Used by [`grpc_reflect`] to
/// accumulate every service's descriptors into one pool without rebuilding it per service. Each
/// import is asked for once, and every request and file is counted in `fetched` first.
async fn build_pool_into(
    reflect: &mut Reflect,
    symbol: &str,
    pool: &mut DescriptorPool,
    fetched: &mut Fetched,
) -> Result<(), String> {
    let mut collected: HashMap<String, FileDescriptorProto> = HashMap::new();
    let mut asked: HashSet<String> = HashSet::new();
    let mut pending = vec![FileQuery::Symbol(symbol.to_string())];

    while let Some(query) = pending.pop() {
        fetched.request()?;
        let raw_files = reflect
            .fetch_files(&query)
            .await
            .map_err(|e| e.into_string())?;
        fetched.answer(&raw_files)?;
        for raw in raw_files {
            let fd = FileDescriptorProto::decode(raw.as_slice())
                .map_err(|e| format!("invalid file descriptor: {e}"))?;
            let name = fd.name().to_string();
            if collected.contains_key(&name) || pool.get_file_by_name(&name).is_some() {
                continue;
            }
            for dep in &fd.dependency {
                if !collected.contains_key(dep)
                    && pool.get_file_by_name(dep).is_none()
                    && asked.insert(dep.clone())
                {
                    pending.push(FileQuery::Filename(dep.clone()));
                }
            }
            collected.insert(name, fd);
        }
    }

    pool.add_file_descriptor_protos(collected.into_values())
        .map_err(|e| format!("failed to add descriptors: {e}"))
}

/// The request headers as tonic sends them: the metadata (keys lowercased, the reserved
/// names tonic strips — `te`, `content-type`, `grpc-message`, `grpc-message-type`,
/// `grpc-status` — left out), then the two `Grpc::unary` inserts. `user-agent` (tonic's own,
/// added inside the channel) is not reconstructed.
fn headers_as_sent(metadata: &[GrpcHeader]) -> Vec<(String, String)> {
    const RESERVED: [&str; 5] = [
        "te",
        "content-type",
        "grpc-message",
        "grpc-message-type",
        "grpc-status",
    ];
    let mut out: Vec<(String, String)> = metadata
        .iter()
        .map(|h| (h.name.trim().to_ascii_lowercase(), h.value.clone()))
        .filter(|(k, _)| !RESERVED.contains(&k.as_str()))
        .collect();
    out.push(("te".into(), "trailers".into()));
    out.push(("content-type".into(), "application/grpc".into()));
    out
}

/// The pending Network row for a call about to go out — nothing for an endpoint tonic will
/// refuse anyway. gRPC is always HTTP/2 here (tonic), so the version is known up front.
fn start_flow(tap: &Tap, request: &GrpcRequest) -> Flow {
    let Ok(uri) =
        endpoint_uri(&request.endpoint, request.plaintext).parse::<tonic::codegen::http::Uri>()
    else {
        return Flow::none();
    };
    let Some(host) = uri.host() else {
        return Flow::none();
    };
    let port = uri
        .port_u16()
        .unwrap_or(if uri.scheme_str() == Some("https") {
            443
        } else {
            80
        });
    tap.start(
        FlowProto::Grpc,
        "POST",
        host.trim_start_matches('[').trim_end_matches(']'),
        port,
        &format!("/{}/{}", request.service, request.method),
        "HTTP/2",
        headers_as_sent(&request.metadata),
    )
}

/// Send a unary gRPC request. Frontend: `invoke<GrpcResponse>('grpc_send', { request })`.
///
/// A non-OK gRPC status **resolves** as a [`GrpcResponse`] (`statusCode != 0`,
/// `statusName` set, `error` carrying the message) — mirroring `http_send`. A failure to
/// *connect* (dial/TLS/reflection) is `Err`, and so is a deadline that passed on our side
/// (the request's timeout): no server sent that status, so none is reported. The method's
/// descriptor is fetched via reflection, the JSON request built into a `DynamicMessage`, the
/// call made with a dynamic codec, and the response decoded back to JSON. The call is recorded
/// in the Network view as source `API client`.
#[tauri::command]
pub async fn grpc_send(request: GrpcRequest) -> Result<GrpcResponse, String> {
    send_via(request, &Tap::global()).await
}

/// [`grpc_send`] with the Network tap injected instead of taken from the app — the seam
/// `tests/netcap_record.rs` drives: the real call, recorded into a test's own `Netcap`.
pub async fn send_via(request: GrpcRequest, tap: &Tap) -> Result<GrpcResponse, String> {
    call(request, tap, None)
        .await
        .map(|outcome| outcome.response)
}

/// A unary call's [`GrpcResponse`] and the metadata the server sent with it: on OK the
/// response headers and trailers (tonic merges them), otherwise the status's metadata — with
/// `grpc-status`, `grpc-message` and `grpc-status-details-bin` left out, as they are the
/// response's status fields.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GrpcOutcome {
    pub response: GrpcResponse,
    pub metadata: Vec<(String, String)>,
}

/// `metadata` without the status entries [`GrpcResponse`] already carries.
fn without_status(metadata: &[(String, String)]) -> Vec<(String, String)> {
    const STATUS: [&str; 3] = ["grpc-status", "grpc-message", "grpc-status-details-bin"];
    metadata
        .iter()
        .filter(|(k, _)| !STATUS.contains(&k.as_str()))
        .cloned()
        .collect()
}

/// The unary call behind [`grpc_send`], recorded on `tap`, returning the server's metadata as
/// well. With a `limit`, the whole call (dial, reflection, the call itself) must finish within
/// it; past it the call is abandoned and its Network row settles as an error, never left
/// pending. The channel's own request timeout is then set past the limit
/// ([`channel_timeout`]), so a call may take all of it, and the limit is the deadline reported.
pub async fn call(
    request: GrpcRequest,
    tap: &Tap,
    limit: Option<Duration>,
) -> Result<GrpcOutcome, String> {
    call_with_default_timeout(request, tap, limit, REQUEST_TIMEOUT).await
}

/// [`call`] with the channel's request timeout for a call without a limit given as `default`
/// instead of [`REQUEST_TIMEOUT`]: the seam a test uses to make that default short, and see that a
/// call's own limit — not the default — is what its channel waits.
pub async fn call_with_default_timeout(
    request: GrpcRequest,
    tap: &Tap,
    limit: Option<Duration>,
    default: Duration,
) -> Result<GrpcOutcome, String> {
    let flow = start_flow(tap, &request);
    let request_timeout = channel_timeout(limit, default);
    let outcome = match limit {
        None => unary(request, &flow, request_timeout).await,
        Some(limit) => tokio::time::timeout(limit, unary(request, &flow, request_timeout))
            .await
            .unwrap_or_else(|_| {
                Err(format!(
                    "no answer within {} ms; the call was abandoned",
                    limit.as_millis()
                ))
            }),
    };
    outcome.inspect_err(|e| flow.fail(e.clone()))
}

/// Whether `status` is a deadline that passed on our side — the channel's request timeout, or a
/// `grpc-timeout` the request carried — which tonic reports as a `Cancelled` status although no
/// server sent one. tonic keeps the error it mapped as the status's source.
fn deadline_passed(status: &Status) -> bool {
    let mut source = std::error::Error::source(status);
    while let Some(e) = source {
        if e.is::<tonic::TimeoutExpired>() {
            return true;
        }
        source = e.source();
    }
    false
}

/// The call itself; `flow` gets the request body once parsed and the outcome. The channel's
/// requests time out after `request_timeout`.
async fn unary(
    request: GrpcRequest,
    flow: &Flow,
    request_timeout: Duration,
) -> Result<GrpcOutcome, String> {
    let channel = connect_channel(&request.endpoint, request.plaintext, request_timeout).await?;

    // Resolve the method descriptor via reflection.
    let mut reflection = Reflection::over(channel.clone()).await?;
    reflection.load(&request.service).await?;
    let pool = reflection.pool();

    let service = pool
        .get_service_by_name(&request.service)
        .ok_or_else(|| format!("service {} not found in reflected schema", request.service))?;
    let method = service
        .methods()
        .find(|m| m.name() == request.method)
        .ok_or_else(|| {
            format!(
                "method {} not found on service {}",
                request.method, request.service
            )
        })?;

    // TODO(defer): streaming. v1 is unary only; a streaming method is a clear error
    // rather than a silent unary call against the first message.
    if method.is_client_streaming() || method.is_server_streaming() {
        return Err(format!(
            "{}/{} is a streaming method; only unary calls are supported",
            request.service, request.method
        ));
    }

    let request_message = json_to_dynamic(method.input(), &request.message)?;
    // The row's request body: the canonical JSON of what goes on the wire, sized as the
    // encoded protobuf payload.
    flow.request_body(
        dynamic_to_json(&request_message)?.as_bytes(),
        request_message.encoded_len() as u64,
    );
    let metadata = build_metadata(&request.metadata)?;

    // Build the low-level generic client and invoke the unary method with our dynamic
    // codec. `/{service}/{method}` is the standard gRPC path.
    let path = PathAndQuery::from_maybe_shared(format!("/{}/{}", request.service, request.method))
        .map_err(|e| format!("invalid method path: {e}"))?;
    let codec = DynamicCodec {
        output: method.output(),
    };

    let mut grpc =
        tonic::client::Grpc::new(channel).max_decoding_message_size(MAX_DECODING_MESSAGE_BYTES);
    grpc.ready()
        .await
        .map_err(|e| format!("gRPC channel not ready: {e}"))?;

    let mut tonic_request = tonic::Request::new(request_message);
    *tonic_request.metadata_mut() = metadata;

    match grpc.unary(tonic_request, path, codec).await {
        Ok(response) => {
            let message = dynamic_to_json(response.get_ref())?;
            // tonic only resolves `Ok` on an HTTP 200 whose grpc-status was OK; its metadata is
            // the response headers with the trailers merged in (so `grpc-status: 0` is there).
            let headers = capture_headers(&response.metadata().clone().into_headers());
            flow.response_head(200, "HTTP/2", headers.clone());
            flow.grpc_status(0);
            flow.response_body(message.as_bytes(), response.get_ref().encoded_len() as u64);
            flow.done(None);
            Ok(GrpcOutcome {
                response: GrpcResponse {
                    message,
                    status_code: 0,
                    status_name: status_name_for(0).to_string(),
                    error: None,
                },
                metadata: without_status(&headers),
            })
        }
        // Our own deadline, not an answer: the caller sees a timeout and the row fails.
        Err(status) if deadline_passed(&status) => Err(format!(
            "no answer before the request's deadline ({}); the call was abandoned",
            status.message()
        )),
        // A gRPC status (incl. a post-connect transport blip surfaced as Unavailable) is
        // a normal response, mirroring `http.rs`'s treatment of a 4xx/5xx.
        Err(status) => {
            let number = code_number(status.code());
            let status_name = status_name_for(number).to_string();
            let message = status.message();
            let error = if message.is_empty() {
                status_name.clone()
            } else {
                message.to_string()
            };
            flow.grpc_status(number as i32);
            let metadata = capture_headers(&status.metadata().clone().into_headers());
            if std::error::Error::source(&status).is_some() {
                // Wrapped by tonic around an h2/transport error: nothing came back from the
                // server, so the row is an error, not a response.
                flow.fail(format!("{status_name}: {error}"));
            } else {
                // A status the server sent. tonic parsed `grpc-status`/`grpc-message` out of
                // the trailers (or the headers of a trailers-only response) and kept the rest
                // as the status metadata; the row shows them together, as they arrived. The
                // HTTP status itself is not exposed by tonic and none is invented.
                let mut trailers = vec![("grpc-status".to_string(), number.to_string())];
                if !message.is_empty() {
                    trailers.push(("grpc-message".to_string(), message.to_string()));
                }
                trailers.extend(metadata.iter().cloned());
                flow.response_trailers(trailers);
                flow.done(None);
            }
            Ok(GrpcOutcome {
                response: GrpcResponse {
                    message: String::new(),
                    status_code: number,
                    status_name,
                    error: Some(error),
                },
                metadata: without_status(&metadata),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use prost_types::field_descriptor_proto::{Label, Type};
    use prost_types::{DescriptorProto, FieldDescriptorProto};

    // ── (a) endpoint → URI ────────────────────────────────────────────────────

    #[test]
    fn endpoint_uri_prepends_http_for_plaintext_and_https_for_tls() {
        assert_eq!(
            endpoint_uri("localhost:50051", true),
            "http://localhost:50051"
        );
        assert_eq!(
            endpoint_uri("localhost:50051", false),
            "https://localhost:50051"
        );
    }

    #[test]
    fn endpoint_uri_preserves_an_explicit_scheme_and_trims() {
        assert_eq!(
            endpoint_uri("  https://api.example.com:443  ", true),
            "https://api.example.com:443"
        );
        assert_eq!(
            endpoint_uri("http://10.0.0.1:9000", false),
            "http://10.0.0.1:9000"
        );
    }

    // ── (b) Code → (number, name) over all 17 codes ───────────────────────────

    #[test]
    fn code_number_maps_every_canonical_code() {
        let all = [
            (Code::Ok, 0u32),
            (Code::Cancelled, 1),
            (Code::Unknown, 2),
            (Code::InvalidArgument, 3),
            (Code::DeadlineExceeded, 4),
            (Code::NotFound, 5),
            (Code::AlreadyExists, 6),
            (Code::PermissionDenied, 7),
            (Code::ResourceExhausted, 8),
            (Code::FailedPrecondition, 9),
            (Code::Aborted, 10),
            (Code::OutOfRange, 11),
            (Code::Unimplemented, 12),
            (Code::Internal, 13),
            (Code::Unavailable, 14),
            (Code::DataLoss, 15),
            (Code::Unauthenticated, 16),
        ];
        for (code, number) in all {
            assert_eq!(code_number(code), number, "{code:?}");
        }
    }

    #[test]
    fn status_name_table_is_exhaustive_and_canonical() {
        let expected = [
            (0u32, "OK"),
            (1, "Canceled"),
            (2, "Unknown"),
            (3, "InvalidArgument"),
            (4, "DeadlineExceeded"),
            (5, "NotFound"),
            (6, "AlreadyExists"),
            (7, "PermissionDenied"),
            (8, "ResourceExhausted"),
            (9, "FailedPrecondition"),
            (10, "Aborted"),
            (11, "OutOfRange"),
            (12, "Unimplemented"),
            (13, "Internal"),
            (14, "Unavailable"),
            (15, "DataLoss"),
            (16, "Unauthenticated"),
        ];
        for (code, name) in expected {
            assert_eq!(status_name_for(code), name, "code {code}");
        }
        assert_eq!(status_name_for(99), "Unknown", "out-of-range degrades");
    }

    #[test]
    fn every_tonic_code_has_a_matching_name() {
        // The Code→number and number→name tables agree for all 17 codes.
        for code in [
            Code::Ok,
            Code::Cancelled,
            Code::Unknown,
            Code::InvalidArgument,
            Code::DeadlineExceeded,
            Code::NotFound,
            Code::AlreadyExists,
            Code::PermissionDenied,
            Code::ResourceExhausted,
            Code::FailedPrecondition,
            Code::Aborted,
            Code::OutOfRange,
            Code::Unimplemented,
            Code::Internal,
            Code::Unavailable,
            Code::DataLoss,
            Code::Unauthenticated,
        ] {
            let name = status_name_for(code_number(code));
            if code == Code::Unknown {
                // Code::Unknown legitimately maps to the name "Unknown".
                assert_eq!(name, "Unknown");
            } else {
                assert_ne!(name, "Unknown", "{code:?} should have a specific name");
            }
        }
    }

    // ── (c) metadata → MetadataMap ─────────────────────────────────────────────

    fn header(name: &str, value: &str) -> GrpcHeader {
        GrpcHeader {
            name: name.to_string(),
            value: value.to_string(),
        }
    }

    #[test]
    fn build_metadata_lowercases_keys_and_keeps_values() {
        let map = build_metadata(&[
            header("Authorization", "Bearer TOKEN"),
            header("X-Tenant", "acme"),
        ])
        .expect("valid metadata");
        assert_eq!(
            map.get("authorization").map(|v| v.to_str().unwrap()),
            Some("Bearer TOKEN")
        );
        assert_eq!(
            map.get("x-tenant").map(|v| v.to_str().unwrap()),
            Some("acme")
        );
    }

    #[test]
    fn build_metadata_appends_duplicate_keys() {
        let map = build_metadata(&[header("x-scope", "a"), header("x-scope", "b")])
            .expect("valid metadata");
        let values: Vec<_> = map
            .get_all("x-scope")
            .iter()
            .map(|v| v.to_str().unwrap().to_string())
            .collect();
        assert_eq!(values, vec!["a", "b"]);
    }

    #[test]
    fn build_metadata_rejects_binary_metadata_for_now() {
        let err = build_metadata(&[header("trace-bin", "AAAA")]).unwrap_err();
        assert!(err.contains("binary metadata"), "got: {err}");
    }

    #[test]
    fn an_outcomes_metadata_leaves_out_the_status_it_already_carries() {
        let pairs = |p: &[(&str, &str)]| -> Vec<(String, String)> {
            p.iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect()
        };
        assert_eq!(
            without_status(&pairs(&[
                ("content-type", "application/grpc"),
                ("grpc-status", "0"),
                ("x-served-by", "a"),
                ("grpc-message", "m"),
                ("grpc-status-details-bin", "AAAA"),
                ("x-served-by", "b"),
            ])),
            pairs(&[
                ("content-type", "application/grpc"),
                ("x-served-by", "a"),
                ("x-served-by", "b"),
            ])
        );
    }

    #[test]
    fn a_call_with_a_limit_of_its_own_gets_a_channel_that_waits_past_it() {
        // Without a limit, the channel's own deadline is the only one.
        assert_eq!(channel_timeout(None, REQUEST_TIMEOUT), REQUEST_TIMEOUT);
        // With one, the channel must never cut the call first — including limits past the
        // default request timeout, which an agent's `grpc call --timeout-ms` allows.
        for ms in [1, 400, 29_999, 30_000, 45_000, 60_000] {
            let limit = Duration::from_millis(ms);
            assert!(
                channel_timeout(Some(limit), REQUEST_TIMEOUT) > limit,
                "{ms} ms"
            );
        }
    }

    /// Every request counts as a file even when its answer holds none, every file of an answer
    /// counts, and every byte; past either limit the session stops, for good.
    #[test]
    fn a_reflection_session_counts_requests_files_and_bytes_and_stops_for_good() {
        let mut f = Fetched::default();
        for _ in 0..MAX_REFLECTED_FILES {
            f.request().unwrap();
            f.answer(&[]).unwrap();
        }
        let e = f.request().unwrap_err();
        assert!(e.starts_with("reflection stopped: "), "{e}");
        assert!(f.stopped);

        let mut f = Fetched::default();
        f.request().unwrap();
        assert!(f
            .answer(&vec![Vec::new(); MAX_REFLECTED_FILES + 1])
            .is_err());

        let mut f = Fetched::default();
        f.request().unwrap();
        f.answer(&[vec![0; MAX_REFLECTED_BYTES]]).unwrap();
        f.request().unwrap();
        assert!(f.answer(&[vec![0; 1]]).is_err());
        assert!(f.request().is_err(), "a stopped session stays stopped");
    }

    #[test]
    fn build_metadata_rejects_an_invalid_key() {
        let err = build_metadata(&[header("bad key", "x")]).unwrap_err();
        assert!(err.contains("invalid metadata key"), "got: {err}");
    }

    // ── (d) JSON ⇄ DynamicMessage round-trip against a hand-built descriptor ───

    /// A tiny proto3 message `test.Echo { string text = 1; int32 count = 2; }`.
    fn echo_descriptor() -> MessageDescriptor {
        let file = FileDescriptorProto {
            name: Some("test.proto".to_string()),
            package: Some("test".to_string()),
            syntax: Some("proto3".to_string()),
            message_type: vec![DescriptorProto {
                name: Some("Echo".to_string()),
                field: vec![
                    FieldDescriptorProto {
                        name: Some("text".to_string()),
                        number: Some(1),
                        label: Some(Label::Optional as i32),
                        r#type: Some(Type::String as i32),
                        json_name: Some("text".to_string()),
                        ..Default::default()
                    },
                    FieldDescriptorProto {
                        name: Some("count".to_string()),
                        number: Some(2),
                        label: Some(Label::Optional as i32),
                        r#type: Some(Type::Int32 as i32),
                        json_name: Some("count".to_string()),
                        ..Default::default()
                    },
                ],
                ..Default::default()
            }],
            ..Default::default()
        };
        let mut pool = DescriptorPool::new();
        pool.add_file_descriptor_proto(file)
            .expect("valid file descriptor");
        pool.get_message_by_name("test.Echo")
            .expect("Echo message present")
    }

    #[test]
    fn json_to_dynamic_and_back_round_trips() {
        let desc = echo_descriptor();
        let msg = json_to_dynamic(desc.clone(), r#"{"text":"hi","count":3}"#).expect("parse");
        let json = dynamic_to_json(&msg).expect("serialize");
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(value["text"], "hi");
        assert_eq!(value["count"], 3);
    }

    #[test]
    fn json_to_dynamic_survives_a_protobuf_encode_decode_cycle() {
        // This exercises the exact prost encode / DynamicMessage::decode path the
        // dynamic codec uses on the wire, without needing tonic's Encode/DecodeBuf.
        let desc = echo_descriptor();
        let msg = json_to_dynamic(desc.clone(), r#"{"text":"round","count":7}"#).expect("parse");

        let mut bytes = Vec::new();
        msg.encode(&mut bytes).expect("encode");
        let decoded = DynamicMessage::decode(desc, bytes.as_slice()).expect("decode");

        let json = dynamic_to_json(&decoded).expect("serialize");
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(value["text"], "round");
        assert_eq!(value["count"], 7);
    }

    #[test]
    fn blank_request_message_is_treated_as_empty() {
        let desc = echo_descriptor();
        let msg = json_to_dynamic(desc, "   ").expect("blank is empty message");
        // Nothing set → default-field-skipping serialization yields `{}`.
        assert_eq!(dynamic_to_json(&msg).unwrap(), "{}");
    }

    #[test]
    fn json_to_dynamic_rejects_malformed_json() {
        let desc = echo_descriptor();
        let err = json_to_dynamic(desc, r#"{"text": "#).unwrap_err();
        assert!(err.contains("invalid request JSON"), "got: {err}");
    }

    #[test]
    fn json_to_dynamic_rejects_trailing_garbage() {
        let desc = echo_descriptor();
        let err = json_to_dynamic(desc, r#"{"text":"a"} extra"#).unwrap_err();
        assert!(err.contains("invalid request JSON"), "got: {err}");
    }

    // ── live-server paths (need a real reflection endpoint) ────────────────────
    //
    // Reflection + the unary call require a running gRPC server, so they can't be pure
    // unit tests. They are verified in the running app against a
    // throwaway reflection-enabled endpoint. These `#[ignore]`d tests document how to
    // exercise them manually, e.g.:
    //   cargo test --manifest-path src-tauri/Cargo.toml grpc -- --ignored --nocapture
    // pointed at a local server (adjust the endpoint).

    #[tokio::test]
    #[ignore = "needs a live gRPC reflection server on localhost:50051"]
    async fn reflect_lists_services_from_a_live_server() {
        let schema = grpc_reflect("localhost:50051".to_string(), true)
            .await
            .expect("reflection should succeed");
        assert!(
            !schema.services.is_empty(),
            "expected at least one service, got {schema:?}"
        );
    }

    #[tokio::test]
    #[ignore = "needs a live gRPC unary endpoint"]
    async fn unary_call_against_a_live_server() {
        let response = grpc_send(GrpcRequest {
            endpoint: "localhost:50051".to_string(),
            service: "grpc.health.v1.Health".to_string(),
            method: "Check".to_string(),
            message: "{}".to_string(),
            metadata: vec![],
            plaintext: true,
        })
        .await
        .expect("transport should succeed");
        // OK or a real gRPC status — both resolve; neither is an Err.
        assert!(response.status_code <= 16);
    }

    // ── live TLS smoke: the ONE grpc test that leaves the machine ──────────────
    //
    // Both live tests above are `plaintext: true` (h2c on localhost), so **the `grpcs://`
    // TLS path would have no test at all** — and both the crypto provider (`ring`,
    // installed in `crate::tls`) and the root store (`with_enabled_roots()`: OS anchors ∪
    // Mozilla) are deliberate choices underneath it. `#[ignore]`d so `cargo test`/CI stay
    // hermetic, matching `usage.rs`'s `live_smoke_reads_real_usage_from_the_cli`.
    // Run after touching any `rustls`/`tonic` feature:
    //
    //     cargo test --manifest-path src-tauri/Cargo.toml -- --ignored live_smoke
    #[tokio::test]
    #[ignore = "reaches the public internet over TLS — run with --ignored"]
    async fn live_smoke_grpcs_completes_a_real_tls_handshake() {
        // grpcb.in's TLS port speaks gRPC + server reflection (`CN=grpcb.in`, a public
        // chain). Reaching a service list proves the whole TLS path: `ClientTlsConfig`
        // built with the installed provider, ALPN h2 negotiated, and the peer's chain
        // validated against our root store.
        let schema = grpc_reflect("grpcb.in:9001".to_string(), false)
            .await
            .expect(
                "grpcs:// must work: a certificate/handshake error here means the TLS \
                 provider or root store regressed (see src/tls.rs). A connect error \
                 means the network or the public test server; retarget if grpcb.in is gone.",
            );
        assert!(
            !schema.services.is_empty(),
            "expected at least one reflected service over TLS, got {schema:?}"
        );
    }
}
