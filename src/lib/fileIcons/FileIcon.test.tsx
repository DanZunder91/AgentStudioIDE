/** The resolver is spy-mocked (real impls, observable calls): pins the component contract without
 * coupling to the generated map, and makes the React.memo bailout a call count. */

import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FileIcon } from "./FileIcon";
import { resolveFileIconId } from "./resolveIconId";

vi.mock("./resolveIconId", { spy: true });

beforeEach(() => {
  vi.mocked(resolveFileIconId).mockReset();
  vi.mocked(resolveFileIconId).mockReturnValue("stub-id");
});

afterEach(() => {
  cleanup();
});

const svgOf = (container: HTMLElement) => container.querySelector("svg.file-icon")!;

describe("FileIcon", () => {
  it("consults the resolver with the basename and renders <use href='#mi-<id>'> + data-icon-id", () => {
    const { container } = render(<FileIcon name="Cargo.toml" />);

    expect(resolveFileIconId).toHaveBeenCalledWith("Cargo.toml");
    const svg = svgOf(container);
    expect(svg.getAttribute("data-icon-id")).toBe("stub-id");
    expect(svg.querySelector("use")!.getAttribute("href")).toBe("#mi-stub-id");
  });

  it("defaults to 12px and honours an explicit size", () => {
    const { container } = render(<FileIcon name="a.ts" />);
    const svg = svgOf(container);
    expect(svg.getAttribute("width")).toBe("12");
    expect(svg.getAttribute("height")).toBe("12");

    const { container: big } = render(<FileIcon name="a.ts" size={20} />);
    const bigSvg = svgOf(big);
    expect(bigSvg.getAttribute("width")).toBe("20");
    expect(bigSvg.getAttribute("height")).toBe("20");
  });

  it("is decoration: aria-hidden and unfocusable, name provided by the host row", () => {
    const { container } = render(<FileIcon name="a.ts" />);
    const svg = svgOf(container);
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("focusable")).toBe("false");
  });

  it("keeps the base class and appends a custom className", () => {
    const { container } = render(<FileIcon name="a.ts" className="extra" />);
    expect(svgOf(container).getAttribute("class")).toBe("file-icon extra");
  });

  it("memo: a parent re-render with the same props does not re-resolve; a prop change does", () => {
    const Host = ({ name }: { name: string }) => (
      <div>
        <FileIcon name={name} />
      </div>
    );
    const { rerender } = render(<Host name="a.ts" />);
    expect(resolveFileIconId).toHaveBeenCalledTimes(1);

    // Same props, new parent render → React.memo must bail out (the tree
    // re-renders every visible row on selection/git churn).
    rerender(<Host name="a.ts" />);
    expect(resolveFileIconId).toHaveBeenCalledTimes(1);

    rerender(<Host name="b.rs" />);
    expect(resolveFileIconId).toHaveBeenCalledTimes(2);
  });
});
