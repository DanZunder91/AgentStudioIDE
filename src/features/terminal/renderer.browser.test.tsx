/** Browser tier (testing-strategy §7.5): only real Chromium has WebGL2, so the probe stays real
 * and is toggled by stubbing `getContext("webgl2")`. `@xterm/addon-webgl` is a faithful fake: we
 * test our decision to mount/dispose it, not xterm's addon. */

import { Terminal } from "@xterm/xterm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getRendererPreference,
  mountRenderer,
  setRendererPreference,
} from "./renderer";

/* ── The fake addon: hoisted so `vi.mock`'s factory can see it ── */
const glMock = vi.hoisted(() => {
  interface FakeInstance {
    activated: boolean;
    disposed: boolean;
    contextLossCb: (() => void) | null;
  }
  const instances: FakeInstance[] = [];
  const state = { activateThrows: false };

  class FakeWebglAddon implements FakeInstance {
    activated = false;
    disposed = false;
    contextLossCb: (() => void) | null = null;
    constructor() {
      instances.push(this);
    }
    // xterm's AddonManager calls activate() synchronously from loadAddon(); a
    // throw here is exactly how a real un-creatable GL context surfaces.
    activate(): void {
      if (state.activateThrows) throw new Error("simulated WebGL context failure");
      this.activated = true;
    }
    onContextLoss(cb: () => void): void {
      this.contextLossCb = cb;
    }
    dispose(): void {
      this.disposed = true;
    }
  }
  return { instances, state, FakeWebglAddon };
});

vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: glMock.FakeWebglAddon }));

/* ── The feature-detection seam: real getContext, toggled per test ── */
const realGetContext = HTMLCanvasElement.prototype.getContext;

/** Make `webgl2Available()` see no GL context — the real probe's null branch. */
function forceWebglUnavailable(): void {
  HTMLCanvasElement.prototype.getContext = function (
    this: HTMLCanvasElement,
    type: string,
    ...args: unknown[]
  ) {
    if (type === "webgl2" || type === "webgl" || type === "experimental-webgl") {
      return null;
    }
    // Delegate everything else (2d, bitmaprenderer, …) to the real engine.
    return (realGetContext as (...a: unknown[]) => unknown).call(this, type, ...args);
  } as typeof HTMLCanvasElement.prototype.getContext;
}

/** Run the real probe against real Chromium — used to prove availability. */
function realWebgl2Available(): boolean {
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2");
  const available = gl !== null;
  (gl as WebGL2RenderingContext | null)
    ?.getExtension("WEBGL_lose_context")
    ?.loseContext();
  return available;
}

/** The first lazy `import()` of the addon pays a module-load cost, so poll rather than flush.
 * Does not assert; the caller does, so a timeout fails legibly. */
async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (pred()) return;
    await new Promise<void>((r) => setTimeout(r, 5));
  }
}

/** Let the lazy import settle for the negative case (kind must STAY dom). */
async function settle(): Promise<void> {
  await waitFor(() => false, 60);
}

describe("terminal renderer — WebGL selection and the DOM degrade path", () => {
  const hosts: HTMLElement[] = [];

  /** A real, opened xterm terminal in a real host — as TerminalRegistry does. */
  function openTerminal(): Terminal {
    const host = document.createElement("div");
    host.style.width = "400px";
    host.style.height = "200px";
    document.body.appendChild(host);
    hosts.push(host);
    const term = new Terminal({ allowProposedApi: true });
    term.open(host);
    return term;
  }

  beforeEach(() => {
    glMock.instances.length = 0;
    glMock.state.activateThrows = false;
    setRendererPreference("auto");
  });

  afterEach(() => {
    HTMLCanvasElement.prototype.getContext = realGetContext;
    setRendererPreference("auto");
    for (const h of hosts.splice(0)) h.remove();
  });

  // A canary, not a feature test: every "WebGL is available" branch below is
  // premised on real Chromium actually giving us GL. If this line goes red, the
  // failures beneath it are environmental, not renderer.ts regressions.
  it("(premise) real Chromium exposes a WebGL2 context", () => {
    expect(realWebgl2Available()).toBe(true);
  });

  it("auto + WebGL available → mounts the WebGL renderer", async () => {
    expect(realWebgl2Available()).toBe(true); // premise, made local & explicit
    expect(getRendererPreference()).toBe("auto");

    const handle = mountRenderer(openTerminal());
    await waitFor(() => handle.kind === "webgl");

    // The decision renderer.ts made: it constructed and activated exactly one
    // WebGL addon, and reports the webgl kind.
    expect(handle.kind).toBe("webgl");
    expect(glMock.instances).toHaveLength(1);
    expect(glMock.instances[0].activated).toBe(true);
  });

  it("auto + WebGL2 probe returns null → falls back to the DOM renderer (no throw)", async () => {
    forceWebglUnavailable();
    expect(realWebgl2Available()).toBe(false); // the probe now reports unavailable

    // mountRenderer itself must never throw — the whole point of the degrade path.
    const handle = mountRenderer(openTerminal());
    await settle();

    expect(handle.kind).toBe("dom");
    // resolveKind() short-circuits to dom, so the addon is never even imported.
    expect(glMock.instances).toHaveLength(0);
  });

  it("addon activation throws → falls back to DOM and disposes the dead addon", async () => {
    // Probe says yes but the addon fails in loadAddon() (no real GL context): renderer.ts must
    // dispose the half-built addon and land on DOM.
    expect(realWebgl2Available()).toBe(true);
    glMock.state.activateThrows = true;

    const handle = mountRenderer(openTerminal());
    await waitFor(() => glMock.instances[0]?.disposed === true);

    expect(handle.kind).toBe("dom");
    expect(glMock.instances).toHaveLength(1); // it was constructed…
    expect(glMock.instances[0].activated).toBe(false); // …activate threw…
    expect(glMock.instances[0].disposed).toBe(true); // …and the catch disposed it.
  });

  it("setRendererPreference('dom') is honored even when WebGL IS available", async () => {
    // Non-vacuous: prove WebGL really is available first, so a dom result can
    // only be the override winning — not an absent GL context.
    expect(realWebgl2Available()).toBe(true);
    setRendererPreference("dom");
    expect(getRendererPreference()).toBe("dom");

    const handle = mountRenderer(openTerminal());
    await settle();

    expect(handle.kind).toBe("dom");
    // Forced DOM must not even attempt to construct a WebGL addon.
    expect(glMock.instances).toHaveLength(0);
  });

  it("setRendererPreference('webgl') bypasses the probe (mounts WebGL despite an unavailable probe)", async () => {
    // The strong form of "override honored": make the probe say NO, then force
    // WebGL. Under 'auto' this would be DOM; the forced kind proves the override
    // skips feature detection entirely.
    forceWebglUnavailable();
    expect(realWebgl2Available()).toBe(false);
    setRendererPreference("webgl");

    const handle = mountRenderer(openTerminal());
    await waitFor(() => handle.kind === "webgl");

    expect(handle.kind).toBe("webgl");
    expect(glMock.instances).toHaveLength(1);
    expect(glMock.instances[0].activated).toBe(true);
  });

  it("self-heals on WebGL context loss: degrades to DOM and disposes the addon", async () => {
    const handle = mountRenderer(openTerminal());
    await waitFor(() => handle.kind === "webgl");

    // Precondition: we are actually on WebGL, with a context-loss handler wired.
    expect(handle.kind).toBe("webgl");
    const addon = glMock.instances[0];
    expect(addon.contextLossCb).toBeTypeOf("function");
    expect(addon.disposed).toBe(false);

    // Drive the seam renderer.ts owns: xterm translates a real `webglcontextlost`
    // DOM event into this callback (after a ~3s grace that is xterm's, not ours),
    // so invoking it directly is the faithful, deterministic simulation.
    addon.contextLossCb!();

    expect(handle.kind).toBe("dom"); // degraded, permanently
    expect(addon.disposed).toBe(true); // the dead GL addon was released
  });

  it("dispose releases the addon instance, and a second mount works", async () => {
    const first = mountRenderer(openTerminal());
    await waitFor(() => first.kind === "webgl");
    expect(first.kind).toBe("webgl");
    const firstAddon = glMock.instances[0];
    expect(firstAddon.disposed).toBe(false);

    first.dispose();

    // The instance is released — this is the leak §7.5's `dispose_releases_instance`
    // guards against across TerminalRegistry open/close cycles.
    expect(firstAddon.disposed).toBe(true);

    // A fresh mount is unaffected by the disposed one: distinct instance, live.
    const second = mountRenderer(openTerminal());
    await waitFor(() => second.kind === "webgl");
    expect(second.kind).toBe("webgl");
    expect(glMock.instances).toHaveLength(2);
    expect(glMock.instances[1]).not.toBe(firstAddon);
    expect(glMock.instances[1].activated).toBe(true);
    expect(glMock.instances[1].disposed).toBe(false);

    second.dispose();
    expect(glMock.instances[1].disposed).toBe(true);
  });

  it("dispose during the async addon load never mounts a leaked addon", async () => {
    // dispose() can land before the lazy `await import()` resolves. renderer.ts's
    // `if (disposed) return` guards must ensure we neither mount nor leak.
    const handle = mountRenderer(openTerminal());
    handle.dispose(); // synchronous, before the lazy import can resolve
    await settle();

    expect(handle.kind).toBe("dom");
    // Either the addon was never constructed, or if it was, it was disposed —
    // never left live.
    for (const inst of glMock.instances) {
      expect(inst.activated && !inst.disposed).toBe(false);
    }
  });
});
