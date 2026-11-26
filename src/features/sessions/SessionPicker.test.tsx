/** `./sessionsIpc` and `../fleet/useLaunchAgent` are mocked: calling the launch path with exactly
 * `{ cwd, resumeSessionId }` is the feature's contract. */

import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sessionsIpc = vi.hoisted(() => ({
  listClaudeSessions: vi.fn(),
}));
vi.mock("./sessionsIpc", () => sessionsIpc);

const launch = vi.hoisted(() => vi.fn());
vi.mock("../fleet/useLaunchAgent", () => ({
  useLaunchAgent: () => launch,
}));

import type { ClaudeSessionMeta } from "./sessionsIpc";
import { RECOVERING_MS, SessionPicker } from "./SessionPicker";

const CWD = "/w/gazelle";

/** Same-year timestamps (built from the wall clock) so dates render short. */
const YEAR = new Date().getFullYear();

const sess = (over: Partial<ClaudeSessionMeta> = {}): ClaudeSessionMeta => ({
  sessionId: "s-1",
  mtimeMs: new Date(YEAR, 6, 24, 16, 2).getTime(),
  sizeBytes: 11 * 1024 * 1024,
  label: "Fix the flatten bug",
  resumable: true,
  ...over,
});

const rows = () => screen.getAllByRole("option");

beforeEach(() => {
  sessionsIpc.listClaudeSessions.mockReset();
  launch.mockReset();
});

describe("SessionPicker — states", () => {
  it("shows a calm loading state while the list is in flight", () => {
    sessionsIpc.listClaudeSessions.mockImplementation(() => new Promise(() => {}));
    render(<SessionPicker cwd={CWD} />);

    expect(screen.getByText("Loading sessions…")).toBeInTheDocument();
    expect(sessionsIpc.listClaudeSessions).toHaveBeenCalledWith(CWD);
  });

  it("shows the empty state — a folder that never ran claude is normal", async () => {
    sessionsIpc.listClaudeSessions.mockResolvedValue([]);
    render(<SessionPicker cwd={CWD} />);

    expect(
      await screen.findByText("No past sessions for this folder"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
  });

  it("shows a calm inline error on rejection — never a crash", async () => {
    sessionsIpc.listClaudeSessions.mockRejectedValue(new Error("scope denied"));
    render(<SessionPicker cwd={CWD} />);

    const note = await screen.findByRole("alert");
    expect(note).toHaveTextContent("Couldn't load sessions: scope denied");
  });

  it("renders a STRING rejection too — Tauri command errors are not Errors", async () => {
    sessionsIpc.listClaudeSessions.mockRejectedValue("no such dir");
    render(<SessionPicker cwd={CWD} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't load sessions: no such dir",
    );
  });

  it("names the folder in the header", async () => {
    sessionsIpc.listClaudeSessions.mockResolvedValue([]);
    render(<SessionPicker cwd={CWD} />);

    expect(screen.getByTitle(CWD)).toHaveTextContent(CWD);
    await screen.findByText("No past sessions for this folder");
  });

  it("survives an unmount while the fetch is still in flight", async () => {
    let resolveList!: (v: ClaudeSessionMeta[]) => void;
    sessionsIpc.listClaudeSessions.mockImplementation(
      () => new Promise<ClaudeSessionMeta[]>((r) => (resolveList = r)),
    );
    const { unmount } = render(<SessionPicker cwd={CWD} />);
    unmount();

    // The active-guard swallows the late resolve — no setState after unmount.
    resolveList([sess()]);
    await act(async () => {});
  });

  it("survives an unmount while the fetch is in flight AND then fails", async () => {
    let rejectList!: (err: unknown) => void;
    sessionsIpc.listClaudeSessions.mockImplementation(
      () => new Promise<ClaudeSessionMeta[]>((_r, reject) => (rejectList = reject)),
    );
    const { unmount } = render(<SessionPicker cwd={CWD} />);
    unmount();

    // Same guard on the error path — a late rejection must not setState either.
    rejectList(new Error("too late"));
    await act(async () => {});
  });
});

describe("SessionPicker — the list", () => {
  it("renders each session's date, label and size, in Rust's (newest-first) order", async () => {
    sessionsIpc.listClaudeSessions.mockResolvedValue([
      sess({ sessionId: "s-new", label: "Fix the flatten bug" }),
      sess({
        sessionId: "s-old",
        label: "Explore the repo",
        mtimeMs: new Date(YEAR, 0, 5, 3, 7).getTime(),
        sizeBytes: 1536,
      }),
    ]);
    render(<SessionPicker cwd={CWD} />);

    const [first, second] = await screen.findAllByRole("option");
    expect(first).toHaveTextContent("Jul 24, 16:02");
    expect(first).toHaveTextContent("Fix the flatten bug");
    expect(first).toHaveTextContent("11 MB");
    expect(second).toHaveTextContent("Jan 5, 03:07");
    expect(second).toHaveTextContent("Explore the repo");
    expect(second).toHaveTextContent("1.5 KB");
  });

  it("dims a non-resumable row, hints why, and marks it disabled for AT", async () => {
    sessionsIpc.listClaudeSessions.mockResolvedValue([
      sess({ sessionId: "s-live" }),
      sess({ sessionId: "s-dead", resumable: false, label: "ancient run" }),
    ]);
    render(<SessionPicker cwd={CWD} />);

    const [live, dead] = await screen.findAllByRole("option");
    expect(dead).toHaveClass("session-row--unresumable");
    expect(dead).toHaveTextContent("(not resumable)");
    expect(dead).toHaveAttribute("aria-disabled", "true");
    expect(live).not.toHaveClass("session-row--unresumable");
    expect(live).not.toHaveAttribute("aria-disabled");
  });

  it("single-click selects (visual only) — it never launches", async () => {
    sessionsIpc.listClaudeSessions.mockResolvedValue([
      sess({ sessionId: "s-1" }),
      sess({ sessionId: "s-2", label: "second" }),
    ]);
    render(<SessionPicker cwd={CWD} />);
    const [first, second] = await screen.findAllByRole("option");

    fireEvent.click(second);
    expect(second).toHaveAttribute("aria-selected", "true");
    expect(second).toHaveClass("session-row--selected");
    expect(first).toHaveAttribute("aria-selected", "false");
    expect(launch).not.toHaveBeenCalled();
  });
});

describe("SessionPicker — recover", () => {
  it("double-click launches the resume with exactly { cwd, resumeSessionId }", async () => {
    sessionsIpc.listClaudeSessions.mockResolvedValue([sess({ sessionId: "s-42" })]);
    render(<SessionPicker cwd={CWD} />);
    const [row] = await screen.findAllByRole("option");

    fireEvent.doubleClick(row);

    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledWith(CWD, { resumeSessionId: "s-42" });
    // Transient in-flight cue on the row; the picker itself stays open.
    expect(row).toHaveClass("session-row--recovering");
    expect(screen.getByText("Recovering…")).toBeInTheDocument();
  });

  it("Enter on a focused row recovers too — keyboard parity", async () => {
    sessionsIpc.listClaudeSessions.mockResolvedValue([sess({ sessionId: "s-kb" })]);
    render(<SessionPicker cwd={CWD} />);
    const [row] = await screen.findAllByRole("option");

    row.focus();
    fireEvent.keyDown(row, { key: "Enter" });

    expect(launch).toHaveBeenCalledWith(CWD, { resumeSessionId: "s-kb" });
  });

  it("other keys do nothing", async () => {
    sessionsIpc.listClaudeSessions.mockResolvedValue([sess()]);
    render(<SessionPicker cwd={CWD} />);
    const [row] = await screen.findAllByRole("option");

    fireEvent.keyDown(row, { key: " " });
    fireEvent.keyDown(row, { key: "Escape" });

    expect(launch).not.toHaveBeenCalled();
  });

  it("a non-resumable row is INERT — double-click and Enter both no-op", async () => {
    sessionsIpc.listClaudeSessions.mockResolvedValue([
      sess({ sessionId: "s-dead", resumable: false }),
    ]);
    render(<SessionPicker cwd={CWD} />);
    const [row] = await screen.findAllByRole("option");

    fireEvent.doubleClick(row);
    fireEvent.keyDown(row, { key: "Enter" });

    expect(launch).not.toHaveBeenCalled();
    expect(screen.queryByText("Recovering…")).not.toBeInTheDocument();
  });

  it("a second double-click while one recover is in flight is a no-op", async () => {
    sessionsIpc.listClaudeSessions.mockResolvedValue([
      sess({ sessionId: "s-1" }),
      sess({ sessionId: "s-2", label: "second" }),
    ]);
    render(<SessionPicker cwd={CWD} />);
    const [first, second] = await screen.findAllByRole("option");

    fireEvent.doubleClick(first);
    fireEvent.doubleClick(first); // same row again
    fireEvent.doubleClick(second); // a different row too

    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledWith(CWD, { resumeSessionId: "s-1" });
  });

  it("the in-flight cue clears after RECOVERING_MS, allowing another recover", async () => {
    vi.useFakeTimers();
    try {
      sessionsIpc.listClaudeSessions.mockResolvedValue([sess({ sessionId: "s-1" })]);
      render(<SessionPicker cwd={CWD} />);
      await act(async () => {}); // flush the resolved fetch under fake timers
      const [row] = rows();

      fireEvent.doubleClick(row);
      expect(screen.getByText("Recovering…")).toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(RECOVERING_MS);
      });
      expect(screen.queryByText("Recovering…")).not.toBeInTheDocument();

      fireEvent.doubleClick(row);
      expect(launch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("unmounting while the cue shows cancels its timer", async () => {
    vi.useFakeTimers();
    try {
      sessionsIpc.listClaudeSessions.mockResolvedValue([sess()]);
      const view = render(<SessionPicker cwd={CWD} />);
      await act(async () => {});

      fireEvent.doubleClick(rows()[0]);
      view.unmount();

      // Firing now would be a setState on an unmounted component.
      act(() => {
        vi.advanceTimersByTime(RECOVERING_MS);
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("SessionPicker — refetch", () => {
  it("the ↻ button re-fetches and renders the new list", async () => {
    sessionsIpc.listClaudeSessions
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([sess({ label: "freshly arrived" })]);
    render(<SessionPicker cwd={CWD} />);
    await screen.findByText("No past sessions for this folder");

    fireEvent.click(screen.getByRole("button", { name: "Refresh sessions" }));

    expect(await screen.findByText("freshly arrived")).toBeInTheDocument();
    expect(sessionsIpc.listClaudeSessions).toHaveBeenCalledTimes(2);
    expect(sessionsIpc.listClaudeSessions).toHaveBeenLastCalledWith(CWD);
  });

  it("a refresh also recovers from an earlier error", async () => {
    sessionsIpc.listClaudeSessions
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce([sess()]);
    render(<SessionPicker cwd={CWD} />);
    await screen.findByRole("alert");

    fireEvent.click(screen.getByRole("button", { name: "Refresh sessions" }));

    expect(await screen.findByText("Fix the flatten bug")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("a cwd change re-fetches for the new folder", async () => {
    sessionsIpc.listClaudeSessions.mockResolvedValue([]);
    const { rerender } = render(<SessionPicker cwd={CWD} />);
    await screen.findByText("No past sessions for this folder");

    rerender(<SessionPicker cwd="/w/other" />);

    expect(sessionsIpc.listClaudeSessions).toHaveBeenLastCalledWith("/w/other");
    expect(sessionsIpc.listClaudeSessions).toHaveBeenCalledTimes(2);
  });
});
