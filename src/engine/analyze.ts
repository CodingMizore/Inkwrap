// Page analysis: characters -> words -> lines -> reading order -> paragraphs.
//
// The input is exact per-character geometry from PDFium, so words and lines
// are known precisely; the heuristics below are only about *structure*
// (which lines form a paragraph, what is a running header, what is a figure).

import {
  ObjType,
  type Block,
  type FigureBlock,
  type Line,
  type PageModel,
  type ParaBlock,
  type RawChar,
  type RawPage,
  type Rect,
  type Word,
} from './types';

// ---------------------------------------------------------------------------
// small helpers

const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Most common value after rounding to `step`, weighted. */
const mode = (values: number[], weights: number[], step: number): number => {
  const acc = new Map<number, number>();
  values.forEach((v, i) => {
    const k = Math.round(v / step) * step;
    acc.set(k, (acc.get(k) ?? 0) + weights[i]);
  });
  let best = 0, bestW = -1;
  for (const [k, w] of acc) if (w > bestW) (best = k), (bestW = w);
  return best;
};

const grow = (r: Rect, o: Rect) => {
  r.x0 = Math.min(r.x0, o.x0);
  r.y0 = Math.min(r.y0, o.y0);
  r.x1 = Math.max(r.x1, o.x1);
  r.y1 = Math.max(r.y1, o.y1);
};

const isSpaceCode = (c: number) => c === 32 || c === 0xa0 || c === 9 || (c >= 0x2000 && c <= 0x200b) || c === 0x3000;
const isBreakCode = (c: number) => c === 10 || c === 13;
const DASHES = new Set([0x2013, 0x2014, 0x2015]);

// ---------------------------------------------------------------------------
// 1. words

interface WordDraft extends Word {
  inkX0: number;
  inkX1: number;
  inkTop: number;
  inkBottom: number;
  charCount: number;
}

function makeWord(chars: RawChar[], page: RawPage): WordDraft | null {
  if (!chars.length) return null;
  // dominant char = largest size (superscripts are smaller)
  let main = chars[0];
  for (const c of chars) if (c.size > main.size * 1.05) main = c;

  const last = chars[chars.length - 1];
  let hy: RawChar | null = null;
  let softHy = false;
  if (chars.length > 1 && (last.hyphen || last.code === 2 || last.code === 0xad || last.code === 0x2d || last.code === 0x2010)) {
    hy = last;
    softHy = last.hyphen || last.code === 2 || last.code === 0xad;
    chars = chars.slice(0, -1);
  }

  const pad = (s: number) => 0.6 + 0.04 * s;
  let x0 = Infinity, x1 = -Infinity, inkX0 = Infinity, inkX1 = -Infinity, inkTop = Infinity, inkBottom = -Infinity;
  let text = '';
  for (const c of chars) {
    x0 = Math.min(x0, c.lx0);
    x1 = Math.max(x1, c.lx1);
    const tightOk = c.tx1 > c.tx0 && c.ty1 > c.ty0;
    inkX0 = Math.min(inkX0, tightOk ? c.tx0 : c.lx0);
    inkX1 = Math.max(inkX1, tightOk ? c.tx1 : c.lx1);
    inkTop = Math.min(inkTop, tightOk ? c.ty0 : c.ly0);
    inkBottom = Math.max(inkBottom, tightOk ? c.ty1 : c.ly1);
    text += c.code === 0 || c.code >= 0xfffe ? '�' : String.fromCodePoint(c.code);
  }
  const p = pad(main.size);
  const w: WordDraft = {
    text,
    x0,
    x1,
    cropX0: inkX0 - p,
    cropX1: inkX1 + p,
    baseline: main.oy,
    size: main.size,
    mono: page.fonts[main.font]?.mono ?? false,
    inkX0,
    inkX1,
    inkTop,
    inkBottom,
    charCount: chars.length,
  };
  if (chars.length >= 5) {
    // safe cut points for hyphenation: never inside a ligature (shared origin) or through overlapping ink
    const adv: number[] = [], ink: number[] = [];
    for (let i = 0; i + 1 < chars.length; i++) {
      const a = chars[i], b = chars[i + 1];
      const tight = a.tx1 > a.tx0 && b.tx1 > b.tx0;
      const ok = b.ox > a.ox + 0.05 && (!tight || b.tx0 >= a.tx1 - 0.25);
      adv.push(b.lx0);
      ink.push(ok ? (tight ? (a.tx1 + b.tx0) / 2 : b.lx0) : NaN);
    }
    w.splits = { adv, ink };
  }
  if (hy) {
    const hInk0 = hy.tx1 > hy.tx0 ? hy.tx0 : hy.lx0;
    const hInk1 = hy.tx1 > hy.tx0 ? hy.tx1 : hy.lx1;
    const mid = (inkX1 + hInk0) / 2;
    // the letters' crop must stop before the hyphen's ink
    w.cropX1 = Math.min(w.cropX1, mid);
    w.hyphen = { soft: softHy, x0: hy.lx0, x1: hy.lx1, cropX0: mid, cropX1: hInk1 + p };
    w.inkX1 = hInk1; // for neighbour limits, the word's ink includes the hyphen
  }
  return w;
}

export function buildWords(page: RawPage): WordDraft[] {
  const words: WordDraft[] = [];
  let cur: RawChar[] = [];
  let main: RawChar | null = null;
  const flush = () => {
    const w = makeWord(cur, page);
    if (w) words.push(w);
    cur = [];
    main = null;
  };
  for (const c of page.chars) {
    if (isSpaceCode(c.code) || isBreakCode(c.code)) {
      flush();
      continue;
    }
    if (c.code < 32 && c.code !== 2) continue; // control chars other than PDFium's hyphen marker
    const a = Math.min(c.angle, Math.PI * 2 - c.angle);
    if (a > 0.05) {
      flush(); // rotated text is left to figure crops
      continue;
    }
    if (c.lx1 <= c.lx0 && c.tx1 <= c.tx0) continue; // zero-size glyph
    if (main && cur.length) {
      const prev = cur[cur.length - 1];
      const s = Math.max(main.size, c.size);
      const dy = Math.abs(c.oy - main.oy);
      const backwards = c.lx0 < prev.lx0 - 0.1 * s;
      const gap = c.lx0 - prev.lx1 > 0.22 * s;
      let baselineJump = false;
      if (dy > 0.15 * s) {
        const smaller = c.size < main.size * 0.9 || main.size < c.size * 0.9;
        baselineJump = !(smaller && dy < 0.75 * s);
      }
      if (backwards || gap || baselineJump) flush();
    }
    cur.push(c);
    if (!main || c.size > main.size * 1.05) main = c;
  }
  flush();
  return words;
}

// ---------------------------------------------------------------------------
// 2. lines

interface LineDraft extends Line {
  words: WordDraft[];
  text: string;
  charCount: number;
}

function finishLine(words: WordDraft[]): LineDraft {
  words.sort((a, b) => a.x0 - b.x0);
  const sizes = words.map((w) => w.size);
  const weights = words.map((w) => w.charCount);
  const size = mode(sizes, weights, 0.25) || words[0].size;
  const main = words.filter((w) => Math.abs(w.size - size) < 0.15 * size);
  const baseline = median((main.length ? main : words).map((w) => w.baseline));
  // Oversized words (drop caps) must not stretch the line's crop band over its neighbours;
  // they get a band of their own instead.
  const normal = words.filter((w) => w.size <= size * 1.5);
  for (const w of words)
    if (w.size > size * 1.5) {
      const pad = 0.6 + 0.04 * w.size;
      w.own = { top: w.inkTop - pad, bottom: w.inkBottom + pad, scale: size / w.size };
    } else delete w.own;
  const line: LineDraft = {
    page: -1,
    words,
    x0: Math.min(...words.map((w) => w.x0)),
    x1: Math.max(...words.map((w) => w.hyphen?.x1 ?? w.x1)),
    baseline,
    size,
    inkTop: Math.min(...(normal.length ? normal : words).map((w) => w.inkTop)),
    inkBottom: Math.max(...(normal.length ? normal : words).map((w) => w.inkBottom)),
    bandTop: 0,
    bandBottom: 0,
    mono: words.filter((w) => w.mono).reduce((n, w) => n + w.charCount, 0) > 0.6 * weights.reduce((a, b) => a + b, 0),
    text: words.map((w) => w.text + (w.hyphen ? '-' : '')).join(' '),
    charCount: weights.reduce((a, b) => a + b, 0),
  };
  // Horizontal crop limits: never reach past the midpoint to a neighbour's ink.
  for (let i = 1; i < words.length; i++) {
    const a = words[i - 1], b = words[i];
    const mid = (a.inkX1 + b.inkX0) / 2;
    if (a.hyphen) a.hyphen.cropX1 = Math.min(a.hyphen.cropX1, mid);
    else a.cropX1 = Math.min(a.cropX1, mid);
    b.cropX0 = Math.max(b.cropX0, mid);
  }
  return line;
}

export function buildLines(words: WordDraft[]): LineDraft[] {
  const sorted = [...words].sort((a, b) => a.baseline - b.baseline || a.x0 - b.x0);
  const clusters: WordDraft[][] = [];
  let cur: WordDraft[] = [];
  let ref = 0, refSize = 0;
  for (const w of sorted) {
    if (cur.length && Math.abs(w.baseline - ref) <= 0.25 * Math.max(w.size, refSize)) {
      cur.push(w);
      if (w.size > refSize) (refSize = w.size), (ref = w.baseline);
      continue;
    }
    if (cur.length) clusters.push(cur);
    cur = [w];
    ref = w.baseline;
    refSize = w.size;
  }
  if (cur.length) clusters.push(cur);

  // split clusters horizontally at large gaps (columns, page numbers far right)
  let lines: LineDraft[] = [];
  for (const c of clusters) {
    c.sort((a, b) => a.x0 - b.x0);
    let seg: WordDraft[] = [c[0]];
    for (let i = 1; i < c.length; i++) {
      const gap = c[i].x0 - c[i - 1].x1;
      if (gap > 1.8 * Math.max(c[i].size, c[i - 1].size)) {
        lines.push(finishLine(seg));
        seg = [];
      }
      seg.push(c[i]);
    }
    lines.push(finishLine(seg));
  }

  // merge stray superscript/subscript fragments into the line they belong to
  let merged = true;
  while (merged) {
    merged = false;
    for (const small of lines) {
      if (small.words.length > 3) continue;
      const host = lines.find(
        (h) =>
          h !== small &&
          small.size < h.size * 0.85 &&
          Math.abs(h.baseline - small.baseline) < 0.75 * h.size &&
          small.x0 >= h.x0 - h.size &&
          small.x1 <= h.x1 + h.size,
      );
      if (host) {
        const words = [...host.words, ...small.words];
        lines = lines.filter((l) => l !== small && l !== host);
        lines.push(finishLine(words));
        merged = true;
        break;
      }
    }
  }
  lines = attachDropCaps(lines);
  lines.sort((a, b) => a.baseline - b.baseline || a.x0 - b.x0);
  return lines;
}

/**
 * A drop cap is a big initial letter spanning several lines. Attach it to the first line beside it
 * (as the start of that line's first word) and treat the lines it pushes right as unindented.
 */
function attachDropCaps(lines: LineDraft[]): LineDraft[] {
  const typical = median(lines.map((l) => l.size));
  const caps = lines.flatMap((l) => l.words.filter((w) => w.size > 1.8 * typical && w.text.length <= 2 && /\p{L}/u.test(w.text)));
  for (const w of caps) {
    // take the cap out of whatever line it was clustered into
    const host = lines.find((l) => l.words.includes(w))!;
    lines = lines.filter((l) => l !== host);
    const rest = host.words.filter((x) => x !== w);
    if (rest.length) lines.push(finishLine(rest));
    const beside = lines
      .filter((l) => l.x0 >= w.x1 - 2 && l.x0 - w.x1 < 3 * typical && l.baseline >= w.inkTop - 2 && l.baseline <= w.baseline + 0.5 * typical)
      .sort((a, b) => a.baseline - b.baseline);
    if (!beside.length) {
      lines.push(finishLine([w])); // not a drop cap after all
      continue;
    }
    const target = beside[0];
    w.joinNext = true;
    const merged = finishLine([w, ...target.words]);
    lines = lines.map((l) => (l === target ? merged : l));
    for (const b of beside.slice(1)) b.x0 = w.x0;
  }
  return lines;
}

// ---------------------------------------------------------------------------
// 3. per-page preparation (cached by callers; used for neighbour comparisons)

export interface PreparedPage {
  raw: RawPage;
  lines: LineDraft[];
}

export function preparePage(raw: RawPage): PreparedPage {
  const lines = buildLines(buildWords(raw));
  for (const l of lines) l.page = raw.index;
  return { raw, lines };
}

const PAGE_NUM = /^\s*[([]?\s*(\d{1,4}|[ivxlcdm]{1,7})\s*[)\]]?\s*$/i;
const normalizeFurniture = (s: string) =>
  s
    .toLowerCase()
    .replace(/\b([0-9]+|[ivxlcdm]+)\b/g, '')
    .replace(/[^\p{L}]+/gu, ' ')
    .trim();

function hasPageNumberToken(l: LineDraft): boolean {
  const ws = l.words;
  return PAGE_NUM.test(ws[0].text) || PAGE_NUM.test(ws[ws.length - 1].text);
}

/** Find running headers/footers/page numbers. */
function findFurniture(page: PreparedPage, neighbours: PreparedPage[], bodySize: number): Set<LineDraft> {
  const out = new Set<LineDraft>();
  const lines = [...page.lines].sort((a, b) => a.baseline - b.baseline);
  if (lines.length < 2) return out;
  const H = page.raw.height;

  const repeats = (l: LineDraft, fromTop: boolean) => {
    const key = normalizeFurniture(l.text);
    if (key.length < 3) return false;
    return neighbours.some((n) => {
      const nl = [...n.lines].sort((a, b) => a.baseline - b.baseline);
      const cands = fromTop ? nl.slice(0, 2) : nl.slice(-2);
      return cands.some((c) => Math.abs(c.baseline - l.baseline) < 4 && normalizeFurniture(c.text) === key);
    });
  };

  const check = (l: LineDraft, next: LineDraft | undefined, fromTop: boolean): boolean => {
    if (l.size > bodySize * 1.25) return false;
    const inMargin = fromTop ? l.baseline < H * 0.14 : l.baseline > H * 0.86;
    const gap = next ? Math.abs(next.baseline - l.baseline) : Infinity;
    const isolated = gap > 1.6 * Math.max(l.size, next?.size ?? 0);
    if (PAGE_NUM.test(l.text) && (inMargin || isolated)) return true;
    if (repeats(l, fromTop)) return true;
    if (isolated && inMargin && hasPageNumberToken(l)) return true;
    return false;
  };

  // up to two lines from the top and from the bottom
  for (let i = 0; i < Math.min(2, lines.length - 1); i++) {
    if (check(lines[i], lines[i + 1], true)) out.add(lines[i]);
    else break;
  }
  for (let i = lines.length - 1; i > Math.max(0, lines.length - 3); i--) {
    if (out.has(lines[i])) break;
    if (check(lines[i], lines[i - 1], false)) out.add(lines[i]);
    else break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 4. figures

function findFigures(raw: RawPage, lines: LineDraft[], bodySize: number): { rect: Rect; lines: Set<LineDraft> }[] {
  const pageArea = raw.width * raw.height;
  const s = bodySize || 10;
  type R = { rect: Rect; rule: boolean };
  const cands: R[] = [];
  for (const o of raw.objects) {
    const w = o.rect.x1 - o.rect.x0, h = o.rect.y1 - o.rect.y0;
    if (w * h > pageArea * 0.85 && lines.length >= 3) continue; // background behind real text (or a scan with OCR)
    if (w < 3 && h < 3) continue;
    const rule = o.type === ObjType.Path && (w < 2 || h < 2);
    cands.push({ rect: { ...o.rect }, rule });
  }
  if (!cands.length) return [];

  // cluster touching / nearby objects (union-find)
  const parent = cands.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const near = (a: Rect, b: Rect, d: number) => a.x0 - d <= b.x1 && b.x0 - d <= a.x1 && a.y0 - d <= b.y1 && b.y0 - d <= a.y1;
  for (let i = 0; i < cands.length; i++)
    for (let j = i + 1; j < cands.length; j++) if (near(cands[i].rect, cands[j].rect, 4)) parent[find(i)] = find(j);
  const groups = new Map<number, R[]>();
  cands.forEach((c, i) => {
    const r = find(i);
    groups.set(r, [...(groups.get(r) ?? []), c]);
  });

  const figs: { rect: Rect; lines: Set<LineDraft> }[] = [];
  for (const g of groups.values()) {
    const rect = g.reduce<Rect>(
      (u, c) => ({ x0: Math.min(u.x0, c.rect.x0), y0: Math.min(u.y0, c.rect.y0), x1: Math.max(u.x1, c.rect.x1), y1: Math.max(u.y1, c.rect.y1) }),
      { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity },
    );
    const w = rect.x1 - rect.x0, h = rect.y1 - rect.y0;
    const rules = g.filter((c) => c.rule).length;
    const onlyRules = rules === g.length;
    if (onlyRules && (rules < 4 || w < 3 * s || h < 3 * s)) continue; // separators, underlines
    if (w < 1.2 * s && h < 1.2 * s) continue; // tiny ornaments, inline icons
    if (h < 1.5 * s && !onlyRules) {
      // something line-sized: keep it only if no text line overlaps it (inline decorations stay in text)
      if (lines.some((l) => l.x0 < rect.x1 && l.x1 > rect.x0 && l.inkTop < rect.y1 && l.inkBottom > rect.y0)) continue;
    }
    const inside = new Set<LineDraft>();
    for (const l of lines) {
      const cx = (l.x0 + l.x1) / 2, cy = (l.inkTop + l.inkBottom) / 2;
      if (cx >= rect.x0 - 2 && cx <= rect.x1 + 2 && cy >= rect.y0 - 2 && cy <= rect.y1 + 2) inside.add(l);
    }
    // A box behind ordinary paragraphs (sidebar, shaded note) is decoration, not a figure.
    const insideChars = [...inside].reduce((n, l) => n + l.charCount, 0);
    const proseLike = [...inside].filter((l) => l.x1 - l.x0 > 0.6 * w && l.words.length >= 6).length;
    if (inside.size >= 3 && proseLike >= 0.6 * inside.size && insideChars > 150) continue;
    const full: Rect = { ...rect };
    for (const l of inside) {
      full.x0 = Math.min(full.x0, l.x0);
      full.x1 = Math.max(full.x1, l.x1);
      full.y0 = Math.min(full.y0, l.inkTop);
      full.y1 = Math.max(full.y1, l.inkBottom);
    }
    figs.push({ rect: full, lines: inside });
  }
  return figs;
}

// ---------------------------------------------------------------------------
// 5. reading order (recursive XY-cut)

type Elem = { kind: 'line'; line: LineDraft; r: Rect } | { kind: 'fig'; rect: Rect; r: Rect };

export interface Frame {
  L: number;
  R: number;
  /** the edge is shared by many lines (not just the extreme of a ragged set) */
  strongL?: boolean;
  strongR?: boolean;
}

/** Left / right edge of a text column: the extreme x values shared by many lines. */
export function frameOf(lines: Line[]): Frame | null {
  if (lines.length < 3) return null;
  const minShare = Math.max(3, Math.ceil(lines.length * 0.15));
  let strong = true;
  const pick = (vals: number[], fromLow: boolean) => {
    strong = true;
    const counts = new Map<number, number>();
    for (const v of vals) {
      const k = Math.round(v * 2) / 2;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    // merge near-identical keys (+-1pt)
    const keys = [...counts.keys()].sort((a, b) => (fromLow ? a - b : b - a));
    for (const k of keys) {
      let n = 0;
      for (const [k2, c] of counts) if (Math.abs(k2 - k) <= 1) n += c;
      if (n >= minShare) return k;
    }
    strong = false;
    return fromLow ? Math.min(...vals) : Math.max(...vals);
  };
  const L = pick(lines.map((l) => l.x0), true);
  const strongL = strong;
  const R = pick(lines.map((l) => l.x1), false);
  return { L, R, strongL, strongR: strong };
}

interface Leaf {
  elems: Elem[];
  frame: Frame;
}

function xyCut(elems: Elem[], frame: Frame, s: number, out: Leaf[]) {
  if (elems.length <= 1) {
    if (elems.length) out.push({ elems, frame });
    return;
  }
  // horizontal cuts: bands of whitespace across the whole region
  const byY = [...elems].sort((a, b) => a.r.y0 - b.r.y0);
  const rows: Elem[][] = [];
  let row: Elem[] = [byY[0]];
  let bottom = byY[0].r.y1;
  for (let i = 1; i < byY.length; i++) {
    const e = byY[i];
    if (e.r.y0 - bottom > 0.45 * s) {
      rows.push(row);
      row = [];
    }
    row.push(e);
    bottom = Math.max(bottom, e.r.y1);
  }
  rows.push(row);
  if (rows.length > 1) {
    for (const r of rows) xyCut(r, frame, s, out);
    return;
  }
  // vertical cuts: columns
  const byX = [...elems].sort((a, b) => a.r.x0 - b.r.x0);
  const cols: Elem[][] = [];
  let col: Elem[] = [byX[0]];
  let right = byX[0].r.x1;
  for (let i = 1; i < byX.length; i++) {
    const e = byX[i];
    if (e.r.x0 - right > 1.0 * s) {
      cols.push(col);
      col = [];
    }
    col.push(e);
    right = Math.max(right, e.r.x1);
  }
  cols.push(col);
  if (cols.length > 1) {
    for (const c of cols) {
      const lines = c.filter((e): e is Extract<Elem, { kind: 'line' }> => e.kind === 'line').map((e) => e.line);
      const f = frameOf(lines) ?? {
        L: Math.min(...c.map((e) => e.r.x0)),
        R: Math.max(...c.map((e) => e.r.x1)),
      };
      xyCut(c, f, s, out);
    }
    return;
  }
  out.push({ elems: byY, frame });
}

// ---------------------------------------------------------------------------
// 6. paragraphs

const LIST_MARK = /^([•·▪◦‣∙●○■□–—-]|\(?\d{1,3}[.)]|\(?[a-z][.)]|\(?[ivx]{1,4}[.)])$/i;

function lineIsCentered(l: LineDraft, f: Frame): boolean {
  const s = l.size;
  return Math.abs((l.x0 + l.x1) / 2 - (f.L + f.R) / 2) < 0.6 * s && l.x0 > f.L + 1.5 * s && l.x1 < f.R - 1.5 * s;
}

/** How the line's last word connects to the next line: split word, hyphen, dash, or not at all. */
function endsWithJoiner(l: Line): 'soft' | 'hyphen' | 'dash' | null {
  const w = l.words[l.words.length - 1];
  if (w.hyphen) return w.hyphen.soft ? 'soft' : 'hyphen';
  const last = w.text.codePointAt(w.text.length - 1) ?? 0;
  if (w.text.length > 1 && DASHES.has(last)) return 'dash';
  return null;
}

function segmentParagraphs(
  lines: LineDraft[],
  f: Frame,
  pitchFor: (size: number) => number,
): LineDraft[][] {
  const paras: LineDraft[][] = [];
  let cur: LineDraft[] = [];
  const full = (i: number) => {
    const l = lines[i];
    if (l.x1 >= f.R - 0.6 * l.size) return true;
    // narrower measure (block quote): equal right edges with a neighbour
    const eq = (j: number) => j >= 0 && j < lines.length && Math.abs(lines[j].x1 - l.x1) < 1 && l.x1 - l.x0 > 8 * l.size;
    return eq(i - 1) || eq(i + 1);
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!cur.length) {
      cur.push(l);
      continue;
    }
    const p = lines[i - 1];
    const s = Math.max(l.size, p.size);
    let brk = false;
    // a line ending in a hyphen continues; one ending in a dash may still end a verse line
    const joiner = endsWithJoiner(p);
    const hyphenated = joiner === 'soft' || joiner === 'hyphen';
    if (Math.abs(l.size - p.size) > 0.12 * s) brk = true;
    else if (l.mono !== p.mono) brk = true;
    else if (l.baseline - p.baseline > pitchFor(l.size) * 1.35 + 0.5 || l.baseline < p.baseline) brk = true;
    else if (lineIsCentered(l, f) || lineIsCentered(p, f)) brk = true;
    else if (l.mono && p.mono) brk = false; // code: keep together, lines preserved later
    else {
      // previous line ended early although the next word would have fit -> paragraph end
      const firstW = l.words[0].x1 - l.words[0].x0;
      if (!hyphenated && !full(i - 1) && f.R - p.x1 > firstW + 0.3 * s) brk = true;
      // indented first line
      const next = lines[i + 1];
      const moreIndented = l.x0 - p.x0 > 0.5 * s;
      if (moreIndented) {
        const hanging = cur.length === 1 && LIST_MARK.test(p.words[0].text) && p.words.length > 1 && Math.abs(p.words[1].x0 - l.x0) < 0.5 * s;
        const returns = !next || next.x0 < l.x0 - 0.5 * s || Math.abs(next.x0 - l.x0) < 0.5 * s;
        if (!hanging && returns) {
          // a hanging list continuation looks the same as an indent; only break if p is not a list item line
          const inHangingList = cur.length > 1 && cur.slice(1).every((c) => Math.abs(c.x0 - l.x0) < 0.5 * s);
          if (!inHangingList) brk = true;
        }
      }
      // leaving an indented block (quote, list) after its continuation lines
      if (p.x0 - l.x0 > 0.5 * s && cur.length > 1 && Math.abs(cur[cur.length - 1].x0 - cur[cur.length - 2]?.x0) < 0.5 * s) brk = true;
      // a new list item
      if (LIST_MARK.test(l.words[0].text) && l.words.length > 1 && !hyphenated && !full(i - 1)) brk = true;
    }
    if (brk) {
      paras.push(cur);
      cur = [];
    }
    cur.push(l);
  }
  if (cur.length) paras.push(cur);
  return paras;
}

function describeParagraph(lines: LineDraft[], f: Frame, pitchFor: (s: number) => number, bodySize: number, pageIndex: number, gapBefore: number): ParaBlock {
  const size = mode(lines.map((l) => l.size), lines.map((l) => l.charCount), 0.25) || lines[0].size;
  const pitches: number[] = [];
  for (let i = 1; i < lines.length; i++) pitches.push(lines[i].baseline - lines[i - 1].baseline);
  const pitch = pitches.length ? median(pitches) : pitchFor(size);
  const first = lines[0];
  const rest = lines.slice(1);
  const pre = lines.every((l) => l.mono);
  let align: ParaBlock['align'] = 'left';
  let insetL = 0, insetR = 0, indent = 0;
  if (lines.every((l) => lineIsCentered(l, f))) align = 'center';
  else if (lines.length === 1 && first.x1 >= f.R - 0.6 * first.size && first.x0 > f.L + 3 * first.size && first.x1 - first.x0 < (f.R - f.L) * 0.6)
    align = 'right';
  else {
    if (rest.length) {
      insetL = Math.max(0, Math.min(...rest.map((l) => l.x0)) - f.L);
      indent = first.x0 - f.L - insetL;
      // justified: (almost) every line but the last reaches the same right edge. Allow ~half an em
      // because of optical margin alignment (hyphens and punctuation hang into the margin).
      const bodyLines = lines.slice(0, -1);
      const ends = bodyLines.map((l) => l.x1);
      const maxEnd = Math.max(...ends);
      const near = ends.filter((e) => e >= maxEnd - 0.5 * size).length;
      const justified = bodyLines.length >= 2 && near >= bodyLines.length * 0.75;
      align = justified ? 'justify' : 'left';
      if (justified && maxEnd < f.R - 1.5 * size) insetR = f.R - maxEnd;
    } else {
      indent = Math.max(0, first.x0 - f.L);
    }
  }
  if (pre) {
    insetL = Math.max(0, Math.min(...lines.map((l) => l.x0)) - f.L);
    indent = 0;
    align = 'left';
  }
  const width = f.R - f.L;
  insetL = Math.min(insetL, width * 0.3);
  insetR = Math.min(insetR, width * 0.3);
  indent = Math.max(-insetL, Math.min(indent, width * 0.3));
  return {
    kind: 'para',
    lines,
    align,
    indent,
    insetL,
    insetR,
    colL: f.L,
    colR: f.R,
    size,
    pitch,
    gapBefore,
    heading: size > bodySize * 1.12,
    pre,
    page: pageIndex,
  };
}

// ---------------------------------------------------------------------------
// 7. the page model

/**
 * Analyse one page. `docFrame` is the book's usual text column for pages of this parity;
 * it is used when the page itself has too few full lines to show its edges (poems, short pages).
 */
export function analyzePage(page: PreparedPage, neighbours: PreparedPage[], docFrame: Frame | null = null): PageModel {
  const raw = page.raw;
  const all = page.lines;
  const sizes = all.map((l) => l.size);
  const weights = all.map((l) => l.charCount);
  const bodySize = all.length ? mode(sizes, weights, 0.25) : 0;
  const s = bodySize || 10;

  const furniture = findFurniture(page, neighbours, s);
  let lines = all.filter((l) => !furniture.has(l));
  // Covers, plates and other mostly-picture pages: show the page as one image.
  const pageArea = raw.width * raw.height;
  const pictureArea = raw.objects
    .filter((o) => o.type === ObjType.Image || o.type === ObjType.Form || o.type === ObjType.Shading || (o.type === ObjType.Path && (o.rect.x1 - o.rect.x0) * (o.rect.y1 - o.rect.y0) > pageArea * 0.01))
    .reduce((a, o) => a + (o.rect.x1 - o.rect.x0) * (o.rect.y1 - o.rect.y0), 0);
  const textChars = lines.reduce((n, l) => n + l.charCount, 0);
  if (pictureArea > pageArea * 0.3 && textChars < 250) {
    const r: Rect = { x0: raw.width, y0: raw.height, x1: 0, y1: 0 };
    for (const o of raw.objects) if (o.type !== ObjType.Path || (o.rect.x1 - o.rect.x0) * (o.rect.y1 - o.rect.y0) > pageArea * 0.01) grow(r, o.rect);
    for (const l of lines) grow(r, { x0: l.x0, x1: l.x1, y0: l.inkTop, y1: l.inkBottom });
    const rect = { x0: Math.max(0, r.x0), y0: Math.max(0, r.y0), x1: Math.min(raw.width, r.x1), y1: Math.min(raw.height, r.y1) };
    return { index: raw.index, width: raw.width, height: raw.height, blocks: [{ kind: 'figure', rect, gapBefore: 0, page: raw.index }], furniture: [...furniture], bodySize, contentRect: rect };
  }
  const figures = findFigures(raw, lines, s);
  const inFigure = new Set<LineDraft>();
  for (const f of figures) for (const l of f.lines) inFigure.add(l);
  lines = lines.filter((l) => !inFigure.has(l));

  // typical baseline pitch per font size on this page
  const pitchBySize = new Map<number, number[]>();
  const sortedLines = [...lines].sort((a, b) => a.baseline - b.baseline);
  for (let i = 1; i < sortedLines.length; i++) {
    const a = sortedLines[i - 1], b = sortedLines[i];
    if (Math.abs(a.size - b.size) > 0.05 * a.size) continue;
    if (!(a.x0 < b.x1 && b.x0 < a.x1)) continue;
    const d = b.baseline - a.baseline;
    if (d < 0.9 * a.size || d > 2.5 * a.size) continue;
    const k = Math.round(a.size * 4) / 4;
    pitchBySize.set(k, [...(pitchBySize.get(k) ?? []), d]);
  }
  const pitchFor = (size: number) => {
    const k = Math.round(size * 4) / 4;
    const v = pitchBySize.get(k);
    return v && v.length >= 2 ? median(v) : size * 1.2;
  };

  const elems: Elem[] = [
    ...lines.map((line): Elem => ({ kind: 'line', line, r: { x0: line.x0, x1: line.x1, y0: line.baseline - 0.8 * line.size, y1: line.baseline + 0.25 * line.size } })),
    ...figures.map((f): Elem => ({ kind: 'fig', rect: f.rect, r: f.rect })),
  ];
  const own = frameOf(lines);
  const minX = lines.length ? Math.min(...lines.map((l) => l.x0)) : 0;
  const maxX = lines.length ? Math.max(...lines.map((l) => l.x1)) : raw.width;
  const docFits = docFrame !== null && minX >= docFrame.L - s && maxX <= docFrame.R + s;
  const pageFrame: Frame = {
    L: own?.strongL ? own.L : docFits ? docFrame!.L : own?.L ?? minX,
    R: own?.strongR ? own.R : docFits ? docFrame!.R : own?.R ?? maxX,
  };
  const leaves: Leaf[] = [];
  xyCut(elems, pageFrame, s, leaves);

  // build blocks leaf by leaf
  const blocks: Block[] = [];
  let prevBottomBaseline: number | null = null;
  for (const leaf of leaves) {
    let run: LineDraft[] = [];
    const flushRun = () => {
      if (!run.length) return;
      // crop bands between consecutive lines
      for (let i = 0; i < run.length; i++) {
        const l = run[i];
        const pad = 0.12 * l.size + 0.5;
        l.bandTop = l.inkTop - pad;
        l.bandBottom = l.inkBottom + pad;
        if (i > 0) {
          const p = run[i - 1];
          if (p.bandBottom > l.bandTop) {
            const mid = (p.inkBottom + l.inkTop) / 2;
            p.bandBottom = Math.min(p.bandBottom, Math.max(mid, p.baseline + 0.1 * p.size));
            l.bandTop = Math.max(l.bandTop, Math.min(mid, l.baseline - 0.5 * l.size));
          }
        }
      }
      for (const para of segmentParagraphs(run, leaf.frame, pitchFor)) {
        const gap: number = prevBottomBaseline === null ? pitchFor(para[0].size) : para[0].baseline - prevBottomBaseline;
        blocks.push(describeParagraph(para, leaf.frame, pitchFor, s, raw.index, gap));
        prevBottomBaseline = para[para.length - 1].baseline;
      }
      run = [];
    };
    for (const e of leaf.elems) {
      if (e.kind === 'line') run.push(e.line);
      else {
        flushRun();
        const fig: FigureBlock = { kind: 'figure', rect: e.rect, gapBefore: 0, page: raw.index };
        blocks.push(fig);
        prevBottomBaseline = e.rect.y1 + s; // treat like a line just below the figure
      }
    }
    flushRun();
  }

  // continuation between consecutive leaves (two-column pages)
  for (let i = 1; i < blocks.length; i++) {
    const a = blocks[i - 1], b = blocks[i];
    if (a.kind !== 'para' || b.kind !== 'para') continue;
    if (b.lines[0].baseline < a.lines[a.lines.length - 1].baseline && canContinue(a, b, pageFrame)) {
      a.lines.push(...b.lines);
      blocks.splice(i, 1);
      i--;
    }
  }

  let contentRect: Rect | null = null;
  for (const b of blocks) {
    const r = b.kind === 'figure' ? b.rect : { x0: Math.min(...b.lines.map((l) => l.x0)), x1: Math.max(...b.lines.map((l) => l.x1)), y0: b.lines[0].bandTop, y1: b.lines[b.lines.length - 1].bandBottom };
    contentRect = contentRect ? { x0: Math.min(contentRect.x0, r.x0), y0: Math.min(contentRect.y0, r.y0), x1: Math.max(contentRect.x1, r.x1), y1: Math.max(contentRect.y1, r.y1) } : { ...r };
  }

  // a hyphen glyph in body text, for drawing hyphens where the layout splits words
  let hyphenSample: PageModel['hyphenSample'];
  for (const b of blocks) {
    if (b.kind !== 'para' || b.pre || hyphenSample) continue;
    for (const l of b.lines) {
      const w = l.words[l.words.length - 1];
      if (w.hyphen && Math.abs(l.size - s) < 0.1 * s) {
        const h = w.hyphen;
        hyphenSample = { page: raw.index, x0: h.x0, x1: h.x1, cropX0: Math.max(h.cropX0, h.x0 - 0.3), cropX1: h.cropX1, top: l.bandTop, bottom: l.bandBottom, baseline: l.baseline, size: l.size };
        break;
      }
    }
  }

  return { index: raw.index, width: raw.width, height: raw.height, blocks, furniture: [...furniture], bodySize, contentRect, hyphenSample };
}

/** Can paragraph `b` (top of next column/page) continue paragraph `a`? */
export function canContinue(a: ParaBlock, b: ParaBlock, frameB: Frame | null): boolean {
  if (a.pre !== b.pre) return false;
  if (a.align === 'center' || b.align === 'center' || b.heading || a.heading) return false;
  if (Math.abs(a.size - b.size) > 0.1 * a.size) return false;
  const last = a.lines[a.lines.length - 1];
  const first = b.lines[0];
  // a's last line must run to the right edge of the column (a short final line ends a paragraph)
  const reaches = endsWithJoiner(last) !== null || last.x1 >= a.colR - a.insetR - 0.6 * last.size;
  if (!reaches) return false;
  // b's first line must not be indented
  const L = frameB ? frameB.L : b.colL;
  if (b.indent > 0.5 * b.size) return false;
  if (first.x0 > L + b.insetL + 0.5 * b.size) return false;
  return true;
}

/** Mark paragraphs that run across a page break (call with consecutive pages). */
export function linkPages(prev: PageModel, next: PageModel): void {
  const a = [...prev.blocks].reverse().find((b) => b.kind === 'para') as ParaBlock | undefined;
  const firstBlock = next.blocks[0];
  if (!a || !firstBlock || firstBlock.kind !== 'para') return;
  if (prev.blocks[prev.blocks.length - 1] !== a) return; // a figure ends the page
  if (canContinue(a, firstBlock, null)) {
    a.continuesNext = true;
    firstBlock.continuesPrev = true;
  }
}

/** Typical word-space width relative to font size, measured on unstretched lines. */
export function measureSpaceEm(model: PageModel): number {
  const gaps: number[] = [];
  for (const b of model.blocks) {
    if (b.kind !== 'para' || b.pre || b.lines.length < 2) continue;
    const last = b.lines[b.lines.length - 1]; // last lines of paragraphs are not justified
    for (let i = 1; i < last.words.length; i++) {
      const g = (last.words[i].x0 - last.words[i - 1].x1) / last.size;
      if (g > 0.1 && g < 0.6) gaps.push(g);
    }
  }
  return gaps.length >= 5 ? median(gaps) : 0;
}
