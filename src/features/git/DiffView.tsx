/** The `diff` tab: HEAD (left) vs. the working tree (right) in a `MergeView`. Read-only, no
 * `revertControls`: reverting is the tree's confirmed menu item. Each non-diff outcome gets its
 * own sentence. The view is disposed on unmount (an orphaned view leaks listeners). */

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { MergeView } from "@codemirror/merge";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

// The editor feature's chrome theme, so the two panes read as the same dark
// surface the file editor does. A plain value import — nothing in the editor
// feature was restructured to get it.
import { editorChromeTheme } from "../editor/theme";
import { gitFileDiff, type FileDiff } from "./gitIpc";
import "./diff.css";

/** Both: `readOnly` blocks commands but still takes IME input; `editable: false` alone still lets
 * a command mutate the doc. */
const READ_ONLY_PANE: Extension = [
  EditorState.readOnly.of(true),
  EditorView.editable.of(false),
  editorChromeTheme,
];

/** The fetch's three observable states — one union, so no impossible pairs. */
type DiffState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; diff: FileDiff };

/** Rust's rejections are strings; a thrown Error can still reach here in tests. */
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Last path segment. `split` never yields an empty array, so no fallback arm. */
function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1];
}

/** Split out so its host div always renders and the layout effect never sees a null ref. */
function MergeSurface({ a, b }: { a: string; b: string }): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const view = new MergeView({
      a: { doc: a, extensions: READ_ONLY_PANE },
      b: { doc: b, extensions: READ_ONLY_PANE },
      parent: hostRef.current as HTMLDivElement,
      // HEAD first, working tree second — the reading order of "what it was →
      // what it is", matching every other diff the user sees (gh, git, VS Code).
      orientation: "a-b",
      // Long identical stretches collapse to a click-to-expand strip, so a
      // three-line change in a 2000-line file is three lines on screen.
      collapseUnchanged: { margin: 3, minSize: 4 },
      gutter: true,
      highlightChanges: true,
      // No `revertControls` — see this module's header.
    });
    return () => view.destroy();
  }, [a, b]);

  return <div className="diff-view__merge" data-testid="diff-merge" ref={hostRef} />;
}

/** A calm one-line explanation of why there is no side-by-side diff to show. */
function Note({
  testId,
  children,
}: {
  testId: string;
  children: string;
}): React.JSX.Element {
  return (
    <p className="diff-view__note" data-testid={testId}>
      {children}
    </p>
  );
}

/** The body — every state distinguishable from every other, on purpose. */
function DiffBody({ state }: { state: DiffState }): React.JSX.Element {
  if (state.status === "loading") {
    return <Note testId="diff-loading">Loading the diff…</Note>;
  }
  if (state.status === "error") {
    // role="alert" and the message verbatim: "not in a git repository" is the
    // answer, and paraphrasing it would lose the only useful part.
    return (
      <p className="diff-view__note diff-view__note--error" role="alert" data-testid="diff-error">
        {state.message}
      </p>
    );
  }

  const diff = state.diff;
  if (diff.binary) {
    return <Note testId="diff-binary">Binary file — no text diff.</Note>;
  }
  if (diff.unchanged) {
    return <Note testId="diff-unchanged">No changes — this file matches HEAD.</Note>;
  }
  if (diff.head === null) {
    // Nothing to compare against, so there is no diff — just the file. Rendered
    // as plain text rather than a one-sided MergeView, which would paint the
    // whole file as an insertion and say less than the sentence above it does.
    return (
      <>
        <Note testId="diff-new">New file — not yet in HEAD.</Note>
        <pre className="diff-view__plain">{diff.working}</pre>
      </>
    );
  }
  if (diff.working === null) {
    // The tree cannot launch this state (a deleted file has no row), but the
    // file can vanish between the right-click and the IPC — so it is reachable,
    // and showing what HEAD still holds is the useful half of the answer.
    return (
      <>
        <Note testId="diff-deleted">Deleted on disk.</Note>
        <pre className="diff-view__plain">{diff.head}</pre>
      </>
    );
  }
  return <MergeSurface a={diff.head} b={diff.working} />;
}

export function DiffView({ path }: { path: string }): React.JSX.Element {
  /** Tagged with its path, so a path change resets the view during render: no setState in the
   * effect (`react-hooks/set-state-in-effect`), no frame of the previous file's diff. */
  const [result, setResult] = useState<{ path: string; state: DiffState } | null>(null);

  useEffect(() => {
    let stale = false;
    // One settle point, so there is ONE `stale` guard rather than two — an
    // unmount mid-flight is a single branch to cover, not a pair.
    const settle = (state: DiffState): void => {
      if (!stale) setResult({ path, state });
    };
    gitFileDiff(path).then(
      (diff) => settle({ status: "ready", diff }),
      (e: unknown) => settle({ status: "error", message: errMsg(e) }),
    );
    return () => {
      stale = true;
    };
  }, [path]);

  // Nothing yet, or an answer about a file we are no longer showing: loading.
  const state: DiffState =
    result !== null && result.path === path ? result.state : { status: "loading" };

  // The repo-relative path once we have it — what a diff is about is its place
  // in the repo, not its place on this machine's disk.
  const heading = state.status === "ready" ? state.diff.relative : basename(path);

  return (
    <div className="diff-view" data-testid="diff-view" data-path={path}>
      <div className="diff-view__header">
        <span className="diff-view__title" title={path}>
          {heading}
        </span>
        <span className="diff-view__sides">HEAD ↔ Working tree</span>
      </div>
      <div className="diff-view__body">
        <DiffBody state={state} />
      </div>
    </div>
  );
}
