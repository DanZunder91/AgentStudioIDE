/**
 * Layer 5 (testing-strategy §1) — the gRPC console, driven through the real <App/>
 * in Chromium over the mocked Tauri backend (native tonic).
 *
 * Proves the wiring the jsdom component tests can't: the protocol toggle mounts the
 * real `GrpcConsole` inside the app, Reflect populates the picker, and a unary Send
 * renders the OK status pill — with NO "install X" degrade path (native gRPC is
 * always available; that is the point of a native engine over a `grpcurl` shell-out).
 */

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
