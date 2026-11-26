/** Real-browser tier setup; deliberately not `setup.ts`, whose jsdom shims (the no-op
 * `ResizeObserver` above all) would hide the layout bugs this tier exists to catch. Only RTL
 * teardown is shared. */

import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// <App/> mounts <CloseTabShortcut>: a real `listen()`/`unlisten()` lands after the IPC mock's
// teardown and fails the tier with unhandled rejections. Inert no-ops decouple the two; a test
// that drives events can `vi.mock` this module itself.
vi.mock("@tauri-apps/api/event", () => ({
  listen: () => Promise.resolve(() => {}),
  once: () => Promise.resolve(() => {}),
  emit: () => Promise.resolve(),
  emitTo: () => Promise.resolve(),
  TauriEvent: {},
}));

afterEach(() => {
  cleanup();
});
