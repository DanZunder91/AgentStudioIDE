/**
 * Renderer selection with graceful degradation: WebGL -> DOM.
 *
 * ## Why there is no Canvas rung any more
 *
 * ARCHITECTURE §6 specified WebGL -> Canvas -> DOM, with Linux/WebKitGTK
 * routed straight to Canvas. That is no longer buildable: `@xterm/addon-canvas`
 * was last published 2024-07-14 (0.7.0) and still peer-depends on
 * `@xterm/xterm@^5.0.0`, while core xterm is 6.x — it hard-fails `npm install`
 * with ERESOLVE. The addon is abandoned; Canvas is gone as an option.
 *
 * ## Linux/WebKitGTK policy: attempt WebGL, fall back to DOM
 *
 * With Canvas gone the only choices are attempt-WebGL-then-DOM, or
 * straight-to-DOM on Linux. We attempt WebGL everywhere, because:
 *
 *  1. The Linux special-case existed to reach Canvas — the safe-but-still-fast
 *     middle rung. With that rung gone, defaulting Linux to DOM tracks away the
 *     product's core need (many high-throughput agent terminals) against a risk
 *     that is already detected and handled below, and does so preemptively
 *     rather than on evidence.
 *  2. Failure is cheap and self-healing. A context that cannot be created
 *     throws synchronously out of `loadAddon()` and lands on DOM immediately,
 *     at no cost. A context lost at runtime degrades to DOM permanently.
 *  3. §6's worry that WebKitGTK's WebGL2 "can be silently software-backed" is
 *     an argument about speed, not correctness: measured under SwiftShader
 *     (software WebGL2), xterm's WebGL renderer activates and renders fine. A
 *     software-backed WebGL path is still expected to beat the DOM renderer.
 *
 * The DOM renderer is significantly slower under heavy output, so it is the
 * floor, not a default. ARCHITECTURE §6's M1 Ubuntu/NVIDIA benchmark gate is
 * the right place to overturn this on real data — `setRendererPreference('dom')`
 * is the lever and needs no code change here.
 */

import type { ITerminalAddon, Terminal } from "@xterm/xterm";

/** `dom` is xterm's built-in renderer: it means "no renderer addon loaded". */
export type RendererKind = "webgl" | "dom";

/** `auto` = feature-detect (the default). Force a kind for benchmarking. */
export type RendererPreference = RendererKind | "auto";

let preference: RendererPreference = "auto";

/**
 * Override renderer selection process-wide. Intended for the ARCHITECTURE §6
 * Linux/NVIDIA benchmark gate and for its staged fallback plan (step 1 —
 * now necessarily "force DOM on Linux" rather than Canvas). Takes effect for
 * terminals created afterwards.
 */
export function setRendererPreference(kind: RendererPreference): void {
  preference = kind;
}

export function getRendererPreference(): RendererPreference {
  return preference;
}

/** Probe for a real WebGL2 context, releasing the probe immediately. */
function webgl2Available(): boolean {
  if (typeof document === "undefined") return false;
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2", {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
    });
    if (!gl) return false;
    // Free the probe context right away — webviews cap live GL contexts (~8-16)
    // and we want them all for real terminals.
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return true;
  } catch {
    return false;
  }
}

function resolveKind(): RendererKind {
  if (preference !== "auto") return preference;
  return webgl2Available() ? "webgl" : "dom";
}

export interface RendererHandle {
  /** The renderer currently in use; degrades to `dom` after a context loss. */
  readonly kind: RendererKind;
  dispose(): void;
}

/**
 * Load the best available renderer addon into `term`.
 *
 * Returns synchronously; the addon is imported lazily, so the handle reports
 * `dom` until one settles. Self-healing: a WebGL context loss disposes the
 * addon and leaves xterm on its built-in DOM renderer, with no caller
 * involvement.
 */
export function mountRenderer(term: Terminal): RendererHandle {
  let current: ITerminalAddon | null = null;
  let kind: RendererKind = "dom";
  let disposed = false;

  // Named loadWebgl, not useWebgl: a `use`-prefixed local reads as a React hook
  // to both humans and react-hooks/rules-of-hooks, and this is neither.
  const loadWebgl = async (): Promise<void> => {
    if (disposed) return;
    let addon: import("@xterm/addon-webgl").WebglAddon | undefined;
    try {
      const { WebglAddon } = await import("@xterm/addon-webgl");
      if (disposed) return;
      addon = new WebglAddon();
      const gl = addon;
      // WebKitGTK (and GPU driver resets anywhere) can drop the context at any
      // time — degrade instead of rendering nothing.
      //
      // Note: xterm's WebglRenderer gives the browser a 3s grace period to
      // restore the context before it fires this, so a real context loss means
      // ~3s of a stalled terminal before the DOM renderer takes over. That's
      // xterm's call, not ours — verified against @xterm/addon-webgl 0.19.
      gl.onContextLoss(() => {
        console.warn("[terminal] WebGL context lost, falling back to DOM renderer");
        try {
          gl.dispose(); // disposing the addon reverts xterm to its DOM renderer
        } catch {
          /* already torn down */
        }
        if (current === gl) {
          current = null;
          kind = "dom";
        }
      });
      // Throws if the GL context can't be created — activate() is synchronous.
      term.loadAddon(gl);
      current = gl;
      kind = "webgl";
    } catch (err) {
      // No Canvas rung to catch us: xterm's built-in DOM renderer is the floor.
      console.warn("[terminal] WebGL renderer unavailable, using DOM renderer", err);
      try {
        addon?.dispose();
      } catch {
        /* activate() failed before it held anything */
      }
      current = null;
      kind = "dom";
    }
  };

  if (resolveKind() === "webgl") void loadWebgl();
  // "dom": nothing to load.

  return {
    get kind() {
      return kind;
    },
    dispose() {
      disposed = true;
      try {
        current?.dispose();
      } catch {
        /* already torn down */
      }
      current = null;
    },
  };
}
