/**
 * Layer 5 (testing-strategy §1) — the blame gutter in a real CodeMirror 6, in
 * Chromium. jsdom proves the pure logic and the popover controller;
 * only a real layout engine can prove the gutter actually MOUNTS: the column
 * sits LEFT of the line numbers, each visible line carries its label (run
 * collapsing included), and a real hover opens the commit popover.
 */

import { fireEvent, render, type RenderResult } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAppStore } from "../../../app/store";
import { installTauriMock, type TauriMock } from "../../../test/tauri-mock";
import { resetStore } from "../../../test/store-harness";
import { CodeEditor } from "../CodeEditor";
import { disposeAll } from "../EditorRegistry";
import type { FileBlame } from "./blameIpc";

/** Local 2026-05-27 noon — "5/27/26" in every timezone (en-US Chromium). */
const MAY_27 = new Date(2026, 4, 27, 12).getTime();
const JAN_03 = new Date(2026, 0, 3, 12).getTime();

const BLAME: FileBlame = {
  relPath: "src/main.rs",
  commits: [
    {
      id: "8f3a2c1d9e0b7a6f5c4d3e2b1a0f9e8d7c6b5a49",
      author: "Max Turing",
      email: "max@example.com",
      timeMs: MAY_27,
      summary: "feat: add blame gutter",
      message: "feat: add blame gutter\n\nIntelliJ-style annotate view.\n",
    },
    {
      id: "0123456789abcdef0123456789abcdef01234567",
      author: "Ada Lovelace",
      email: "ada@example.com",
      timeMs: JAN_03,
      summary: "init",
      message: "init\n",
    },
  ],
  // 4 doc lines: a two-line run of commit 0, one line of commit 1, one uncommitted.
  lines: [0, 0, 1, null],
};

describe("blame gutter (real CodeMirror 6)", () => {
  let ipc: TauriMock;

  beforeEach(() => {
    disposeAll();
    resetStore();
    ipc = installTauriMock();
    ipc.handle("read_file", () => "one\ntwo\nthree\nfour");
    ipc.handle("git_blame", () => BLAME);
  });
  afterEach(() => {
    ipc.reset();
    disposeAll();
    document.querySelector(".blame-popover")?.remove();
  });

  const open = async (path = "/w/src/main.rs") => {
    useAppStore.getState().layoutActions.openEditorTab(path);
    const utils = render(<CodeEditor path={path} />);
    await vi.waitFor(() => expect(utils.container.querySelector(".cm-content")).toBeTruthy());
    return utils;
  };

  /** Blame toggles from the editor's right-click "Editor tools" menu —
   *  open it on the CM6 host and click whichever Git Blame item it offers
   *  ("Annotate with Git Blame" ↔ "Hide Git Blame"). */
  const toggleBlame = async (utils: RenderResult) => {
    fireEvent.contextMenu(utils.getByTestId("editor-host"), { clientX: 40, clientY: 30 });
    await userEvent.setup().click(await utils.findByRole("menuitem", { name: /Git Blame/ }));
  };

  it("toggling Blame ON mounts the annotation column LEFT of the line numbers", async () => {
    const utils = await open();
    const { container } = utils;
    expect(container.querySelector(".cm-blame-gutter")).toBeNull(); // off by default

    await toggleBlame(utils);
    await vi.waitFor(() => expect(container.querySelector(".cm-blame-gutter")).toBeTruthy());

    // Geometry, not DOM order: the blame column's right edge is left of the
    // line-number gutter's left edge.
    const blameRect = container.querySelector(".cm-blame-gutter")!.getBoundingClientRect();
    const numbersRect = container.querySelector(".cm-lineNumbers")!.getBoundingClientRect();
    expect(blameRect.width).toBeGreaterThan(0);
    expect(blameRect.right).toBeLessThanOrEqual(numbersRect.left + 0.5);
  });

  it("labels first-of-run lines only, and dims uncommitted lines to an em dash", async () => {
    const utils = await open();
    const { container } = utils;
    await toggleBlame(utils);
    await vi.waitFor(() => expect(container.querySelector(".cm-blame-gutter")).toBeTruthy());

    const labels = [...container.querySelectorAll(".cm-blame-line")].map((el) => el.textContent);
    expect(labels).toHaveLength(4);
    expect(labels[0]).toMatch(/Turing$/); // "5/27/26 Turing" (short LOCAL date)
    expect(labels[0]).toMatch(/26/);
    expect(labels[1]).toBe(""); // same-commit run → continuation is blank
    expect(labels[2]).toMatch(/Lovelace$/); // new commit → labeled again
    expect(labels[3]).toBe("—"); // uncommitted
    expect(container.querySelectorAll(".cm-blame-line--none")).toHaveLength(1);
  });

  it("hovering the name opens the full-commit popover; Esc dismisses it", async () => {
    const utils = await open();
    const { container } = utils;
    const user = userEvent.setup();
    await toggleBlame(utils);
    await vi.waitFor(() => expect(container.querySelector(".cm-blame-line")).toBeTruthy());

    await user.hover(container.querySelector(".cm-blame-line")!);
    // The popover appears only after the ~150 ms hover delay.
    expect(document.querySelector(".blame-popover")).toBeNull();
    await vi.waitFor(() => expect(document.querySelector(".blame-popover")).toBeTruthy());

    const popover = document.querySelector(".blame-popover")!;
    expect(popover.querySelector(".blame-popover__hash")!.textContent).toBe(
      "commit 8f3a2c1d9e0b7a6f5c4d3e2b1a0f9e8d7c6b5a49",
    );
    const meta = [...popover.querySelectorAll(".blame-popover__meta")].map((m) => m.textContent);
    expect(meta[0]).toBe("Author: Max Turing <max@example.com>");
    expect(meta[1]).toMatch(/^Date: /);
    expect(meta[1]).toMatch(/May 27, 2026/);
    expect(meta[2]).toBe("Path: src/main.rs");
    expect(popover.querySelector(".blame-popover__message")!.textContent).toBe(
      "feat: add blame gutter\n\nIntelliJ-style annotate view.",
    );

    await user.keyboard("{Escape}");
    expect(document.querySelector(".blame-popover")).toBeNull();
  });

  it("leaving the marker before the delay elapses never opens the popover", async () => {
    const utils = await open();
    const { container } = utils;
    const user = userEvent.setup();
    await toggleBlame(utils);
    await vi.waitFor(() => expect(container.querySelector(".cm-blame-line")).toBeTruthy());

    await user.hover(container.querySelector(".cm-blame-line")!);
    await user.unhover(container.querySelector(".cm-blame-line")!); // swept past
    await new Promise((r) => setTimeout(r, 400));
    expect(document.querySelector(".blame-popover")).toBeNull();
  });

  it("toggling Blame OFF removes the column without recreating the editor", async () => {
    const utils = await open();
    const { container } = utils;
    const user = userEvent.setup();

    // Type first, so we can prove the buffer survives the reconfigure.
    await user.click(container.querySelector(".cm-content")!);
    await user.keyboard("X");

    await toggleBlame(utils); // ON ("Annotate with Git Blame")
    await vi.waitFor(() => expect(container.querySelector(".cm-blame-gutter")).toBeTruthy());

    await toggleBlame(utils); // OFF (the item now reads "Hide Git Blame")
    await vi.waitFor(() => expect(container.querySelector(".cm-blame-gutter")).toBeNull());
    expect(container.querySelector(".cm-content")!.textContent).toContain("Xone"); // buffer intact
  });

  it("a blame shorter than the buffer renders the extra lines as uncommitted (no crash)", async () => {
    ipc.handle("git_blame", () => ({ ...BLAME, lines: [0, 0] })); // 2 entries, 4 lines
    const utils = await open();
    const { container } = utils;
    await toggleBlame(utils);
    await vi.waitFor(() => expect(container.querySelector(".cm-blame-gutter")).toBeTruthy());

    const labels = [...container.querySelectorAll(".cm-blame-line")].map((el) => el.textContent);
    expect(labels).toHaveLength(4);
    expect(labels[2]).toBe("—"); // beyond the blame → clamped to uncommitted
    expect(labels[3]).toBe("—");
  });

  it("git_blame rejecting shows the calm header note — the editor keeps working", async () => {
    ipc.handle("git_blame", () => {
      throw new Error("/w/src/main.rs is not in a git repository");
    });
    const utils = await open();
    const { container, findByTestId } = utils;
    await toggleBlame(utils);

    const note = await findByTestId("blame-note");
    expect(note.textContent).toBe("No git history");
    expect(container.querySelector(".cm-blame-gutter")).toBeNull();
    // Blame turned itself back OFF — the menu item reads "Annotate…" again.
    fireEvent.contextMenu(utils.getByTestId("editor-host"), { clientX: 40, clientY: 30 });
    expect(await utils.findByRole("menuitem", { name: "Annotate with Git Blame" })).toBeTruthy();
  });
});
