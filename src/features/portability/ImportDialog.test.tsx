/**
 * Tests for the import dialog (config bundles).
 *
 * ── Nothing is mocked ────────────────────────────────────────────────────────
 * Same seam as the export dialog: every action is a prop, so the doubles are plain
 * `vi.fn()`s and `portabilityFormat` runs for real. The plans come from
 * `portabilityFixtures` as **inputs**; every expected sentence is typed out here.
 *
 * ── What this file is really checking ────────────────────────────────────────
 * That the dialog is a REVIEW screen and not a confirm button. Concretely:
 *   • the provenance is reported speech, and never the word "verified";
 *   • the hosts and the variables are both on screen before anything is written;
 *   • the variables this machine already holds are marked, because that pairing is the
 *     exfiltration risk;
 *   • `overwriteExistingSecrets` is off by default;
 *   • a wrong passphrase is retryable **without re-picking the file**.
 *
 * The last one is the assertion this dialog exists for, and it was falsified: derive the
 * locked state from the error string instead of `plan.unsealed` and it goes red.
 */

import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ImportDialog, type ImportDialogProps } from "./ImportDialog";
import {
  BARE_PLAN,
  LOCKED_PLAN,
  MIXED_RESULT,
  NOTHING_TO_DO_PLAN,
  NO_CHANGE_RESULT,
  RICH_PLAN,
} from "./portabilityFixtures";

const PATH = "/Users/someone/Downloads/team-staging.agentstudio.json";

interface Harness {
  props: ImportDialogProps;
  onPickFile: ReturnType<typeof vi.fn>;
  onInspect: ReturnType<typeof vi.fn>;
  onImport: ReturnType<typeof vi.fn>;
  onClose: ReturnType<typeof vi.fn>;
}

let h: Harness;

beforeEach(() => {
  const onPickFile = vi.fn();
  const onInspect = vi.fn();
  const onImport = vi.fn();
  const onClose = vi.fn();
  h = {
    onPickFile,
    onInspect,
    onImport,
    onClose,
    props: {
      path: null,
      plan: null,
      busy: false,
      error: null,
      result: null,
      onPickFile,
      onInspect,
      onImport,
      onClose,
    },
  };
});

function open(over: Partial<ImportDialogProps> = {}) {
  return render(<ImportDialog {...h.props} {...over} />);
}

const dialog = (): HTMLElement => screen.getByTestId("portability-import-dialog");

/* ═════════════════════════ before a file is chosen ═══════════════════════ */

describe("the empty state", () => {
  it("asks for a file and promises nothing is written yet", () => {
    open();
    expect(screen.getByTestId("pb-pick-note")).toHaveTextContent(
      "Choose a bundle file to review. Nothing is written until you say so. Up to 8 MB.",
    );
    expect(screen.getByTestId("pb-pick")).toHaveTextContent("Choose a bundle…");
    expect(screen.queryByTestId("pb-path")).not.toBeInTheDocument();
    expect(screen.queryByTestId("pb-claims")).not.toBeInTheDocument();
  });

  it("hands the picker to the caller — this component never opens one itself", () => {
    open();
    fireEvent.click(screen.getByTestId("pb-pick"));
    expect(h.onPickFile).toHaveBeenCalledTimes(1);
  });

  it("shows a failure from a rejected file in place, with the picker still available", () => {
    open({ error: "That file is not an Agent Studio bundle." });
    expect(screen.getByTestId("pb-import-error")).toHaveTextContent(
      "That file is not an Agent Studio bundle.",
    );
    expect(screen.getByTestId("pb-pick")).toBeEnabled();
  });

  it("disables the picker while an inspect is in flight", () => {
    open({ busy: true });
    expect(screen.getByTestId("pb-pick")).toBeDisabled();
  });
});

/* ═════════════════════════ what the file CLAIMS ══════════════════════════ */

describe("provenance is a claim, never a verification", () => {
  it("reports what the file says about itself, and shows the path", () => {
    open({ path: PATH, plan: RICH_PLAN });
    expect(screen.getByTestId("pb-path")).toHaveTextContent(PATH);
    expect(screen.getByTestId("pb-provenance")).toHaveTextContent(
      'This file says it was exported by Agent Studio 0.1.0 on 2026-07-28 09:15 UTC and calls itself "Team staging DB + API".',
    );
    expect(screen.getByTestId("pb-header-counts")).toHaveTextContent(
      "It says it contains 2 database connections, 3 saved queries, 4 requests and 1 environment. It carries no secret values.",
    );
  });

  it("puts the 'nothing here is verified' note next to the claim, not in a tooltip", () => {
    open({ plan: RICH_PLAN });
    expect(screen.getByTestId("pb-unverified")).toHaveTextContent(
      "Nothing here is verified. A bundle is a plain JSON file with no signature, so everything it says about itself is only a claim — trust it exactly as much as you trust wherever you got the file.",
    );
  });

  it("never uses the word 'verified' as a description of the file", () => {
    open({ plan: RICH_PLAN });
    const claims = screen.getByTestId("pb-claims").textContent ?? "";
    expect(claims).not.toMatch(/verified export|verified bundle|signed by/i);
  });

  it("drops the label clause when the bundle never named itself", () => {
    open({ plan: BARE_PLAN });
    expect(screen.getByTestId("pb-provenance")).toHaveTextContent(
      "This file says it was exported by Agent Studio 0.1.0 on 2026-07-28 09:15 UTC.",
    );
  });
});

/* ═════════════════════════ the sealed / locked state ═════════════════════ */

describe("a sealed bundle", () => {
  it("describes the file from its header but lists no contents", () => {
    open({ path: PATH, plan: LOCKED_PLAN });
    expect(screen.getByTestId("pb-header-counts")).toHaveTextContent("It carries 3 secret values.");
    expect(screen.getByTestId("pb-locked")).toHaveTextContent(
      "This bundle is sealed, so its contents cannot be listed until it is unlocked. The counts above come from the file's unencrypted header, which nothing verifies.",
    );
    // The review — hosts, variables, per-item actions — is NOT rendered from a header.
    expect(screen.queryByTestId("pb-hosts")).not.toBeInTheDocument();
    expect(screen.queryByTestId("pb-variables")).not.toBeInTheDocument();
    expect(screen.queryByTestId("pb-import")).not.toBeInTheDocument();
  });

  it("focuses the passphrase box, because that is the point of the screen", () => {
    open({ plan: LOCKED_PLAN });
    expect(document.activeElement).toBe(screen.getByTestId("pb-import-passphrase"));
  });

  it("cannot unlock with an empty passphrase", () => {
    open({ plan: LOCKED_PLAN });
    expect(screen.getByTestId("pb-unlock")).toBeDisabled();
    fireEvent.change(screen.getByTestId("pb-import-passphrase"), { target: { value: "guess" } });
    expect(screen.getByTestId("pb-unlock")).toBeEnabled();
  });

  it("inspects again with the typed passphrase", () => {
    open({ plan: LOCKED_PLAN });
    fireEvent.change(screen.getByTestId("pb-import-passphrase"), {
      target: { value: "correct horse battery" },
    });
    fireEvent.click(screen.getByTestId("pb-unlock"));
    expect(h.onInspect).toHaveBeenCalledWith("correct horse battery");
  });

  it("unlocks on Enter too, without submitting anything else", () => {
    open({ plan: LOCKED_PLAN });
    const field = screen.getByTestId("pb-import-passphrase");
    fireEvent.change(field, { target: { value: "correct horse battery" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(h.onInspect).toHaveBeenCalledWith("correct horse battery");
  });

  it("ignores other keys in the passphrase box", () => {
    open({ plan: LOCKED_PLAN });
    fireEvent.keyDown(screen.getByTestId("pb-import-passphrase"), { key: "x" });
    expect(h.onInspect).not.toHaveBeenCalled();
  });

  it("says it is working and blocks a second attempt while one is in flight", () => {
    open({ plan: LOCKED_PLAN, busy: true });
    fireEvent.change(screen.getByTestId("pb-import-passphrase"), { target: { value: "guess" } });
    expect(screen.getByTestId("pb-unlock")).toBeDisabled();
    expect(screen.getByTestId("pb-unlock")).toHaveTextContent("Unlocking…");
  });

  /**
   * 🔴 The assertion this dialog exists for. A wrong passphrase must cost one correction,
   * not a trip back through the file picker — `portability_inspect` writes nothing either
   * way, so there is no reason to make the user start over.
   */
  it("retries a wrong passphrase IN PLACE, keeping the file and what was typed", () => {
    const { rerender } = render(
      <ImportDialog {...h.props} path={PATH} plan={LOCKED_PLAN} />,
    );
    fireEvent.change(screen.getByTestId("pb-import-passphrase"), { target: { value: "wrong one" } });
    fireEvent.click(screen.getByTestId("pb-unlock"));

    // The caller comes back with a failure. The plan is UNCHANGED — it is still the same
    // sealed, still-locked bundle — so the dialog must not have moved anywhere.
    rerender(
      <ImportDialog
        {...h.props}
        path={PATH}
        plan={LOCKED_PLAN}
        error="That passphrase did not open this bundle."
      />,
    );
    expect(screen.getByTestId("pb-import-error")).toHaveTextContent(
      "That passphrase did not open this bundle.",
    );
    expect(screen.getByTestId("pb-path")).toHaveTextContent(PATH);
    expect(screen.getByTestId("pb-import-passphrase")).toHaveValue("wrong one");
    expect(h.onPickFile).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId("pb-import-passphrase"), { target: { value: "right one" } });
    fireEvent.click(screen.getByTestId("pb-unlock"));
    expect(h.onInspect).toHaveBeenNthCalledWith(2, "right one");
  });

  it("still offers a different file, labelled as a replacement", () => {
    open({ path: PATH, plan: LOCKED_PLAN });
    expect(screen.getByTestId("pb-pick")).toHaveTextContent("Choose a different file…");
  });
});

/* ═════════════════════════ the review ════════════════════════════════════ */

describe("the review — hosts", () => {
  it("lists every host anything in the bundle would contact", () => {
    open({ plan: RICH_PLAN });
    const hosts = screen.getByTestId("pb-hosts");
    expect(hosts).toHaveTextContent("Everything in this bundle would talk to these hosts:");
    const list = screen.getByTestId("pb-hosts-list");
    expect(within(list).getByText("api.example.com")).toBeInTheDocument();
    expect(within(list).getByText("db.staging")).toBeInTheDocument();
  });

  it("says so when nothing in the bundle contacts anything", () => {
    open({ plan: BARE_PLAN });
    expect(screen.getByTestId("pb-hosts")).toHaveTextContent(
      "Nothing in this bundle contacts a host.",
    );
    expect(screen.queryByTestId("pb-hosts-list")).not.toBeInTheDocument();
  });
});

describe("the review — variables, i.e. the exfiltration risk", () => {
  it("summarises how many of them this machine already has a value for", () => {
    open({ plan: RICH_PLAN });
    expect(screen.getByTestId("pb-variables-summary")).toHaveTextContent(
      "Reads 3 variables. You already have a value for 2 of them, so an imported request can read your value and send it to any host listed above.",
    );
  });

  it("marks each variable the machine already holds, and each one it does not", () => {
    open({ plan: RICH_PLAN });
    const rows = within(screen.getByTestId("pb-variables-list")).getAllByRole("listitem");
    expect(rows.map((r) => r.getAttribute("data-have"))).toEqual(["no", "yes", "yes"]);

    const held = rows[1];
    expect(held).toHaveTextContent("PROD_STRIPE_KEY");
    expect(held).toHaveTextContent("you already have a value for this");
    expect(held).toHaveTextContent("the bundle carries a value");

    // Held locally, but the bundle carries no value of its own for it — the pairing that
    // makes "an imported request reads YOUR secret" concrete.
    expect(rows[2]).toHaveTextContent("SHARED_TOKEN");
    expect(rows[2]).toHaveTextContent("you already have a value for this");
    expect(rows[2]).toHaveTextContent("the bundle carries no value");

    expect(rows[0]).toHaveTextContent("you have no value for this yet");
  });

  it("says plainly when the machine holds none of them", () => {
    open({ plan: NOTHING_TO_DO_PLAN });
    expect(screen.getByTestId("pb-variables-summary")).toHaveTextContent(
      "Reads 1 variable. You do not have a value for any of them yet.",
    );
  });

  it("says so when the bundle references no variables at all", () => {
    open({ plan: BARE_PLAN });
    expect(screen.getByTestId("pb-variables-summary")).toHaveTextContent(
      "This bundle does not reference any variables.",
    );
    expect(screen.queryByTestId("pb-variables-list")).not.toBeInTheDocument();
  });
});

describe("the review — per item", () => {
  it("groups every kind, shows the default action and the reason for it", () => {
    open({ plan: RICH_PLAN });
    for (const heading of [
      "Database connections",
      "Saved queries",
      "API requests",
      "Environments",
      "Variables",
    ]) {
      expect(screen.getByText(heading)).toBeInTheDocument();
    }
    expect(screen.getByTestId("portability-item-dbConnection-conn-warehouse")).toHaveValue("update");
    expect(screen.getByTestId("portability-item-dbConnection-conn-analytics")).toHaveValue("create");
    expect(screen.getByTestId("portability-item-variable-PROD_STRIPE_KEY")).toHaveValue("skip");
    expect(screen.getByTestId("pb-items")).toHaveTextContent(
      "a connection with this id already exists",
    );
    expect(screen.getByTestId("pb-items")).toHaveTextContent(
      "you already have a value for this variable",
    );
  });

  it("offers all three actions on every row", () => {
    open({ plan: RICH_PLAN });
    const select = screen.getByTestId("portability-item-dbQuery-query-top-accounts");
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Create",
      "Update",
      "Skip",
    ]);
  });

  it("🔴 offers read-only as a CHECKED default rather than a forced value", () => {
    // This used to assert a sentence
    // saying connections arrive read-only "whatever the file says" — true while Rust forced it,
    // and a lie the moment the importer got the decision. The default is unchanged; what changed
    // is that it is now visible and reversible.
    open({ plan: RICH_PLAN });
    const toggle = screen.getByTestId("pb-read-only") as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    expect(screen.getByText(/Import connections as read-only/)).toBeInTheDocument();
    // The consequence of turning it OFF has to be on screen, or the checkbox reads as a preference.
    expect(screen.getByTestId("pb-items").textContent ?? "").toContain("DELETE");
  });

  it("🔴 sends `forceReadOnly: false` once the importer unticks it", () => {
    // The half that would silently do nothing if the flag were dropped between the dialog and the
    // store — which is exactly what happened to the per-item choices before the seam test existed.
    open({ plan: RICH_PLAN });
    fireEvent.click(screen.getByTestId("pb-read-only"));
    fireEvent.click(screen.getByTestId("pb-import"));
    expect(h.onImport).toHaveBeenCalledWith({
      actions: {},
      overwriteExistingSecrets: false,
      forceReadOnly: false,
    });
  });

  it("sends back ONLY the actions the user actually changed", () => {
    open({ plan: RICH_PLAN });
    fireEvent.change(screen.getByTestId("portability-item-dbConnection-conn-warehouse"), {
      target: { value: "skip" },
    });
    // Re-selecting the plan's own default is not a decision, so it must not be sent.
    fireEvent.change(screen.getByTestId("portability-item-apiRequest-req-charge"), {
      target: { value: "create" },
    });
    fireEvent.click(screen.getByTestId("pb-import"));
    expect(h.onImport).toHaveBeenCalledWith({
      actions: { "conn-warehouse": "skip" },
      overwriteExistingSecrets: false,
      forceReadOnly: true,
    });
  });

  it("sends an empty action map when the plan was accepted as it came", () => {
    open({ plan: RICH_PLAN });
    fireEvent.click(screen.getByTestId("pb-import"));
    expect(h.onImport).toHaveBeenCalledWith({ actions: {}, overwriteExistingSecrets: false, forceReadOnly: true });
  });

  it("says so when a bundle contains nothing importable", () => {
    open({ plan: NOTHING_TO_DO_PLAN });
    expect(screen.getByTestId("pb-items-empty")).toHaveTextContent(
      "This bundle contains nothing this app can import.",
    );
  });

  it("shows the reader's own notes about the file, when there are any", () => {
    open({ plan: RICH_PLAN });
    expect(screen.getByTestId("pb-plan-notices")).toHaveTextContent(
      "A header on “Create charge” looked like a literal secret and was redacted.",
    );
  });

  it("renders no notes block when the file read cleanly", () => {
    open({ plan: BARE_PLAN });
    expect(screen.queryByTestId("pb-plan-notices")).not.toBeInTheDocument();
  });

  it("disables Import while one is in flight", () => {
    open({ plan: RICH_PLAN, busy: true });
    expect(screen.getByTestId("pb-import")).toBeDisabled();
    expect(screen.getByTestId("pb-import")).toHaveTextContent("Importing…");
  });

  it("focuses Import once the bundle is reviewable", () => {
    open({ plan: RICH_PLAN });
    expect(document.activeElement).toBe(screen.getByTestId("pb-import"));
  });
});

describe("the overwrite switch", () => {
  it("is OFF by default and says what both positions do", () => {
    open({ plan: RICH_PLAN });
    expect(screen.getByTestId("pb-overwrite")).not.toBeChecked();
    const hint = document.getElementById("pb-overwrite-hint");
    expect(hint?.textContent).toContain(
      "Off: variables you already have a value for keep your value",
    );
    expect(hint?.textContent).toContain("On: the bundle's value replaces yours");
    expect(screen.getByTestId("pb-overwrite")).toHaveAttribute(
      "aria-describedby",
      "pb-overwrite-hint",
    );
  });

  it("is labelled by what turning it ON does", () => {
    open({ plan: RICH_PLAN });
    expect(
      screen.getByLabelText("Let incoming values replace secrets I already have"),
    ).toBeInTheDocument();
  });

  it("travels in the choices once turned on", () => {
    open({ plan: RICH_PLAN });
    fireEvent.click(screen.getByTestId("pb-overwrite"));
    fireEvent.click(screen.getByTestId("pb-import"));
    expect(h.onImport).toHaveBeenCalledWith({ actions: {}, overwriteExistingSecrets: true, forceReadOnly: true });
  });
});

/* ═════════════════════════ the receipt ═══════════════════════════════════ */

describe("the receipt", () => {
  it("counts what happened and repeats the app's own notes", () => {
    open({ path: PATH, plan: RICH_PLAN, result: MIXED_RESULT });
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Import finished");
    expect(screen.getByTestId("pb-import-receipt")).toHaveTextContent(
      "Created 1 database connection, 1 saved query, 1 request and 2 variables, updated 1 environment and skipped 1 variable.",
    );
    expect(screen.getByTestId("pb-result-notices")).toHaveTextContent(
      "“warehouse (staging)” was imported read-only.",
    );
    // The review is gone: nothing left to decide.
    expect(screen.queryByTestId("pb-items")).not.toBeInTheDocument();
    expect(screen.queryByTestId("pb-pick")).not.toBeInTheDocument();
  });

  it("says nothing changed rather than showing three empty counts", () => {
    open({ plan: RICH_PLAN, result: NO_CHANGE_RESULT });
    expect(screen.getByTestId("pb-import-receipt")).toHaveTextContent("Nothing was changed.");
    expect(screen.queryByTestId("pb-result-notices")).not.toBeInTheDocument();
  });

  it("closes on Done, which is also where focus lands", () => {
    open({ plan: RICH_PLAN, result: NO_CHANGE_RESULT });
    const done = screen.getByTestId("pb-import-close");
    expect(done).toHaveTextContent("Done");
    expect(document.activeElement).toBe(done);
    fireEvent.click(done);
    expect(h.onClose).toHaveBeenCalledTimes(1);
  });
});

/* ═════════════════════════ the modal contract ════════════════════════════ */

describe("accessibility and focus, matching the database dialog", () => {
  it("is a labelled modal dialog", () => {
    open();
    expect(dialog()).toHaveAttribute("role", "dialog");
    expect(dialog()).toHaveAttribute("aria-modal", "true");
    expect(dialog()).toHaveAttribute("aria-labelledby", "portability-import-title");
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Import a config bundle");
  });

  it("moves focus into the dialog on open and hands it back on close", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const { unmount } = open();
    expect(document.activeElement).toBe(screen.getByTestId("pb-pick"));
    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("moves focus as the flow advances, so it never falls out of the trap", () => {
    const { rerender } = render(<ImportDialog {...h.props} />);
    expect(document.activeElement).toBe(screen.getByTestId("pb-pick"));
    rerender(<ImportDialog {...h.props} path={PATH} plan={LOCKED_PLAN} />);
    expect(document.activeElement).toBe(screen.getByTestId("pb-import-passphrase"));
    rerender(<ImportDialog {...h.props} path={PATH} plan={RICH_PLAN} />);
    expect(document.activeElement).toBe(screen.getByTestId("pb-import"));
  });

  it("closes on Escape", () => {
    open();
    fireEvent.keyDown(dialog(), { key: "Escape" });
    expect(h.onClose).toHaveBeenCalledTimes(1);
  });

  it("cancels without importing", () => {
    open({ plan: RICH_PLAN });
    fireEvent.click(screen.getByTestId("pb-import-close"));
    expect(h.onClose).toHaveBeenCalledTimes(1);
    expect(h.onImport).not.toHaveBeenCalled();
  });

  it("ignores keys that are neither Escape nor Tab", () => {
    open();
    fireEvent.keyDown(dialog(), { key: "a" });
    expect(h.onClose).not.toHaveBeenCalled();
  });

  it("lets Tab run naturally in the middle of the dialog", () => {
    open();
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
    expect(document.activeElement).toBe(screen.getByTestId("pb-import-close"));
  });
});
