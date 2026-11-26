/** Real mermaid in a real browser, asserting on `document.body`: `mermaid.render` without a
 * container paints its error graphic into a body-level temp div and throws before removing it.
 * The last test pins `suppressErrorRendering`; the jsdom suite pins our `finally` sweep. */

import { act, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import mermaid from "mermaid";

import { MarkdownPreview } from "./MarkdownPreview";

// A fenced-block delimiter kept out of the template literals below.
const F = "```";

/** A `;` inside a `Note` line, which the sequence grammar reads as a separator: a parse error. */
const BAD = [
  "sequenceDiagram",
  "    participant A",
  "    participant B",
  "    A->>B: hello",
  "    Note over A,B: first thing; second thing",
].join("\n");

/** Parses and draws in every engine — the control for "we did not just break mermaid". */
const GOOD = "graph TD\n  A-->B";

const fenced = (...diagrams: string[]): string =>
  diagrams.map((d) => `${F}mermaid\n${d}\n${F}`).join("\n\n");

/** The preview in a definite box, the shape CodeEditor mounts it in. */
const view = (text: string): React.JSX.Element => (
  <div style={{ width: 600, height: 400 }}>
    <MarkdownPreview text={text} zoom={1} />
  </div>
);

/** Stranded temp nodes, keyed on the id mermaid derives from ours (`d` + `mdp-mermaid-N`), never on
 * a global class or `svg path.error-icon`. */
const stranded = (): Element[] =>
  Array.from(document.body.querySelectorAll('[id^="dmdp-mermaid-"]'));

afterEach(() => {
  // Runs AFTER the assertions, so one leaking test cannot cascade into its
  // neighbours and turn a single regression into a wall of red.
  for (const el of stranded()) el.remove();
  document.getElementById("dmdp-mermaid-probe")?.remove();
});

describe("mermaid leak — real library, real browser", () => {
  it("leaves nothing on document.body when three diagrams fail to parse", async () => {
    const { container } = render(view(fenced(BAD, BAD, BAD)));

    await waitFor(() =>
      expect(container.querySelectorAll(".markdown-preview__diagram-error")).toHaveLength(
        3,
      ),
    );

    // 🔴 OUTSIDE the RTL container on purpose — the leak is its SIBLING.
    expect(stranded()).toEqual([]);
    // And the SYMPTOM, not only the node: an id-only assertion would pass a
    // "fix" that merely renamed the div that showed the graphic.
    expect(document.body.textContent).not.toContain("Syntax error in text");
    expect(document.body.querySelector("svg .error-icon")).toBeNull();

    // The note really is the real library's verdict, not a generic apology:
    // real mermaid reports `loc.first_line: 5` for this source, and the line
    // number is relative to the FENCE BODY, which is what "of the diagram" says.
    expect(container.querySelector(".markdown-preview__diagram-error")).toHaveTextContent(
      "Diagram error — line 5 of the diagram",
    );
    expect(container.querySelector(".markdown-preview__diagram-detail")).toHaveTextContent(
      /Unexpected NEWLINE — expected /,
    );
  });

  it("does not accumulate them across mount / unmount cycles", async () => {
    // Each tab switch re-hydrates with a fresh id, and mermaid only reclaims a node of the same id,
    // so a leak grows with every pass.
    for (let pass = 0; pass < 3; pass++) {
      const { container, unmount } = render(view(fenced(BAD, BAD)));
      await waitFor(() =>
        expect(
          container.querySelectorAll(".markdown-preview__diagram-error"),
        ).toHaveLength(2),
      );
      unmount();
      // Asserted INSIDE the loop as well as after it: a leak that is cleaned up
      // by the next mount would be invisible to an end-of-loop check, and
      // "gone by the time you look" is not what the user experienced.
      expect(stranded()).toEqual([]);
    }
    expect(stranded()).toEqual([]);
    expect(document.body.textContent).not.toContain("Syntax error in text");
  });

  it("still renders a diagram that is valid", async () => {
    // The control. Suppressing mermaid's error rendering must not suppress
    // mermaid: without this, "delete the mermaid call" would pass every
    // assertion above.
    const { container } = render(view(fenced(GOOD)));

    await waitFor(() =>
      expect(
        container.querySelector(".markdown-preview__mermaid--rendered"),
      ).not.toBeNull(),
    );
    const svg = container.querySelector(".markdown-preview__mermaid--rendered svg");
    expect(svg).not.toBeNull();
    // Real geometry, from a real layout engine — not an empty <svg> shell.
    expect(svg!.getBoundingClientRect().width).toBeGreaterThan(0);
    expect(container.querySelector(".markdown-preview__diagram-error")).toBeNull();
    // The success path sweeps up after itself too (mermaid already did, so the
    // sweep must simply find nothing).
    expect(stranded()).toEqual([]);
  });

  it("a mixed document renders what it can and explains what it cannot", async () => {
    const { container } = render(view(fenced(GOOD, BAD, GOOD)));

    await waitFor(() =>
      expect(
        container.querySelectorAll(".markdown-preview__mermaid--rendered"),
      ).toHaveLength(2),
    );
    expect(container.querySelectorAll(".markdown-preview__diagram-error")).toHaveLength(1);
    // One bad diagram does not stop the ones after it — the hydration loop is
    // sequential, so a throw that escaped would strand every later block as
    // raw source.
    expect(stranded()).toEqual([]);
    expect(document.body.textContent).not.toContain("Syntax error in text");
  });

  it("mermaid ITSELF strands nothing, with our sweep out of the path", async () => {
    // Only this test can falsify `suppressErrorRendering`: our `finally` sweep satisfies the rest.
    // Mounting first applies our module-global config; then the library is driven directly.
    const { container } = render(view(fenced(BAD)));
    await waitFor(() =>
      expect(container.querySelector(".markdown-preview__diagram-error")).not.toBeNull(),
    );

    await act(async () => {
      await expect(mermaid.render("mdp-mermaid-probe", BAD)).rejects.toThrow();
    });

    expect(document.getElementById("dmdp-mermaid-probe")).toBeNull();
    expect(document.body.textContent).not.toContain("Syntax error in text");

    // Two-sided: the call really did reach the renderer and really did fail on
    // the source we think it failed on, rather than being rejected early by
    // something that would also produce no node.
    await act(async () => {
      await expect(mermaid.render("mdp-mermaid-probe", GOOD)).resolves.toMatchObject({
        diagramType: "flowchart-v2",
      });
    });
    expect(document.getElementById("dmdp-mermaid-probe")).toBeNull();
  });
});
