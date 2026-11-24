/**
 * Inline SVG icons for the pane chrome. Local to src/components/**.
 *
 * Kept inline (no icon dependency, no icon font, no remote/`data:` asset — a
 * strict CSP would block those) and stroked with `currentColor` so they inherit
 * the pane palette and any future theme switch for free.
 *
 * Every icon is `aria-hidden` + `focusable={false}`: these are DECORATION. The
 * accessible name always comes from the host control's text or `aria-label`,
 * never from the glyph — so a screen reader says "Files", not "folder Files".
 *
 * Every icon also carries `data-icon="<shape>"` — a stable, shape-named hook so
 * a test can assert *which* glyph a control rendered (e.g. that the Files tab
 * got the folder, not a shared placeholder) without reaching into path data.
 */

type IconProps = { size?: number };

const base = (size: number, name: string) => ({
  width: size,
  height: size,
  viewBox: "0 0 16 16",
  fill: "none" as const,
  stroke: "currentColor",
  strokeWidth: 1.25,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
  focusable: false,
  "data-icon": name,
});

/** Terminal tab: a shell prompt chevron. */
export function TerminalIcon({ size = 13 }: IconProps) {
  return (
    <svg {...base(size, "terminal")}>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <path d="M4.5 6.5 6.5 8l-2 1.5M8.5 10h3" />
    </svg>
  );
}

/** Editor tab: a document. */
export function FileIcon({ size = 13 }: IconProps) {
  return (
    <svg {...base(size, "file")}>
      <path d="M9 1.5H4.5A1.5 1.5 0 0 0 3 3v10a1.5 1.5 0 0 0 1.5 1.5h7A1.5 1.5 0 0 0 13 13V5.5z" />
      <path d="M9 1.5V5a.5.5 0 0 0 .5.5H13" />
    </svg>
  );
}

/**
 * Split into side-by-side panes — a vertical divider.
 * Maps to Orientation 'row' (types.ts: "'row' = side-by-side").
 */
/** Workspace tree: a folder. `open` swaps to the ajar variant. */
export function FolderIcon({ size = 13, open = false }: IconProps & { open?: boolean }) {
  return (
    <svg {...base(size, "folder")}>
      {open ? (
        <path d="M1.75 12.5 3.4 7.2A1 1 0 0 1 4.35 6.5H14l-1.4 5.3a1 1 0 0 1-.97.7H1.75zM1.75 12.5V4a1 1 0 0 1 1-1h3l1.5 1.5H12a1 1 0 0 1 1 1v1" />
      ) : (
        <path d="M1.75 12.5V4a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1z" />
      )}
    </svg>
  );
}

/** Disclosure caret; rotate 90 degrees via CSS when its folder is open. */
export function ChevronIcon({ size = 12 }: IconProps) {
  return (
    <svg {...base(size, "chevron")}>
      <path d="M6 4l4 4-4 4" />
    </svg>
  );
}

export function SplitRightIcon({ size = 13 }: IconProps) {
  return (
    <svg {...base(size, "split-right")}>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <path d="M8 2.5v11" />
    </svg>
  );
}

/** Split into stacked panes — a horizontal divider. Maps to Orientation 'column'. */
export function SplitDownIcon({ size = 13 }: IconProps) {
  return (
    <svg {...base(size, "split-down")}>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <path d="M1.5 8h13" />
    </svg>
  );
}

export function CloseIcon({ size = 12 }: IconProps) {
  return (
    <svg {...base(size, "close")}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

/** Resume: a circular arrow (↻) — "continue this conversation". */
export function ResumeIcon({ size = 12 }: IconProps) {
  return (
    <svg {...base(size, "resume")}>
      <path d="M12.5 8a4.5 4.5 0 1 1-1.3-3.2M12.5 3v2.6H9.9" />
    </svg>
  );
}

export function PlusIcon({ size = 13 }: IconProps) {
  return (
    <svg {...base(size, "plus")}>
      <path d="M8 3.5v9M3.5 8h9" />
    </svg>
  );
}

/** Quick-launch: a lightning bolt. Filled so it reads at rail size. */
export function LightningIcon({ size = 13 }: IconProps) {
  return (
    <svg {...base(size, "lightning")} fill="currentColor" stroke="none">
      <path d="M9 1.5 3.5 9H7l-.9 5.5L12.5 6.5H9z" />
    </svg>
  );
}

/**
 * Titlebar panel toggle: a rectangle with a divider marking the LEFT rail
 * (the divider sits near the left edge, so the icon reads as "left panel").
 */
export function PanelLeftIcon({ size = 16 }: IconProps) {
  return (
    <svg {...base(size, "panel-left")}>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <path d="M6 2.5v11" />
    </svg>
  );
}

/**
 * Titlebar panel toggle: a rectangle with a divider marking the RIGHT rail —
 * the mirror image of `PanelLeftIcon`.
 */
export function PanelRightIcon({ size = 16 }: IconProps) {
  return (
    <svg {...base(size, "panel-right")}>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <path d="M10 2.5v11" />
    </svg>
  );
}

/** Titlebar Find: a magnifying glass (search). */
export function SearchIcon({ size = 16 }: IconProps) {
  return (
    <svg {...base(size, "search")}>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5 L14 14" />
    </svg>
  );
}

/**
 * Vault rail tab: a padlock. Two big shapes only — a body and a shackle arc —
 * with no interior detail (no keyhole), so it still reads as "locked" at 13px
 * where a keyhole would just muddy the body.
 */
export function LockIcon({ size = 13 }: IconProps) {
  return (
    <svg {...base(size, "lock")}>
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </svg>
  );
}

/**
 * History rail tab: a clock. A plain dial + two hands drawn as ONE polyline —
 * the usual "history" glyph adds a counter-clockwise arrow around the dial, which
 * is exactly the fine detail that turns to mud at rail size, so it is omitted.
 */
/**
 * A metrics tab: three ascending bars. Lives here (not in the metrics feature) because
 * `TabBar`'s `TabKindIcon` is the shared switch over every tab kind — without this a
 * metrics tab falls through to the terminal glyph and reads as a shell.
 *
 * Same path data as the titlebar button's local glyph, deliberately: one mark for one
 * concept. Three bars rather than a line chart because at 13px a polyline with axis
 * ticks is mud, whereas three strokes of different heights stay unmistakable.
 */
export function ChartIcon({ size = 13 }: IconProps) {
  return (
    <svg {...base(size, "chart")}>
      <path d="M3 13V8.5M8 13V3M13 13V6.5" />
    </svg>
  );
}

/**
 * Agent Logs: a prompt chevron over two log lines — "what the
 * fleet printed", distinct from the diagnostics overlay's framed-lines glyph.
 */
export function LogStreamIcon({ size = 13 }: IconProps) {
  return (
    <svg {...base(size, "log-stream")}>
      <path d="M2.5 4l2.5 2-2.5 2M7 8h6.5M2.5 11.5h11" />
    </svg>
  );
}

/**
 * Network traffic: opposed up/down arrows — requests out,
 * responses in. Two strokes each, legible at 13px.
 */
export function NetworkIcon({ size = 13 }: IconProps) {
  return (
    <svg {...base(size, "network")}>
      <path d="M5 13V3M2.5 5.5L5 3l2.5 2.5M11 3v10M8.5 10.5L11 13l2.5-2.5" />
    </svg>
  );
}

/**
 * Agent Village: a little house — roof, walls and a door — the
 * village's unit (one house per project folder).
 */
export function VillageIcon({ size = 13 }: IconProps) {
  return (
    <svg {...base(size, "village")}>
      <path d="M2 7.5L8 2.5l6 5M3.5 6.5v7h9v-7M6.75 13.5v-3.5h2.5v3.5" />
    </svg>
  );
}

export function ClockIcon({ size = 13 }: IconProps) {
  return (
    <svg {...base(size, "clock")}>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.75V8l2.75 1.75" />
    </svg>
  );
}

/**
 * DB rail tab: a database cylinder.
 *
 * Two strokes only — the top ellipse and the barrel's silhouette — plus ONE interior
 * band. The canonical "stacked disks" glyph draws three ellipses, which at 13px puts
 * three curves within ~3px of each other and renders as a grey smudge; one band still
 * reads unmistakably as a database and cannot be confused with the Files folder or the
 * Collections bookmark. The barrel is drawn as a single path so the vertical sides and
 * the bottom curve join without a seam at the ellipse.
 */
export function DatabaseIcon({ size = 13 }: IconProps) {
  return (
    <svg {...base(size, "database")}>
      <ellipse cx="8" cy="3.75" rx="5.25" ry="2.25" />
      <path d="M2.75 3.75v8.5c0 1.24 2.35 2.25 5.25 2.25s5.25-1.01 5.25-2.25V3.75" />
      <path d="M2.75 8c0 1.24 2.35 2.25 5.25 2.25s5.25-1.01 5.25-2.25" />
    </svg>
  );
}

/**
 * Collections rail tab: a bookmark (saved / curated items). Chosen over the
 * usual "layers" stack on purpose: layers is three near-parallel strokes ~2px
 * apart once rendered at 13px, which smears together, whereas the bookmark is a
 * single closed silhouette with a notch — unmistakable at any rail size, and not
 * confusable with the Files folder.
 */
export function BookmarkIcon({ size = 13 }: IconProps) {
  return (
    <svg {...base(size, "bookmark")}>
      <path d="M4 2.5h8v11.5L8 10.75 4 14z" />
    </svg>
  );
}

/**
 * Tools rail tab: an open-end spanner.
 *
 * ONE closed silhouette, same discipline as the bookmark above: the whole wrench is a
 * single outline — jaw, head, handle — so there are no near-parallel strokes to smear
 * at 13px. Two shapes were rejected before this one:
 *
 *  - The crossed **wrench + screwdriver**. Two thin diagonals plus two detailed tips is
 *    six features inside a 13px box; it is the "three ellipses" mistake of DatabaseIcon
 *    in a different costume.
 *  - The **closed-ring** wrench head (the common Feather-style `tool` glyph). A circle
 *    with a thin diagonal rod is *exactly* the magnifying glass already sitting in the
 *    titlebar for Find — at rail size the small jaw notch is the only thing separating
 *    them, which is not a difference a user should have to look for.
 *
 * So the jaw is a deliberately WIDE bite (3.0 units across × 3.7 deep ≈ 2.4×3.0 px at
 * 13px, ~84° of the head's circumference) and the handle is a 3.4-unit BAR with a
 * rounded end, not a rod. Head ⌀7.4 centred at (9.9, 6.1), handle running down-left on
 * the 45° axis to (3.5, 12.5); everything stays inside x∈[1.7,14.2], y∈[1.8,14.3], so
 * the 1.25 stroke never touches the viewBox edge.
 */
export function WrenchIcon({ size = 13 }: IconProps) {
  return (
    <svg {...base(size, "wrench")}>
      <path d="M13.35 4.77A3.7 3.7 0 0 1 8.78 9.63L4.74 13.66A1.7 1.7 0 0 1 2.34 11.26L6.37 7.22A3.7 3.7 0 0 1 11.23 2.65L8.63 5.25l2.12 2.12z" />
    </svg>
  );
}

/**
 * Git rail tab: the standard branch glyph — a trunk with one
 * branch forking off, three commit dots. Same 13px discipline as the wrench above:
 * two short strokes and three small circles, nothing near-parallel to smear.
 */
export function GitBranchIcon({ size = 13 }: IconProps) {
  return (
    <svg {...base(size, "git-branch")}>
      <circle cx="4.5" cy="3.5" r="1.7" />
      <circle cx="4.5" cy="12.5" r="1.7" />
      <circle cx="11.5" cy="3.5" r="1.7" />
      <path d="M4.5 5.2v5.6" />
      <path d="M11.5 5.2c0 3.2-2.6 4-5.3 4.6" />
    </svg>
  );
}

/**
 * The rail strip's overflow trigger: three dots on the horizontal
 * axis. Filled — at 13px a 1.25 stroke around a sub-2px circle reads as noise,
 * so these are the one deliberate exception to the outline style.
 */
export function EllipsisIcon({ size = 13 }: IconProps) {
  return (
    <svg {...base(size, "ellipsis")} fill="currentColor" strokeWidth={0}>
      <circle cx="3" cy="8" r="1.4" />
      <circle cx="8" cy="8" r="1.4" />
      <circle cx="13" cy="8" r="1.4" />
    </svg>
  );
}
