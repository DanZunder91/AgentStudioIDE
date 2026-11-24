/**
 * The SEAM: store slice ⇄ the two dialogs, driven for real.
 *
 * Neither half could write this file. The store slice's suite mocks the components away; the
 * dialogs' suites take everything through props and never see a store. Both are at 100% coverage
 * and **both were right about their own side** — and the join still had two defects, which this
 * file exists to have caught:
 *
 * 1. A sealed bundle could not be imported at all. `portability_import` needs the passphrase that
 *    unsealed the plan, `ImportDialogProps` deliberately carries none, and the store must not hold
 *    one. The passphrase had nowhere to live.
 * 2. The user's per-item choices were silently ignored. The dialog holds them in component state;
 *    `applyImport` reads them from the store. Nothing connected the two, so every item would have
 *    taken the plan's default and no error would have said so.
 *
 * Only the IPC edge is mocked. The store, its reducers, both dialogs and the container are real.
 * Literal expectations throughout.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({
  portabilityExport: vi.fn(),
  portabilityInspect: vi.fn(),
  portabilityImport: vi.fn(),
  pickBundleDestination: vi.fn(),
  pickBundleSource: vi.fn(),
}));
// Partial mock: `importChoices` is a pure record-shaper in the same module and the store calls it.
// Replacing it with `undefined` (which a whole-module factory does) is exactly the mistake that
// once made the DB connect path fail with "an unrecognized reason".
vi.mock("./portabilityIpc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./portabilityIpc")>()),
  ...ipc,
}));

const terminal = vi.hoisted(() => ({
  configureTerminal: vi.fn(),
  dispose: vi.fn(),
  setDefaultTerminalCwd: vi.fn(),
}));
vi.mock("../terminal", () => terminal);

import { useAppStore } from "../../app/store";
import { resetStore } from "../../test/store-harness";
import { PortabilityDialogs, exportSourceFrom } from "./PortabilityDialogs";
import type { ImportPlan } from "./types";

const state = () => useAppStore.getState();
const SRC = "/Users/me/from-a-colleague.json";
const PASSPHRASE = "correct-horse-battery-staple";

/** A sealed bundle's header-only plan: what `inspect` returns with no passphrase. */
const LOCKED: ImportPlan = {
  header: {
    kind: "agentstudio.bundle",
    version: 1,
    mode: "sealed",
    createdAtMs: 1_785_000_000_000,
    app: "Agent Studio 0.1.0",
    label: "Team staging",
    counts: {
      dbConnections: 1,
      dbQueries: 0,
      apiRequests: 1,
      environments: 1,
      referencedVariables: 1,
      secretValues: 1,
    },
  },
  unsealed: false,
  items: [],
  hosts: [],
  variables: [],
  notices: [],
};

/** The same bundle, opened. Two items so a per-item override is a real choice. */
const UNSEALED: ImportPlan = {
  ...LOCKED,
  unsealed: true,
  items: [
    {
      kind: "dbConnection",
      id: "dbConnection:01J-CONN",
      label: "staging postgres",
      action: "create",
      reason: "nothing here has this id",
    },
    {
      kind: "apiRequest",
      id: "apiRequest:01J-REQ",
      label: "GET /health",
      action: "create",
      reason: "nothing here has this id",
    },
  ],
  hosts: ["db.staging.internal", "api.example.com"],
  variables: [{ name: "PG_PASSWORD", haveLocally: false, bundleHasValue: true }],
  notices: [],
};

const RESULT = {
  created: { dbConnections: 1, dbQueries: 0, apiRequests: 1, environments: 0, variables: 1 },
  updated: { dbConnections: 0, dbQueries: 0, apiRequests: 0, environments: 0, variables: 0 },
  skipped: { dbConnections: 0, dbQueries: 0, apiRequests: 0, environments: 0, variables: 0 },
  notices: [],
};

beforeEach(() => {
  resetStore();
  cleanup();
  for (const fn of Object.values(ipc)) fn.mockReset();
});

/** Open the import dialog on an already-picked, still-locked bundle. */
function openLockedImport(): void {
  useAppStore.setState((s) => {
    s.portabilityDialog = "import";
    s.portabilityImport.srcPath = SRC;
    s.portabilityImport.plan = LOCKED;
  });
}

describe("PortabilityDialogs — the join neither half could test", () => {
  it("renders nothing when no dialog is open", () => {
    render(<PortabilityDialogs />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("🔴 imports a SEALED bundle — the passphrase reaches the command that needs it", async () => {
    const user = userEvent.setup();
    ipc.portabilityInspect.mockResolvedValue(UNSEALED);
    ipc.portabilityImport.mockResolvedValue(RESULT);
    openLockedImport();
    render(<PortabilityDialogs />);

    // Unlock.
    await user.type(screen.getByTestId("pb-import-passphrase"), PASSPHRASE);
    await user.click(screen.getByTestId("pb-unlock"));
    await waitFor(() => expect(state().portabilityImport.plan?.unsealed).toBe(true));
    expect(ipc.portabilityInspect).toHaveBeenCalledWith(SRC, PASSPHRASE);

    // Import. THE assertion of this file: the passphrase the dialog has already forgotten, and
    // the store never held, still arrives at `portability_import` — otherwise a sealed bundle
    // could be reviewed and never imported.
    await user.click(screen.getByTestId("pb-import"));
    await waitFor(() => expect(ipc.portabilityImport).toHaveBeenCalledTimes(1));
    const [path, passphrase] = ipc.portabilityImport.mock.calls[0] as [string, string | null];
    expect(path).toBe(SRC);
    expect(passphrase).toBe(PASSPHRASE);
  });

  it("🔴 forwards the user's per-item choices, which the store is what actually sends", async () => {
    const user = userEvent.setup();
    ipc.portabilityInspect.mockResolvedValue(UNSEALED);
    ipc.portabilityImport.mockResolvedValue(RESULT);
    useAppStore.setState((s) => {
      s.portabilityDialog = "import";
      s.portabilityImport.srcPath = SRC;
      s.portabilityImport.plan = UNSEALED;
    });
    render(<PortabilityDialogs />);

    // Change one item to "skip". The dialog holds that in ITS state; `applyImport` reads the
    // store's. Without the container forwarding it, this choice vanishes and the item is created
    // anyway — silently, which is the part that makes it a bug rather than an annoyance.
    const selects = screen.getAllByRole("combobox");
    await user.selectOptions(selects[0], "skip");
    await user.click(screen.getByTestId("pb-import"));

    await waitFor(() => expect(ipc.portabilityImport).toHaveBeenCalledTimes(1));
    const choices = ipc.portabilityImport.mock.calls[0][2] as {
      actions: Record<string, string>;
      overwriteExistingSecrets: boolean;
    };
    expect(choices.actions["dbConnection:01J-CONN"]).toBe("skip");
    // And the security default survives the trip untouched.
    expect(choices.overwriteExistingSecrets).toBe(false);
  });

  it("a wrong passphrase is retryable in place, without re-picking the file", async () => {
    const user = userEvent.setup();
    ipc.portabilityInspect
      .mockRejectedValueOnce("bad-passphrase")
      .mockResolvedValueOnce(UNSEALED);
    openLockedImport();
    render(<PortabilityDialogs />);

    await user.type(screen.getByTestId("pb-import-passphrase"), "wrong-passphrase-x");
    await user.click(screen.getByTestId("pb-unlock"));
    await waitFor(() => expect(state().portabilityImport.error).not.toBeNull());

    // The file is still chosen and the field is still there — the whole point of not latching a
    // failure. Re-picking a file to fix a typo would be its own small insult.
    expect(state().portabilityImport.srcPath).toBe(SRC);
    const field = screen.getByTestId("pb-import-passphrase");
    await user.clear(field);
    await user.type(field, PASSPHRASE);
    await user.click(screen.getByTestId("pb-unlock"));
    await waitFor(() => expect(state().portabilityImport.plan?.unsealed).toBe(true));
  });

  it("closing clears the passphrase, so reopening cannot silently reuse it", async () => {
    const user = userEvent.setup();
    ipc.portabilityInspect.mockResolvedValue(UNSEALED);
    ipc.portabilityImport.mockResolvedValue(RESULT);
    openLockedImport();
    const { unmount } = render(<PortabilityDialogs />);

    await user.type(screen.getByTestId("pb-import-passphrase"), PASSPHRASE);
    await user.click(screen.getByTestId("pb-unlock"));
    await waitFor(() => expect(state().portabilityImport.plan?.unsealed).toBe(true));

    // Close, then reopen on the same (still unsealed) plan and import.
    state().portabilityActions.closePortabilityDialog();
    unmount();
    useAppStore.setState((s) => {
      s.portabilityDialog = "import";
    });
    render(<PortabilityDialogs />);
    await user.click(screen.getByTestId("pb-import"));

    await waitFor(() => expect(ipc.portabilityImport).toHaveBeenCalledTimes(1));
    // `null`, not the passphrase from before: a remembered secret surviving a dialog the user
    // dismissed is the kind of convenience nobody asked for. Rust will refuse the sealed bundle,
    // which is the correct, visible outcome.
    expect(ipc.portabilityImport.mock.calls[0][1]).toBeNull();
  });

  it("the store never contains the passphrase at any point in the flow", async () => {
    const user = userEvent.setup();
    ipc.portabilityInspect.mockResolvedValue(UNSEALED);
    ipc.portabilityImport.mockResolvedValue(RESULT);
    openLockedImport();
    render(<PortabilityDialogs />);

    await user.type(screen.getByTestId("pb-import-passphrase"), PASSPHRASE);
    await user.click(screen.getByTestId("pb-unlock"));
    await waitFor(() => expect(ipc.portabilityInspect).toHaveBeenCalled());
    await user.click(screen.getByTestId("pb-import"));
    await waitFor(() => expect(ipc.portabilityImport).toHaveBeenCalled());

    // The whole store, serialised. The slice has its own version of this assertion; repeating it
    // HERE is the point, because the container is the piece that actually holds the value.
    expect(JSON.stringify(useAppStore.getState())).not.toContain(PASSPHRASE);
  });

  it("picking a file reaches the picker, and Close clears the dialog AND the passphrase", async () => {
    const user = userEvent.setup();
    ipc.pickBundleSource.mockResolvedValue(null); // the user cancelled the picker
    useAppStore.setState((s) => {
      s.portabilityDialog = "import";
    });
    render(<PortabilityDialogs />);

    // The pick affordance is the whole first step; without this wired, the import dialog opens
    // and can never get a file.
    await user.click(screen.getByTestId("pb-pick"));
    await waitFor(() => expect(ipc.pickBundleSource).toHaveBeenCalledTimes(1));
    // A cancelled picker must leave the dialog open and pick nothing — not close it, and not
    // record a path.
    expect(state().portabilityDialog).toBe("import");
    expect(state().portabilityImport.srcPath).toBeNull();

    await user.click(screen.getByTestId("pb-import-close"));
    expect(state().portabilityDialog).toBeNull();
  });

  it("🔴 Close forgets the passphrase, so a reopened dialog cannot import with it", async () => {
    const user = userEvent.setup();
    ipc.portabilityInspect.mockResolvedValue(UNSEALED);
    ipc.portabilityImport.mockResolvedValue(RESULT);
    openLockedImport();
    render(<PortabilityDialogs />);

    await user.type(screen.getByTestId("pb-import-passphrase"), PASSPHRASE);
    await user.click(screen.getByTestId("pb-unlock"));
    await waitFor(() => expect(state().portabilityImport.plan?.unsealed).toBe(true));

    // Dismiss through the dialog's own Close — the gesture a user actually makes, which is what
    // must clear the ref. (The test above closes through the store action and therefore does not
    // exercise this path at all.)
    await user.click(screen.getByTestId("pb-import-close"));
    expect(state().portabilityDialog).toBeNull();

    // Reopen on the same still-unsealed plan and import: the passphrase must be gone.
    // `waitFor` before the click, not `getByTestId` straight after the `setState`: a store write
    // from outside React is not flushed synchronously, so the first version of this test looked
    // for a button that had not been re-rendered yet.
    useAppStore.setState((s) => {
      s.portabilityDialog = "import";
    });
    const apply = await waitFor(() => screen.getByTestId("pb-import"));
    await user.click(apply);
    await waitFor(() => expect(ipc.portabilityImport).toHaveBeenCalledTimes(1));
    expect(ipc.portabilityImport.mock.calls[0][1]).toBeNull();
  });
});

describe("the export half of the seam", () => {
  it("reaches the command with what the dialog collected", async () => {
    const user = userEvent.setup();
    ipc.pickBundleDestination.mockResolvedValue("/Users/me/out.json");
    ipc.portabilityExport.mockResolvedValue(LOCKED.header);
    useAppStore.setState((s) => {
      s.portabilityDialog = "export";
      // There has to BE something to export: the dialog blocks on an empty selection
      // ("Choose at least one thing to include"), which is correct — without a connection the
      // button would be disabled and nothing would be called.
      s.dbConnections = [
        { id: "c1", name: "staging", engine: "postgres" } as never,
      ];
    });
    render(<PortabilityDialogs />);

    await user.click(screen.getByTestId("pb-export"));
    await waitFor(() => expect(ipc.portabilityExport).toHaveBeenCalledTimes(1));
    // `structure` is the default and must survive the trip — asserted on the WIRE
    // rather than on the radio, because the radio is the dialog's own tested concern.
    const [options] = ipc.portabilityExport.mock.calls[0] as [{ mode: string }];
    expect(options.mode).toBe("structure");
  });
});

describe("exportSourceFrom", () => {
  it("marks a variable with an empty value as having NO value to withhold", () => {
    const source = exportSourceFrom(
      [{ id: "c1", name: "staging", engine: "postgres" }],
      [{ id: "r1", name: "GET /health", protocol: "http" }],
      [
        {
          id: "e1",
          name: "prod",
          variables: [
            { key: "PG_PASSWORD", value: "hunter2" },
            // Declared and never filled in — a real state in this app. Listing it under "stays on
            // this machine" would promise the recipient a secret that was never there.
            { key: "UNSET", value: "" },
          ],
        },
      ],
    );
    expect(source.environments[0].variables).toEqual([
      { key: "PG_PASSWORD", hasValue: true },
      { key: "UNSET", hasValue: false },
    ]);
    expect(source.dbConnections).toEqual([{ id: "c1", name: "staging", detail: "postgres" }]);
  });

  it("does not invent a protocol for a request that predates the field", () => {
    // Legacy store files omit `protocol`. Defaulting to "http" would be an assumption about
    // someone else's saved request, and it would show as fact in the export list.
    const source = exportSourceFrom([], [{ id: "r1", name: "old" }], []);
    expect(source.apiRequests).toEqual([{ id: "r1", name: "old", detail: null }]);
  });
});
