// Shared data types for the reflow engine.
//
// Coordinate convention: all page geometry is in PDF points, origin at the
// TOP-LEFT of the page's crop box, y growing DOWN (like the screen). The
// extractor converts from PDF user space (y-up) once, so nothing else has to.

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** One character as reported by PDFium, converted to y-down page space. */
export interface RawChar {
  code: number; // unicode code point (0x02 = PDFium's marker for a line-end hyphen)
  generated: boolean; // space / line break inserted by PDFium, not in the PDF
  hyphen: boolean; // PDFium thinks this is a line-end hyphen
  ox: number; // origin (pen position on the baseline)
  oy: number; // baseline
  // loose box: advance width x (font ascent + descent)
  lx0: number;
  lx1: number;
  ly0: number;
  ly1: number;
  // tight box: glyph ink bounds
  tx0: number;
  tx1: number;
  ty0: number;
  ty1: number;
  size: number; // effective font size in points
  font: number; // index into RawPage.fonts
  angle: number; // radians
}

export interface FontInfo {
  name: string;
  flags: number; // PDF font descriptor flags
  mono: boolean;
  italic: boolean;
  bold: boolean;
}

export const enum ObjType {
  Text = 1,
  Path = 2,
  Image = 3,
  Shading = 4,
  Form = 5,
}

/** A non-text page object (image / vector drawing) with its bounds. */
export interface RawObject {
  type: ObjType;
  rect: Rect;
}

export interface RawPage {
  index: number;
  width: number;
  height: number;
  chars: RawChar[];
  fonts: FontInfo[];
  objects: RawObject[];
}

// ---------------------------------------------------------------------------
// Analysis results

export interface Word {
  text: string;
  /** Advance box: typographic extent used for spacing. */
  x0: number;
  x1: number;
  /** Ink extent (incl. a little antialiasing margin) used for cropping. */
  cropX0: number;
  cropX1: number;
  baseline: number;
  size: number;
  /**
   * Trailing hyphen glyph. The word's own x1/cropX1 stop before it, so the hyphen can be
   * dropped when the two halves of a split word are rejoined. `soft` = PDFium judged it to be
   * a line-break hyphen; the layout also treats "-" + lowercase continuation as soft.
   */
  hyphen?: { soft: boolean; x0: number; x1: number; cropX0: number; cropX1: number };
  mono: boolean;
  /** Oversized word (drop cap): its own vertical crop band; drawn scaled by `scale` to match the line. */
  own?: { top: number; bottom: number; scale: number };
  /** No space after this word (a drop cap is the first letter of the next word). */
  joinNext?: boolean;
  /**
   * Places where the word image may be cut for hyphenation: between char i and i+1, `adv[i]` is
   * the typographic boundary and `ink[i]` the crop line (NaN where cutting would damage a glyph,
   * e.g. inside a ligature).
   */
  splits?: { adv: number[]; ink: number[] };
}

/** A hyphen glyph from the book itself, drawn where the layout hyphenates a word. */
export interface HyphenSample {
  page: number;
  x0: number;
  x1: number;
  cropX0: number;
  cropX1: number;
  top: number;
  bottom: number;
  baseline: number;
  size: number;
}

export interface Line {
  page: number;
  words: Word[];
  x0: number;
  x1: number;
  baseline: number;
  size: number;
  inkTop: number;
  inkBottom: number;
  /** Vertical crop band (computed after reading order is known). */
  bandTop: number;
  bandBottom: number;
  mono: boolean;
}

export type Align = 'justify' | 'left' | 'center' | 'right';

export interface ParaBlock {
  kind: 'para';
  lines: Line[];
  align: Align;
  /** First-line indent relative to the other lines (pt, may be negative for hanging indents). */
  indent: number;
  /** Left / right inset of the whole paragraph relative to the text column (pt). */
  insetL: number;
  insetR: number;
  /** The text column's left / right edges (pt). */
  colL: number;
  colR: number;
  size: number;
  /** Source baseline-to-baseline distance between lines (pt). */
  pitch: number;
  /** Source distance from previous block's last baseline (or top) to our first baseline. */
  gapBefore: number;
  heading: boolean;
  /** Preformatted (code): keep line breaks, never re-wrap. */
  pre: boolean;
  /** Last paragraph on the page that runs on to the next page. */
  continuesNext?: boolean;
  /** First paragraph on the page that continues the previous page's last paragraph. */
  continuesPrev?: boolean;
  page: number;
}

export interface FigureBlock {
  kind: 'figure';
  rect: Rect;
  gapBefore: number;
  page: number;
}

export type Block = ParaBlock | FigureBlock;

export interface PageModel {
  index: number;
  width: number;
  height: number;
  blocks: Block[];
  /** Lines removed as running headers / footers / page numbers. */
  furniture: Line[];
  /** Dominant body font size on this page (pt), 0 if no text. */
  bodySize: number;
  /** Bounding box of everything kept (used to crop margins in "original" view). */
  contentRect: Rect | null;
  /** A hyphen glyph found on this page (for hyphenating), if any. */
  hyphenSample?: HyphenSample;
}

// ---------------------------------------------------------------------------
// Layout results

/** Copy `src` (page pt) from `page` rendered at `scale` px/pt to (dx, dy) in CSS px. */
export interface DrawOp {
  page: number;
  src: Rect;
  scale: number;
  dx: number;
  dy: number;
  /** pictures keep their colours in dark / sepia themes */
  figure?: boolean;
}

export interface LayoutSettings {
  /** Content width in CSS px (screen width minus side margins). */
  width: number;
  /** Target size of body text in CSS px. */
  fontPx: number;
  /** Multiplier on the book's own line spacing. */
  lineSpacing: number;
  justify: boolean;
}

export interface ChunkLayout {
  height: number;
  ops: DrawOp[];
  /** Vertical anchors: CSS-px y of each source page's first content, for position mapping. */
  anchors: { page: number; y: number; srcY: number }[];
}
