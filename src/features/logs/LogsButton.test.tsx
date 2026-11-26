import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useLogStore } from "./logStore";
import { LogsButton } from "./LogsButton";

function resetLogStore(): void {
  useLogStore.setState({ entries: [], visible: false, levelFilter: "all", textFilter: "", nextId: 0 });
}

const button = () => screen.getByRole("button", { name: "Logs" });

beforeEach(() => resetLogStore());
afterEach(cleanup);

describe("LogsButton", () => {
  it("toggles the store's visibility and reflects it via aria-pressed", () => {
    render(<LogsButton />);
    expect(button()).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(button());
    expect(useLogStore.getState().visible).toBe(true);
    expect(button()).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(button());
    expect(useLogStore.getState().visible).toBe(false);
    expect(button()).toHaveAttribute("aria-pressed", "false");
  });

  it("renders no count badge when the feed is empty", () => {
    render(<LogsButton />);
    expect(document.querySelector(".logs-button__count")).toBeNull();
    expect(button()).toHaveTextContent("");
  });

  it("still renders no number once the feed fills up", () => {
    const s = useLogStore.getState();
    for (let i = 0; i < 120; i++) s.append({ level: "info", source: "s", message: `m${i}` });
    render(<LogsButton />);
    expect(document.querySelector(".logs-button__count")).toBeNull();
    expect(button()).toHaveTextContent("");
    expect(screen.queryByText("99+")).toBeNull();
  });
});
