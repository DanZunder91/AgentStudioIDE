/**
 * AgentLogsButton — the titlebar affordance that opens the fleet-wide log stream.
 * Mirrors `<MetricsButton/>`:
 * one store action, the destination is a singleton TAB.
 */

import { useAppStore } from "../../app/store";
import { LogStreamIcon } from "../../components/icons";

export function AgentLogsButton(): React.JSX.Element {
  const openAgentLogsTab = useAppStore((s) => s.layoutActions.openAgentLogsTab);
  return (
    <button
      type="button"
      className="titlebar__icon-btn"
      data-testid="titlebar-agent-logs"
      aria-label="Agent logs"
      title="Agent logs — everything your terminals and agents print and run, in one stream"
      onClick={() => openAgentLogsTab()}
    >
      <LogStreamIcon size={15} />
    </button>
  );
}
