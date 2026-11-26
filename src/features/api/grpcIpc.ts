/** Wrappers for the Rust grpc_* commands (native tonic + prost-reflect): the exact wire contract,
 * mirrored by camelCase serde structs. Nothing here writes to disk. */

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

/** Services and their methods from reflection; empty until a reflect succeeds. */
export interface GrpcSchema {
  services: GrpcServiceInfo[];
}

/** gRPC's header: ordered, duplicates allowed. Values are RESOLVED (post-substitution). */
export interface GrpcMetadata {
  name: string;
  value: string;
}

/** endpoint is host:port, no scheme; plaintext picks h2c vs TLS (grpcurl's -plaintext). service
 * is the dotted FQN; message is JSON, mapped to protobuf by Rust via reflection. */
export interface GrpcRequest {
  endpoint: string;
  service: string;
  method: string;
  message: string;
  metadata: GrpcMetadata[];
  plaintext: boolean;
}

/** message is the response as JSON; error is grpc-message (null on OK). A non-OK status RESOLVES;
 * Rust rejects only on transport failure (DNS/TLS/connect/HTTP-2), as HTTP's 404 vs a dead host. */
export interface GrpcResponse {
  message: string;
  statusCode: number;
  statusName: string;
  error: string | null;
}

/** Rejects with a string when reflection is off or the transport fails. Reflection is an assist:
 * a failure falls back to manual service/method entry, never blocks sending. */
export async function grpcReflect(
  endpoint: string,
  plaintext: boolean,
): Promise<GrpcSchema> {
  return invoke<GrpcSchema>("grpc_reflect", { endpoint, plaintext });
}

/** Resolves on any gRPC status, non-OK included; rejects (a string) only on transport failure. */
export async function grpcSend(request: GrpcRequest): Promise<GrpcResponse> {
  return invoke<GrpcResponse>("grpc_send", { request });
}
