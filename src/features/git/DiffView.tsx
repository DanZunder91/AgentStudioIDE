/**
 * DiffView — the `diff` center tab: this file at HEAD, beside this file on disk.
 *
 * Opened from the file tree's right-click **Git ▸ Compare with HEAD**.
 * One `git_file_diff` on mount, then a `@codemirror/merge`
 * `MergeView` with HEAD on the left (`a`) and the working tree on the right
 * (`b`).
 *
 * **Both sides are read-only, deliberately.** v1 is a *viewer*: you look at what
 * changed, and the two ways to act on it are the editor (for the working side)
 * and the tree's explicit `Revert changes…` (for the whole file, behind a
 * confirm). Editing inside the diff is the obvious follow-on and is NOT built —
 * it needs a save path, a dirty flag and an unsaved-changes story that the
 * read-only tab is exempt from today.
 *
 * For the same reason there are **no `revertControls`**. Per-chunk revert arrows
 * would be a second way to mutate the file, one click deep and with no
 * confirmation, sitting inside a surface whose whole promise is that it only
 * shows. The menu item owns reverting and it asks first.
 *
 * Every non-diff outcome is rendered as its own honest sentence rather than an
 * empty box or a false error: loading, the IPC's message inline, binary,
 * identical to HEAD, no HEAD side yet, deleted on disk. `git_file_diff` reports
 * them as fields precisely so this component can distinguish them.
 *
 * The `MergeView` is disposed on unmount. A CodeMirror view that outlives its
 * host is the exact shape of the "eternal Loading…" orphan and of a listener
 * leak.
 */

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

/**
 * What each pane is configured with. `readOnly` (the state facet) is what stops
 * commands and input handlers from producing changes; `editable` is what stops
 * the DOM from being contenteditable at all. Both, because either alone leaves a
 * way in — `readOnly` still renders a text cursor you can type into via IME, and
 * `editable: false` alone still lets a programmatic command mutate the doc.
 */
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

/**
 * The two-pane surface. Split out so its host div is rendered UNCONDITIONALLY:
 * the layout effect then always finds the ref set, and there is no null branch
 * to guard (and none left uncovered) — the same argument `CodeEditor` makes.
 */
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
  /**
   * The fetched answer, TAGGED with the path it is about.
   *
   * Tagging is what resets the view when `path` changes, instead of a
   * `setState({loading})` in the effect body: that shape is a cascading render
   * (and `react-hooks/set-state-in-effect` rejects it), and it also paints one
   * frame of the PREVIOUS file's diff under the new file's heading before the
   * effect runs. Deriving "is this answer about the file I am showing?" during
   * render has neither problem.
   */
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
