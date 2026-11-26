/** Driven directly: its real hosts unmount it on save, hiding the Enter/Esc→unmount→blur race
 * the `resolved` flag absorbs. */

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";

import { InlineEditInput } from "./InlineEditInput";

afterEach(() => cleanup());

const renderInput = (over: Partial<Parameters<typeof InlineEditInput>[0]> = {}) =>
  render(
    <InlineEditInput
      value={over.value ?? "current"}
      onCommit={over.onCommit ?? vi.fn()}
      onCancel={over.onCancel ?? vi.fn()}
      ariaLabel={over.ariaLabel ?? "Rename"}
      className={over.className}
    />,
  );

const input = () => screen.getByRole("textbox");

describe("InlineEditInput", () => {
  it("focuses on mount, prefilled with the value", () => {
    renderInput({ value: "hello" });
    expect(input()).toHaveValue("hello");
    expect(document.activeElement).toBe(input());
  });

  it("commits the edited value on Enter", () => {
    const onCommit = vi.fn();
    renderInput({ value: "old", onCommit });
    fireEvent.change(input(), { target: { value: "new" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(onCommit).toHaveBeenCalledWith("new");
  });

  it("commits on blur", () => {
    const onCommit = vi.fn();
    renderInput({ value: "v", onCommit });
    fireEvent.blur(input());
    expect(onCommit).toHaveBeenCalledWith("v");
  });

  it("cancels on Escape, without committing", () => {
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    renderInput({ onCommit, onCancel });
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("ignores other keys", () => {
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    renderInput({ onCommit, onCancel });
    fireEvent.keyDown(input(), { key: "a" });
    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("resolves ONCE: a blur after Enter does not commit twice", () => {
    const onCommit = vi.fn();
    renderInput({ onCommit });
    fireEvent.keyDown(input(), { key: "Enter" });
    fireEvent.blur(input()); // the unmount-blur race
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("a blur after Escape does not commit (cancel wins)", () => {
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    renderInput({ onCommit, onCancel });
    fireEvent.keyDown(input(), { key: "Escape" });
    fireEvent.blur(input());
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("ignores a second Escape after cancel", () => {
    const onCancel = vi.fn();
    renderInput({ onCancel });
    fireEvent.keyDown(input(), { key: "Escape" });
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("stops click and mousedown from reaching the parent (no select/drag)", () => {
    const onParentClick = vi.fn();
    const onParentMouseDown = vi.fn();
    render(
      <div onClick={onParentClick} onMouseDown={onParentMouseDown}>
        <InlineEditInput value="v" onCommit={vi.fn()} onCancel={vi.fn()} ariaLabel="Rename" />
      </div>,
    );
    fireEvent.click(input());
    fireEvent.mouseDown(input());
    expect(onParentClick).not.toHaveBeenCalled();
    expect(onParentMouseDown).not.toHaveBeenCalled();
  });
});
