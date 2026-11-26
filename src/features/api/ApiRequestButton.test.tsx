/** The titlebar button drives one store action; the tab it creates is what is under test. */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useAppStore } from "../../app/store";
import type { Tab } from "../../app/types";
import { resetStore } from "../../test/store-harness";
import { ApiRequestButton } from "./ApiRequestButton";

const apiTabs = (): Tab[] =>
  Object.values(useAppStore.getState().tabs).filter((t) => t.ref.kind === "api-request");

beforeEach(() => resetStore());
afterEach(() => cleanup());

describe("ApiRequestButton", () => {
  it("opens a new, active API request tab on click", () => {
    render(<ApiRequestButton />);
    expect(apiTabs()).toHaveLength(0);

    fireEvent.click(screen.getByLabelText("New API request"));

    const tabs = apiTabs();
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({ kind: "api-request", title: "New request" });
    // The tab references a request that now exists in the api slice.
    const ref = tabs[0].ref;
    expect(ref.kind).toBe("api-request");
    if (ref.kind === "api-request") {
      expect(useAppStore.getState().apiRequests[ref.requestId]).toBeDefined();
    }
  });
});
