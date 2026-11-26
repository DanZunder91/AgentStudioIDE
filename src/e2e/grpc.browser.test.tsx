/** gRPC console through the real <App/> in Chromium over the mocked backend (testing-strategy §1):
 * the toggle mounts `GrpcConsole`, Reflect fills the picker, unary Send shows OK. No "install X"
 * path: native tonic gRPC is always available. */

import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import App from "../App";
import { installE2EHarness, resetE2E, settle, teardownE2E, type E2EHarness } from "./harness";

describe("gRPC console — real <App/> over a mocked backend", () => {
  let h: E2EHarness;

  beforeEach(() => {
    resetE2E();
    h = installE2EHarness();
  });
  afterEach(() => {
    teardownE2E(h.ipc);
  });

  it("switches HTTP→gRPC, reflects to populate the picker, and sends a unary call", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByTestId("app-shell");

    // Open a new API request tab and switch its protocol to gRPC.
    await user.click(screen.getByLabelText("New API request"));
    await user.click(await screen.findByRole("button", { name: "gRPC" }));

    // The native gRPC console mounts — and there is NO "install grpcurl" degrade.
    const console = await screen.findByTestId("grpc-console");
    expect(within(console).queryByTestId("grpc-degraded")).toBeNull();

    // Endpoint → Reflect populates the service/method picker from the mock schema.
    await user.type(screen.getByLabelText("gRPC endpoint"), "localhost:50051");
    await act(async () => {
      await user.click(screen.getByTestId("grpc-reflect"));
    });
    await waitFor(() => expect(h.ipc.calls("grpc_reflect")).toHaveLength(1));

    const service = screen.getByLabelText("gRPC service") as HTMLSelectElement;
    await waitFor(() => expect(service.tagName).toBe("SELECT"));
    await user.selectOptions(service, "greeter.Greeter");
    await user.selectOptions(screen.getByLabelText("gRPC method"), "SayHello");

    // Send → the OK status pill renders from the mock response.
    await act(async () => {
      await user.click(screen.getByTestId("grpc-send"));
    });
    await waitFor(() => expect(h.ipc.calls("grpc_send")).toHaveLength(1));
    expect(await screen.findByTestId("grpc-status")).toHaveTextContent("0 OK");
    await settle();
  });
});
