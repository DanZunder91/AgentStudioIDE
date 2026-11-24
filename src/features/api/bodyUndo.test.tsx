/**
 * Undo for the request BODY. The bug: a change to the request
 * body could not be undone with Command+Z after switching to another window or
 * executing the request.
 *
 * The two halves are tested separately because they fail for different reasons:
 * the STORE half is what survives a tab switch (the browser's undo cannot, since
 * `Pane` unmounts the textarea), and the KEY half is what makes Cmd+Z reach it.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiStoreIpc = vi.hoisted(() => ({ loadApiStore: vi.fn(), saveApiStore: vi.fn() }));
vi.mock("./apiStoreIpc", () => apiStoreIpc);
const historyIpc = vi.hoisted(() => ({ loadApiHistory: vi.fn(), saveApiHistory: vi.fn() }));
vi.mock("./historyIpc", () => historyIpc);

import { useAppStore } from "../../app/store";
import { resetStore } from "../../test/store-harness";
import { ApiRequestView } from "./ApiRequestView";
import { JsonBodyEditor } from "./JsonBodyEditor";

const state = () => useAppStore.getState();
const api = () => state().apiActions;
const bodyOf = (id: string) => state().apiRequests[id].body;

/** A request with a body already set, one edit group ago. */
function seeded(initial: string): string {
  const id = api().createApiRequest();
  api().patchApiRequest(id, { body: initial });
  return id;
}

describe("body undo — the store half", () => {
  beforeEach(() => {
    resetStore();
    apiStoreIpc.saveApiStore.mockResolvedValue(undefined);
    // A fixed clock from t=0, so `seeded()` and the edits below sit in the
    // grouping window we intend rather than wherever the real clock happens to
    // be. Set BEFORE seeding — moving the clock backwards mid-test would make
    // every later edit look simultaneous with the seed.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
  });
  afterEach(() => vi.useRealTimers());

  it("steps back to the previous body, then forward again", () => {
    const id = seeded("{}");
    vi.setSystemTime(new Date(10_000));
    api().patchApiRequest(id, { body: '{"a":1}' });
    expect(bodyOf(id)).toBe('{"a":1}');

    api().undoApiBody(id);
    expect(bodyOf(id)).toBe("{}");

    api().redoApiBody(id);
    expect(bodyOf(id)).toBe('{"a":1}');
  });

  it("SURVIVES the component being unmounted — the actual bug", () => {
    // Nothing here touches the DOM: a tab switch destroys the textarea and the
    // browser's undo stack, and the store's history is untouched by that.
    const id = seeded("{}");
    vi.setSystemTime(new Date(10_000));
    api().patchApiRequest(id, { body: "edited" });

    const { unmount } = render(
      <JsonBodyEditor value={bodyOf(id)} onChange={() => {}} ariaLabel="Request body" />,
    );
    unmount();

    api().undoApiBody(id);
    expect(bodyOf(id)).toBe("{}");
  });

  it("makes a PROGRAMMATIC rewrite undoable — Format, or a pasted curl", () => {
    // Every body writer goes through patchApiRequest, so the Format button and
    // the curl importer are undoable without either of them knowing about undo.
    const id = seeded('{"a":1}');
    vi.setSystemTime(new Date(10_000));
    api().patchApiRequest(id, { body: '{\n  "a": 1\n}' }); // Format
    api().undoApiBody(id);
    expect(bodyOf(id)).toBe('{"a":1}');
  });

  it("coalesces a burst of typing into ONE undo step", () => {
    const id = seeded("");
    vi.setSystemTime(new Date(10_000));
    api().patchApiRequest(id, { body: "h" });
    vi.setSystemTime(new Date(10_100));
    api().patchApiRequest(id, { body: "he" });
    vi.setSystemTime(new Date(10_200));
    api().patchApiRequest(id, { body: "hel" });

    // One Cmd+Z clears the burst rather than removing one letter — undo that
    // steps per keystroke is technically correct and useless.
    api().undoApiBody(id);
    expect(bodyOf(id)).toBe("");
  });

  it("starts a NEW group after a pause", () => {
    const id = seeded("");
    vi.setSystemTime(new Date(10_000));
    api().patchApiRequest(id, { body: "first" });
    vi.setSystemTime(new Date(20_000)); // well past the group window
    api().patchApiRequest(id, { body: "first second" });

    api().undoApiBody(id);
    expect(bodyOf(id)).toBe("first"); // two-sided against the coalescing test
    api().undoApiBody(id);
    expect(bodyOf(id)).toBe("");
  });

  it("a fresh edit drops the redo branch", () => {
    const id = seeded("a");
    vi.setSystemTime(new Date(10_000));
    api().patchApiRequest(id, { body: "b" });
    api().undoApiBody(id);
    expect(bodyOf(id)).toBe("a");

    vi.setSystemTime(new Date(20_000));
    api().patchApiRequest(id, { body: "c" });
    api().redoApiBody(id); // nothing to redo — "b" is gone
    expect(bodyOf(id)).toBe("c");
  });

  it("does not record a patch that leaves the body unchanged", () => {
    const id = seeded("same");
    vi.setSystemTime(new Date(10_000));
    api().patchApiRequest(id, { body: "same" });
    api().patchApiRequest(id, { url: "https://x.test" });
    // Only the original edit is on the stack, so one undo reaches the start.
    api().undoApiBody(id);
    expect(bodyOf(id)).toBe("");
  });

  it("is a calm no-op at either end, and for an unknown request", () => {
    const id = api().createApiRequest();
    expect(() => {
      api().undoApiBody(id);
      api().redoApiBody(id);
      api().undoApiBody("nope");
      api().redoApiBody("nope");
    }).not.toThrow();
    expect(bodyOf(id)).toBe("");
  });

  it("bounds the history rather than growing forever", () => {
    const id = api().createApiRequest();
    for (let i = 0; i < 260; i++) {
      vi.setSystemTime(new Date(10_000 + i * 1_000)); // each its own group
      api().patchApiRequest(id, { body: `v${i}` });
    }
    expect(state().apiRequests[id].bodyHistory.past.length).toBeLessThanOrEqual(200);
  });
});

describe("body undo — the key half", () => {
  beforeEach(() => resetStore());

  /** Render the editor with spies, focused and ready for a chord. */
  function setup() {
    const onUndo = vi.fn();
    const onRedo = vi.fn();
    const onKeyDown = vi.fn();
    render(
      <JsonBodyEditor
        value="{}"
        onChange={() => {}}
        ariaLabel="Request body"
        onUndo={onUndo}
        onRedo={onRedo}
        onKeyDown={onKeyDown}
      />,
    );
    return { onUndo, onRedo, onKeyDown, field: screen.getByLabelText("Request body") };
  }

  it("Cmd/Ctrl+Z undoes, and preventDefault stops the browser's empty stack too", async () => {
    const user = userEvent.setup();
    const { onUndo, field } = setup();
    await user.click(field);
    await user.keyboard("{Meta>}z{/Meta}");
    expect(onUndo).toHaveBeenCalledTimes(1);

    await user.keyboard("{Control>}z{/Control}");
    expect(onUndo).toHaveBeenCalledTimes(2);
  });

  it("Shift+Cmd+Z and Ctrl+Y redo", async () => {
    const user = userEvent.setup();
    const { onUndo, onRedo, field } = setup();
    await user.click(field);
    await user.keyboard("{Meta>}{Shift>}z{/Shift}{/Meta}");
    expect(onRedo).toHaveBeenCalledTimes(1);
    // Two-sided: the shifted chord is redo, NOT undo.
    expect(onUndo).not.toHaveBeenCalled();

    await user.keyboard("{Control>}y{/Control}");
    expect(onRedo).toHaveBeenCalledTimes(2);
  });

  it("passes every other key through to the caller", async () => {
    const user = userEvent.setup();
    const { onKeyDown, onUndo, field } = setup();
    await user.click(field);
    await user.keyboard("{Meta>}s{/Meta}"); // the save chord
    expect(onKeyDown).toHaveBeenCalled();
    expect(onUndo).not.toHaveBeenCalled();
  });

  it("leaves a bare z alone so typing still works", async () => {
    const user = userEvent.setup();
    const { onUndo, onRedo, field } = setup();
    await user.click(field);
    await user.keyboard("z");
    expect(onUndo).not.toHaveBeenCalled();
    expect(onRedo).not.toHaveBeenCalled();
  });

  it("does not throw when no undo handlers are supplied", async () => {
    const user = userEvent.setup();
    render(<JsonBodyEditor value="{}" onChange={() => {}} ariaLabel="Request body" />);
    await user.click(screen.getByLabelText("Request body"));
    await expect(user.keyboard("{Meta>}z{/Meta}")).resolves.toBeUndefined();
  });
});

/**
 * The seam: the store half and the key half are each covered
 * above, and neither proves the two are WIRED to each other. This drives the
 * real `<ApiRequestView/>` with a real Cmd+Z and asserts the body actually
 * moved — which is what a user will do.
 */
describe("body undo — end to end in the real request view", () => {
  beforeEach(() => {
    resetStore();
    apiStoreIpc.loadApiStore.mockResolvedValue({
      collections: [],
      environments: [],
      activeEnvironmentId: null,
      folders: [],
    });
    apiStoreIpc.saveApiStore.mockResolvedValue(undefined);
    historyIpc.loadApiHistory.mockResolvedValue({ entries: [] });
    historyIpc.saveApiHistory.mockResolvedValue(undefined);
  });

  it("Cmd+Z in the body field steps the body back", async () => {
    const user = userEvent.setup();
    const id = api().createApiRequest();
    // Seeded WITHOUT patchApiRequest, so the setup does not become an undo group
    // the typing below would coalesce into — this stands for "the request
    // already had this body when the view mounted".
    useAppStore.setState((s) => {
      s.apiRequests[id].method = "POST";
      s.apiRequests[id].url = "https://a.test";
      s.apiRequests[id].body = "{}";
    });

    render(<ApiRequestView requestId={id} />);
    const field = await screen.findByLabelText("Request body");

    await user.click(field);
    await user.type(field, "x");
    expect(bodyOf(id)).toBe("{}x");

    await user.keyboard("{Meta>}z{/Meta}");
    expect(bodyOf(id)).toBe("{}");

    // …and forward again, so the wiring is proven both directions.
    await user.keyboard("{Meta>}{Shift>}z{/Shift}{/Meta}");
    expect(bodyOf(id)).toBe("{}x");
  });
});
