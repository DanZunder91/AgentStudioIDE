/** BFS on the 4-connected grid; fixed neighbour order (up, down, left, right) so ties resolve the
 * same way. Characters never block each other; props and walls do. Typed arrays keep it cheap. */

import type { World } from "../villageTypes";
import { walkGrid } from "./world";

export interface Tile {
  col: number;
  row: number;
}

const DC = [0, 0, -1, 1];
const DR = [-1, 1, 0, 0];

/** Excludes the start, includes the end; `[]` when already there; `null` if `to` is out of bounds,
 * not walkable or unreachable. `blocked` keys are `"col,row"`; `allow` exempts one tile from prop
 * blocking (a character's own chair). The start tile is never checked. */
export function findPath(
  world: World,
  from: Tile,
  to: Tile,
  blocked?: Set<string>,
  allow?: Tile | null,
): Tile[] | null {
  const { cols, rows } = world;
  const inside = (c: number, r: number) => c >= 0 && r >= 0 && c < cols && r < rows;
  if (!inside(from.col, from.row) || !inside(to.col, to.row)) return null;
  if (from.col === to.col && from.row === to.row) return [];
  const grid = walkGrid(world);
  const allowIdx = allow ? allow.row * cols + allow.col : -1;
  const passable = (c: number, r: number) => {
    const i = r * cols + c;
    return (grid[i] === 1 || i === allowIdx) && !blocked?.has(`${c},${r}`);
  };
  if (!passable(to.col, to.row)) return null;

  const start = from.row * cols + from.col;
  const goal = to.row * cols + to.col;
  const prev = new Int32Array(cols * rows).fill(-1);
  const queue = new Int32Array(cols * rows);
  prev[start] = start;
  queue[0] = start;
  let head = 0;
  let tail = 1;
  while (head < tail) {
    const cur = queue[head++];
    if (cur === goal) break;
    const c = cur % cols;
    const r = (cur - c) / cols;
    for (let d = 0; d < 4; d++) {
      const nc = c + DC[d];
      const nr = r + DR[d];
      if (!inside(nc, nr)) continue;
      const ni = nr * cols + nc;
      if (prev[ni] !== -1 || !passable(nc, nr)) continue;
      prev[ni] = cur;
      queue[tail++] = ni;
    }
  }
  if (prev[goal] === -1) return null;
  const path: Tile[] = [];
  for (let i = goal; i !== start; i = prev[i]) path.push({ col: i % cols, row: Math.floor(i / cols) });
  return path.reverse();
}
