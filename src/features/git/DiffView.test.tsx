/** `@codemirror/merge` is mocked (jsdom never lays it out); this pins the config handed to it, and
 * `diffView.browser.test.tsx` drives the real view. The mock is a frozen copy of `DiffView.tsx`'s
 * imports from it: add any new import here, or it fails as an "Unhandled Error". */

import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/** Every `MergeView` constructed, with the exact config object it was given. */
const merge = vi.hoisted(() => ({
  configs: [] as Array<Record<string, unknown>>,
  destroy: vi.fn(),
}));

vi.mock("@codemirror/merge", () => ({
  MergeView: class {
    destroy = merge.destroy;
    constructor(config: Record<string, unknown>) {
      merge.configs.push(config);
    }
  },
}));

import { installTauriMock, type TauriMock } from "../../test/tauri-mock";
import { DiffView } from "./DiffView";
import type { FileDiff } from "./gitIpc";

const PATH = "/w/alpha/src/a.ts";

/** A `FileDiff` with the "ordinary two-sided change" defaults, overridable. */
const diff = (over: Partial<FileDiff> = {}): FileDiff => ({
  path: PATH,
  relative: "src/a.ts",
  head: "const a = 1;\n",
  working: "const a = 2;\n",
  unchanged: false,
  binary: false,
  ...over,
});

/** The single config the component handed `MergeView`. */
const lastConfig = () => {
  expect(merge.configs).toHaveLength(1);
  return merge.configs[0];
};

/** One pane's `EditorStateConfig`, as `MergeView` would have received it. */
const pane = (side: "a" | "b") =>
  lastConfig()[side] as { doc: string; extensions: Extension };

describe("DiffView", () => {
  let ipc: TauriMock;

  beforeEach(() => {
    merge.configs.length = 0;
    merge.destroy.mockClear();
    ipc = installTauriMock();
  });
  afterEach(() => {
    ipc.reset();
  });

  it("shows a loading note before git_file_diff answers, headed by the file's name", () => {
    // A promise that never settles: the component is pinned in its first state.
    ipc.handle("git_file_diff", () => new Promise(() => {}));

    render(<DiffView path={PATH} />);

    expect(screen.getByTestId("diff-loading")).toHaveTextContent("Loading the diff…");
    // No `relative` yet, so the heading falls back to the basename — never blank.
    expect(screen.getByTestId("diff-view")).toHaveTextContent("a.ts");
    expect(merge.configs).toHaveLength(0);
  });

  it("builds a MergeView with HEAD on the left and the working tree on the right", async () => {
    ipc.handle("git_file_diff", () => diff());

    render(<DiffView path={PATH} />);

    await screen.findByTestId("diff-merge");
    expect(ipc.lastCall("git_file_diff")).toEqual({ path: PATH });
    expect(pane("a").doc).toBe("const a = 1;\n"); // HEAD
    expect(pane("b").doc).toBe("const a = 2;\n"); // working tree
    // "was → is" reading order; the package's default is the same, but a default
    // is not a decision until something asserts it.
    expect(lastConfig().orientation).toBe("a-b");
  });

  it("configures BOTH panes read-only — the state facet AND editability", async () => {
    ipc.handle("git_file_diff", () => diff());

    render(<DiffView path={PATH} />);
    await screen.findByTestId("diff-merge");

    // Materialise each side's extensions into a real EditorState and ask it,
    // rather than trusting the shape of an opaque extension array.
    for (const side of ["a", "b"] as const) {
      const state = EditorState.create({ doc: "x", extensions: pane(side).extensions });
      expect(state.readOnly, `${side} readOnly`).toBe(true);
      expect(state.facet(EditorView.editable), `${side} editable`).toBe(false);
    }
  });

  it("collapses long unchanged stretches, gutters and highlights changes — and offers NO revert controls", async () => {
    ipc.handle("git_file_diff", () => diff());

    render(<DiffView path={PATH} />);
    await screen.findByTestId("diff-merge");

    expect(lastConfig().collapseUnchanged).toEqual({ margin: 3, minSize: 4 });
    expect(lastConfig().gutter).toBe(true);
    expect(lastConfig().highlightChanges).toBe(true);
    // The load-bearing absence: per-chunk arrows would be a second, unconfirmed
    // way to mutate the file. The tree's `Revert changes…` owns that, and asks.
    expect(lastConfig().revertControls).toBeUndefined();
    expect(lastConfig().renderRevertControl).toBeUndefined();
  });

  it("mounts the MergeView into its own host element", async () => {
    ipc.handle("git_file_diff", () => diff());

    render(<DiffView path={PATH} />);
    const host = await screen.findByTestId("diff-merge");

    expect(lastConfig().parent).toBe(host);
  });

  it("destroys the MergeView on unmount (a leaked CM view is the eternal-Loading bug)", async () => {
    ipc.handle("git_file_diff", () => diff());

    const { unmount } = render(<DiffView path={PATH} />);
    await screen.findByTestId("diff-merge");
    expect(merge.destroy).not.toHaveBeenCalled();

    unmount();

    expect(merge.destroy).toHaveBeenCalledTimes(1);
  });

  it("heads the view with the REPO-RELATIVE path once the diff has landed", async () => {
    ipc.handle("git_file_diff", () => diff({ relative: "src/a.ts" }));

    render(<DiffView path={PATH} />);

    expect(await screen.findByText("src/a.ts")).toBeInTheDocument();
  });

  it("renders the IPC's message inline, verbatim, and builds no MergeView", async () => {
    ipc.handle("git_file_diff", () => Promise.reject("not in a git repository"));

    render(<DiffView path="/w/notes/a.txt" />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("not in a git repository");
    expect(merge.configs).toHaveLength(0);
  });

  it("renders a thrown Error's message too (not '[object Object]')", async () => {
    ipc.handle("git_file_diff", () => {
      throw new Error("permission denied");
    });

    render(<DiffView path={PATH} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("permission denied");
  });

  it("says so when the file is binary, instead of diffing nothing", async () => {
    ipc.handle("git_file_diff", () => diff({ binary: true, head: null, working: null }));

    render(<DiffView path="/w/alpha/logo.png" />);

    expect(await screen.findByTestId("diff-binary")).toHaveTextContent(
      "Binary file — no text diff.",
    );
    expect(merge.configs).toHaveLength(0);
  });

  it("says the file matches HEAD when it is unchanged, instead of an empty diff", async () => {
    ipc.handle("git_file_diff", () => diff({ unchanged: true, working: "const a = 1;\n" }));

    render(<DiffView path={PATH} />);

    expect(await screen.findByTestId("diff-unchanged")).toHaveTextContent(
      "No changes — this file matches HEAD.",
    );
    expect(merge.configs).toHaveLength(0);
  });

  it("shows a new file's content alone when there is no HEAD side", async () => {
    ipc.handle("git_file_diff", () => diff({ head: null, working: "brand new\n" }));

    render(<DiffView path="/w/alpha/new.ts" />);

    expect(await screen.findByTestId("diff-new")).toHaveTextContent(
      "New file — not yet in HEAD.",
    );
    expect(screen.getByTestId("diff-view")).toHaveTextContent("brand new");
    expect(merge.configs).toHaveLength(0); // nothing to compare against
  });

  it("shows what HEAD still holds when the file is deleted on disk", async () => {
    ipc.handle("git_file_diff", () => diff({ working: null, head: "was here\n" }));

    render(<DiffView path="/w/alpha/gone.ts" />);

    expect(await screen.findByTestId("diff-deleted")).toHaveTextContent("Deleted on disk.");
    expect(screen.getByTestId("diff-view")).toHaveTextContent("was here");
    expect(merge.configs).toHaveLength(0);
  });

  it("re-fetches when the path changes, and shows the new file's diff", async () => {
    ipc.handle("git_file_diff", (args) =>
      diff({ path: String(args.path), relative: String(args.path).slice("/w/alpha/".length) }),
    );

    const { rerender } = render(<DiffView path={PATH} />);
    expect(await screen.findByText("src/a.ts")).toBeInTheDocument();

    rerender(<DiffView path="/w/alpha/src/b.ts" />);

    expect(await screen.findByText("src/b.ts")).toBeInTheDocument();
    expect(screen.queryByText("src/a.ts")).toBeNull();
  });

  it("ignores a diff for the PREVIOUS path that lands after the new one", async () => {
    // Two requests in flight, the abandoned one answering last: without the `stale` guard it would
    // overwrite the current answer and drop the view back to loading.
    const resolvers = new Map<string, (d: FileDiff) => void>();
    ipc.handle(
      "git_file_diff",
      (args) => new Promise<FileDiff>((res) => resolvers.set(String(args.path), res)),
    );

    const A = "/w/alpha/src/a.ts";
    const B = "/w/alpha/src/b.ts";
    const { rerender } = render(<DiffView path={A} />);
    rerender(<DiffView path={B} />);
    await waitFor(() => expect(resolvers.size).toBe(2));

    await act(async () => {
      resolvers.get(B)!(diff({ path: B, relative: "src/b.ts" }));
    });
    expect(screen.getByText("src/b.ts")).toBeInTheDocument();

    await act(async () => {
      resolvers.get(A)!(diff({ path: A, relative: "src/a.ts" }));
    });

    expect(screen.getByText("src/b.ts")).toBeInTheDocument();
    expect(screen.queryByTestId("diff-loading")).toBeNull();
  });

  it("drops a diff that lands after unmount instead of setting state on a dead component", async () => {
    // The `stale` guard. Without it React 19 silently applies the update to a
    // torn-down tree; with it there is nothing to apply. Asserted through the
    // only observable this leaves: no error surfaces and no view is built.
    const errors: unknown[] = [];
    const onError = (e: ErrorEvent) => errors.push(e.error ?? e.message);
    window.addEventListener("error", onError);

    let land: (d: FileDiff) => void = () => {};
    ipc.handle("git_file_diff", () => new Promise<FileDiff>((res) => (land = res)));

    const { unmount } = render(<DiffView path={PATH} />);
    await screen.findByTestId("diff-loading");
    unmount();

    land(diff());
    await waitFor(() => expect(merge.configs).toHaveLength(0));

    window.removeEventListener("error", onError);
    expect(errors).toEqual([]);
  });
});
