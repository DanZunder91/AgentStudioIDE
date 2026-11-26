/** Hover card at the pointer (CSS px inside the stage). Never shows prompt text: `title` is
 * already privacy-safe. A city console (`consoleId`) is a terminal, not an agent. */

import type { VillageAgent } from "./villageTypes";
import { activityText, agoText, consoleActivityText } from "./villageView";

export interface VillageInfoCardProps {
  agent: VillageAgent;
  x: number;
  y: number;
  /** Epoch ms the relative time is measured from (captured when the hover began). */
  now: number;
  /** Its context-window line (`capacityModel.contextLine`), or null/absent without a reading — then nothing is said. */
  context?: string | null;
}

/** The origin line: where this character runs, and what a click does when it can do anything. */
function originText(agent: VillageAgent): string {
  if (agent.consoleId) return "Console in the IDE";
  if (agent.origin === "ide") return "In the IDE";
  return agent.host ? `Running in ${agent.host} — click to switch` : "Outside the IDE";
}

export function VillageInfoCard({ agent, x, y, now, context = null }: VillageInfoCardProps): React.JSX.Element {
  const clickable = agent.origin === "ide" && (agent.ideAgentId !== null || Boolean(agent.consoleId));
  return (
    <div className="village-card" role="tooltip" data-testid="village-card" style={{ left: x + 14, top: y + 14 }}>
      <div className="village-card__title">{agent.title}</div>
      <div className="village-card__row">
        <span className="village-card__dim">Folder</span> {agent.folder}
      </div>
      <div className={`village-card__origin village-card__origin--${agent.origin}`}>{originText(agent)}</div>
      <div className="village-card__row">
        {agent.consoleId ? consoleActivityText(agent.activity) : activityText(agent.activity, agent.tool)}
      </div>
      {context !== null && (
        <div className="village-card__row" data-testid="village-card-context">
          {context}
        </div>
      )}
      {agent.lastActivityAt !== null && (
        <div className="village-card__dim">Last active {agoText(agent.lastActivityAt, now)}</div>
      )}
      {clickable && <div className="village-card__hint">Click to open</div>}
    </div>
  );
}
