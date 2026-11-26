/** Polls `machine_capacity` every {@link CAPACITY_POLL_MS} while `enabled`: cheap, spawns nothing.
 * Reads never overlap; a failed read keeps the last good sample beside its error code. */

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
