/**
 * JsonBodyEditor — the highlighted, editable request-body field. The tokenizer is
 * covered in `highlightJson.test.ts`; here we test the widget: it renders the colored
 * highlight layer, edits flow through `onChange`, keydown passes through, and the
 * scroll sync mirrors onto the highlight layer.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { JsonBodyEditor } from "./JsonBodyEditor";

afterEach(cleanup);

const area = () => screen.getByLabelText("Body") as HTMLTextAreaElement;

describe("JsonBodyEditor", () => {
  it("renders the textarea value and a colored highlight layer", () => {
    render(
      <JsonBodyEditor value={'{"k": true}'} onChange={() => {}} ariaLabel="Body" />,
    );
    expect(area().value).toBe('{"k": true}');
    const hl = screen.getByTestId("json-editor-highlight");
    // The key + the boolean are colored via the JsonView palette classes.
    expect(hl.querySelector(".jsonview__key")).not.toBeNull();
    expect(hl.querySelector(".jsonview__bool")).not.toBeNull();
    expect(hl.textContent).toContain('"k"');
  });

  it("calls onChange as the user types", () => {
    const onChange = vi.fn();
    render(<JsonBodyEditor value="" onChange={onChange} ariaLabel="Body" />);
    fireEvent.change(area(), { target: { value: '{"a":1}' } });
    expect(onChange).toHaveBeenCalledWith('{"a":1}');
  });

  it("passes keydown through (e.g. Cmd/Ctrl+Enter to send)", () => {
    const onKeyDown = vi.fn();
    render(
      <JsonBodyEditor value="" onChange={() => {}} ariaLabel="Body" onKeyDown={onKeyDown} />,
    );
    fireEvent.keyDown(area(), { key: "Enter", metaKey: true });
    expect(onKeyDown).toHaveBeenCalled();
  });

  it("mirrors the textarea scroll onto the highlight layer", () => {
    render(<JsonBodyEditor value={"a\n".repeat(50)} onChange={() => {}} ariaLabel="Body" />);
    const hl = screen.getByTestId("json-editor-highlight");
    area().scrollTop = 40;
    fireEvent.scroll(area());
    expect(hl.scrollTop).toBe(40);
  });
});
