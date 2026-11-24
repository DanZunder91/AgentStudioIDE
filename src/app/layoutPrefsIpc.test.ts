import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Tauri invoke boundary — the wrapper's only dependency.
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { EMPTY_LAYOUT_PREFS, loadLayoutPrefs, saveLayoutPrefs } from "./layoutPrefsIpc";

beforeEach(() => {
  invoke.mockReset();
});

describe("loadLayoutPrefs", () => {
  it("returns the prefs Rust reports", async () => {
    invoke.mockResolvedValue({
      folderOrder: ["/a", "/b"],
      collapsedFolders: ["/a"],
      collapsedRoots: ["/b"],
      focusFollowsAgent: true,
      collapsedApiFolders: ["f-1"],
    });
    await expect(loadLayoutPrefs()).resolves.toEqual({
      folderOrder: ["/a", "/b"],
      collapsedFolders: ["/a"],
      collapsedRoots: ["/b"],
      focusFollowsAgent: true,
      collapsedApiFolders: ["f-1"],
      views: [],
      activeViewId: null,
    });
    expect(invoke).toHaveBeenCalledWith("layout_prefs_load", {});
  });

  it("defaults any field an older Rust build omitted", async () => {
    invoke.mockResolvedValue({ folderOrder: ["/x"] });
    await expect(loadLayoutPrefs()).resolves.toEqual({
      folderOrder: ["/x"],
      collapsedFolders: [],
      collapsedRoots: [],
      focusFollowsAgent: false,
      collapsedApiFolders: [],
      views: [],
      activeViewId: null,
    });
  });

  it("defaults focusFollowsAgent to false when absent but the lists are present", async () => {
    // A pre-feature store carried the three lists but not the toggle.
    invoke.mockResolvedValue({
      folderOrder: ["/a"],
      collapsedFolders: [],
      collapsedRoots: ["/a"],
    });
    await expect(loadLayoutPrefs()).resolves.toEqual({
      folderOrder: ["/a"],
      collapsedFolders: [],
      collapsedRoots: ["/a"],
      focusFollowsAgent: false,
      // A prefs file written before saved-request folders existed omits this too.
      collapsedApiFolders: [],
      // …and one written before the center layout was persisted omits these.
      // Empty, NOT a fabricated view: the store reads "nothing persisted" from
      // the empty list and keeps its own boot view.
      views: [],
      activeViewId: null,
    });
  });

  it("returns the persisted center layout — views, names, splits and all", async () => {
    // 🔴 The two restart bugs, at the wire: a view's NAME and which pane each
    // terminal sat in are the two things that were never on disk.
    const views = [
      {
        id: "v-1",
        name: "Backend",
        layout: {
          type: "split" as const,
          orientation: "row" as const,
          sizes: [0.5, 0.5],
          children: [
            {
              type: "leaf" as const,
              terminals: [{ terminalId: "t-1", customTitle: "gazelle" }],
              activeTerminalId: "t-1",
            },
            {
              type: "leaf" as const,
              terminals: [{ terminalId: "t-2", customTitle: null }],
              activeTerminalId: null,
            },
          ],
        },
      },
      {
        id: "v-2",
        name: "Frontend",
        layout: {
          type: "leaf" as const,
          terminals: [{ terminalId: "t-3", customTitle: null }],
          activeTerminalId: "t-3",
        },
      },
    ];
    invoke.mockResolvedValue({ views, activeViewId: "v-2" });
    const prefs = await loadLayoutPrefs();
    expect(prefs.views).toEqual(views);
    expect(prefs.activeViewId).toBe("v-2");
  });

  it("defaults every field when the payload is an empty object", async () => {
    // Covers each `?? []` fallback (including folderOrder's) — an all-missing blob.
    invoke.mockResolvedValue({});
    await expect(loadLayoutPrefs()).resolves.toEqual(EMPTY_LAYOUT_PREFS);
  });

  it("yields empty prefs (never throws) when the command fails", async () => {
    invoke.mockRejectedValue(new Error("not implemented"));
    await expect(loadLayoutPrefs()).resolves.toEqual(EMPTY_LAYOUT_PREFS);
  });
});

describe("saveLayoutPrefs", () => {
  it("passes the prefs blob under the `prefs` key", async () => {
    invoke.mockResolvedValue(undefined);
    const prefs = { folderOrder: ["/a"], collapsedFolders: [], collapsedRoots: ["/a"] };
    await saveLayoutPrefs(prefs);
    expect(invoke).toHaveBeenCalledWith("layout_prefs_save", { prefs });
  });

  it("round-trips focusFollowsAgent through the save blob", async () => {
    invoke.mockResolvedValue(undefined);
    const prefs = {
      folderOrder: [],
      collapsedFolders: [],
      collapsedRoots: [],
      focusFollowsAgent: true,
    };
    await saveLayoutPrefs(prefs);
    expect(invoke).toHaveBeenCalledWith("layout_prefs_save", { prefs });
  });

  it("carries the center layout through the save blob verbatim", async () => {
    invoke.mockResolvedValue(undefined);
    const prefs = {
      ...EMPTY_LAYOUT_PREFS,
      views: [
        {
          id: "v-1",
          name: "Renamed by the user",
          layout: {
            type: "leaf" as const,
            terminals: [{ terminalId: "t-1", customTitle: "api" }],
            activeTerminalId: "t-1",
          },
        },
      ],
      activeViewId: "v-1",
    };
    await saveLayoutPrefs(prefs);
    expect(invoke).toHaveBeenCalledWith("layout_prefs_save", { prefs });
  });

  it("swallows a failed save (best-effort, never rejects)", async () => {
    invoke.mockRejectedValue(new Error("disk full"));
    await expect(
      saveLayoutPrefs({ ...EMPTY_LAYOUT_PREFS }),
    ).resolves.toBeUndefined();
  });
});
