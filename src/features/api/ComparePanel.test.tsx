/** jsdom tier: every render state and store write, seeded via the REAL store actions; layout
 * claims live in `compare.browser.test.tsx`. The `scrollIntoView` spy is REMOVED after each
 * test so others keep exercising jsdom's undefined branch. */

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAppStore } from "../../app/store";
import { resetStore } from "../../test/store-harness";
import { CompareBar, ComparePanel } from "./ComparePanel";
import type { HttpResponse } from "./httpIpc";

const api = () => useAppStore.getState().apiActions;
const compareOf = (id: string) =>
  useAppStore.getState().apiRequests[id].compare;

const response = (over: Partial<HttpResponse> = {}): HttpResponse => ({
  status: 200,
  statusText: "OK",
  headers: [{ name: "content-type", value: "application/json" }],
  body: '{"ok":true}',
  durationMs: 42,
  sizeBytes: 128,
  truncated: false,
  ...over,
});

const jsonResponse = (
  value: unknown,
  over: Partial<HttpResponse> = {},
): HttpResponse => response({ body: JSON.stringify(value), ...over });

/** A request with compare on and B's bar filled in — the panel's home state. */
function seed(): string {
  const id = api().createApiRequest();
  api().patchApiRequest(id, { method: "GET", url: "https://a.test/one" });
  api().setCompareEnabled(id, true);
  api().patchCompare(id, { method: "POST", url: "https://b.test/two" });
  return id;
}

const pane = (side: "a" | "b") => screen.getByTestId(`compare-pane-${side}`);
const body = (side: "a" | "b") => screen.getByTestId(`compare-body-${side}`);
/** Every key element in DOM order — the rendered key ORDER is the sort claim. */
const keysIn = (el: HTMLElement) =>
  Array.from(el.querySelectorAll("[data-key]")).map((k) =>
    k.getAttribute("data-key"),
  );
const selectedIn = (el: HTMLElement) =>
  el.querySelectorAll('[data-selected="true"]');
/** The clickable key button for `name` inside one pane's body. */
function keyButton(side: "a" | "b", name: string): HTMLElement {
  const btn = within(body(side))
    .getAllByTestId("json-key")
    .find((b) => b.getAttribute("data-key") === name);
  if (!btn) throw new Error(`no key "${name}" in pane ${side}`);
  return btn;
}

beforeEach(() => {
  resetStore();
});

describe("ComparePanel", () => {
  it("renders each side's own status pill, stats and method+url echo", () => {
    const id = seed();
    api().setCompareResponse(id, "a", jsonResponse({ ok: true }));
    api().setCompareResponse(
      id,
      "b",
      jsonResponse(
        { ok: false },
        {
          status: 404,
          statusText: "Not Found",
          durationMs: 7,
          sizeBytes: 2048,
          truncated: true,
        },
      ),
    );
    render(<ComparePanel requestId={id} />);

    const statusA = screen.getByTestId("compare-status-a");
    expect(statusA).toHaveTextContent("200");
    expect(statusA.className).toContain("api-status--2xx");
    const statusB = screen.getByTestId("compare-status-b");
    expect(statusB).toHaveTextContent("404");
    expect(statusB.className).toContain("api-status--4xx");

    // A's head echoes the request's own method/url; B's echoes compare's.
    expect(within(pane("a")).getByText("GET")).toBeInTheDocument();
    expect(within(pane("a")).getByTitle("https://a.test/one")).toHaveTextContent(
      "https://a.test/one",
    );
    expect(within(pane("b")).getByText("POST")).toBeInTheDocument();
    expect(within(pane("b")).getByTitle("https://b.test/two")).toHaveTextContent(
      "https://b.test/two",
    );

    expect(within(pane("a")).getByText("42 ms")).toBeInTheDocument();
    expect(within(pane("a")).getByText("128 B")).toBeInTheDocument();
    expect(within(pane("b")).getByText("7 ms")).toBeInTheDocument();
    expect(within(pane("b")).getByText("2.0 KB")).toBeInTheDocument();

    // The truncated badge appears exactly where `truncated` is set.
    expect(screen.getByTestId("compare-truncated-b")).toHaveTextContent(
      "truncated",
    );
    expect(screen.queryByTestId("compare-truncated-a")).toBeNull();
  });

  it("clicking a key in ONE pane marks every occurrence in BOTH panes; same key or chip clears", () => {
    const id = seed();
    api().setCompareResponse(
      id,
      "a",
      jsonResponse({ name: "alpha", nested: { name: "inner" } }),
    );
    api().setCompareResponse(id, "b", jsonResponse({ name: "beta", other: 1 }));
    render(<ComparePanel requestId={id} />);
    expect(screen.queryByTestId("compare-selected")).toBeNull();

    fireEvent.click(keyButton("a", "name"));
    expect(compareOf(id).selectedKey).toBe("name");
    // Every occurrence of the NAME, at any depth, in BOTH panes.
    expect(selectedIn(body("a"))).toHaveLength(2);
    expect(selectedIn(body("b"))).toHaveLength(1);
    for (const el of [...selectedIn(body("a")), ...selectedIn(body("b"))]) {
      expect(el.getAttribute("data-key")).toBe("name");
    }
    const chip = screen.getByTestId("compare-selected");
    expect(chip).toHaveTextContent("name");

    // The chip clears everything…
    fireEvent.click(chip);
    expect(compareOf(id).selectedKey).toBeNull();
    expect(screen.queryByTestId("compare-selected")).toBeNull();
    expect(selectedIn(body("a"))).toHaveLength(0);
    expect(selectedIn(body("b"))).toHaveLength(0);

    // …and so does clicking the SAME key again — from EITHER pane.
    fireEvent.click(keyButton("b", "name"));
    expect(compareOf(id).selectedKey).toBe("name");
    fireEvent.click(keyButton("a", "name"));
    expect(compareOf(id).selectedKey).toBeNull();
    expect(selectedIn(body("a"))).toHaveLength(0);
  });

  it("Sort keys reorders BOTH trees recursively, tracks aria-pressed, and toggles back", () => {
    const id = seed();
    const unsorted = { z: 1, a: { y: 2, b: 3 } };
    api().setCompareResponse(id, "a", jsonResponse(unsorted));
    api().setCompareResponse(id, "b", jsonResponse(unsorted));
    render(<ComparePanel requestId={id} />);

    const sort = screen.getByTestId("compare-sort");
    expect(sort).toHaveAttribute("aria-pressed", "false");
    // Wire order: z first, then a with its children y, b.
    expect(keysIn(body("a"))).toEqual(["z", "a", "y", "b"]);
    expect(keysIn(body("b"))).toEqual(["z", "a", "y", "b"]);

    fireEvent.click(sort);
    expect(sort).toHaveAttribute("aria-pressed", "true");
    expect(compareOf(id).sortKeys).toBe(true);
    // Sorted at every depth: a (with b, y inside) before z.
    expect(keysIn(body("a"))).toEqual(["a", "b", "y", "z"]);
    expect(keysIn(body("b"))).toEqual(["a", "b", "y", "z"]);

    // Off restores the wire order exactly — the sort never mutated the value.
    fireEvent.click(sort);
    expect(sort).toHaveAttribute("aria-pressed", "false");
    expect(keysIn(body("a"))).toEqual(["z", "a", "y", "b"]);
  });

  it("renders one side's error as an alert while the other side keeps its tree", () => {
    const id = seed();
    api().setCompareResponse(id, "a", jsonResponse({ name: "x" }));
    api().setCompareError(id, "b", "dns exploded");
    render(<ComparePanel requestId={id} />);

    const err = screen.getByTestId("compare-error-b");
    expect(err).toHaveTextContent("dns exploded");
    expect(within(body("b")).getByRole("alert")).toBe(err);
    expect(within(body("b")).queryByTestId("json-view")).toBeNull();
    expect(within(body("a")).getByTestId("json-view")).toBeInTheDocument();
    // No status pill on a side that never landed a response.
    expect(screen.queryByTestId("compare-status-b")).toBeNull();

    // Selecting a key still works; the error pane simply has no occurrence to
    // mark or scroll to (the effect's `el` is null there).
    fireEvent.click(keyButton("a", "name"));
    expect(compareOf(id).selectedKey).toBe("name");
    expect(selectedIn(body("a"))).toHaveLength(1);
    expect(selectedIn(body("b"))).toHaveLength(0);
  });

  it("shows 'No response yet' idle and 'Sending…' in flight, per side", () => {
    const id = seed();
    render(<ComparePanel requestId={id} />);
    expect(screen.getByTestId("compare-empty-a")).toHaveTextContent(
      "No response yet",
    );
    expect(screen.getByTestId("compare-empty-b")).toHaveTextContent(
      "No response yet",
    );
    act(() => api().setCompareSending(id, true));
    expect(screen.getByTestId("compare-empty-a")).toHaveTextContent("Sending…");
    expect(screen.getByTestId("compare-empty-b")).toHaveTextContent("Sending…");
  });

  it("renders a non-JSON body as a raw <pre>, not a tree", () => {
    const id = seed();
    api().setCompareResponse(
      id,
      "a",
      response({
        headers: [{ name: "content-type", value: "text/plain" }],
        body: "plain text\nline two",
      }),
    );
    api().setCompareResponse(id, "b", jsonResponse({ ok: 1 }));
    render(<ComparePanel requestId={id} />);

    const pre = body("a").querySelector("pre");
    expect(pre).not.toBeNull();
    expect(pre).toHaveTextContent("plain text");
    expect(within(body("a")).queryByTestId("json-view")).toBeNull();
    expect(within(body("b")).getByTestId("json-view")).toBeInTheDocument();
  });

  it("scrolls each pane's first occurrence into view when a key is selected", () => {
    const id = seed();
    api().setCompareResponse(id, "a", jsonResponse({ name: "x", zz: 1 }));
    api().setCompareResponse(id, "b", jsonResponse({ name: "y" }));
    // jsdom has no scrollIntoView — DEFINE it as a spy (the component's `?.`
    // exists for the undefined case, which every other test still covers).
    const spy = vi.fn();
    Element.prototype.scrollIntoView = spy;
    render(<ComparePanel requestId={id} />);
    // No selection yet → the effect returned before querying anything.
    expect(spy).not.toHaveBeenCalled();

    fireEvent.click(keyButton("a", "name"));
    // Both panes hold the key, so both scrolled their first occurrence.
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenCalledWith({ block: "nearest" });
  });

  it("renders null for an unknown requestId", () => {
    const { container } = render(<ComparePanel requestId="ghost" />);
    expect(container.firstChild).toBeNull();
  });
});

/** Find and Copy hold on BOTH panes, in Raw and in the tree view. */
describe("ComparePanel — Raw/Formatted, Find and Copy on both sides", () => {
  const bothSides = ["a", "b"] as const;

  function seedJson(): string {
    const id = seed();
    api().setCompareResponse(id, "a", jsonResponse({ name: "alpha" }));
    api().setCompareResponse(id, "b", jsonResponse({ name: "beta" }));
    return id;
  }

  it("gives EVERY pane the same three tools, over a JSON body", () => {
    render(<ComparePanel requestId={seedJson()} />);
    for (const side of bothSides) {
      const pane = within(body(side));
      // The tree is what is on screen…
      expect(pane.getByTestId("json-view")).toBeInTheDocument();
      // …and the tools are there anyway, in the same order on both sides.
      expect(pane.getByTestId("response-view-toggle")).toHaveTextContent("Raw");
      expect(pane.getByTestId("response-find-toggle")).toBeInTheDocument();
      expect(pane.getByTestId("response-copy")).toBeInTheDocument();
    }
    // Still named per side, so two Copy buttons are tellable apart by name.
    expect(screen.getByLabelText("Copy response A")).toBeInTheDocument();
    expect(screen.getByLabelText("Copy response B")).toBeInTheDocument();
  });

  it("each pane's Copy writes ITS OWN raw body, in either view", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    // After setup().
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<ComparePanel requestId={seedJson()} />);

    // From the FORMATTED view (the default for JSON).
    await user.click(within(body("a")).getByTestId("response-copy"));
    // And from the RAW view of the other pane.
    await user.click(within(body("b")).getByTestId("response-view-toggle"));
    await user.click(within(body("b")).getByTestId("response-copy"));

    const a = JSON.stringify({ name: "alpha" }, null, 2);
    const b = JSON.stringify({ name: "beta" }, null, 2);
    expect(writeText).toHaveBeenNthCalledWith(1, a);
    expect(writeText).toHaveBeenNthCalledWith(2, b);
    // Two-sided: B's Copy did NOT copy A's body (the bug a shared component
    // makes easy — one `text`, two panes).
    expect(a).not.toBe(b);
  });

  it("searches inside one pane's tree without touching the other", async () => {
    const user = userEvent.setup();
    render(<ComparePanel requestId={seedJson()} />);

    await user.click(within(body("a")).getByTestId("response-find-toggle"));
    await user.type(within(body("a")).getByTestId("response-find-input"), "alpha");
    const hit = within(body("a")).getByTestId("response-find-current");
    expect(hit).toHaveTextContent("alpha");
    expect(hit.closest('[data-testid="json-view"]')).not.toBeNull();
    expect(within(body("a")).getByTestId("response-find-count")).toHaveTextContent("1/1");

    // Pane B never opened a bar and has no marks — the panes are independent.
    expect(within(body("b")).queryByTestId("response-find")).toBeNull();
    expect(within(body("b")).queryByTestId("response-find-current")).toBeNull();
  });

  it("flips one pane to Raw while the other stays Formatted", async () => {
    const user = userEvent.setup();
    render(<ComparePanel requestId={seedJson()} />);
    await user.click(within(body("a")).getByTestId("response-view-toggle"));

    expect(within(body("a")).queryByTestId("json-view")).toBeNull();
    expect(body("a").querySelector("pre")).toHaveTextContent('"name": "alpha"');
    expect(within(body("a")).getByTestId("response-view-toggle")).toHaveTextContent(
      "Formatted",
    );
    // B is untouched.
    expect(within(body("b")).getByTestId("json-view")).toBeInTheDocument();
  });

  it("still cross-highlights a selected key while a search is marking the same tree", async () => {
    const user = userEvent.setup();
    const id = seedJson();
    render(<ComparePanel requestId={id} />);

    await user.click(within(body("a")).getByTestId("response-find-toggle"));
    await user.type(within(body("a")).getByTestId("response-find-input"), "am");
    // The `name` key carries a search mark…
    const hit = within(body("a")).getByTestId("response-find-current");
    expect(hit.closest("[data-key]")?.getAttribute("data-key")).toBe("name");

    // …and clicking it still selects, in BOTH panes. The two highlights are
    // independent: one is a `<mark>` inside the button, the other is the
    // button's own `data-selected`.
    fireEvent.click(keyButton("a", "name"));
    expect(compareOf(id).selectedKey).toBe("name");
    expect(selectedIn(body("a"))).toHaveLength(1);
    expect(selectedIn(body("b"))).toHaveLength(1);
    expect(within(body("a")).getByTestId("response-find-current")).toHaveTextContent("am");
  });
});

describe("CompareBar", () => {
  it("edits patch the store's compare method/url and the hint is honest", () => {
    const id = seed();
    render(<CompareBar requestId={id} onSend={() => {}} />);

    const bar = screen.getByTestId("compare-bar");
    expect(bar.className).toContain("api-bar");

    const method = screen.getByLabelText("Request B method");
    expect((method as HTMLSelectElement).value).toBe("POST");
    fireEvent.change(method, { target: { value: "DELETE" } });
    expect(compareOf(id).method).toBe("DELETE");

    const url = screen.getByLabelText("Request B URL");
    expect((url as HTMLInputElement).value).toBe("https://b.test/two");
    fireEvent.change(url, { target: { value: "https://b.test/other" } });
    expect(compareOf(id).url).toBe("https://b.test/other");

    expect(screen.getByText("same headers & body as A")).toBeInTheDocument();
  });

  it("Cmd/Ctrl+Enter in the URL input sends; plain Enter and Cmd+other do not", () => {
    const id = seed();
    const onSend = vi.fn();
    render(<CompareBar requestId={id} onSend={onSend} />);
    const url = screen.getByLabelText("Request B URL");

    fireEvent.keyDown(url, { key: "Enter", metaKey: true });
    expect(onSend).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(url, { key: "Enter", ctrlKey: true });
    expect(onSend).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(url, { key: "Enter" });
    expect(onSend).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(url, { key: "k", metaKey: true });
    expect(onSend).toHaveBeenCalledTimes(2);
  });

  it("renders null for an unknown requestId", () => {
    const { container } = render(
      <CompareBar requestId="ghost" onSend={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });
});

afterEach(() => {
  // Remove the auto-scroll test's spy so jsdom goes back to NOT having
  // scrollIntoView — the state every other test (and the component's `?.`)
  // is written against.
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

/** Each SIDE keeps its own bar at `findBars["compare:<requestId>:<side>"]`, surviving a tab
 * switch without sharing state; unmount + remount IS the tab switch. */
describe("ComparePanel — the find bar survives a tab switch", () => {
  const inA = () => within(body("a"));
  const inB = () => within(body("b"));

  /** Compare on, both sides landed with the same two-match JSON body. */
  function seedBothSides(): string {
    const id = seed();
    api().setCompareResponse(id, "a", jsonResponse({ alpha: "beta", gamma: "beta-2" }));
    api().setCompareResponse(id, "b", jsonResponse({ alpha: "beta", gamma: "beta-2" }));
    return id;
  }

  it("keeps side A's bar, query, view and cursor across unmount/remount — and B stays closed", () => {
    const id = seedBothSides();
    const first = render(<ComparePanel requestId={id} />);

    fireEvent.click(inA().getByTestId("response-find-toggle"));
    fireEvent.change(inA().getByTestId("response-find-input"), {
      target: { value: "beta" },
    });
    fireEvent.click(inA().getByTestId("response-find-next")); // walk to match 2
    fireEvent.click(inA().getByTestId("response-view-toggle")); // Formatted → Raw
    expect(inA().getByTestId("response-find-count")).toHaveTextContent("2/2");
    // Two-sided from the start: B's bar never opened — `:a` and `:b` are
    // different keys, so nothing can bleed across the split.
    expect(inB().queryByTestId("response-find")).toBeNull();

    first.unmount(); // the tab switch: Pane drops the inactive tab's subtree
    render(<ComparePanel requestId={id} />);

    expect(inA().getByTestId("response-find")).toBeInTheDocument();
    expect(inA().getByTestId("response-find-input")).toHaveValue("beta");
    // Still the RAW view (the toggle names the view you switch TO)…
    expect(inA().getByTestId("response-view-toggle")).toHaveTextContent("Formatted");
    expect(inA().queryByTestId("json-view")).toBeNull();
    // …still standing on match 2, and B is STILL closed on its default view.
    expect(inA().getByTestId("response-find-count")).toHaveTextContent("2/2");
    expect(inB().queryByTestId("response-find")).toBeNull();
    expect(inB().getByTestId("json-view")).toBeInTheDocument();
  });

  it("the two sides hold two independent bars at once", () => {
    const id = seedBothSides();
    render(<ComparePanel requestId={id} />);

    fireEvent.click(inA().getByTestId("response-find-toggle"));
    fireEvent.change(inA().getByTestId("response-find-input"), {
      target: { value: "beta" },
    });
    fireEvent.click(inB().getByTestId("response-find-toggle"));
    fireEvent.change(inB().getByTestId("response-find-input"), {
      target: { value: "alpha" },
    });

    // Each side reads back its OWN query — the store keys them apart.
    expect(inA().getByTestId("response-find-input")).toHaveValue("beta");
    expect(inB().getByTestId("response-find-input")).toHaveValue("alpha");
    const bars = useAppStore.getState().findBars;
    expect(bars[`compare:${id}:a`]).toMatchObject({ open: true, query: "beta" });
    expect(bars[`compare:${id}:b`]).toMatchObject({ open: true, query: "alpha" });
  });

  it("Esc in one pane drops only THAT side's record", () => {
    const id = seedBothSides();
    render(<ComparePanel requestId={id} />);
    fireEvent.click(inA().getByTestId("response-find-toggle"));
    fireEvent.change(inA().getByTestId("response-find-input"), {
      target: { value: "beta" },
    });
    fireEvent.click(inB().getByTestId("response-find-toggle"));
    fireEvent.change(inB().getByTestId("response-find-input"), {
      target: { value: "alpha" },
    });

    fireEvent.keyDown(inA().getByTestId("response-find-input"), { key: "Escape" });

    // A's record is GONE (absence is the closed state); B's is untouched.
    expect(useAppStore.getState().findBars[`compare:${id}:a`]).toBeUndefined();
    expect(useAppStore.getState().findBars[`compare:${id}:b`]).toMatchObject({
      open: true,
      query: "alpha",
    });
    expect(inA().queryByTestId("response-find")).toBeNull();
    expect(inB().getByTestId("response-find")).toBeInTheDocument();
  });
});

/* ═══════════════ Cmd/Ctrl+F seeds from the selection, per SIDE ═══════════════ */

/** One document selection, two bodies: Cmd+F over B must not seed from A's selection
 * (`domSelectionSeed` containment). Store tests can't see it; both sides share `patchFindBar`. */
describe("ComparePanel — Cmd/Ctrl+F seeds from the selection, per side", () => {
  const inA = () => within(body("a"));
  const inB = () => within(body("b"));

  afterEach(() => window.getSelection()?.removeAllRanges());

  /** Compare on, each side landed with its own distinguishable body. */
  function seedBothSides(): string {
    const id = seed();
    api().setCompareResponse(id, "a", jsonResponse({ name: "alpha" }));
    api().setCompareResponse(id, "b", jsonResponse({ name: "beta" }));
    return id;
  }

  /** The focusable `.response-body` box of one side. */
  const boxOf = (side: "a" | "b"): HTMLElement =>
    body(side).querySelector(".response-body") as HTMLElement;

  /** Select the first occurrence of `text` inside one side's box. */
  function selectIn(side: "a" | "b", text: string): void {
    const walker = document.createTreeWalker(boxOf(side), NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const at = (node.textContent ?? "").indexOf(text);
      if (at === -1) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + text.length);
      const selection = window.getSelection() as Selection;
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    throw new Error(`no text node in side ${side} contains ${JSON.stringify(text)}`);
  }

  it("seeds the side the key was pressed in, and searches there", () => {
    const id = seedBothSides();
    render(<ComparePanel requestId={id} />);

    // Focus FIRST, then select: jsdom's `focus()` collapses the document
    // selection (no real browser does that for a non-editable element), and the
    // real gesture is mousedown-then-drag anyway.
    boxOf("a").focus();
    selectIn("a", "alpha");
    fireEvent.keyDown(boxOf("a"), { key: "f", metaKey: true });

    expect(inA().getByTestId("response-find-input")).toHaveValue("alpha");
    expect(inA().getByTestId("response-find-count")).toHaveTextContent("1/1");
    expect(inA().getByTestId("response-find-current")).toHaveTextContent("alpha");
    expect(useAppStore.getState().findBars[`compare:${id}:a`]).toMatchObject({
      open: true,
      query: "alpha",
    });
    // B never opened, and certainly never took A's text.
    expect(inB().queryByTestId("response-find")).toBeNull();
    expect(useAppStore.getState().findBars[`compare:${id}:b`]).toBeUndefined();
  });

  it("a selection in side A never seeds side B's bar", () => {
    const id = seedBothSides();
    render(<ComparePanel requestId={id} />);

    boxOf("b").focus();
    selectIn("a", "alpha"); // the selection lives in the OTHER pane
    fireEvent.keyDown(boxOf("b"), { key: "f", metaKey: true });

    expect(inB().getByTestId("response-find-input")).toHaveValue("");
    expect(inB().queryByTestId("response-find-current")).not.toBeInTheDocument();
  });
});
