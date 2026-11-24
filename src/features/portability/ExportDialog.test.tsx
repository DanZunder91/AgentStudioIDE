/**
 * Tests for the export dialog (config bundles).
 *
 * ── Nothing is mocked ────────────────────────────────────────────────────────
 * The component takes every action as a prop and touches no store, no `invoke` and no
 * Tauri plugin, so there is no `vi.mock` here at all — the doubles are plain `vi.fn()`s.
 * `portabilityFormat` is deliberately NOT mocked either: every assertion below is on the
 * string a user would actually read, which is the only version of this test worth having
 * (a test against a stand-in only proves the test agrees with itself).
 *
 * ── The three assertions that matter most ────────────────────────────────────
 * 1. `structure` is selected on open. A default of `sealed` would mean the common case
 *    ships live credentials to Slack.
 * 2. Export stays disabled below `MIN_PASSPHRASE_LENGTH`, and the reason is on screen.
 * 3. Structure mode names the variables it is leaving behind.
 * All three were falsified — broken in the source, watched go red, restored — before this
 * file was called done.
 */

import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ExportDialog, type ExportDialogProps } from "./ExportDialog";
import {
  EMPTY_EXPORT_SOURCE,
  SEALED_HEADER,
  STRUCTURE_HEADER,
  TEST_EXPORT_SOURCE,
} from "./portabilityFixtures";
import type { ExportSource } from "./portabilityFormat";
import { MIN_PASSPHRASE_LENGTH } from "./types";

/** Long enough to clear the floor, and obviously not a real passphrase. */
const GOOD_PASSPHRASE = "correct horse battery";

interface Harness {
  props: ExportDialogProps;
  onExport: ReturnType<typeof vi.fn>;
  onClose: ReturnType<typeof vi.fn>;
}

let h: Harness;

beforeEach(() => {
  const onExport = vi.fn();
  const onClose = vi.fn();
  h = {
    onExport,
    onClose,
    props: {
      source: TEST_EXPORT_SOURCE,
      busy: false,
      error: null,
      exported: null,
      onExport,
      onClose,
    },
  };
});

function open(over: Partial<ExportDialogProps> = {}) {
  return render(<ExportDialog {...h.props} {...over} />);
}

const dialog = (): HTMLElement => screen.getByTestId("portability-export-dialog");
const exportBtn = (): HTMLButtonElement => screen.getByTestId("pb-export");
const type = (testId: string, value: string): void => {
  fireEvent.change(screen.getByTestId(testId), { target: { value } });
};

/* ═════════════════════════ the default is the feature ════════════════════ */

describe("the mode default", () => {
  it("opens on structure, NOT sealed", () => {
    open();
    expect(screen.getByTestId("pb-mode-structure")).toBeChecked();
    expect(screen.getByTestId("pb-mode-sealed")).not.toBeChecked();
    // The consequence, not just the radio: no passphrase field exists yet, and the
    // "what stays behind" block is the one on screen.
    expect(screen.getByTestId("pb-withheld")).toBeInTheDocument();
    expect(screen.queryByTestId("pb-sealed")).not.toBeInTheDocument();
  });

  it("marks the selected mode without needing a colour class", () => {
    open();
    const structure = screen.getByTestId("pb-mode-structure").closest("label");
    expect(structure).toHaveAttribute("data-selected", "yes");
    fireEvent.click(screen.getByTestId("pb-mode-sealed"));
    expect(structure).toHaveAttribute("data-selected", "no");
  });

  it("exports structure mode with no passphrase key at all", () => {
    open();
    fireEvent.click(exportBtn());
    expect(h.onExport).toHaveBeenCalledTimes(1);
    const options = h.onExport.mock.calls[0][0];
    expect(options.mode).toBe("structure");
    expect("passphrase" in options).toBe(false);
  });
});

/* ═════════════════════════ what stays on this machine ════════════════════ */

describe("structure mode says what is being left out", () => {
  it("names the variables whose values are not travelling", () => {
    open();
    const list = screen.getByTestId("pb-withheld-list");
    expect(within(list).getByText("PG_PASSWORD")).toBeInTheDocument();
    expect(within(list).getByText("SHARED_TOKEN")).toBeInTheDocument();
    expect(within(list).getByText("ALPHA_KEY")).toBeInTheDocument();
    // UNSET_WEBHOOK has no value on this machine, so nothing about it is withheld —
    // listing it would send the recipient looking for something that never existed.
    expect(within(list).queryByText("UNSET_WEBHOOK")).not.toBeInTheDocument();
    expect(screen.getByTestId("pb-withheld").textContent).toContain(
      "supply each one before this config works",
    );
  });

  it("shrinks the list when an environment is un-ticked", () => {
    open();
    fireEvent.click(screen.getByLabelText("staging"));
    const list = screen.getByTestId("pb-withheld-list");
    expect(within(list).getByText("ALPHA_KEY")).toBeInTheDocument();
    expect(within(list).queryByText("PG_PASSWORD")).not.toBeInTheDocument();
  });

  it("says 'nothing is being withheld' rather than hiding the block", () => {
    open();
    fireEvent.click(screen.getByLabelText("staging"));
    fireEvent.click(screen.getByLabelText("local"));
    expect(screen.queryByTestId("pb-withheld-list")).not.toBeInTheDocument();
    expect(screen.getByTestId("pb-withheld").textContent).toContain("Nothing is being withheld");
  });

  it("explains that a literal secret in a header is replaced with a loud placeholder", () => {
    open();
    expect(screen.getByTestId("pb-withheld").textContent).toContain(
      "{{REDACTED — supply this value}}",
    );
  });
});

/* ═════════════════════════ the passphrase gate ═══════════════════════════ */

describe("sealed mode", () => {
  const goSealed = (over: Partial<ExportDialogProps> = {}) => {
    open(over);
    fireEvent.click(screen.getByTestId("pb-mode-sealed"));
  };

  it("leads with the fact that encryption does not rescue a weak passphrase", () => {
    goSealed();
    const truth = screen.getByTestId("pb-passphrase-truth").textContent ?? "";
    expect(truth).toContain("Encryption does not make a weak passphrase safe");
    expect(truth).toContain("guess at the passphrase offline");
    // And it is ABOVE the fields, not beneath them: below the inputs it reads as fine
    // print, which is the same as not being there.
    const block = screen.getByTestId("pb-sealed");
    const nodes = Array.from(block.querySelectorAll("*"));
    expect(nodes.indexOf(screen.getByTestId("pb-passphrase-truth"))).toBeLessThan(
      nodes.indexOf(screen.getByTestId("pb-passphrase")),
    );
  });

  it("swaps the structure block out — the two are never both on screen", () => {
    goSealed();
    expect(screen.queryByTestId("pb-withheld")).not.toBeInTheDocument();
    expect(screen.getByTestId("pb-sealed")).toBeInTheDocument();
  });

  it("keeps Export disabled until a passphrase is entered", () => {
    goSealed();
    expect(exportBtn()).toBeDisabled();
    expect(screen.getByTestId("pb-blocked")).toHaveTextContent(
      "Enter a passphrase to seal this bundle.",
    );
  });

  it("keeps Export disabled BELOW the minimum length, and says how far off it is", () => {
    goSealed();
    // BOTH fields, deliberately. Filling only the first leaves the pair mismatched, and
    // the mismatch rule would then be the thing holding the button — so the test would
    // pass with the length floor deleted. Found by falsifying it.
    type("pb-passphrase", "hunter2hunt");
    type("pb-passphrase-confirm", "hunter2hunt");
    expect("hunter2hunt".length).toBeLessThan(MIN_PASSPHRASE_LENGTH);
    expect(exportBtn()).toBeDisabled();
    expect(screen.getByTestId("pb-passphrase-message")).toHaveTextContent(
      "At least 12 characters — 1 more to go.",
    );
    expect(exportBtn()).toHaveAttribute("aria-describedby", "pb-blocked");
  });

  it("keeps Export disabled while the confirmation does not match", () => {
    goSealed();
    type("pb-passphrase", GOOD_PASSPHRASE);
    type("pb-passphrase-confirm", "correct horse batteru");
    expect(exportBtn()).toBeDisabled();
    expect(screen.getByTestId("pb-passphrase-message")).toHaveTextContent(
      "The two passphrases do not match.",
    );
  });

  it("enables Export once the pair is long and matching, and sends the passphrase", () => {
    goSealed();
    type("pb-passphrase", GOOD_PASSPHRASE);
    type("pb-passphrase-confirm", GOOD_PASSPHRASE);
    expect(exportBtn()).toBeEnabled();
    expect(screen.queryByTestId("pb-blocked")).not.toBeInTheDocument();
    expect(exportBtn()).not.toHaveAttribute("aria-describedby");
    expect(screen.queryByTestId("pb-passphrase-message")).not.toBeInTheDocument();

    fireEvent.click(exportBtn());
    expect(h.onExport).toHaveBeenCalledWith({
      mode: "sealed",
      label: "",
      dbConnectionIds: ["conn-warehouse", "conn-cache", "conn-scratch"],
      apiRequestIds: ["req-charge", "req-health"],
      environmentIds: ["env-staging", "env-local"],
      passphrase: GOOD_PASSPHRASE,
    });
  });

  it("states the KDF limitation instead of implying the cipher is the protection", () => {
    goSealed();
    expect(screen.getByTestId("pb-sealed").textContent).toContain("weaker against GPU cracking");
  });
});

/* ═════════════════════════ selection ═════════════════════════════════════ */

describe("what to include", () => {
  it("starts with everything ticked and counts each group", () => {
    open();
    expect(screen.getByTestId("pb-include-dbConnections-count")).toHaveTextContent("3 of 3");
    expect(screen.getByTestId("pb-include-apiRequests-count")).toHaveTextContent("2 of 2");
    expect(screen.getByTestId("pb-include-environments-count")).toHaveTextContent("2 of 2");
    expect(screen.getByTestId("pb-summary")).toHaveTextContent(
      "3 database connections, 2 requests and 2 environments, referencing 4 variables.",
    );
  });

  it("un-ticks one record and both the count and the summary follow", () => {
    open();
    fireEvent.click(screen.getByLabelText("session cache"));
    expect(screen.getByTestId("pb-include-dbConnections-count")).toHaveTextContent("2 of 3");
    expect(screen.getByTestId("pb-summary")).toHaveTextContent("2 database connections");
    fireEvent.click(exportBtn());
    expect(h.onExport.mock.calls[0][0].dbConnectionIds).toEqual([
      "conn-warehouse",
      "conn-scratch",
    ]);
  });

  it("re-ticks a record that was un-ticked", () => {
    open();
    fireEvent.click(screen.getByLabelText("session cache"));
    fireEvent.click(screen.getByLabelText("session cache"));
    expect(screen.getByTestId("pb-include-dbConnections-count")).toHaveTextContent("3 of 3");
  });

  it("shows a detail line where the store has one, and nothing where it does not", () => {
    open();
    expect(screen.getByText("postgres · db.staging:5432")).toBeInTheDocument();
    // `conn-scratch` has `detail: null` — no empty dim line is rendered for it.
    const scratch = screen.getByLabelText("scratch").closest("li") as HTMLElement;
    expect(scratch.querySelector(".pb-dialog__hint")).toBeNull();
  });

  it("pluralises an environment's variable count, singular included", () => {
    // One environment with exactly one variable — the singular branch the shared fixture
    // deliberately does not reach.
    const source: ExportSource = {
      dbConnections: [],
      apiRequests: [],
      environments: [
        { id: "solo", name: "solo", variables: [{ key: "ONLY", hasValue: true }] },
        { id: "pair", name: "pair", variables: TEST_EXPORT_SOURCE.environments[1].variables },
      ],
    };
    open({ source });
    expect(screen.getByText("1 variable")).toBeInTheDocument();
    expect(screen.getByText("2 variables")).toBeInTheDocument();
  });

  it("blocks an empty bundle and says why", () => {
    open({ source: EMPTY_EXPORT_SOURCE });
    expect(screen.getAllByText("Nothing of this kind on this machine.")).toHaveLength(3);
    expect(exportBtn()).toBeDisabled();
    expect(screen.getByTestId("pb-blocked")).toHaveTextContent(
      "Choose at least one thing to include.",
    );
    expect(screen.getByTestId("pb-summary")).toHaveTextContent("This bundle would be empty.");
  });

  it("blocks a bundle whose every record was un-ticked", () => {
    open();
    for (const name of [
      "warehouse (staging)",
      "session cache",
      "scratch",
      "Create charge",
      "Health",
      "staging",
      "local",
    ]) {
      fireEvent.click(screen.getByLabelText(name));
    }
    expect(exportBtn()).toBeDisabled();
  });
});

/* ═════════════════════════ label, busy, errors ═══════════════════════════ */

describe("the rest of the form", () => {
  it("trims the label on the way out", () => {
    open();
    fireEvent.change(screen.getByLabelText("Name this bundle"), {
      target: { value: "  Team staging DB + API  " },
    });
    fireEvent.click(exportBtn());
    expect(h.onExport.mock.calls[0][0].label).toBe("Team staging DB + API");
  });

  it("renders an error in the dialog, never in an alert()", () => {
    open({ error: "Could not write the file: permission denied." });
    expect(screen.getByTestId("pb-export-error")).toHaveTextContent(
      "Could not write the file: permission denied.",
    );
    expect(screen.getByTestId("pb-export-error")).toHaveAttribute("role", "alert");
  });

  it("shows no error node when there is no error", () => {
    open();
    expect(screen.queryByTestId("pb-export-error")).not.toBeInTheDocument();
  });

  it("disables Export while one is in flight and says so on the button", () => {
    open({ busy: true });
    expect(exportBtn()).toBeDisabled();
    expect(exportBtn()).toHaveTextContent("Exporting…");
  });

  it("labels the button 'Export…' when idle, because a save dialog comes next", () => {
    open();
    expect(exportBtn()).toHaveTextContent("Export…");
  });

  it("closes on Cancel", () => {
    open();
    fireEvent.click(screen.getByTestId("pb-cancel"));
    expect(h.onClose).toHaveBeenCalledTimes(1);
  });
});

/* ═════════════════════════ the receipt ═══════════════════════════════════ */

describe("the receipt", () => {
  it("replaces the form and restates what a structure bundle does NOT contain", () => {
    open({ exported: STRUCTURE_HEADER });
    expect(screen.queryByTestId("pb-export")).not.toBeInTheDocument();
    expect(screen.getByTestId("pb-receipt")).toHaveTextContent(
      "Structure-only bundle written, containing 2 database connections, 3 saved queries, 4 requests and 1 environment. It holds no secret values, so it is safe to paste anywhere.",
    );
  });

  it("reminds the sharer to send a sealed bundle's passphrase separately", () => {
    open({ exported: SEALED_HEADER });
    expect(screen.getByTestId("pb-receipt")).toHaveTextContent(
      "Sealed bundle written, containing 1 database connection, 2 requests and 1 environment. Send the passphrase separately — not in the same message as the file.",
    );
  });

  it("closes on Done", () => {
    open({ exported: STRUCTURE_HEADER });
    fireEvent.click(screen.getByTestId("pb-done"));
    expect(h.onClose).toHaveBeenCalledTimes(1);
  });
});

/* ═════════════════════════ the modal contract ════════════════════════════ */

describe("accessibility and focus, matching the database dialog", () => {
  it("is a labelled modal dialog", () => {
    open();
    expect(dialog()).toHaveAttribute("role", "dialog");
    expect(dialog()).toHaveAttribute("aria-modal", "true");
    expect(dialog()).toHaveAttribute("aria-labelledby", "portability-export-title");
    expect(screen.getByRole("heading", { level: 2 })).toHaveAttribute(
      "id",
      "portability-export-title",
    );
  });

  it("moves focus into the dialog on open", () => {
    open();
    expect(document.activeElement).toBe(screen.getByLabelText("Name this bundle"));
  });

  it("gives focus back to whatever opened it", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const { unmount } = open();
    expect(document.activeElement).not.toBe(opener);
    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("closes on Escape", () => {
    open();
    fireEvent.keyDown(dialog(), { key: "Escape" });
    expect(h.onClose).toHaveBeenCalledTimes(1);
  });

  it("ignores keys that are neither Escape nor Tab", () => {
    open();
    fireEvent.keyDown(dialog(), { key: "a" });
    expect(h.onClose).not.toHaveBeenCalled();
  });

  it("lets Tab run naturally in the middle of the dialog", () => {
    open();
    // Focus is on the first field, so forward Tab needs no interception at all.
    const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    dialog().dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("wraps Shift+Tab from the first control round to the last", () => {
    open();
    const event = new KeyboardEvent("keydown", {
      key: "Tab",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    dialog().dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(exportBtn());
  });
});
