/**
 * Agent Village renderer — shared types (types only, erased at runtime).
 *
 * `DrawTarget` is the narrow slice of `CanvasRenderingContext2D` the renderer
 * touches, so jsdom tests can hand it a recording fake (jsdom has no canvas)
 * and the browser tier hands it the real context. A real 2D context is
 * assignable to it as-is.
 */

/** The subset of `CanvasRenderingContext2D` the renderer uses. */
export interface DrawTarget {
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  globalAlpha: number;
  lineWidth: number;
  imageSmoothingEnabled: boolean;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  fillRect(x: number, y: number, w: number, h: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  drawImage(
    image: CanvasImageSource,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ): void;
  fillText(text: string, x: number, y: number): void;
  measureText(text: string): { width: number };
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  scale(x: number, y: number): void;
  beginPath(): void;
  arc(x: number, y: number, r: number, start: number, end: number): void;
  /** `fillRule` "evenodd" lets one path punch holes (the house interiors out of the outdoor grade). */
  fill(fillRule?: CanvasFillRule): void;
  /** Add a rectangle sub-path to the current path. */
  rect(x: number, y: number, w: number, h: number): void;
  /** Clip to the current path (undone by `restore`). */
  clip(fillRule?: CanvasFillRule): void;
}

/** A decoded (or pre-rendered) image the renderer can `drawImage` from. */
export type SpriteImage = CanvasImageSource;

/** The vendored pixel-agents furniture PNGs we render (see src/assets/pixel-agents/README.md). */
export type FurnitureId =
  | "DESK_FRONT"
  | "SMALL_TABLE_FRONT"
  | "TABLE_FRONT"
  | "PC_FRONT_OFF"
  | "PC_FRONT_ON_1"
  | "PC_FRONT_ON_2"
  | "PC_FRONT_ON_3"
  | "WOODEN_CHAIR_FRONT"
  | "WOODEN_CHAIR_BACK"
  | "WOODEN_CHAIR_SIDE"
  | "PLANT"
  | "BOOKSHELF"
  | "BIN"
  | "COFFEE"
  | "SOFA_FRONT"
  | "SOFA_BACK";

/** Photoshop-style "Colorize" parameters: hue 0..360, saturation 0..100, brightness/contrast -100..100. */
export interface Hsbc {
  h: number;
  s: number;
  b: number;
  c: number;
}

/**
 * The decoded art. Every getter returns `null` when that sprite is unavailable
 * (bank in fallback mode, or a recolour needs a canvas the host lacks) — the
 * renderer then paints a plain coloured rectangle instead. Recoloured variants
 * are rendered lazily on first request and cached by key.
 */
export interface SpriteBank {
  /** true when the PNGs could not be loaded: every getter returns null. */
  readonly fallback: boolean;
  /** Character sheet `palette` (0..5, wrapped) hue-rotated by `hueShift` degrees. 112×96. */
  character(palette: number, hueShift: number): SpriteImage | null;
  /** Floor pattern `pattern` (0..8, wrapped) colourised with `tint`. 16×16. */
  floor(pattern: number, tint: Hsbc): SpriteImage | null;
  /** The 4×4 wall auto-tile sheet colourised with `tint`. 64×128 (16×32 pieces). */
  wall(tint: Hsbc): SpriteImage | null;
  /** A furniture PNG, unmodified. */
  furniture(id: FurnitureId): SpriteImage | null;
}
