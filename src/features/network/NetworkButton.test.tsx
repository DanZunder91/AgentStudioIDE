/** Starts from the button: a store-level test cannot see which action a button calls. */

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useAppStore } from "../../app/store";
import { resetStore } from "../../test/store-harness";
import { NetworkButton } from "./NetworkButton";

beforeEach(() => resetStore());

describe("NetworkButton", () => {
  it("calls openNetworkTab, and says what the view covers", () => {
    const open = vi.fn();
    useAppStore.setState((s) => {
      s.layoutActions = { ...s.layoutActions, openNetworkTab: open };
    });
    render(<NetworkButton />);
    const btn = screen.getByRole("button", { name: "Network traffic" });
    expect(btn.title).toContain("every app's connections");
    fireEvent.click(btn);
    expect(open).toHaveBeenCalledTimes(1);
  });
});
