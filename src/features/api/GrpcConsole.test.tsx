/**
 * GrpcConsole — the API client's gRPC console (native tonic).
 *
 * `grpcIpc` is mocked at the module boundary: the real `grpc_*` commands cross
 * Tauri (pinned in `grpcIpc.test.ts`). What is under test here is the console —
 * reflect-populates-the-picker (+ the manual fallback), the one-shot Send through
 * `executeGrpcRequest`, the status pill / body / error rendering, and the
 * metadata-substitution secret-safety (resolved on the wire, LITERAL in history).
 * `historyIpc`/`apiStoreIpc` are mocked so a record/env mutation never touches Tauri.
 */

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const grpcIpc = vi.hoisted(() => ({
  grpcReflect: vi.fn(),
  grpcSend: vi.fn(),
}));
vi.mock("./grpcIpc", () => grpcIpc);
const historyIpc = vi.hoisted(() => ({
  loadApiHistory: vi.fn(),
  saveApiHistory: vi.fn(),
}));
vi.mock("./historyIpc", () => historyIpc);
const apiStoreIpc = vi.hoisted(() => ({
  loadApiStore: vi.fn(),
  saveApiStore: vi.fn(),
}));
vi.mock("./apiStoreIpc", () => apiStoreIpc);

import { useAppStore } from "../../app/store";
import { resetStore } from "../../test/store-harness";
import { GrpcConsole } from "./GrpcConsole";
import type { GrpcResponse, GrpcSchema } from "./grpcIpc";

const SCHEMA: GrpcSchema = {
  services: [
    {
      name: "greeter.Greeter",
      methods: [{ name: "SayHello" }, { name: "SayBye" }],
    },
  ],
};

const OK: GrpcResponse = {
  message: '{"greeting":"hello world"}',
  statusCode: 0,
  statusName: "OK",
  error: null,
};

const endpointInput = () =>
  screen.getByLabelText("gRPC endpoint") as HTMLInputElement;
const messageInput = () =>
  screen.getByLabelText("Request message (JSON)") as HTMLTextAreaElement;
const reflectBtn = () => screen.getByTestId("grpc-reflect");
const sendBtn = () => screen.getByTestId("grpc-send");
const serviceControl = () =>
  screen.getByLabelText("gRPC service") as HTMLSelectElement;
const methodControl = () =>
  screen.getByLabelText("gRPC method") as HTMLSelectElement;

const api = () => useAppStore.getState().apiActions;
const grpcOf = (id: string) => useAppStore.getState().apiRequests[id].grpc;

/** Create a grpc request and render its console. */
async function setup(): Promise<string> {
  const id = api().createApiRequest();
  api().setApiProtocol(id, "grpc");
  render(<GrpcConsole requestId={id} />);
  await act(async () => {}); // settle any initial effects
  return id;
}

/** Type an endpoint, then reflect (flushing the resolve) to populate the picker. */
async function reflect(endpoint = "localhost:50051"): Promise<void> {
  fireEvent.change(endpointInput(), { target: { value: endpoint } });
  await act(async () => {
    fireEvent.click(reflectBtn());
  });
}

beforeEach(() => {
  resetStore();
  grpcIpc.grpcReflect.mockReset().mockResolvedValue(SCHEMA);
  grpcIpc.grpcSend.mockReset().mockResolvedValue(OK);
  historyIpc.saveApiHistory.mockReset();
  apiStoreIpc.saveApiStore.mockReset();
});

afterEach(() => cleanup());

describe("GrpcConsole — rendering", () => {
  it("renders nothing for an unknown request id", async () => {
    const { container } = render(<GrpcConsole requestId="nope" />);
    await act(async () => {});
    expect(container).toBeEmptyDOMElement();
  });

  it("starts with an endpoint bar, a plaintext toggle on, and Send disabled", async () => {
    await setup();
    expect(screen.getByTestId("grpc-console")).toBeInTheDocument();
    expect(endpointInput()).toHaveValue("");
    expect(
      screen.getByLabelText("Use plaintext (no TLS)"),
    ).toBeChecked();
    expect(sendBtn()).toBeDisabled(); // no endpoint/service/method
    expect(reflectBtn()).toBeDisabled(); // no endpoint
    // No schema yet → the manual service/method inputs (no toggle button).
    expect(serviceControl().tagName).toBe("INPUT");
    expect(screen.queryByTestId("grpc-toggle-manual")).toBeNull();
  });

});

describe("GrpcConsole — reflect", () => {
  it("reflects with the endpoint + plaintext flag and populates the service/method picker", async () => {
    await setup();
    await reflect();

    expect(grpcIpc.grpcReflect).toHaveBeenCalledWith("localhost:50051", true);
    // The service <select> lists the reflected service; picking it lists its methods.
    const service = serviceControl();
    expect(service.tagName).toBe("SELECT");
    fireEvent.change(service, { target: { value: "greeter.Greeter" } });
    const method = methodControl();
    const options = Array.from(method.options).map((o) => o.value);
    expect(options).toEqual(["", "SayHello", "SayBye"]);
  });

  it("shows Reflecting… on a disabled button while the reflect is pending", async () => {
    const id = await setup();
    grpcIpc.grpcReflect.mockReturnValueOnce(new Promise<GrpcSchema>(() => {}));
    fireEvent.change(endpointInput(), { target: { value: "localhost:50051" } });
    await act(async () => {
      fireEvent.click(reflectBtn());
    });
    expect(reflectBtn()).toHaveTextContent("Reflecting…");
    expect(reflectBtn()).toBeDisabled();
    expect(grpcOf(id).listing).toBe(true);
  });

  it("surfaces a reflect failure inline and leaves manual entry usable for a real Send", async () => {
    await setup();
    grpcIpc.grpcReflect.mockRejectedValueOnce(
      new Error("server does not support reflection"),
    );
    fireEvent.change(endpointInput(), { target: { value: "localhost:50051" } });
    await act(async () => {
      fireEvent.click(reflectBtn());
    });
    expect(screen.getByTestId("grpc-list-error")).toHaveTextContent(
      /reflection/,
    );
    // No schema → manual inputs. Type a service + method and Send works.
    fireEvent.change(serviceControl(), { target: { value: "pkg.Svc" } });
    fireEvent.change(methodControl(), { target: { value: "DoThing" } });
    expect(sendBtn()).toBeEnabled();
    await act(async () => {
      fireEvent.click(sendBtn());
    });
    expect(grpcIpc.grpcSend).toHaveBeenCalledTimes(1);
    expect(grpcIpc.grpcSend.mock.calls[0][0]).toMatchObject({
      service: "pkg.Svc",
      method: "DoThing",
    });
  });

  it("toggles between the reflected picker and manual entry once a schema exists", async () => {
    await setup();
    await reflect();
    // Schema present → the toggle appears, defaulting to the picker (selects).
    expect(serviceControl().tagName).toBe("SELECT");
    const toggle = screen.getByTestId("grpc-toggle-manual");
    expect(toggle).toHaveTextContent("Enter manually");

    fireEvent.click(toggle);
    expect(serviceControl().tagName).toBe("INPUT");
    expect(toggle).toHaveTextContent("Use reflected list");

    fireEvent.click(toggle);
    expect(serviceControl().tagName).toBe("SELECT");
  });
});

describe("GrpcConsole — send", () => {
  /** Reflect + pick greeter.Greeter/SayHello so Send is enabled. */
  async function ready(): Promise<string> {
    const id = await setup();
    await reflect();
    fireEvent.change(serviceControl(), { target: { value: "greeter.Greeter" } });
    fireEvent.change(methodControl(), { target: { value: "SayHello" } });
    fireEvent.change(messageInput(), { target: { value: '{"name":"world"}' } });
    return id;
  }

  it("sends and renders a 0 OK status pill + the pretty-printed response body", async () => {
    await ready();
    expect(sendBtn()).toBeEnabled();
    await act(async () => {
      fireEvent.click(sendBtn());
    });

    const sent = grpcIpc.grpcSend.mock.calls[0][0];
    expect(sent).toMatchObject({
      endpoint: "localhost:50051",
      service: "greeter.Greeter",
      method: "SayHello",
      message: '{"name":"world"}',
      plaintext: true,
    });
    expect(screen.getByTestId("grpc-status")).toHaveTextContent("0 OK");
    expect(screen.getByTestId("grpc-status")).toHaveClass("api-status--ok");
    expect(screen.getByTestId("grpc-response-body")).toHaveTextContent(
      /"greeting": "hello world"/,
    );
    // No transport-error block on a resolved call.
    expect(screen.queryByTestId("grpc-error")).toBeNull();
  });

  it("shows a non-JSON response message as raw text (the formatMessage fallback)", async () => {
    grpcIpc.grpcSend.mockResolvedValue({
      message: "not valid json",
      statusCode: 0,
      statusName: "OK",
      error: null,
    });
    await ready();
    await act(async () => {
      fireEvent.click(sendBtn());
    });
    expect(screen.getByTestId("grpc-response-body")).toHaveTextContent(
      "not valid json",
    );
  });

  it("renders a non-OK status as a RESPONSE (pill + grpc-message), not the error block", async () => {
    grpcIpc.grpcSend.mockResolvedValue({
      message: "{}",
      statusCode: 5,
      statusName: "NOT_FOUND",
      error: "no such user",
    });
    await ready();
    await act(async () => {
      fireEvent.click(sendBtn());
    });
    const pill = screen.getByTestId("grpc-status");
    expect(pill).toHaveTextContent("5 NOT_FOUND");
    expect(pill).toHaveClass("api-status--grpcerr");
    expect(screen.getByTestId("grpc-response")).toHaveTextContent(
      "no such user",
    );
    expect(screen.queryByTestId("grpc-error")).toBeNull();
  });

  it("surfaces a transport failure in a calm alert block (no response body)", async () => {
    grpcIpc.grpcSend.mockRejectedValue(new Error("connection refused"));
    await ready();
    await act(async () => {
      fireEvent.click(sendBtn());
    });
    const err = screen.getByTestId("grpc-error");
    expect(err).toHaveAttribute("role", "alert");
    expect(err).toHaveTextContent("connection refused");
    expect(screen.queryByTestId("grpc-response")).toBeNull();
  });

  it("gates Send until endpoint + service + method are set, and sends on Cmd/Ctrl+Enter", async () => {
    const id = await setup();
    await reflect();
    expect(sendBtn()).toBeDisabled(); // no service/method yet
    fireEvent.change(serviceControl(), { target: { value: "greeter.Greeter" } });
    expect(sendBtn()).toBeDisabled(); // still no method
    fireEvent.change(methodControl(), { target: { value: "SayHello" } });
    expect(sendBtn()).toBeEnabled();

    // A modifier + non-Enter, and a plain Enter (no modifier), both do nothing.
    fireEvent.keyDown(messageInput(), { key: "a", metaKey: true });
    fireEvent.keyDown(messageInput(), { key: "Enter" });
    expect(grpcIpc.grpcSend).not.toHaveBeenCalled();

    // Ctrl+Enter (and, on mac, Cmd+Enter) sends.
    await act(async () => {
      fireEvent.keyDown(messageInput(), { key: "Enter", ctrlKey: true });
    });
    expect(grpcIpc.grpcSend).toHaveBeenCalledTimes(1);
    expect(grpcOf(id).response).toEqual(OK);
  });
});

describe("GrpcConsole — metadata secret-safety", () => {
  it("resolves {{VAR}} in metadata onto the WIRE but keeps the LITERAL in history", async () => {
    const id = await setup();
    // An active env holding the secret.
    const envId = api().addEnvironment("prod");
    api().setEnvVar(envId, "TOKEN", "sk-secret");
    api().setActiveEnvironment(envId);

    await reflect();
    fireEvent.change(serviceControl(), { target: { value: "greeter.Greeter" } });
    fireEvent.change(methodControl(), { target: { value: "SayHello" } });

    // Add a metadata row through the UI: authorization: Bearer {{TOKEN}}.
    fireEvent.click(screen.getByTestId("grpc-add-metadata"));
    fireEvent.change(screen.getByLabelText("Metadata name"), {
      target: { value: "authorization" },
    });
    fireEvent.change(screen.getByLabelText("Metadata value"), {
      target: { value: "Bearer {{TOKEN}}" },
    });

    await act(async () => {
      fireEvent.click(sendBtn());
    });

    // The wire metadata carried the RESOLVED secret…
    expect(grpcIpc.grpcSend.mock.calls[0][0].metadata).toEqual([
      { name: "authorization", value: "Bearer sk-secret" },
    ]);
    // …while the recorded history keeps the LITERAL placeholder.
    const hist = useAppStore.getState().apiHistory;
    expect(hist).toHaveLength(1);
    expect(hist[0]).toMatchObject({ protocol: "grpc", grpcService: "greeter.Greeter" });
    expect(hist[0].headers[0]).toEqual({
      name: "authorization",
      value: "Bearer {{TOKEN}}",
    });
    expect(grpcOf(id).response).toEqual(OK);
  });

  it("removes a metadata row via its ✕ control", async () => {
    await setup();
    fireEvent.click(screen.getByTestId("grpc-add-metadata"));
    expect(screen.getByTestId("grpc-metadata-row")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Remove metadata"));
    expect(screen.queryByTestId("grpc-metadata-row")).toBeNull();
    expect(screen.getByText("No metadata")).toBeInTheDocument();
  });

  it("toggles a metadata row's enabled checkbox and the plaintext flag", async () => {
    const id = await setup();
    fireEvent.click(screen.getByLabelText("Use plaintext (no TLS)"));
    expect(grpcOf(id).plaintext).toBe(false);

    fireEvent.click(screen.getByTestId("grpc-add-metadata"));
    const enabled = screen.getByLabelText("Metadata enabled") as HTMLInputElement;
    expect(enabled).toBeChecked();
    fireEvent.click(enabled);
    expect(
      useAppStore.getState().apiRequests[id].headers[0].enabled,
    ).toBe(false);
  });
});

describe("GrpcConsole — environment", () => {
  it("switches the active environment from the console's env select", async () => {
    const envId = api().addEnvironment("prod"); // before render → the option exists
    await setup();
    // The select reflects the store and drives setActiveEnvironment both ways.
    fireEvent.change(screen.getByLabelText("Environment"), {
      target: { value: envId },
    });
    expect(useAppStore.getState().activeEnvironmentId).toBe(envId);
    fireEvent.change(screen.getByLabelText("Environment"), {
      target: { value: "" },
    });
    expect(useAppStore.getState().activeEnvironmentId).toBeNull();
  });
});
