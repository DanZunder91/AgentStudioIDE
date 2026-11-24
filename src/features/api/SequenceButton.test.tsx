/**
 * `<SequenceButton/>` — the titlebar affordance. Twin of `ApiRequestButton.test`.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiStoreIpc = vi.hoisted(() => ({ loadApiStore: vi.fn(), saveApiStore: vi.fn() }));
vi.mock("./apiStoreIpc", () => apiStoreIpc);
const historyIpc = vi.hoisted(() => ({ loadApiHistory: vi.fn(), saveApiHistory: vi.fn() }));
vi.mock("./historyIpc", () => historyIpc);

import { useAppStore } from "../../app/store";
import { resetStore } from "../../test/store-harness";
import { SequenceButton } from "./SequenceButton";

describe("SequenceButton", () => {
  beforeEach(() => {
    resetStore();
    apiStoreIpc.saveApiStore.mockResolvedValue(undefined);
  });

  it("opens a sequence tab, minting the sequence behind it", async () => {
    const user = userEvent.setup();
    render(<SequenceButton />);
    expect(Object.keys(useAppStore.getState().sequences)).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "New request sequence" }));

    const tabs = Object.values(useAppStore.getState().tabs);
    expect(tabs).toHaveLength(1);
    expect(tabs[0].ref.kind).toBe("sequence");
    // Two-sided: the tab exists AND the sequence it points at was created.
    expect(Object.keys(useAppStore.getState().sequences)).toHaveLength(1);
  });
});
