/**
 * The hover card over a capacity building: its exact numbers, where they come from,
 * and — for the seats — that the figure is an ESTIMATE. Positioned by the panel at the pointer
 * (CSS px inside the stage), like the agents' card. The words are `capacityModel.capacityCard`'s.
 */

import type { CapacityCard } from "./capacityModel";

export interface CapacityInfoCardProps {
  card: CapacityCard;
  x: number;
  y: number;
}

export function CapacityInfoCard({ card, x, y }: CapacityInfoCardProps): React.JSX.Element {
  return (
    <div
      className="village-card village-card--capacity"
      role="tooltip"
      data-testid="village-capacity-card"
      data-kind={card.kind}
      style={{ left: x + 14, top: y + 14 }}
    >
      <div className="village-card__title">
        {card.title}
        {card.estimate && <span className="village-card__estimate">estimate</span>}
      </div>
      {card.rows.map((row) => (
        <div key={row} className="village-card__row">
          {row}
        </div>
      ))}
      <div className="village-card__dim village-card__source">{card.source}</div>
    </div>
  );
}
