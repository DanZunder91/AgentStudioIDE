/**
 * ClaudeMcpItem — "Add Agent Studio to Claude Code", in the Settings menu.
 *
 * One click adds Agent Studio's MCP server to Claude Code, so every Claude Code session in an
 * Agent Studio terminal can use the app's database and API tools; when it is added, the same item
 * removes it. The work is Claude Code's own `claude mcp add|remove` (`claudeMcpIpc.ts`).
 *
 * Mounted only while the popover is open, so Claude Code is asked for the status when the user
 * opens the menu and never at startup: a vendor CLI runs on the user's action, not on its own.
 * Clicking does not close the popover, because the answer is shown right here, in the item's own
 * description line; nothing else opens.
 */
import { useEffect, useRef, useState } from "react";

import {
  claudeMcpInstall,
  claudeMcpStatus,
  claudeMcpUninstall,
  type ClaudeMcpReport,
} from "./claudeMcpIpc";

type Action = "install" | "uninstall";

type View =
  | { phase: "checking" }
  | { phase: "working"; action: Action }
  | { phase: "ready"; report: ClaudeMcpReport };

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
  const r = view.report;
  // A problem: say it, and offer the add again unless there is no Claude Code to run.
  if (!r.ok) {
    return { label: ADD, hint: r.message, action: r.state === "claudeMissing" ? null : "install", problem: true };
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
  const [view, setView] = useState<View>({ phase: "checking" });
  // An answer that arrives after the popover closed has no item to land in.
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    void claudeMcpStatus().then((report) => {
      if (live.current) setView({ phase: "ready", report });
    });
    return () => {
      live.current = false;
    };
  }, []);

  const shown = show(view);
  const action = shown.action;
  const run = (act: Action) => {
    setView({ phase: "working", action: act });
    void (act === "install" ? claudeMcpInstall() : claudeMcpUninstall()).then((report) => {
      if (live.current) setView({ phase: "ready", report });
    });
  };

  return (
    <button
      type="button"
      role="menuitem"
      className="settings-menu__item"
      data-testid="settings-claude-mcp"
      data-state={view.phase === "ready" ? view.report.state : view.phase}
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
