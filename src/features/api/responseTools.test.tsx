import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiStoreIpc = vi.hoisted(() => ({ loadApiStore: vi.fn(), saveApiStore: vi.fn() }));
vi.mock("./apiStoreIpc", () => apiStoreIpc);
const historyIpc = vi.hoisted(() => ({ loadApiHistory: vi.fn(), saveApiHistory: vi.fn() }));
vi.mock("./historyIpc", () => historyIpc);

import { useAppStore } from "../../app/store";
import { resetStore } from "../../test/store-harness";
import { ResponseBody } from "./ResponseBody";

const state = () => useAppStore.getState();
const api = () => state().apiActions;

const BODY = '{"name":"ada","role":"admin","team":"ada-team"}';

/** The find bar's store key — the shape ApiRequestView passes (`api:<requestId>`). */
const KEY = "api:r1";

const renderBody = (text = BODY) =>
  render(
    <ResponseBody text={text} testId="api-response-body" copyLabel="the response" findKey={KEY} />,
  );

describe("response search", () => {
  beforeEach(() => resetStore());

  it("opens on Cmd/Ctrl+F and highlights every match", async () => {
    const user = userEvent.setup();
    renderBody();
    expect(screen.queryByTestId("response-find")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("api-response-body"));
    await user.keyboard("{Meta>}f{/Meta}");
    expect(screen.getByTestId("response-find")).toBeInTheDocument();

    await user.type(screen.getByTestId("response-find-input"), "ada");
    // "ada", "ada-team" → two hits, one of them the current one.
    expect(screen.getAllByTestId("response-find-hit")).toHaveLength(1);
    expect(screen.getByTestId("response-find-current")).toBeInTheDocument();
    expect(screen.getByTestId("response-find-count")).toHaveTextContent("1");
  });

  it("opens on Ctrl+F too — the Windows and Linux chord", async () => {
    const user = userEvent.setup();
    renderBody();
    await user.click(screen.getByTestId("api-response-body"));
    await user.keyboard("{Control>}f{/Control}");
    expect(screen.getByTestId("response-find")).toBeInTheDocument();
  });

  it("names the platform's modifier in the search button's tooltip (⌘ on macOS, Ctrl elsewhere)", () => {
    const ua = vi.spyOn(navigator, "userAgent", "get");
    ua.mockReturnValue("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
    const { unmount } = renderBody();
    expect(screen.getByTestId("response-find-toggle")).toHaveAttribute(
      "title",
      "Search this response (Ctrl+F)",
    );
    unmount();
    ua.mockReturnValue("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)");
    renderBody();
    expect(screen.getByTestId("response-find-toggle")).toHaveAttribute(
      "title",
      "Search this response (⌘+F)",
    );
    ua.mockRestore();
  });

  it("steps through matches and wraps around", async () => {
    const user = userEvent.setup();
    renderBody();
    await user.click(screen.getByTestId("response-find-toggle"));
    await user.type(screen.getByTestId("response-find-input"), "ada");

    const current = () => screen.getByTestId("response-find-current").textContent;
    expect(current()).toBe("ada");

    await user.click(screen.getByTestId("response-find-next"));
    expect(screen.getByTestId("response-find-count")).toHaveTextContent("2");

    // Wrapping is the property — a next at the end returns to the first.
    await user.click(screen.getByTestId("response-find-next"));
    expect(screen.getByTestId("response-find-count")).toHaveTextContent("1");

    await user.click(screen.getByTestId("response-find-prev"));
    expect(screen.getByTestId("response-find-count")).toHaveTextContent("2");
  });

  it("says so when nothing matches, and highlights nothing", async () => {
    const user = userEvent.setup();
    renderBody();
    await user.click(screen.getByTestId("response-find-toggle"));
    await user.type(screen.getByTestId("response-find-input"), "zzzz");
    expect(screen.queryAllByTestId("response-find-hit")).toHaveLength(0);
    expect(screen.queryByTestId("response-find-current")).not.toBeInTheDocument();
    // Two-sided against the match test: the body text is still all there.
    expect(screen.getByTestId("api-response-body")).toHaveTextContent("admin");
  });

  it("Escape closes the bar and clears the highlights", async () => {
    const user = userEvent.setup();
    renderBody();
    await user.click(screen.getByTestId("response-find-toggle"));
    await user.type(screen.getByTestId("response-find-input"), "ada");
    expect(screen.getByTestId("response-find-current")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("response-find")).not.toBeInTheDocument();
    expect(screen.queryByTestId("response-find-current")).not.toBeInTheDocument();
  });

  it("Enter with no matches does nothing rather than throwing", async () => {
    const user = userEvent.setup();
    renderBody();
    await user.click(screen.getByTestId("response-find-toggle"));
    const input = screen.getByTestId("response-find-input");
    await user.type(input, "zzzz");
    // The ↑/↓ buttons are disabled here, but Enter is not — so this is the one
    // way a user can ask to step with nothing to step through.
    await user.type(input, "{Enter}");
    expect(screen.getByTestId("response-find-count")).toHaveTextContent("0");
  });

  it("the ✕ closes the bar as well as Escape", async () => {
    const user = userEvent.setup();
    renderBody();
    await user.click(screen.getByTestId("response-find-toggle"));
    await user.type(screen.getByTestId("response-find-input"), "ada");
    await user.click(screen.getByTestId("response-find-close"));
    expect(screen.queryByTestId("response-find")).not.toBeInTheDocument();
    expect(screen.queryByTestId("response-find-current")).not.toBeInTheDocument();
  });

  it("Enter and Shift+Enter walk the matches", async () => {
    const user = userEvent.setup();
    renderBody();
    await user.click(screen.getByTestId("response-find-toggle"));
    const input = screen.getByTestId("response-find-input");
    await user.type(input, "ada");
    await user.type(input, "{Enter}");
    expect(screen.getByTestId("response-find-count")).toHaveTextContent("2");
    await user.type(input, "{Shift>}{Enter}{/Shift}");
    expect(screen.getByTestId("response-find-count")).toHaveTextContent("1");
  });

  it("resets the cursor when the response itself changes", async () => {
    const user = userEvent.setup();
    const { rerender } = renderBody();
    await user.click(screen.getByTestId("response-find-toggle"));
    await user.type(screen.getByTestId("response-find-input"), "ada");
    await user.click(screen.getByTestId("response-find-next"));
    expect(screen.getByTestId("response-find-count")).toHaveTextContent("2");

    // A re-send lands new text; "match 2 of 2" would be a claim about the old one.
    rerender(
      <ResponseBody
        text='{"name":"ada"}'
        testId="api-response-body"
        copyLabel="the response"
        findKey={KEY}
      />,
    );
    expect(screen.getByTestId("response-find-count")).toHaveTextContent("1");
  });

  it("highlights a match at the very START and at the very END of the text", async () => {
    const user = userEvent.setup();
    // No leading run before the first hit, and no trailing run after the last —
    // the two edges where a naive splitter drops text.
    renderBody("abc middle abc");
    await user.click(screen.getByTestId("response-find-toggle"));
    await user.type(screen.getByTestId("response-find-input"), "abc");

    expect(screen.getByTestId("response-find-count")).toHaveTextContent("2");
    // Nothing is lost: the whole text still reads back.
    expect(screen.getByTestId("api-response-body")).toHaveTextContent("abc middle abc");
  });

  it("renders the body untouched when nothing is being searched", () => {
    renderBody();
    expect(screen.getByTestId("api-response-body")).toHaveTextContent(BODY);
    expect(screen.queryAllByTestId("response-find-hit")).toHaveLength(0);
  });
});

describe("response copy", () => {
  beforeEach(() => resetStore());

  it("copies the response text, says it did, and retires the claim on a new response", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    // Set AFTER userEvent.setup(), which installs its own clipboard stub
    // (a spy made before it is discarded).
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    const { rerender } = renderBody();
    await user.click(screen.getByTestId("response-copy"));

    expect(writeText).toHaveBeenCalledWith(BODY);
    expect(await screen.findByText("Copied")).toBeInTheDocument();

    // "Copied" is a claim about THIS text, so a new response must retire it —
    // otherwise the button says the new body is on the clipboard when it is not.
    rerender(
      <ResponseBody
        text='{"new":1}'
        testId="api-response-body"
        copyLabel="the response"
        findKey={KEY}
      />,
    );
    expect(screen.getByTestId("response-copy")).toHaveTextContent("Copy");
  });

  it("does nothing when the platform has no clipboard", async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    renderBody();
    await expect(user.click(screen.getByTestId("response-copy"))).resolves.toBeUndefined();
    expect(screen.queryByText("Copied")).not.toBeInTheDocument();
  });

  it("stays quiet when the copy is refused", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    renderBody();
    await user.click(screen.getByTestId("response-copy"));
    // Let the rejection actually settle — without this the `.catch` has not run
    // by the time the test ends, and "it did not throw" would be vacuous.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    // A refused clipboard is not something to shout about — but it must not
    // claim success either.
    expect(writeText).toHaveBeenCalled();
    expect(screen.queryByText("Copied")).not.toBeInTheDocument();
  });
});

describe("duplicate a request", () => {
  beforeEach(() => {
    resetStore();
    apiStoreIpc.saveApiStore.mockResolvedValue(undefined);
  });

  it("copies method, url, body, protocol and headers into a NEW request", () => {
    const id = api().createApiRequest();
    api().patchApiRequest(id, { method: "POST", url: "https://a.test/x", body: '{"a":1}' });
    api().addHeader(id);
    const headerId = state().apiRequests[id].headers[0].id;
    api().updateHeader(id, headerId, { name: "authorization", value: "Bearer {{T}}" });

    const copyId = api().duplicateApiRequest(id)!;
    const copy = state().apiRequests[copyId];

    expect(copyId).not.toBe(id);
    expect(copy).toMatchObject({ method: "POST", url: "https://a.test/x", body: '{"a":1}' });
    expect(copy.headers[0]).toMatchObject({
      name: "authorization",
      value: "Bearer {{T}}",
      enabled: true,
    });
    // Fresh row id: a shared one would make editing either request rewrite both.
    expect(copy.headers[0].id).not.toBe(headerId);
  });

  it("does NOT inherit the original's response — the copy has not been sent", () => {
    const id = api().createApiRequest();
    api().patchApiRequest(id, { url: "https://a.test" });
    api().setApiResponse(id, {
      status: 200,
      statusText: "OK",
      headers: [],
      body: "{}",
      durationMs: 5,
      sizeBytes: 2,
      truncated: false,
    });

    // The id FIRST: `state()` in the same expression would be evaluated before
    // the duplicate exists and would read a stale snapshot of the map.
    const copyId = api().duplicateApiRequest(id)!;
    const copy = state().apiRequests[copyId];
    // Showing the original's response under a request that never ran is a lie.
    expect(copy.response).toBeNull();
    expect(copy.error).toBeNull();
    expect(copy.sending).toBe(false);
    // Two-sided: the ORIGINAL still has its response.
    expect(state().apiRequests[id].response).not.toBeNull();
  });

  it("does not inherit the original's undo history", () => {
    const id = api().createApiRequest();
    api().patchApiRequest(id, { url: "https://a.test", body: "first" });
    const copyId = api().duplicateApiRequest(id)!;
    const copy = state().apiRequests[copyId];
    // Otherwise Cmd+Z in the copy would rewrite it into edits never made to it.
    expect(copy.bodyHistory.past).toEqual([]);
  });

  it("returns null for a request that is not there", () => {
    expect(api().duplicateApiRequest("nope")).toBeNull();
  });

  it("the button opens the copy in a NEW tab", async () => {
    const user = userEvent.setup();
    apiStoreIpc.loadApiStore.mockResolvedValue({
      collections: [],
      environments: [],
      activeEnvironmentId: null,
      folders: [],
    });
    historyIpc.loadApiHistory.mockResolvedValue({ entries: [] });
    const { ApiRequestView } = await import("./ApiRequestView");

    const id = api().createApiRequest();
    api().patchApiRequest(id, { method: "PUT", url: "https://a.test/y" });
    render(<ApiRequestView requestId={id} />);

    await user.click(await screen.findByTestId("api-duplicate"));

    const tabs = Object.values(state().tabs).filter((t) => t.ref.kind === "api-request");
    expect(tabs).toHaveLength(1); // the copy's tab; the original was rendered without one
    const ref = tabs[0].ref;
    if (ref.kind !== "api-request") throw new Error("unreachable");
    expect(ref.requestId).not.toBe(id);
    expect(state().apiRequests[ref.requestId].url).toBe("https://a.test/y");
  });
});

/** Seam: each half is covered alone, but the shipped bug lived in the join. Both halves are built
 * from ONE value, as ApiRequestView builds them. */
describe("Raw / Formatted — one tools row, one Copy, one search", () => {
  beforeEach(() => resetStore());
  // The pinning/scroll tests define `scrollIntoView`, which jsdom does not
  // have; removing it again keeps the component's `?.` exercised elsewhere.
  afterEach(() => {
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  const JSON_BODY = { name: "ada", role: "admin", team: "ada-team" };
  const jsonText = (value: unknown) => JSON.stringify(value, null, 2);

  /** Both halves of ONE response — exactly how ApiRequestView pairs them. */
  const renderJson = (value: unknown = JSON_BODY) =>
    render(
      <ResponseBody
        text={jsonText(value)}
        testId="api-response-body"
        copyLabel="the response"
        findKey={KEY}
        formatted={{ value }}
      />,
    );

  const toggle = () => screen.getByTestId("response-view-toggle");
  const count = () => screen.getByTestId("response-find-count").textContent;
  const other = () => screen.queryByTestId("response-find-other-count");

  it("names the view you switch TO — 'Formatted', never 'Tree'", async () => {
    const user = userEvent.setup();
    renderJson();
    // A JSON body opens FORMATTED, so the button offers the raw text…
    expect(screen.getByTestId("json-view")).toBeInTheDocument();
    expect(toggle()).toHaveTextContent("Raw");

    await user.click(toggle());
    // …and from the raw text it offers "Formatted".
    expect(toggle()).toHaveTextContent("Formatted");
    expect(toggle()).not.toHaveTextContent("Tree");
    expect(screen.queryByTestId("json-view")).toBeNull();
    expect(screen.getByTestId("api-response-body")).toHaveTextContent('"role": "admin"');
  });

  it("keeps Find and Copy in the SAME place in both views", async () => {
    const user = userEvent.setup();
    const { container } = renderJson();
    // The tools row is one node, above the view: its position in the DOM must
    // not depend on which view is on screen (a control that moves is worse
    // than one that is missing).
    const toolsOrder = () =>
      Array.from(container.querySelectorAll(".response-body__tools button")).map(
        (b) => b.getAttribute("data-testid"),
      );
    const expected = ["response-view-toggle", "response-find-toggle", "response-copy"];
    expect(toolsOrder()).toEqual(expected);
    const row = container.querySelector(".response-body__tools");
    // It is the FIRST child of the body — the view is drawn under it.
    expect(row?.parentElement?.firstElementChild).toBe(row);

    await user.click(toggle()); // → Raw
    expect(toolsOrder()).toEqual(expected);
    expect(row?.parentElement?.firstElementChild).toBe(row);
  });

  it("offers no view toggle at all when the body is not JSON", () => {
    renderBody("plain text");
    expect(screen.queryByTestId("response-view-toggle")).toBeNull();
    // …but Find and Copy are still there — they never depended on the toggle.
    expect(screen.getByTestId("response-copy")).toBeInTheDocument();
    expect(screen.getByTestId("response-find-toggle")).toBeInTheDocument();
  });

  it("copies the SAME string from both views — the raw text, never the tree's", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    // Set AFTER userEvent.setup().
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderJson();

    expect(screen.getByTestId("json-view")).toBeInTheDocument(); // Formatted
    await user.click(screen.getByTestId("response-copy"));
    const fromFormatted = writeText.mock.calls[0][0] as string;

    await user.click(toggle()); // → Raw
    await user.click(screen.getByTestId("response-copy"));
    const fromRaw = writeText.mock.calls[1][0] as string;

    // Two-sided: the value is right AND the two agree. Asserting
    // only that they match would pass if both were "".
    expect(fromFormatted).toBe(jsonText(JSON_BODY));
    expect(fromRaw).toBe(fromFormatted);
  });

  it("finds, marks and steps through matches inside the TREE", async () => {
    const user = userEvent.setup();
    renderJson();
    await user.click(screen.getByTestId("response-find-toggle"));
    await user.type(screen.getByTestId("response-find-input"), "am");

    // Hand-counted: the `name` key, the `team` key, the "ada-team" value.
    expect(count()).toBe("1/3");
    expect(screen.getAllByTestId("response-find-hit")).toHaveLength(2);
    const current = screen.getByTestId("response-find-current");
    expect(current).toHaveTextContent("am");
    // The hit is IN the tree, on the row it belongs to — not in a stray <pre>.
    expect(current.closest('[data-testid="json-view"]')).not.toBeNull();
    expect(current.closest("[data-key]")?.getAttribute("data-key")).toBe("name");

    await user.click(screen.getByTestId("response-find-next"));
    expect(count()).toBe("2/3");
    expect(
      screen.getByTestId("response-find-current").closest("[data-key]")
        ?.getAttribute("data-key"),
    ).toBe("team");
  });

  it("reports the SAME total in both views for a content query", async () => {
    const user = userEvent.setup();
    renderJson();
    await user.click(screen.getByTestId("response-find-toggle"));
    // Nothing typed yet: one total, and no second one to disagree with it.
    expect(count()).toBe("0 results");
    expect(other()).toBeNull();

    await user.type(screen.getByTestId("response-find-input"), "ada");
    expect(count()).toBe("1/2"); // "ada" and "ada-team", in the tree
    expect(other()).toBeNull(); // …the raw text finds the same two

    await user.click(toggle()); // → Raw
    // THE point of this test: the number does not move when the view does.
    expect(count()).toBe("1/2");
    expect(other()).toBeNull();
  });

  it("says so out loud when the two views genuinely cannot agree", async () => {
    const user = userEvent.setup();
    renderJson();
    await user.click(screen.getByTestId("response-find-toggle"));
    // `":` exists only in JSON punctuation, which the tree never draws.
    await user.type(screen.getByTestId("response-find-input"), '":');
    expect(count()).toBe("0 results");
    expect(other()).toHaveTextContent("Raw: 3");

    await user.click(toggle()); // → Raw
    expect(count()).toBe("1/3");
    expect(other()).toHaveTextContent("Formatted: 0");
  });

  it("clamps the cursor when the other view holds fewer matches", async () => {
    const user = userEvent.setup();
    renderJson();
    await user.click(screen.getByTestId("response-find-toggle"));
    await user.click(toggle()); // → Raw
    await user.type(screen.getByTestId("response-find-input"), '"');
    // 12 quotes in the raw text; 6 in the tree (values only — keys lose theirs).
    expect(count()).toBe("1/12");
    for (let i = 0; i < 7; i += 1) {
      await user.click(screen.getByTestId("response-find-next"));
    }
    expect(count()).toBe("8/12");

    await user.click(toggle()); // → Formatted
    // Never an "8/6": the cursor lands on the last match that exists here.
    expect(count()).toBe("6/6");
    expect(other()).toHaveTextContent("Raw: 12");
  });

  it("scrolls the matched node into view as you step through the tree", async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    Element.prototype.scrollIntoView = spy;
    renderJson();
    await user.click(screen.getByTestId("response-find-toggle"));
    await user.type(screen.getByTestId("response-find-input"), "am");
    expect(spy).toHaveBeenCalledWith({ block: "nearest" });

    spy.mockClear();
    await user.click(screen.getByTestId("response-find-next"));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("reopens a COLLAPSED node that holds a hit, and pins it while the query stands", async () => {
    const user = userEvent.setup();
    renderJson({ outer: { inner: "needle" }, other: 1 });
    const carets = () => screen.getAllByTestId("json-node-toggle");
    await user.click(carets()[1]); // collapse `outer`
    expect(screen.getByTestId("api-response-body")).not.toHaveTextContent("needle");

    await user.click(screen.getByTestId("response-find-toggle"));
    await user.type(screen.getByTestId("response-find-input"), "needle");
    // The counter claims a hit, so the tree SHOWS it…
    expect(count()).toBe("1/1");
    expect(screen.getByTestId("response-find-current")).toHaveTextContent("needle");
    // …and will not let it be hidden again while the query stands.
    expect(carets()[1]).toBeDisabled();

    await user.click(screen.getByTestId("response-find-close"));
    expect(carets()[1]).not.toBeDisabled();
    expect(screen.getByTestId("api-response-body")).not.toHaveTextContent("needle");
  });
});

describe("both surfaces get the same tools", () => {
  beforeEach(() => resetStore());

  it("labels the compare sides distinctly for assistive tech", () => {
    render(
      <>
        <ResponseBody text="a" testId="compare-raw-a" copyLabel="response A" findKey="compare:r1:a" />
        <ResponseBody text="b" testId="compare-raw-b" copyLabel="response B" findKey="compare:r1:b" />
      </>,
    );
    // This is required in both the A/B compare and the ordinary view;
    // two identically-named Copy buttons would be unusable by name.
    expect(screen.getByLabelText("Copy response A")).toBeInTheDocument();
    expect(screen.getByLabelText("Copy response B")).toBeInTheDocument();
    expect(screen.getByLabelText("Search response A")).toBeInTheDocument();
    const paneB = screen.getByTestId("compare-raw-b");
    expect(within(paneB).queryByText("a")).not.toBeInTheDocument();
  });
});

/** Pane unmounts inactive tabs, so unmount + remount is the tab switch at this tier; the real
 * surfaces repeat it (ApiRequestView.test.tsx, ComparePanel.test.tsx). */
describe("the find bar survives the tab (store-backed)", () => {
  beforeEach(() => resetStore());

  const VALUE = { alpha: "beta", gamma: "beta-2" };
  const TEXT = JSON.stringify(VALUE, null, 2);
  const view = (findKey: string) => (
    <ResponseBody
      text={TEXT}
      testId="api-response-body"
      copyLabel="the response"
      findKey={findKey}
      formatted={{ value: VALUE }}
    />
  );

  it("keeps the bar, query, view and cursor across unmount + remount", async () => {
    const user = userEvent.setup();
    const first = render(view(KEY));
    await user.click(screen.getByTestId("response-find-toggle"));
    await user.type(screen.getByTestId("response-find-input"), "beta");
    await user.click(screen.getByTestId("response-find-next")); // walk to match 2
    await user.click(screen.getByTestId("response-view-toggle")); // Formatted → Raw
    expect(screen.getByTestId("response-find-count")).toHaveTextContent("2/2");

    first.unmount(); // the tab switch: Pane drops the inactive tab's subtree

    render(view(KEY));
    // Everything that used to disappear is still there:
    expect(screen.getByTestId("response-find")).toBeInTheDocument();
    expect(screen.getByTestId("response-find-input")).toHaveValue("beta");
    // Still the RAW view (the toggle names the view you switch TO)…
    expect(screen.getByTestId("response-view-toggle")).toHaveTextContent("Formatted");
    expect(screen.queryByTestId("json-view")).toBeNull();
    // …and still standing on match 2.
    expect(screen.getByTestId("response-find-count")).toHaveTextContent("2/2");
  });

  it("does NOT bleed into a different findKey — the other tab starts closed", async () => {
    const user = userEvent.setup();
    const first = render(view(KEY));
    await user.click(screen.getByTestId("response-find-toggle"));
    await user.type(screen.getByTestId("response-find-input"), "beta");
    await user.click(screen.getByTestId("response-view-toggle")); // → Raw
    first.unmount();

    render(view("api:r2"));
    // Two-sided against the survival test: a fresh key is closed, empty, and
    // on the default Formatted view.
    expect(screen.queryByTestId("response-find")).toBeNull();
    expect(screen.getByTestId("json-view")).toBeInTheDocument();
  });

  it("clamps a restored cursor against a response that changed while the tab was away", async () => {
    const user = userEvent.setup();
    const first = render(
      <ResponseBody text="x x x" testId="api-response-body" copyLabel="the response" findKey={KEY} />,
    );
    await user.click(screen.getByTestId("response-find-toggle"));
    const input = screen.getByTestId("response-find-input");
    await user.type(input, "x");
    await user.click(screen.getByTestId("response-find-next"));
    await user.click(screen.getByTestId("response-find-next"));
    expect(screen.getByTestId("response-find-count")).toHaveTextContent("3/3");
    first.unmount();

    // A re-send landed while the tab was away: only ONE match exists now.
    render(
      <ResponseBody text="x alone" testId="api-response-body" copyLabel="the response" findKey={KEY} />,
    );
    // The stored cursor (2) is clamped into the current match list — never "3/1".
    expect(screen.getByTestId("response-find-count")).toHaveTextContent("1/1");
    expect(screen.getByTestId("response-find-input")).toHaveValue("x");
  });

  it("🔴 Next scrolls to the ONE match — a step that cannot move the cursor still jumps", async () => {
    const user = userEvent.setup();
    // jsdom has no scrollIntoView; the component optional-calls it, so a spy on
    // the prototype is what proves the jump was requested.
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      value: scrollIntoView,
      configurable: true,
      writable: true,
    });
    renderBody();
    await user.click(screen.getByTestId("response-find-toggle"));
    // "admin" appears exactly once in BODY.
    await user.type(screen.getByTestId("response-find-input"), "admin");
    expect(screen.getByTestId("response-find-count")).toHaveTextContent("1/1");

    scrollIntoView.mockClear();
    await user.click(screen.getByTestId("response-find-next"));

    // With one match `(0 + 1) % 1 === 0`: the cursor is unchanged, so before the
    // fix nothing re-ran and Next did nothing at all. The user asked to be taken
    // to the match; being already on it is not a reason to ignore them.
    expect(scrollIntoView).toHaveBeenCalled();
  });

  it("Next still walks a MULTI-match list — the nonce did not replace the cursor", async () => {
    const user = userEvent.setup();
    renderBody();
    await user.click(screen.getByTestId("response-find-toggle"));
    // "ada" appears twice in BODY (the value and the team name).
    await user.type(screen.getByTestId("response-find-input"), "ada");
    expect(screen.getByTestId("response-find-count")).toHaveTextContent("1/2");
    await user.click(screen.getByTestId("response-find-next"));
    // Two-sided with the test above: the fix must not make stepping a no-op.
    expect(screen.getByTestId("response-find-count")).toHaveTextContent("2/2");
    expect(state().findBars[KEY]).toMatchObject({ cursor: 1 });
  });

  it("Esc while reading RAW keeps the view — dismissing the search must not flip the body", async () => {
    const user = userEvent.setup();
    // `formatted` present: the view toggle only exists for a parseable body.
    render(
      <ResponseBody
        text={BODY}
        testId="api-response-body"
        copyLabel="the response"
        findKey={KEY}
        formatted={{ value: JSON.parse(BODY) }}
      />,
    );
    await user.click(screen.getByTestId("response-find-toggle"));
    await user.type(screen.getByTestId("response-find-input"), "ada");
    // The user's reading choice, made independently of the search…
    await user.click(screen.getByTestId("response-view-toggle"));
    expect(state().findBars[KEY]).toMatchObject({ view: "raw" });
    await user.keyboard("{Escape}");

    // …survives the search being dismissed: the bar state is zeroed, the view
    // stands. Two-sided with the test below: ONLY a raw view earns the
    // tombstone — the default-view close still deletes the record outright.
    expect(screen.queryByTestId("response-find")).toBeNull();
    expect(state().findBars[KEY]).toMatchObject({ open: false, query: "", view: "raw" });
    expect(screen.queryByTestId("json-view")).toBeNull();
  });

  it("Esc DROPS the record — absence is the closed state, no tombstone", async () => {
    const user = userEvent.setup();
    renderBody();
    await user.click(screen.getByTestId("response-find-toggle"));
    await user.type(screen.getByTestId("response-find-input"), "ada");
    // Two-sided: the record exists while the bar is up…
    expect(state().findBars[KEY]).toMatchObject({ open: true, query: "ada" });

    await user.keyboard("{Escape}");
    // …and Esc deletes it outright rather than zeroing it.
    expect(state().findBars[KEY]).toBeUndefined();
    expect(screen.queryByTestId("response-find")).toBeNull();
  });

  it("the ✕ drops the record exactly like Esc", async () => {
    const user = userEvent.setup();
    renderBody();
    await user.click(screen.getByTestId("response-find-toggle"));
    await user.type(screen.getByTestId("response-find-input"), "ada");
    await user.click(screen.getByTestId("response-find-close"));
    expect(state().findBars[KEY]).toBeUndefined();
  });

  it("the Find toggle closes SOFTLY — the query survives a toggle-close/reopen", async () => {
    // Pins the deliberate asymmetry: Esc/✕ forget the bar; the toggle merely
    // hides it (the old `setOpen(v => !v)` semantics, now `{open: !open}`).
    const user = userEvent.setup();
    renderBody();
    await user.click(screen.getByTestId("response-find-toggle"));
    await user.type(screen.getByTestId("response-find-input"), "ada");
    await user.click(screen.getByTestId("response-find-toggle")); // hide
    expect(screen.queryByTestId("response-find")).toBeNull();
    expect(state().findBars[KEY]).toMatchObject({ open: false, query: "ada" });

    await user.click(screen.getByTestId("response-find-toggle")); // show again
    expect(screen.getByTestId("response-find-input")).toHaveValue("ada");
  });
});

/* ═══════════════════ Cmd/Ctrl+F seeds from the selection ═══════════════════ */

/** Asserts the response was SEARCHED, not just the box filled. jsdom's focus() collapses the
 * selection (browsers don't), so select AFTER focusing. Selection.toString() adds no block breaks,
 * so the raw view's single <pre> gives an honest multi-line selection. */
describe("response search — Cmd/Ctrl+F seeds from the selection", () => {
  beforeEach(() => resetStore());

  afterEach(() => window.getSelection()?.removeAllRanges());

  /** A pretty-printed body: its `<pre>` text node carries real line breaks. */
  const PRETTY = ['{', '  "name": "ada",', '  "role": "admin"', '}'].join("\n");

  /** The focusable box `ResponseBody` reads the selection inside. */
  const boxOf = (): HTMLElement =>
    screen.getByTestId("api-response-body").closest(".response-body") as HTMLElement;

  const findInput = (): HTMLInputElement =>
    screen.getByTestId<HTMLInputElement>("response-find-input");

  /** Select the first occurrence of `text` in one of the body's text nodes. */
  function selectInBody(text: string): void {
    const walker = document.createTreeWalker(boxOf(), NodeFilter.SHOW_TEXT);
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
    // Loud, not silent: a fixture that stopped containing the text would make
    // every assertion in the calling test vacuous.
    throw new Error(`no text node in the response contains ${JSON.stringify(text)}`);
  }

  /** Focus the box, select `text`, then press Cmd+F — the real order. */
  function pressFindAfterSelecting(text: string): void {
    boxOf().focus();
    selectInBody(text);
    fireEvent.keyDown(boxOf(), { key: "f", metaKey: true });
  }

  /** The find input is focused on a `setTimeout(…, 0)`; let it land. */
  async function settleFocus(): Promise<void> {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it("seeds a single-line selection AND searches it", () => {
    renderBody();

    pressFindAfterSelecting("admin");

    expect(findInput()).toHaveValue("admin");
    // It searched: the match is marked as the current one and the counter agrees.
    expect(screen.getByTestId("response-find-current")).toHaveTextContent("admin");
    expect(screen.getByTestId("response-find-count")).toHaveTextContent("1/1");
  });

  it("selects the seeded text, so the next keystroke replaces it", async () => {
    renderBody();

    pressFindAfterSelecting("admin");
    await settleFocus();

    const input = findInput();
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe("admin".length);
  });

  it("OVERWRITES the query of an already-open bar, re-searches, and restarts at the first match", () => {
    renderBody();
    boxOf().focus();
    fireEvent.keyDown(boxOf(), { key: "f", metaKey: true });
    fireEvent.change(findInput(), { target: { value: "ada" } });
    fireEvent.click(screen.getByTestId("response-find-next")); // walk to match 2
    expect(screen.getByTestId("response-find-count")).toHaveTextContent("2/2");

    // "team" also has two matches, so a cursor left at 1 would read "2/2" here
    // too — the discriminator is that it reads 1/2. Typing a new query zeroes
    // the cursor (`onChange` writes `cursor: 0`); seeding one must do the same.
    pressFindAfterSelecting("team");

    expect(findInput()).toHaveValue("team");
    expect(screen.getByTestId("response-find-count")).toHaveTextContent("1/2");
    expect(screen.getByTestId("response-find-current")).toHaveTextContent("team");
  });

  it("re-seeding the SAME query keeps the user's place — a refocus, not a new search", () => {
    // The editor's bar skips its own dispatch for an unchanged query; this is
    // that rule, here. Without it the record's cursor would be
    // zeroed behind a rendered "2/2" and the place would jump on the next mount.
    renderBody();
    boxOf().focus();
    fireEvent.keyDown(boxOf(), { key: "f", metaKey: true });
    fireEvent.change(findInput(), { target: { value: "ada" } });
    fireEvent.click(screen.getByTestId("response-find-next"));
    expect(screen.getByTestId("response-find-count")).toHaveTextContent("2/2");

    pressFindAfterSelecting("ada");

    expect(findInput()).toHaveValue("ada");
    expect(screen.getByTestId("response-find-count")).toHaveTextContent("2/2");
    expect(state().findBars[KEY]).toMatchObject({ query: "ada", cursor: 1 });
  });

  it("leaves the query UNTOUCHED for a MULTI-LINE selection — it does not clear it", () => {
    renderBody(PRETTY);
    boxOf().focus();
    fireEvent.keyDown(boxOf(), { key: "f", metaKey: true });
    fireEvent.change(findInput(), { target: { value: "ada" } });
    expect(screen.getByTestId("response-find-count")).toHaveTextContent("1/1");

    // Spans two lines of the pretty-printed body — a real `\n` in the <pre>.
    // Chosen to sit inside ONE text node: the open bar has already split the
    // <pre> around its <mark>, so a span crossing "ada" would exist in no node.
    pressFindAfterSelecting('"role": "admin"\n}');

    expect(findInput()).toHaveValue("ada");
    expect(screen.getByTestId("response-find-count")).toHaveTextContent("1/1");
  });

  it("ignores a selection that lives OUTSIDE this body", () => {
    // The A/B compare shape in miniature: two of these render side by side, and
    // a selection in one must never seed the other (ComparePanel.test.tsx drives
    // the real two-pane version).
    renderBody();
    const stranger = document.createElement("div");
    stranger.append(document.createTextNode("somebody else's text"));
    document.body.append(stranger);
    boxOf().focus();
    const range = document.createRange();
    range.selectNodeContents(stranger);
    const selection = window.getSelection() as Selection;
    selection.removeAllRanges();
    selection.addRange(range);

    fireEvent.keyDown(boxOf(), { key: "f", metaKey: true });

    expect(findInput()).toHaveValue("");
    stranger.remove();
  });

  it("with NOTHING selected the bar opens empty and focused, exactly as it always has", async () => {
    renderBody();

    boxOf().focus();
    fireEvent.keyDown(boxOf(), { key: "f", metaKey: true });
    await settleFocus();

    expect(findInput()).toHaveValue("");
    expect(document.activeElement).toBe(findInput());
    expect(screen.queryByTestId("response-find-current")).not.toBeInTheDocument();
  });

  it("the Find BUTTON selects the query too — the same bar, the same affordance", async () => {
    // Not a seeding path (a click is not a selection gesture), but it shares the
    // input: leaving one of the two ways of opening it focus-only would be the
    // divergence this shared affordance exists to close.
    const user = userEvent.setup();
    renderBody();
    await user.click(screen.getByTestId("response-find-toggle"));
    await user.type(findInput(), "ada");
    await user.click(screen.getByTestId("response-find-toggle")); // hide
    await user.click(screen.getByTestId("response-find-toggle")); // show again
    await settleFocus();

    expect(findInput().selectionStart).toBe(0);
    expect(findInput().selectionEnd).toBe("ada".length);
  });
});
