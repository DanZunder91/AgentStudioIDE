/**
 * The machine sample behind the capacity buildings: `machine_capacity` read now and
 * every {@link CAPACITY_POLL_MS} — only while `enabled` (the panel passes "mounted and the document
 * visible"). Reading the process table is cheap and spawns nothing, unlike the usage
 * and context reads, which this hook never triggers.
 *
 * A failed read keeps the last good sample beside its error code (stale-but-true beats a blank
 * building, as in `usageStore`); reads never overlap.
 */

import { useEffect, useState } from "react";

import { externalErrorCode, machineCapacity } from "./villageIpc";
import type { MachineCapacityWire } from "./villageTypes";

export const CAPACITY_POLL_MS = 5000;

export interface MachineCapacityState {
  /** The last good sample; null until the first one. */
  sample: MachineCapacityWire | null;
  /** The last read's error code; null after a success. */
  error: string | null;
}

export function useMachineCapacity(enabled: boolean): MachineCapacityState {
  const [state, setState] = useState<MachineCapacityState>({ sample: null, error: null });
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let busy = false;
    const read = (): void => {
      if (busy) return;
      busy = true;
      machineCapacity()
        .then(
          (sample) => !disposed && setState({ sample, error: null }),
          (err: unknown) => !disposed && setState((s) => ({ sample: s.sample, error: externalErrorCode(err) })),
        )
        .finally(() => {
          busy = false;
        });
    };
    read();
    const timer = setInterval(read, CAPACITY_POLL_MS);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [enabled]);
  return state;
}
