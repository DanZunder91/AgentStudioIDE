/**
 * Tests for the connection dialog.
 *
 * ── Nothing is mocked, and that is the point ─────────────────────────────────
 * The component takes every action as a prop and touches no store and no `invoke`, so
 * these tests need no `vi.mock` at all — the doubles are plain `vi.fn()`s handed in as
 * props. That is the same seam that keeps the form independent of the Rust commands.
 * `engineFields.ts` is deliberately NOT mocked either: using the real logic means every
 * assertion below is on the string a user would actually read (a test against a
 * stand-in only proves the test agrees with itself).
 *
 * ── The hostile fixtures, and what they are for ──────────────────────────────
 * `HOSTILE_PASSWORD` is `p@ss:w/rd#1`: every character that a URL builder has to
 * percent-encode. `hostileBuild` is a *misbehaving backend* that echoes it into the
 * connection string in both its literal and encoded forms. Those two together pin the
 * one property this dialog cannot get wrong — a password must never reach the URL
 * preview, no matter what the layer below hands up.
 */

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConnectionDialog, focusById, type ConnectionDialogProps } from "./ConnectionDialog";
import {
  AWKWARD_ENGINE,
  MONGODB_ENGINE,
  POSTGRES_ENGINE,
  TEST_ENGINES,
} from "./dbFixtures";
import {
  PASSWORD_MOVED_NOTICE,
  READ_ONLY_OFF_WARNING,
  SECRET_MASK,
  URL_COPIED_NOTICE,
  URL_LITERAL_PASSWORD_NOTICE,
  URL_OVERRIDE_NOTE,
  URL_REQUIRED_ERROR,
} from "./engineFields";
import type { DbConnectionDraft, DbTestResult, EngineSpec, ParsedUrl } from "./types";

/** Every character a URL builder must percent-encode, in one password. */
const HOSTILE_PASSWORD = "p@ss:w/rd#1";
const HOSTILE_ENCODED = "p%40ss%3Aw%2Frd%231";

const OK_RESULT: DbTestResult = {
  ok: true,
  serverVersion: "PostgreSQL 17.2",
  latencyMs: 34,
  error: null,
};

function emptyParsed(over: Partial<ParsedUrl> = {}): ParsedUrl {
  return {
    engine: null,
    family: null,
    host: "",
    port: null,
    database: "",
    user: "",
    hadPassword: false,
  srv: false,
    // Null = the credential came from the userinfo, which is the default shape these
    // helpers build. Tests that care about a query-string credential override it.
    passwordParam: null,
    sslMode: null,
    url: "",
    options: {},
    ...over,
  };
}

interface Harness {
  props: ConnectionDialogProps;
  onTest: ReturnType<typeof vi.fn>;
  onSave: ReturnType<typeof vi.fn>;
  onBuildUrl: ReturnType<typeof vi.fn>;
  onParseUrl: ReturnType<typeof vi.fn>;
  onCancel: ReturnType<typeof vi.fn>;
}

let h: Harness;

beforeEach(() => {
  const onTest = vi.fn(async () => OK_RESULT);
  const onSave = vi.fn(async () => {});
  // Shaped like `db_url_build`: a `null` port emits NO port, which is the whole point of the
  // contract change. A builder that interpolated `null` blindly would print `:null` and make
  // every assertion below unreadable.
  const onBuildUrl = vi.fn(
    async (c: DbConnectionDraft) =>
      `postgresql://${c.user}@${c.host}${c.port === null ? "" : `:${c.port}`}/${c.database}`,
  );
  const onParseUrl = vi.fn(async () => emptyParsed());
  const onCancel = vi.fn();
  h = {
    onTest,
    onSave,
    onBuildUrl,
    onParseUrl,
    onCancel,
    props: {
      engines: TEST_ENGINES,
      initial: null,
      onTest,
      onSave,
      onBuildUrl,
      onParseUrl,
      onCancel,
    },
  };
});

afterEach(() => {
  vi.useRealTimers();
});

/** Render, then let the first URL build settle so nothing resolves mid-assertion. */
async function open(over: Partial<ConnectionDialogProps> = {}) {
  const utils = render(<ConnectionDialog {...h.props} {...over} />);
  await waitFor(() => expect(h.onBuildUrl).toHaveBeenCalled());
  return utils;
}

/** The ONE connection-string box — editable, and authoritative when it is not empty. */
const urlBox = (): HTMLInputElement => screen.getByTestId("db-url");
const notices = (): string => screen.getByTestId("db-notices").textContent ?? "";
const type = (label: string, value: string): void => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};
/** Reveal the Advanced section. Its rows are genuinely unmounted while it is closed. */
const openAdvanced = (): void => {
  fireEvent.click(screen.getByTestId("db-advanced-toggle"));
};
const setMode = (value: string): void => {
  fireEvent.change(screen.getByTestId("db-mode"), { target: { value } });
};
/** Paste into the URL box the way a user does — the string never becomes an input value. */
const pasteUrl = (text: string): void => {
  fireEvent.paste(urlBox(), { clipboardData: { getData: () => text } });
};

/* ═════════════════════ the form is the descriptor ════════════════════════ */

describe("per-engine fields", () => {
  it("shows the fields you must fill in, and keeps the engine's extras behind Advanced", async () => {
    await open();
    // 🔴 The dialog was confusing because it showed too much: this used to be eleven controls
    // in one flat grid, each with a paragraph under it.
    for (const label of ["Name", "Host", "Port", "Database", "User"]) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
    for (const label of ["SSL mode", "Application name", "Search path", "Connect timeout (s)"]) {
      expect(screen.queryByLabelText(label)).not.toBeInTheDocument();
    }
    openAdvanced();
    for (const label of ["SSL mode", "Application name", "Search path", "Connect timeout (s)"]) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
    expect(screen.queryByLabelText("Replica set")).not.toBeInTheDocument();
  });

  it("🔴 leaves the port EMPTY, showing the descriptor's default as a placeholder", async () => {
    await open();
    // A port nobody entered must never be added. The box used to open
    // holding 5432, which was then stored and emitted into every connection string.
    const port = screen.getByLabelText("Port");
    expect(port).toHaveValue("");
    expect(port).toHaveAttribute("placeholder", "5432");
    expect(port).toHaveAttribute("title", "Leave empty for 5432, this engine's default.");
  });

  it("carries the descriptor's prose as a tooltip rather than a paragraph", async () => {
    await open();
    openAdvanced();
    const box = screen.getByLabelText("Application name");
    expect(box).toHaveAttribute(
      "title",
      "Appears in pg_stat_activity, so a runaway query is traceable back to this app.",
    );
    // And it is no longer a line of body text sitting under the control.
    expect(
      screen.queryByText(
        "Appears in pg_stat_activity, so a runaway query is traceable back to this app.",
      ),
    ).not.toBeInTheDocument();
  });

  it("grows a MongoDB form — replica set, read preference, direct connection — on switch", async () => {
    await open();
    fireEvent.change(screen.getByLabelText("Driver"), { target: { value: "mongodb" } });
    // `authSource` is `required` in the descriptor, so it stays visible: a save that blocks on a
    // field hidden behind a collapsed section is a dead end.
    expect(screen.getByLabelText("Auth source")).toBeInTheDocument();
    openAdvanced();
    expect(screen.getByLabelText("Replica set")).toBeInTheDocument();
    expect(screen.getByLabelText("Read preference")).toBeInTheDocument();
    expect(screen.getByLabelText("Direct connection")).toHaveAttribute("type", "checkbox");
    expect(screen.queryByLabelText("Search path")).not.toBeInTheDocument();
  });

  it("drops the user field for an engine that has no user", async () => {
    await open();
    fireEvent.change(screen.getByLabelText("Driver"), { target: { value: "redis" } });
    expect(screen.queryByLabelText("User")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Database index")).toBeInTheDocument();
  });

  it("offers only the engine's own SSL modes", async () => {
    await open();
    openAdvanced();
    const ssl = screen.getByLabelText("SSL mode");
    expect(within(ssl).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "disable",
      "prefer",
      "require",
      "verify-ca",
      "verify-full",
    ]);
  });

  it("writes a select and a checkbox extra straight into the draft's options", async () => {
    await open();
    fireEvent.change(screen.getByLabelText("Driver"), { target: { value: "mongodb" } });
    openAdvanced();
    fireEvent.change(screen.getByLabelText("Read preference"), { target: { value: "nearest" } });
    fireEvent.click(screen.getByLabelText("Direct connection"));
    await waitFor(() => {
      const last = h.onBuildUrl.mock.calls.at(-1)![0] as DbConnectionDraft;
      // `authSource` is here because its descriptor carries a non-empty `default`
      // ("admin") and `newDraft` seeds those — the whole point of adding `default`.
      // Empty defaults are NOT seeded: an empty option is indistinguishable from an
      // unset one, so writing it would be noise in a persisted record.
      expect(last.options).toEqual({
        authSource: "admin",
        readPreference: "nearest",
        directConnection: "true",
      });
    });
    fireEvent.click(screen.getByLabelText("Direct connection"));
    await waitFor(() => {
      const last = h.onBuildUrl.mock.calls.at(-1)![0] as DbConnectionDraft;
      expect(last.options.directConnection).toBe("");
    });
  });

  it("ignores a driver value that names no engine", async () => {
    await open();
    const driver = screen.getByLabelText("Driver");
    fireEvent.change(driver, { target: { value: "not-an-engine" } });
    openAdvanced();
    expect(screen.getByLabelText("Search path")).toBeInTheDocument(); // still PostgreSQL
  });

  it("says so when the saved connection names an engine this build does not offer", async () => {
    await open({ initial: { id: "01J", engine: "aurora-mysql", name: "X", host: "h" } });
    expect(notices()).toContain('names the engine "aurora-mysql"');
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Edit connection");
  });
});

/* ═══════════════════════════ engine switching ════════════════════════════ */

describe("switching engine", () => {
  it("keeps the common fields, drops the options the new engine cannot use, and says both", async () => {
    await open({
      initial: {
        name: "Mongo Maestro",
        engine: "mongodb",
        host: "cluster0",
        user: "catalog_ro",
        options: { replicaSet: "rs0", authSource: "admin" },
      },
    });
    fireEvent.change(screen.getByLabelText("Driver"), { target: { value: "postgres" } });

    expect(screen.getByLabelText("Name")).toHaveValue("Mongo Maestro");
    expect(screen.getByLabelText("Host")).toHaveValue("cluster0");
    expect(screen.getByLabelText("User")).toHaveValue("catalog_ro");
    expect(notices()).toContain(
      "Switched to PostgreSQL. Name, host, user and the guardrails were kept.",
    );
    // Three, not two: `readPreference` is seeded from its non-empty descriptor default,
    // so switching away from Mongo now drops it as well.
    expect(notices()).toContain(
      "Removed 3 settings PostgreSQL does not use: authSource, readPreference, replicaSet.",
    );
    expect(screen.queryByLabelText("Replica set")).not.toBeInTheDocument();
  });

  it("leaves the port exactly as the user left it, and says nothing about ports", async () => {
    await open();
    fireEvent.change(screen.getByLabelText("Driver"), { target: { value: "mongodb" } });
    expect(screen.getByLabelText("Port")).toHaveValue("");
    expect(screen.getByLabelText("Port")).toHaveAttribute("placeholder", "27017");
    expect(notices()).not.toContain("Port is now");

    type("Port", "6543");
    fireEvent.change(screen.getByLabelText("Driver"), { target: { value: "postgres" } });
    expect(screen.getByLabelText("Port")).toHaveValue("6543");
  });

  it("says when it had to lower the SSL mode", async () => {
    await open();
    openAdvanced();
    fireEvent.change(screen.getByLabelText("SSL mode"), { target: { value: "verify-ca" } });
    fireEvent.change(screen.getByLabelText("Driver"), { target: { value: "mongodb" } });
    expect(screen.getByLabelText("SSL mode")).toHaveValue("require");
    expect(notices()).toContain(
      'MongoDB does not offer SSL mode "verify-ca", so it is now "require".',
    );
  });

  it("keeps Advanced open across a switch, and opens it when the new engine arrives dirty", async () => {
    // A section the user opened must not close under them; and a switch that leaves a
    // non-default value behind must not hide it (the SSL downgrade above is exactly that).
    await open();
    openAdvanced();
    fireEvent.change(screen.getByLabelText("SSL mode"), { target: { value: "verify-ca" } });
    fireEvent.change(screen.getByLabelText("Driver"), { target: { value: "mongodb" } });
    expect(screen.getByTestId("db-advanced")).toBeInTheDocument();

    // Now closed by the user. The draft's SSL mode is MongoDB's `require`, which is not
    // PostgreSQL's default — so switching back arrives dirty and the section reopens rather
    // than hiding a TLS setting the user cannot see.
    fireEvent.click(screen.getByTestId("db-advanced-toggle"));
    expect(screen.queryByTestId("db-advanced")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Driver"), { target: { value: "postgres" } });
    expect(screen.getByTestId("db-advanced")).toBeInTheDocument();
    expect(screen.getByLabelText("SSL mode")).toHaveValue("require");
  });
});

/* ═════════════════════════════ the password ══════════════════════════════ */

describe("the password", () => {
  it("never lands in the draft, whether it is masked or shown", async () => {
    // The rendering changed (visible by default); what this test is about did not.
    await open({ initial: { name: "Prod", host: "db.internal" } });
    const box = screen.getByTestId("db-password");
    fireEvent.change(box, { target: { value: HOSTILE_PASSWORD } });

    fireEvent.click(screen.getByTestId("db-save"));
    await waitFor(() => expect(h.onSave).toHaveBeenCalled());

    const [draft, password] = h.onSave.mock.calls[0] as [DbConnectionDraft, string];
    // Out of band: argument two, and NOT anywhere in the record.
    expect(password).toBe(HOSTILE_PASSWORD);
    expect(Object.keys(draft)).not.toContain("password");
    expect(JSON.stringify(draft)).not.toContain(HOSTILE_PASSWORD);
    expect(draft.passwordRef).toBe("");
  });

  it("🔴 can be MASKED on request — a real button whose name says which way it goes", async () => {
    // The password is shown by default, since this is a local tool — so visible is the
    // default and the button hides it, for a screen share. The direction of this test is the
    // record of that decision.
    await open({ initial: { name: "Prod", host: "db.internal" } });
    const box = screen.getByTestId("db-password");
    fireEvent.change(box, { target: { value: HOSTILE_PASSWORD } });

    const toggle = screen.getByTestId("db-password-reveal");
    // Operable and announced: an element, not a div with an onClick.
    expect(toggle.tagName).toBe("BUTTON");
    expect(toggle).toHaveAttribute("type", "button");
    expect(box).toHaveAttribute("type", "text");
    expect(box).toHaveValue(HOSTILE_PASSWORD);
    expect(toggle).toHaveAccessibleName("Hide password");
    expect(toggle).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(toggle);
    expect(box).toHaveAttribute("type", "password");
    // Masking is a RENDERING change: the value is still there to be saved.
    expect(box).toHaveValue(HOSTILE_PASSWORD);
    expect(toggle).toHaveAccessibleName("Show password");
    expect(toggle).toHaveAttribute("aria-pressed", "false");

    // …and back, so the control is a toggle rather than a one-way door.
    fireEvent.click(toggle);
    expect(box).toHaveAttribute("type", "text");
    expect(toggle).toHaveAttribute("aria-pressed", "true");
  });

  it("🔴 revealing it changes the rendering and NOTHING that is saved", async () => {
    // The assertion that would catch a "reveal" implemented by writing the value somewhere
    // else — a second field, the draft, a data attribute. Two saves, one masked and one
    // revealed, and the payloads must be indistinguishable.
    await open({ initial: { name: "Prod", host: "db.internal" } });
    fireEvent.change(screen.getByTestId("db-password"), { target: { value: HOSTILE_PASSWORD } });

    fireEvent.click(screen.getByTestId("db-save"));
    await waitFor(() => expect(h.onSave).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByTestId("db-password-reveal"));
    // Not a vacuous comparison: the first save was made with the secret on screen (visible is the
    // default now) and the second with it masked, so the two renderings really do differ.
    expect(screen.getByTestId("db-password")).toHaveAttribute("type", "password");
    fireEvent.click(screen.getByTestId("db-save"));
    await waitFor(() => expect(h.onSave).toHaveBeenCalledTimes(2));

    // Call 0 was made with it SHOWN, call 1 with it MASKED — the names read the other way round
    // until the default flipped, and the property is the same either way.
    const [shownDraft, shownPassword] = h.onSave.mock.calls[0] as [DbConnectionDraft, string];
    const [maskedDraft, maskedPassword] = h.onSave.mock.calls[1] as [DbConnectionDraft, string];
    expect(shownDraft).toEqual(maskedDraft);
    expect(shownPassword).toBe(maskedPassword);
    expect(shownPassword).toBe(HOSTILE_PASSWORD);
    // Still out of band, revealed or not (the rule the first test in this block pins).
    expect(JSON.stringify(shownDraft)).not.toContain(HOSTILE_PASSWORD);
  });

  it("🔴 starts VISIBLE on every open, and never renders a stored secret", async () => {
    // Visible by default (this is a local tool), and the
    // reason it is safe is the second assertion here rather than the first: the field is EMPTY on
    // open even for a saved connection, because the secret lives in the Vault and only its
    // `{{VAR}}` reference is rendered. So "visible" can only ever mean "what you just typed".
    //
    // 🔴 This assertion is the condition on the default: if the dialog ever starts prefilling a
    // stored password, this test goes red and the default must flip back to masked.
    const initial = { id: "01J", name: "Prod", host: "db.internal", passwordRef: "{{PG_PASSWORD}}" };
    const { unmount } = await open({ initial });
    expect(screen.getByTestId("db-password")).toHaveAttribute("type", "text");
    expect(screen.getByTestId("db-password")).toHaveValue("");

    // The toggle still masks it — for a screen share — and a reopen returns to visible.
    fireEvent.click(screen.getByTestId("db-password-reveal"));
    expect(screen.getByTestId("db-password")).toHaveAttribute("type", "password");

    unmount();
    h.onBuildUrl.mockClear();
    await open({ initial });
    expect(screen.getByTestId("db-password")).toHaveAttribute("type", "text");
    expect(screen.getByTestId("db-password")).toHaveValue("");
    expect(screen.getByTestId("db-password-reveal")).toHaveAccessibleName("Hide password");
    expect(screen.getByTestId("db-password-reveal")).toHaveAttribute("aria-pressed", "true");
  });

  it("renders the Save: control with the three retention choices", async () => {
    await open();
    const save = screen.getByLabelText("Save:");
    expect(within(save).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Forever",
      "Until I quit",
      "Never",
    ]);
    expect(save).toHaveValue("forever");
    expect(screen.getByText(/Kept in the Vault under a \{\{VAR\}\} name/)).toBeInTheDocument();

    fireEvent.change(save, { target: { value: "never" } });
    expect(
      screen.getByText("Not kept at all — you are asked for it on every connect."),
    ).toBeInTheDocument();
  });

  it("shows the {{VAR}} reference for a saved password, not the password", async () => {
    await open({
      initial: { id: "01J", name: "P", host: "h", passwordRef: "{{PG_PROD_PASSWORD}}" },
    });
    expect(screen.getByTestId("db-password-ref")).toHaveTextContent("{{PG_PROD_PASSWORD}}");
    expect(screen.getByTestId("db-password-ref")).toHaveTextContent("never the value");
  });

  it("summarises a CA certificate rather than showing its PEM", async () => {
    await open({
      initial: {
        id: "01J",
        name: "P",
        host: "h",
        caSummary: { subjects: ["Amazon RDS"], count: 2, sha256: "abcdef0123456789ff" },
      },
    });
    expect(screen.getByTestId("db-ca-summary")).toHaveTextContent(
      "CA certificate: 2 certificates (Amazon RDS) · abcdef012345",
    );
  });

  it("says certificate, singular, for one", async () => {
    await open({
      initial: {
        id: "01J",
        name: "P",
        host: "h",
        caSummary: { subjects: ["Internal CA"], count: 1, sha256: "0123456789abcdef" },
      },
    });
    expect(screen.getByTestId("db-ca-summary")).toHaveTextContent(
      "CA certificate: 1 certificate (Internal CA) · 0123456789ab",
    );
  });
});

/* ═══════════════════ a descriptor the dialog must not trust ══════════════ */

describe("an awkward descriptor", () => {
  it("copes with the shapes that would otherwise mislead or crash it", async () => {
    await open({ engines: [AWKWARD_ENGINE], initial: null });

    // No database concept, and no TLS choices to offer.
    expect(screen.queryByLabelText("Database")).not.toBeInTheDocument();
    openAdvanced();
    expect(screen.queryByLabelText("SSL mode")).not.toBeInTheDocument();
    // A select with no choices renders empty rather than throwing or inventing one.
    const mode = screen.getByLabelText("Mode");
    expect(within(mode).queryAllByRole("option")).toEqual([]);
    // And read-only is ON, which no descriptor can change: `EngineSpec.defaults` has no
    // `readOnly` key to set (removed from the contract for exactly this reason — the
    // most important safety default must not be weakenable by data).
    expect(Object.keys(AWKWARD_ENGINE.defaults)).not.toContain("readOnly");
    expect(screen.getByLabelText("Read-only")).toBeChecked();
  });
});

/* ══════════════════════════ the URL preview ══════════════════════════════ */

describe("the connection string", () => {
  it("is derived from the form and updates as the form changes", async () => {
    await open();
    type("Host", "db.prod");
    type("User", "catalog_ro");
    type("Database", "maestro");
    // No `:5432` anywhere: an untouched port reaches `db_url_build` as `null`, so the string
    // the user is shown is the string they described.
    await waitFor(() => expect(urlBox()).toHaveValue("postgresql://catalog_ro@db.prod/maestro"));
    type("Port", "6543");
    await waitFor(() =>
      expect(urlBox()).toHaveValue("postgresql://catalog_ro@db.prod:6543/maestro"),
    );
  });

  it("NEVER shows the password, even when the layer below echoes it back", async () => {
    // A hostile/buggy backend: both the literal and the percent-encoded form.
    h.onBuildUrl.mockImplementation(
      async () =>
        `postgresql://u:${HOSTILE_PASSWORD}@h:5432/db?also=${HOSTILE_ENCODED}&x=${HOSTILE_PASSWORD}`,
    );
    const { container } = await open();
    fireEvent.change(screen.getByTestId("db-password"), { target: { value: HOSTILE_PASSWORD } });

    await waitFor(() => expect(urlBox().value).toContain(SECRET_MASK));
    expect(urlBox().value).not.toContain(HOSTILE_PASSWORD);
    expect(urlBox().value).not.toContain(HOSTILE_ENCODED);
    expect(container.textContent).not.toContain(HOSTILE_PASSWORD);
    // The builder is never even given the password — it has no parameter for one.
    for (const call of h.onBuildUrl.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(HOSTILE_PASSWORD);
    }
  });

  it("opens a saved URL override in URL-only mode, editable, and says it overrides", async () => {
    await open({
      initial: {
        id: "01J",
        name: "P",
        host: "h",
        url: "postgresql://u:{{PG_PROD_PASSWORD}}@h:5432/db",
      },
    });
    expect(urlBox()).toHaveValue("postgresql://u:{{PG_PROD_PASSWORD}}@h:5432/db");
    // 🔴 The URL used to be read-only — it can be edited now, and it says what that means.
    expect(urlBox()).not.toHaveAttribute("readonly");
    expect(screen.getByTestId("db-mode")).toHaveValue("url");
    expect(screen.getByTestId("db-url-hint")).toHaveTextContent(URL_OVERRIDE_NOTE);
    // A `{{VAR}}` is not a literal, so no warning about a password sitting in the string.
    expect(screen.queryByTestId("db-url-literal")).not.toBeInTheDocument();
  });

  it("copies the safe string and says what went on the clipboard", async () => {
    const user = userEvent.setup();
    await open();
    await user.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(notices()).toContain(URL_COPIED_NOTICE));
    await expect(navigator.clipboard.readText()).resolves.toBe(urlBox().value);
  });

  it("reports a clipboard that refused rather than pretending it copied", async () => {
    const writeText = vi.fn(async () => {
      throw new Error("clipboard blocked");
    });
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() =>
      expect(screen.getByTestId("db-url-error")).toHaveTextContent("clipboard blocked"),
    );
    expect(notices()).not.toContain(URL_COPIED_NOTICE);
  });

  it("shows a build failure instead of a stale string", async () => {
    h.onBuildUrl.mockRejectedValue("invalid-config: no host");
    await open();
    await waitFor(() =>
      expect(screen.getByTestId("db-url-error")).toHaveTextContent("invalid-config: no host"),
    );
    expect(urlBox()).toHaveValue("");
  });

  it("drops a build that resolves after the dialog is gone", async () => {
    let settle: (s: string) => void = () => {};
    h.onBuildUrl.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          settle = resolve;
        }),
    );
    const { unmount } = await open();
    unmount();
    // Resolving now must not touch React state (an unmounted-setState warning would
    // fail the run's console budget, and a stale preview would be a lie).
    settle("postgresql://late@h/db");
    await Promise.resolve();
    expect(screen.queryByTestId("db-url")).not.toBeInTheDocument();
  });

  it("drops a build that REJECTS after the dialog is gone", async () => {
    let fail: (e: unknown) => void = () => {};
    h.onBuildUrl.mockImplementation(
      () =>
        new Promise<string>((_resolve, reject) => {
          fail = reject;
        }),
    );
    const { unmount } = await open();
    unmount();
    fail("too late");
    await Promise.resolve();
    expect(screen.queryByTestId("db-url-error")).not.toBeInTheDocument();
  });
});

/* ═══════════════════════════ pasting a URL ══════════════════════════════ */

describe("importing a connection string", () => {
  it("🔴 KEEPS the pasted string as the override, and never lets it become an input value", async () => {
    // End to end: the pasted string used to be discarded whenever its password
    // was in the userinfo, and the connection was rebuilt from the fields instead.
    const stripped = "postgresql://ro@db.prod:6543/maestro";
    h.onParseUrl.mockResolvedValue(
      emptyParsed({
        engine: "postgres",
        host: "db.prod",
        port: 6543,
        database: "maestro",
        user: "ro",
        hadPassword: true,
        url: stripped,
      }),
    );
    const { container } = await open();
    const pasted = `postgresql://ro:${HOSTILE_PASSWORD}@db.prod:6543/maestro`;
    pasteUrl(pasted);

    await waitFor(() => expect(h.onParseUrl).toHaveBeenCalledWith(pasted));
    // The box holds the parser's CREDENTIAL-FREE string — the literal never reached React state.
    await waitFor(() => expect(urlBox()).toHaveValue(stripped));
    expect(container.textContent).not.toContain(HOSTILE_PASSWORD);
    expect(screen.getByTestId("db-mode")).toHaveValue("url");
    expect(screen.getByLabelText("Host")).toHaveValue("db.prod");
    expect(screen.getByLabelText("Port")).toHaveValue("6543");
    expect(notices()).toContain("Set host, port, database, user from that URL.");
  });

  it("🔴 keeps `mongodb+srv`, and sends no port for it", async () => {
    const atlas = "mongodb+srv://catalog_ro@cluster0.abcde.mongodb.net/maestro";
    h.onParseUrl.mockResolvedValue(
      emptyParsed({
        engine: "mongodb",
        host: "cluster0.abcde.mongodb.net",
        database: "maestro",
        user: "catalog_ro",
        hadPassword: true,
        url: atlas,
      }),
    );
    await open({ initial: { name: "Atlas", engine: "mongodb" } });
    pasteUrl(`mongodb+srv://catalog_ro:${HOSTILE_PASSWORD}@cluster0.abcde.mongodb.net/maestro`);

    await waitFor(() => expect(urlBox()).toHaveValue(atlas));
    expect(notices()).toContain("That URL is a DNS seed list (`mongodb+srv://`)");
    // The port box is empty AND inert, and the record carries `srv: true` with `port: null`.
    expect(screen.getByLabelText("Port")).toHaveValue("");
    fireEvent.change(screen.getByTestId("db-password"), { target: { value: "s3cret" } });
    fireEvent.click(screen.getByTestId("db-save"));
    await waitFor(() => expect(h.onSave).toHaveBeenCalled());
    expect(h.onSave.mock.calls[0][0]).toMatchObject({ srv: true, port: null, url: atlas });
  });

  it("treats a paste with no scheme as an ordinary edit rather than a parse", async () => {
    // Pasting a hostname into a URL you are fixing must not fire a parse and get refused.
    await open();
    fireEvent.paste(urlBox(), { clipboardData: { getData: () => "db.internal" } });
    expect(h.onParseUrl).not.toHaveBeenCalled();
  });

  it("TELLS the user when the pasted URL carried a password", async () => {
    h.onParseUrl.mockResolvedValue(emptyParsed({ host: "db.prod", hadPassword: true }));
    await open();
    pasteUrl(`postgresql://u:${HOSTILE_PASSWORD}@db.prod/db`);
    await waitFor(() => expect(notices()).toContain(PASSWORD_MOVED_NOTICE));
  });

  it("surfaces query parameters it could not model instead of dropping them", async () => {
    h.onParseUrl.mockResolvedValue(
      emptyParsed({ host: "h", options: { target_session_attrs: "read-write" } }),
    );
    await open();
    pasteUrl("postgresql://h/db?target_session_attrs=read-write");
    await waitFor(() =>
      expect(notices()).toContain(
        "Kept 1 parameter PostgreSQL does not model, to pass through unchanged: " +
          "target_session_attrs=read-write.",
      ),
    );
    const kept = screen.getByTestId("db-unmodelled");
    expect(kept).toHaveTextContent("target_session_attrs=read-write");
    expect(screen.getByTestId("db-warning")).toHaveTextContent(
      "PostgreSQL does not model the setting `target_session_attrs`",
    );

    fireEvent.click(screen.getByRole("button", { name: "Remove target_session_attrs" }));
    expect(screen.queryByTestId("db-unmodelled")).not.toBeInTheDocument();
  });

  it("reads a TYPED string into the fields on Import, taking its password out", async () => {
    // The one-click fix for a literal password someone typed: `db_url_parse` strips it and the
    // box is replaced by the credential-free string it returned.
    h.onParseUrl.mockResolvedValue(
      emptyParsed({ host: "typed.host", hadPassword: true, url: "postgresql://ro@typed.host/db" }),
    );
    await open();
    const button = screen.getByRole("button", { name: "Import" });
    // Nothing derived yet for a blank form, so there is nothing to import.
    await waitFor(() => expect(urlBox()).toHaveValue("postgresql://@/"));
    fireEvent.change(urlBox(), { target: { value: `postgresql://ro:${HOSTILE_PASSWORD}@typed.host/db` } });
    expect(screen.getByTestId("db-url-literal")).toHaveTextContent(URL_LITERAL_PASSWORD_NOTICE);

    fireEvent.click(button);
    await waitFor(() =>
      expect(h.onParseUrl).toHaveBeenCalledWith(`postgresql://ro:${HOSTILE_PASSWORD}@typed.host/db`),
    );
    await waitFor(() => expect(urlBox()).toHaveValue("postgresql://ro@typed.host/db"));
    expect(screen.queryByTestId("db-url-literal")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Host")).toHaveValue("typed.host");
    expect(notices()).toContain(PASSWORD_MOVED_NOTICE);
  });

  it("disables Import when there is no string to import", async () => {
    h.onBuildUrl.mockResolvedValue("");
    await open();
    await waitFor(() => expect(urlBox()).toHaveValue(""));
    expect(screen.getByRole("button", { name: "Import" })).toBeDisabled();
  });

  it("leaves the form untouched when the string will not parse", async () => {
    h.onParseUrl.mockRejectedValue("Port `abc` is not a number.");
    await open({ initial: { name: "P", host: "keep.me" } });
    pasteUrl("postgresql://h:abc/db");
    await waitFor(() =>
      expect(screen.getByTestId("db-url-error")).toHaveTextContent("Port `abc` is not a number."),
    );
    expect(screen.getByLabelText("Host")).toHaveValue("keep.me");
    // And the refused string never landed in the box either.
    expect(urlBox().value).not.toContain("abc");
  });
});

/* ═════════════════ the connection type ══════════════════════════════════════ */

describe("Connection type", () => {
  it("offers SRV only where the descriptor declares the scheme", async () => {
    await open();
    const mode = screen.getByTestId("db-mode");
    expect(within(mode).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Host and port",
      "URL only",
    ]);
    expect(mode).toHaveValue("fields");
    expect(screen.queryByTestId("db-mode-note")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Driver"), { target: { value: "mongodb" } });
    expect(within(screen.getByTestId("db-mode")).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Host and port",
      "DNS seed list (SRV)",
      "URL only",
    ]);
  });

  it("🔴 SRV forbids a port: the box goes inert, says why, and the record carries none", async () => {
    await open({ initial: { name: "Atlas", engine: "mongodb", host: "cluster0.abcde.mongodb.net" } });
    type("Port", "27017"); // a port the user typed before choosing SRV
    setMode("srv");

    const port = screen.getByLabelText("Port");
    expect(port).toBeDisabled();
    expect(screen.getByText("A `mongodb+srv://` URI must not carry a port — DNS supplies it."));
    expect(screen.getByTestId("db-mode-note")).toHaveTextContent(
      "`mongodb+srv://` resolves the hosts, the port and the replica set from DNS",
    );

    fireEvent.click(screen.getByTestId("db-save"));
    await waitFor(() => expect(h.onSave).toHaveBeenCalled());
    // The invalid pairing cannot be persisted, even though the box still shows what was typed.
    expect(port).toHaveValue("27017");
    expect(h.onSave.mock.calls[0][0]).toMatchObject({ srv: true, port: null });
  });

  it("URL only takes over the derived string, makes the fields inert, and connects with it", async () => {
    await open({ initial: { name: "P", host: "db.internal", user: "ro", database: "maestro" } });
    await waitFor(() => expect(urlBox()).toHaveValue("postgresql://ro@db.internal/maestro"));

    setMode("url");
    // Seeded from what it is taking over from — an authoritative box that opens empty would
    // throw away the very thing it replaced.
    expect(urlBox()).toHaveValue("postgresql://ro@db.internal/maestro");
    expect(screen.getByTestId("db-url-hint")).toHaveTextContent(URL_OVERRIDE_NOTE);
    // 🔴 The corrected sentence. The old one ("…and are not used.") contradicted
    // PASSWORD_MOVED_NOTICE a few centimetres below it, which is how a URL-only connection got
    // saved with no credential at all. Asserted as a literal, not against the constant.
    expect(screen.getByTestId("db-mode-note")).toHaveTextContent(
      "The connection string decides the host, port, database and user — the fields below are " +
        "kept for reference. The Password field is still used: it fills the gap when the " +
        "string carries no credential of its own.",
    );
    expect(screen.getByTestId("db-mode-note")).not.toHaveTextContent("are not used");
    // Inert, not gone: the values still show, and Name stays ours.
    expect(screen.getByLabelText("Host")).toBeDisabled();
    expect(screen.getByLabelText("Host")).toHaveValue("db.internal");
    expect(screen.getByLabelText("Name")).toBeEnabled();
    // The guardrails are never governed by the URL.
    expect(screen.getByLabelText("Read-only")).toBeEnabled();
    expect(screen.getByLabelText("Row limit")).toBeEnabled();

    fireEvent.change(urlBox(), { target: { value: "postgresql://ro@other.host:6543/other" } });
    fireEvent.click(screen.getByTestId("db-save"));
    await waitFor(() => expect(h.onSave).toHaveBeenCalled());
    expect(h.onSave.mock.calls[0][0]).toMatchObject({
      url: "postgresql://ro@other.host:6543/other",
      host: "db.internal", // kept, and ignored by Rust while `url` is set
    });
  });

  it("asks for the URL it needs, and for nothing the string already carries", async () => {
    // Connecting with a URL, a user and a password used to demand too many other fields —
    // a URL-only connection needs a name and a string, not a host and a port the
    // URI already has.
    // Nothing derived to seed the box from, so URL-only really does open empty.
    h.onBuildUrl.mockResolvedValue("");
    await open();
    type("Name", "Atlas");
    setMode("url");
    fireEvent.click(screen.getByTestId("db-save"));
    expect(h.onSave).not.toHaveBeenCalled();
    expect(screen.getByText(URL_REQUIRED_ERROR)).toBeInTheDocument();
    expect(urlBox()).toHaveFocus();
    expect(urlBox()).toHaveAttribute("aria-invalid", "true");
    // …and it does NOT also demand the host it is not going to use.
    expect(screen.queryByText("Host is required.")).not.toBeInTheDocument();

    // Clearing the box hands the connection back to the fields, which then ask for their own
    // one requirement instead.
    fireEvent.change(urlBox(), { target: { value: "postgresql://ro@h/db" } });
    fireEvent.change(urlBox(), { target: { value: "" } });
    expect(screen.getByTestId("db-mode")).toHaveValue("fields");
    fireEvent.click(screen.getByTestId("db-save"));
    expect(screen.getByText("Host is required.")).toBeInTheDocument();
    expect(h.onSave).not.toHaveBeenCalled();
  });

  it("moves the select by itself when the user edits the URL, and back when they clear it", async () => {
    // The control explains the override instead of hiding it: a non-empty URL genuinely IS what
    // connects, so the mode is read off the draft rather than stored beside it.
    await open({ initial: { name: "P", host: "db.internal" } });
    fireEvent.change(urlBox(), { target: { value: "postgresql://ro@typed/db" } });
    expect(screen.getByTestId("db-mode")).toHaveValue("url");
    expect(screen.getByLabelText("Host")).toBeDisabled();

    fireEvent.change(urlBox(), { target: { value: "" } });
    expect(screen.getByTestId("db-mode")).toHaveValue("fields");
    expect(screen.getByLabelText("Host")).toBeEnabled();
  });

  it("remembers the URL across a round trip through Host and port", async () => {
    await open({ initial: { name: "P", host: "db.internal" } });
    fireEvent.change(urlBox(), { target: { value: "postgresql://ro@typed/db" } });
    setMode("fields");
    await waitFor(() => expect(urlBox()).toHaveValue("postgresql://@db.internal/"));
    setMode("url");
    expect(urlBox()).toHaveValue("postgresql://ro@typed/db");
  });

  it("warns about a literal password typed into the URL, and says where it goes", async () => {
    await open({ initial: { name: "P", host: "h" } });
    expect(screen.queryByTestId("db-url-literal")).not.toBeInTheDocument();
    fireEvent.change(urlBox(), { target: { value: `postgresql://ro:${HOSTILE_PASSWORD}@h/db` } });
    // Not blocking: `upsert` splits it server-side and Vaults it. Saying so is the whole job —
    // a password silently rewritten is as confusing as a port silently added.
    expect(screen.getByTestId("db-url-literal")).toHaveTextContent(URL_LITERAL_PASSWORD_NOTICE);
    fireEvent.change(urlBox(), { target: { value: "postgresql://ro:{{PG}}@h/db" } });
    expect(screen.queryByTestId("db-url-literal")).not.toBeInTheDocument();
  });
});

/* ═══════════════════════ progressive disclosure ═════════════════════════════ */

describe("the Advanced section", () => {
  it("starts closed for a new connection and toggles", async () => {
    await open();
    const toggle = screen.getByTestId("db-advanced-toggle");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("db-advanced")).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("db-advanced")).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.queryByTestId("db-advanced")).not.toBeInTheDocument();
  });

  it("🔴 opens itself when a SAVED connection has a non-default advanced setting", async () => {
    // A user editing a saved connection must not have to hunt for the setting they set.
    await open({
      initial: { id: "01J", name: "P", host: "h", options: { searchPath: "reporting" } },
    });
    expect(screen.getByTestId("db-advanced")).toBeInTheDocument();
    expect(screen.getByLabelText("Search path")).toHaveValue("reporting");
  });

  it("stays closed when the saved connection only carries the descriptor's own defaults", async () => {
    await open({
      initial: { id: "01J", name: "P", host: "h", options: { applicationName: "Agent Studio" } },
    });
    expect(screen.queryByTestId("db-advanced")).not.toBeInTheDocument();
  });

  it("opens itself when a PASTE lands a non-default value in it", async () => {
    h.onParseUrl.mockResolvedValue(
      emptyParsed({ host: "h", sslMode: "verify-full", url: "postgresql://h/db?sslmode=verify-full" }),
    );
    await open();
    pasteUrl("postgresql://h/db?sslmode=verify-full");
    await waitFor(() => expect(screen.getByTestId("db-advanced")).toBeInTheDocument());
    expect(screen.getByLabelText("SSL mode")).toHaveValue("verify-full");
  });

  it("reveals a collapsed field before focusing it on a failed save", async () => {
    // Otherwise "Fix 1 field before saving" points at a control nobody can see — the dead end
    // a disclosure can create if the reveal and the focus are not ordered.
    await open({ initial: { name: "P", host: "h" } });
    openAdvanced();
    type("Connect timeout (s)", "ten");
    fireEvent.click(screen.getByTestId("db-advanced-toggle")); // collapse it again
    expect(screen.queryByTestId("db-advanced")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("db-save"));
    expect(h.onSave).not.toHaveBeenCalled();
    expect(screen.getByTestId("db-advanced")).toBeInTheDocument();
    expect(screen.getByText("Connect timeout (s) must be a whole number.")).toBeInTheDocument();
    expect(screen.getByLabelText("Connect timeout (s)")).toHaveFocus();
  });

  it("shows no Advanced control at all for an engine that has nothing advanced", async () => {
    // Data-driven, so "nothing optional and no SSL modes" must yield no empty disclosure.
    const bare: EngineSpec = { ...AWKWARD_ENGINE, extraFields: [] };
    await open({ engines: [bare], initial: null });
    expect(screen.queryByTestId("db-advanced-toggle")).not.toBeInTheDocument();
  });
});

describe("focusById", () => {
  it("focuses what is there and does nothing for what is not", () => {
    // The "not there" arm is real: a failed save names the first bad field, and by the time the
    // effect runs any edit may have cleared the error (`firstErrorDomId` answers `""`).
    const input = document.createElement("input");
    input.id = "db-field-real";
    document.body.appendChild(input);
    focusById("db-field-real");
    expect(input).toHaveFocus();
    expect(() => focusById("")).not.toThrow();
    expect(() => focusById("db-field-gone")).not.toThrow();
    input.remove();
  });
});

/* ══════════════════════════ Test Connection ═════════════════════════════ */

describe("Test Connection", () => {
  it("goes pending, then shows the server version and the latency", async () => {
    let settle: (r: DbTestResult) => void = () => {};
    h.onTest.mockImplementation(
      () =>
        new Promise<DbTestResult>((resolve) => {
          settle = resolve;
        }),
    );
    await open({ initial: { name: "P", host: "h" } });

    fireEvent.click(screen.getByTestId("db-test"));
    expect(screen.getByTestId("db-test-result")).toHaveTextContent("Testing the connection…");
    expect(screen.getByTestId("db-test")).toBeDisabled();

    settle(OK_RESULT);
    await waitFor(() =>
      expect(screen.getByTestId("db-test-result")).toHaveTextContent("PostgreSQL 17.2 · 34 ms"),
    );
    expect(screen.getByTestId("db-test-result")).toHaveAttribute("data-tone", "ok");
    expect(screen.getByTestId("db-test")).toBeEnabled();
    // The password went out of band here too.
    expect(h.onTest.mock.calls[0][1]).toBe("");
  });

  it("shows the mapped error, never a raw driver string", async () => {
    h.onTest.mockResolvedValue({
      ok: false,
      serverVersion: null,
      latencyMs: null,
      error: "tls: the server's certificate is not trusted — add its CA, or lower SSL mode",
    });
    await open({ initial: { name: "P", host: "h" } });
    fireEvent.click(screen.getByTestId("db-test"));
    await waitFor(() =>
      expect(screen.getByTestId("db-test-result")).toHaveTextContent(
        "tls: the server's certificate is not trusted — add its CA, or lower SSL mode",
      ),
    );
    expect(screen.getByTestId("db-test-result")).toHaveAttribute("data-tone", "bad");
  });

  it("maps a rejected call rather than leaving the button spinning", async () => {
    h.onTest.mockRejectedValue("secret-missing");
    await open({ initial: { name: "P", host: "h" } });
    fireEvent.click(screen.getByTestId("db-test"));
    await waitFor(() =>
      expect(screen.getByTestId("db-test-result")).toHaveTextContent("secret-missing"),
    );
  });

  it("cannot hang forever — a test that never answers times out", async () => {
    h.onTest.mockImplementation(() => new Promise<DbTestResult>(() => {}));
    await open({ initial: { name: "P", host: "h" }, testTimeoutMs: 200 });
    fireEvent.click(screen.getByTestId("db-test"));
    expect(screen.getByTestId("db-test-result")).toHaveTextContent("Testing the connection…");
    await waitFor(
      () =>
        expect(screen.getByTestId("db-test-result")).toHaveTextContent(
          "The test did not finish within 0 s.",
        ),
      { timeout: 2000 },
    );
    expect(screen.getByTestId("db-test")).toBeEnabled();
  });

  it("scrubs the typed password out of the driver's error text", async () => {
    h.onTest.mockResolvedValue({
      ok: false,
      serverVersion: null,
      latencyMs: null,
      error: `network: could not connect to postgresql://u:${HOSTILE_PASSWORD}@h/db`,
    });
    const { container } = await open({ initial: { name: "P", host: "h" } });
    fireEvent.change(screen.getByTestId("db-password"), { target: { value: HOSTILE_PASSWORD } });
    fireEvent.click(screen.getByTestId("db-test"));
    await waitFor(() =>
      expect(screen.getByTestId("db-test-result")).toHaveTextContent(SECRET_MASK),
    );
    expect(container.textContent).not.toContain(HOSTILE_PASSWORD);
  });

  it("forgets a stale result as soon as the form changes", async () => {
    await open({ initial: { name: "P", host: "h" } });
    fireEvent.click(screen.getByTestId("db-test"));
    await waitFor(() => expect(screen.getByTestId("db-test-result")).toBeInTheDocument());
    type("Host", "somewhere.else");
    expect(screen.queryByTestId("db-test-result")).not.toBeInTheDocument();
  });
});

/* ═══════════════════════════ the guardrails ═════════════════════════════ */

describe("read-only and the other guardrails", () => {
  it("is ON by default for a new connection", async () => {
    await open();
    expect(screen.getByLabelText("Read-only")).toBeChecked();
    expect(screen.getByLabelText("Allow multiple statements")).not.toBeChecked();
    expect(screen.getByLabelText("Row limit")).toHaveValue("500");
    expect(screen.getByLabelText("Timeout (ms)")).toHaveValue("30000");
  });

  it("promises a server boundary only for an engine that has one", async () => {
    await open();
    expect(screen.getByTestId("db-readonly-note")).toHaveTextContent(
      "PostgreSQL enforces this at the server for the whole session",
    );
    expect(screen.getByTestId("db-readonly-note")).not.toHaveTextContent("speed bump");
  });

  it("says it is only a client-side speed bump where the engine cannot enforce it", async () => {
    await open();
    fireEvent.change(screen.getByLabelText("Driver"), { target: { value: "mongodb" } });
    const note = screen.getByTestId("db-readonly-note");
    expect(note).toHaveTextContent("MongoDB has no server-side read-only mode");
    expect(note).toHaveTextContent("a speed bump, not a guarantee");
    expect(note).toHaveTextContent("read-only database user");
    expect(MONGODB_ENGINE.serverEnforcedReadOnly).toBe(false);
    expect(POSTGRES_ENGINE.serverEnforcedReadOnly).toBe(true);
  });

  it("warns loudly when the user turns it off", async () => {
    await open();
    expect(screen.queryByTestId("db-readonly-off")).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Read-only"));
    expect(screen.getByTestId("db-readonly-off")).toHaveTextContent(READ_ONLY_OFF_WARNING);
    expect(screen.getByTestId("db-readonly-off")).toHaveAttribute("role", "alert");
  });

  it("carries the guardrails into the saved record", async () => {
    await open({ initial: { name: "P", host: "h" } });
    type("Row limit", "1000");
    type("Timeout (ms)", "5000");
    fireEvent.click(screen.getByLabelText("Allow multiple statements"));
    fireEvent.click(screen.getByTestId("db-save"));
    await waitFor(() => expect(h.onSave).toHaveBeenCalled());
    const draft = h.onSave.mock.calls[0][0] as DbConnectionDraft;
    expect(draft.rowLimit).toBe(1000);
    expect(draft.timeoutMs).toBe(5000);
    expect(draft.allowMultiStatement).toBe(true);
    expect(draft.readOnly).toBe(true);
  });
});

/* ══════════════════════════════ saving ══════════════════════════════════ */

describe("saving", () => {
  it("refuses, explains, and focuses the first bad field", async () => {
    await open();
    fireEvent.click(screen.getByTestId("db-save"));
    expect(h.onSave).not.toHaveBeenCalled();
    expect(screen.getByTestId("db-summary")).toHaveTextContent(
      "Fix 2 fields before saving this connection.",
    );
    const name = screen.getByLabelText("Name");
    expect(name).toHaveFocus();
    expect(name).toHaveAttribute("aria-invalid", "true");
    const error = screen.getByText("Name is required.");
    expect(name.getAttribute("aria-describedby")).toContain(error.id);
    expect(screen.getByText("Host is required.")).toBeInTheDocument();
  });

  it("reports a required per-engine field the same way", async () => {
    await open({ initial: { name: "P", host: "h", engine: "mongodb" } });
    // Auth source now arrives PRE-FILLED from its descriptor default, so clearing it is
    // what exercises the required-and-empty path this test is about. (Before `default`
    // existed, a fresh Mongo form was invalid on open — the bug that added the field.)
    type("Auth source", "");
    fireEvent.click(screen.getByTestId("db-save"));
    expect(h.onSave).not.toHaveBeenCalled();
    expect(screen.getByText("Auth source is required.")).toBeInTheDocument();
    expect(screen.getByLabelText("Auth source")).toHaveFocus();
  });

  it("reports a bad port with the exact message, and associates it with the field", async () => {
    await open({ initial: { name: "P", host: "h" } });
    type("Port", "70000");
    fireEvent.click(screen.getByTestId("db-save"));
    const port = screen.getByLabelText("Port");
    // The message now teaches the empty case, because empty is the default state of the box.
    const error = screen.getByText("Port must be a whole number from 1 to 65535, or empty for 5432.");
    expect(port).toHaveFocus();
    expect(port.getAttribute("aria-describedby")).toContain(error.id);
  });

  it("saves an empty port without complaint", async () => {
    await open({ initial: { name: "P", host: "h" } });
    fireEvent.click(screen.getByTestId("db-save"));
    await waitFor(() => expect(h.onSave).toHaveBeenCalled());
    expect(h.onSave.mock.calls[0][0]).toMatchObject({ port: null });
    expect(screen.queryByTestId("db-summary")).not.toBeInTheDocument();
  });

  it("reports a bad guardrail number and focuses it", async () => {
    await open({ initial: { name: "P", host: "h" } });
    type("Row limit", "999999");
    fireEvent.click(screen.getByTestId("db-save"));
    expect(screen.getByText("Row limit must be a whole number from 1 to 100000.")).toBeInTheDocument();
    expect(screen.getByLabelText("Row limit")).toHaveFocus();
  });

  it("does not show field errors before the first attempt", async () => {
    await open();
    expect(screen.queryByText("Name is required.")).not.toBeInTheDocument();
    expect(screen.queryByTestId("db-summary")).not.toBeInTheDocument();
  });

  it("passes a complete draft, with family denormalised from the descriptor", async () => {
    await open();
    type("Name", "Prod");
    type("Host", "db.internal");
    type("User", "catalog_ro");
    fireEvent.click(screen.getByTestId("db-save"));
    await waitFor(() => expect(h.onSave).toHaveBeenCalled());
    expect(h.onSave.mock.calls[0][0]).toMatchObject({
      name: "Prod",
      host: "db.internal",
      user: "catalog_ro",
      engine: "postgres",
      family: "postgres",
      // 🔴 `null`, not 5432: the port the user never typed is not sent.
      port: null,
      srv: false,
      readOnly: true,
      url: null,
    });
    // The draft is a `DbConnectionDraft`, so the three Rust-minted fields are absent
    // rather than carrying sentinels. That is the whole reason the type was split out:
    // `createdAt: 0` is how an epoch timestamp eventually reaches a UI.
    const draft = h.onSave.mock.calls[0][0] as Record<string, unknown>;
    expect(draft).not.toHaveProperty("id");
    expect(draft).not.toHaveProperty("createdAt");
    expect(draft).not.toHaveProperty("updatedAt");
  });

  it("shows a rejected save and re-enables the button", async () => {
    h.onSave.mockRejectedValue("invalid-config: unknown option");
    await open({ initial: { name: "P", host: "h" } });
    fireEvent.click(screen.getByTestId("db-save"));
    await waitFor(() =>
      expect(screen.getByTestId("db-save-error")).toHaveTextContent("invalid-config: unknown option"),
    );
    expect(screen.getByTestId("db-save")).toBeEnabled();
  });

  it("disables the button while the save is in flight", async () => {
    let settle: () => void = () => {};
    h.onSave.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );
    await open({ initial: { name: "P", host: "h" } });
    fireEvent.click(screen.getByTestId("db-save"));
    await waitFor(() => expect(screen.getByTestId("db-save")).toBeDisabled());
    expect(screen.getByTestId("db-save")).toHaveTextContent("Saving…");
    settle();
    await waitFor(() => expect(screen.getByTestId("db-save")).toBeEnabled());
  });
});

/* ═════════════════════ accessibility, focus, closing ════════════════════ */

describe("the modal contract", () => {
  it("is a labelled, modal dialog", async () => {
    await open();
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleName("New connection");
  });

  it("moves focus into the form on open and restores it on close", async () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    expect(opener).toHaveFocus();

    const { unmount } = await open();
    expect(screen.getByLabelText("Name")).toHaveFocus();

    unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });

  it("traps Tab at both ends of the dialog", async () => {
    await open();
    const dialog = screen.getByRole("dialog");
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), select"),
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    last.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(first).toHaveFocus();

    first.focus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();
  });

  it("pulls focus back in when it has escaped, and leaves the middle alone", async () => {
    await open();
    const dialog = screen.getByRole("dialog");
    const inputs = Array.from(dialog.querySelectorAll<HTMLInputElement>("input"));
    document.body.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(dialog.contains(document.activeElement)).toBe(true);

    inputs[2].focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(inputs[2]).toHaveFocus(); // the browser's own order is left to do its job
  });

  it("ignores keys that are neither Escape nor Tab", async () => {
    await open();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "a" });
    expect(h.onCancel).not.toHaveBeenCalled();
  });

  it("closes on Escape and on Cancel", async () => {
    await open();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(h.onCancel).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("db-cancel"));
    expect(h.onCancel).toHaveBeenCalledTimes(2);
  });

  it("says so, instead of rendering an empty form, when no engines were offered", async () => {
    render(<ConnectionDialog {...h.props} engines={[]} />);
    expect(h.onBuildUrl).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toHaveAccessibleName("No database engines");
    expect(screen.getByText(/no database drivers/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(h.onCancel).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(h.onCancel).toHaveBeenCalledTimes(2);
  });
});

/**
 * 🔴 **DynamoDB declares no connection string**, and an older build was therefore offering a
 * "URL only" mode whose every control is inert — a `user@host/database` box for something with
 * no user and no database, which then refused to save with "Host is required".
 *
 * It went unnoticed because **nothing rendered its dialog**: the field logic
 * (`engineFieldRows`) is a pure function over a descriptor and was behaving perfectly, while the
 * component around it added a mode it should not have offered. These tests render the component —
 * the layer the user actually touches.
 */
describe("no engine without a DSN offers a connection string", () => {
  /** A DynamoDB-shaped row: schemeless, no database, addressed by host and port. */
  const DYNAMODB_ENGINE: EngineSpec = {
    ...POSTGRES_ENGINE,
    id: "dynamodb",
    family: "dynamodb",
    label: "Amazon DynamoDB",
    defaultPort: 443,
    urlSchemes: [],
    databaseLabel: null,
    extraFields: [],
  };

  it("shows no connection-string box", async () => {
    await open({
      engines: [POSTGRES_ENGINE, DYNAMODB_ENGINE],
      initial: { engine: "dynamodb" } as never,
    });
    expect(screen.queryByTestId("db-url")).not.toBeInTheDocument();
  });

  it("never offers 'URL only' — the mode that made the form unfillable", async () => {
    await open({
      engines: [POSTGRES_ENGINE, DYNAMODB_ENGINE],
      initial: { engine: "dynamodb" } as never,
    });
    // With one mode there is nothing to choose, so the selector is not rendered at all.
    expect(screen.queryByTestId("db-mode")).not.toBeInTheDocument();
    // …while an engine that DOES have a DSN keeps both.
    await open();
    expect(screen.getByTestId("db-mode")).toBeInTheDocument();
    expect(screen.getByTestId("db-url")).toBeInTheDocument();
  });
});
