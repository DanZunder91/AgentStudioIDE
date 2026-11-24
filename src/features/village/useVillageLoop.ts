/**
 * Agent Village — the animation loop. A `requestAnimationFrame` loop that runs only
 * while `running` is true: the panel passes "the document is visible", and the loop
 * is torn down on unmount (the Pane renders only the ACTIVE tab, so a hidden village
 * tab is unmounted). No background CPU either way.
 */

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

/**
 * Call `onFrame(now)` on every animation frame while `running`; `onStop` when the
 * loop stops (pause or unmount). The latest callbacks are used without restarting.
 *
 * A frame that throws neither ends the loop (that left a frozen — on the first frame,
 * blank — canvas until the tab was reopened) nor floods: the error is reported ONCE per
 * streak of failing frames (diagnostics log + console), and after LOOP_MAX_FAILURES in a
 * row the loop retries once every LOOP_RETRY_MS instead of 60 times a second. The first
 * frame that paints again ends the streak.
 */
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
