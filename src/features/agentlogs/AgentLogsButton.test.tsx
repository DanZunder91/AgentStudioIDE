/**
 * The titlebar button calls `openAgentLogsTab` — asserted from the button, not the
 * store, by the store change it causes.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(undefined)) }));

import { useAppStore } from "../../app/store";
import { resetStore } from "../../test/store-harness";
import { AgentLogsButton } from "./AgentLogsButton";

beforeEach(() => resetStore());

it("opens the singleton agent-logs tab", () => {
  render(<AgentLogsButton />);
  const kinds = () => Object.values(useAppStore.getState().tabs).map((t) => t.ref.kind);
  expect(kinds()).not.toContain("agent-logs");
  fireEvent.click(screen.getByRole("button", { name: "Agent logs" }));
  fireEvent.click(screen.getByRole("button", { name: "Agent logs" }));
  expect(kinds().filter((k) => k === "agent-logs")).toHaveLength(1);
});
