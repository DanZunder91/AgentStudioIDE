/** ComparePanel queries the DOM contract (data-key / data-selected / json-key) directly. Search
 * counts are hand-counted literals: a total from the same walk that produced it proves nothing. */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { JsonView, searchJsonTree } from "./JsonView";

afterEach(cleanup);

const view = (value: unknown) => render(<JsonView value={value} />);
const tree = () => screen.getByTestId("json-view");

describe("JsonView", () => {
  it("renders each primitive kind, typed", () => {
    view("hi");
    expect(tree()).toHaveTextContent('"hi"'); // strings are quoted
    cleanup();
    view(42);
    expect(tree()).toHaveTextContent("42");
    cleanup();
    view(true);
    expect(tree()).toHaveTextContent("true");
    cleanup();
    view(null);
    expect(tree()).toHaveTextContent("null");
    cleanup();
    view(undefined);
    expect(tree()).toHaveTextContent("undefined");
    cleanup();
    view(10n); // bigint → coerced string (the default branch)
    expect(tree()).toHaveTextContent("10");
  });

  it("renders an empty object/array as bare brackets with no caret", () => {
    view({});
    expect(tree()).toHaveTextContent("{}");
    expect(screen.queryByTestId("json-node-toggle")).toBeNull();
    cleanup();
    view([]);
    expect(tree()).toHaveTextContent("[]");
    expect(screen.queryByTestId("json-node-toggle")).toBeNull();
  });

  it("renders object keys, array items, and nesting (expanded by default)", () => {
    view({ name: "x", list: [1, { k: true }] });
    const t = tree();
    expect(t).toHaveTextContent("name");
    expect(t).toHaveTextContent('"x"');
    expect(t).toHaveTextContent("list");
    expect(t).toHaveTextContent("true"); // the nested { k: true } is expanded too
  });

  it("collapses a node (children hidden → summary) and expands it again", () => {
    view({ a: { b: 1 } });
    expect(tree()).toHaveTextContent("b");
    // The outer object's toggle is the first one.
    fireEvent.click(screen.getAllByTestId("json-node-toggle")[0]);
    expect(tree()).not.toHaveTextContent("b"); // children unmounted
    expect(tree()).toHaveTextContent("{…}"); // collapsed summary
    fireEvent.click(screen.getAllByTestId("json-node-toggle")[0]);
    expect(tree()).toHaveTextContent("b"); // expanded again
  });

  it("shows an Array(N) summary when an array is collapsed", () => {
    view([1, 2, 3]);
    fireEvent.click(screen.getByTestId("json-node-toggle"));
    expect(tree()).toHaveTextContent("Array(3)");
  });

  it("caps deeply nested values with a summary instead of recursing unbounded", () => {
    let v: unknown = "leaf";
    for (let i = 0; i < 105; i += 1) v = { a: v };
    view(v);
    expect(tree()).toBeInTheDocument();
    // The depth-capped node shows a summary rather than the buried leaf.
    expect(tree()).not.toHaveTextContent('"leaf"');
    expect(screen.getAllByText("{…}").length).toBeGreaterThanOrEqual(1);
  });
});

/** The key element for `name`, wherever it is (span or button). */
const keyEl = (container: HTMLElement, name: string) =>
  container.querySelector(`[data-key="${CSS.escape(name)}"]`);

describe("JsonView — A/B compare (selectedKey / onSelectKey)", () => {
  it("clicking a key calls onSelectKey with exactly that key name", () => {
    const onSelectKey = vi.fn();
    const { container } = render(
      <JsonView
        value={{ alpha: 1, beta: { gamma: 2 } }}
        onSelectKey={onSelectKey}
      />,
    );
    const gamma = keyEl(container, "gamma");
    expect(gamma).not.toBeNull();
    fireEvent.click(gamma as HTMLElement);
    expect(onSelectKey).toHaveBeenCalledTimes(1);
    expect(onSelectKey).toHaveBeenCalledWith("gamma");
  });

  it("clicking a key selects it WITHOUT collapsing its node", () => {
    const onSelectKey = vi.fn();
    const { container } = render(
      <JsonView value={{ obj: { inner: 1 } }} onSelectKey={onSelectKey} />,
    );
    fireEvent.click(keyEl(container, "obj") as HTMLElement);
    expect(onSelectKey).toHaveBeenCalledWith("obj");
    // The node stayed expanded: its child is still mounted, no summary shown.
    expect(tree()).toHaveTextContent("inner");
    expect(tree()).not.toHaveTextContent("{…}");
  });

  it("selectedKey marks EVERY occurrence of the key name, at any depth", () => {
    const { container } = render(
      <JsonView
        value={{ name: "a", nested: { name: "b" }, list: [{ name: "c" }] }}
        selectedKey="name"
        onSelectKey={() => {}}
      />,
    );
    const marked = container.querySelectorAll('[data-key="name"]');
    expect(marked).toHaveLength(3);
    for (const el of Array.from(marked)) {
      expect(el.getAttribute("data-selected")).toBe("true");
      expect(el.classList.contains("jsonview__key--selected")).toBe(true);
    }
    // Non-matching keys carry neither the attribute nor the class.
    for (const other of ["nested", "list"]) {
      const el = keyEl(container, other) as HTMLElement;
      expect(el.hasAttribute("data-selected")).toBe(false);
      expect(el.classList.contains("jsonview__key--selected")).toBe(false);
    }
  });

  it("selection is an exact match — 'name' marks neither 'username' nor 'names'", () => {
    const { container } = render(
      <JsonView
        value={{ username: 1, name: 2, names: 3 }}
        selectedKey="name"
        onSelectKey={() => {}}
      />,
    );
    const name = keyEl(container, "name") as HTMLElement;
    expect(name.getAttribute("data-selected")).toBe("true");
    expect(name.classList.contains("jsonview__key--selected")).toBe(true);
    for (const near of ["username", "names"]) {
      const el = keyEl(container, near) as HTMLElement;
      expect(el.hasAttribute("data-selected")).toBe(false);
      expect(el.classList.contains("jsonview__key--selected")).toBe(false);
    }
  });

  it("interactive keys are <button type=button>, never nested in another button", () => {
    render(
      <JsonView value={{ obj: { inner: 1 }, list: [7] }} onSelectKey={() => {}} />,
    );
    const keys = screen.getAllByTestId("json-key");
    expect(keys.length).toBeGreaterThanOrEqual(4); // obj, inner, list, 0
    for (const btn of keys) {
      expect(btn.tagName).toBe("BUTTON");
      expect((btn as HTMLButtonElement).type).toBe("button");
      // No <button> ancestor — the key must not live inside the toggle.
      expect(btn.parentElement?.closest("button")).toBeNull();
    }
  });

  it("array indices are keyed rows too — data-key is the stringified index", () => {
    const { container } = render(
      <JsonView value={[10, 20]} onSelectKey={() => {}} />,
    );
    expect(keyEl(container, "0")).toHaveTextContent("0");
    expect(keyEl(container, "1")).toHaveTextContent("1");
  });

  it("without onSelectKey keys stay spans — no json-key testid", () => {
    const { container } = render(<JsonView value={{ a: 1 }} />);
    expect(screen.queryAllByTestId("json-key")).toHaveLength(0);
    expect((keyEl(container, "a") as HTMLElement).tagName).toBe("SPAN");
  });

  it("selectedKey highlights span keys in read-only mode too", () => {
    const { container } = render(<JsonView value={{ a: 1, b: 2 }} selectedKey="a" />);
    const a = keyEl(container, "a") as HTMLElement;
    expect(a.tagName).toBe("SPAN");
    expect(a.getAttribute("data-selected")).toBe("true");
    expect(a.classList.contains("jsonview__key--selected")).toBe(true);
    expect((keyEl(container, "b") as HTMLElement).hasAttribute("data-selected")).toBe(false);
  });

  it("expand/collapse still works in interactive mode (caret-only toggle)", () => {
    render(<JsonView value={{ a: { b: 1 } }} onSelectKey={() => {}} />);
    expect(tree()).toHaveTextContent("b");
    expect(screen.getAllByTestId("json-node-toggle")[0]).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    fireEvent.click(screen.getAllByTestId("json-node-toggle")[0]);
    expect(tree()).not.toHaveTextContent("b"); // children unmounted
    expect(tree()).toHaveTextContent("{…}"); // collapsed summary
    expect(screen.getAllByTestId("json-node-toggle")[0]).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    fireEvent.click(screen.getAllByTestId("json-node-toggle")[0]);
    expect(tree()).toHaveTextContent("b"); // expanded again
  });
});

describe("searchJsonTree — what the find bar's number MEANS", () => {
  it("counts every hit in key names and primitive values, in render order", () => {
    // Hand-counted: key `name` (1), value "ada" (0), key `team` (1),
    // value "ada-team" (1) → three, and the ordinals run top to bottom.
    const s = searchJsonTree({ name: "ada", team: "ada-team" }, "am");
    expect(s.total).toBe(3);
    const offsets = Array.from(s.slots.values()).map((slot) => slot.offset);
    expect(offsets).toEqual([0, 1, 2]);
    // Four slots exist in this value (two keys, two values); only three matched,
    // so the one that did not is simply ABSENT — "no marks here".
    expect(s.slots.size).toBe(3);
  });

  it("counts a hit per OCCURRENCE inside one slot, not per slot", () => {
    const s = searchJsonTree({ k: "aXaXa" }, "a");
    // Three in the value, none in the key: one slot, three ordinals.
    expect(s.total).toBe(3);
    expect(s.slots.size).toBe(1);
    expect(Array.from(s.slots.values())[0].matches).toHaveLength(3);
  });

  it("never searches JSON punctuation — the tree does not draw it", () => {
    // The Raw view finds `":` after every key; the tree has no such characters
    // on screen, so it must report zero rather than invent a hit.
    expect(searchJsonTree({ name: "ada" }, '":').total).toBe(0);
    expect(searchJsonTree({ name: "ada" }, "{").total).toBe(0);
  });

  it("never searches a node SUMMARY — the total must not move when a caret does", () => {
    // `Array(2)` / `{…}` are the collapsed placeholders. Counting them would
    // make "3 results" depend on which nodes happen to be open.
    expect(searchJsonTree({ list: [1, 2] }, "Array").total).toBe(0);
    expect(searchJsonTree({ obj: { a: 1 } }, "…").total).toBe(0);
  });

  it("skips an EMPTY container and everything below the depth cap", () => {
    // Empty object: the key still counts, the (absent) children cannot.
    expect(searchJsonTree({ empty: {} }, "empty").total).toBe(1);
    expect(searchJsonTree({ empty: [] }, "e").total).toBe(1);

    // Past MAX_DEPTH the node renders a summary and CANNOT be opened, so a hit
    // down there would be one the user can never see. It is not counted.
    let deep: unknown = "leaf";
    for (let i = 0; i < 105; i += 1) deep = { a: deep };
    expect(searchJsonTree(deep, "leaf").total).toBe(0);
    // Two-sided: the keys above the cap DO count, so this is a cap, not a
    // silently empty walk.
    expect(searchJsonTree(deep, "a").total).toBe(100);
  });

  it("pins the nodes a hit is UNDER — which for a key is its parent, not itself", () => {
    const s = searchJsonTree({ outer: { inner: "needle" }, other: 1 }, "needle");
    // The hit sits in `outer`'s child, so both `outer` and the root must open.
    expect(s.pinned.size).toBe(2);

    // A hit on `outer`'s OWN key pins only the root — the node that draws that
    // key. `outer` itself may stay shut; its key is on screen either way.
    const key = searchJsonTree({ outer: { inner: 1 } }, "outer");
    expect(Array.from(key.pinned)).toEqual([""]); // "" is the root's path
  });

  it("counts a root primitive and array indices, which are keys too", () => {
    expect(searchJsonTree("bare string", "bare").total).toBe(1);
    // "0" and "1" are rendered key labels; 10 and 20 are values.
    expect(searchJsonTree([10, 20], "0").total).toBe(3);
  });
});

describe("JsonView — search marks", () => {
  const NEEDLES = { name: "ada", team: "ada-team" };

  it("marks the hits inside keys AND values, with exactly one current", () => {
    const search = searchJsonTree(NEEDLES, "am");
    const { container } = render(
      <JsonView value={NEEDLES} search={search} currentMatch={1} />,
    );
    // Three marks, and the SECOND ordinal is the current one — the `team` key.
    expect(screen.getAllByTestId("response-find-hit")).toHaveLength(2);
    const current = screen.getByTestId("response-find-current");
    expect(current).toHaveTextContent("am");
    expect(current.closest("[data-key]")?.getAttribute("data-key")).toBe("team");
    // The key text is not lost around the mark, and neither is the value's.
    expect(keyEl(container, "name")).toHaveTextContent("name");
    expect(tree()).toHaveTextContent('"ada-team"');
  });

  it("leaves every slot that did not match as bare text", () => {
    render(<JsonView value={NEEDLES} search={searchJsonTree(NEEDLES, "am")} />);
    // `role`-less value "ada" holds no "am": its span has no <mark> in it.
    const ada = screen.getByText('"ada"');
    expect(ada.querySelector("mark")).toBeNull();
  });

  it("pins a collapsed node open while a hit is inside it, then hands it back", () => {
    const value = { outer: { inner: "needle" }, other: 1 };
    const { rerender } = render(<JsonView value={value} />);
    const carets = () => screen.getAllByTestId("json-node-toggle");
    fireEvent.click(carets()[1]); // collapse `outer`
    expect(tree()).not.toHaveTextContent("needle");

    rerender(
      <JsonView value={value} search={searchJsonTree(value, "needle")} />,
    );
    // Reopened, and locked open: a counted hit the user cannot see is worse
    // than a missing one.
    expect(screen.getByTestId("response-find-current")).toHaveTextContent("needle");
    expect(carets()[1]).toBeDisabled();
    expect(carets()[1]).toHaveAttribute("aria-expanded", "true");
    expect(carets()[1]).toHaveAttribute("title", "Kept open — a search match is inside");

    // Query gone → the node goes back to the collapse the USER chose.
    rerender(<JsonView value={value} />);
    expect(carets()[1]).not.toBeDisabled();
    expect(carets()[1]).not.toHaveAttribute("title");
    expect(tree()).not.toHaveTextContent("needle");
  });

  it("leaves a collapsed node collapsed when the hit is somewhere else", () => {
    const value = { outer: { inner: "needle" }, other: 1 };
    const { rerender } = render(<JsonView value={value} />);
    const carets = () => screen.getAllByTestId("json-node-toggle");
    fireEvent.click(carets()[1]);

    rerender(<JsonView value={value} search={searchJsonTree(value, "other")} />);
    expect(screen.getByTestId("response-find-current")).toHaveTextContent("other");
    expect(carets()[1]).not.toBeDisabled();
    expect(tree()).toHaveTextContent("{…}"); // still the collapsed summary
  });

  it("pins and marks in INTERACTIVE mode too (the compare panes' caret-only toggle)", () => {
    const value = { outer: { inner: "needle" } };
    const onSelectKey = vi.fn();
    const { rerender } = render(
      <JsonView value={value} onSelectKey={onSelectKey} />,
    );
    const carets = () => screen.getAllByTestId("json-node-toggle");
    fireEvent.click(carets()[1]);
    expect(tree()).not.toHaveTextContent("needle");

    rerender(
      <JsonView
        value={value}
        onSelectKey={onSelectKey}
        search={searchJsonTree(value, "inner")}
      />,
    );
    // The key button carries the mark, and clicking it still SELECTS (the mark
    // is inside the button, not a replacement for it).
    const current = screen.getByTestId("response-find-current");
    expect(current).toHaveTextContent("inner");
    fireEvent.click(current);
    expect(onSelectKey).toHaveBeenCalledWith("inner");
    expect(carets()[1]).toBeDisabled();
  });
});
