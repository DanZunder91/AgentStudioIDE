import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiStoreIpc = vi.hoisted(() => ({ loadApiStore: vi.fn(), saveApiStore: vi.fn() }));
vi.mock("./apiStoreIpc", () => apiStoreIpc);

import { useAppStore } from "../../app/store";
import { resetStore } from "../../test/store-harness";
import { VaultPanel } from "./VaultPanel";
import type { ApiStore } from "./apiStoreIpc";

const emptyStore: ApiStore = { collections: [], environments: [], activeEnvironmentId: null, folders: [] };

const envs = () => useAppStore.getState().apiEnvironments;

beforeEach(() => {
  resetStore();
  apiStoreIpc.loadApiStore.mockReset().mockResolvedValue(emptyStore);
  apiStoreIpc.saveApiStore.mockReset().mockResolvedValue(undefined);
});

afterEach(() => cleanup());

describe("VaultPanel — hydration on mount", () => {
  it("loads the durable store once on mount and paints its environments + secure note", async () => {
    apiStoreIpc.loadApiStore.mockResolvedValue({
      collections: [],
      environments: [{ id: "e1", name: "prod", variables: [{ key: "TOKEN", value: "s3cr3t" }] }],
      activeEnvironmentId: null,
      folders: [],
    });
    await act(async () => {
      render(<VaultPanel />);
    });

    expect(apiStoreIpc.loadApiStore).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().apiStoreLoaded).toBe(true);
    expect(screen.getByTestId("vault-panel")).toBeInTheDocument();
    // The calm secure-storage note.
    expect(screen.getByText(/stored securely in the/i)).toBeInTheDocument();
    // The seeded env + its variable painted.
    expect(within(screen.getByTestId("vault-env")).getByDisplayValue("prod")).toBeInTheDocument();
    expect(screen.getByText("TOKEN")).toBeInTheDocument();
  });

  it("skips the load when the store is already loaded", async () => {
    act(() => useAppStore.getState().apiActions.hydrateApiStore(emptyStore)); // marks loaded
    render(<VaultPanel />);
    await act(async () => {});
    expect(apiStoreIpc.loadApiStore).not.toHaveBeenCalled();
    expect(screen.getByText("No environments")).toBeInTheDocument();
  });

  it("drops a load that resolves after unmount (the cancelled guard)", async () => {
    let resolveLoad!: (s: ApiStore) => void;
    apiStoreIpc.loadApiStore.mockReturnValue(new Promise<ApiStore>((r) => (resolveLoad = r)));
    const { unmount } = render(<VaultPanel />);
    unmount(); // effect cleanup sets cancelled = true

    await act(async () => {
      resolveLoad({
        collections: [],
        environments: [{ id: "late", name: "late", variables: [] }],
        activeEnvironmentId: null,
        folders: [],
      });
    });
    // The late resolve is dropped — the store was never hydrated.
    expect(useAppStore.getState().apiStoreLoaded).toBe(false);
    expect(envs()).toEqual([]);
  });
});

describe("VaultPanel — environment + variable CRUD", () => {
  /** Render with the store already loaded so the mount effect short-circuits. */
  function setup(seed: ApiStore = emptyStore): void {
    act(() => useAppStore.getState().apiActions.hydrateApiStore(seed));
    render(<VaultPanel />);
  }

  it("adds, renames, and deletes an environment", () => {
    setup();
    expect(screen.getByText("No environments")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("vault-add-env"));
    expect(envs()).toHaveLength(1);
    expect(envs()[0].name).toBe("New environment");

    fireEvent.change(screen.getByLabelText("Environment name"), { target: { value: "prod" } });
    expect(envs()[0].name).toBe("prod");

    fireEvent.click(screen.getByLabelText("Delete environment prod"));
    expect(envs()).toEqual([]);
    expect(screen.getByText("No environments")).toBeInTheDocument();
  });

  it("adds a variable (button disabled until a key is typed), edits its value, and removes it", () => {
    setup({
      collections: [],
      environments: [{ id: "e1", name: "prod", variables: [] }],
      activeEnvironmentId: null,
      folders: [],
    });

    // The add-var button is disabled until a key is present.
    expect(screen.getByLabelText("Add variable")).toBeDisabled();
    fireEvent.change(screen.getByLabelText("New variable key"), { target: { value: "TOKEN" } });
    fireEvent.change(screen.getByLabelText("New variable value"), { target: { value: "s3cr3t" } });
    expect(screen.getByLabelText("Add variable")).toBeEnabled();
    fireEvent.click(screen.getByLabelText("Add variable"));
    expect(envs()[0].variables).toEqual([{ key: "TOKEN", value: "s3cr3t" }]);

    // Edit the value in place, then remove the variable.
    fireEvent.change(screen.getByLabelText("Value of TOKEN"), { target: { value: "rotated" } });
    expect(envs()[0].variables[0].value).toBe("rotated");
    fireEvent.click(screen.getByLabelText("Remove TOKEN"));
    expect(envs()[0].variables).toEqual([]);
  });
});
