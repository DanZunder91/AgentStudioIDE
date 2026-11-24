/**
 * Browser-tier smoke-core E2E suite (PRIMARY tier).
 *
 * The 8 highest-value end-to-end flows (docs/design/e2e-flow-catalog §4.1) driven
 * against the REAL `<App/>` in real Chromium (Playwright), over a comprehensive
 * mocked Tauri backend (see `harness.ts`). This is the deterministic suite that
 * runs with `npm run test:browser` on a dev machine — the tier that
 * catches the frontend-wiring bugs jsdom cannot (Find not closing on open; a
 * click that "does nothing"): real DOM events, real components, real selectors.
 *
 *   1. B1 — App boots to the 3-pane shell.
 *   2. P1 — New terminal (empty pane) → tab + PTY host + terminal_open.
 *   3. F1 — Quick-launch agent → rail row + agent-terminal tab + agent_spawn.
 *   4. F6 — Close agent → row gone + terminal_close.
 *   5. E1 — Open a workspace file → editor tab with content + read_file.
 *   6. S1→S6 — Find in files → search → open a match → editor opens + Find closes.
 *   7. A2 — API GET → http_send → 200 + body.
 *   8. A3 — API POST → http_send carries method:"POST" + the body.
 *
 * Each `it` is independent: `beforeEach` resets every module-level singleton and
 * reinstalls the mock, mirroring the existing browser specs.
 */

import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "../App";
import { useAppStore } from "../app/store";
import {
  FIND_QUERY,
  FIXTURE_FILE,
  FIXTURE_ROOT,
  installE2EHarness,
  resetE2E,
  settle,
  teardownE2E,
  type E2EHarness,
} from "./harness";

describe("smoke-core E2E — real <App/> over a mocked Tauri backend", () => {
  let h: E2EHarness;

  beforeEach(() => {
    resetE2E();
    h = installE2EHarness();
  });

  afterEach(() => {
    teardownE2E(h.ipc);
  });

  /* ── 1. B1 — boot ── */
  it("B1 — boots to the 3-pane shell with an empty terminal pane", async () => {
    render(<App />);

    // Left rail, right-rail workspace tree, and the center's empty pane all paint.
    expect(await screen.findByTestId("app-shell")).toBeInTheDocument();
    expect(screen.getByTestId("left-rail")).toBeInTheDocument();
    expect(screen.getByTestId("workspace-tree")).toBeInTheDocument();
    expect(screen.getByTestId("empty-pane-new-terminal")).toBeInTheDocument();
  });

  /* ── 2. P1 — new terminal ── */
  it("P1 — New terminal opens a tab + PTY host and fires terminal_open", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByTestId("empty-pane-new-terminal"));
    await settle(); // xterm scheduleOpen fires on setTimeout(0)

    // A real tab and a real xterm host mounted…
    // Scoped to the PANE's tablist: the view bar above is a tablist too, so a bare
    // getByRole("tab") now matches the view chip as well and is ambiguous.
    const paneTabs = screen.getByRole("tablist", { name: "Tabs in this pane" });
    expect(within(paneTabs).getByRole("tab")).toBeInTheDocument();
    expect(document.querySelector("[data-terminal-id]")).toBeTruthy();
    // …and the PTY was opened over the control plane.
    await vi.waitFor(() => expect(h.ipc.calls("terminal_open")).toHaveLength(1));
  });

  /* ── 3. F1 — create agent ── */
  it("F1 — quick-launch adds an agent row + agent-terminal tab and fires agent_spawn", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByLabelText(/^Quick-launch an agent in /));
    await settle();

    // The Agents tree now has the agent row (its Close button is unique to it —
    // the folder-group header that also carries role="treeitem" has no such button).
    const tree = screen.getByRole("tree", { name: "Agents" });
    expect(within(tree).getAllByRole("treeitem").length).toBeGreaterThan(0);
    expect(within(tree).getByRole("button", { name: /^Close agent/ })).toBeInTheDocument();

    // An agent-terminal tab opened in the focused pane… (scoped past the view bar's tablist)
    const paneTabs = screen.getByRole("tablist", { name: "Tabs in this pane" });
    expect(within(paneTabs).getByRole("tab")).toBeInTheDocument();
    // …and the runtime was spawned through the adapter seam (never a raw program).
    await vi.waitFor(() => expect(h.ipc.calls("agent_spawn")).toHaveLength(1));
    expect(h.ipc.lastCall("agent_spawn")!.runtime).toBe("claude-code");
  });

  /* ── 4. F6 — close agent ── */
  it("F6 — closing an agent removes its row and fires terminal_close", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByLabelText(/^Quick-launch an agent in /));
    await settle();
    await vi.waitFor(() => expect(h.ipc.calls("agent_spawn")).toHaveLength(1));

    await user.click(screen.getByRole("button", { name: /^Close agent/ }));
    await settle();

    // The row is gone (its folder group, now empty, collapses away with it)…
    await vi.waitFor(() =>
      expect(screen.queryByRole("button", { name: /^Close agent/ })).toBeNull(),
    );
    // …and the PTY was torn down.
    expect(h.ipc.calls("terminal_close").length).toBeGreaterThanOrEqual(1);
  });

  /* ── 5. E1 — open file ── */
  it("E1 — clicking a workspace file opens the editor with the file's content", async () => {
    const user = userEvent.setup();
    render(<App />);

    // The Files panel is multi-root and empty with no agents, so open
    // the fixture folder as a browse root first — that is the flow a real user
    // takes to see files with no agent running. The fixture root is already mocked
    // for read_dir/read_file, so its listing paints and the file is clickable.
    act(() => {
      useAppStore.getState().workspaceActions.addBrowseRoot(FIXTURE_ROOT);
    });

    // The fixture tree lists README.md and notes.md at the root — pick by path.
    const files = await screen.findAllByTestId("ws-file");
    const readme = files.find((el) => el.getAttribute("data-path") === FIXTURE_FILE);
    expect(readme, "README.md node present in the workspace tree").toBeTruthy();

    await user.click(readme!);

    const editor = await screen.findByTestId("code-editor");
    expect(editor).toHaveAttribute("data-path", FIXTURE_FILE);
    // read_file was invoked for this exact path…
    await vi.waitFor(() =>
      expect(h.ipc.calls("read_file").some((c) => c.args.path === FIXTURE_FILE)).toBe(true),
    );
    // …and its content is rendered in the CodeMirror editor.
    await vi.waitFor(() => expect(editor.textContent).toContain("HELLO_FROM_MOCK_BACKEND"));
  });

  /* ── 6. S1→S6 — Find in files ── */
  it("S1→S6 — Find opens, searches, and opening a match reveals the file and closes Find", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByTestId("app-shell");

    // Mod+Shift+F toggles the overlay open (the window-level hotkey).
    await user.keyboard("{Meta>}{Shift>}F{/Shift}{/Meta}");
    const overlay = await screen.findByTestId("find-in-files");

    await user.type(within(overlay).getByLabelText("Search in files"), FIND_QUERY);

    // After the debounce the search fires and a match row renders.
    await vi.waitFor(
      () => expect(h.ipc.calls("find_in_files").length).toBeGreaterThan(0),
      { timeout: 2000 },
    );
    await user.click(await screen.findByTestId("find-match"));

    // Opening the match reveals the file in an editor tab AND closes the overlay
    // (the "Find not closing" bug this tier exists to catch).
    expect(await screen.findByTestId("code-editor")).toBeInTheDocument();
    await vi.waitFor(() => expect(screen.queryByTestId("find-in-files")).toBeNull());
  });

  /* ── 7. A2 — API GET ── */
  it("A2 — API GET sends the request and renders a 200 response", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByLabelText("New API request"));
    const view = await screen.findByTestId("api-request");

    await user.type(within(view).getByLabelText("Request URL"), "https://api.example.com/things");
    await user.click(screen.getByTestId("api-send"));

    await vi.waitFor(() => expect(h.ipc.calls("http_send")).toHaveLength(1));
    expect(await screen.findByTestId("api-status")).toHaveTextContent("200");
    expect(screen.getByTestId("api-response-body")).toHaveTextContent("mock-backend");

    // A GET carries no body on the wire.
    expect(h.lastHttpRequest()!.method).toBe("GET");
    expect(h.lastHttpRequest()!.body).toBeNull();
  });

  /* ── 8. A3 — API POST ── */
  it("A3 — API POST sends method POST with the typed body", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByLabelText("New API request"));
    const view = await screen.findByTestId("api-request");

    // Selecting POST reveals the body editor (shown only for body-carrying methods).
    await user.selectOptions(within(view).getByLabelText("HTTP method"), "POST");
    await user.type(within(view).getByLabelText("Request URL"), "https://api.example.com/things");
    await user.type(within(view).getByLabelText("Request body"), "sample-post-body");

    await user.click(screen.getByTestId("api-send"));

    await vi.waitFor(() => expect(h.ipc.calls("http_send")).toHaveLength(1));
    const req = h.lastHttpRequest()!;
    expect(req.method).toBe("POST");
    expect(req.body).toBe("sample-post-body");
    expect(await screen.findByTestId("api-response")).toBeInTheDocument();
  });
});
