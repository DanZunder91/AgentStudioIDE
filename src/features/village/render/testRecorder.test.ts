import { describe, expect, it } from "vitest";

import { recorder } from "./testRecorder";

describe("recorder (the jsdom stand-in for a 2D context)", () => {
  it("records every op with the state it was issued under", () => {
    const ctx = recorder();
    ctx.fillStyle = "#123456";
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    ctx.arc(1, 2, 3, 0, Math.PI);
    ctx.fill();
    ctx.rect(0, 0, 4, 4);
    ctx.clip("evenodd");
    ctx.strokeRect(1, 1, 2, 2);
    ctx.clearRect(0, 0, 1, 1);
    expect(ctx.calls.map((c) => c.op)).toEqual([
      "beginPath",
      "arc",
      "fill",
      "rect",
      "clip",
      "strokeRect",
      "clearRect",
    ]);
    expect(ctx.of("arc")[0]).toMatchObject({
      args: [1, 2, 3, 0, Math.PI],
      fillStyle: "#123456",
      alpha: 0.5,
    });
    expect(ctx.of("clip")[0].args).toEqual(["evenodd"]);
    expect(ctx.measureText("abc").width).toBe(18);
  });
});
