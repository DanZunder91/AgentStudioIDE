/** Adds or removes Agent Studio's MCP server in Claude Code (`claudeMcpIpc.ts`). Mounted only while
 * the popover is open, so the vendor CLI runs on the user's action, never at startup; runs outlive
 * the popover (`claudeMcpRuns.ts`). Clicks keep the popover open: the answer shows in the item. */
import { useEffect, useRef, useState } from "react";

import {
  currentRun,
  recentAnswer,
  startRun,
  type ClaudeMcpAction as Action,
  type ClaudeMcpAnswer,
} from "./claudeMcpRuns";

type View =
  | { phase: "checking" }
  | { phase: "working"; action: Action }
  | { phase: "ready"; answer: ClaudeMcpAnswer };

/** What the item shows when the popover opens: the run still going, or a recent answer. */
function opening(): View {
  const run = currentRun();
  if (run !== null) return run.action === null ? { phase: "checking" } : { phase: "working", action: run.action };
  const known = recentAnswer();
  return known === null ? { phase: "checking" } : { phase: "ready", answer: known };
}

const ADD = "Add Agent Studio to Claude Code";
const REMOVE = "Remove Agent Studio from Claude Code";

interface Shown {
  label: string;
  hint: string;
  /** What a click does; `null` when there is nothing it can do. */
  action: Action | null;
  /** The hint is a problem the user should read (styled, and announced). */
  problem: boolean;
}

function show(view: View): Shown {
  if (view.phase === "checking") {
    return { label: ADD, hint: "Checking Claude Code…", action: null, problem: false };
  }
  if (view.phase === "working") {
    return view.action === "install"
      ? { label: "Adding Agent Studio to Claude Code…", hint: "Running claude mcp add…", action: null, problem: false }
      : { label: "Removing Agent Studio from Claude Code…", hint: "Running claude mcp remove…", action: null, problem: false };
  }
  const r = view.answer.report;
  // A problem: say it, and offer the same again (a failed removal is still a removal to retry),
  // unless there is no Claude Code to run.
  if (!r.ok) {
    const retry: Action = view.answer.after === "uninstall" ? "uninstall" : "install";
    return {
      label: retry === "uninstall" ? REMOVE : ADD,
      hint: r.message,
      action: r.state === "claudeMissing" ? null : retry,
      problem: true,
    };
  }
  switch (r.state) {
    case "installed":
      return {
        label: REMOVE,
        hint: "Added: Claude Code sessions in Agent Studio's terminals can use its database and API tools.",
        action: "uninstall",
        problem: false,
      };
    case "different":
      return {
        label: "Point Claude Code at this Agent Studio",
        hint: `Claude Code's agent-studio server runs another copy: ${r.configured ?? "unknown"}`,
        action: "install",
        problem: false,
      };
    // An entry in Claude Code's local or project config wins over the user config: say which,
    // and how to remove it. Adding again re-checks.
    case "shadowed":
      return { label: ADD, hint: r.message, action: "install", problem: true };
    default:
      return {
        label: ADD,
        hint: "Lets Claude Code sessions use Agent Studio's database and API tools (runs claude mcp add).",
        action: "install",
        problem: false,
      };
  }
}

export function ClaudeMcpItem(): React.JSX.Element {
  const [initial] = useState(opening);
  const [view, setView] = useState<View>(initial);
  // An answer that arrives after the popover closed has no item to land in (claudeMcpRuns keeps
  // it for the next open).
  const live = useRef(true);
  const land = (answer: ClaudeMcpAnswer) => {
    if (live.current) setView({ phase: "ready", answer });
  };

  useEffect(() => {
    live.current = true;
    // Ask Claude Code, or wait for the run already going; a recent answer needs neither.
    if (initial.phase !== "ready") void startRun(null).then(land);
    return () => {
      live.current = false;
    };
  }, [initial]);

  const shown = show(view);
  const action = shown.action;
  const run = (act: Action) => {
    setView({ phase: "working", action: act });
    void startRun(act).then(land);
  };

  return (
    <button
      type="button"
      role="menuitem"
      className="settings-menu__item"
      data-testid="settings-claude-mcp"
      data-state={view.phase === "ready" ? view.answer.report.state : view.phase}
      disabled={action === null}
      aria-busy={view.phase !== "ready"}
      onClick={action === null ? undefined : () => run(action)}
    >
      <span className="settings-menu__label-text">{shown.label}</span>
      <span
        className={`settings-menu__hint settings-menu__hint--wrap${shown.problem ? " settings-menu__hint--problem" : ""}`}
        data-testid="settings-claude-mcp-hint"
        aria-live="polite"
      >
        {shown.hint}
      </span>
    </button>
  );
}
