/** How the rail draws a project (Settings → Interface): CSS only, via `fleet-tree--groups-<style>`
 * on the flat list. Persisted in `layout-prefs.json`; an unknown value reads as the default, so a
 * downgrade never leaves the rail unstyled. */

export const RAIL_GROUP_STYLES = ["card", "well", "divider", "pinned"] as const;

export type RailGroupStyle = (typeof RAIL_GROUP_STYLES)[number];

export const DEFAULT_RAIL_GROUP_STYLE: RailGroupStyle = "card";

export interface RailGroupStyleOption {
  value: RailGroupStyle;
  label: string;
  hint: string;
}

/** The choices Settings → Interface offers, in the order it lists them. */
export const RAIL_GROUP_STYLE_OPTIONS: readonly RailGroupStyleOption[] = [
  {
    value: "card",
    label: "Framed card",
    hint: "Each project and its agents sit inside one bordered card.",
  },
  {
    value: "well",
    label: "Inset well",
    hint: "The agents sit in a darker panel under the project name.",
  },
  {
    value: "divider",
    label: "Labelled divider",
    hint: "A small project label and a rule line open each project.",
  },
  {
    value: "pinned",
    label: "Pinned header bar",
    hint: "The project bar stays at the top while you scroll its agents.",
  },
];

/** A persisted value as this build understands it: a known style, else the default. */
export function parseRailGroupStyle(value: unknown): RailGroupStyle {
  return (RAIL_GROUP_STYLES as readonly unknown[]).includes(value)
    ? (value as RailGroupStyle)
    : DEFAULT_RAIL_GROUP_STYLE;
}

/** The label Settings shows for a style. */
export function railGroupStyleLabel(style: RailGroupStyle): string {
  return RAIL_GROUP_STYLE_OPTIONS.find((o) => o.value === style)?.label ?? style;
}
