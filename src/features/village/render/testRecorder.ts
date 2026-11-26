/** Test-only recording `DrawTarget` (jsdom has no canvas): each call with its context state.
 * Tests assert order, rects, colours and alpha; pixels are render.browser.test.tsx's job. */

import type { DrawTarget } from "./renderTypes";

export interface DrawCall {
  op:
    | "fillRect"
    | "clearRect"
    | "strokeRect"
    | "drawImage"
    | "fillText"
    | "save"
    | "restore"
    | "translate"
    | "scale"
    | "arc"
    | "fill"
    | "beginPath"
    | "rect"
    | "clip";
  args: unknown[];
  fillStyle: string;
  alpha: number;
  font: string;
  smoothing: boolean;
}

export interface RecordingTarget extends DrawTarget {
  calls: DrawCall[];
  /** The calls of one op, in order. */
  of(op: DrawCall["op"]): DrawCall[];
}

/** A fresh recorder. `measureText` reports 6 px per character. */
export function recorder(): RecordingTarget {
  const calls: DrawCall[] = [];
  const target: RecordingTarget = {
    fillStyle: "#000000",
    strokeStyle: "#000000",
    globalAlpha: 1,
    lineWidth: 1,
    imageSmoothingEnabled: true,
    font: "10px sans-serif",
    textAlign: "start",
    textBaseline: "alphabetic",
    calls,
    of: (op) => calls.filter((c) => c.op === op),
    fillRect: (...args) => record("fillRect", args),
    clearRect: (...args) => record("clearRect", args),
    strokeRect: (...args) => record("strokeRect", args),
    drawImage: (...args) => record("drawImage", args),
    fillText: (...args) => record("fillText", args),
    measureText: (text) => ({ width: text.length * 6 }),
    save: () => record("save", []),
    restore: () => record("restore", []),
    translate: (...args) => record("translate", args),
    scale: (...args) => record("scale", args),
    beginPath: () => record("beginPath", []),
    arc: (...args) => record("arc", args),
    fill: (...args) => record("fill", args),
    rect: (...args) => record("rect", args),
    clip: (...args) => record("clip", args),
  };
  function record(op: DrawCall["op"], args: unknown[]): void {
    calls.push({
      op,
      args,
      fillStyle: String(target.fillStyle),
      alpha: target.globalAlpha,
      font: target.font,
      smoothing: target.imageSmoothingEnabled,
    });
  }
  return target;
}
