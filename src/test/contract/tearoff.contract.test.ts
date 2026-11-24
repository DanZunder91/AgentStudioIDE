/**
 * The TS half of the tab tear-off contract — `goldens/tearoff.json` was WRITTEN BY RUST
 * (`src-tauri/tests/tearoff_contract.rs`) from the real registry and `TornTab::key`, and
 * Rust proves it reads every value back byte for byte. This file proves the page agrees:
 *
 *  - `tabKey` derives the key Rust derived, for every kind;
 *  - every object carries EXACTLY the fields the TS types name (hand-written tables,
 *    never read off the code under test), so a field added on one side only is red;
 *  - the golden's tabs go through the real ADOPTER, and the real DESCRIBER gives back the
 *    very objects Rust wrote — the page produces what Rust consumes, and vice versa.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../features/terminal", () => ({
  configureTerminal: vi.fn(),
  dispose: vi.fn(),
  setDefaultTerminalCwd: vi.fn(),
}));
vi.mock("../../features/terminal/TerminalRegistry", () => ({ abandon: vi.fn() }));
const editorRegistry = vi.hoisted(() => ({
  exportEditor: vi.fn(),
  seedEditor: vi.fn(),
  abandon: vi.fn(),
}));
vi.mock("../../features/editor/EditorRegistry", () => editorRegistry);
vi.mock("../../features/editor", () => ({ disposeEditorBuffer: vi.fn() }));

import { useAppStore } from "../../app/store";
import {
  tabKey,
  TEAROFF_KINDS,
  type Claim,
  type EditorBuffer,
  type Holding,
  type Mail,
  type TornTab,
} from "../../app/tearoff/contract";
import { adoptTornTabs, describeTab, findTabByKey, handleMail } from "../../app/tearoff/handoff";
import { resetFleetStore } from "../fleet-harness";
import { resetStore } from "../store-harness";
import golden from "./goldens/tearoff.json";

interface Golden {
  tabs: { tab: TornTab; key: string }[];
  mail: Mail[];
  claim: Claim;
  holdings: Holding[];
}
const G = golden as unknown as Golden;

/** Every field each kind carries, by hand. A kind missing here is a compile error. */
const TAB_FIELDS: Record<TornTab["kind"], string[]> = {
  terminal: ["kind", "terminalId", "title", "customTitle"],
  "agent-terminal": ["kind", "terminalId", "agentId", "title", "customTitle"],
  editor: ["kind", "path", "title", "customTitle", "buffer"],
  diff: ["kind", "path", "title"],
  metrics: ["kind", "cwd"],
  "agent-logs": ["kind"],
  network: ["kind"],
  village: ["kind"],
};
const BUFFER_FIELDS: (keyof EditorBuffer)[] = ["text", "baseline", "state", "stamp", "stale"];
const MAIL_FIELDS: Record<Mail["t"], string[]> = {
  adopt: ["t", "tabs"],
  focus: ["t", "key"],
  close: ["t", "key"],
  dismissed: ["t", "agentId"],
  give: ["t", "tabId", "to"],
  renamed: ["t", "agentId", "name"],
};

const sorted = (o: object) => Object.keys(o).sort();

beforeEach(() => {
  resetStore();
  resetFleetStore();
  vi.clearAllMocks();
});

describe("tearoff golden ↔ contract.ts", () => {
  it("covers every kind that can move, and no other", () => {
    expect(new Set(G.tabs.map((t) => t.tab.kind))).toEqual(new Set(TEAROFF_KINDS));
  });

  it("tabKey derives the key Rust derived, for every tab", () => {
    for (const { tab, key } of G.tabs) expect(tabKey(tab), tab.kind).toBe(key);
  });

  it("every tab carries exactly the fields its kind names", () => {
    for (const { tab } of G.tabs) {
      expect(sorted(tab), tab.kind).toEqual([...TAB_FIELDS[tab.kind]].sort());
      if (tab.kind === "editor" && tab.buffer) {
        expect(sorted(tab.buffer)).toEqual([...BUFFER_FIELDS].sort());
        expect(sorted(tab.buffer.stamp as object)).toEqual(["mtimeMs", "size"]);
        // The CodeMirror state crosses as a STRING — Rust never parses (re-orders) it.
        expect(typeof tab.buffer.state).toBe("string");
      }
    }
    // Both shapes of an optional buffer are in the golden.
    const buffers = G.tabs.flatMap((t) => (t.tab.kind === "editor" ? [t.tab.buffer] : []));
    expect(buffers.some((b) => b === null)).toBe(true);
    expect(buffers.some((b) => b !== null)).toBe(true);
  });

  it("every mail carries exactly its fields, and every kind of mail is there", () => {
    expect(new Set(G.mail.map((m) => m.t))).toEqual(new Set(Object.keys(MAIL_FIELDS)));
    for (const m of G.mail) expect(sorted(m), m.t).toEqual([...MAIL_FIELDS[m.t]].sort());
  });

  it("a claim and the holdings have exactly their fields", () => {
    expect(sorted(G.claim)).toEqual(["mail", "tabs"]);
    for (const h of G.holdings) expect(sorted(h)).toEqual(["keys", "label"]);
    expect(G.holdings[0].keys).toEqual(G.claim.tabs.map(tabKey));
  });

  it("the page adopts Rust's tabs, and describes them back to exactly what Rust wrote", () => {
    const bufferOf = new Map(
      G.tabs.flatMap(({ tab }) => (tab.kind === "editor" ? [[tab.path, tab.buffer] as const] : [])),
    );
    editorRegistry.exportEditor.mockImplementation((path: string) => bufferOf.get(path) ?? null);

    const ids = adoptTornTabs(G.tabs.map((t) => t.tab));
    expect(ids).toHaveLength(G.tabs.length);
    expect(ids.map((id) => describeTab(id))).toEqual(G.tabs.map((t) => t.tab));
    // The buffer was seeded for the editor that had one, and only that one.
    expect(editorRegistry.seedEditor.mock.calls.map((c) => c[0])).toEqual(["/Users/me/gazelle/src/main.rs"]);
  });

  it("the page acts on every kind of mail Rust can hand it", () => {
    for (const m of G.mail) expect(() => handleMail(m), m.t).not.toThrow();
    expect(findTabByKey(useAppStore.getState().tabs, "village")).not.toBeNull();
  });
});
