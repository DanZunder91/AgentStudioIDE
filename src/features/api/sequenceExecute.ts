/** Run-all loops over executeSequenceStep, the only send path. Unlike compareExecute, steps are
 * awaited in order and {{VAR}} is re-resolved per step (captures feed later steps): keep it so.
 * A capture miss fails the step, since substituteVars would silently send an empty value. */

import { useAppStore } from "../../app/store";
import { extractPath } from "./extractPath";
import { executeHttpRequest } from "./execute";
import { parseJsonBody } from "./responseFormat";

/** How long to wait for one step's response before calling it a timeout. */
const STEP_TIMEOUT_MS = 120_000;
/** How often to look at the store while a step is in flight. */
const POLL_MS = 25;

/** The store slice this module reads, narrowed for testability. */
function state() {
  return useAppStore.getState();
}

/** executeHttpRequest is fire-and-forget, so poll the store for the result (no subscription
 * lifecycle to tear down per step). */
async function awaitSend(requestId: string): Promise<{ timedOut: boolean }> {
  const started = Date.now();
  for (;;) {
    const req = state().apiRequests[requestId];
    if (!req || !req.sending) return { timedOut: false };
    if (Date.now() - started > STEP_TIMEOUT_MS) return { timedOut: true };
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

/** Did this response satisfy the step's expectation? */
function statusFailure(status: number, expect: number | null): string | null {
  if (expect === null) {
    return status >= 200 && status < 300 ? null : `Expected a 2xx, got ${status}`;
  }
  return status === expect ? null : `Expected ${expect}, got ${status}`;
}

/** Returns pass/fail for stopOnFailure. Manual steps see earlier captures: the bag lives on the
 * sequence. */
export async function executeSequenceStep(sequenceId: string, stepId: string): Promise<boolean> {
  const seq = state().sequences[sequenceId];
  const step = seq?.steps.find((t) => t.id === stepId);
  if (!seq || !step) return false;
  if (step.outcome === "running") return false; // already in flight

  const actions = state().sequenceActions;
  // Checked BEFORE sending: `executeHttpRequest` bails silently on both of these,
  // and a step that never left would otherwise sit here until the poll timed out.
  // The two are told apart because they need different actions from the user.
  const pending = state().apiRequests[step.requestId];
  if (!pending) {
    actions.setStepOutcome(sequenceId, stepId, "failed", "This step's request is gone.", {});
    return false;
  }
  if (pending.url.trim() === "") {
    actions.setStepOutcome(sequenceId, stepId, "failed", "This step has no URL yet.", {});
    return false;
  }
  actions.setStepOutcome(sequenceId, stepId, "running", null, {});

  // `seq` was read at the top of THIS call and nothing has awaited since, so its
  // bag is current: `executeSequence` re-enters this function per step, which is
  // what makes each step see the previous one's captures.
  executeHttpRequest(step.requestId, seq.captured);
  const { timedOut } = await awaitSend(step.requestId);

  // Non-null: the pre-send check above proved it exists and nothing disposes a
  // request while it is in flight.
  const req = state().apiRequests[step.requestId]!;

  // A transport failure is a failure, never a silent pass. Postman's runner
  // reporting "2 passes, 0 fails" for a run whose request errored is the exact
  // shape being avoided here.
  if (req.error !== null) {
    actions.setStepOutcome(sequenceId, stepId, "failed", req.error, {});
    return false;
  }
  const response = req.response;
  if (!response) {
    // Only the poll timeout lands here (a send always settles into a response or an error), so say
    // it timed out rather than "no response".
    void timedOut;
    actions.setStepOutcome(
      sequenceId,
      stepId,
      "failed",
      `Timed out after ${Math.round(STEP_TIMEOUT_MS / 1000)} s.`,
      {},
    );
    return false;
  }

  const badStatus = statusFailure(response.status, step.expectStatus);
  if (badStatus !== null) {
    actions.setStepOutcome(sequenceId, stepId, "failed", badStatus, {});
    return false;
  }

  // ── captures ──────────────────────────────────────────────────────────────
  const named = step.captures.filter((c) => c.name.trim() !== "" && c.path.trim() !== "");
  if (named.length === 0) {
    actions.setStepOutcome(sequenceId, stepId, "passed", null, {});
    return true;
  }

  const parsed = parseJsonBody(response);
  if (!parsed.isJson) {
    actions.setStepOutcome(
      sequenceId,
      stepId,
      "failed",
      "This step captures a value, but the response is not JSON.",
      {},
    );
    return false;
  }

  const values: Record<string, string> = {};
  for (const cap of named) {
    const got = extractPath(parsed.value, cap.path);
    if (!got.found) {
      // Name BOTH the capture and where the walk stopped — the user has to know
      // which of several captures failed, not just that one did.
      actions.setStepOutcome(
        sequenceId,
        stepId,
        "failed",
        `Capture "${cap.name.trim()}" — ${got.reason}`,
        values,
      );
      return false;
    }
    values[cap.name.trim()] = got.value;
  }

  actions.mergeSequenceCaptured(sequenceId, values);
  actions.setStepOutcome(sequenceId, stepId, "passed", null, values);
  return true;
}

/** Resets captures first. On failure with stopOnFailure the rest are marked skipped, not idle, so
 * "stopped before this" reads differently from "never ran". */
export async function executeSequence(sequenceId: string): Promise<void> {
  const seq = state().sequences[sequenceId];
  if (!seq || seq.running) return;

  const actions = state().sequenceActions;
  actions.resetSequenceRun(sequenceId);
  actions.setSequenceRunning(sequenceId, true);

  try {
    const stepIds = seq.steps.map((t) => t.id);
    for (let i = 0; i < stepIds.length; i++) {
      const passed = await executeSequenceStep(sequenceId, stepIds[i]);
      if (!passed && state().sequences[sequenceId]?.stopOnFailure === true) {
        for (const rest of stepIds.slice(i + 1)) {
          actions.setStepOutcome(sequenceId, rest, "skipped", null, {});
        }
        return;
      }
    }
  } finally {
    actions.setSequenceRunning(sequenceId, false);
  }
}
