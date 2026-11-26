/** Real store and real executeHttpRequest, only IPC mocked: a value captured from step 1 must
 * reach step 2's wire, which a stubbed send cannot show. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const httpIpc = vi.hoisted(() => ({ sendHttp: vi.fn() }));
vi.mock("./httpIpc", () => httpIpc);
const grpcIpc = vi.hoisted(() => ({ grpcSend: vi.fn(), grpcReflect: vi.fn() }));
vi.mock("./grpcIpc", () => grpcIpc);
const historyIpc = vi.hoisted(() => ({ loadApiHistory: vi.fn(), saveApiHistory: vi.fn() }));
vi.mock("./historyIpc", () => historyIpc);
const apiStoreIpc = vi.hoisted(() => ({ loadApiStore: vi.fn(), saveApiStore: vi.fn() }));
vi.mock("./apiStoreIpc", () => apiStoreIpc);

import type { HttpRequest, HttpResponse } from "./httpIpc";
import { useAppStore } from "../../app/store";
import { resetStore } from "../../test/store-harness";
import { executeSequence, executeSequenceStep } from "./sequenceExecute";

const state = () => useAppStore.getState();
const seqActions = () => state().sequenceActions;
const apiActions = () => state().apiActions;

/** A JSON response with the given status and body. */
function jsonResponse(status: number, body: unknown): HttpResponse {
  const text = JSON.stringify(body);
  return {
    status,
    statusText: "OK",
    headers: [{ name: "content-type", value: "application/json" }],
    body: text,
    durationMs: 5,
    sizeBytes: text.length,
    truncated: false,
  };
}

/** Build a sequence of `n` steps, each a POST to a distinct url. */
function buildSequence(n: number): { id: string; stepIds: string[] } {
  const id = seqActions().createSequence();
  const stepIds: string[] = [];
  for (let i = 0; i < n; i++) {
    const stepId = seqActions().addSequenceStep(id);
    stepIds.push(stepId);
    const step = state().sequences[id].steps.find((t) => t.id === stepId)!;
    apiActions().patchApiRequest(step.requestId, {
      url: `https://api.test/step${i + 1}`,
      method: "POST",
    });
  }
  return { id, stepIds };
}

const stepOf = (seqId: string, stepId: string) =>
  state().sequences[seqId].steps.find((t) => t.id === stepId)!;

/** Every url `sendHttp` was actually called with, in order. */
const sentUrls = () =>
  httpIpc.sendHttp.mock.calls.map((c) => (c[0] as HttpRequest).url);

describe("executeSequence", () => {
  beforeEach(() => {
    resetStore();
    httpIpc.sendHttp.mockReset();
    historyIpc.saveApiHistory.mockResolvedValue(undefined);
    apiStoreIpc.saveApiStore.mockResolvedValue(undefined);
  });
  afterEach(() => vi.useRealTimers());

  it("runs the steps IN ORDER, not in parallel", async () => {
    const { id } = buildSequence(3);
    httpIpc.sendHttp.mockResolvedValue(jsonResponse(200, { ok: true }));

    await executeSequence(id);

    expect(sentUrls()).toEqual([
      "https://api.test/step1",
      "https://api.test/step2",
      "https://api.test/step3",
    ]);
    expect(state().sequences[id].steps.map((t) => t.outcome)).toEqual([
      "passed",
      "passed",
      "passed",
    ]);
    expect(state().sequences[id].running).toBe(false);
  });

  it("carries a captured value into the NEXT step's wire request", async () => {
    const { id, stepIds } = buildSequence(2);
    seqActions().addStepCapture(id, stepIds[0]);
    const capId = stepOf(id, stepIds[0]).captures[0].id;
    seqActions().setStepCapture(id, stepIds[0], capId, { name: "jwt", path: "data.jwt" });

    // Step 2 uses it in a header — the thing the whole feature exists for.
    const step2 = stepOf(id, stepIds[1]);
    apiActions().addHeader(step2.requestId);
    const headerId = state().apiRequests[step2.requestId].headers[0].id;
    apiActions().updateHeader(step2.requestId, headerId, {
      name: "authorization",
      value: "Bearer {{jwt}}",
    });

    httpIpc.sendHttp
      .mockResolvedValueOnce(jsonResponse(200, { data: { jwt: "TOKEN-123" } }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    await executeSequence(id);

    const second = httpIpc.sendHttp.mock.calls[1][0] as HttpRequest;
    expect(second.headers).toContainEqual({ name: "authorization", value: "Bearer TOKEN-123" });
    expect(state().sequences[id].captured).toEqual({ jwt: "TOKEN-123" });
  });

  it("keeps the captured token OUT of history — history holds the template", async () => {
    const { id, stepIds } = buildSequence(2);
    seqActions().addStepCapture(id, stepIds[0]);
    const capId = stepOf(id, stepIds[0]).captures[0].id;
    seqActions().setStepCapture(id, stepIds[0], capId, { name: "jwt", path: "data.jwt" });
    const step2 = stepOf(id, stepIds[1]);
    apiActions().addHeader(step2.requestId);
    const headerId = state().apiRequests[step2.requestId].headers[0].id;
    apiActions().updateHeader(step2.requestId, headerId, {
      name: "authorization",
      value: "Bearer {{jwt}}",
    });
    httpIpc.sendHttp
      .mockResolvedValueOnce(jsonResponse(200, { data: { jwt: "TOKEN-123" } }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    await executeSequence(id);

    // Two-sided: the WIRE carried the real token (asserted above), and the
    // recorded history carries the placeholder instead.
    const recorded = state().apiHistory.flatMap((h) => h.headers);
    expect(recorded).toContainEqual({ name: "authorization", value: "Bearer {{jwt}}" });
    expect(JSON.stringify(state().apiHistory)).not.toContain("TOKEN-123");
  });

  it("fails the step and NAMES the capture and the reason when a path misses", async () => {
    const { id, stepIds } = buildSequence(2);
    seqActions().addStepCapture(id, stepIds[0]);
    const capId = stepOf(id, stepIds[0]).captures[0].id;
    seqActions().setStepCapture(id, stepIds[0], capId, { name: "jwt", path: "data.jwt" });
    httpIpc.sendHttp.mockResolvedValue(jsonResponse(200, { data: {} }));

    await executeSequence(id);

    const failed = stepOf(id, stepIds[0]);
    expect(failed.outcome).toBe("failed");
    // The message must carry BOTH which capture failed and where the walk stopped —
    // otherwise the user is back to guessing, which is the whole defect this
    // feature is designed around.
    expect(failed.failure).toContain("jwt");
    expect(failed.failure).toContain("data");
    // And step 2 never went out with an empty credential.
    expect(sentUrls()).toEqual(["https://api.test/step1"]);
  });

  it("marks the remaining steps SKIPPED, distinct from never-ran", async () => {
    const { id, stepIds } = buildSequence(3);
    httpIpc.sendHttp.mockResolvedValue(jsonResponse(500, { ok: false }));

    await executeSequence(id);

    expect(stepOf(id, stepIds[0]).outcome).toBe("failed");
    expect(stepOf(id, stepIds[1]).outcome).toBe("skipped");
    expect(stepOf(id, stepIds[2]).outcome).toBe("skipped");
  });

  it("runs every step anyway when stopOnFailure is off", async () => {
    const { id, stepIds } = buildSequence(3);
    seqActions().setStopOnFailure(id, false);
    httpIpc.sendHttp.mockResolvedValue(jsonResponse(500, { ok: false }));

    await executeSequence(id);

    // Two-sided against the test above: same failure, opposite policy, and now
    // nothing is skipped.
    expect(state().sequences[id].steps.map((t) => t.outcome)).toEqual([
      "failed",
      "failed",
      "failed",
    ]);
    expect(sentUrls()).toHaveLength(3);
    void stepIds;
  });

  it("honours expectStatus exactly, and treats null as any 2xx", async () => {
    const { id, stepIds } = buildSequence(1);
    httpIpc.sendHttp.mockResolvedValue(jsonResponse(201, {}));

    await executeSequence(id);
    expect(stepOf(id, stepIds[0]).outcome).toBe("passed"); // null → 2xx passes

    // Two-sided: an exact match passes…
    seqActions().setStepExpectStatus(id, stepIds[0], 201);
    await executeSequence(id);
    expect(stepOf(id, stepIds[0]).outcome).toBe("passed");

    // …and a mismatch fails, naming both numbers.
    seqActions().setStepExpectStatus(id, stepIds[0], 200);
    await executeSequence(id);
    const failed = stepOf(id, stepIds[0]);
    expect(failed.outcome).toBe("failed");
    expect(failed.failure).toBe("Expected 200, got 201");
  });

  it("fails on a transport error rather than counting it as a pass", async () => {
    const { id, stepIds } = buildSequence(1);
    httpIpc.sendHttp.mockRejectedValue("dns error: no such host");

    await executeSequence(id);

    const failed = stepOf(id, stepIds[0]);
    expect(failed.outcome).toBe("failed");
    expect(failed.failure).toContain("dns error");
  });

  it("fails a capture step whose response is not JSON", async () => {
    const { id, stepIds } = buildSequence(1);
    seqActions().addStepCapture(id, stepIds[0]);
    const capId = stepOf(id, stepIds[0]).captures[0].id;
    seqActions().setStepCapture(id, stepIds[0], capId, { name: "x", path: "a" });
    httpIpc.sendHttp.mockResolvedValue({
      ...jsonResponse(200, {}),
      headers: [{ name: "content-type", value: "text/plain" }],
      body: "plain",
    });

    await executeSequence(id);

    expect(stepOf(id, stepIds[0]).failure).toContain("not JSON");
  });

  it("fails a step that has no URL yet, and says so", async () => {
    const id = seqActions().createSequence();
    const stepId = seqActions().addSequenceStep(id); // url left empty
    await executeSequence(id);
    expect(stepOf(id, stepId).failure).toContain("no URL");
    expect(httpIpc.sendHttp).not.toHaveBeenCalled();
  });

  it("times out a step that never settles, and says so", async () => {
    vi.useFakeTimers();
    const { id, stepIds } = buildSequence(1);
    // A send that never resolves: the request stays `sending` forever.
    httpIpc.sendHttp.mockReturnValue(new Promise(() => {}));

    const run = executeSequenceStep(id, stepIds[0]);
    await vi.advanceTimersByTimeAsync(121_000);
    await run;

    expect(stepOf(id, stepIds[0]).failure).toContain("Timed out");
  });

  it("is a no-op while already running", async () => {
    const { id } = buildSequence(1);
    seqActions().setSequenceRunning(id, true);

    await executeSequence(id);

    expect(httpIpc.sendHttp).not.toHaveBeenCalled();
  });

  it("resets the previous run's captures before starting", async () => {
    const { id } = buildSequence(1);
    seqActions().mergeSequenceCaptured(id, { stale: "old" });
    httpIpc.sendHttp.mockResolvedValue(jsonResponse(200, {}));

    await executeSequence(id);

    // A run that inherited a stale token would report a green the next person
    // could not reproduce.
    expect(state().sequences[id].captured).toEqual({});
  });

  it("does nothing for an unknown sequence", async () => {
    await executeSequence("nope");
    expect(httpIpc.sendHttp).not.toHaveBeenCalled();
  });
});

describe("executeSequenceStep — manual stepping", () => {
  beforeEach(() => {
    resetStore();
    httpIpc.sendHttp.mockReset();
    historyIpc.saveApiHistory.mockResolvedValue(undefined);
    apiStoreIpc.saveApiStore.mockResolvedValue(undefined);
  });

  it("uses captures from an EARLIER, SEPARATE run", async () => {
    const { id, stepIds } = buildSequence(2);
    seqActions().addStepCapture(id, stepIds[0]);
    const capId = stepOf(id, stepIds[0]).captures[0].id;
    seqActions().setStepCapture(id, stepIds[0], capId, { name: "jwt", path: "data.jwt" });
    const step2 = stepOf(id, stepIds[1]);
    apiActions().addHeader(step2.requestId);
    const headerId = state().apiRequests[step2.requestId].headers[0].id;
    apiActions().updateHeader(step2.requestId, headerId, {
      name: "authorization",
      value: "Bearer {{jwt}}",
    });

    httpIpc.sendHttp.mockResolvedValueOnce(jsonResponse(200, { data: { jwt: "T1" } }));
    await executeSequenceStep(id, stepIds[0]); // one gesture

    httpIpc.sendHttp.mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    await executeSequenceStep(id, stepIds[1]); // a separate gesture, later

    const second = httpIpc.sendHttp.mock.calls[1][0] as HttpRequest;
    expect(second.headers).toContainEqual({ name: "authorization", value: "Bearer T1" });
  });

  it("leaves its siblings' outcomes untouched", async () => {
    const { id, stepIds } = buildSequence(2);
    httpIpc.sendHttp.mockResolvedValue(jsonResponse(200, {}));
    await executeSequenceStep(id, stepIds[0]);
    expect(stepOf(id, stepIds[0]).outcome).toBe("passed"); // two-sided: it IS passed…

    await executeSequenceStep(id, stepIds[1]);
    expect(stepOf(id, stepIds[0]).outcome).toBe("passed"); // …and still is
    expect(stepOf(id, stepIds[1]).outcome).toBe("passed");
  });

  it("is a no-op for an unknown step, and while that step is running", async () => {
    const { id, stepIds } = buildSequence(1);
    expect(await executeSequenceStep(id, "nope")).toBe(false);
    expect(await executeSequenceStep("nope", stepIds[0])).toBe(false);

    seqActions().setStepOutcome(id, stepIds[0], "running", null, {});
    expect(await executeSequenceStep(id, stepIds[0])).toBe(false);
    expect(httpIpc.sendHttp).not.toHaveBeenCalled();
  });

  it("fails calmly when the step's request has been disposed", async () => {
    const { id, stepIds } = buildSequence(1);
    const step = stepOf(id, stepIds[0]);
    useAppStore.setState((s) => {
      const next = { ...s.apiRequests };
      delete next[step.requestId];
      return { apiRequests: next };
    });

    expect(await executeSequenceStep(id, stepIds[0])).toBe(false);
    expect(stepOf(id, stepIds[0]).failure).toContain("gone");
  });
});
