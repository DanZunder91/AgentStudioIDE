/**
 * `<FolderGroupRow>` — the folder-group header.
 *
 * Rendered in isolation: it names the folder, counts + rolls up its agents,
 * discloses the group, and carries a per-folder `+` that launches another agent
 * in that folder.
 */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fireDragLeave, makeDataTransfer } from "../../test/dnd";

const terminal = vi.hoisted(() => ({
  configureTerminal: vi.fn(),
  dispose: vi.fn(),
  setDefaultTerminalCwd: vi.fn(),
}));
vi.mock("../terminal", () => terminal);

const fleetIpc = vi.hoisted(() => ({ pushRecentProject: vi.fn().mockResolvedValue(undefined) }));
vi.mock("./fleetIpc", () => fleetIpc);

import { useAppStore } from "../../app/store";
import { resetFleetStore } from "../../test/fleet-harness";
import { resetStore } from "../../test/store-harness";
import {
  FOLDER_DND_MIME,
  FolderGroupRow,
  folderPathType,
  type FolderGroupRowProps,
} from "./FolderGroupRow";

/** The centre-pane tab drag MIME — a folder header must ignore it (distinct MIMEs). */
const TAB_DND_MIME = "application/x-agentstudio-tab";

const state = () => useAppStore.getState();

function renderFolder(over: Partial<FolderGroupRowProps> = {}) {
  return render(
    <FolderGroupRow
      path={over.path ?? "/w/gazelle"}
      name={over.name ?? "gazelle"}
      agentCount={over.agentCount ?? 2}
      rollupRunning={over.rollupRunning ?? 0}
      rollupDone={over.rollupDone ?? 0}
      rollupError={over.rollupError ?? 0}
      collapsed={over.collapsed ?? false}
    />,
  );
}

const header = () => screen.getByRole("treeitem");

beforeEach(() => {
  resetStore();
  resetFleetStore();
  terminal.configureTerminal.mockClear();
  fleetIpc.pushRecentProject.mockClear();
});
afterEach(() => cleanup());

describe("FolderGroupRow", () => {
  it("renders the basename, agent count and a rollup summary", () => {
    renderFolder({ name: "gazelle", agentCount: 3, rollupRunning: 2, rollupDone: 1 });
    expect(header()).toHaveTextContent("gazelle");
    expect(screen.getByLabelText("3 agents")).toBeInTheDocument();
    expect(header()).toHaveTextContent("2 running · 1 done");
  });

  it("shows ▼ / aria-expanded when open, ▶ when collapsed", () => {
    const { rerender } = renderFolder({ collapsed: false });
    expect(header()).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Collapse folder gazelle" })).toBeInTheDocument();

    rerender(
      <FolderGroupRow
        path="/w/gazelle"
        name="gazelle"
        agentCount={2}
        rollupRunning={0}
        rollupDone={0}
        rollupError={0}
        collapsed
      />,
    );
    expect(header()).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "Expand folder gazelle" })).toBeInTheDocument();
  });

  it("flags attention (error styling) when the rollup has an error", () => {
    renderFolder({ rollupError: 1 });
    expect(header()).toHaveClass("folder-group--attention");
  });

  it("clicking the header toggles the folder's collapse state", async () => {
    const user = userEvent.setup();
    renderFolder({ path: "/w/gazelle", collapsed: false });

    await user.click(screen.getByRole("button", { name: "Collapse folder gazelle" }));

    expect(state().collapsedFolders.has("/w/gazelle")).toBe(true);
  });

  it("the per-folder + launches an agent IN that folder and records it recent", async () => {
    const user = userEvent.setup();
    renderFolder({ path: "/w/gazelle", name: "gazelle" });

    await user.click(screen.getByRole("button", { name: "New agent in gazelle" }));

    const agentId = state().rootAgentIds[0];
    expect(agentId).toBeDefined();
    expect(state().agents[agentId].cwd).toBe("/w/gazelle");
    expect(state().recentProjects[0]).toBe("/w/gazelle");
    expect(fleetIpc.pushRecentProject).toHaveBeenCalledWith("/w/gazelle");
  });

  it("launches even if persisting the recent project fails", async () => {
    const user = userEvent.setup();
    fleetIpc.pushRecentProject.mockRejectedValueOnce(new Error("disk full"));
    renderFolder({ path: "/w/gazelle", name: "gazelle" });

    await user.click(screen.getByRole("button", { name: "New agent in gazelle" }));

    // The agent is created regardless — the recents push is best-effort.
    expect(state().rootAgentIds).toHaveLength(1);
    expect(state().agents[state().rootAgentIds[0]].cwd).toBe("/w/gazelle");
  });

  it("omits the rollup text when there is nothing to summarize", () => {
    renderFolder({ rollupRunning: 0, rollupDone: 0, rollupError: 0 });
    expect(header()).not.toHaveTextContent("running");
    expect(header()).not.toHaveTextContent("done");
  });
});

describe("FolderGroupRow — drag-to-reorder", () => {
  /** Simulate a folder drag already in flight from `path` (the source markers). */
  const dragFrom = (path: string) =>
    makeDataTransfer({ [FOLDER_DND_MIME]: path, [folderPathType(path)]: "" });

  it("is draggable and puts its path on the dataTransfer under the folder MIME", () => {
    renderFolder({ path: "/w/gazelle" });
    expect(header()).toHaveAttribute("draggable", "true");

    // A capture object (not makeDataTransfer): `types` is snapshotted at creation,
    // so setData made during dragStart would not show up on a pre-built one.
    const data = new Map<string, string>();
    const dataTransfer = { setData: (t: string, v: string) => data.set(t, v), effectAllowed: "" };
    fireEvent.dragStart(header(), { dataTransfer });

    expect(data.get(FOLDER_DND_MIME)).toBe("/w/gazelle");
    expect(data.has(folderPathType("/w/gazelle"))).toBe(true);
    expect(dataTransfer.effectAllowed).toBe("move");
    expect(header()).toHaveClass("folder-group--dragging");

    fireEvent.dragEnd(header());
    expect(screen.getByRole("treeitem")).not.toHaveClass("folder-group--dragging");
  });

  it("accepts a folder drag from ANOTHER folder — dropEffect move + a drop cue", () => {
    renderFolder({ path: "/w/gazelle" });
    const dt = dragFrom("/w/api");
    fireEvent.dragOver(header(), { dataTransfer: dt });

    expect(dt.dropEffect).toBe("move");
    expect(header()).toHaveClass("folder-group--drop-target");
  });

  it("shows NO drop cue when dragged over itself (a self-drop is a no-op)", () => {
    renderFolder({ path: "/w/gazelle" });
    const dt = dragFrom("/w/gazelle");
    fireEvent.dragOver(header(), { dataTransfer: dt });

    expect(dt.dropEffect).toBe("");
    expect(header()).not.toHaveClass("folder-group--drop-target");
  });

  it("ignores a non-folder drag (a centre-pane tab)", () => {
    renderFolder({ path: "/w/gazelle" });
    const dt = makeDataTransfer({ [TAB_DND_MIME]: "t1" });
    fireEvent.dragOver(header(), { dataTransfer: dt });

    expect(dt.dropEffect).toBe("");
    expect(header()).not.toHaveClass("folder-group--drop-target");
  });

  it("dropping folder A onto folder B moves A immediately before B", () => {
    act(() =>
      useAppStore.setState((s) => {
        s.folderOrder = ["/w/gazelle", "/w/api"];
      }),
    );
    renderFolder({ path: "/w/gazelle" });

    // Drag /w/api's header, drop on /w/gazelle → api lands before gazelle.
    const dt = dragFrom("/w/api");
    fireEvent.drop(header(), { dataTransfer: dt });

    expect(state().folderOrder).toEqual(["/w/api", "/w/gazelle"]);
    expect(header()).not.toHaveClass("folder-group--drop-target");
  });

  it("a self-drop reorders nothing", () => {
    act(() =>
      useAppStore.setState((s) => {
        s.folderOrder = ["/w/gazelle", "/w/api"];
      }),
    );
    renderFolder({ path: "/w/gazelle" });

    const dt = dragFrom("/w/gazelle");
    fireEvent.drop(header(), { dataTransfer: dt });

    expect(state().folderOrder).toEqual(["/w/gazelle", "/w/api"]);
  });

  it("a drop with an empty payload reorders nothing", () => {
    act(() =>
      useAppStore.setState((s) => {
        s.folderOrder = ["/w/gazelle", "/w/api"];
      }),
    );
    renderFolder({ path: "/w/gazelle" });

    const dt = makeDataTransfer({ [FOLDER_DND_MIME]: "" });
    fireEvent.drop(header(), { dataTransfer: dt });

    expect(state().folderOrder).toEqual(["/w/gazelle", "/w/api"]);
  });

  it("ignores a drop that is not a folder drag", () => {
    act(() =>
      useAppStore.setState((s) => {
        s.folderOrder = ["/w/gazelle", "/w/api"];
      }),
    );
    renderFolder({ path: "/w/gazelle" });

    const dt = makeDataTransfer({ [TAB_DND_MIME]: "t1" });
    fireEvent.drop(header(), { dataTransfer: dt });

    expect(state().folderOrder).toEqual(["/w/gazelle", "/w/api"]);
  });

  it("clears the drop cue on drag leave", () => {
    renderFolder({ path: "/w/gazelle" });
    const dt = dragFrom("/w/api");
    fireEvent.dragOver(header(), { dataTransfer: dt });
    expect(header()).toHaveClass("folder-group--drop-target");

    fireDragLeave(header(), null);
    expect(header()).not.toHaveClass("folder-group--drop-target");
  });

  it("keeps the drop cue when the pointer moves to a child, not out of the row", () => {
    renderFolder({ path: "/w/gazelle", name: "gazelle" });
    const dt = dragFrom("/w/api");
    fireEvent.dragOver(header(), { dataTransfer: dt });
    expect(header()).toHaveClass("folder-group--drop-target");

    // relatedTarget still inside the row → not a real leave.
    fireDragLeave(header(), screen.getByRole("button", { name: "Collapse folder gazelle" }));
    expect(header()).toHaveClass("folder-group--drop-target");
  });
});
