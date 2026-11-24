/**
 * NetworkButton — the titlebar affordance that opens the capture-proxy flow table.
 * Mirrors `<MetricsButton/>`:
 * one store action, the destination is a singleton TAB.
 */

import { useEffect } from "react";

import { useAppStore } from "../../app/store";
import { NetworkIcon } from "../../components/icons";
import { watchTerminalTitles } from "./terminalTitles";

export function NetworkButton(): React.JSX.Element {
  const openNetworkTab = useAppStore((s) => s.layoutActions.openNetworkTab);
  // Mounted in the titlebar for the app's whole life: the one place that sees every terminal
  // while it is still open, so a closed one's flows keep its title (`gazelle (closed)`).
  useEffect(() => watchTerminalTitles(), []);
  return (
    <button
      type="button"
      className="titlebar__icon-btn"
      data-testid="titlebar-network"
      aria-label="Network traffic"
      title="Network traffic — every HTTP, WebSocket and gRPC call your agents make, or every app's connections on this computer"
      onClick={() => openNetworkTab()}
    >
      <NetworkIcon size={15} />
    </button>
  );
}
