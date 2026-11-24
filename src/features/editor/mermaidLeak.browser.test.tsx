/**
 * The mermaid error-graphic leak — layer 5, the real-browser tier (testing-strategy §1).
 *
 * The bug: opening a markdown
 * file whose mermaid diagrams fail to parse filled the app with mermaid's red
 * *"Syntax error in text / mermaid version 11.16.1"* graphic — stacked many
 * times over, overlapping the left rail and the terminal, persisting across
 * screens and surviving the source file being fixed. Only an app restart
 * cleared them.
 *
 * `mermaid.render(id, text)` called with no container argument builds every
 * diagram in a temp `<div id="d{id}">` appended to **`document.body`** — a
 * sibling of `#root`, outside React, which nothing in this app would ever
 * remove. On a parse failure it paints the graphic there and then does
 * `if (parseEncounteredException) { throw … }` **one statement above** its own
 * `removeTempElements()`, with no `finally`. Our `catch` swallowed the
 * rejection and drew the calm inline note, so the user got both.
 *
 * ── Why this file, and why this tier ─────────────────────────────────────────
 *
 * 🔴 No test in this repo had ever run real mermaid. It is `vi.mock`ed in
 * `MarkdownPreview.test.tsx` and `previewZoomSeam.test.tsx`, the browser-tier
 * zoom suite pre-bakes post-hydration markup by hand, and the one
 * invalid-diagram test used `mockRejectedValue` — which BY CONSTRUCTION cannot
 * leak, and asserted only within the RTL container, a *sibling* of the leaked
 * div. That is precisely why this bug shipped: every instrument pointed away
 * from the thing that broke.
 *
 * So this file runs the REAL library and asserts on `document.body`. It lives in
 * the browser tier rather than beside the jsdom suite because real mermaid under
 * jsdom needs polyfills to run at all — a constructable `CSSStyleSheet` and
 * `SVGElement.prototype.getBBox` — and a regression test for "what the library
 * actually does" that only holds in a hand-patched environment is the kind of
 * test that produced this bug in the first place. Chromium has both, for real,
 * along with the SVG layout every diagram type measures itself with. The mocked
 * jsdom suite keeps its own half: it pins OUR sweep by reproducing the leak
 * deterministically (see "a failed diagram leaves nothing on document.body"
 * there). Between them, each fix is falsifiable on its own:
 *
 *   - drop `suppressErrorRendering` → the last test here goes red (it calls
 *     `mermaid.render` DIRECTLY, so our sweep is not in the path at all);
 *   - drop the `finally` sweep → the jsdom suite goes red.
 *
 * Run: `npx vitest run --config vitest.browser.config.ts \
 *        src/features/editor/mermaidLeak.browser.test.tsx`
 */

import { act, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import mermaid from "mermaid";

import { MarkdownPreview } from "./MarkdownPreview";

// A fenced-block delimiter kept out of the template literals below.
const F = "```";

/**
 * A real failure mode, reduced: a `;` inside a `Note` line, which the
 * sequence grammar reads as a statement separator. Real mermaid rejects this
 * with a jison parse error whose `hash.loc.first_line` is 5.
 */
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

/**
 * Temp nodes stranded on the body, however they got there. Keyed on the id
 * shape mermaid derives from the ids WE pass (`d` + `mdp-mermaid-N`) — never on
 * a class or on `svg path.error-icon`, which would be a global DOM stomp.
 */
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
    // The graphic stuck on every screen, even after the file was fixed.
    // `Pane` mounts only the ACTIVE tab, so every switch away and back re-runs
    // the hydration with a fresh monotonic id — and mermaid's own
    // `removeExistingElements` only reclaims a node of the SAME id, so before
    // the fix the count grew without bound for as long as the app was open.
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
    // 🔴 The isolation test for `suppressErrorRendering`, and the only one that
    // can falsify it: every assertion above is also satisfied by our own
    // `finally` sweep, so removing the flag alone would leave them green.
    //
    // Mounting the component first is what applies our config — `initMermaid`
    // is module-global and idempotent, and this is the same module instance the
    // component imports. Then the library is driven DIRECTLY, so nothing of
    // ours can clean up after it.
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
