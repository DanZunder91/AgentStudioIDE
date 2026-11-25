/**
 * A project's badge in the agent rail: a two-letter monogram and a color, both derived
 * from the folder, so the same project looks the same on every launch without storing
 * anything.
 */

/**
 * Colors for project badges. Chosen to stay readable on the rail's dark surface and to
 * stay clear of the status colors (blue running, amber waiting, green done, red error),
 * so a project's color is never read as a state.
 */
export const PROJECT_COLORS = [
  "#a78bfa", // violet
  "#2dd4bf", // teal
  "#f472b6", // pink
  "#a3e635", // lime
  "#818cf8", // indigo
  "#67e8f9", // cyan
] as const;

/** FNV-1a over the path's UTF-16 units: stable across launches and platforms. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** The project's color, from its absolute folder path. */
export function projectColor(path: string): string {
  return PROJECT_COLORS[hash(path) % PROJECT_COLORS.length];
}

/**
 * Two letters for a folder name: the first letters of its first two words, where words
 * break at `-`, `_`, `.`, spaces, a lower-to-upper case change and a letter/digit change
 * ("AgentStudioIDE" → "AS", "docs-site" → "DS", "to3D" → "T3"). A one-word name gives
 * its first two letters ("gazelle" → "GA").
 */
export function projectMonogram(name: string): string {
  const words = name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .replace(/(\d)([A-Za-z])/g, "$1 $2")
    .split(/[\s\-_.]+/)
    .filter(Boolean);
  if (words.length === 0) return "?";
  const letters =
    words.length === 1
      ? Array.from(words[0]).slice(0, 2)
      : [Array.from(words[0])[0], Array.from(words[1])[0]];
  return letters.join("").toUpperCase();
}
