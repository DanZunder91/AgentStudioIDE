/** App's wiring: CSP reporter mounted once and unsubscribed on unmount; right-rail routing. */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const stop = vi.fn();
  const startCspReporter = vi.fn(() => stop);
  return { stop, startCspReporter };
});

vi.mock("./features/logs/cspReporter", () => ({
  CSP_LOG_SOURCE: "csp",
  startCspReporter: mocks.startCspReporter,
}));

// `<CloseTabShortcut>` calls `listen()` on mount; the real one needs `__TAURI_INTERNALS__` (absent
// in jsdom) and rejects after the test, failing the run. Only `setup.browser.ts` stubs it globally.
vi.mock("@tauri-apps/api/event", () => ({
  listen: () => Promise.resolve(() => {}),
  once: () => Promise.resolve(() => {}),
  emit: () => Promise.resolve(),
  emitTo: () => Promise.resolve(),
  TauriEvent: {},
}));

import App from "./App";
import { useAppStore } from "./app/store";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("App — CSP violation reporter", () => {
  it("renders NO project label in the titlebar", () => {
    // Actions-only titlebar: one `workspaceRoot` name in a multi-root app implies a "current
    // project" that scopes nothing, so the folder name must appear nowhere in it.
    useAppStore.setState((s) => {
      s.workspaceRoot = "/Users/me/projects/orders-api";
    });
    render(<App />);

    const titlebar = document.querySelector(".titlebar");
    expect(titlebar).not.toBeNull();
    expect(titlebar?.textContent ?? "").not.toContain("orders-api");
    // …and the decorative dot that read like a status indicator is gone too.
    expect(document.querySelector(".titlebar__dot")).toBeNull();
    // The action cluster is still there — we removed a label, not the toolbar.
    expect(document.querySelector('[data-testid="rail-toggle-left"]')).not.toBeNull();
  });

  it("the find button's tooltip names this platform's chord — never a ⌘ on Windows", () => {
    const ua = vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
    try {
      render(<App />);
      expect(screen.getByTestId("titlebar-find")).toHaveAttribute("title", "Find in files (Ctrl+Shift+F)");
    } finally {
      ua.mockRestore();
    }
  });

  it("starts the reporter once on mount and stops it on unmount", () => {
    const { unmount } = render(<App />);

    expect(mocks.startCspReporter).toHaveBeenCalledTimes(1);
    expect(mocks.stop).not.toHaveBeenCalled();

    unmount();
    expect(mocks.stop).toHaveBeenCalledTimes(1);
    // Unmount does not re-arm it behind the module's back.
    expect(mocks.startCspReporter).toHaveBeenCalledTimes(1);
  });
});

/** Routing lives only in App.tsx's chain; asserted two-sided (right panel present, other gone)
 * because a new `RightRailTab` with no arm silently renders the fallback's panel. */
describe("App — right rail tab routing", () => {
  beforeEach(() => {
    // This file does not use the shared store harness (it asserts on the real shell),
    // so reset just the one field these tests move; `rightRailTab` is sticky store
    // state and would otherwise leak into whichever test runs next.
    useAppStore.setState((s) => {
      s.rightRailTab = "files";
    });
  });
  afterEach(cleanup);

  it("mounts the Tools panel — and unmounts the DB one — when the Tools tab is clicked", () => {
    render(<App />);
    // Precondition: the rail boots on Files, so neither panel is up yet. Without this
    // the assertions below could pass on a rail that was already showing Tools.
    expect(screen.queryByTestId("tools-panel")).toBeNull();

    fireEvent.click(screen.getByTestId("rail-tab-tools"));

    expect(useAppStore.getState().rightRailTab).toBe("tools");
    expect(screen.getByTestId("tools-panel")).not.toBeNull();
    // …and the old fallthrough panel is NOT what got rendered. This is the assertion
    // that fails if the final `else` is left as `<DbPanel/>`.
    expect(screen.queryByTestId("db-panel")).toBeNull();
  });

  it("still mounts the DB panel from its own explicit arm", () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("rail-tab-db"));

    expect(useAppStore.getState().rightRailTab).toBe("db");
    expect(screen.getByTestId("db-panel")).not.toBeNull();
    // `db` must be a real arm, not a leftover fallthrough that Tools now occupies.
    expect(screen.queryByTestId("tools-panel")).toBeNull();
  });

  it("mounts the Git panel — and unmounts the Tools one — when the Git tab is clicked", () => {
    render(<App />);
    // Precondition, same reasoning as the Tools test above: prove the panel was not
    // already up before the click.
    expect(screen.queryByTestId("git-panel")).toBeNull();

    fireEvent.click(screen.getByTestId("rail-tab-git"));

    expect(useAppStore.getState().rightRailTab).toBe("git");
    expect(screen.getByTestId("git-panel")).not.toBeNull();
    // …and the PREVIOUS fallthrough panel is not what got rendered. This is the
    // assertion that fails if `tools` had been left as the chain's bare `else` when
    // the seventh tab was appended (the same trap Tools exposed).
    expect(screen.queryByTestId("tools-panel")).toBeNull();
  });

  it("still mounts the Tools panel from its own explicit arm", () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("rail-tab-tools"));

    expect(useAppStore.getState().rightRailTab).toBe("tools");
    expect(screen.getByTestId("tools-panel")).not.toBeNull();
    // `tools` must be a real arm, not a leftover fallthrough that Git now occupies.
    expect(screen.queryByTestId("git-panel")).toBeNull();
  });
});
