/** Iterating SPRITE_ICON_IDS pins routing (the sprite reaches the DOM addressable); its content is
 * pinned by the generator's drift test (scripts/icons/generate.test.mjs). */

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { IconSprite } from "./IconSprite";
import { SPRITE_ICON_IDS } from "./sprite.generated";

afterEach(() => {
  cleanup();
});

const containers = (root: HTMLElement) =>
  root.querySelectorAll('[data-testid="file-icon-sprite"]');

describe("IconSprite", () => {
  it("injects the sprite once, with every generated symbol addressable by #mi-<id>", () => {
    const { container } = render(<IconSprite />);

    expect(containers(container)).toHaveLength(1);
    expect(SPRITE_ICON_IDS.length).toBeGreaterThan(0); // guard: an empty loop below would assert nothing
    for (const id of SPRITE_ICON_IDS) {
      expect(container.querySelector(`symbol[id="mi-${id}"]`)).not.toBeNull();
    }
  });

  it("is visually hidden without display:none (a display:none subtree can blank <use> targets)", () => {
    const { container } = render(<IconSprite />);
    const box = containers(container)[0] as HTMLElement;

    expect(box.style.position).toBe("absolute");
    expect(box.style.width).toBe("0px");
    expect(box.style.height).toBe("0px");
    expect(box.style.overflow).toBe("hidden");
    expect(box.style.display).not.toBe("none");
    expect(box.getAttribute("aria-hidden")).toBe("true");
  });

  it("React 19 innerHTML regression: a re-render with a fresh element neither wipes nor duplicates the sprite", () => {
    const { container, rerender } = render(<IconSprite />);

    // Mark the injected subtree, then re-render with a NEW element: were `{ __html }` rebuilt per
    // render, React 19 would re-assign innerHTML and the probe would vanish.
    container.querySelector('[data-testid="file-icon-sprite"] > svg')!
      .setAttribute("data-probe", "survived");
    rerender(<IconSprite />);

    // The detached-node trap: a re-assigned innerHTML DETACHES the old svg,
    // which keeps the probe — asserting on a pre-rerender reference would lie
    // green. Always re-query from the live container after the re-render.
    const after = container.querySelectorAll('[data-testid="file-icon-sprite"] > svg');
    expect(after).toHaveLength(1);
    expect(after[0].getAttribute("data-probe")).toBe("survived");
  });
});
