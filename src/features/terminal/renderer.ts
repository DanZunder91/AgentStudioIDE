/** WebGL → DOM. No Canvas rung: `@xterm/addon-canvas` is abandoned and peer-depends on xterm 5.
 * WebGL is attempted everywhere, Linux included: failure falls to DOM cheaply and a lost context
 * degrades permanently. Overturn on data via `setRendererPreference('dom')` (ARCHITECTURE §6). */

import type { ITerminalAddon, Terminal } from "@xterm/xterm";

/** `dom` is xterm's built-in renderer: it means "no renderer addon loaded". */
export type RendererKind = "webgl" | "dom";

/** `auto` = feature-detect (the default). Force a kind for benchmarking. */
export type RendererPreference = RendererKind | "auto";

let preference: RendererPreference = "auto";

/** Process-wide override for the ARCHITECTURE §6 Linux benchmark gate (its fallback is now
 * "force DOM on Linux"). Applies to terminals created afterwards. */
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

/** Returns synchronously; the addon loads lazily, so the handle reports `dom` until it settles.
 * A WebGL context loss disposes the addon, leaving xterm's DOM renderer, with no caller help. */
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
      // The context can drop any time (WebKitGTK, GPU resets): degrade rather than render nothing.
      // xterm waits 3s for a restore before firing (@xterm/addon-webgl 0.19): a ~3s stall.
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
