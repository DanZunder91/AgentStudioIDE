/**
 * The Tools feature's public surface.
 *
 * Narrow on purpose, exactly like `features/db/index.ts`: `App.tsx` mounts the rail
 * panel and must not have to know which file inside the feature it lives in. The
 * conversion engine (`epoch.ts`, `instant.ts`, `dateParse.ts`) is NOT re-exported —
 * nothing outside this feature has any business calling it, and a barrel is an
 * invitation.
 */

export { ToolsPanel } from "./ToolsPanel";
