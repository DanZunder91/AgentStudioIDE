/** Editing and run bookkeeping only; sending is covered by sequenceExecute.test.ts. */

import { beforeEach, describe, expect, it, vi } from "vitest";

const apiStoreIpc = vi.hoisted(() => ({ loadApiStore: vi.fn(), saveApiStore: vi.fn() }));
vi.mock("./apiStoreIpc", () => apiStoreIpc);
const historyIpc = vi.hoisted(() => ({ loadApiHistory: vi.fn(), saveApiHistory: vi.fn() }));
vi.mock("./historyIpc", () => historyIpc);

import { useAppStore } from "../../app/store";
import { resetStore } from "../../test/store-harness";

const state = () => useAppStore.getState();
const a = () => state().sequenceActions;

describe("sequenceActions", () => {
  beforeEach(() => {
    resetStore();
    apiStoreIpc.saveApiStore.mockResolvedValue(undefined);
  });

  it("mints a sequence with stop-on-failure ON — both are supported, this is the default", () => {
    const id = a().createSequence();
    expect(state().sequences[id]).toMatchObject({
      name: "New sequence",
      steps: [],
      running: false,
      stopOnFailure: true,
      expandedStepId: null,
      captured: {},
    });
  });

  it("adds a step that OWNS a real request, and opens it", () => {
    const id = a().createSequence();
    const stepId = a().addSequenceStep(id);
    const step = state().sequences[id].steps[0];
    expect(step.id).toBe(stepId);
    // The step owns a real ApiRequestState — that is what lets it reuse the
    // whole request editor.
    expect(state().apiRequests[step.requestId]).toBeDefined();
    expect(state().sequences[id].expandedStepId).toBe(stepId);
  });

  it("removing a step disposes the request it owned", () => {
    const id = a().createSequence();
    const stepId = a().addSequenceStep(id);
    const requestId = state().sequences[id].steps[0].requestId;
    // Two-sided: it really was there first…
    expect(state().apiRequests[requestId]).toBeDefined();

    a().removeSequenceStep(id, stepId);

    // …and is gone now. Without this, every removed step leaks a request into
    // the store for the life of the process.
    expect(state().apiRequests[requestId]).toBeUndefined();
    expect(state().sequences[id].steps).toHaveLength(0);
    expect(state().sequences[id].expandedStepId).toBeNull();
  });

  it("reorders steps and round-trips", () => {
    const id = a().createSequence();
    const s1 = a().addSequenceStep(id);
    const s2 = a().addSequenceStep(id);
    const s3 = a().addSequenceStep(id);
    const order = () => state().sequences[id].steps.map((t) => t.id);
    expect(order()).toEqual([s1, s2, s3]);

    a().moveSequenceStep(id, s3, s1); // s3 before s1
    expect(order()).toEqual([s3, s1, s2]);

    a().moveSequenceStep(id, s3, null); // to the end
    expect(order()).toEqual([s1, s2, s3]);
  });

  it("expands one step at a time and collapses with null", () => {
    const id = a().createSequence();
    const s1 = a().addSequenceStep(id);
    const s2 = a().addSequenceStep(id);
    a().expandSequenceStep(id, s1);
    expect(state().sequences[id].expandedStepId).toBe(s1);
    a().expandSequenceStep(id, s2);
    expect(state().sequences[id].expandedStepId).toBe(s2);
    a().expandSequenceStep(id, null);
    expect(state().sequences[id].expandedStepId).toBeNull();
  });

  it("edits name, stop-on-failure and expect-status", () => {
    const id = a().createSequence();
    const stepId = a().addSequenceStep(id);
    a().setSequenceName(id, "Auth flow");
    a().setStopOnFailure(id, false);
    a().setStepExpectStatus(id, stepId, 201);
    expect(state().sequences[id].name).toBe("Auth flow");
    expect(state().sequences[id].stopOnFailure).toBe(false);
    expect(state().sequences[id].steps[0].expectStatus).toBe(201);
    a().setStepExpectStatus(id, stepId, null);
    expect(state().sequences[id].steps[0].expectStatus).toBeNull();
  });

  it("adds, patches and removes captures", () => {
    const id = a().createSequence();
    const stepId = a().addSequenceStep(id);
    a().addStepCapture(id, stepId);
    const cap = state().sequences[id].steps[0].captures[0];
    expect(cap).toMatchObject({ name: "", path: "" });

    a().setStepCapture(id, stepId, cap.id, { name: "jwt" });
    expect(state().sequences[id].steps[0].captures[0]).toMatchObject({ name: "jwt", path: "" });
    a().setStepCapture(id, stepId, cap.id, { path: "data.jwt" });
    expect(state().sequences[id].steps[0].captures[0]).toMatchObject({
      name: "jwt",
      path: "data.jwt",
    });

    a().removeStepCapture(id, stepId, cap.id);
    expect(state().sequences[id].steps[0].captures).toHaveLength(0);
  });

  it("merges captured values rather than replacing the bag", () => {
    const id = a().createSequence();
    a().mergeSequenceCaptured(id, { a: "1" });
    a().mergeSequenceCaptured(id, { b: "2" });
    // Two-sided: the earlier key survives AND the new one landed.
    expect(state().sequences[id].captured).toEqual({ a: "1", b: "2" });
    a().mergeSequenceCaptured(id, { a: "3" });
    expect(state().sequences[id].captured.a).toBe("3");
  });

  it("resetSequenceRun clears outcomes, failures AND the capture bag", () => {
    const id = a().createSequence();
    const stepId = a().addSequenceStep(id);
    a().setStepOutcome(id, stepId, "failed", "boom", { x: "1" });
    a().mergeSequenceCaptured(id, { tok: "stale" });
    // It really was dirty first.
    expect(state().sequences[id].captured).toEqual({ tok: "stale" });

    a().resetSequenceRun(id);

    expect(state().sequences[id].steps[0]).toMatchObject({
      outcome: "idle",
      failure: null,
      capturedPreview: {},
    });
    // A run that inherited a stale token would report a green nobody can reproduce.
    expect(state().sequences[id].captured).toEqual({});
  });

  it("every action is a calm no-op for an unknown sequence or step", () => {
    // Reachable through the UI whenever a tab outlives its sequence.
    expect(() => {
      a().addSequenceStep("nope");
      a().removeSequenceStep("nope", "x");
      a().moveSequenceStep("nope", "x", null);
      a().setSequenceName("nope", "n");
      a().setStopOnFailure("nope", true);
      a().expandSequenceStep("nope", null);
      a().setStepExpectStatus("nope", "x", 1);
      a().addStepCapture("nope", "x");
      a().setStepCapture("nope", "x", "c", { name: "n" });
      a().removeStepCapture("nope", "x", "c");
      a().setStepOutcome("nope", "x", "passed", null, {});
      a().setSequenceRunning("nope", true);
      a().mergeSequenceCaptured("nope", {});
      a().resetSequenceRun("nope");
    }).not.toThrow();
    expect(state().sequences["nope"]).toBeUndefined();

    // And a real sequence with an unknown STEP id is equally inert.
    const id = a().createSequence();
    a().setStepCapture(id, "no-step", "no-cap", { name: "x" });
    a().removeStepCapture(id, "no-step", "no-cap");
    a().setStepExpectStatus(id, "no-step", 200);
    a().addStepCapture(id, "no-step");
    a().setStepOutcome(id, "no-step", "passed", null, {});
    expect(state().sequences[id].steps).toHaveLength(0);
  });

  it("removing a step whose request is already gone is still clean", () => {
    // Reachable whenever something else disposed the request first; the step
    // must still go, without touching a key that is not there.
    const id = a().createSequence();
    const stepId = a().addSequenceStep(id);
    const requestId = state().sequences[id].steps[0].requestId;
    useAppStore.setState((s) => {
      const next = { ...s.apiRequests };
      delete next[requestId];
      return { apiRequests: next };
    });
    a().removeSequenceStep(id, stepId);
    expect(state().sequences[id].steps).toHaveLength(0);
  });

  it("removing an unknown STEP of a real sequence changes nothing", () => {
    const id = a().createSequence();
    a().addSequenceStep(id);
    a().removeSequenceStep(id, "no-such-step");
    expect(state().sequences[id].steps).toHaveLength(1);
    expect(Object.keys(state().apiRequests)).toHaveLength(1);
  });

  it("titles a tab opened on an unknown sequence id without inventing a name", () => {
    const tabId = state().layoutActions.openSequenceTab("no-such-sequence");
    expect(state().tabs[tabId].title).toBe("Sequence");
  });

  it("opens a sequence tab titled by the sequence's name", () => {
    const id = a().createSequence();
    a().setSequenceName(id, "Auth flow");
    const tabId = state().layoutActions.openSequenceTab(id);
    expect(state().tabs[tabId]).toMatchObject({
      kind: "sequence",
      title: "Auth flow",
      ref: { kind: "sequence", sequenceId: id },
    });
  });

  it("openSequenceTab mints a sequence when given none", () => {
    const tabId = state().layoutActions.openSequenceTab();
    const ref = state().tabs[tabId].ref;
    expect(ref.kind).toBe("sequence");
    if (ref.kind !== "sequence") throw new Error("unreachable");
    expect(state().sequences[ref.sequenceId]).toBeDefined();
  });
});
