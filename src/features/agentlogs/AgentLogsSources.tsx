/** Logs **Sources** popover (keeps the toolbar one row): IDE terminals & agents (client-side),
 * Mac/System apps (`syslog_set`; per-backend wording in `syslogTexts`), and the iOS Simulator
 * only when Rust saw one booted (never probed). An unavailable backend shows its `reason`. */

import { useEffect, useMemo, useRef, useState } from "react";

import { AppPicker } from "../../components/AppPicker";
import { appPickerItems, appsLabel, formatNameList, parseNameList, syslogTexts } from "./agentLogsFormat";
import { useAgentLogsStore } from "./agentLogsStore";
import { LOG_CAP, type SyslogFilter, type SyslogLevel, type SyslogStatus } from "./agentLogsTypes";

const MIN_LEVELS: { level: SyslogLevel; label: string }[] = [
  { level: "debug", label: "Debug" },
  { level: "info", label: "Info" },
  { level: "default", label: "Default" },
  { level: "error", label: "Error" },
];

/** Applies on Enter or blur, never per keystroke (each apply restarts `log stream`). Keyed on
 * the active value, so a new value from Rust resets the draft. */
function CommitBox({
  label,
  value,
  placeholder,
  onCommit,
}: {
  label: string;
  value: string;
  placeholder: string;
  onCommit(text: string): void;
}): React.JSX.Element {
  const [draft, setDraft] = useState(value);
  const commit = () => {
    if (draft.trim() !== value) onCommit(draft);
  };
  return (
    <input
      type="text"
      className="alog-srcs__text"
      aria-label={label}
      placeholder={placeholder}
      value={draft}
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
      }}
    />
  );
}

interface SectionProps {
  status: SyslogStatus;
  /** What the controls show: the filter in flight, else the active one. */
  filter: SyslogFilter;
  machine: string;
}

/** The system-apps controls, shown while the source is on. */
function SystemAppsControls({ status, filter }: Omit<SectionProps, "machine">): React.JSX.Element {
  const apps = useAgentLogsStore((s) => s.apps);
  const appsLoading = useAgentLogsStore((s) => s.appsLoading);
  const appsError = useAgentLogsStore((s) => s.appsError);
  const actions = useAgentLogsStore.getState();
  const texts = syslogTexts(status.backend);
  const items = useMemo(() => appPickerItems(apps), [apps]);
  return (
    <div className="alog-srcs__controls">
      <div className="alog-srcs__line">
        <AppPicker
          items={items}
          selected={filter.apps}
          onChange={(next) => void actions.setSyslogFilter({ apps: next })}
          noun={texts.noun}
          label={texts.picker}
          onOpen={() => void actions.refreshApps()}
        />
        <button
          type="button"
          className="alog-chip"
          aria-label={texts.refreshLabel}
          title={texts.refreshTitle}
          disabled={appsLoading}
          onClick={() => void actions.refreshApps()}
        >
          ↻
        </button>
      </div>
      {appsError !== null && (
        <p className="alog-srcs__error" role="alert">
          {appsError}
        </p>
      )}
      <label className="alog-srcs__line">
        <span>Minimum level</span>
        <select
          className="alog-srcs__select"
          value={filter.minLevel}
          onChange={(e) => void actions.setSyslogFilter({ minLevel: e.target.value as SyslogLevel })}
        >
          {MIN_LEVELS.map(({ level, label }) => (
            <option key={level} value={level}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <CommitBox
        key={filter.subsystem ?? ""}
        label={texts.subsystemLabel}
        placeholder={texts.subsystemPlaceholder}
        value={filter.subsystem ?? ""}
        onCommit={(text) => void actions.setSyslogFilter({ subsystem: text.trim() === "" ? null : text.trim() })}
      />
      <p className="alog-srcs__stats" aria-live="polite">
        {status.running ? `${Math.round(status.linesPerSec)} lines/s` : "Not running"}
        {status.droppedPerSec > 0 && (
          <span className="alog-srcs__dropped">
            {" "}
            ⚠ dropping {Math.round(status.droppedPerSec)} lines/s — over the 500/s cap; pick apps or
            raise the level
          </span>
        )}
      </p>
    </div>
  );
}

/** Mac apps / System apps: the reason when unavailable, else the toggle and its controls. */
function SystemAppsSection({ status, filter, machine }: SectionProps): React.JSX.Element {
  const pending = useAgentLogsStore((s) => s.syslogPending);
  const volumeNotice = useAgentLogsStore((s) => s.volumeNotice);
  const actions = useAgentLogsStore.getState();
  if (!status.available) {
    return (
      <p className="alog-srcs__reason" data-testid="syslog-unavailable">
        <b>{machine}</b> — {status.reason ?? "not available on this system"}
      </p>
    );
  }
  const setEnabled = (on: boolean) => {
    if (on) void actions.refreshApps();
    void actions.setSyslogFilter({ enabled: on });
  };
  return (
    <>
      <div className="alog-srcs__row">
        <label className="alog-srcs__row">
          <input type="checkbox" checked={filter.enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <span>{machine}</span>
        </label>
        {pending !== null && <span className="alog-srcs__note">applying…</span>}
      </div>
      {status.reason !== null && (
        <p className="alog-srcs__note" data-testid="syslog-partial">
          {status.reason}
        </p>
      )}
      {filter.enabled && <SystemAppsControls status={status} filter={filter} />}
      {volumeNotice && syslogTexts(status.backend).highVolume && (
        <div className="alog-srcs__notice" role="status">
          <span>
            All apps is high volume — about 150–500 lines/s. The view keeps the newest{" "}
            {LOG_CAP.toLocaleString("en-US")} lines; pick apps or raise the level to see further back.
          </span>
          <button type="button" className="alog-chip" onClick={actions.dismissVolumeNotice}>
            Got it
          </button>
        </div>
      )}
    </>
  );
}

/** iOS Simulator — rendered only when Rust saw a booted simulator. */
function SimulatorSection({ status, filter }: Omit<SectionProps, "machine">): React.JSX.Element {
  const actions = useAgentLogsStore.getState();
  const names = formatNameList(filter.simulatorApps);
  return (
    <div className="alog-srcs__section" role="group" aria-label="iOS Simulator">
      <div className="alog-srcs__row">
        <label className="alog-srcs__row">
          <input
            type="checkbox"
            checked={filter.simulator}
            onChange={(e) => void actions.setSyslogFilter({ simulator: e.target.checked })}
          />
          <span>iOS Simulator</span>
        </label>
        {status.simulator.running && <span className="alog-srcs__note">streaming</span>}
      </div>
      {status.simulator.reason !== null && <p className="alog-srcs__note">{status.simulator.reason}</p>}
      {filter.simulator && (
        <CommitBox
          key={names}
          label="Simulator apps"
          placeholder="All simulator apps — or names, comma-separated"
          value={names}
          onCommit={(text) => void actions.setSyslogFilter({ simulatorApps: parseNameList(text) })}
        />
      )}
    </div>
  );
}

export function AgentLogsSources(): React.JSX.Element {
  const ide = useAgentLogsStore((s) => s.filter.ide);
  const syslog = useAgentLogsStore((s) => s.syslog);
  const pending = useAgentLogsStore((s) => s.syslogPending);
  const syslogError = useAgentLogsStore((s) => s.syslogError);
  const applyError = useAgentLogsStore((s) => s.applyError);
  const actions = useAgentLogsStore.getState();

  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onDown = (e: MouseEvent) => {
      // The ref is attached whenever the popover is open.
      if (!(root.current as HTMLDivElement).contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  const machine = appsLabel(syslog?.backend);
  const filter = syslog === null ? null : (pending ?? syslog.filter);
  const streaming = syslog !== null && syslog.available && (filter as SyslogFilter).enabled;
  const problem = syslogError ?? applyError;

  const toggleOpen = () => {
    // The app list is a snapshot of running processes: re-read it every time the control
    // opens with the source on, so an app launched since is pickable.
    if (!open && streaming) void actions.refreshApps();
    setOpen(!open);
  };

  return (
    <div className="alog-srcs" ref={root}>
      <button
        type="button"
        className="alog-chip"
        aria-label="Log sources"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={
          problem ??
          (streaming ? `${machine} are streaming` : "Choose what this view streams: IDE terminals, other apps, the iOS Simulator")
        }
        onClick={toggleOpen}
      >
        Sources
        {streaming && syslog.running && (
          <span className="alog-srcs__rate">
            {" "}
            · {Math.round(syslog.linesPerSec)}/s
          </span>
        )}
        {problem !== null && <span className="alog-srcs__warn"> ⚠</span>} ▾
      </button>

      {open && (
        <div className="alog-srcs__pop" role="dialog" aria-label="Log sources">
          <label className="alog-srcs__row">
            <input type="checkbox" checked={ide} onChange={() => actions.setIde(!ide)} />
            <span>IDE terminals &amp; agents</span>
          </label>

          <div className="alog-srcs__section" role="group" aria-label={machine}>
            {syslog === null ? (
              syslogError === null && <p className="alog-srcs__note">Checking {machine.toLowerCase()} logs…</p>
            ) : (
              <SystemAppsSection status={syslog} filter={filter as SyslogFilter} machine={machine} />
            )}
          </div>

          {syslog !== null && syslog.simulator.available && (
            <SimulatorSection status={syslog} filter={filter as SyslogFilter} />
          )}

          {syslogError !== null && (
            <p className="alog-srcs__error" role="alert">
              {syslogError}
            </p>
          )}
          {applyError !== null && (
            <p className="alog-srcs__error" role="alert">
              {applyError}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
