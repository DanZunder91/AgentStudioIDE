/**
 * Layer 5 (testing-strategy §1) — the real CodeMirror 6 editor, in Chromium.
 *
 * CM6 needs a real DOM: under jsdom it constructs but never lays out, and its
 * editability/keymap can't be exercised. This tier proves the whole path — read
 * only by default, Shiki colors, opt-in edit, typing → dirty, Cmd/Ctrl+S →
 * write_file, a save error keeping the buffer, and edits surviving a tab switch.
 */

import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAppStore } from "../../app/store";
import { installTauriMock, type TauriMock } from "../../test/tauri-mock";
import { resetStore } from "../../test/store-harness";
import { CodeEditor } from "./CodeEditor";
import { disposeAll } from "./EditorRegistry";

/** "Mod" is Cmd on macOS, Ctrl elsewhere — match what CM6's keymap resolves to. */
const MOD = navigator.platform.toLowerCase().includes("mac") ? "Meta" : "Control";

const tabDirty = (path: string) =>
  Object.values(useAppStore.getState().tabs).some(
    (t) => t.ref.kind === "editor" && t.ref.path === path && Boolean(t.dirty),
  );

const editorTabOpen = (path: string) =>
  Object.values(useAppStore.getState().tabs).some(
    (t) => t.ref.kind === "editor" && t.ref.path === path,
  );

describe("CodeEditor (real CodeMirror 6)", () => {
  let ipc: TauriMock;

  beforeEach(() => {
    disposeAll(); // the registry is a module singleton — clear it between tests
    resetStore();
    ipc = installTauriMock();
  });
  afterEach(() => {
    ipc.reset();
    disposeAll();
  });

  /** Open the editor tab (so dirty/preserve wiring has a tab), then render. */
  const open = (path: string) => {
    useAppStore.getState().layoutActions.openEditorTab(path);
    return render(<CodeEditor path={path} />);
  };

  it("renders content EDITABLE by default, with a line-number gutter and no toggle", async () => {
    ipc.handle("read_file", () => 'fn main() {\n    println!("hi");\n}\n');
    const { container, queryByRole } = open("/w/src/main.rs");

    await vi.waitFor(() => expect(container.querySelector(".cm-content")).toBeTruthy());
    expect(container.querySelector(".cm-editor")!.textContent).toContain("println!");
    expect(container.querySelector(".cm-lineNumbers")).toBeTruthy();
    // Editable immediately (like a normal IDE) — no opt-in Edit button.
    expect(container.querySelector(".cm-content")!.getAttribute("contenteditable")).toBe(
      "true",
    );
    expect(queryByRole("button", { name: "Edit" })).toBeNull();
  });

  it("themes the caret + gutter so the cursor is visible on the dark surface", async () => {
    // The bug: caret invisible on tokyo-night. The chrome theme sets a
    // bright caret-color (native caret, no drawSelection) and a themed gutter.
    ipc.handle("read_file", () => "hello\nworld\n");
    const { container } = open("/w/a.txt");
    await vi.waitFor(() => expect(container.querySelector(".cm-content")).toBeTruthy());

    const content = container.querySelector(".cm-content") as HTMLElement;
    // #c0caf5 → rgb(192, 202, 245): a clearly-visible caret, not the default.
    expect(getComputedStyle(content).caretColor).toBe("rgb(192, 202, 245)");

    // The chrome theme is applied: the gutter carries the Tokyo Night surface.
    const gutters = container.querySelector(".cm-gutters") as HTMLElement;
    expect(getComputedStyle(gutters).backgroundColor).toBe("rgb(26, 27, 38)"); // #1a1b26
  });

  it("applies Shiki syntax colors — a colored token span appears", async () => {
    ipc.handle("read_file", () => "fn main() {}\n");
    const { container } = open("/w/main.rs");

    await vi.waitFor(
      () => expect(container.querySelector('.cm-content span[style*="color"]')).toBeTruthy(),
      { timeout: 5000 },
    );
  });

  it("typing straight into the default-editable buffer marks the tab dirty", async () => {
    ipc.handle("read_file", () => "hello\n");
    const { container } = open("/w/a.txt");
    await vi.waitFor(() => expect(container.querySelector(".cm-content")).toBeTruthy());

    const user = userEvent.setup();
    await user.click(container.querySelector(".cm-content")!); // no Edit step
    await user.keyboard("X");
    await vi.waitFor(() => expect(tabDirty("/w/a.txt")).toBe(true));
    expect(container.querySelector(".cm-content")!.textContent).toContain("Xhello");
  });

  it("Cmd/Ctrl+S writes the buffer and clears dirty on success", async () => {
    ipc.handle("read_file", () => "hello\n");
    let written: { path: string; content: string } | null = null;
    ipc.handle("write_file", (args) => {
      written = args as { path: string; content: string };
      return null;
    });
    const { container } = open("/w/a.txt");
    await vi.waitFor(() => expect(container.querySelector(".cm-content")).toBeTruthy());

    const user = userEvent.setup();
    await user.click(container.querySelector(".cm-content")!);
    await user.keyboard("X");
    await vi.waitFor(() => expect(tabDirty("/w/a.txt")).toBe(true));

    await user.keyboard(`{${MOD}>}s{/${MOD}}`);

    await vi.waitFor(() => expect(written).not.toBeNull());
    expect(written!.path).toBe("/w/a.txt");
    expect(written!.content).toContain("Xhello");
    await vi.waitFor(() => expect(tabDirty("/w/a.txt")).toBe(false)); // dirty cleared
  });

  it("Cmd/Ctrl+W closes the focused editor's tab (native menu can't reach a focused CM)", async () => {
    // The bug: on macOS the menu://close-tab accelerator is silent while
    // CodeMirror's contenteditable holds focus, so a file wouldn't close. The
    // editor's own Mod-w keymap closes its tab regardless.
    ipc.handle("read_file", () => "hello\n");
    const { container } = open("/w/close-me.txt");
    await vi.waitFor(() => expect(container.querySelector(".cm-content")).toBeTruthy());
    expect(editorTabOpen("/w/close-me.txt")).toBe(true);

    const user = userEvent.setup();
    await user.click(container.querySelector(".cm-content")!); // give CM focus

    await user.keyboard(`{${MOD}>}w{/${MOD}}`);

    await vi.waitFor(() => expect(editorTabOpen("/w/close-me.txt")).toBe(false));
  });

  it("a failed save keeps the buffer dirty and surfaces the error", async () => {
    ipc.handle("read_file", () => "hello\n");
    ipc.handle("write_file", () => {
      throw new Error("permission denied");
    });
    const { container, findByRole } = open("/w/ro.txt");
    await vi.waitFor(() => expect(container.querySelector(".cm-content")).toBeTruthy());

    const user = userEvent.setup();
    await user.click(container.querySelector(".cm-content")!);
    await user.keyboard("X");
    await vi.waitFor(() => expect(tabDirty("/w/ro.txt")).toBe(true));

    await user.keyboard(`{${MOD}>}s{/${MOD}}`);

    const alert = await findByRole("alert");
    expect(alert.textContent).toContain("permission denied");
    expect(tabDirty("/w/ro.txt")).toBe(true); // NEVER lose the edits
  });

  it("preserves the buffer across a tab switch (unmount → remount)", async () => {
    ipc.handle("read_file", () => "hello\n");
    const { container, unmount } = open("/w/a.txt");
    await vi.waitFor(() => expect(container.querySelector(".cm-content")).toBeTruthy());

    const user = userEvent.setup();
    await user.click(container.querySelector(".cm-content")!);
    await user.keyboard("EDIT ");
    await vi.waitFor(() => expect(tabDirty("/w/a.txt")).toBe(true));

    unmount(); // switch away — the tab still exists, so the registry keeps the view

    const again = render(<CodeEditor path="/w/a.txt" />);
    await vi.waitFor(() => expect(again.container.querySelector(".cm-content")).toBeTruthy());
    expect(again.container.querySelector(".cm-content")!.textContent).toContain("EDIT hello");
    expect(tabDirty("/w/a.txt")).toBe(true); // still dirty — edits preserved
  });

  /**
   * The calm-state path, on a file that genuinely has no text behind it.
   *
   * 🔴 This used to open `/w/logo.png`, which was accurate until images got their own
   * viewer: a PNG reached `read_file`, got rejected as `"binary file"`, and landed here.
   * That WAS the bug — an image tab is now routed to the image viewer
   * and never asks for text at all. The state itself is still reachable and still
   * matters, so the fixture moves to a non-image binary rather than the test being
   * deleted: `read_file` still rejects a `.bin`, an oversized file and invalid
   * UTF-8, and any of those must stay a calm note rather than a crash.
   */
  it("shows a calm state — never a crash — when read_file rejects", async () => {
    ipc.handle("read_file", () => {
      throw new Error("not valid UTF-8");
    });
    const { findByText } = open("/w/core.bin");
    expect(await findByText(/Can.t preview this file/)).toBeInTheDocument();
  });

  /**
   * The other side of that move, in the tier that can actually mount the thing:
   * a raster image must never reach `read_file` at all.
   */
  it("routes a raster image to the viewer without ever reading it as text", async () => {
    let reads = 0;
    ipc.handle("read_file", () => {
      reads += 1;
      throw new Error("binary file");
    });
    ipc.handle("read_image_data_url", () => "data:image/png;base64,iVBORw0KGgo=");
    const { findByTestId } = open("/w/logo.png");

    expect(await findByTestId("image-viewer")).toBeInTheDocument();
    expect(reads).toBe(0);
  });

  it("keeps a large file READ-ONLY plaintext (not editable, no Shiki)", async () => {
    const big = "x = 1\n".repeat(400_000); // ~2.4 MB, over the gate
    ipc.handle("read_file", () => big);
    const { container } = open("/w/huge.py");

    await vi.waitFor(() => expect(container.querySelector(".cm-content")).toBeTruthy());
    // Gated → read-only (can't meaningfully edit), and no syntax coloring.
    expect(container.querySelector(".cm-content")!.getAttribute("contenteditable")).toBe(
      "false",
    );
    expect(container.querySelector('.cm-content span[style*="color"]')).toBeNull();
  });
});
