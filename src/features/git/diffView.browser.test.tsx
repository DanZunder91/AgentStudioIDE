/**
 * Layer 5 (testing-strategy §1) — the REAL `@codemirror/merge` view, in Chromium.
 *
 * `DiffView.test.tsx` mocks the package, so it can prove what configuration this
 * component asks for and nothing at all about what the user sees. A `MergeView`
 * needs a layout engine: under jsdom it constructs, computes no geometry, and
 * every claim about changed lines, collapsed regions or contenteditable would be
 * vacuously true. This tier is where those claims are made.
 *
 * What is proved here: the two panes exist with HEAD on the left and the working
 * tree on the right, the changed lines are actually marked, a long identical
 * stretch really does collapse, NEITHER side is editable and neither carries a
 * revert control, and unmounting takes the whole view out of the DOM.
 */

import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installTauriMock, type TauriMock } from "../../test/tauri-mock";
import { DiffView } from "./DiffView";
import type { FileDiff } from "./gitIpc";

const PATH = "/w/alpha/src/a.ts";

const diff = (over: Partial<FileDiff> = {}): FileDiff => ({
  path: PATH,
  relative: "src/a.ts",
  head: "const a = 1;\n",
  working: "const a = 2;\n",
  unchanged: false,
  binary: false,
  ...over,
});

/** `n` identical lines — the filler a `collapseUnchanged` test needs. */
const filler = (n: number) =>
  Array.from({ length: n }, (_, i) => `// line ${i}`).join("\n");

describe("DiffView (real @codemirror/merge, real layout)", () => {
  let ipc: TauriMock;

  beforeEach(() => {
    ipc = installTauriMock();
  });
  afterEach(() => {
    ipc.reset();
  });

  /** Render and wait for the merge view to lay out. */
  const open = async (d: FileDiff, path = PATH) => {
    ipc.handle("git_file_diff", () => d);
    const out = render(<DiffView path={path} />);
    await vi.waitFor(() =>
      expect(out.container.querySelector(".cm-mergeView")).toBeTruthy(),
    );
    return out;
  };

  it("shows HEAD on the left and the working tree on the right, both laid out", async () => {
    const { container } = await open(
      diff({ head: "const a = 1;\n", working: "const a = 2;\n" }),
    );

    const editors = container.querySelectorAll(".cm-mergeView .cm-editor");
    expect(editors).toHaveLength(2);
    expect(editors[0].textContent).toContain("const a = 1;");
    expect(editors[1].textContent).toContain("const a = 2;");

    // Real layout: both panes have real width, so this is a document, not a stub.
    expect(editors[0].getBoundingClientRect().width).toBeGreaterThan(0);
    expect(editors[1].getBoundingClientRect().width).toBeGreaterThan(0);
  });

  it("MARKS the changed line on both sides (highlightChanges is doing work)", async () => {
    const { container } = await open(
      diff({
        head: `${filler(2)}\nconst a = 1;\n`,
        working: `${filler(2)}\nconst a = 2;\n`,
      }),
    );

    await vi.waitFor(() =>
      expect(container.querySelectorAll(".cm-changedLine").length).toBeGreaterThan(0),
    );
    // Both panes carry a marked line — a one-sided highlight would mean the diff
    // is being drawn against the wrong document.
    const editors = container.querySelectorAll<HTMLElement>(".cm-mergeView .cm-editor");
    expect(editors[0].querySelectorAll(".cm-changedLine").length).toBeGreaterThan(0);
    expect(editors[1].querySelectorAll(".cm-changedLine").length).toBeGreaterThan(0);
    // …and the changed TEXT inside it is marked, not just the whole line.
    expect(container.querySelectorAll(".cm-changedText").length).toBeGreaterThan(0);
  });

  it("collapses a long identical stretch, so a small change stays a small screen", async () => {
    const long = filler(80);
    const { container } = await open(
      diff({ head: `changed head\n${long}\n`, working: `changed working\n${long}\n` }),
    );

    await vi.waitFor(() =>
      expect(container.querySelectorAll(".cm-collapsedLines").length).toBeGreaterThan(0),
    );
    // The collapse is what keeps the rendered document short — the 80 filler
    // lines are not all painted.
    const lines = container.querySelectorAll(".cm-mergeView .cm-editor .cm-line");
    expect(lines.length).toBeLessThan(80);
  });

  it("does NOT collapse a short file (minSize is a threshold, not a policy)", async () => {
    // Two-sided against the test above: if `collapseUnchanged`
    // were collapsing unconditionally, that test would pass for the wrong reason.
    const { container } = await open(
      diff({ head: "one\ntwo\nHEAD\n", working: "one\ntwo\nWORK\n" }),
    );

    expect(container.querySelectorAll(".cm-collapsedLines")).toHaveLength(0);
  });

  it("keeps BOTH sides read-only — typing into either changes nothing", async () => {
    const { container } = await open(diff());

    const contents = container.querySelectorAll<HTMLElement>(".cm-mergeView .cm-content");
    expect(contents).toHaveLength(2);
    for (const el of contents) expect(el.getAttribute("contenteditable")).toBe("false");

    // And prove it, rather than trusting the attribute: click into the working
    // side and type. A read-only pane keeps its document.
    const user = userEvent.setup();
    await user.click(contents[1]);
    await user.keyboard("XYZ");
    expect(contents[1].textContent).toBe("const a = 2;");
    expect(contents[1].textContent).not.toContain("XYZ");
  });

  it("offers no per-chunk revert control anywhere in the view", async () => {
    const { container } = await open(
      diff({ head: `${filler(2)}\nHEAD\n`, working: `${filler(2)}\nWORK\n` }),
    );

    await vi.waitFor(() =>
      expect(container.querySelectorAll(".cm-changedLine").length).toBeGreaterThan(0),
    );
    // The package draws revert arrows as buttons in the spacer between the panes.
    // There is a change to revert, and still no button — reverting is the tree's
    // confirmed menu item, never a stray click inside a read-only viewer.
    expect(container.querySelectorAll(".cm-merge-revert button")).toHaveLength(0);
    expect(container.querySelectorAll(".cm-mergeView button")).toHaveLength(0);
  });

  it("takes the whole merge view out of the DOM on unmount", async () => {
    const { container, unmount } = await open(diff());
    expect(container.querySelector(".cm-mergeView")).toBeTruthy();

    unmount();

    expect(container.querySelector(".cm-mergeView")).toBeNull();
    expect(container.querySelector(".cm-editor")).toBeNull();
  });

  it("renders the no-diff states as text, with no merge view at all", async () => {
    ipc.handle("git_file_diff", () => diff({ unchanged: true, working: "const a = 1;\n" }));
    const { container, findByTestId } = render(<DiffView path={PATH} />);

    expect(await findByTestId("diff-unchanged")).toBeInTheDocument();
    expect(container.querySelector(".cm-mergeView")).toBeNull();
  });
});
