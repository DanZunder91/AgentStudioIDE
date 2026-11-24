/**
 * `grpcIpc` — the API client's gRPC lane, at the wire (native tonic).
 *
 * Thin wrappers, so the command *names*, arg *shapes*, and the resolve-vs-reject
 * split are the whole contract with the Rust `grpc_*` commands. Mirrors
 * `httpIpc.test.ts`/`wsIpc.test.ts`. The behavioural contract pinned here: a non-OK
 * gRPC status RESOLVES (only a transport failure rejects).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installTauriMock, type TauriMock } from "../../test/tauri-mock";
import {
  grpcReflect,
  grpcSend,
  type GrpcRequest,
  type GrpcResponse,
  type GrpcSchema,
} from "./grpcIpc";

const SCHEMA: GrpcSchema = {
  services: [
    {
      name: "greeter.Greeter",
      methods: [{ name: "SayHello" }, { name: "SayBye" }],
    },
  ],
};

const REQUEST: GrpcRequest = {
  endpoint: "localhost:50051",
  service: "greeter.Greeter",
  method: "SayHello",
  message: '{"name":"world"}',
  metadata: [{ name: "authorization", value: "Bearer t" }],
  plaintext: true,
};

const OK: GrpcResponse = {
  message: '{"message":"hello world"}',
  statusCode: 0,
  statusName: "OK",
  error: null,
};

describe("grpcIpc", () => {
  let ipc: TauriMock;

  beforeEach(() => {
    ipc = installTauriMock();
  });
  afterEach(() => {
    ipc.reset();
  });

  describe("grpcReflect", () => {
    it("invokes grpc_reflect with { endpoint, plaintext } and returns the schema", async () => {
      ipc.handle("grpc_reflect", () => SCHEMA);
      await expect(grpcReflect("localhost:50051", true)).resolves.toEqual(
        SCHEMA,
      );
      expect(ipc.lastCall("grpc_reflect")).toEqual({
        endpoint: "localhost:50051",
        plaintext: true,
      });
    });

    it("propagates a rejection (reflection disabled / transport failure)", async () => {
      ipc.handle("grpc_reflect", () => {
        throw new Error("server does not support reflection");
      });
      await expect(grpcReflect("localhost:50051", false)).rejects.toThrow(
        /reflection/,
      );
    });
  });

  describe("grpcSend", () => {
    it("invokes grpc_send with the request under a `request` key, returning the response", async () => {
      ipc.handle("grpc_send", () => OK);
      await expect(grpcSend(REQUEST)).resolves.toEqual(OK);
      expect(ipc.lastCall("grpc_send")).toEqual({ request: REQUEST });
    });

    it("RESOLVES a non-OK gRPC status (it is not turned into a rejection)", async () => {
      const notFound: GrpcResponse = {
        message: "{}",
        statusCode: 5,
        statusName: "NOT_FOUND",
        error: "user 7 not found",
      };
      ipc.handle("grpc_send", () => notFound);
      // The whole point: a non-OK status is a RESOLVED call, like HTTP's 404.
      await expect(grpcSend(REQUEST)).resolves.toEqual(notFound);
    });

    it("propagates a rejection on a TRANSPORT failure (dead host / TLS)", async () => {
      ipc.handle("grpc_send", () => {
        throw new Error("connection refused");
      });
      await expect(grpcSend(REQUEST)).rejects.toThrow(/connection refused/);
    });
  });
});
