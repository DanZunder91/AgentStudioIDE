/**
 * `<SequenceView/>` — the accordion layout.
 *
 * The runner is mocked at the module boundary: this file is about what the user
 * sees and clicks, and `sequenceExecute.test.ts` already drives the real send
 * path. `ApiRequestView` is mocked too — it is a 600-line component with its own
 * suite, and rendering it here would test it a second time rather than testing
 * the accordion.
 */

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiStoreIpc = vi.hoisted(() => ({ loadApiStore: vi.fn(), saveApiStore: vi.fn() }));
vi.mock("./apiStoreIpc", () => apiStoreIpc);
const historyIpc = vi.hoisted(() => ({ loadApiHistory: vi.fn(), saveApiHistory: vi.fn() }));
vi.mock("./historyIpc", () => historyIpc);
const runner = vi.hoisted(() => ({
  executeSequence: vi.fn(),
  executeSequenceStep: vi.fn(),
}));
vi.mock("./sequenceExecute", () => runner);
vi.mock("./ApiRequestView", () => ({
  ApiRequestView: ({ requestId }: { requestId: string }) => (
    <div data-testid="request-view">{requestId}</div>
  ),
}));

import { useAppStore } from "../../app/store";
import { resetStore } from "../../test/store-harness";
import { SequenceView } from "./SequenceView";

const state = () => useAppStore.getState();
const a = () => state().sequenceActions;

/** A sequence with `n` steps, each pointed at a distinct url. */
function seed(n: number): { id: string; stepIds: string[] } {
  const id = a().createSequence();
  const stepIds: string[] = [];
  for (let i = 0; i < n; i++) {
    const stepId = a().addSequenceStep(id);
    stepIds.push(stepId);
    const step = state().sequences[id].steps.find((t) => t.id === stepId)!;
    state().apiActions.patchApiRequest(step.requestId, {
      url: `https://api.test/step${i + 1}`,
      method: "POST",
    });
  }
  a().expandSequenceStep(id, null); // start collapsed, like a reopened tab
  return { id, stepIds };
}

const rows = () => screen.queryAllByTestId("sequence-step");

describe("SequenceView", () => {
  beforeEach(() => {
    resetStore();
    apiStoreIpc.saveApiStore.mockResolvedValue(undefined);
    runner.executeSequence.mockReset();
    runner.executeSequenceStep.mockReset();
  });

  it("renders nothing for an unknown sequence", () => {
    const { container } = render(<SequenceView sequenceId="nope" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("tells an empty sequence what to do", () => {
    const id = a().createSequence();
    render(<SequenceView sequenceId={id} />);
    expect(screen.getByTestId("sequence-empty")).toBeInTheDocument();
    expect(rows()).toHaveLength(0);
  });

  it("lists the steps in order, with method and url on the collapsed row", () => {
    const { id } = seed(3);
    render(<SequenceView sequenceId={id} />);
    const listed = rows();
    expect(listed).toHaveLength(3);
    expect(listed[0]).toHaveTextContent("https://api.test/step1");
    expect(listed[2]).toHaveTextContent("https://api.test/step3");
    expect(listed[0]).toHaveTextContent("POST");
  });

  it("expands exactly ONE step, collapsing the previous — it is an accordion", async () => {
    const user = userEvent.setup();
    const { id } = seed(2);
    render(<SequenceView sequenceId={id} />);
    expect(screen.queryAllByTestId("sequence-step-detail")).toHaveLength(0);

    await user.click(screen.getAllByTestId("sequence-step-row")[0]);
    expect(screen.getAllByTestId("sequence-step-detail")).toHaveLength(1);
    expect(state().sequences[id].expandedStepId).toBe(state().sequences[id].steps[0].id);

    await user.click(screen.getAllByTestId("sequence-step-row")[1]);
    // Still exactly one — the first closed as the second opened.
    expect(screen.getAllByTestId("sequence-step-detail")).toHaveLength(1);
    expect(state().sequences[id].expandedStepId).toBe(state().sequences[id].steps[1].id);
  });

  it("collapses again when the open row is clicked", async () => {
    const user = userEvent.setup();
    const { id } = seed(1);
    render(<SequenceView sequenceId={id} />);
    await user.click(screen.getByTestId("sequence-step-row"));
    await user.click(screen.getByTestId("sequence-step-row"));
    expect(screen.queryAllByTestId("sequence-step-detail")).toHaveLength(0);
    expect(state().sequences[id].expandedStepId).toBeNull();
  });

  it("shows the request editor for the EXPANDED step only", async () => {
    const user = userEvent.setup();
    const { id } = seed(2);
    render(<SequenceView sequenceId={id} />);
    await user.click(screen.getAllByTestId("sequence-step-row")[1]);
    const shown = screen.getAllByTestId("request-view");
    expect(shown).toHaveLength(1);
    // …and it is the SECOND step's request, not just any.
    expect(shown[0]).toHaveTextContent(state().sequences[id].steps[1].requestId);
  });

  it("Run all calls the runner; the per-step ▶ runs just that step", async () => {
    const user = userEvent.setup();
    const { id, stepIds } = seed(2);
    render(<SequenceView sequenceId={id} />);

    await user.click(screen.getByTestId("sequence-run-all"));
    expect(runner.executeSequence).toHaveBeenCalledWith(id);

    // Manual stepping: the second row's button runs the second step.
    await user.click(screen.getAllByTestId("sequence-run-step")[1]);
    expect(runner.executeSequenceStep).toHaveBeenCalledWith(id, stepIds[1]);
  });

  it("disables Run all while running and with no steps", () => {
    const empty = a().createSequence();
    const { rerender } = render(<SequenceView sequenceId={empty} />);
    expect(screen.getByTestId("sequence-run-all")).toBeDisabled();

    const { id } = seed(1);
    rerender(<SequenceView sequenceId={id} />);
    expect(screen.getByTestId("sequence-run-all")).toBeEnabled(); // two-sided

    a().setSequenceRunning(id, true);
    rerender(<SequenceView sequenceId={id} />);
    expect(screen.getByTestId("sequence-run-all")).toBeDisabled();
  });

  it("shows a failure's REASON on the row, not just a red mark", () => {
    const { id, stepIds } = seed(2);
    a().setStepOutcome(id, stepIds[0], "failed", 'Capture "jwt" — "data" has no "jwt"', {});
    render(<SequenceView sequenceId={id} />);
    const failure = screen.getByTestId("sequence-step-failure");
    // Both halves matter: which capture, and where the walk stopped.
    expect(failure).toHaveTextContent("jwt");
    expect(failure).toHaveTextContent("data");
  });

  it("distinguishes SKIPPED from never-run", () => {
    const { id, stepIds } = seed(3);
    a().setStepOutcome(id, stepIds[0], "failed", "boom", {});
    a().setStepOutcome(id, stepIds[1], "skipped", null, {});
    render(<SequenceView sequenceId={id} />);
    const listed = rows();
    // "we stopped before this" and "this never ran" are different facts.
    expect(listed[1].className).toContain("is-skipped");
    expect(listed[2].className).toContain("is-idle");
    expect(listed[1].className).not.toBe(listed[2].className);
  });

  it("toggles stop-on-failure — BOTH behaviours are required", async () => {
    const user = userEvent.setup();
    const { id } = seed(1);
    render(<SequenceView sequenceId={id} />);
    const toggle = screen.getByTestId("sequence-stop-on-failure");
    expect(toggle).toBeChecked(); // default on
    await user.click(toggle);
    expect(state().sequences[id].stopOnFailure).toBe(false);
  });

  it("renames the sequence", async () => {
    const user = userEvent.setup();
    const { id } = seed(1);
    render(<SequenceView sequenceId={id} />);
    const name = screen.getByTestId("sequence-name");
    await user.clear(name);
    await user.type(name, "Auth");
    expect(state().sequences[id].name).toBe("Auth");
  });

  it("adds and removes steps from the bar and the row", async () => {
    const user = userEvent.setup();
    const { id } = seed(1);
    render(<SequenceView sequenceId={id} />);
    await user.click(screen.getByTestId("sequence-add-step"));
    expect(state().sequences[id].steps).toHaveLength(2);
    await user.click(screen.getAllByTestId("sequence-remove-step")[0]);
    expect(state().sequences[id].steps).toHaveLength(1);
  });

  it("edits captures, and shows what a step actually captured", async () => {
    const user = userEvent.setup();
    const { id, stepIds } = seed(1);
    a().expandSequenceStep(id, stepIds[0]);
    render(<SequenceView sequenceId={id} />);

    await user.click(screen.getByTestId("sequence-add-capture"));
    await user.type(screen.getByTestId("sequence-capture-name"), "jwt");
    await user.type(screen.getByTestId("sequence-capture-path"), "data.jwt");
    expect(state().sequences[id].steps[0].captures[0]).toMatchObject({
      name: "jwt",
      path: "data.jwt",
    });

    a().setStepOutcome(id, stepIds[0], "passed", null, { jwt: "TOKEN-9" });
    expect(await screen.findByTestId("sequence-capture-value")).toHaveTextContent("TOKEN-9");

    await user.click(screen.getByTestId("sequence-remove-capture"));
    expect(state().sequences[id].steps[0].captures).toHaveLength(0);
  });

  it("reads expect-status as a number, and blank as any 2xx", async () => {
    const user = userEvent.setup();
    const { id, stepIds } = seed(1);
    a().expandSequenceStep(id, stepIds[0]);
    render(<SequenceView sequenceId={id} />);
    const input = screen.getByTestId("sequence-expect-status");

    await user.type(input, "201");
    expect(state().sequences[id].steps[0].expectStatus).toBe(201);

    await user.clear(input);
    expect(state().sequences[id].steps[0].expectStatus).toBeNull();

    // Not a number → "any 2xx" rather than NaN.
    await user.type(input, "abc");
    expect(state().sequences[id].steps[0].expectStatus).toBeNull();
  });

  it("names the captured variables once a run has produced some", () => {
    const { id } = seed(1);
    a().mergeSequenceCaptured(id, { jwt: "x", userId: "7" });
    render(<SequenceView sequenceId={id} />);
    const bag = screen.getByTestId("sequence-captured");
    expect(bag).toHaveTextContent("jwt");
    expect(bag).toHaveTextContent("userId");
  });

  it("shows a step's status and duration once it has a response", () => {
    const { id } = seed(1);
    const step = state().sequences[id].steps[0];
    state().apiActions.setApiResponse(step.requestId, {
      status: 201,
      statusText: "Created",
      headers: [],
      body: "{}",
      durationMs: 88,
      sizeBytes: 2,
      truncated: false,
    });
    render(<SequenceView sequenceId={id} />);
    const row = within(rows()[0]);
    expect(row.getByText("201")).toBeInTheDocument();
    expect(row.getByText("88 ms")).toBeInTheDocument();
  });

  it("still renders a row whose request has been disposed", () => {
    // Reachable whenever a step outlives its request; the row must degrade to
    // sensible defaults rather than blanking or throwing.
    const { id } = seed(1);
    const requestId = state().sequences[id].steps[0].requestId;
    useAppStore.setState((s) => {
      const next = { ...s.apiRequests };
      delete next[requestId];
      return { apiRequests: next };
    });
    render(<SequenceView sequenceId={id} />);
    expect(rows()[0]).toHaveTextContent("GET");
    expect(screen.queryByText("88 ms")).not.toBeInTheDocument();
  });

  it("says (no url) rather than rendering an empty gap", () => {
    const id = a().createSequence();
    a().addSequenceStep(id);
    render(<SequenceView sequenceId={id} />);
    expect(rows()[0]).toHaveTextContent("(no url)");
  });
});
