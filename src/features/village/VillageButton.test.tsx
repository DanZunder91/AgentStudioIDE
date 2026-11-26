/** Starts from the button: a store-level test cannot see which action a button calls. */

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useAppStore } from "../../app/store";
import { resetStore } from "../../test/store-harness";
import { VillageButton } from "./VillageButton";

beforeEach(() => resetStore());

describe("VillageButton", () => {
  it("calls openVillageTab, with its titlebar test id and the house glyph", () => {
    const open = vi.fn();
    useAppStore.setState((s) => {
      s.layoutActions = { ...s.layoutActions, openVillageTab: open };
    });
    render(<VillageButton />);
    const btn = screen.getByRole("button", { name: "Agent Village" });
    expect(btn.title).toBe("Agent Village");
    expect(btn.getAttribute("data-testid")).toBe("titlebar-village");
    expect(btn.querySelector('[data-icon="village"]')).not.toBeNull();
    fireEvent.click(btn);
    expect(open).toHaveBeenCalledTimes(1);
  });
});
