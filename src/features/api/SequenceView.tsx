/** Accordion: one step open at a time, so it can embed <ApiRequestView/> verbatim without repeating
 * its env picker. Every row has its own run button, and a manual step still sees earlier captures
 * (SequenceState.captured). A failing row states its reason inline. */

import { useAppStore } from "../../app/store";
import type { SequenceStep } from "../../app/store";
import { ApiRequestView } from "./ApiRequestView";
import { executeSequence, executeSequenceStep } from "./sequenceExecute";
import "./api.css";
import "./sequence.css";

/** The glyph and class for a step's outcome. */
const OUTCOME: Record<SequenceStep["outcome"], { glyph: string; label: string }> = {
  idle: { glyph: "·", label: "not run" },
  running: { glyph: "◌", label: "running" },
  passed: { glyph: "✓", label: "passed" },
  failed: { glyph: "✗", label: "failed" },
  // Distinct from `idle` ON PURPOSE: "we stopped before reaching this" and
  // "this never ran" are different facts and the user has to be able to tell
  // them apart when reading a failed run.
  skipped: { glyph: "–", label: "skipped" },
};

export function SequenceView({ sequenceId }: { sequenceId: string }): React.JSX.Element | null {
  const seq = useAppStore((s) => s.sequences[sequenceId]);
  const requests = useAppStore((s) => s.apiRequests);
  const a = useAppStore((s) => s.sequenceActions);

  if (!seq) return null;

  const expandedStep = seq.steps.find((t) => t.id === seq.expandedStepId) ?? null;

  return (
    <div className="api-view seq" data-testid="sequence-view">
      <div className="seq__bar">
        <input
          className="api-input seq__name"
          data-testid="sequence-name"
          aria-label="Sequence name"
          value={seq.name}
          onChange={(e) => a.setSequenceName(sequenceId, e.target.value)}
        />
        <button
          type="button"
          className="api-send seq__run-all"
          data-testid="sequence-run-all"
          disabled={seq.running || seq.steps.length === 0}
          onClick={() => void executeSequence(sequenceId)}
        >
          {seq.running ? "Running…" : "▶ Run all"}
        </button>
        <button
          type="button"
          className="api-add-header"
          data-testid="sequence-add-step"
          onClick={() => a.addSequenceStep(sequenceId)}
        >
          + Add step
        </button>
        <label className="seq__stop" title="Stop at the first failing step, or run them all anyway">
          <input
            type="checkbox"
            data-testid="sequence-stop-on-failure"
            checked={seq.stopOnFailure}
            onChange={(e) => a.setStopOnFailure(sequenceId, e.target.checked)}
          />
          Stop on failure
        </label>
      </div>

      {seq.steps.length === 0 ? (
        <p className="api-section__empty" data-testid="sequence-empty">
          No steps yet. Add one, fill in the request, and capture a value from its response to use
          in the next step as <code>{"{{name}}"}</code>.
        </p>
      ) : (
        <ul className="seq__list" data-testid="sequence-steps">
          {seq.steps.map((step, i) => {
            const req = requests[step.requestId];
            const open = seq.expandedStepId === step.id;
            const out = OUTCOME[step.outcome];
            return (
              <li key={step.id} className={`seq__step is-${step.outcome}`} data-testid="sequence-step">
                <div className="seq__row">
                  <button
                    type="button"
                    className="seq__disclose"
                    data-testid="sequence-step-row"
                    aria-expanded={open}
                    aria-label={`${open ? "Collapse" : "Expand"} step ${i + 1}`}
                    onClick={() => a.expandSequenceStep(sequenceId, open ? null : step.id)}
                  >
                    <span className="seq__outcome" title={out.label} aria-label={out.label}>
                      {out.glyph}
                    </span>
                    <span className="seq__index">{i + 1}</span>
                    <span className="seq__method">{req?.method ?? "GET"}</span>
                    <span className="seq__url">{req?.url === "" ? "(no url)" : req?.url}</span>
                    <span className="seq__status">
                      {req?.response ? req.response.status : ""}
                    </span>
                    <span className="seq__dur">
                      {req?.response ? `${req.response.durationMs} ms` : ""}
                    </span>
                    <span className="seq__caret" aria-hidden="true">
                      {open ? "▾" : "▸"}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="api-add-header seq__run-one"
                    data-testid="sequence-run-step"
                    aria-label={`Run step ${i + 1}`}
                    title="Run just this step, using values captured earlier"
                    disabled={seq.running || step.outcome === "running"}
                    onClick={() => void executeSequenceStep(sequenceId, step.id)}
                  >
                    ▶
                  </button>
                  <button
                    type="button"
                    className="api-add-header seq__remove"
                    data-testid="sequence-remove-step"
                    aria-label={`Remove step ${i + 1}`}
                    onClick={() => a.removeSequenceStep(sequenceId, step.id)}
                  >
                    ✕
                  </button>
                </div>

                {step.failure !== null && (
                  <p className="seq__failure" role="alert" data-testid="sequence-step-failure">
                    {step.failure}
                  </p>
                )}

                {open && (
                  <div className="seq__detail" data-testid="sequence-step-detail">
                    <ApiRequestView requestId={step.requestId} />
                    <div className="seq__meta">
                      <label className="seq__expect">
                        Expect status
                        <input
                          className="api-input seq__expect-input"
                          data-testid="sequence-expect-status"
                          aria-label={`Expected status for step ${i + 1}`}
                          placeholder="any 2xx"
                          value={step.expectStatus === null ? "" : String(step.expectStatus)}
                          onChange={(e) => {
                            const raw = e.target.value.trim();
                            const n = Number(raw);
                            a.setStepExpectStatus(
                              sequenceId,
                              step.id,
                              raw !== "" && Number.isFinite(n) ? n : null,
                            );
                          }}
                        />
                      </label>

                      <div className="seq__captures">
                        <div className="seq__captures-head">
                          <span className="api-section__label">Capture</span>
                          <button
                            type="button"
                            className="api-add-header"
                            data-testid="sequence-add-capture"
                            onClick={() => a.addStepCapture(sequenceId, step.id)}
                          >
                            + Capture
                          </button>
                        </div>
                        {step.captures.length === 0 ? (
                          <div className="api-section__empty">
                            Nothing captured — later steps see no new variables from this one.
                          </div>
                        ) : (
                          step.captures.map((cap) => {
                            const got = step.capturedPreview[cap.name.trim()];
                            return (
                              <div className="seq__capture" key={cap.id}>
                                <input
                                  className="api-input"
                                  data-testid="sequence-capture-name"
                                  aria-label="Capture name"
                                  placeholder="name"
                                  value={cap.name}
                                  onChange={(e) =>
                                    a.setStepCapture(sequenceId, step.id, cap.id, {
                                      name: e.target.value,
                                    })
                                  }
                                />
                                <span className="seq__arrow" aria-hidden="true">
                                  ←
                                </span>
                                <input
                                  className="api-input"
                                  data-testid="sequence-capture-path"
                                  aria-label="Capture path"
                                  placeholder="data.jwt"
                                  value={cap.path}
                                  onChange={(e) =>
                                    a.setStepCapture(sequenceId, step.id, cap.id, {
                                      path: e.target.value,
                                    })
                                  }
                                />
                                <span className="seq__capture-value" data-testid="sequence-capture-value">
                                  {got === undefined ? "" : got}
                                </span>
                                <button
                                  type="button"
                                  className="api-add-header"
                                  data-testid="sequence-remove-capture"
                                  aria-label={`Remove capture ${cap.name || "unnamed"}`}
                                  onClick={() => a.removeStepCapture(sequenceId, step.id, cap.id)}
                                >
                                  ✕
                                </button>
                              </div>
                            );
                          })
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {expandedStep === null && Object.keys(seq.captured).length > 0 && (
        <p className="seq__bag" data-testid="sequence-captured">
          Captured: {Object.keys(seq.captured).join(", ")}
        </p>
      )}
    </div>
  );
}
