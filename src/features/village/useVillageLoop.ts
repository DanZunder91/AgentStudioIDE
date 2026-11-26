/** The village's rAF loop: runs only while `running` (document visible) and is torn down on
 * unmount (the Pane renders only the active tab), so no background CPU. */

import { useEffect, useRef, useState } from "react";

import { logError } from "../logs/logStore";

/** Consecutive throwing frames after which the loop stops retrying on every frame… */
export const LOOP_MAX_FAILURES = 3;
/** …and retries this often instead, until a frame paints again. */
export const LOOP_RETRY_MS = 1000;

/** `!document.hidden`, kept current via `visibilitychange`. */
export function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(() => !document.hidden);
  useEffect(() => {
    const onChange = (): void => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return visible;
}

/** `onFrame(now)` each frame while `running`, `onStop` when it stops; latest callbacks, no restart.
 * A throwing frame neither ends the loop nor floods: one report per failing streak, and after
 * LOOP_MAX_FAILURES in a row it retries every LOOP_RETRY_MS until a frame paints again. */
export function useAnimationLoop(onFrame: (nowMs: number) => void, running: boolean, onStop?: () => void): void {
  const frameRef = useRef(onFrame);
  const stopRef = useRef(onStop);
  useEffect(() => {
    frameRef.current = onFrame;
    stopRef.current = onStop;
  });

  useEffect(() => {
    if (!running) return;
    let id = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const step = (now: number): void => {
      try {
        frameRef.current(now);
        failures = 0;
      } catch (error) {
        if (failures === 0) {
          console.error("Agent Village: a frame failed to paint", error);
          logError("village", "A frame failed to paint", String(error));
        }
        failures++;
      }
      if (failures < LOOP_MAX_FAILURES) id = requestAnimationFrame(step);
      else
        retry = setTimeout(() => {
          retry = undefined;
          id = requestAnimationFrame(step);
        }, LOOP_RETRY_MS);
    };
    id = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(id);
      clearTimeout(retry);
      stopRef.current?.();
    };
  }, [running]);
}
