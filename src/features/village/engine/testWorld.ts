/** Test-only World from ASCII, for edge cases `buildWorld` never produces (sealed rooms, …).
 *   . grass   = path   _ floor   # wall   ~ water   o plaza */

import type { House, Prop, Seat, TileKind, World } from "../villageTypes";

const KINDS: Record<string, TileKind> = { ".": "grass", "=": "path", _: "floor", "#": "wall", "~": "water", o: "plaza" };

export function asciiWorld(
  rows: string[],
  extra: { props?: Prop[]; seats?: Seat[]; houses?: House[]; plaza?: { col: number; row: number } } = {},
): World {
  const tiles: TileKind[] = [];
  for (const line of rows) for (const ch of line) tiles.push(KINDS[ch]);
  return {
    cols: rows[0].length,
    rows: rows.length,
    tiles,
    props: extra.props ?? [],
    seats: extra.seats ?? [],
    houses: extra.houses ?? [],
    plaza: extra.plaza ?? { col: 0, row: 0 },
  };
}
