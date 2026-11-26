/** Project styles close each project's shape with sibling selectors over a flat list; jsdom
 * computes no stylesheet styles. Two projects cover both endings: before a header, and last. */

import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import App from "../../App";
import { useAppStore } from "../../app/store";
import { asAgentId } from "../../app/types";
import { wireAgent } from "../../test/fleet-harness";
import { resetStore } from "../../test/store-harness";
import { installTauriMock, type TauriMock } from "../../test/tauri-mock";
import { disposeAll } from "../terminal";
import type { RailGroupStyle } from "./railGroupStyle";

async function settle(ms = 150): Promise<void> {
  await act(async () => {
    const d = performance.now() + ms;
    while (performance.now() < d) await new Promise<void>((r) => requestAnimationFrame(() => r()));
  });
}

const BIG = "/w/AgentStudioIDE";
const SMALL = "/w/docs-site";
const BIG_AGENTS = 12; // enough to scroll the rail, for the pinned header
const SELECTED = asAgentId("01J0GROUPS0000000000000003");

const BG_APP = "rgb(13, 17, 23)";
const BG_ELEV = "rgb(28, 33, 40)";
const ACCENT_SOFT = "rgba(59, 130, 246, 0.14)";

function mount(style: RailGroupStyle): void {
  act(() => {
    const big = Array.from({ length: BIG_AGENTS }, (_, i) =>
      wireAgent({
        id: asAgentId(`01J0GROUPS00000000000000${String(i).padStart(2, "0")}`),
        title: `big-${i}`,
        cwd: BIG,
        status: i === 1 ? "waiting_input" : "running",
      }),
    );
    const small = ["a", "b"].map((s) =>
      wireAgent({ id: asAgentId(`01J0GROUPS0000000000000SM${s}`), title: `small-${s}`, cwd: SMALL, status: "idle" }),
    );
    const s = useAppStore.getState();
    s.agentActions.applyFleetSnapshot([...big, ...small]);
    s.agentActions.selectAgent(SELECTED);
    s.workspaceActions.setRailGroupStyle(style);
  });
  render(<App />);
}

const tree = () => document.querySelector<HTMLElement>('[data-testid="left-rail"] .fleet-tree')!;
const header = (name: string) =>
  [...tree().querySelectorAll<HTMLElement>("li.folder-group")].find(
    (h) => h.querySelector(".folder-group__name")?.textContent === name,
  )!;
const row = (title: string) =>
  [...tree().querySelectorAll<HTMLElement>("li.fleet-row")].find(
    (r) => r.querySelector(".fleet-row__title")?.textContent === title,
  )!;
const css = (el: Element, pseudo?: string) => getComputedStyle(el, pseudo);
const px = (v: string) => parseFloat(v);

describe("agent rail — project styles", () => {
  let ipc: TauriMock;

  beforeEach(() => {
    resetStore();
    // The store harness leaves the workspace slice alone; one test collapses a project.
    useAppStore.setState((s) => {
      s.collapsedFolders = new Set();
    });
    ipc = installTauriMock();
  });
  afterEach(() => {
    disposeAll();
    ipc.reset();
  });

  it("every style keeps the whole project name, with the counts on a line under it", async () => {
    for (const style of ["card", "well", "divider", "pinned"] as const) {
      mount(style);
      await settle();
      const h = header("AgentStudioIDE");
      const name = h.querySelector<HTMLElement>(".folder-group__name")!;
      const stats = h.querySelector<HTMLElement>(".folder-group__stats")!;
      expect(name.scrollWidth, `${style}: name cut short`).toBeLessThanOrEqual(name.clientWidth);
      expect(stats.getBoundingClientRect().top, `${style}: counts under the name`).toBeGreaterThanOrEqual(
        name.getBoundingClientRect().bottom - 1,
      );
      expect(stats.textContent).toBe("11 running·1 waiting");
      document.body.innerHTML = "";
    }
  });

  it("Framed card: one border around each project, closed under its last agent both ways a project can end", async () => {
    mount("card");
    await settle();
    const h = header("AgentStudioIDE");
    expect(css(h).backgroundColor).toBe(BG_ELEV);
    expect(px(css(h).borderTopWidth)).toBe(1);
    expect(px(css(h).borderTopLeftRadius)).toBe(8);
    expect(css(h.querySelector(".folder-group__mono")!).display).toBe("grid");

    // Sides on every row, a bottom only on a project's last row.
    for (const title of ["big-0", "big-5", "small-a"]) {
      expect(px(css(row(title)).borderLeftWidth), title).toBe(1);
      expect(px(css(row(title)).borderBottomWidth), title).toBe(0);
    }
    for (const last of ["big-11", "small-b"]) {
      expect(px(css(row(last)).borderBottomWidth), last).toBe(1);
      expect(px(css(row(last)).borderBottomLeftRadius), last).toBe(8);
    }
    // The card's edges line up from header to last row.
    const left = h.getBoundingClientRect().left;
    expect(row("big-11").getBoundingClientRect().left).toBe(left);

    // Collapsed, the header alone is the whole card: it closes itself.
    act(() => useAppStore.getState().agentActions.toggleFolderCollapsed(SMALL));
    await settle();
    expect(px(css(header("docs-site")).borderBottomLeftRadius)).toBe(8);
  });

  it("Inset well: agents sit in a darker panel, rounded at the project's first and last rows", async () => {
    mount("well");
    await settle();
    const h = header("AgentStudioIDE");
    expect(css(h.querySelector(".folder-group__icon")!).display).toBe("block");
    expect(css(h.querySelector(".folder-group__mono")!).display).toBe("none");

    expect(css(row("big-5")).backgroundColor).toBe(BG_APP);
    for (const first of ["big-0", "small-a"]) expect(px(css(row(first)).borderTopLeftRadius), first).toBe(8);
    for (const last of ["big-11", "small-b"]) expect(px(css(row(last)).borderBottomLeftRadius), last).toBe(8);
    expect(px(css(row("big-5")).borderTopLeftRadius)).toBe(0);
    expect(px(css(row("big-5")).borderBottomLeftRadius)).toBe(0);
  });

  it("Labelled divider: an uppercase label with a rule running out to the +", async () => {
    mount("divider");
    await settle();
    const h = header("AgentStudioIDE");
    expect(css(h.querySelector(".folder-group__name")!).textTransform).toBe("uppercase");
    const button = h.querySelector(".folder-group__header")!;
    expect(px(css(button, "::after").width)).toBeGreaterThan(20);
    expect(px(css(row("big-0")).marginLeft)).toBe(6);
  });

  it("Pinned header bar: the project's bar stays at the top while its agents scroll — and a card's does not", async () => {
    for (const [style, pinned] of [
      ["pinned", true],
      ["card", false],
    ] as const) {
      mount(style);
      await settle();
      const t = tree();
      expect(t.scrollHeight, "the rail must be able to scroll").toBeGreaterThan(t.clientHeight + 200);
      t.scrollTop = 200;
      await settle(50);
      const offset = header("AgentStudioIDE").getBoundingClientRect().top - t.getBoundingClientRect().top;
      if (pinned) expect(Math.abs(offset), "stuck to the top").toBeLessThanOrEqual(1);
      else expect(offset, "scrolled away with its rows").toBeLessThan(-100);
      document.body.innerHTML = "";
    }
  });

  it("the selected agent keeps its accent in every style", async () => {
    for (const style of ["card", "well", "divider", "pinned"] as const) {
      mount(style);
      await settle();
      const selected = tree().querySelector<HTMLElement>(".fleet-row--selected")!;
      expect(css(selected).backgroundColor, style).toBe(ACCENT_SOFT);
      expect(css(selected).boxShadow, style).toContain("rgb(59, 130, 246)");
      document.body.innerHTML = "";
    }
  });

  it("🔴 choosing a style in Settings → Interface restyles the rail", async () => {
    mount("card");
    await settle();
    const click = async (el: Element | null) => {
      act(() => (el as HTMLElement).click());
      await settle(30);
    };
    await click(document.querySelector('[aria-label="Settings"]'));
    await click(document.querySelector('[data-testid="settings-interface"]'));
    await click(document.querySelector('[data-testid="rail-group-style-well"]'));

    expect(tree()).toHaveClass("fleet-tree--groups-well");
    expect(css(row("big-5")).backgroundColor).toBe(BG_APP);
  });
});
