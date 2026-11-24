/**
 * MarkdownPreview tests. jsdom + @testing-library/react.
 *
 * `mermaid` is mocked at the module boundary: the real renderer needs a live SVG
 * layout engine jsdom does not have, and mocking lets us drive both the success
 * and the parse-error paths deterministically — plus the unmount race guard.
 *
 * NOTE on ordering: the component inits mermaid once (module-global flag), so the
 * FIRST test that renders a diagram exercises the init; later diagram tests
 * exercise the already-initialised path. Both branches are covered as a result.
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mermaidMock = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
}));
vi.mock("mermaid", () => ({ default: mermaidMock }));

// Local images are inlined via this scoped read. Mocked so the tests drive the
// success / skip / failure / unmount-race paths without touching Tauri.
const workspaceIpc = vi.hoisted(() => ({ readImageDataUrl: vi.fn() }));
vi.mock("../workspace/workspaceIpc", () => workspaceIpc);

const gitIpc = vi.hoisted(() => ({ urlOpen: vi.fn(() => Promise.resolve()) }));
vi.mock("../git/gitIpc", () => gitIpc);

import { useAppStore, type FindBarState } from "../../app/store";
import { interceptLink, MarkdownPreview } from "./MarkdownPreview";
import { anchorScrollDelta, fitPreviewZoom, wheelPreviewZoom } from "./previewZoom";

// A fenced-block delimiter kept out of the template literals below.
const F = "```";

/**
 * Dispatch a NATIVE wheel event and return it. `fireEvent.wheel` does not set
 * `cancelable`, and `defaultPrevented` is only observable on a cancelable event
 * — the whole point of several assertions below.
 */
function wheel(el: HTMLElement, init: WheelEventInit): WheelEvent {
  const evt = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(evt);
  return evt;
}

/**
 * Run `fn` and collect anything React reports as an UNCAUGHT error.
 *
 * `expect(() => fireEvent.click(x)).not.toThrow()` is worthless against a React
 * event handler: React catches the throw and re-reports it via `reportError`,
 * which jsdom turns into a window "error" event. Vitest then prints
 * "53 passed | 1 error" — a red run being polite — and any
 * assertion phrased as "did not throw" sails straight past it. Verified against
 * a real mutant: deleting the handler's `!block || !svg` bail throws a
 * TypeError that `not.toThrow()` did not catch and this helper does.
 */
function errorsDuring(fn: () => void): unknown[] {
  const seen: unknown[] = [];
  const onError = (e: ErrorEvent): void => {
    e.preventDefault(); // keep vitest's own unhandled-error reporter quiet
    seen.push(e.error ?? e.message);
  };
  window.addEventListener("error", onError);
  try {
    fn();
  } finally {
    window.removeEventListener("error", onError);
  }
  return seen;
}

/**
 * jsdom's scrollLeft/scrollTop are inert (no layout → no scrolling box), so
 * replace them with plain writable values. Stubbed, and honest about it (the
 * ResultsGrid measurement-stub precedent): this pins the component's scroll
 * ARITHMETIC; it cannot prove real scroll clamping under a layout engine.
 */
function stubScroll(el: HTMLElement): void {
  Object.defineProperty(el, "scrollLeft", { value: 0, writable: true, configurable: true });
  Object.defineProperty(el, "scrollTop", { value: 0, writable: true, configurable: true });
}

/**
 * Feed the Fit handler the two measurements it takes at click time. jsdom has no
 * layout engine, so every `getBoundingClientRect()` is 0×0 and every
 * `clientWidth`/`clientHeight` is 0 — a Fit click here would measure a collapsed
 * pane and (correctly) do nothing, which makes an unstubbed assertion vacuous.
 *
 * Stubbed, and honest about it — the `stubScroll` caveat above applies in full:
 * this pins the WIRING (which element is measured, that the pane's padding comes
 * off the client box, and that `fitPreviewZoom`'s number is what reaches
 * `onZoomChange`) and nothing else. It proves nothing about real geometry —
 * mermaid's own SVG size, the `calc(100% * var(--mdp-zoom))` ceiling, a
 * scrollbar eating clientWidth. That is the browser tier's job
 * (`markdownPreviewZoom.browser.test.tsx`), under a real engine.
 */
function stubFitGeometry(
  preview: HTMLElement,
  {
    client,
    padding,
    diagram,
  }: {
    /** What `clientWidth`/`clientHeight` report (border box minus scrollbars). */
    client: { width: number; height: number };
    /** Real inline padding — jsdom resolves it through getComputedStyle, so the
     *  handler reads it exactly as it would in the app. */
    padding: number;
    /** What the diagram's rect reports, in device pixels at the current zoom. */
    diagram: { width: number; height: number };
  },
): void {
  Object.defineProperty(preview, "clientWidth", { value: client.width, configurable: true });
  Object.defineProperty(preview, "clientHeight", { value: client.height, configurable: true });
  preview.style.padding = `${padding}px`;
  const rect: DOMRect = {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    width: diagram.width,
    height: diagram.height,
    right: diagram.width,
    bottom: diagram.height,
    toJSON: () => ({}),
  };
  const svg = preview.querySelector("svg") as SVGSVGElement;
  svg.getBoundingClientRect = () => rect;
}

beforeEach(() => {
  mermaidMock.initialize.mockClear();
  mermaidMock.render.mockReset();
  // Default: a local image inlines to this data URL. Tests override per-case.
  workspaceIpc.readImageDataUrl.mockReset().mockResolvedValue("data:image/png;base64,AAAA");
});
afterEach(() => vi.clearAllTimers());

describe("MarkdownPreview — markdown rendering", () => {
  it("renders headings, lists, links, blockquotes, inline + fenced code", () => {
    const { container } = render(
      <MarkdownPreview
        text={[
          "# Heading one",
          "## Heading two",
          "",
          "- first",
          "- second",
          "",
          "> a quote",
          "",
          "Some `inline` code and a [link](https://example.com).",
          "",
          `${F}js`,
          "const x = 1;",
          F,
        ].join("\n")}
      />,
    );

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Heading one");
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Heading two");
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.querySelector("blockquote")).not.toBeNull();

    const link = screen.getByRole("link", { name: "link" });
    expect(link).toHaveAttribute("href", "https://example.com");

    expect(container.querySelector("code")).toHaveTextContent("inline");
    // The fenced block is a <pre><code> — the code is present.
    expect(container.querySelector("pre code")).toHaveTextContent("const x = 1;");
  });

  it("renders GFM tables to real table markup", () => {
    const { container } = render(
      <MarkdownPreview
        text={["| A | B |", "| - | - |", "| 1 | 2 |"].join("\n")}
      />,
    );

    expect(container.querySelector("table")).not.toBeNull();
    const headers = container.querySelectorAll("th");
    expect(headers).toHaveLength(2);
    expect(headers[0]).toHaveTextContent("A");
    expect(container.querySelectorAll("td")).toHaveLength(2);
  });

  it("renders safe raw HTML but strips dangerous tags and handlers (sanitised)", () => {
    const { container } = render(
      <MarkdownPreview
        text={[
          "# Safe",
          "",
          '<p align="center">centered</p>',
          "",
          "<script>window.pwned = 1</script>",
          "",
          '<img src="https://example.com/x.png" onerror="window.pwned = 2">',
        ].join("\n")}
      />,
    );

    // Safe HTML renders as real elements — a README `<p align>` banner works now.
    const p = container.querySelector("p[align='center']");
    expect(p).not.toBeNull();
    expect(p).toHaveTextContent("centered");

    // Dangerous HTML is REMOVED by DOMPurify — not escaped-as-text, gone.
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).not.toContain("window.pwned");
    // The event handler is stripped from the <img>, the tag itself kept.
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("onerror")).toBeNull();
  });

  it("resolves + inlines a relative raw-HTML <img> banner against basePath", async () => {
    // The README case: a `<p align="center"><img src="./banner.gif"></p>` banner.
    // The raw <img> never passes the markdown image rule, so the effect must join
    // its relative src to basePath before the scoped read.
    workspaceIpc.readImageDataUrl.mockResolvedValue("data:image/gif;base64,R0lGOD");
    const { container } = render(
      <MarkdownPreview
        text={'<p align="center"><img src="./.github/assets/banner.gif" alt="Gazelle"></p>'}
        basePath="/w/gazelle"
      />,
    );

    await waitFor(() =>
      expect(workspaceIpc.readImageDataUrl).toHaveBeenCalledWith(
        "/w/gazelle/./.github/assets/banner.gif",
      ),
    );
    await waitFor(() =>
      expect(container.querySelector("img")?.getAttribute("src")).toBe(
        "data:image/gif;base64,R0lGOD",
      ),
    );
  });
});

describe("MarkdownPreview — empty state", () => {
  it("shows a calm empty state for empty text", () => {
    render(<MarkdownPreview text="" />);
    expect(screen.getByText("Nothing to preview.")).toBeInTheDocument();
    expect(screen.queryByTestId("markdown-preview")?.querySelector(".markdown-preview__body")).toBeNull();
  });

  it("shows the empty state for whitespace-only text", () => {
    render(<MarkdownPreview text={"   \n\t  "} />);
    expect(screen.getByText("Nothing to preview.")).toBeInTheDocument();
  });
});

describe("MarkdownPreview — mermaid diagrams", () => {
  const doc = `${F}mermaid\ngraph TD; A-->B;\n${F}`;

  it("hydrates a mermaid block into an SVG", async () => {
    mermaidMock.render.mockResolvedValue({
      svg: '<svg data-testid="mermaid-svg"><g></g></svg>',
    });

    const { container } = render(<MarkdownPreview text={doc} />);

    // The block starts as a container holding the raw source.
    const block = container.querySelector<HTMLElement>(".markdown-preview__mermaid");
    expect(block).not.toBeNull();

    await waitFor(() =>
      expect(block).toHaveClass("markdown-preview__mermaid--rendered"),
    );
    expect(block!.querySelector("svg")).not.toBeNull();
    expect(mermaidMock.render).toHaveBeenCalledWith(
      expect.stringContaining("mdp-mermaid-"),
      expect.stringContaining("graph TD"),
    );
    // First diagram render in this file → mermaid was initialised strictly.
    expect(mermaidMock.initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        startOnLoad: false,
        securityLevel: "strict",
        // 🔴 The fix for the leaked-error-graphic bug. Without this flag mermaid
        // paints its red "Syntax error in text" graphic into the temp div it
        // appends to document.body and then throws one statement BEFORE its own
        // cleanup runs — so the graphic is stranded outside React, one per
        // failed render, until the app restarts. Asserted here because this is
        // the only test in the file that observes `initialize`: init is
        // module-global and idempotent, so every later diagram test runs
        // against the already-initialised path (see the file header).
        suppressErrorRendering: true,
      }),
    );
  });

  it("renders a calm inline error when a diagram fails to parse", async () => {
    mermaidMock.render.mockRejectedValue(new Error("parse error"));

    const { container } = render(<MarkdownPreview text={doc} />);

    await waitFor(() =>
      expect(container.querySelector(".markdown-preview__diagram-error")).not.toBeNull(),
    );
    expect(container.querySelector(".markdown-preview__diagram-error")).toHaveTextContent(
      "Diagram error",
    );
    // The source is preserved beside the note; the preview never crashes.
    expect(container.querySelector(".markdown-preview__diagram-source")).toHaveTextContent(
      "graph TD",
    );
    expect(container.querySelector("svg")).toBeNull();
  });

  /**
   * mermaid's default is `useMaxWidth: true` for every diagram type, which emits
   * `width="100%" style="max-width: <natural>px"` — shrink-to-fit-the-pane. Under
   * CSS `zoom` that clamp makes zooming a NO-OP for diagrams (the pane's CSS width
   * is itself divided by the zoom, so `100%` paints back to the same device pixels
   * at every level), and it is why a wide schema was unreadable at 100% in the
   * first place. The hydration step pins the natural width instead.
   */
  describe("sizes the rendered diagram so zoom can scale it", () => {
    const hydrate = async (svg: string) => {
      mermaidMock.render.mockResolvedValue({ svg });
      const { container } = render(<MarkdownPreview text={doc} />);
      await waitFor(() =>
        expect(
          container.querySelector(".markdown-preview__mermaid--rendered"),
        ).not.toBeNull(),
      );
      return container.querySelector("svg") as SVGElement;
    };

    it("takes mermaid's own computed width out of its inline max-width clamp", async () => {
      // Exactly what mermaid v11 emits (calculateSvgSizeAttrs, useMaxWidth: true).
      const el = await hydrate(
        '<svg width="100%" style="max-width: 2400px;" viewBox="0 0 2400 900"></svg>',
      );
      expect(el.style.width).toBe("2400px");
      // The INLINE clamp must be gone, or it would beat the stylesheet rule that
      // re-imposes the ceiling as `calc(100% * var(--mdp-zoom))`.
      expect(el.style.maxWidth).toBe("");
      expect(el.style.height).toBe("auto"); // viewBox keeps the aspect ratio
    });

    it("falls back to the viewBox width when there is no max-width", async () => {
      const el = await hydrate('<svg viewBox="0 0 1234 500"></svg>');
      expect(el.style.width).toBe("1234px");
    });

    it("ignores a zero-width diagram rather than pinning it to 0px", async () => {
      // A 0-width viewBox is degenerate output, not a size. Pinning `width: 0px`
      // would render an invisible diagram — worse than leaving mermaid's own
      // fit-to-pane sizing in place, which at least shows something.
      const el = await hydrate('<svg viewBox="0 0 0 500"></svg>');
      expect(el.style.width).toBe("");
      expect(el.style.maxWidth).toBe("");
    });

    it("does not throw when mermaid returns markup with no <svg> at all", async () => {
      mermaidMock.render.mockResolvedValue({ svg: "<p>not a diagram</p>" });
      const { container } = render(<MarkdownPreview text={doc} />);
      // Nothing to pin: the block still hydrates and the preview never crashes.
      await waitFor(() =>
        expect(
          container.querySelector(".markdown-preview__mermaid--rendered"),
        ).not.toBeNull(),
      );
      expect(container.querySelector("svg")).toBeNull();
      expect(container.querySelector(".markdown-preview__mermaid")).toHaveTextContent(
        "not a diagram",
      );
    });

    it("leaves a diagram it cannot measure exactly as mermaid built it", async () => {
      // Two-sided: without this, "always writes a width" would pass the tests
      // above while silently forcing a bogus 0px/NaN size on odd output.
      const el = await hydrate('<svg class="untouched"><g></g></svg>');
      expect(el.style.width).toBe("");
      expect(el.style.maxWidth).toBe("");
      expect(el.style.height).toBe("");
    });
  });

  it("does not inject the SVG after unmount (race guard)", async () => {
    let resolveRender!: (value: { svg: string }) => void;
    mermaidMock.render.mockReturnValue(
      new Promise<{ svg: string }>((resolve) => {
        resolveRender = resolve;
      }),
    );

    const { container, unmount } = render(<MarkdownPreview text={doc} />);
    const block = container.querySelector<HTMLElement>(".markdown-preview__mermaid")!;

    await waitFor(() => expect(mermaidMock.render).toHaveBeenCalled());

    unmount(); // sets the cancelled flag before the render promise settles
    resolveRender({ svg: '<svg data-testid="too-late"></svg>' });
    await new Promise((r) => setTimeout(r, 0));

    expect(block.querySelector("svg")).toBeNull();
    expect(block).not.toHaveClass("markdown-preview__mermaid--rendered");
  });
});

/**
 * The leaked-error-graphic bug: a markdown file
 * whose mermaid diagrams fail to parse filled the app with mermaid's red
 * *"Syntax error in text / mermaid version 11.16.1"* graphic — stacked many
 * times, overlapping the left rail and the terminal, persisting across screens
 * and surviving the source file being fixed. Only restarting cleared them.
 *
 * Two independent fixes, falsifiable independently:
 *
 *   1. `suppressErrorRendering` stops mermaid drawing the graphic at all, and
 *      makes it run its own `removeTempElements()` before rethrowing. Pinned by
 *      the `initialize` assertion above (the only place in this file that can
 *      see the init), and END-TO-END against the real library in
 *      `mermaidLeak.browser.test.tsx`.
 *   2. Our own `finally` sweep, for the ~20 lines of `render()` that sit in no
 *      try/catch at all and can still strand the div with suppression on. That
 *      is what this block pins, and the MOCK is the right instrument for it:
 *      it reproduces mermaid's leak exactly (append `#d{id}` to document.body,
 *      then reject) while removing every other reason the node might vanish, so
 *      only our sweep can be what cleans it.
 *
 * 🔴 Every assertion here looks at `document.body`, OUTSIDE the RTL container.
 * That is the whole point: the leaked node is a SIBLING of the container, which
 * is exactly why the pre-existing invalid-diagram test — `mockRejectedValue`
 * (which by construction cannot leak) asserted within `container` — could not
 * have caught this.
 */
describe("MarkdownPreview — a failed diagram leaves nothing on document.body", () => {
  const doc = `${F}mermaid\ngraph TD; A-->B;\n${F}`;

  /** A jison parse error, shaped exactly as mermaid 11.16.1 throws one. */
  function parseError(): Error {
    return Object.assign(new Error("Parse error on line 3:\n…\n----^\nExpecting …"), {
      hash: {
        text: "\n",
        token: "NEWLINE",
        line: 3,
        loc: { first_line: 3, last_line: 3, first_column: 32, last_column: 44 },
        expected: ["'SOLID_ARROW'", "'DOTTED_ARROW'", "'SOLID_CROSS'", "'SOLID_POINT'"],
      },
    });
  }

  /**
   * mermaid's leak, at the module boundary: `render(id, text)` with no
   * container argument builds the diagram in a temp `<div id="d{id}">` appended
   * to `document.body`, paints the bomb into it, and throws before its cleanup.
   * Returns the ids it was called with, so the assertions never have to guess
   * at the component's monotonic counter.
   */
  function leakThenReject(error: unknown): string[] {
    const ids: string[] = [];
    mermaidMock.render.mockImplementation((id: string) => {
      ids.push(id);
      const temp = document.createElement("div");
      temp.id = `d${id}`;
      temp.textContent = "Syntax error in text";
      document.body.append(temp);
      return Promise.reject(error);
    });
    return ids;
  }

  /** Leftover temp divs, however they got there. */
  const stranded = (): Element[] =>
    Array.from(document.body.querySelectorAll('[id^="dmdp-mermaid-"]'));

  afterEach(() => {
    // AFTER every assertion (afterEach runs post-test), so one leaking test
    // cannot cascade into its neighbours and turn one red into five.
    for (const el of stranded()) el.remove();
  });

  it("sweeps up the temp node mermaid strands when a diagram fails", async () => {
    const ids = leakThenReject(parseError());
    const { container } = render(<MarkdownPreview text={doc} />);
    await waitFor(() =>
      expect(container.querySelector(".markdown-preview__diagram-error")).not.toBeNull(),
    );

    expect(ids).toHaveLength(1);
    expect(document.getElementById(`d${ids[0]}`)).toBeNull();
    expect(stranded()).toEqual([]);
    // Text search too, not just the id: the visible symptom was the GRAPHIC,
    // and an id-only assertion would pass a fix that merely renamed the node.
    expect(document.body.textContent).not.toContain("Syntax error in text");

    // Two-sided: the fixture really does leak. Drive the same
    // mock directly — no component, so no sweep — and the node stays.
    await expect(mermaidMock.render("mdp-mermaid-probe", "x")).rejects.toThrow();
    expect(document.getElementById("dmdp-mermaid-probe")).not.toBeNull();
  });

  it("does not accumulate them across mount / unmount cycles", async () => {
    // The graphic stuck on every screen: `Pane` mounts only the ACTIVE
    // tab, so every switch away and back re-runs the hydration with a fresh
    // monotonic id — and mermaid's own `removeExistingElements` only reclaims a
    // node of the SAME id, so the count was unbounded over a session.
    const ids = leakThenReject(parseError());
    for (let pass = 0; pass < 3; pass++) {
      const { container, unmount } = render(<MarkdownPreview text={doc} />);
      await waitFor(() =>
        expect(container.querySelector(".markdown-preview__diagram-error")).not.toBeNull(),
      );
      unmount();
    }
    // Three distinct renders really happened — the ids prove the passes were
    // not deduplicated by something upstream of the leak.
    expect(new Set(ids).size).toBe(3);
    expect(stranded()).toEqual([]);
    expect(document.body.textContent).not.toContain("Syntax error in text");
  });

  it("leaves nothing behind when a diagram SUCCEEDS either", async () => {
    // Same sweep, success path: the `finally` runs on both, and mermaid has
    // already removed its own node, so the lookup must simply find nothing
    // rather than throw.
    mermaidMock.render.mockResolvedValue({ svg: "<svg><g></g></svg>" });
    const { container } = render(<MarkdownPreview text={doc} />);
    await waitFor(() =>
      expect(
        container.querySelector(".markdown-preview__mermaid--rendered"),
      ).not.toBeNull(),
    );
    expect(stranded()).toEqual([]);
  });

  it("does not re-render a block that already failed", async () => {
    // The retry amplifier. The hydration effect re-runs whenever `isControlled`
    // flips, over a DOM React has NOT re-injected (the html string is
    // unchanged), so without an "already dealt with" marker on the failed block
    // the pass reads the error note's own prose back out of `textContent` and
    // feeds it to mermaid as diagram source — a fresh id, a fresh leak, and
    // "Diagram error" stacking on itself, on every pass.
    mermaidMock.render.mockRejectedValue(parseError());
    const { container, rerender } = render(<MarkdownPreview text={doc} />);
    await waitFor(() =>
      expect(container.querySelector(".markdown-preview__diagram-error")).not.toBeNull(),
    );
    expect(mermaidMock.render).toHaveBeenCalledTimes(1);

    rerender(<MarkdownPreview text={doc} zoom={1} onZoomChange={vi.fn()} />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(mermaidMock.render).toHaveBeenCalledTimes(1);
    expect(container.querySelectorAll(".markdown-preview__diagram-error")).toHaveLength(1);
    // And the source beneath the note is still the DIAGRAM, not the note's prose.
    expect(container.querySelector(".markdown-preview__diagram-source")).toHaveTextContent(
      "graph TD",
    );
  });
});

/**
 * What the inline note SAYS. It used to be a bare "Diagram error"
 * next to the source — true, and useless: a real diagram had to be diagnosed
 * by hand (it was a `;` inside a `Note` line, which the sequence
 * grammar reads as a statement separator). The thrown error already carries the
 * line, the token and what the parser expected there.
 */
describe("MarkdownPreview — what a diagram error says", () => {
  const doc = `${F}mermaid\nsequenceDiagram\n  Note over A: a; b\n${F}`;

  const failWith = async (error: unknown): Promise<HTMLElement> => {
    mermaidMock.render.mockRejectedValue(error);
    const { container } = render(<MarkdownPreview text={doc} />);
    await waitFor(() =>
      expect(container.querySelector(".markdown-preview__diagram-error")).not.toBeNull(),
    );
    return container.querySelector<HTMLElement>(".markdown-preview__mermaid--error")!;
  };

  it("names the line and the token for a parse error", async () => {
    const block = await failWith(
      Object.assign(new Error("Parse error on line 3:\n…"), {
        hash: {
          token: "NEWLINE",
          // 🔴 `line` and `loc.first_line` DISAGREE, and this pair is not
          // invented: measured against mermaid 11.16.1, a flowchart failure on
          // the third line reports `line: 2` (jison's 0-based `yylineno`) and
          // `first_line: 3`, and only `loc` agrees with mermaid's own
          // "Parse error on line 3:". Reading `hash.line` would be off by one.
          line: 2,
          loc: { first_line: 3 },
          expected: ["'SOLID_ARROW'", "'DOTTED_ARROW'", "'SOLID_CROSS'", "'SOLID_POINT'"],
        },
      }),
    );
    // "of the diagram", because the number is relative to the FENCE BODY, not
    // to the markdown document the user is looking at.
    expect(block.querySelector(".markdown-preview__diagram-error")).toHaveTextContent(
      "Diagram error — line 3 of the diagram",
    );
    expect(block.querySelector(".markdown-preview__diagram-detail")).toHaveTextContent(
      "Unexpected NEWLINE — expected SOLID_ARROW, DOTTED_ARROW, SOLID_CROSS (and 1 more).",
    );
    // The source is still there for the line number to point at.
    expect(block.querySelector(".markdown-preview__diagram-source")).toHaveTextContent(
      "Note over A: a; b",
    );
  });

  it("reads the line out of the message when a LEXICAL error carries no loc", async () => {
    // Measured shape: `{ text: "", token: null, line: 1 }` — no `loc`, no
    // `expected`, and `line` one BELOW the number mermaid itself prints. The
    // formatted message is the only place the real number exists on this path.
    const block = await failWith(
      Object.assign(
        new Error("Lexical error on line 2. Unrecognized text.\ngraph TD  A --> ]B[\n---^"),
        { hash: { text: "", token: null, line: 1 } },
      ),
    );
    expect(block.querySelector(".markdown-preview__diagram-error")).toHaveTextContent(
      "Diagram error — line 2 of the diagram",
    );
    // No token, so nothing to say about one — silence beats "Unexpected null".
    expect(block.querySelector(".markdown-preview__diagram-detail")).toBeNull();
  });

  it("names every expectation when there are few enough to name", async () => {
    // The "(and N more)" tail is for the 27-entry sequence-grammar wall, not for
    // a flowchart's handful. A short list must not sprout "(and 0 more)".
    const block = await failWith(
      Object.assign(new Error("Parse error on line 1:"), {
        hash: { token: "TAGEND", loc: { first_line: 1 }, expected: ["'NODE_STRING'", "'SEMI'"] },
      }),
    );
    const detail = block.querySelector(".markdown-preview__diagram-detail");
    expect(detail).toHaveTextContent("Unexpected TAGEND — expected NODE_STRING, SEMI.");
    expect(detail!.textContent).not.toContain("more");
  });

  it("says a token with no expectations plainly, however the hash omits them", async () => {
    // Both shapes, because both occur: an EMPTY list and no `expected` key at
    // all (a lexical failure carries neither `loc` nor `expected`).
    const empty = await failWith(
      Object.assign(new Error("Parse error on line 1:"), {
        hash: { token: "TAGEND", loc: { first_line: 1 }, expected: [] },
      }),
    );
    expect(empty.querySelector(".markdown-preview__diagram-detail")).toHaveTextContent(
      "Unexpected TAGEND.",
    );

    const absent = await failWith(
      Object.assign(new Error("Parse error on line 1:"), {
        hash: { token: "TAGEND", loc: { first_line: 1 } },
      }),
    );
    expect(absent.querySelector(".markdown-preview__diagram-detail")).toHaveTextContent(
      "Unexpected TAGEND.",
    );
  });

  it("falls back to a bare note when the failure carries no parse info", async () => {
    // A failure on the DRAW path is an ordinary Error with no `hash` at all —
    // and so is anything a future mermaid throws. The note must stay calm
    // rather than print "line NaN of the diagram".
    const block = await failWith(new Error("Cannot read properties of null"));
    const note = block.querySelector(".markdown-preview__diagram-error");
    expect(note).toHaveTextContent("Diagram error");
    expect(note!.textContent).not.toContain("line");
    expect(block.querySelector(".markdown-preview__diagram-detail")).toBeNull();
    expect(block.querySelector(".markdown-preview__diagram-source")).toHaveTextContent(
      "sequenceDiagram",
    );
  });

  it("survives a rejection that is not an Error at all", async () => {
    const block = await failWith("something went wrong");
    expect(block.querySelector(".markdown-preview__diagram-error")).toHaveTextContent(
      "Diagram error",
    );
    expect(block.querySelector(".markdown-preview__diagram-detail")).toBeNull();
  });

  it("survives a rejection with no value at all", async () => {
    // `Promise.reject()` — nothing to read a line, a token or even a message
    // out of. The floor of the fallback chain, and the one shape where a naive
    // `String(error)` would print "undefined" into the note.
    const block = await failWith(undefined);
    expect(block.querySelector(".markdown-preview__diagram-error")).toHaveTextContent(
      "Diagram error",
    );
    expect(block.querySelector(".markdown-preview__diagram-error")!.textContent).not.toContain(
      "undefined",
    );
    expect(block.querySelector(".markdown-preview__diagram-detail")).toBeNull();
  });
});

/**
 * Regression guard for the un-hydration bug: clicking the preview
 * focuses the pane, which re-renders the editor, which re-rendered this
 * component — and React 19 re-assigns `innerHTML` whenever the
 * `dangerouslySetInnerHTML` prop OBJECT is a new reference (it never compares
 * the `__html` strings). That wiped every post-mount mutation — the mermaid SVG
 * reverted to its raw source text, inlined images lost their data URLs — and it
 * was permanent, because the hydration effects are keyed on the unchanged HTML.
 *
 * These tests re-render with the SAME text and assert the hydrated DOM survives.
 * They exercise React's real prop diffing, so they fail if the memoised
 * `htmlProp` is ever inlined back into the JSX.
 */
describe("MarkdownPreview — hydration survives unrelated re-renders", () => {
  const doc = `${F}mermaid\ngraph TD; A-->B;\n${F}`;

  it("keeps the mermaid SVG when the zoom changes", async () => {
    mermaidMock.render.mockResolvedValue({
      svg: '<svg data-testid="mermaid-svg"><g></g></svg>',
    });

    const { container, rerender } = render(<MarkdownPreview text={doc} zoom={1} />);
    await waitFor(() =>
      expect(
        container.querySelector(".markdown-preview__mermaid--rendered"),
      ).not.toBeNull(),
    );

    // A zoom step, then a reset — the diagram source used to show
    // after the zoom was reset. Same text ⇒ same HTML ⇒ the SVG must persist.
    rerender(<MarkdownPreview text={doc} zoom={1.25} />);
    rerender(<MarkdownPreview text={doc} zoom={1} />);

    // Re-query: a re-injected innerHTML DETACHES the old <pre>, which keeps its
    // SVG. Asserting on a stale reference would pass while the DOM is broken.
    const block = container.querySelector<HTMLElement>(".markdown-preview__mermaid")!;
    expect(block.querySelector("svg")).not.toBeNull();
    expect(block).toHaveClass("markdown-preview__mermaid--rendered");
    expect(block.textContent).not.toContain("graph TD");
    // Nothing was re-injected, so no second hydration pass was needed.
    expect(mermaidMock.render).toHaveBeenCalledTimes(1);
  });

  it("keeps the mermaid SVG across a re-render with an unchanged callback-less prop set", async () => {
    mermaidMock.render.mockResolvedValue({
      svg: '<svg data-testid="mermaid-svg"><g></g></svg>',
    });

    const { container, rerender } = render(<MarkdownPreview text={doc} />);
    await waitFor(() =>
      expect(
        container.querySelector(".markdown-preview__mermaid--rendered"),
      ).not.toBeNull(),
    );

    // A fresh `onZoomChange` arrow on every parent render — exactly what
    // CodeEditor passes — must not disturb the injected subtree either.
    rerender(<MarkdownPreview text={doc} onZoomChange={() => {}} />);
    rerender(<MarkdownPreview text={doc} onZoomChange={() => {}} />);

    const block = container.querySelector<HTMLElement>(".markdown-preview__mermaid")!;
    expect(block.querySelector("svg")).not.toBeNull();
    expect(block).toHaveClass("markdown-preview__mermaid--rendered");
    expect(mermaidMock.render).toHaveBeenCalledTimes(1);
  });

  it("keeps an inlined image's data URL across a re-render", async () => {
    workspaceIpc.readImageDataUrl.mockResolvedValue("data:image/png;base64,ZZZ");
    const text = "![alt](pics/logo.png)";

    const { container, rerender } = render(
      <MarkdownPreview text={text} basePath="/work/docs" zoom={1} />,
    );
    await waitFor(() =>
      expect(container.querySelector("img")).toHaveAttribute(
        "src",
        "data:image/png;base64,ZZZ",
      ),
    );

    rerender(<MarkdownPreview text={text} basePath="/work/docs" zoom={1.5} />);

    expect(container.querySelector("img")).toHaveAttribute(
      "src",
      "data:image/png;base64,ZZZ",
    );
  });

  it("DOES re-render and re-hydrate when the source actually changes", async () => {
    mermaidMock.render.mockResolvedValue({
      svg: '<svg data-testid="mermaid-svg"><g></g></svg>',
    });

    const { container, rerender } = render(<MarkdownPreview text={doc} />);
    await waitFor(() =>
      expect(
        container.querySelector(".markdown-preview__mermaid--rendered"),
      ).not.toBeNull(),
    );

    const edited = `${F}mermaid\ngraph TD; A-->C;\n${F}`;
    rerender(<MarkdownPreview text={edited} />);

    // Fresh HTML ⇒ React re-injects ⇒ the effect hydrates the new block.
    await waitFor(() => expect(mermaidMock.render).toHaveBeenCalledTimes(2));
    expect(mermaidMock.render).toHaveBeenLastCalledWith(
      expect.stringContaining("mdp-mermaid-"),
      expect.stringContaining("A-->C"),
    );
    await waitFor(() =>
      expect(
        container.querySelector(".markdown-preview__mermaid--rendered"),
      ).not.toBeNull(),
    );
  });
});

describe("MarkdownPreview — image src resolution", () => {
  it("resolves a relative image src against basePath", () => {
    const { container } = render(
      <MarkdownPreview text={"![alt](pics/logo.png)"} basePath="/work/docs/" />,
    );
    expect(container.querySelector("img")).toHaveAttribute("src", "/work/docs/pics/logo.png");
  });

  it("leaves a remote image src untouched even with basePath", () => {
    const { container } = render(
      <MarkdownPreview
        text={"![alt](https://cdn.example.com/logo.png)"}
        basePath="/work/docs"
      />,
    );
    expect(container.querySelector("img")).toHaveAttribute(
      "src",
      "https://cdn.example.com/logo.png",
    );
  });

  it("leaves a relative image src untouched when no basePath is given", () => {
    const { container } = render(<MarkdownPreview text={"![alt](pics/logo.png)"} />);
    expect(container.querySelector("img")).toHaveAttribute("src", "pics/logo.png");
  });
});

describe("MarkdownPreview — local image inlining", () => {
  it("inlines a local image as a data URL via the scoped read", async () => {
    workspaceIpc.readImageDataUrl.mockResolvedValue("data:image/png;base64,ZZZ");
    const { container } = render(
      <MarkdownPreview text={"![alt](pics/logo.png)"} basePath="/work/docs" />,
    );
    // The render rule first resolves the relative src to an absolute path…
    await waitFor(() =>
      expect(container.querySelector("img")).toHaveAttribute(
        "src",
        "data:image/png;base64,ZZZ",
      ),
    );
    // …and the effect reads THAT absolute path through the scoped IPC.
    expect(workspaceIpc.readImageDataUrl).toHaveBeenCalledWith("/work/docs/pics/logo.png");
  });

  it("inlines a relative image under a WINDOWS base — read at `C:\\…\\…`, the src never dropped", async () => {
    // DOMPurify strips `src="C:\…"` (it reads `C:` as a URL scheme); before the fix the
    // inliner then saw no src and the image rendered as nothing.
    workspaceIpc.readImageDataUrl.mockResolvedValue("data:image/png;base64,WIN");
    const { container } = render(
      <MarkdownPreview text={"![alt](pics/logo.png)"} basePath={"C:\\work\\docs"} />,
    );
    await waitFor(() =>
      expect(container.querySelector("img")).toHaveAttribute("src", "data:image/png;base64,WIN"),
    );
    expect(workspaceIpc.readImageDataUrl).toHaveBeenCalledWith("C:\\work\\docs\\pics\\logo.png");
  });

  it("never treats a Windows-absolute or UNC src as relative to the base", async () => {
    workspaceIpc.readImageDataUrl.mockResolvedValue("data:image/png;base64,ABS");
    render(<MarkdownPreview text={'<img src="\\\\srv\\share\\a.png">'} basePath={"C:\\work\\docs"} />);
    await waitFor(() => expect(workspaceIpc.readImageDataUrl).toHaveBeenCalledWith("\\\\srv\\share\\a.png"));
  });

  it("does not read a remote image (leaves it to load directly)", async () => {
    const { container } = render(
      <MarkdownPreview text={"![alt](https://cdn.example.com/logo.png)"} basePath="/work/docs" />,
    );
    // Give the effect a chance to run; it must skip the remote src.
    await Promise.resolve();
    expect(workspaceIpc.readImageDataUrl).not.toHaveBeenCalled();
    expect(container.querySelector("img")).toHaveAttribute(
      "src",
      "https://cdn.example.com/logo.png",
    );
  });

  it("skips an image with an empty src", async () => {
    // No basePath, so the render rule leaves the empty `src` as-is → the effect's
    // `!src` guard skips it (no read attempted).
    render(<MarkdownPreview text={"![alt]()"} />);
    await Promise.resolve();
    expect(workspaceIpc.readImageDataUrl).not.toHaveBeenCalled();
  });

  it("leaves the <img> as-is when the scoped read fails", async () => {
    workspaceIpc.readImageDataUrl.mockRejectedValue(new Error("outside allowed roots"));
    const { container } = render(
      <MarkdownPreview text={"![alt](pics/logo.png)"} basePath="/work/docs" />,
    );
    await waitFor(() => expect(workspaceIpc.readImageDataUrl).toHaveBeenCalled());
    // The read failed → the resolved absolute path is left in place (broken image).
    expect(container.querySelector("img")).toHaveAttribute("src", "/work/docs/pics/logo.png");
  });

  it("does not touch the DOM if unmounted before the read resolves", async () => {
    let resolve!: (v: string) => void;
    workspaceIpc.readImageDataUrl.mockReturnValue(
      new Promise<string>((r) => {
        resolve = r;
      }),
    );
    const { container, unmount } = render(
      <MarkdownPreview text={"![alt](pics/logo.png)"} basePath="/work/docs" />,
    );
    const img = container.querySelector("img");
    unmount(); // cancels the in-flight inline
    resolve("data:image/png;base64,LATE");
    await Promise.resolve();
    // The detached node keeps the pre-read src — the cancelled guard held.
    expect(img).toHaveAttribute("src", "/work/docs/pics/logo.png");
  });
});

describe("MarkdownPreview — canvas zoom (ctrl/cmd+wheel)", () => {
  it("renders the zoom prop as CSS zoom; default is an inert zoom:1", () => {
    const { container, rerender } = render(<MarkdownPreview text="# Z" zoom={2} />);
    const body = container.querySelector<HTMLElement>(".markdown-preview__body");
    expect(body!.style.zoom).toBe("2");
    // …and publishes the same number to CSS: the diagram's fit-the-pane ceiling
    // is `calc(100% * var(--mdp-zoom))`, so without this a zoomed diagram would
    // stay exactly the same size on screen.
    expect(body!.style.getPropertyValue("--mdp-zoom")).toBe("2");

    rerender(<MarkdownPreview text="# Z" />);
    expect(body!.style.zoom).toBe("1");
  });

  it("ctrl+wheel reports wheelPreviewZoom's next zoom and prevents the default", () => {
    const onZoomChange = vi.fn();
    render(<MarkdownPreview text="# Z" zoom={1} onZoomChange={onZoomChange} />);

    const evt = wheel(screen.getByTestId("markdown-preview"), { ctrlKey: true, deltaY: -100 });

    expect(onZoomChange).toHaveBeenCalledTimes(1);
    expect(onZoomChange).toHaveBeenCalledWith(wheelPreviewZoom(1, -100, evt.deltaMode));
    expect(evt.defaultPrevented).toBe(true);
  });

  it("meta+wheel zooms too (the house ctrl-or-meta idiom)", () => {
    const onZoomChange = vi.fn();
    render(<MarkdownPreview text="# Z" zoom={2} onZoomChange={onZoomChange} />);

    const evt = wheel(screen.getByTestId("markdown-preview"), { metaKey: true, deltaY: 100 });

    expect(onZoomChange).toHaveBeenCalledWith(wheelPreviewZoom(2, 100, evt.deltaMode));
    expect(evt.defaultPrevented).toBe(true);
  });

  it("a plain wheel is left alone: no zoom, no preventDefault", () => {
    const onZoomChange = vi.fn();
    render(<MarkdownPreview text="# Z" zoom={1} onZoomChange={onZoomChange} />);

    const evt = wheel(screen.getByTestId("markdown-preview"), { deltaY: -100 });

    expect(onZoomChange).not.toHaveBeenCalled();
    expect(evt.defaultPrevented).toBe(false);
  });

  it("without onZoomChange the gesture is fully inert (no throw, no preventDefault)", () => {
    render(<MarkdownPreview text="# Z" zoom={1} />);

    const evt = wheel(screen.getByTestId("markdown-preview"), { ctrlKey: true, deltaY: -100 });

    expect(evt.defaultPrevented).toBe(false);
  });

  it("at the clamp rail it stays silent but STILL eats the event (no webview pinch)", () => {
    const onZoomChange = vi.fn();
    render(<MarkdownPreview text="# Z" zoom={4} onZoomChange={onZoomChange} />);

    // zoom=4 is PREVIEW_ZOOM_MAX; zooming in further is a no-op…
    const evt = wheel(screen.getByTestId("markdown-preview"), { ctrlKey: true, deltaY: -100 });

    expect(onZoomChange).not.toHaveBeenCalled();
    // …but the default is still prevented, or the webview would pinch-zoom the UI.
    expect(evt.defaultPrevented).toBe(true);
  });

  it("anchors the content under the cursor: the controlled round-trip adjusts scroll", () => {
    const onZoomChange = vi.fn();
    const { rerender } = render(
      <MarkdownPreview text="# Z" zoom={1} onZoomChange={onZoomChange} />,
    );
    const el = screen.getByTestId("markdown-preview");
    stubScroll(el);

    wheel(el, { ctrlKey: true, deltaY: -100, clientX: 120, clientY: 80 });
    const next = wheelPreviewZoom(1, -100, 0);
    expect(onZoomChange).toHaveBeenCalledWith(next);
    // Nothing scrolls until the parent commits the new zoom (fully controlled).
    expect(el.scrollLeft).toBe(0);
    expect(el.scrollTop).toBe(0);

    // The parent round-trips the zoom back in, as EditorView does via the store.
    rerender(<MarkdownPreview text="# Z" zoom={next} onZoomChange={onZoomChange} />);
    // jsdom rects are 0×0, so the unscaled cursor offset is clientX/zoom — the
    // stubScroll caveat applies: this pins the arithmetic, not real geometry.
    expect(el.scrollLeft).toBe(anchorScrollDelta(120 / 1, 1, next));
    expect(el.scrollTop).toBe(anchorScrollDelta(80 / 1, 1, next));
  });

  it("a zoom change WITHOUT a wheel gesture (− / + buttons) leaves scroll untouched", () => {
    const { rerender } = render(<MarkdownPreview text="# Z" zoom={1} />);
    const el = screen.getByTestId("markdown-preview");
    stubScroll(el);

    rerender(<MarkdownPreview text="# Z" zoom={2} />);

    expect(el.scrollLeft).toBe(0);
    expect(el.scrollTop).toBe(0);
  });

  it("zooming the empty state changes the zoom but has no body to anchor", () => {
    const onZoomChange = vi.fn();
    const { rerender } = render(
      <MarkdownPreview text="" zoom={1} onZoomChange={onZoomChange} />,
    );
    const el = screen.getByTestId("markdown-preview");
    stubScroll(el);

    const evt = wheel(el, { ctrlKey: true, deltaY: -100, clientX: 120, clientY: 80 });
    const next = wheelPreviewZoom(1, -100, 0);
    expect(onZoomChange).toHaveBeenCalledWith(next);
    expect(evt.defaultPrevented).toBe(true);

    // No `.markdown-preview__body` exists → no anchor was queued.
    rerender(<MarkdownPreview text="" zoom={next} onZoomChange={onZoomChange} />);
    expect(el.scrollLeft).toBe(0);
    expect(el.scrollTop).toBe(0);
  });
});

/**
 * The per-diagram "Fit" control (a button over the diagram that zooms it
 * automatically, to 50% in some cases and 200% in others). Both of those
 * numbers come out of one rule, so the tests below drive the same
 * click into a pane the diagram overflows and a pane it under-fills.
 *
 * Two things about the control are structural rather than cosmetic, and each
 * gets its own case: it exists ONLY on a block that really became a diagram
 * (nothing else can be measured), and only when zoom is controlled (otherwise
 * the button is a dead affordance). The click itself is handled by DELEGATION
 * from the container — the button carries no closure — so these tests dispatch
 * a real click on the button and let it bubble.
 */
describe("MarkdownPreview — per-diagram Fit control", () => {
  const doc = `${F}mermaid\ngraph TD; A-->B;\n${F}`;
  const DIAGRAM_SVG = '<svg data-testid="mermaid-svg"><g></g></svg>';

  /**
   * Render controlled and wait for the diagram to hydrate — the only state in
   * which the control exists at all. Returns the scrolling container, which is
   * both what gets measured and what the delegated listener sits on.
   */
  const renderFitted = async (
    onZoomChange: (zoom: number) => void,
    zoom = 1,
  ): Promise<HTMLElement> => {
    mermaidMock.render.mockResolvedValue({ svg: DIAGRAM_SVG });
    const { container } = render(
      <MarkdownPreview text={doc} zoom={zoom} onZoomChange={onZoomChange} />,
    );
    await waitFor(() =>
      expect(container.querySelector(".markdown-preview__mermaid--rendered")).not.toBeNull(),
    );
    return screen.getByTestId("markdown-preview");
  };

  /**
   * The delegated listener sits on the container, so it runs for EVERY click in
   * the preview — including in documents and modes where no Fit control exists.
   * Its two early bails are what make that safe, and both are reachable from
   * user content rather than being unreachable belt-and-braces.
   */
  it("an uncontrolled preview ignores clicks instead of throwing", async () => {
    // No `onZoomChange`, so no control is rendered — but the handler is still
    // bound and still fires. The `!onZoomChange` bail is also what narrows the
    // optional prop for the call at the end, so it cannot simply be deleted.
    mermaidMock.render.mockResolvedValue({ svg: DIAGRAM_SVG });
    const { container } = render(<MarkdownPreview text={doc} zoom={1} />);
    await waitFor(() =>
      expect(container.querySelector(".markdown-preview__mermaid--rendered")).not.toBeNull(),
    );
    const block = container.querySelector<HTMLElement>(".markdown-preview__mermaid")!;

    expect(errorsDuring(() => fireEvent.click(block))).toEqual([]);
    // Two-sided: the diagram really did hydrate, so this is a click on a real
    // rendered diagram — not a vacuous pass on an empty preview.
    expect(block.querySelector("svg")).not.toBeNull();
  });

  it("ignores a `data-mdp-fit` element the DOCUMENT supplied, outside any diagram", async () => {
    // markdown-it runs with html:true and DOMPurify keeps `data-*`, so a README
    // can contain the very attribute the delegation matches on. Walking up from
    // it finds no diagram to measure, and the handler must decline rather than
    // read dimensions off `null`.
    const onZoomChange = vi.fn();
    render(
      <MarkdownPreview
        text={'<button data-mdp-fit type="button">Not a real control</button>'}
        zoom={1}
        onZoomChange={onZoomChange}
      />,
    );

    const impostor = screen.getByRole("button", { name: "Not a real control" });
    expect(impostor).toHaveAttribute("data-mdp-fit"); // the hook really survived
    // Not `not.toThrow()` — see errorsDuring: React would swallow the throw and
    // this test would pass against a handler that crashes on every click.
    expect(errorsDuring(() => fireEvent.click(impostor))).toEqual([]);
    expect(onZoomChange).not.toHaveBeenCalled();
  });

  it("pins a Fit control inside a diagram that rendered", async () => {
    const preview = await renderFitted(vi.fn());

    const btn = screen.getByRole("button", { name: "Fit diagram to pane" });
    expect(btn).toHaveTextContent("Fit");
    // Inside the BLOCK, not merely somewhere in the preview: the delegated
    // handler walks up from the button to find the diagram it must measure, so
    // a control parked outside the `<pre>` would be inert.
    expect(preview.querySelector(".markdown-preview__mermaid")).toContainElement(btn);
    // The attribute is the hook the delegation matches on — not decoration.
    expect(btn).toHaveAttribute("data-mdp-fit");
  });

  it("adds no control to a diagram that failed to parse", async () => {
    mermaidMock.render.mockRejectedValue(new Error("parse error"));
    const { container } = render(
      <MarkdownPreview text={doc} zoom={1} onZoomChange={vi.fn()} />,
    );
    await waitFor(() =>
      expect(container.querySelector(".markdown-preview__diagram-error")).not.toBeNull(),
    );

    // Controlled on purpose: the control is missing because there is no diagram
    // to fit, not because there is no zoom to set (that is the next case).
    // Fitting the pane to an error note is meaningless.
    expect(screen.queryByTestId("diagram-fit")).toBeNull();
  });

  it("adds no control until the diagram has actually hydrated", async () => {
    let resolveRender!: (value: { svg: string }) => void;
    mermaidMock.render.mockReturnValue(
      new Promise<{ svg: string }>((resolve) => {
        resolveRender = resolve;
      }),
    );
    const { container } = render(
      <MarkdownPreview text={doc} zoom={1} onZoomChange={vi.fn()} />,
    );
    await waitFor(() => expect(mermaidMock.render).toHaveBeenCalled());

    // Mid-flight the block is still raw source. A control here would sit on a
    // <pre> of text and "fit" the pane to a paragraph.
    expect(screen.queryByTestId("diagram-fit")).toBeNull();
    expect(container.querySelector(".markdown-preview__mermaid")).toHaveTextContent("graph TD");

    resolveRender({ svg: DIAGRAM_SVG });
    await waitFor(() => expect(screen.getByTestId("diagram-fit")).toBeInTheDocument());
  });

  it("adds no control at all when the preview is uncontrolled", async () => {
    mermaidMock.render.mockResolvedValue({ svg: DIAGRAM_SVG });
    const { container } = render(<MarkdownPreview text={doc} zoom={1} />);
    await waitFor(() =>
      expect(container.querySelector(".markdown-preview__mermaid--rendered")).not.toBeNull(),
    );

    // Two-sided: the diagram DID hydrate, so the absence is the isControlled
    // guard and not a diagram that never arrived. With no `onZoomChange` there
    // is no zoom to set, and the button would be a dead affordance.
    expect(container.querySelector("svg")).not.toBeNull();
    expect(screen.queryByTestId("diagram-fit")).toBeNull();
  });

  it("clicking Fit zooms OUT so a diagram wider than the pane fits", async () => {
    const onZoomChange = vi.fn();
    const preview = await renderFitted(onZoomChange);
    // A 960×380 diagram in a 500×400 pane with 10px padding → a 480×380 CONTENT
    // box. The padding is load-bearing here: fitting to the client box instead
    // would land on ≈0.52, not 50%.
    stubFitGeometry(preview, {
      client: { width: 500, height: 400 },
      padding: 10,
      diagram: { width: 960, height: 380 },
    });

    fireEvent.click(screen.getByTestId("diagram-fit"));

    const next = fitPreviewZoom(1, { width: 960, height: 380 }, { width: 480, height: 380 });
    expect(next).toBe(0.5); // the 50% case
    expect(onZoomChange).toHaveBeenCalledTimes(1);
    expect(onZoomChange).toHaveBeenCalledWith(next);
  });

  it("clicking Fit zooms IN so a diagram smaller than the pane fills it", async () => {
    const onZoomChange = vi.fn();
    const preview = await renderFitted(onZoomChange);
    // Same rule, opposite direction: a 240×190 diagram in the same 480×380
    // content box has room to double. This is the "other 200%".
    stubFitGeometry(preview, {
      client: { width: 500, height: 400 },
      padding: 10,
      diagram: { width: 240, height: 190 },
    });

    fireEvent.click(screen.getByTestId("diagram-fit"));

    expect(onZoomChange).toHaveBeenCalledWith(2);
  });

  it("fits from the CURRENT zoom, not from 100%", async () => {
    const onZoomChange = vi.fn();
    // The measurements are taken at the live zoom, so the ratio scales the zoom
    // that is in force. At 200% a diagram measuring 960 device px in a 480px
    // content box is twice too wide → the fit is 100%, not 50%.
    const preview = await renderFitted(onZoomChange, 2);
    stubFitGeometry(preview, {
      client: { width: 500, height: 400 },
      padding: 10,
      diagram: { width: 960, height: 380 },
    });

    fireEvent.click(screen.getByTestId("diagram-fit"));

    expect(onZoomChange).toHaveBeenCalledWith(1);
  });

  it("stays silent when the diagram already fits (no store churn)", async () => {
    const onZoomChange = vi.fn();
    const preview = await renderFitted(onZoomChange);
    // Exactly the content box: the computed zoom equals the current one.
    stubFitGeometry(preview, {
      client: { width: 500, height: 400 },
      padding: 10,
      diagram: { width: 480, height: 380 },
    });

    fireEvent.click(screen.getByTestId("diagram-fit"));

    // Reporting the same number back would re-render the editor (and, through
    // the store, persist) for nothing — a click that changes nothing must be a
    // no-op, not a round-trip.
    expect(onZoomChange).not.toHaveBeenCalled();
  });

  it("produces no zoom at all from a pane with no layout", async () => {
    const onZoomChange = vi.fn();
    await renderFitted(onZoomChange);

    // Nothing stubbed: jsdom measures 0×0 for both the diagram and the pane —
    // the same numbers a collapsed or not-yet-laid-out pane reports for real.
    // `fitPreviewZoom` returns the current zoom for a zero dimension and the
    // handler bails, so a garbage zoom never reaches the store, and the missing
    // measurements never throw.
    expect(() => fireEvent.click(screen.getByTestId("diagram-fit"))).not.toThrow();
    expect(onZoomChange).not.toHaveBeenCalled();
  });

  it("ignores an ordinary click elsewhere in the preview", async () => {
    const onZoomChange = vi.fn();
    const preview = await renderFitted(onZoomChange);
    // Stubbed deliberately: with 0×0 geometry this test would pass even if the
    // delegation matched every click, because the fit would bail on the zeros.
    // Real measurements make the assertion mean "the target was not the button".
    stubFitGeometry(preview, {
      client: { width: 500, height: 400 },
      padding: 10,
      diagram: { width: 960, height: 380 },
    });

    // Clicking the diagram itself — the exact gesture behind the re-render
    // un-hydration bug — reaches the same delegated listener as the button.
    fireEvent.click(preview.querySelector("svg") as SVGSVGElement);

    expect(onZoomChange).not.toHaveBeenCalled();
  });

  it("skips a block that is already hydrated when the effect re-runs", async () => {
    mermaidMock.render.mockResolvedValue({ svg: DIAGRAM_SVG });
    const { container, rerender } = render(<MarkdownPreview text={doc} zoom={1} />);
    await waitFor(() =>
      expect(container.querySelector(".markdown-preview__mermaid--rendered")).not.toBeNull(),
    );
    expect(mermaidMock.render).toHaveBeenCalledTimes(1);

    // The hydration effect is keyed on [html, isControlled], so zoom becoming
    // controlled re-runs it over a subtree that is ALREADY SVG. The `--rendered`
    // guard is what stops the second pass, and it is load-bearing: `source` is
    // read back from `textContent`, which after hydration is the SVG's own text
    // plus the "Fit" label — mermaid would be handed that garbage as a diagram,
    // and the block would collect a second control.
    rerender(<MarkdownPreview text={doc} zoom={1} onZoomChange={vi.fn()} />);
    await Promise.resolve();

    expect(mermaidMock.render).toHaveBeenCalledTimes(1);
    // Re-query: a re-injected innerHTML detaches the old <pre>,
    // which keeps its SVG and would happily answer for the live DOM.
    const block = container.querySelector<HTMLElement>(".markdown-preview__mermaid")!;
    expect(block.querySelectorAll("svg")).toHaveLength(1);
    expect(block.textContent).not.toContain("graph TD");
    // The honest consequence of that guard: a block hydrated while the preview
    // was UNCONTROLLED never gains a control retroactively. Inert in the app —
    // CodeEditor always passes `onZoomChange`, so a diagram hydrates controlled
    // or not at all — but a future caller that toggles the prop would see this.
    expect(screen.queryAllByTestId("diagram-fit")).toHaveLength(0);
  });
});

describe("MarkdownPreview — pan (ctrl/cmd+drag)", () => {
  afterEach(() => {
    // Defensive: end any drag a failed assertion left open so the window-level
    // listeners and the body class never leak into the next test.
    fireEvent(window, new MouseEvent("pointerup", { bubbles: true }));
    document.body.classList.remove("is-panning");
  });

  it("ctrl+drag scrolls against the cursor (grab semantics) and ends on pointerup", () => {
    render(<MarkdownPreview text="# Z" />);
    const el = screen.getByTestId("markdown-preview");
    stubScroll(el);

    fireEvent.pointerDown(el, { ctrlKey: true, button: 0, clientX: 100, clientY: 100 });
    expect(document.body.classList.contains("is-panning")).toBe(true);

    // Cursor moves 40 left / 20 up → content follows → scroll grows by 40/20.
    fireEvent(window, new MouseEvent("pointermove", { clientX: 60, clientY: 80, bubbles: true }));
    expect(el.scrollLeft).toBe(40);
    expect(el.scrollTop).toBe(20);

    fireEvent(window, new MouseEvent("pointerup", { bubbles: true }));
    expect(document.body.classList.contains("is-panning")).toBe(false);
    // Listeners were removed with the class — further moves change nothing.
    fireEvent(window, new MouseEvent("pointermove", { clientX: 0, clientY: 0, bubbles: true }));
    expect(el.scrollLeft).toBe(40);
    expect(el.scrollTop).toBe(20);
  });

  it("meta+drag pans too (the house ctrl-or-meta idiom)", () => {
    render(<MarkdownPreview text="# Z" />);
    const el = screen.getByTestId("markdown-preview");
    stubScroll(el);

    fireEvent.pointerDown(el, { metaKey: true, button: 0, clientX: 10, clientY: 10 });
    expect(document.body.classList.contains("is-panning")).toBe(true);

    fireEvent(window, new MouseEvent("pointermove", { clientX: 0, clientY: 5, bubbles: true }));
    expect(el.scrollLeft).toBe(10);
    expect(el.scrollTop).toBe(5);
  });

  it("a plain pointerdown does not pan", () => {
    render(<MarkdownPreview text="# Z" />);
    const el = screen.getByTestId("markdown-preview");
    stubScroll(el);

    fireEvent.pointerDown(el, { button: 0, clientX: 100, clientY: 100 });

    expect(document.body.classList.contains("is-panning")).toBe(false);
    fireEvent(window, new MouseEvent("pointermove", { clientX: 60, clientY: 80, bubbles: true }));
    expect(el.scrollLeft).toBe(0);
    expect(el.scrollTop).toBe(0);
  });

  it("a non-primary button does not pan even with the modifier held", () => {
    render(<MarkdownPreview text="# Z" />);
    const el = screen.getByTestId("markdown-preview");
    stubScroll(el);

    fireEvent.pointerDown(el, { ctrlKey: true, button: 1, clientX: 100, clientY: 100 });

    expect(document.body.classList.contains("is-panning")).toBe(false);
    fireEvent(window, new MouseEvent("pointermove", { clientX: 60, clientY: 80, bubbles: true }));
    expect(el.scrollLeft).toBe(0);
    expect(el.scrollTop).toBe(0);
  });

  it("unmount mid-drag does not crash; the drag still ends on pointerup (house pattern)", () => {
    const { unmount } = render(<MarkdownPreview text="# Z" />);
    const el = screen.getByTestId("markdown-preview");
    stubScroll(el);

    fireEvent.pointerDown(el, { ctrlKey: true, button: 0, clientX: 100, clientY: 100 });
    expect(document.body.classList.contains("is-panning")).toBe(true);

    unmount();
    // Mirrors RailResizer exactly: the window listeners + body class belong to
    // the DRAG, not the component — they clear on pointerup, not on unmount.
    expect(document.body.classList.contains("is-panning")).toBe(true);

    fireEvent(window, new MouseEvent("pointerup", { bubbles: true }));
    expect(document.body.classList.contains("is-panning")).toBe(false);
  });
});

/**
 * Find inside the RENDERED preview (search must work inside the rendered .md
 * file, not only in its source).
 *
 * This is the SEAM: `previewFind.ts` and `PreviewFindBar.tsx` are
 * each fully unit-tested on their own, and two 100%-covered halves do not add up
 * to a working feature. What is only assertable here is the join — that the key
 * reaches a handler at all, that the ranges come from THIS preview's DOM, that
 * the count is the count of addressable matches, and that closing retires the
 * highlights.
 *
 * Two things are asserted that look like implementation detail and are not:
 *
 *   - **Nothing is ever injected into the body.** That is the entire reason this
 *     uses `CSS.highlights` instead of `<mark>`s. A `<mark>` inside an
 *     un-hydrated ```mermaid block would be read back by the hydration pass as
 *     diagram SOURCE and rendered as *"Diagram error"* — a diagram broken
 *     **because the user searched** — and any injected node is erased outright
 *     by the next `innerHTML` assignment.
 *   - **The window-level fallback.** A strictly container-scoped handler is not
 *     the feature: the usual flow puts focus on a tree row or a tab, not in
 *     the preview, which is precisely why today's build answers Cmd+F with
 *     nothing.
 *
 * jsdom has no `CSS.highlights`, so `paintHighlights` is inert here by default;
 * where the painting itself is the claim the registry is stubbed, and the stub's
 * absence is asserted first so the test cannot pass by measuring nothing. The
 * real API is exercised in `previewFind.browser.test.tsx`.
 */
describe("MarkdownPreview — find in the rendered preview", () => {
  /** A Setlike stand-in for `Highlight`, enough for what is asserted below. */
  class FakeHighlight {
    priority = 0;
    readonly ranges: Range[];
    constructor(...ranges: Range[]) {
      this.ranges = ranges;
    }
  }

  /** Install a fake highlight API for one test; `afterEach` restores jsdom's. */
  const restores: (() => void)[] = [];
  function withHighlightApi(): Map<string, FakeHighlight> {
    const registry = new Map<string, FakeHighlight>();
    const g = globalThis as unknown as Record<string, unknown>;
    const savedCss = g.CSS;
    const savedHighlight = g.Highlight;
    g.CSS = { ...(savedCss as object), highlights: registry };
    g.Highlight = FakeHighlight;
    restores.push(() => {
      g.CSS = savedCss;
      g.Highlight = savedHighlight;
    });
    return registry;
  }

  afterEach(() => {
    while (restores.length > 0) restores.pop()!();
  });

  const DOC = [
    "# Release notes",
    "",
    "The **preview** renders markdown. The preview also zooms.",
    "",
    "- a preview list item",
  ].join("\n");

  /** Press Cmd+F on the preview itself (the container is focusable). */
  function pressFind(el: HTMLElement): void {
    el.focus();
    fireEvent.keyDown(el, { key: "f", metaKey: true });
  }

  /** Type into the open find bar. */
  function type(query: string): void {
    fireEvent.change(screen.getByTestId("preview-find-input"), {
      target: { value: query },
    });
  }

  const count = (): string => screen.getByTestId("preview-find-count").textContent ?? "";

  it("Cmd+F opens the bar and Escape closes it, clearing the query", () => {
    render(<MarkdownPreview text={DOC} />);
    const el = screen.getByTestId("markdown-preview");
    expect(screen.queryByTestId("preview-find")).toBeNull();

    pressFind(el);
    expect(screen.getByTestId("preview-find")).toBeInTheDocument();
    type("preview");
    expect(count()).toBe("1/3");

    fireEvent.keyDown(el, { key: "Escape" });

    expect(screen.queryByTestId("preview-find")).toBeNull();
    // Reopening WITH NOTHING SELECTED starts clean rather than restoring a
    // stale search. The qualifier is load-bearing: Cmd+F now
    // seeds from the selection, and `pressFind` focuses the container first —
    // which in jsdom collapses the selection — so this is the no-selection path
    // (the seeded one is its own describe below).
    pressFind(el);
    expect(screen.getByTestId("preview-find-input")).toHaveValue("");
  });

  it("Ctrl+F opens it too, and the key never reaches WebKit's own find", () => {
    render(<MarkdownPreview text={DOC} />);
    const el = screen.getByTestId("markdown-preview");
    el.focus();

    const evt = new KeyboardEvent("keydown", {
      key: "f",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    // A raw dispatch, not `fireEvent`, because `defaultPrevented` is only
    // observable on an event we hold — and `act` so React flushes the state
    // change the handler makes.
    act(() => void el.dispatchEvent(evt));

    expect(screen.getByTestId("preview-find")).toBeInTheDocument();
    expect(evt.defaultPrevented).toBe(true);
  });

  it("leaves every other key alone (Escape does nothing while the bar is shut)", () => {
    render(<MarkdownPreview text={DOC} />);
    const el = screen.getByTestId("markdown-preview");
    el.focus();

    const esc = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    act(() => void el.dispatchEvent(esc));

    expect(screen.queryByTestId("preview-find")).toBeNull();
    // Not swallowed: Esc closes panels and cancels renames elsewhere in the app.
    expect(esc.defaultPrevented).toBe(false);
  });

  it("counts matches in the RENDERED text, not in the markdown source", () => {
    render(<MarkdownPreview text={"# Title\n\n**bold** text"} />);
    pressFind(screen.getByTestId("markdown-preview"));

    // `**` never reaches the preview — it became a <strong>. Searching the
    // source would report a match here; searching what is on screen must not.
    type("**");
    expect(count()).toBe("0 results");

    type("bold");
    expect(count()).toBe("1/1");
  });

  it("finds a phrase that SPANS the markup (a bolded word splits the text run)", () => {
    render(<MarkdownPreview text={"the **bold** word"} />);
    pressFind(screen.getByTestId("markdown-preview"));

    type("bold word");

    expect(count()).toBe("1/1");
  });

  it("walks matches with ↑ / ↓ and wraps at both ends", () => {
    render(<MarkdownPreview text={DOC} />);
    pressFind(screen.getByTestId("markdown-preview"));
    type("preview");
    expect(count()).toBe("1/3");

    fireEvent.click(screen.getByTestId("preview-find-next"));
    expect(count()).toBe("2/3");
    fireEvent.click(screen.getByTestId("preview-find-next"));
    expect(count()).toBe("3/3");
    fireEvent.click(screen.getByTestId("preview-find-next"));
    expect(count()).toBe("1/3"); // wrapped forward

    fireEvent.click(screen.getByTestId("preview-find-prev"));
    expect(count()).toBe("3/3"); // wrapped backward
  });

  it("holds the cursor still when there is nothing to walk", () => {
    render(<MarkdownPreview text={DOC} />);
    pressFind(screen.getByTestId("markdown-preview"));
    type("nothing-matches-this");
    expect(count()).toBe("0 results");

    // The buttons are disabled, but the handler is reachable from Enter too.
    fireEvent.keyDown(screen.getByTestId("preview-find-input"), { key: "Enter" });

    expect(count()).toBe("0 results");
  });

  it("re-indexes when the SOURCE changes under an open search", () => {
    // A re-injected innerHTML detaches every node the old Ranges point into, so
    // the count has to be recomputed against the new DOM — not merely kept.
    const { rerender } = render(<MarkdownPreview text={DOC} />);
    pressFind(screen.getByTestId("markdown-preview"));
    type("preview");
    expect(count()).toBe("1/3");

    rerender(<MarkdownPreview text={`${DOC}\n\nOne more preview mention.`} />);

    expect(count()).toBe("1/4");
  });

  it("searches an empty preview without crashing (no body to index)", () => {
    render(<MarkdownPreview text="" />);
    expect(screen.getByText("Nothing to preview.")).toBeInTheDocument();

    pressFind(screen.getByTestId("markdown-preview"));
    type("anything");

    expect(count()).toBe("0 results");
  });

  it("paints every match and the current one, and retires both on close", () => {
    const registry = withHighlightApi();
    render(<MarkdownPreview text={DOC} />);
    pressFind(screen.getByTestId("markdown-preview"));

    type("preview");

    const all = registry.get("markdown-preview-find")!;
    const current = registry.get("markdown-preview-find-current")!;
    expect(all.ranges.map((r) => r.toString())).toEqual(["preview", "preview", "preview"]);
    expect(current.ranges.map((r) => r.toString())).toEqual(["preview"]);
    expect(current.ranges[0]).toBe(all.ranges[0]); // the cursor starts at the first

    fireEvent.click(screen.getByTestId("preview-find-next"));
    expect(registry.get("markdown-preview-find-current")!.ranges[0]).toBe(all.ranges[1]);

    fireEvent.click(screen.getByTestId("preview-find-close"));
    expect(registry.size).toBe(0);
  });

  it("retires the highlights when the preview unmounts", () => {
    // The registry is document-global: a closed tab that left colour behind
    // would paint over whatever opens next.
    const registry = withHighlightApi();
    const { unmount } = render(<MarkdownPreview text={DOC} />);
    pressFind(screen.getByTestId("markdown-preview"));
    type("preview");
    expect(registry.size).toBe(2);

    unmount();

    expect(registry.size).toBe(0);
  });

  it("never paints from a preview whose bar is shut (the registry is global)", () => {
    // Two-sided with the case above: an ungated paint effect would stamp two
    // empty highlights on mount and wipe the matches of a preview in another
    // split that HAS a bar open.
    const registry = withHighlightApi();
    render(<MarkdownPreview text={DOC} />);

    expect(registry.size).toBe(0);
  });

  it("INJECTS NOTHING into the body — the reason this uses Ranges, not <mark>", () => {
    const { container } = render(<MarkdownPreview text={DOC} />);
    const body = container.querySelector(".markdown-preview__body") as HTMLElement;
    const before = body.innerHTML;

    pressFind(screen.getByTestId("markdown-preview"));
    type("preview");
    expect(count()).toBe("1/3"); // it really did find them

    // Byte-identical. An injected <mark> would be erased by the next innerHTML
    // assignment and — worse — would be read back as mermaid
    // SOURCE by the hydration pass, turning a search into a "Diagram error".
    expect(body.innerHTML).toBe(before);
    expect(container.querySelectorAll("mark")).toHaveLength(0);
  });

  it("finds text in an un-hydrated ```mermaid block and still lets it render", async () => {
    // The hazard, end to end: the block is searchable while it is still source
    // on screen, and hydration afterwards produces a real diagram rather than
    // the parse error a mutated `textContent` would have caused.
    let resolveRender!: (value: { svg: string }) => void;
    mermaidMock.render.mockReturnValue(
      new Promise<{ svg: string }>((resolve) => {
        resolveRender = resolve;
      }),
    );
    const doc = `${F}mermaid\ngraph TD; Alpha-->Beta;\n${F}`;
    const { container } = render(<MarkdownPreview text={doc} />);
    await waitFor(() => expect(mermaidMock.render).toHaveBeenCalled());

    pressFind(screen.getByTestId("markdown-preview"));
    type("Alpha");
    expect(count()).toBe("1/1"); // the source IS on screen, so it IS findable

    resolveRender({ svg: '<svg data-testid="mermaid-svg"><g></g></svg>' });
    await waitFor(() =>
      expect(container.querySelector(".markdown-preview__mermaid--rendered")).not.toBeNull(),
    );

    expect(container.querySelector(".markdown-preview__diagram-error")).toBeNull();
    expect(mermaidMock.render).toHaveBeenCalledWith(
      expect.stringContaining("mdp-mermaid-"),
      "graph TD; Alpha-->Beta;\n",
    );
  });

  it("does not match the preview's OWN Fit control", async () => {
    // "Fit" is chrome we injected, not the document. Two-sided: the control is
    // really there, and a search for its label finds nothing.
    mermaidMock.render.mockResolvedValue({ svg: "<svg><g></g></svg>" });
    render(<MarkdownPreview text={`${F}mermaid\ngraph TD; A-->B;\n${F}`} onZoomChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("diagram-fit")).toBeInTheDocument());

    pressFind(screen.getByTestId("markdown-preview"));
    type("Fit");

    expect(count()).toBe("0 results");
  });

  /* ═══ Cmd/Ctrl+F seeds from the selection ══════════════════════════════════ */

  /**
   * Pressing Cmd+F with text selected must search for that selection.
   *
   * Same rule as the editor's own bar (`find/selectionSeed`), and the seed is
   * written through the same `patchBar({ query })` the input's onChange uses —
   * so what is asserted here is not "the box has text in it" but that the
   * preview SEARCHED: the count, and the painted Ranges.
   *
   * 🔴 The multi-line fixture is a fenced code block on purpose. jsdom's
   * `Selection.toString()` is `Range.toString()` — it concatenates character
   * data and does not insert the line breaks a real browser puts between block
   * elements — so a selection spanning two `<p>`s would arrive here as a
   * single-line string and the test would pass against nothing. A `<pre>`'s text
   * node carries real `\n`s, so it means the same thing in both engines.
   */
  describe("Cmd+F seeds from the selection", () => {
    const SEED_DOC = [
      "# Release notes",
      "",
      "The **preview** renders markdown. The preview also zooms.",
      "",
      "- a preview list item",
      "",
      F,
      "alpha",
      "beta",
      F,
    ].join("\n");

    afterEach(() => window.getSelection()?.removeAllRanges());

    /**
     * The real gesture, in the order it really happens: the mousedown focuses
     * the preview (`onPointerDown`), the drag makes the selection, then the key
     * is pressed.
     *
     * 🔴 That order is load-bearing HERE and nowhere else: jsdom's
     * `HTMLElement.focus()` ends with `getSelection().collapse(this, 0)`, which
     * no real browser does for a non-editable element. Calling the file's
     * `pressFind` helper (which focuses first) after selecting would therefore
     * wipe the selection and quietly test the empty-bar path instead — a test
     * that passes against nothing.
     */
    function pressFindAfterSelecting(text: string): void {
      const el = screen.getByTestId("markdown-preview");
      el.focus();
      selectInPreview(text);
      fireEvent.keyDown(el, { key: "f", metaKey: true });
    }

    /** Select the first occurrence of `text` within one text node of the preview. */
    function selectInPreview(text: string): void {
      const body = screen.getByTestId("markdown-preview").querySelector(".markdown-preview__body");
      const walker = document.createTreeWalker(body as Node, NodeFilter.SHOW_TEXT);
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
      // Loud rather than silently seeding nothing — a fixture that stopped
      // containing the text would otherwise make every assertion below vacuous.
      throw new Error(`no text node in the preview contains ${JSON.stringify(text)}`);
    }

    const findInput = (): HTMLInputElement => screen.getByTestId("preview-find-input");

    it("seeds a single-line selection AND searches it", () => {
      const registry = withHighlightApi();
      render(<MarkdownPreview text={SEED_DOC} />);

      pressFindAfterSelecting("preview");

      expect(findInput()).toHaveValue("preview");
      // It searched: three matches, the cursor on the first, and the Ranges are
      // painted. "The box has text in it" would be true without any of this.
      expect(count()).toBe("1/3");
      expect(registry.get("markdown-preview-find")!.ranges).toHaveLength(3);
      expect(registry.get("markdown-preview-find-current")!.ranges[0].toString()).toBe("preview");
    });

    it("selects the seeded text, so the next keystroke replaces it", () => {
      render(<MarkdownPreview text={SEED_DOC} />);

      pressFindAfterSelecting("preview");

      const input = findInput();
      expect(document.activeElement).toBe(input);
      expect(input.selectionStart).toBe(0);
      expect(input.selectionEnd).toBe("preview".length);
    });

    it("OVERWRITES the query of an already-open bar, and restarts at the first match", () => {
      render(<MarkdownPreview text={SEED_DOC} />);
      const el = screen.getByTestId("markdown-preview");
      pressFind(el);
      type("preview");
      fireEvent.click(screen.getByTestId("preview-find-next")); // walk to 2/3
      expect(count()).toBe("2/3");

      // "The" also has two matches, so a cursor left at 1 would read "2/2" —
      // 1/2 is the discriminator that the new query really restarted.
      pressFindAfterSelecting("The");

      expect(findInput()).toHaveValue("The");
      expect(count()).toBe("1/2");
    });

    it("re-seeding the SAME query keeps the user's place", () => {
      // The recompute effect tells "a new query" from "the same query
      // re-indexed", and a re-seed is the second — so Cmd+F over the word you
      // are already standing on is a refocus, not a jump back to match 1.
      render(<MarkdownPreview text={SEED_DOC} />);
      const el = screen.getByTestId("markdown-preview");
      pressFind(el);
      type("preview");
      fireEvent.click(screen.getByTestId("preview-find-next"));
      fireEvent.click(screen.getByTestId("preview-find-next"));
      expect(count()).toBe("3/3");

      pressFindAfterSelecting("preview");

      expect(findInput()).toHaveValue("preview");
      expect(count()).toBe("3/3");
    });

    it("leaves the query UNTOUCHED for a MULTI-LINE selection — it does not clear it", () => {
      render(<MarkdownPreview text={SEED_DOC} />);
      const el = screen.getByTestId("markdown-preview");
      pressFind(el);
      type("preview");
      expect(count()).toBe("1/3");

      pressFindAfterSelecting("alpha\nbeta");

      expect(findInput()).toHaveValue("preview");
      expect(count()).toBe("1/3");
    });

    it("ignores a selection that lives OUTSIDE this preview", () => {
      // Two previews in two splits, or the right rail's filter box: a selection
      // elsewhere is not this preview's, and seeding from it would be a
      // jump-scare in a pane the user is not reading.
      render(<MarkdownPreview text={SEED_DOC} />);
      const el = screen.getByTestId("markdown-preview");
      const stranger = document.createElement("div");
      stranger.append(document.createTextNode("somebody else's text"));
      document.body.append(stranger);
      el.focus(); // …before selecting, for the jsdom reason above
      const range = document.createRange();
      range.selectNodeContents(stranger);
      const selection = window.getSelection() as Selection;
      selection.removeAllRanges();
      selection.addRange(range);

      fireEvent.keyDown(el, { key: "f", metaKey: true });

      expect(findInput()).toHaveValue("");
      stranger.remove();
    });

    it("with NOTHING selected the bar opens empty, exactly as it always has", () => {
      render(<MarkdownPreview text={SEED_DOC} />);

      pressFind(screen.getByTestId("markdown-preview"));

      expect(findInput()).toHaveValue("");
      expect(count()).toBe("0 results"); // what an empty query has always read
    });

    it("the WINDOW-level fallback seeds too — the usual gesture", () => {
      // Focus is on the tree row or the tab; the selection is the only evidence
      // the user was reading this preview, so it is the only thing that can
      // seed. That path must not be the one surface that opens empty.
      render(<MarkdownPreview text={SEED_DOC} />);
      selectInPreview("zooms"); // focus stays on <body> — that is the point

      const evt = new KeyboardEvent("keydown", {
        key: "f",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      });
      act(() => void window.dispatchEvent(evt));

      expect(findInput()).toHaveValue("zooms");
      expect(count()).toBe("1/1");
    });
  });

  describe("the window-level fallback — the part that makes it a feature", () => {
    /** Cmd+F at the window, i.e. with focus nowhere in particular. */
    function windowFind(): KeyboardEvent {
      const evt = new KeyboardEvent("keydown", {
        key: "f",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      });
      act(() => void window.dispatchEvent(evt));
      return evt;
    }

    it("opens the bar when the key reached the window unclaimed", () => {
      // The usual gesture: open a README, press Cmd+F. Focus is on
      // the tree row or the tab they clicked — never inside the preview.
      render(<MarkdownPreview text={DOC} />);
      expect(document.activeElement).toBe(document.body);

      const evt = windowFind();

      expect(screen.getByTestId("preview-find")).toBeInTheDocument();
      expect(evt.defaultPrevented).toBe(true);
    });

    it("stands down for an event a focused surface already handled", () => {
      // CodeMirror's keymap and ResponseBody's bar both preventDefault; the
      // terminal's capture listener stops propagation outright. Honouring
      // `defaultPrevented` is what keeps this fallback idempotent.
      render(<MarkdownPreview text={DOC} />);

      const evt = new KeyboardEvent("keydown", {
        key: "f",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      });
      evt.preventDefault();
      act(() => void window.dispatchEvent(evt));

      expect(screen.queryByTestId("preview-find")).toBeNull();
    });

    it("stands down while the user is typing in a text field elsewhere", () => {
      render(<MarkdownPreview text={DOC} />);
      const outside = document.createElement("input");
      document.body.append(outside);
      outside.focus();

      const evt = new KeyboardEvent("keydown", {
        key: "f",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      });
      act(() => void outside.dispatchEvent(evt));

      expect(screen.queryByTestId("preview-find")).toBeNull();
      expect(evt.defaultPrevented).toBe(false);
      outside.remove();
    });

    it("ignores a key that is not the shortcut", () => {
      render(<MarkdownPreview text={DOC} />);

      act(() =>
        void window.dispatchEvent(
          new KeyboardEvent("keydown", { key: "f", shiftKey: true, metaKey: true, bubbles: true }),
        ),
      );

      expect(screen.queryByTestId("preview-find")).toBeNull();
    });

    it("defers to the FOCUSED pane when two previews are open", () => {
      // Rendered inside the app's own pane markup: `Pane.tsx` marks the focused
      // pane with `pane--focused`, and a newly opened tab always lands there.
      render(
        <div>
          <div className="pane">
            <MarkdownPreview text={DOC} />
          </div>
          <div className="pane pane--focused">
            <MarkdownPreview text={DOC} />
          </div>
        </div>,
      );

      windowFind();

      // Exactly one bar, and it is the one in the focused pane.
      const bars = screen.getAllByTestId("preview-find");
      expect(bars).toHaveLength(1);
      expect(bars[0].closest(".pane")).toHaveClass("pane--focused");
    });

    it("re-focuses the query box when the bar is already open", () => {
      render(<MarkdownPreview text={DOC} />);
      windowFind();
      const input = screen.getByTestId("preview-find-input");
      (input as HTMLInputElement).blur();
      expect(document.activeElement).not.toBe(input);

      windowFind();

      expect(document.activeElement).toBe(input);
    });

    it("stops listening once the preview is gone", () => {
      const { unmount } = render(<MarkdownPreview text={DOC} />);
      unmount();

      // Not `not.toThrow()` — React swallows handler throws. A
      // leaked listener would touch a null ref and surface as a window error.
      expect(errorsDuring(() => void windowFind())).toEqual([]);
      expect(screen.queryByTestId("preview-find")).toBeNull();
    });
  });

  describe("the bar survives a tab move — store-kept per path", () => {
    // `Pane` unmounts inactive tabs and a cross-pane drag re-parents the
    // subtree, so open/query/cursor live in `findBars` keyed `preview:${path}`
    // (the previewZoom precedent). These tests drive the REAL store — the same
    // singleton the app uses — so the reset below is load-bearing: a leaked
    // record would make "the bar starts closed" fail three tests later.
    const PATH = "/repo/docs/notes.md";
    const KEY = `preview:${PATH}`;
    const barRecord = (key: string): FindBarState | undefined =>
      useAppStore.getState().findBars[key];

    beforeEach(() => {
      useAppStore.setState((s) => {
        s.findBars = {};
      });
    });

    it("reopens after unmount → remount: bar open, query intact, cursor kept, highlights repainted", () => {
      const registry = withHighlightApi();
      // jsdom ships no scrollIntoView; installing one on the prototype is the
      // only way to observe the REMOUNT paint scrolling (the element it targets
      // does not exist until the paint effect is already running).
      const scrolls = vi.fn();
      const proto = HTMLElement.prototype as unknown as { scrollIntoView?: unknown };
      proto.scrollIntoView = scrolls;
      restores.push(() => delete proto.scrollIntoView);

      const first = render(<MarkdownPreview text={DOC} path={PATH} />);
      pressFind(screen.getByTestId("markdown-preview"));
      type("preview");
      expect(count()).toBe("1/3");
      fireEvent.click(screen.getByTestId("preview-find-next"));
      expect(count()).toBe("2/3");

      first.unmount();

      // A plain unmount is NOT Esc: the record survives it — that is the fix —
      // while the document-global highlights are retired (a closed tab must
      // never leave colour behind).
      expect(barRecord(KEY)).toMatchObject({ open: true, query: "preview", cursor: 1 });
      expect(registry.size).toBe(0);

      scrolls.mockClear();
      const { container } = render(<MarkdownPreview text={DOC} path={PATH} />);

      // The bar is back with its query, the count is recomputed from a FRESH
      // index (the old Ranges died with the old document fragment)…
      expect(screen.getByTestId("preview-find-input")).toHaveValue("preview");
      expect(count()).toBe("2/3"); // the user's place, not match one
      // …the highlights are repainted over the NEW document…
      const all = registry.get("markdown-preview-find")!;
      expect(all.ranges.map((r) => r.toString())).toEqual(["preview", "preview", "preview"]);
      const body = container.querySelector(".markdown-preview__body") as HTMLElement;
      for (const r of all.ranges) expect(body.contains(r.startContainer)).toBe(true);
      // …the current one is still the SECOND match…
      const current = registry.get("markdown-preview-find-current")!;
      expect(current.ranges).toEqual([all.ranges[1]]);
      // …and it was brought back on screen.
      expect(scrolls).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
    });

    it("clamps the stored cursor when the document shrank while the tab was away", () => {
      const first = render(<MarkdownPreview text={DOC} path={PATH} />);
      pressFind(screen.getByTestId("markdown-preview"));
      type("preview");
      fireEvent.click(screen.getByTestId("preview-find-next"));
      fireEvent.click(screen.getByTestId("preview-find-next"));
      expect(count()).toBe("3/3"); // cursor 2, about to outlive two matches
      first.unmount();

      render(<MarkdownPreview text={"Only one preview left."} path={PATH} />);

      // Not "3/1" (a stale ordinal) and not a crash on ranges[2] — the cursor
      // is clamped against the fresh count and the store agrees.
      expect(count()).toBe("1/1");
      expect(barRecord(KEY)).toMatchObject({ open: true, query: "preview", cursor: 0 });
    });

    it("two different paths do NOT share a bar (two-sided)", () => {
      render(
        <div>
          <MarkdownPreview text={DOC} path="/repo/a.md" />
          <MarkdownPreview text={DOC} path="/repo/b.md" />
        </div>,
      );
      const [a, b] = screen.getAllByTestId("markdown-preview");

      pressFind(a);
      type("preview");

      // One bar, in A — B neither opened nor inherited the query.
      expect(screen.getAllByTestId("preview-find")).toHaveLength(1);
      expect(a.contains(screen.getByTestId("preview-find"))).toBe(true);
      expect(barRecord("preview:/repo/a.md")).toMatchObject({ open: true, query: "preview" });
      expect(barRecord("preview:/repo/b.md")).toBeUndefined();

      // Two-sided: open B's too and the two hold DIFFERENT queries at once.
      pressFind(b);
      const inputs = screen.getAllByTestId("preview-find-input");
      expect(inputs).toHaveLength(2);
      fireEvent.change(inputs[1], { target: { value: "zooms" } });
      expect(inputs[0]).toHaveValue("preview");
      expect(inputs[1]).toHaveValue("zooms");
      expect(barRecord("preview:/repo/b.md")).toMatchObject({ open: true, query: "zooms" });
    });

    it("Esc REMOVES the record — absence is the closed state, not a tombstone", () => {
      render(<MarkdownPreview text={DOC} path={PATH} />);
      const el = screen.getByTestId("markdown-preview");
      pressFind(el);
      type("preview");
      expect(barRecord(KEY)).toBeDefined(); // two-sided: there was one to drop

      fireEvent.keyDown(el, { key: "Escape" });

      expect(screen.queryByTestId("preview-find")).toBeNull();
      expect(barRecord(KEY)).toBeUndefined();
    });

    it("the ✕ drops the record exactly like Esc", () => {
      render(<MarkdownPreview text={DOC} path={PATH} />);
      pressFind(screen.getByTestId("markdown-preview"));
      type("preview");
      expect(barRecord(KEY)).toBeDefined();

      fireEvent.click(screen.getByTestId("preview-find-close"));

      expect(screen.queryByTestId("preview-find")).toBeNull();
      expect(barRecord(KEY)).toBeUndefined();
    });

    it("clearing the query zeroes the stored cursor without dropping the open bar", () => {
      render(<MarkdownPreview text={DOC} path={PATH} />);
      pressFind(screen.getByTestId("markdown-preview"));
      type("preview");
      fireEvent.click(screen.getByTestId("preview-find-next"));
      expect(barRecord(KEY)).toMatchObject({ cursor: 1 });

      type("");

      // The bar stays open (clearing is not Esc), but a remount now must not
      // inherit a cursor pointing into a search that no longer exists.
      expect(count()).toBe("0 results");
      expect(barRecord(KEY)).toMatchObject({ open: true, query: "", cursor: 0 });
    });

    it("typing a NEW query still restarts at the first match (remount-keeping did not break it)", () => {
      render(<MarkdownPreview text={DOC} path={PATH} />);
      pressFind(screen.getByTestId("markdown-preview"));
      type("preview");
      fireEvent.click(screen.getByTestId("preview-find-next"));
      expect(count()).toBe("2/3");

      type("the"); // a different query, typed in the SAME mount

      expect(count()).toBe("1/2"); // cursor restarted, not carried over
    });
  });
});

describe("links never navigate the app window", () => {
  beforeEach(() => gitIpc.urlOpen.mockClear());

  const click = (el: Element): boolean =>
    fireEvent.click(el); // false when preventDefault() was called

  it("opens https links in the OS browser and cancels the navigation", () => {
    const { container } = render(<MarkdownPreview text="[site](https://example.com/x)" />);
    const a = container.querySelector("a")!;
    expect(click(a)).toBe(false);
    expect(gitIpc.urlOpen).toHaveBeenCalledWith("https://example.com/x");
  });

  it("cancels http, preview and file links without opening anything", () => {
    for (const href of [
      "http://evil.example/",
      "http://preview.localhost/C:/repo/e.html",
      "file:///etc/passwd",
    ]) {
      const { container, unmount } = render(<MarkdownPreview text={`[x](${href})`} />);
      const a = container.querySelector("a");
      if (a) expect(click(a)).toBe(false);
      unmount();
    }
    expect(gitIpc.urlOpen).not.toHaveBeenCalled();
  });

  it("keeps #anchors inside the preview", () => {
    const { container } = render(<MarkdownPreview text={'[go](#top)\n\n<h2 id="top">Top</h2>'} />);
    const a = container.querySelector('a[href="#top"]')!;
    expect(click(a)).toBe(false);
    expect(gitIpc.urlOpen).not.toHaveBeenCalled();
  });
});

describe("interceptLink — edge cases", () => {
  beforeEach(() => gitIpc.urlOpen.mockClear());

  const fakeEvent = (target: Element, root: HTMLElement) => {
    const preventDefault = vi.fn();
    return {
      ev: { target, currentTarget: root, preventDefault } as unknown as React.MouseEvent<HTMLElement>,
      preventDefault,
    };
  };

  it("is a no-op outside a link", () => {
    const root = document.createElement("div");
    const { ev, preventDefault } = fakeEvent(root, root);
    expect(interceptLink(ev)).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("reads an SVG xlink:href (Mermaid) and opens https", () => {
    const root = document.createElement("div");
    const a = document.createElementNS("http://www.w3.org/2000/svg", "a");
    a.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", "https://example.com/svg");
    root.appendChild(a);
    expect(interceptLink(fakeEvent(a, root).ev)).toBe(true);
    expect(gitIpc.urlOpen).toHaveBeenCalledWith("https://example.com/svg");
  });

  it("an <a> with no href at all is cancelled and ignored", () => {
    const root = document.createElement("div");
    const a = document.createElement("a");
    root.appendChild(a);
    expect(interceptLink(fakeEvent(a, root).ev)).toBe(true);
    expect(gitIpc.urlOpen).not.toHaveBeenCalled();
  });

  it("scrolls to an existing #anchor, and a bare # goes nowhere", () => {
    const root = document.createElement("div");
    const target = document.createElement("h2");
    target.id = "usage";
    target.scrollIntoView = vi.fn();
    const a = document.createElement("a");
    a.setAttribute("href", "#usage");
    const bare = document.createElement("a");
    bare.setAttribute("href", "#");
    root.append(a, bare, target);
    interceptLink(fakeEvent(a, root).ev);
    expect(target.scrollIntoView).toHaveBeenCalledTimes(1);
    interceptLink(fakeEvent(bare, root).ev);
    expect(target.scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("swallows a url_open refusal", async () => {
    gitIpc.urlOpen.mockImplementationOnce(() => Promise.reject(new Error("refused")));
    const root = document.createElement("div");
    const a = document.createElement("a");
    a.setAttribute("href", "https://example.com/");
    root.appendChild(a);
    expect(interceptLink(fakeEvent(a, root).ev)).toBe(true);
    await Promise.resolve();
  });
});
