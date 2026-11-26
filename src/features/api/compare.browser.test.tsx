/** ComparePanel pixel claims (jsdom has no layout): panes side by side within the split's width
 * budget, a wide response scrolls INSIDE its pane body (actually scrolled), the selected key is
 * visibly distinct. App.css is imported for real: the highlight uses its theme variables. */

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useAppStore } from "../../app/store";
import { resetStore } from "../../test/store-harness";
import { ComparePanel } from "./ComparePanel";
import type { HttpResponse } from "./httpIpc";
import "../../App.css";

afterEach(cleanup);
beforeEach(() => {
  resetStore();
});

const api = () => useAppStore.getState().apiActions;

const jsonResponse = (value: unknown): HttpResponse => ({
  status: 200,
  statusText: "OK",
  headers: [{ name: "content-type", value: "application/json" }],
  body: JSON.stringify(value),
  durationMs: 42,
  sizeBytes: 128,
  truncated: false,
});

/** Compare on, both sides landed — the panel's home state. */
function seed(a: unknown, b: unknown): string {
  const id = api().createApiRequest();
  api().patchApiRequest(id, { url: "https://a.test/x" });
  api().setCompareEnabled(id, true);
  api().patchCompare(id, { method: "POST", url: "https://b.test/y" });
  api().setCompareResponse(id, "a", jsonResponse(a));
  api().setCompareResponse(id, "b", jsonResponse(b));
  return id;
}

/** Mount inside a stand-in for `.api-view`'s box (api.css), the flex column compare.css's
 * floor/shrink chain is written against. */
function renderSized(id: string) {
  return render(
    <div
      data-testid="api-view-stand-in"
      style={{
        width: "1000px",
        height: "600px",
        display: "flex",
        flexDirection: "column",
        gap: "12px",
        padding: "12px 14px",
        overflowY: "auto",
        boxSizing: "border-box",
      }}
    >
      <ComparePanel requestId={id} />
    </div>,
  );
}

const rect = (testId: string) =>
  screen.getByTestId(testId).getBoundingClientRect();

/** 400 rows deep and one 500-char value wide — must scroll INSIDE its pane. */
const LONG_AND_WIDE: Record<string, unknown> = {};
for (let i = 0; i < 400; i++) {
  LONG_AND_WIDE[`key_${String(i).padStart(3, "0")}`] = i;
}
LONG_AND_WIDE.wide = "w".repeat(500);

describe("ComparePanel — the split, with a real layout engine", () => {
  it("lays the panes side by side in equal halves, within the split's budget", () => {
    const id = seed({ name: "alpha", n: 1 }, { name: "beta" });
    renderSized(id);

    const a = rect("compare-pane-a");
    const b = rect("compare-pane-b");

    // Side by side, not stacked: B starts at or right of A's edge, tops equal.
    expect(b.left).toBeGreaterThanOrEqual(a.right);
    expect(Math.abs(a.top - b.top)).toBeLessThanOrEqual(1);

    // Equal halves.
    expect(Math.abs(a.width - b.width)).toBeLessThanOrEqual(2);

    // The BUDGET, not the symptom: widths + gap fit the split's
    // client box. This line fails with the arithmetic that names the fix.
    const split = screen.getByTestId("compare-split");
    const gap = parseFloat(getComputedStyle(split).columnGap);
    expect(a.width + gap + b.width).toBeLessThanOrEqual(split.clientWidth + 1);
  });

  it("scrolls a long, wide response INSIDE its pane body — the surface never scrolls", () => {
    const id = seed(LONG_AND_WIDE, { name: "beta" });
    renderSized(id);

    const body = screen.getByTestId("compare-body-a");

    // The content really overflows the body both ways…
    expect(body.scrollHeight).toBeGreaterThan(body.clientHeight);
    expect(body.scrollWidth).toBeGreaterThan(body.clientWidth);
    // …and the body is the box that SCROLLS — asserted by scrolling it, since
    // `scrollWidth > clientWidth` alone is also true of a visible/clipped box.
    body.scrollTop = 500;
    expect(body.scrollTop).toBeGreaterThan(0);
    body.scrollLeft = 200;
    expect(body.scrollLeft).toBeGreaterThan(0);

    // The outer surface pays nothing for it: no horizontal overflow, and the
    // panel's height stayed inside the 600px stand-in (the row-growth
    // failure would show up here as thousands of px of scrollHeight).
    const container = screen.getByTestId("api-view-stand-in");
    expect(container.scrollWidth).toBeLessThanOrEqual(container.clientWidth);
    expect(container.scrollHeight).toBeLessThanOrEqual(
      container.clientHeight + 1,
    );
  });

  it("paints a selected key visibly distinct from an unselected one", () => {
    const id = seed({ name: "alpha", other: 1 }, { name: "beta" });
    renderSized(id);

    const bodyA = screen.getByTestId("compare-body-a");
    const keyOf = (name: string) =>
      within(bodyA)
        .getAllByTestId("json-key")
        .find((k) => k.getAttribute("data-key") === name) as HTMLElement;

    fireEvent.click(keyOf("name"));

    const selected = bodyA.querySelector(
      '[data-selected="true"]',
    ) as HTMLElement;
    expect(selected).not.toBeNull();
    const unselected = keyOf("other");

    // Real computed styles from the real engine: the accent-soft chip and its
    // 1px accent ring, vs. the plain transparent key button.
    const s = getComputedStyle(selected);
    const u = getComputedStyle(unselected);
    expect(s.backgroundColor).not.toBe(u.backgroundColor);
    expect(s.boxShadow).not.toBe(u.boxShadow);
  });
});
