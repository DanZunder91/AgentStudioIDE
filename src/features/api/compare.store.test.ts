/** The `compare` store slice: initial sub-state and every `setCompare*` action. STARTING a send
 * clears both outcomes (no stale side beside a live one); `sending` belongs to the executor. */

import { beforeEach, describe, expect, it } from "vitest";

import { useAppStore } from "../../app/store";
import { resetStore } from "../../test/store-harness";
import type { HttpResponse } from "./httpIpc";

const api = () => useAppStore.getState().apiActions;
const compareOf = (id: string) =>
  useAppStore.getState().apiRequests[id].compare;

const response = (over: Partial<HttpResponse> = {}): HttpResponse => ({
  status: 200,
  statusText: "OK",
  headers: [],
  body: '{"ok":true}',
  durationMs: 42,
  sizeBytes: 11,
  truncated: false,
  ...over,
});

describe("compare store slice", () => {
  beforeEach(() => {
    resetStore();
  });

  it("a fresh request is born with compare OFF and everything empty", () => {
    const id = api().createApiRequest();
    expect(compareOf(id)).toEqual({
      enabled: false,
      method: "GET",
      url: "",
      sending: false,
      a: { response: null, error: null },
      b: { response: null, error: null },
      selectedKey: null,
      sortKeys: false,
    });
  });

  it("setCompareEnabled flips the mode both ways", () => {
    const id = api().createApiRequest();
    api().setCompareEnabled(id, true);
    expect(compareOf(id).enabled).toBe(true);
    api().setCompareEnabled(id, false);
    expect(compareOf(id).enabled).toBe(false);
  });

  it("patchCompare updates B's method and url without touching A's", () => {
    const id = api().createApiRequest();
    api().patchApiRequest(id, { method: "POST", url: "https://a.test/x" });
    api().patchCompare(id, { method: "PUT", url: "https://b.test/y" });
    const req = useAppStore.getState().apiRequests[id];
    expect(req.compare.method).toBe("PUT");
    expect(req.compare.url).toBe("https://b.test/y");
    expect(req.method).toBe("POST");
    expect(req.url).toBe("https://a.test/x");
  });

  it("starting a send clears BOTH previous outcomes; settling it keeps them", () => {
    const id = api().createApiRequest();
    api().setCompareResponse(id, "a", response());
    api().setCompareError(id, "b", "boom");
    api().setCompareSending(id, true);
    expect(compareOf(id)).toMatchObject({
      sending: true,
      a: { response: null, error: null },
      b: { response: null, error: null },
    });
    api().setCompareResponse(id, "b", response({ status: 201 }));
    api().setCompareSending(id, false);
    expect(compareOf(id).sending).toBe(false);
    expect(compareOf(id).b.response?.status).toBe(201);
  });

  it("each side lands independently and does NOT settle the sending flag", () => {
    const id = api().createApiRequest();
    api().setCompareSending(id, true);
    api().setCompareResponse(id, "a", response());
    expect(compareOf(id).a.response?.status).toBe(200);
    expect(compareOf(id).b).toEqual({ response: null, error: null });
    expect(compareOf(id).sending).toBe(true);
  });

  it("a response clears that side's error, and an error clears that side's response", () => {
    const id = api().createApiRequest();
    api().setCompareError(id, "a", "dns failure");
    api().setCompareResponse(id, "a", response());
    expect(compareOf(id).a).toEqual({ response: response(), error: null });
    api().setCompareError(id, "a", "timed out");
    expect(compareOf(id).a).toEqual({ response: null, error: "timed out" });
  });

  it("an outcome on one side never touches the other side", () => {
    const id = api().createApiRequest();
    api().setCompareResponse(id, "b", response({ status: 404 }));
    expect(compareOf(id).a).toEqual({ response: null, error: null });
    expect(compareOf(id).b.response?.status).toBe(404);
  });

  it("selectedKey sets and clears; sortKeys flips both ways", () => {
    const id = api().createApiRequest();
    api().setCompareSelectedKey(id, "name");
    expect(compareOf(id).selectedKey).toBe("name");
    api().setCompareSelectedKey(id, null);
    expect(compareOf(id).selectedKey).toBeNull();
    api().setCompareSortKeys(id, true);
    expect(compareOf(id).sortKeys).toBe(true);
    api().setCompareSortKeys(id, false);
    expect(compareOf(id).sortKeys).toBe(false);
  });

  it("every compare action is a no-op on an unknown request id", () => {
    const id = api().createApiRequest();
    const before = useAppStore.getState().apiRequests;
    api().setCompareEnabled("ghost", true);
    api().patchCompare("ghost", { url: "https://x.test" });
    api().setCompareSending("ghost", true);
    api().setCompareResponse("ghost", "a", response());
    api().setCompareError("ghost", "b", "boom");
    api().setCompareSelectedKey("ghost", "k");
    api().setCompareSortKeys("ghost", true);
    // Nothing was created for the ghost id, and the real request is untouched.
    expect(useAppStore.getState().apiRequests).toEqual(before);
    expect(compareOf(id).enabled).toBe(false);
  });
});
