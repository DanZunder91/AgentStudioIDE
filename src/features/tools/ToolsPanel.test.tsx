/** The `tools-panel` testid is a contract (App.test.tsx asserts rail routing on it). The panel
 * passes NO props, so this is the only test where the converter's default clock and zone run. */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ToolsPanel } from "./ToolsPanel";

afterEach(cleanup);

describe("ToolsPanel", () => {
  it("renders the rail heading and the epoch converter under the contracted testid", () => {
    render(<ToolsPanel />);

    expect(screen.getByTestId("tools-panel")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Tools" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Epoch ⇄ date" })).toBeInTheDocument();
    expect(screen.getByTestId("epoch-tool")).toBeInTheDocument();
    expect(screen.getByLabelText("Epoch or date to convert")).toBeInTheDocument();
  });

  it("passes no props, so the tool runs on the real clock and the host's own zone", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_700_000_000_000);
      render(<ToolsPanel />);

      // The default `clock` really is `Date.now()`…
      expect(
        screen.getByRole("button", { name: "Use the current epoch 1700000000" }),
      ).toBeInTheDocument();
      // …and the default `timeZone` really is the platform's, not a hardcoded "UTC".
      expect(Intl.DateTimeFormat().resolvedOptions().timeZone).not.toBe("");
    } finally {
      vi.useRealTimers();
    }
  });
});
