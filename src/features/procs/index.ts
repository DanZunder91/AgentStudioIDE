/** Dev apps on this machine, UI half: `<DevAppsSection/>` (Logs sidebar's Apps group),
 * `<DevAppCard/>` (above the Logs stream, unmounted when `useSelectedDevApp()` goes null), and
 * `devAppForSource` grouping `kind: "app"` lines (`<name> · <file>`) under their app. */

export { DevAppsSection, RuntimeBadge, type DevAppsSectionProps } from "./DevAppsSection";
export { DevAppCard, type DevAppCardProps } from "./DevAppCard";
export { devAppForSource } from "./procsFormat";
export {
  selectDevApp,
  streamsOf,
  useProcsStore,
  useSelectedDevApp,
  type ActiveStream,
} from "./procsStore";
export type { DevApp, DevRuntime, ProcsList } from "./procsTypes";
