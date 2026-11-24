/**
 * ReferencesPanel — the find-usages results panel.
 *
 * `revealInEditor` is mocked at the module boundary (opening a real editor tab
 * crosses the CM6/registry seam, tested in the browser tier). What is under test
 * here is the panel's behaviour off the `lspReferences` store seam: the closed /
 * loading / empty / grouped states, the marked span, click-to-open-and-close, and
 * the close button + Esc.
 */

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const reveal = vi.hoisted(() => ({ revealInEditor: vi.fn() }));
vi.mock("./reveal", () => reveal);

import { useAppStore, type ReferenceHit, type ReferencesResult } from "../../app/store";
import { resetStore } from "../../test/store-harness";
import { ReferencesPanel } from "./ReferencesPanel";

const hit = (over: Partial<ReferenceHit> & { display: string; line: number }): ReferenceHit => ({
  path: `/w/${over.display}`,
  col: 1,
  lineText: "x",
  matchStart: 0,
  matchEnd: 1,
  ...over,
});

const setRefs = (result: ReferencesResult | null) =>
  act(() => {
    if (result) useAppStore.getState().lspActions.setReferences(result);
    else useAppStore.getState().lspActions.clearReferences();
  });

const panel = () => screen.queryByTestId("references-panel");

beforeEach(() => {
  resetStore();
  reveal.revealInEditor.mockReset();
});
afterEach(cleanup);

describe("ReferencesPanel", () => {
  it("renders nothing when there is no references result", () => {
    render(<ReferencesPanel />);
    expect(panel()).toBeNull();
  });

  it("shows the loading state with the symbol while the query is in flight", () => {
    render(<ReferencesPanel />);
    setRefs({ symbol: "search", hits: [], loading: true });
    expect(panel()).toBeInTheDocument();
    expect(screen.getByText(/Finding usages of/)).toBeInTheDocument();
    expect(screen.getByText("search")).toBeInTheDocument();
    expect(screen.queryByText("No usages found")).toBeNull();
  });

  it("shows 'No usages found' when the query settles empty", () => {
    render(<ReferencesPanel />);
    setRefs({ symbol: "search", hits: [], loading: false });
    expect(screen.getByText("No usages found")).toBeInTheDocument();
  });

  it("groups usages by file with counts and a pluralized header", () => {
    render(<ReferencesPanel />);
    setRefs({
      symbol: "search",
      loading: false,
      hits: [
        hit({ display: "src/a.rs", line: 3 }),
        hit({ display: "src/a.rs", line: 9 }),
        hit({ display: "src/b.rs", line: 1 }),
      ],
    });

    expect(screen.getByText(/3 usages of/)).toBeInTheDocument();
    const files = screen.getAllByTestId("reference-file");
    expect(files).toHaveLength(2);
    expect(within(files[0]).getByText("a.rs")).toBeInTheDocument();
    expect(within(files[0]).getByText("2")).toBeInTheDocument(); // badge
    expect(within(files[1]).getByText("1")).toBeInTheDocument();
    expect(screen.getAllByTestId("reference-hit")).toHaveLength(3);
  });

  it("uses the singular 'usage' for a single hit", () => {
    render(<ReferencesPanel />);
    setRefs({ symbol: "foo", loading: false, hits: [hit({ display: "src/a.rs", line: 1 })] });
    expect(screen.getByText(/1 usage of/)).toBeInTheDocument();
  });

  it("marks the reference span, with leading indentation trimmed", () => {
    render(<ReferencesPanel />);
    setRefs({
      symbol: "search",
      loading: false,
      hits: [
        hit({
          display: "src/a.rs",
          line: 5,
          lineText: "    let x = search();",
          matchStart: 12,
          matchEnd: 18,
        }),
      ],
    });
    const mark = document.querySelector(".refs-hit__mark")!;
    expect(mark.textContent).toBe("search");
  });

  it("clicking a usage reveals it in the editor AND closes the panel", () => {
    render(<ReferencesPanel />);
    setRefs({
      symbol: "search",
      loading: false,
      hits: [hit({ path: "/w/src/a.rs", display: "src/a.rs", line: 42, col: 7 })],
    });

    fireEvent.click(screen.getByTestId("reference-hit"));
    expect(reveal.revealInEditor).toHaveBeenCalledWith("/w/src/a.rs", 42, 7);
    expect(panel()).toBeNull(); // closed
    expect(useAppStore.getState().lspReferences).toBeNull();
  });

  it("collapses a file group, hiding its hits", () => {
    render(<ReferencesPanel />);
    setRefs({
      symbol: "search",
      loading: false,
      hits: [hit({ display: "src/a.rs", line: 3 }), hit({ display: "src/a.rs", line: 9 })],
    });
    expect(screen.getAllByTestId("reference-hit")).toHaveLength(2);
    fireEvent.click(screen.getByTestId("reference-file"));
    expect(screen.queryByTestId("reference-hit")).toBeNull();
  });

  it("renders a bare filename group (no directory segment)", () => {
    render(<ReferencesPanel />);
    setRefs({
      symbol: "search",
      loading: false,
      hits: [hit({ path: "/main.rs", display: "main.rs", line: 1 })],
    });
    const file = screen.getByTestId("reference-file");
    expect(within(file).getByText("main.rs")).toBeInTheDocument();
    expect(file.querySelector(".refs-group__dir")).toBeNull(); // no dim dir span
  });

  it("expands a collapsed group again on a second click", () => {
    render(<ReferencesPanel />);
    setRefs({
      symbol: "search",
      loading: false,
      hits: [hit({ display: "src/a.rs", line: 3 })],
    });
    const header = screen.getByTestId("reference-file");
    fireEvent.click(header); // collapse
    expect(screen.queryByTestId("reference-hit")).toBeNull();
    fireEvent.click(header); // expand again
    expect(screen.getByTestId("reference-hit")).toBeInTheDocument();
  });

  it("ignores non-Escape keys while open", () => {
    render(<ReferencesPanel />);
    setRefs({ symbol: "search", hits: [], loading: false });
    fireEvent.keyDown(window, { key: "a" });
    expect(panel()).toBeInTheDocument(); // still open
  });

  it("closes on the close button and on Escape", () => {
    render(<ReferencesPanel />);
    setRefs({ symbol: "search", hits: [], loading: false });
    fireEvent.click(screen.getByLabelText("Close usages"));
    expect(panel()).toBeNull();

    setRefs({ symbol: "search", hits: [], loading: false });
    expect(panel()).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(panel()).toBeNull();
  });
});
