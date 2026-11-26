/** The bar owns no matches: pins its label, callbacks, dead ↑/↓ and refocus. Labels are literal
 * strings, not recomputed via `findModel.formatCount`. */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PreviewFindBar } from "./PreviewFindBar";

/** Render with sensible defaults; every prop is overridable per case. */
function renderBar(
  over: Partial<React.ComponentProps<typeof PreviewFindBar>> = {},
): {
  onQueryChange: ReturnType<typeof vi.fn>;
  onStep: ReturnType<typeof vi.fn>;
  onClose: ReturnType<typeof vi.fn>;
  rerender: (next: Partial<React.ComponentProps<typeof PreviewFindBar>>) => void;
} {
  const onQueryChange = vi.fn();
  const onStep = vi.fn();
  const onClose = vi.fn();
  const props: React.ComponentProps<typeof PreviewFindBar> = {
    query: "needle",
    total: 3,
    current: 1,
    focusSignal: 0,
    onQueryChange,
    onStep,
    onClose,
    ...over,
  };
  const view = render(<PreviewFindBar {...props} />);
  return {
    onQueryChange,
    onStep,
    onClose,
    rerender: (next) => view.rerender(<PreviewFindBar {...props} {...next} />),
  };
}

describe("PreviewFindBar", () => {
  it("renders the query and the k/N count", () => {
    renderBar({ query: "mermaid", total: 17, current: 3 });

    expect(screen.getByTestId("preview-find-input")).toHaveValue("mermaid");
    expect(screen.getByTestId("preview-find-count")).toHaveTextContent("3/17");
  });

  it("says '0 results' and disables navigation when nothing matched", () => {
    renderBar({ total: 0, current: 1 });

    expect(screen.getByTestId("preview-find-count")).toHaveTextContent("0 results");
    // Dead affordances are worse than absent ones: the arrows go grey rather
    // than silently doing nothing.
    expect(screen.getByTestId("preview-find-prev")).toBeDisabled();
    expect(screen.getByTestId("preview-find-next")).toBeDisabled();
  });

  it("reports every keystroke to the parent (the query lives there, not here)", () => {
    const { onQueryChange } = renderBar({ query: "" });

    fireEvent.change(screen.getByTestId("preview-find-input"), {
      target: { value: "diagram" },
    });

    expect(onQueryChange).toHaveBeenCalledWith("diagram");
  });

  it("steps forward and back from the arrows", () => {
    const { onStep } = renderBar();

    fireEvent.click(screen.getByTestId("preview-find-next"));
    fireEvent.click(screen.getByTestId("preview-find-prev"));

    expect(onStep.mock.calls).toEqual([[1], [-1]]);
  });

  it("Enter walks the matches and Shift+Enter walks back", () => {
    const { onStep } = renderBar();
    const input = screen.getByTestId("preview-find-input");

    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });

    expect(onStep.mock.calls).toEqual([[1], [-1]]);
  });

  it("ignores every other key in the input", () => {
    const { onStep, onClose } = renderBar();
    const input = screen.getByTestId("preview-find-input");

    fireEvent.keyDown(input, { key: "a" });
    // Escape is handled ONCE, on the preview container, so that closing works
    // identically whether the caret is in the box or the user is scrolling.
    fireEvent.keyDown(input, { key: "Escape" });

    expect(onStep).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes from the ✕", () => {
    const { onClose } = renderBar();

    fireEvent.click(screen.getByTestId("preview-find-close"));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("focuses the input on mount", () => {
    renderBar();

    expect(document.activeElement).toBe(screen.getByTestId("preview-find-input"));
  });

  it("re-focuses AND selects the query when the focus signal is bumped", () => {
    // The point of the signal: a second Cmd/Ctrl+F on an already-open bar must
    // do something. Selecting means the user can just type over the old query.
    const { rerender } = renderBar({ query: "old" });
    const input = screen.getByTestId("preview-find-input") as HTMLInputElement;
    input.blur();
    input.setSelectionRange(3, 3);
    expect(document.activeElement).not.toBe(input);

    rerender({ focusSignal: 1 });

    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(3);
  });

  it("leaves focus alone on a re-render that does NOT bump the signal", () => {
    // Two-sided: without this, "focuses on every render" would pass the case
    // above while stealing the caret back from wherever the user put it.
    const { rerender } = renderBar();
    const input = screen.getByTestId("preview-find-input");
    const elsewhere = document.createElement("input");
    document.body.append(elsewhere);
    elsewhere.focus();

    rerender({ total: 9 });

    expect(document.activeElement).toBe(elsewhere);
    expect(document.activeElement).not.toBe(input);
  });
});
