/**
 * gRPC IPC — typed wrapper for the API client's gRPC lane.
 *
 * gRPC is a NATIVE, in-process `tonic` call (dynamic protobuf via `prost-reflect`
 * + server reflection) — no external tool, always available (zero-install). These
 * wrappers are the EXACT wire contract the Rust `grpc_*` commands implement, mirrored
 * by their serde structs (`rename_all = "camelCase"`).
 *
 * Kept feature-local so the wire types live next to their feature.
 *
 * Secret-safety: every call crosses the boundary in memory only —
 * nothing here writes an endpoint, message, or metadata value to disk.
 */

import { invoke } from "@tauri-apps/api/core";

/** One method a service exposes (bare method name, e.g. `SayHello`). */
export interface GrpcMethodInfo {
  name: string;
}

/** One service the server exposes (dotted FQN, e.g. `pkg.Greeter`) + its methods. */
export interface GrpcServiceInfo {
  name: string;
  methods: GrpcMethodInfo[];
}

/**
 * The result of a reflection call: the services the server exposes, each with its
 * methods. The picker renders services grouped and their methods dependent. Empty
 * until a reflect succeeds.
 */
export interface GrpcSchema {
  services: GrpcServiceInfo[];
}

/**
 * One request metadata pair (gRPC's equivalent of an HTTP header). Order-
 * preserving; duplicates allowed. Values are the RESOLVED wire metadata
 * (post-substitution; `{{VAR}}` already spliced in by the send path).
 */
export interface GrpcMetadata {
  name: string;
  value: string;
}

/**
 * A unary call to perform. `endpoint` is `host:port` (no scheme — gRPC is HTTP/2;
 * `plaintext` chooses h2c vs TLS, mirroring grpcurl's `-plaintext`). `service` is
 * the dotted FQN, `method` the bare method name. `message` is the request body as
 * a JSON string (Rust maps JSON → protobuf via reflection). `metadata` is the
 * resolved wire metadata.
 */
export interface GrpcRequest {
  endpoint: string;
  service: string;
  method: string;
  message: string;
  metadata: GrpcMetadata[];
  plaintext: boolean;
}

/**
 * The response Rust returns. `message` is the response protobuf rendered back to a
 * JSON string (the UI pretty-prints it). `statusCode` is the numeric gRPC status
 * (0 = OK … 16), `statusName` its canonical name (`OK`, `NOT_FOUND`, …). `error`
 * is the server-supplied `grpc-message` accompanying a non-OK status (null on OK).
 *
 * IMPORTANT: a non-OK gRPC status is a RESOLVED call, not a rejection — Rust
 * RESOLVES `GrpcResponse` with `statusCode != 0`. Rust only REJECTS (string) on a
 * TRANSPORT failure (DNS/TLS/connect/HTTP-2), which the panel shows in the error
 * block. This split mirrors HTTP (a 404 resolves; a dead host rejects).
 */
export interface GrpcResponse {
  message: string;
  statusCode: number;
  statusName: string;
  error: string | null;
}

/**
 * `grpc_reflect` — reflect the server at `endpoint` and resolve its services +
 * methods, or REJECT with a string (reflection disabled, or a DNS/TLS/connect
 * failure). `plaintext` chooses h2c vs TLS for the reflection channel (the same
 * toggle the unary call uses). Reflection is an ASSIST — a failure falls back to
 * manual service/method entry, never a gate on sending.
 */
export async function grpcReflect(
  endpoint: string,
  plaintext: boolean,
): Promise<GrpcSchema> {
  return invoke<GrpcSchema>("grpc_reflect", { endpoint, plaintext });
}

/**
 * `grpc_send` — perform `request` and resolve its `GrpcResponse` (INCLUDING a
 * non-OK gRPC status — that is a resolved call), or REJECT with a string on a
 * transport failure. Rust owns the native `tonic` call + the JSON⇄protobuf mapping.
 * This is the whole marshalling contract.
 */
export async function grpcSend(request: GrpcRequest): Promise<GrpcResponse> {
  return invoke<GrpcResponse>("grpc_send", { request });
}
