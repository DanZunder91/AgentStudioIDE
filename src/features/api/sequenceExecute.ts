/**
 * sequenceExecute — run a sequence of requests, carrying captured values forward
 * (a sequence of requests to test a flow with, whose steps can be run manually
 * one at a time, not only automatically).
 *
 * Imperative plumbing in the shape of `execute.ts` / `compareExecute.ts`: reads
 * the store through `getState()`, applies results through actions, and is mocked
 * at the module boundary in tests.
 *
 * ## Run-all is a LOOP OVER run-one
 *
 * `executeSequenceStep` is the only place a step is ever sent; `executeSequence`
 * calls it in order. Two code paths for "run a request" would drift, and the one
 * that drifts is always the one with fewer tests — here that would be the manual
 * path, which is the one the user drives by hand.
 *
 * ## Two deliberate inversions of the A/B Compare rules
 *
 * `compareExecute.ts` fires both sends *before* attaching handlers so B never
 * waits on A, and resolves `{{VAR}}` **once** up front so "an environment edit
 * mid-flight can never make A and B see different secrets". A sequence must do
 * the opposite on both counts: steps are awaited in order, and variables are
 * re-resolved per step **because step N's variables include step N-1's
 * captures**. Same feature area, opposite rules — do not "make them consistent".
 *
 * ## Why a failed capture fails the step
 *
 * `substituteVars` resolves an unknown `{{VAR}}` to the empty string, silently
 * (`substitute.test.ts:21`). Left alone, a capture that found nothing would send
 * `Authorization: Bearer ` and the user would debug a 401 in their own API
 * instead of our silence. So a capture miss is a step failure carrying
 * `extractPath`'s reason, and the run stops or continues by the user's own
 * `stopOnFailure` setting — never by guessing.
 */

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

/**
 * Wait for `requestId` to stop sending, then hand back what landed.
 *
 * `executeHttpRequest` is fire-and-forget by design (it is wired to a button),
 * so the sequence observes its result through the store rather than by awaiting
 * it. Polling rather than subscribing keeps this module free of a subscription
 * lifecycle it would have to tear down on every step.
 */
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

/**
 * Run ONE step, using whatever the sequence has captured so far.
 *
 * Returns whether it passed, so `executeSequence` can honour `stopOnFailure`.
 * Safe to call on its own — that is manual stepping: a manually run
 * step sees the captures of steps run earlier, in separate invocations, because
 * the bag lives on the sequence rather than in this function.
 */
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
    // Reachable only through the poll timeout: a request still in flight after
    // STEP_TIMEOUT_MS. Say that, rather than "no response" — the difference is
    // whether the user should look at their server or at their patience.
    // Only the poll timeout can land here: the pre-send checks guarantee a url,
    // and a send always settles into either a response or an error (both clear
    // `sending`). So there is no second arm to write — a `did not run` branch
    // would be unreachable, which the coverage gate proved.
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

/**
 * Run every step in order.
 *
 * Resets first, so a run never inherits the previous run's captures. On a
 * failure with `stopOnFailure`, the remaining steps are marked **`skipped`**
 * rather than left `idle`: the user must be able to tell "we stopped before
 * this" from "this never ran at all".
 */
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
