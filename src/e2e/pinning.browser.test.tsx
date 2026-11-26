/** Agent pinning through the real <App/> in Chromium (testing-strategy §1): a ROOT agent shows
 * the pin toggle and clicking it calls `pin_agent`. Restore-across-restart: the real app only. */

import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import App from "../App";
import { installE2EHarness, resetE2E, settle, teardownE2E, type E2EHarness } from "./harness";

describe("agent pinning — real <App/> over a mocked backend", () => {
  let h: E2EHarness;

  beforeEach(() => {
    resetE2E();
    h = installE2EHarness();
  });
  afterEach(() => {
    teardownE2E(h.ipc);
  });

  it("shows the 📌 toggle on a root agent and pins it on click", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByTestId("app-shell");

    // Quick-launch a root agent (fires agent_spawn; the row appears in the tree).
    await user.click(screen.getByLabelText(/^Quick-launch an agent in /));
    await settle();

    const tree = screen.getByRole("tree", { name: "Agents" });
    const pin = within(tree).getByRole("button", { name: /^Pin/ });
    expect(pin).toHaveAttribute("aria-pressed", "false");

    await act(async () => {
      await user.click(pin);
    });

    // The pin was persisted through the command, and the row flipped to pinned.
    await waitFor(() => expect(h.ipc.calls("pin_agent")).toHaveLength(1));
    expect(within(tree).getByRole("button", { name: /^Unpin/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await settle();
  });
});
