/**
 * HtmlPreview tests — jsdom tier.
 *
 * ## 🔴 What this tier proves, and what it emphatically does NOT
 *
 * jsdom does not load an iframe's `src`, does not implement the `preview://`
 * scheme, does not execute a framed document, and — most importantly — **does
 * not implement `sandbox` or CSP at all**. So nothing here is evidence that the
 * jail *holds*. What it is evidence of is that the host **asks for** the right
 * jail and the right URL, which is the half of the feature that lives in this
 * repository's TypeScript:
 *
 *   - the `sandbox` attribute is the exact string `"allow-scripts"` — asserted
 *     character-for-character, plus token-by-token for the dangerous ones, so a
 *     future `allow-same-origin` cannot slip in as a "small" widening;
 *   - `referrerPolicy` is `no-referrer`;
 *   - the URL is built correctly from a filesystem path, on both platform
 *     spellings, with each SEGMENT percent-encoded and the `/` separators not;
 *   - the frame is genuinely **remounted** (a new DOM node) on a save, on a
 *     Reload click and on a path change, and is NOT remounted on an unrelated
 *     re-render;
 *   - the two known limitations are stated in the chrome, quietly (collapsed by
 *     default), and expand on demand.
 *
 * What would still have to be checked in a real packaged build, by a human
 * driving the app:
 *
 *   - that a page actually renders, with its sibling `.css`, `.js`, ES-module
 *     imports and local `@font-face` resolving through the scheme;
 *   - that WebKit enforces the sandbox and Rust's `PREVIEW_CSP` as intended
 *     (`connect-src 'none'`, no remote origin, no reach into Tauri IPC);
 *   - that a save is visible after a reload — i.e. that the engine does not
 *     serve a stale `style.css` out of its own HTTP cache. That is an engine
 *     behaviour no test in this repo can observe.
 *
 * ## Why there is no browser-tier test here
 *
 * There deliberately is none, and its absence is a finding rather than an
 * omission. The browser tier runs **Chromium**, the app ships **WebKit**, and
 * per `docs/design/csp.md` the browser tier applies **no CSP at all**. A green
 * Chromium assertion about this frame would be a false green: it would prove
 * nothing about the engine that ships and nothing about the policy that is the
 * feature's security. Writing one for the look of it would be worse than not
 * having it, because a passing test is read as evidence.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { HtmlPreview, previewUrlFor } from "./HtmlPreview";

afterEach(() => cleanup());

const frame = (): HTMLIFrameElement =>
  screen.getByTestId("html-preview-frame") as HTMLIFrameElement;

describe("previewUrlFor", () => {
  it("mirrors a POSIX absolute path under preview://localhost", () => {
    expect(previewUrlFor("/Users/sam/proj/index.html")).toBe(
      "preview://localhost/Users/sam/proj/index.html",
    );
  });

  it("percent-encodes each SEGMENT but never the / separators", () => {
    // A space, a `#` and a `?` in a DIRECTORY name. The `#`/`?` are the ones
    // that matter most: unencoded they would truncate Rust's `uri().path()` and
    // the request would arrive for the wrong file entirely.
    expect(previewUrlFor("/Users/sam/my site/v#2/a?b/index.html")).toBe(
      "preview://localhost/Users/sam/my%20site/v%232/a%3Fb/index.html",
    );
  });

  it("percent-encodes non-ASCII path segments as UTF-8", () => {
    // Rust's `percent_decode` reverses exactly this: café -> caf%C3%A9.
    expect(previewUrlFor("/Users/sam/café/página.html")).toBe(
      "preview://localhost/Users/sam/caf%C3%A9/p%C3%A1gina.html",
    );
  });

  it("keeps a literal % in a filename encoded rather than read as an escape", () => {
    expect(previewUrlFor("/Users/sam/100%25/x.html")).toBe(
      "preview://localhost/Users/sam/100%2525/x.html",
    );
  });

  it("uses the Windows platform spelling for a backslash drive path", () => {
    // http://preview.localhost is how wry serves a custom scheme on Windows, and
    // the separators become `/`. `C:` encodes to `C%3A`, which Rust decodes back
    // before it builds the PathBuf.
    expect(previewUrlFor("C:\\Users\\sam\\proj\\index.html")).toBe(
      "http://preview.localhost/C%3A/Users/sam/proj/index.html",
    );
  });

  it("recognises a drive path that already uses forward slashes", () => {
    expect(previewUrlFor("d:/work/site/index.html")).toBe(
      "http://preview.localhost/d%3A/work/site/index.html",
    );
  });

  it("does not mistake a POSIX path with a colon in it for a Windows path", () => {
    // A colon that is not followed by a separator is just a character in a
    // filename, and macOS permits one.
    expect(previewUrlFor("/Users/sam/a:b/index.html")).toBe(
      "preview://localhost/Users/sam/a%3Ab/index.html",
    );
    // 🔴 The `^` anchor, pinned. A drive-letter-SHAPED run in the middle of a
    // POSIX path (`wget -r` makes `https:/` directories; a repo can hold a
    // literal `C:` folder) must NOT re-spell the URL as the Windows one — that
    // would hand macOS a `http://preview.localhost/...` URL pointing nowhere and
    // the user would get a blank preview with nothing to explain it. Found by
    // falsification: dropping the anchor left every other test green.
    expect(previewUrlFor("/Users/sam/C:/site/index.html")).toBe(
      "preview://localhost/Users/sam/C%3A/site/index.html",
    );
    expect(previewUrlFor("/Users/sam/mirror/https:/example.com/i.html")).toBe(
      "preview://localhost/Users/sam/mirror/https%3A/example.com/i.html",
    );
  });
});

describe("HtmlPreview — the sandbox jail", () => {
  it("gives the frame EXACTLY sandbox=allow-scripts and nothing else", () => {
    render(<HtmlPreview path="/Users/sam/proj/index.html" reloadKey={0} />);
    // The exact-string assertion is the regression guard for the whole feature's
    // security: any widening at all has to be a deliberate edit to a failing test.
    expect(frame().getAttribute("sandbox")).toBe("allow-scripts");
  });

  it("never grants allow-same-origin — the documented sandbox escape", () => {
    render(<HtmlPreview path="/Users/sam/proj/index.html" reloadKey={0} />);
    const tokens = (frame().getAttribute("sandbox") ?? "").split(/\s+/);
    // Spelled out one by one so a failure names WHICH capability leaked, not
    // just that a string differs. `allow-scripts` + `allow-same-origin` lets the
    // frame reach parent.document and delete its own sandbox attribute.
    expect(tokens).not.toContain("allow-same-origin");
    expect(tokens).not.toContain("allow-top-navigation");
    expect(tokens).not.toContain("allow-top-navigation-by-user-activation");
    expect(tokens).not.toContain("allow-popups");
    expect(tokens).not.toContain("allow-popups-to-escape-sandbox");
    expect(tokens).not.toContain("allow-modals");
    expect(tokens).not.toContain("allow-forms");
    expect(tokens).not.toContain("allow-downloads");
    expect(tokens).not.toContain("allow-pointer-lock");
    expect(tokens).not.toContain("allow-presentation");
    expect(tokens).not.toContain("allow-storage-access-by-user-activation");
    expect(tokens).toContain("allow-scripts");
  });

  it("sends no referrer, so a page never learns its own absolute path", () => {
    render(<HtmlPreview path="/Users/sam/proj/index.html" reloadKey={0} />);
    expect(frame().getAttribute("referrerpolicy")).toBe("no-referrer");
  });

  it("points the frame at the preview:// URL for the path and names it", () => {
    render(<HtmlPreview path="/Users/sam/proj/index.html" reloadKey={0} />);
    expect(frame().getAttribute("src")).toBe(previewUrlFor("/Users/sam/proj/index.html"));
    expect(frame()).toHaveAttribute("title", "Rendered preview of index.html");
  });
});

describe("HtmlPreview — reloading", () => {
  it("remounts the frame when reloadKey changes (a save)", () => {
    const { rerender } = render(<HtmlPreview path="/p/index.html" reloadKey={1} />);
    const before = frame();
    rerender(<HtmlPreview path="/p/index.html" reloadKey={2} />);
    // A NEW DOM node: the browsing context is discarded, so the previous run's
    // timers and module state go with it. `contentWindow.location.reload()` is
    // not available — the frame is cross-origin and touching it throws.
    expect(frame()).not.toBe(before);
  });

  it("does NOT remount on an unrelated re-render with the same props", () => {
    const { rerender } = render(<HtmlPreview path="/p/index.html" reloadKey={1} />);
    const before = frame();
    rerender(<HtmlPreview path="/p/index.html" reloadKey={1} />);
    // Otherwise every parent render would restart the page from scratch, losing
    // its scroll position and re-running its scripts.
    expect(frame()).toBe(before);
  });

  it("remounts the frame on Reload, with no save and no URL change", () => {
    render(<HtmlPreview path="/p/index.html" reloadKey={7} />);
    const before = frame();
    fireEvent.click(screen.getByTestId("html-preview-reload"));
    const after = frame();
    expect(after).not.toBe(before);
    expect(after.getAttribute("src")).toBe(before.getAttribute("src"));
  });

  it("keeps the reload counter out of the URL the page can read", () => {
    render(<HtmlPreview path="/p/index.html" reloadKey={0} />);
    fireEvent.click(screen.getByTestId("html-preview-reload"));
    // A cache-busting `?r=N` was the other candidate and was rejected: the page
    // would see our counter through `location.search` and could behave
    // differently under the preview than under a real server.
    expect(frame().getAttribute("src")).toBe("preview://localhost/p/index.html");
  });

  it("remounts and re-points the frame when the path changes", () => {
    const { rerender } = render(<HtmlPreview path="/p/a.html" reloadKey={0} />);
    const before = frame();
    rerender(<HtmlPreview path="/p/b.html" reloadKey={0} />);
    expect(frame()).not.toBe(before);
    expect(frame().getAttribute("src")).toBe("preview://localhost/p/b.html");
    expect(frame()).toHaveAttribute("title", "Rendered preview of b.html");
  });
});

describe("HtmlPreview — the limitations chrome", () => {
  it("states both limitations in one quiet line and does not nag", () => {
    render(<HtmlPreview path="/p/index.html" reloadKey={0} />);
    const note = screen.getByTestId("html-preview-note");
    expect(note).toHaveTextContent(/remote URLs and root-absolute paths don’t load/);
    // Collapsed on arrival: users will hit these, so they must be VISIBLE
    // — but a wall of warning redrawn on every preview is a wall nobody reads.
    expect(screen.queryByTestId("html-preview-details")).not.toBeInTheDocument();
    expect(note).toHaveAttribute("aria-expanded", "false");
  });

  it("expands to explain both limitations, and collapses again", () => {
    render(<HtmlPreview path="/p/index.html" reloadKey={0} />);
    const note = screen.getByTestId("html-preview-note");

    fireEvent.click(note);
    const details = screen.getByTestId("html-preview-details");
    expect(note).toHaveAttribute("aria-expanded", "true");
    expect(details).toHaveTextContent(/Remote resources are blocked/);
    // The fix, not just the symptom — a CDN/font/fetch failure is otherwise a
    // mystery, and so is a 404 on an href that works on a real server.
    expect(details).toHaveTextContent(/CDN scripts, web fonts, remote images/);
    expect(details).toHaveTextContent(/no document root/i);
    expect(details).toHaveTextContent(/\/assets\/app\.css/);
    expect(details).toHaveTextContent(/relative path/);

    fireEvent.click(note);
    expect(screen.queryByTestId("html-preview-details")).not.toBeInTheDocument();
    expect(note).toHaveAttribute("aria-expanded", "false");
  });

  it("does not survive-or-lose anything by expanding: the frame is untouched", () => {
    render(<HtmlPreview path="/p/index.html" reloadKey={0} />);
    const before = frame();
    fireEvent.click(screen.getByTestId("html-preview-note"));
    // Reading the note must not restart the page the user is looking at.
    expect(frame()).toBe(before);
  });

  it("carries exactly two controls — no zoom cluster, no find bar", () => {
    render(<HtmlPreview path="/p/index.html" reloadKey={0} />);
    // The regression guard for two DELIBERATE absences (previewKinds.hasZoom is
    // false for "html"; previewFind cannot paint into a cross-origin document).
    // Shipping a % readout that moved nothing would be a control that lies.
    const labels = screen.getAllByRole("button").map((b) => b.textContent);
    expect(labels).toHaveLength(2);
    expect(labels.some((l) => l?.includes("Reload"))).toBe(true);
    expect(labels.some((l) => /%|−|\+/.test(l ?? ""))).toBe(false);
  });
});
