/** Hover card over a capacity building; seat figures are flagged as an ESTIMATE. The panel places
 * it at the pointer (CSS px inside the stage); its words come from `capacityModel.capacityCard`. */

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
