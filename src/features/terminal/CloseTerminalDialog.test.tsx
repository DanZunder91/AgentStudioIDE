/**
 * CloseTerminalDialog — the confirm in front of closing a busy terminal
 * (closing a terminal that is running claude must first ask for
 * confirmation).
 *
 * ── Driven through the REAL store, not a mock ────────────────────────────────
 * Every test below sets `pendingTerminalClose` on the real Zustand store and
 * resolves it through the real `cancelTerminalClose` / `proceedTerminalClose`.
 * A mocked store would prove the buttons call the functions this file passed
 * them — which is a tautology, not wiring. The one thing mocked is the Tauri
 * IPC boundary (there is no Rust process here), and `layout_prefs_save` is the
 * only command any of this reaches.
 *
 * ── 🔴 The two-sided pair ────────────────────────────────────────────────────
 * "Cancel leaves the terminal alive" is satisfied by a build whose Cancel
 * button is wired to NOTHING — and so is "Escape leaves it alive", and so is
 * every backdrop/other-key assertion in this file. Each of them is therefore
 * paired with its opposite: **Close anyway must actually close the tab**. The
 * pending record here carries a REAL tab id from a REAL terminal tab, so the
 * proceed assertions read `state.tabs[tabId]` after the click — the tab is gone
 * or it is not. A dialog that resolved nothing would pass every "still alive"
 * test in this file and fail every one of those.
 *
 * The Enter pair under "keys" is the same shape applied to a key rather than a
 * button: "Enter cancels" alone is satisfied by a build that intercepts Enter
 * dialog-wide, so it is paired with "Enter on the focused Close anyway closes".
 */

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useAppStore, type PendingTerminalClose } from "../../app/store";
import { asAgentId, asTabId, asTerminalId, type TabId } from "../../app/types";
import { resetStore } from "../../test/store-harness";
import { installTauriMock, type TauriMock } from "../../test/tauri-mock";
import { CloseTerminalDialog } from "./CloseTerminalDialog";
import type { BusyReason, BusyTerminal } from "./terminalBusyIpc";

let ipc: TauriMock;

beforeEach(() => {
  resetStore();
  ipc = installTauriMock();
  // The only command a close reaches: the store persists the layout as an
  // effect. Unhandled commands throw loudly by design, so it is stubbed.
  ipc.handle("layout_prefs_save", () => undefined);
});

afterEach(() => {
  cleanup();
  ipc.reset();
});

/* ────────────────────────────── helpers ──────────────────────────────────── */

const state = () => useAppStore.getState();
const dialog = () => screen.queryByTestId("close-terminal-dialog");
const cancelBtn = () => screen.getByTestId("close-terminal-cancel");
const proceedBtn = () => screen.getByTestId("close-terminal-proceed");

function busy(id: string, reason: BusyReason, label: string): BusyTerminal {
  return { id: asTerminalId(id), reason, label };
}

/** Park a close on the store, exactly as `gateTerminalClose` does. */
function hold(pending: PendingTerminalClose): void {
  act(() => {
    useAppStore.setState((s) => {
      s.pendingTerminalClose = pending;
    });
  });
}

/**
 * A real terminal tab in a real pane, plus a pending close that names it.
 * This is what makes "Close anyway" falsifiable: the replay runs the store's
 * own `closeTab`, so the tab either survives or it does not.
 */
function holdRealTabClose(terminals: BusyTerminal[]): TabId {
  let tabId!: TabId;
  act(() => {
    tabId = state().layoutActions.openTerminalTab({ title: "gazelle" });
  });
  hold({ scope: { kind: "tab", tabId }, terminals });
  return tabId;
}

const ONE_AGENT = [busy("t-1", "agent", "gazelle")];

/* ────────────────────────── nothing pending ──────────────────────────────── */

describe("nothing pending", () => {
  it("renders nothing at all — absence IS 'no close is waiting'", () => {
    render(<CloseTerminalDialog />);
    expect(state().pendingTerminalClose).toBeNull();
    expect(dialog()).toBeNull();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("disappears again once the pending close is resolved", () => {
    render(<CloseTerminalDialog />);
    hold({ scope: { kind: "pane", paneId: state().focusedPaneId }, terminals: ONE_AGENT });
    expect(dialog()).toBeInTheDocument();

    act(() => state().layoutActions.cancelTerminalClose());
    expect(dialog()).toBeNull();
  });
});

/* ───────────────────────────── the copy ──────────────────────────────────── */

describe("what is at stake, named", () => {
  it("one busy AGENT terminal reads as a sentence, with the session named", () => {
    render(<CloseTerminalDialog />);
    hold({ scope: { kind: "agent", agentId: asAgentId("a-1") }, terminals: ONE_AGENT });

    expect(screen.getByRole("heading", { name: "Close this terminal?" })).toBeInTheDocument();
    const body = screen.getByTestId("close-terminal-dialog");
    expect(body).toHaveTextContent(
      "gazelle is running a Claude session. Closing this terminal stops it, and anything it has not finished is lost.",
    );
    // The label is emphasised, because it is the thing the user recognises.
    expect(within(body).getByText("gazelle").tagName).toBe("STRONG");
    // One terminal is a sentence, not a list.
    expect(screen.queryByTestId("close-terminal-list")).toBeNull();
  });

  it("one busy COMMAND terminal says a command, not a Claude session", () => {
    render(<CloseTerminalDialog />);
    hold({
      scope: { kind: "tab", tabId: asTabId("tab-1") },
      terminals: [busy("t-9", "command", "Terminal 3")],
    });

    expect(screen.getByTestId("close-terminal-dialog")).toHaveTextContent(
      "Terminal 3 has a command still running. Closing this terminal stops it, and anything it has not finished is lost.",
    );
    expect(screen.getByTestId("close-terminal-dialog")).not.toHaveTextContent(
      "Claude session",
    );
  });

  it("several busy terminals read as ONE dialog with a list — never a queue", () => {
    render(<CloseTerminalDialog />);
    hold({
      scope: { kind: "pane", paneId: state().focusedPaneId },
      terminals: [
        busy("t-1", "agent", "gazelle"),
        busy("t-2", "command", "Terminal 3"),
        busy("t-3", "agent", "docs-site"),
      ],
    });

    // One dialog for a gesture that kills three terminals (point 2 of the component's header).
    expect(screen.getAllByRole("alertdialog")).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "Close 3 terminals?" })).toBeInTheDocument();
    expect(screen.getByTestId("close-terminal-dialog")).toHaveTextContent(
      "These 3 terminals are still working. Closing them stops everything running in them, and anything they have not finished is lost.",
    );

    const items = within(screen.getByTestId("close-terminal-list")).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    // Both wordings survive the list shape, each attached to its own label.
    expect(items[0]).toHaveTextContent("gazelle is running a Claude session.");
    expect(items[1]).toHaveTextContent("Terminal 3 has a command still running.");
    expect(items[2]).toHaveTextContent("docs-site is running a Claude session.");
  });

  it("offers exactly Cancel and Close anyway — and no 'don't ask again'", () => {
    render(<CloseTerminalDialog />);
    hold({ scope: { kind: "tab", tabId: asTabId("tab-1") }, terminals: ONE_AGENT });

    const buttons = within(screen.getByTestId("close-terminal-dialog")).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["Cancel", "Close anyway"]);
    // A "don't ask again" box is a persisted pref + a migration, not a checkbox
    // (there is no localStorage in this app). Pinned so adding one is a decision.
    expect(within(screen.getByTestId("close-terminal-dialog")).queryByRole("checkbox")).toBeNull();
  });
});

/* ──────────────────── the two-sided pair: cancel vs proceed ──────────────── */

describe("resolving the close — both directions", () => {
  it("Cancel dismisses the dialog AND leaves the terminal tab alive", () => {
    render(<CloseTerminalDialog />);
    const tabId = holdRealTabClose(ONE_AGENT);

    fireEvent.click(cancelBtn());

    expect(state().pendingTerminalClose).toBeNull();
    expect(dialog()).toBeNull();
    // The half that a button wired to nothing would also pass…
    expect(state().tabs[tabId]).toBeDefined();
  });

  it("Close anyway REALLY closes it — the held gesture is carried out", () => {
    render(<CloseTerminalDialog />);
    const tabId = holdRealTabClose(ONE_AGENT);
    expect(state().tabs[tabId]).toBeDefined();

    fireEvent.click(proceedBtn());

    // …and the half that it would fail. A dialog that resolved nothing passes
    // every "still alive" assertion in this file and none of this one.
    expect(state().tabs[tabId]).toBeUndefined();
    expect(state().pendingTerminalClose).toBeNull();
    expect(dialog()).toBeNull();
  });
});

/* ───────────────────────────── the keyboard ──────────────────────────────── */

describe("keys — every cheap reflex is the safe one", () => {
  it("Escape cancels: the dialog closes and the terminal survives", () => {
    render(<CloseTerminalDialog />);
    const tabId = holdRealTabClose(ONE_AGENT);

    fireEvent.keyDown(screen.getByTestId("close-terminal-dialog"), { key: "Escape" });

    expect(state().pendingTerminalClose).toBeNull();
    // 🔴 The direction that matters: Escape must never be the destructive path.
    expect(state().tabs[tabId]).toBeDefined();
  });

  /**
   * 🔴 The Enter pair. The safety property is NOT "Enter is neutralised" — it is
   * "Cancel holds initial focus", and only these two tests together say so:
   *
   *   - untouched focus + Enter → cancels (the reflex is safe)
   *   - Tab to `Close anyway` + Enter → closes (the key still works)
   *
   * The first alone is satisfied by a build that `preventDefault`s Enter
   * dialog-wide — which is exactly the build this pair exists to rule out,
   * because it leaves the destructive button unactivatable from the keyboard.
   *
   * `userEvent` rather than `fireEvent` on purpose: jsdom does not turn a
   * keydown into a button activation, so `fireEvent.keyDown` could never tell
   * the two builds apart. user-event models the real sequence (keydown →
   * keypress → click, and no click if the keydown was default-prevented), which
   * is the only thing that makes the second half of the pair falsifiable.
   */
  it("Enter with focus untouched cancels — Cancel is where focus starts", async () => {
    const user = userEvent.setup();
    render(<CloseTerminalDialog />);
    const tabId = holdRealTabClose(ONE_AGENT);
    expect(document.activeElement).toBe(cancelBtn());

    await user.keyboard("{Enter}");

    expect(state().pendingTerminalClose).toBeNull();
    expect(state().tabs[tabId]).toBeDefined();
  });

  it("Enter after Tabbing to Close anyway DOES close it — the key is not broken", async () => {
    const user = userEvent.setup();
    render(<CloseTerminalDialog />);
    const tabId = holdRealTabClose(ONE_AGENT);

    // A deliberate move, through the dialog's own trap: focus starts on Cancel
    // (the first control), so a forward Tab needs no wrap and the browser is
    // left to move it.
    await user.tab();
    expect(document.activeElement).toBe(proceedBtn());
    await user.keyboard("{Enter}");

    expect(state().tabs[tabId]).toBeUndefined();
    expect(state().pendingTerminalClose).toBeNull();
  });

  it("ignores keys that are neither Escape nor Tab", () => {
    render(<CloseTerminalDialog />);
    holdRealTabClose(ONE_AGENT);

    fireEvent.keyDown(screen.getByTestId("close-terminal-dialog"), { key: "a" });

    expect(state().pendingTerminalClose).not.toBeNull();
    expect(dialog()).toBeInTheDocument();
  });
});

/* ───────────────────────────── the backdrop ──────────────────────────────── */

describe("the backdrop", () => {
  it("clicking outside the box cancels — it never closes the terminal", () => {
    render(<CloseTerminalDialog />);
    const tabId = holdRealTabClose(ONE_AGENT);

    fireEvent.click(screen.getByTestId("close-terminal-backdrop"));

    expect(state().pendingTerminalClose).toBeNull();
    expect(state().tabs[tabId]).toBeDefined();
  });

  it("clicking INSIDE the box does nothing (the click never reaches the backdrop)", () => {
    render(<CloseTerminalDialog />);
    holdRealTabClose(ONE_AGENT);

    fireEvent.click(screen.getByTestId("close-terminal-dialog"));

    expect(state().pendingTerminalClose).not.toBeNull();
    expect(dialog()).toBeInTheDocument();
  });
});

/* ────────────────────────── accessibility + focus ────────────────────────── */

describe("accessibility and focus", () => {
  it("is an alertdialog, labelled by its heading and described by its body", () => {
    render(<CloseTerminalDialog />);
    hold({ scope: { kind: "tab", tabId: asTabId("tab-1") }, terminals: ONE_AGENT });

    const box = screen.getByRole("alertdialog");
    expect(box).toHaveAttribute("aria-modal", "true");
    const labelId = box.getAttribute("aria-labelledby");
    const bodyId = box.getAttribute("aria-describedby");
    expect(document.getElementById(labelId!)).toHaveTextContent("Close this terminal?");
    expect(document.getElementById(bodyId!)).toHaveTextContent("gazelle");
  });

  it("moves focus to Cancel on open — the default action is the focused one", () => {
    render(<CloseTerminalDialog />);
    hold({ scope: { kind: "tab", tabId: asTabId("tab-1") }, terminals: ONE_AGENT });

    expect(document.activeElement).toBe(cancelBtn());
  });

  it("gives focus back to whatever opened it", () => {
    render(
      <>
        <button data-testid="opener">✕</button>
        <CloseTerminalDialog />
      </>,
    );
    const opener = screen.getByTestId("opener");
    opener.focus();
    expect(document.activeElement).toBe(opener);

    hold({ scope: { kind: "tab", tabId: asTabId("tab-1") }, terminals: ONE_AGENT });
    expect(document.activeElement).toBe(cancelBtn());

    fireEvent.click(cancelBtn());
    expect(document.activeElement).toBe(opener);
  });

  it("traps Tab inside the dialog: forward from the last button wraps to the first", () => {
    render(<CloseTerminalDialog />);
    hold({ scope: { kind: "tab", tabId: asTabId("tab-1") }, terminals: ONE_AGENT });

    proceedBtn().focus();
    fireEvent.keyDown(screen.getByTestId("close-terminal-dialog"), { key: "Tab" });
    expect(document.activeElement).toBe(cancelBtn());
  });

  it("traps Shift+Tab too: backwards from the first button wraps to the last", () => {
    render(<CloseTerminalDialog />);
    hold({ scope: { kind: "tab", tabId: asTabId("tab-1") }, terminals: ONE_AGENT });

    cancelBtn().focus();
    fireEvent.keyDown(screen.getByTestId("close-terminal-dialog"), {
      key: "Tab",
      shiftKey: true,
    });
    expect(document.activeElement).toBe(proceedBtn());
  });

  it("leaves an ordinary Tab alone (no wrap needed, so the browser moves focus)", () => {
    render(<CloseTerminalDialog />);
    hold({ scope: { kind: "tab", tabId: asTabId("tab-1") }, terminals: ONE_AGENT });

    cancelBtn().focus();
    const event = fireEvent.keyDown(screen.getByTestId("close-terminal-dialog"), {
      key: "Tab",
    });

    // Not prevented, and focus is untouched by us — jsdom has no native tab
    // order, so "the browser moves it" is exactly what NOT preventing means.
    expect(event).toBe(true);
    expect(document.activeElement).toBe(cancelBtn());
  });
});
