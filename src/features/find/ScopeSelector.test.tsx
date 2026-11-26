/** `read_dir` is mocked at the module boundary. The Workspace options must include the primary
 * `workspaceRoot`; the Folder dropdown lists dirs only. */

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const workspaceIpc = vi.hoisted(() => ({ readDir: vi.fn() }));
vi.mock("../workspace/workspaceIpc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../workspace/workspaceIpc")>()),
  readDir: workspaceIpc.readDir,
}));

import { useAppStore } from "../../app/store";
import type { FsEntry } from "../../app/types";
import { resetFleetStore } from "../../test/fleet-harness";
import { resetStore } from "../../test/store-harness";
import {
  ALL_WORKSPACES,
  ScopeSelector,
  folderName,
  scopeRootOf,
  useScope,
  workspaceOptions,
  type ScopeValue,
} from "./ScopeSelector";

const setRoot = (path: string | null) =>
  act(() => {
    useAppStore.setState((s) => {
      s.workspaceRoot = path;
    });
  });

const setBrowseRoots = (paths: string[]) =>
  act(() => {
    useAppStore.setState((s) => {
      s.browseRoots = paths;
    });
  });

const dir = (name: string): FsEntry => ({ name, path: `/w/${name}`, isDir: true });
const file = (name: string): FsEntry => ({ name, path: `/w/${name}`, isDir: false });

const workspaceSelect = () => screen.getByLabelText("Search workspace") as HTMLSelectElement;
const folderSelect = () => screen.getByLabelText("Search folder") as HTMLSelectElement;

beforeEach(() => {
  resetStore();
  resetFleetStore();
  workspaceIpc.readDir.mockReset();
  workspaceIpc.readDir.mockResolvedValue([]);
});

afterEach(() => cleanup());

describe("scopeRootOf", () => {
  it("is null without a workspace", () => {
    expect(scopeRootOf({ workspace: null, folder: "" })).toBeNull();
    expect(scopeRootOf({ workspace: null, folder: "src" })).toBeNull();
  });

  it("is the workspace itself for the whole-workspace choice", () => {
    expect(scopeRootOf({ workspace: "/w", folder: "" })).toBe("/w");
  });

  it("joins workspace + subfolder otherwise", () => {
    expect(scopeRootOf({ workspace: "/w", folder: "src" })).toBe("/w/src");
  });

  it("joins a Windows workspace in its own separator — never a mixed `C:\\w/src`", () => {
    expect(scopeRootOf({ workspace: "C:\\w", folder: "src" })).toBe("C:\\w\\src");
    expect(scopeRootOf({ workspace: "C:\\", folder: "src" })).toBe("C:\\src");
  });
});

describe("workspaceOptions", () => {
  it("puts the primary root first, then the multi-root list", () => {
    expect(workspaceOptions("/w", ["/a", "/b"])).toEqual(["/w", "/a", "/b"]);
  });

  it("dedups (a primary that also appears as a root shows once)", () => {
    expect(workspaceOptions("/w", ["/w", "/b"])).toEqual(["/w", "/b"]);
  });

  it("drops a null primary", () => {
    expect(workspaceOptions(null, ["/a"])).toEqual(["/a"]);
    expect(workspaceOptions(null, [])).toEqual([]);
  });
});

describe("folderName", () => {
  it("is the last path segment, tolerating trailing/mixed separators", () => {
    expect(folderName("/home/me/gazelle")).toBe("gazelle");
    expect(folderName("/home/me/gazelle/")).toBe("gazelle");
    expect(folderName("C:\\Users\\me\\proj")).toBe("proj");
  });

  it("falls back to the whole path when there is no segment", () => {
    expect(folderName("/")).toBe("/");
  });
});

describe("ScopeSelector — component", () => {
  const noop = () => {};
  const value = (over?: Partial<ScopeValue>): ScopeValue => ({
    workspace: "/w",
    folder: "",
    ...over,
  });

  it("lists the primary workspace root (by basename), and dedups the multi-root union", () => {
    setRoot("/home/me/gazelle");
    setBrowseRoots(["/home/me/gazelle", "/home/me/other"]); // first is a dup of the primary

    render(<ScopeSelector value={{ workspace: "/home/me/gazelle", folder: "" }} onChange={noop} />);

    const opts = within(workspaceSelect()).getAllByRole("option") as HTMLOptionElement[];
    // "All workspaces" first, then the deduped union: gazelle (primary)
    // + other — not three roots.
    expect(opts.map((o) => o.value)).toEqual([ALL_WORKSPACES, "/home/me/gazelle", "/home/me/other"]);
    expect(opts.map((o) => o.textContent)).toEqual(["All workspaces", "gazelle", "other"]);
    expect(workspaceSelect().value).toBe("/home/me/gazelle");
  });

  it("loads the selected workspace's subfolders (dirs only) into the Folder dropdown", async () => {
    setRoot("/w");
    workspaceIpc.readDir.mockResolvedValue([dir("src"), file("README.md"), dir("tests")]);

    render(<ScopeSelector value={value()} onChange={noop} />);

    // "Whole workspace" is always first; then the two directories (no file).
    expect(await screen.findByRole("option", { name: "src" })).toBeInTheDocument();
    const opts = within(folderSelect()).getAllByRole("option") as HTMLOptionElement[];
    expect(opts.map((o) => o.textContent)).toEqual(["Whole workspace", "src", "tests"]);
    expect(workspaceIpc.readDir).toHaveBeenCalledWith("/w");
  });

  it("emits a workspace change (resetting the folder to whole-workspace)", () => {
    setRoot("/w");
    setBrowseRoots(["/w2"]);
    const onChange = vi.fn();

    render(<ScopeSelector value={value({ folder: "sub" })} onChange={onChange} />);
    fireEvent.change(workspaceSelect(), { target: { value: "/w2" } });

    expect(onChange).toHaveBeenCalledWith({ workspace: "/w2", folder: "" });
  });

  it("emits a folder change, keeping the workspace", async () => {
    setRoot("/w");
    workspaceIpc.readDir.mockResolvedValue([dir("src")]);
    const onChange = vi.fn();

    render(<ScopeSelector value={value()} onChange={onChange} />);
    await screen.findByRole("option", { name: "src" });
    fireEvent.change(folderSelect(), { target: { value: "src" } });

    expect(onChange).toHaveBeenCalledWith({ workspace: "/w", folder: "src" });
  });

  it("shows a calm 'No folder open' placeholder, never reads a dir, and normalizes an empty pick to null", () => {
    // No workspaceRoot, no browse roots → an empty option set.
    const onChange = vi.fn();
    render(<ScopeSelector value={{ workspace: null, folder: "" }} onChange={onChange} />);

    const opts = within(workspaceSelect()).getAllByRole("option") as HTMLOptionElement[];
    expect(opts).toHaveLength(1);
    expect(opts[0].textContent).toBe("No folder open");
    expect(workspaceIpc.readDir).not.toHaveBeenCalled();

    // The placeholder's empty value normalizes back to a null workspace.
    fireEvent.change(workspaceSelect(), { target: { value: "" } });
    expect(onChange).toHaveBeenCalledWith({ workspace: null, folder: "" });
  });

  it("ignores a superseded folder read when the workspace changes mid-load", async () => {
    setRoot("/w");
    setBrowseRoots(["/w2"]); // both are valid Workspace options
    let resolveStale!: (e: FsEntry[]) => void;
    workspaceIpc.readDir
      .mockImplementationOnce(() => new Promise<FsEntry[]>((r) => (resolveStale = r)))
      .mockResolvedValueOnce([dir("fresh")]);

    const { rerender } = render(
      <ScopeSelector value={{ workspace: "/w", folder: "" }} onChange={noop} />,
    );
    // Switch workspace before the first read resolves → its effect cleanup cancels it.
    rerender(<ScopeSelector value={{ workspace: "/w2", folder: "" }} onChange={noop} />);
    expect(await screen.findByRole("option", { name: "fresh" })).toBeInTheDocument();

    // The stale read now resolves; it must NOT repopulate the (now /w2) dropdown.
    await act(async () => {
      resolveStale([dir("stale")]);
      await Promise.resolve();
    });
    expect(screen.queryByRole("option", { name: "stale" })).toBeNull();
  });

  it("stays calm (Whole workspace only) when read_dir rejects", async () => {
    setRoot("/w");
    workspaceIpc.readDir.mockRejectedValue(new Error("outside the workspace"));

    render(<ScopeSelector value={value()} onChange={noop} />);
    // Let the rejected read settle; the Folder dropdown keeps only its default.
    await act(async () => {});

    const opts = within(folderSelect()).getAllByRole("option") as HTMLOptionElement[];
    expect(opts.map((o) => o.textContent)).toEqual(["Whole workspace"]);
  });

  it("offers 'All workspaces' FIRST in the Workspace dropdown, before the individual roots", () => {
    setRoot("/w");
    setBrowseRoots(["/w2"]);

    render(<ScopeSelector value={value()} onChange={noop} />);

    const opts = within(workspaceSelect()).getAllByRole("option") as HTMLOptionElement[];
    expect(opts.map((o) => o.value)).toEqual([ALL_WORKSPACES, "/w", "/w2"]);
    expect(opts[0].textContent).toBe("All workspaces");
  });

  it("does NOT offer 'All workspaces' when no folder is open (nothing to search across)", () => {
    render(<ScopeSelector value={{ workspace: null, folder: "" }} onChange={noop} />);
    const opts = within(workspaceSelect()).getAllByRole("option") as HTMLOptionElement[];
    expect(opts.map((o) => o.textContent)).toEqual(["No folder open"]);
  });

  it("selecting 'All workspaces' emits the sentinel scope (folder reset)", () => {
    setRoot("/w");
    const onChange = vi.fn();

    render(<ScopeSelector value={value({ folder: "sub" })} onChange={onChange} />);
    fireEvent.change(workspaceSelect(), { target: { value: ALL_WORKSPACES } });

    expect(onChange).toHaveBeenCalledWith({ workspace: ALL_WORKSPACES, folder: "" });
  });

  it("locks the Folder box to a disabled 'All' under 'All workspaces', and reads no dir", () => {
    setRoot("/w");
    render(<ScopeSelector value={{ workspace: ALL_WORKSPACES, folder: "" }} onChange={noop} />);

    const folder = folderSelect();
    expect(folder).toBeDisabled();
    const opts = within(folder).getAllByRole("option") as HTMLOptionElement[];
    expect(opts.map((o) => o.textContent)).toEqual(["All"]);
    // The sentinel is never treated as a directory.
    expect(workspaceIpc.readDir).not.toHaveBeenCalled();
  });
});

/** Through a harness wiring the hook to the real `<ScopeSelector/>`, as the overlays do. */
describe("useScope — scopeRoots + isAll", () => {
  function ScopeHarness(): React.JSX.Element {
    const { effectiveScope, isAll, scopeRoot, scopeRoots, setScope } = useScope();
    return (
      <>
        <ScopeSelector value={effectiveScope} onChange={setScope} />
        <span data-testid="is-all">{String(isAll)}</span>
        <span data-testid="scope-root">{scopeRoot ?? "null"}</span>
        <span data-testid="scope-roots">{scopeRoots.join("|")}</span>
      </>
    );
  }

  const isAll = () => screen.getByTestId("is-all").textContent;
  const singleRoot = () => screen.getByTestId("scope-root").textContent;
  const roots = () => screen.getByTestId("scope-roots").textContent;

  it("a specific workspace (the default) yields one root and isAll=false", () => {
    setRoot("/w");
    setBrowseRoots(["/w2"]);

    render(<ScopeHarness />);
    // Defaults to the primary root with no interaction.
    expect(isAll()).toBe("false");
    expect(singleRoot()).toBe("/w");
    expect(roots()).toBe("/w");
  });

  it("'All workspaces' yields every open root, a null single root, and isAll=true", () => {
    setRoot("/w");
    setBrowseRoots(["/w2"]);

    render(<ScopeHarness />);
    fireEvent.change(workspaceSelect(), { target: { value: ALL_WORKSPACES } });

    expect(isAll()).toBe("true");
    expect(roots()).toBe("/w|/w2");
    // No single root to name under All — the overlays iterate `scopeRoots`.
    expect(singleRoot()).toBe("null");
  });

  it("no workspace open → empty scopeRoots (the 'open a folder' state)", () => {
    render(<ScopeHarness />);
    expect(isAll()).toBe("false");
    expect(roots()).toBe("");
    expect(singleRoot()).toBe("null");
  });
});
