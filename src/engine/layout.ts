// Reflow layout: place the original word images into lines that fit the screen.

import { hyphenPoints } from './hyphenate';
import type { Block, ChunkLayout, DrawOp, HyphenSample, LayoutSettings, Line, PageModel, ParaBlock, Word } from './types';

/** Book-wide measurements the layout needs. */
export interface DocMetrics {
  bodySize: number; // pt
  spaceEm: number; // natural word space / font size
  justified: boolean; // the book's text is mostly justified
  /** a hyphen glyph from the book, and whether its language can be hyphenated (null = don't) */
  hyphen: HyphenSample | null;
}

type SepKind = 'glue' | 'soft' | 'hard' | 'join';
/** A piece of a word image: the whole word, or a part between hyphenation cuts. */
interface Box {
  word: Word;
  line: Line;
  x0: number; // advance range (pt)
  x1: number;
  cropX0: number; // crop range (pt)
  cropX1: number;
  w: number; // px, plus the word's own hyphen if that is always shown
  hy: number; // px, hyphen added if a line breaks right after this box
  /** where a hyphen at a break comes from: the word's own glyph, or the book's sample */
  hySrc: 'own' | 'sample' | null;
}

const DASH_END = /[–—―]$/;
const startsLower = (t: string) => /^\p{Ll}/u.test(t);

/** Build the blocks of the chunk that starts at page `p` (merging paragraphs that run across pages). */
export function chunkBlocks(model: (p: number) => PageModel | undefined, p: number): Block[] {
  const m = model(p);
  if (!m) return [];
  const blocks = m.blocks.slice(m.blocks[0]?.kind === 'para' && m.blocks[0].continuesPrev ? 1 : 0);
  const last = blocks[blocks.length - 1];
  if (last?.kind === 'para' && last.continuesNext) {
    const merged: ParaBlock = { ...last, lines: [...last.lines] };
    let cur: ParaBlock = last;
    let q = p + 1;
    while (cur.continuesNext) {
      const next = model(q)?.blocks[0];
      if (!next || next.kind !== 'para' || !next.continuesPrev) break;
      merged.lines.push(...next.lines);
      cur = next;
      // keep chaining only if that paragraph fills the whole next page
      if (model(q)!.blocks.length !== 1) break;
      q++;
    }
    merged.continuesNext = false;
    blocks[blocks.length - 1] = merged;
  }
  return blocks;
}

export function layoutBlocks(blocks: Block[], st: LayoutSettings, doc: DocMetrics): ChunkLayout {
  const docBodySize = doc.bodySize;
  const W = st.width;
  const k = st.fontPx / (docBodySize || 10);
  const ops: DrawOp[] = [];
  const anchors: ChunkLayout['anchors'] = [];
  const bodyP = (docBodySize || 10) * 1.2 * k * st.lineSpacing;

  let y = 0; // bottom of placed content
  let lastBaseline: number | null = null;
  let lastP = bodyP;
  let first = true;

  const anchor = (page: number, yy: number, srcY: number) => {
    const a = anchors[anchors.length - 1];
    if (!a || a.page !== page || srcY > a.srcY + 0.5) anchors.push({ page, y: yy, srcY });
  };

  for (const block of blocks) {
    if (block.kind === 'figure') {
      const fw = block.rect.x1 - block.rect.x0, fh = block.rect.y1 - block.rect.y0;
      const scale = Math.min(k, W / fw);
      const top = first ? 0 : y + 0.6 * bodyP;
      ops.push({ page: block.page, src: block.rect, scale, dx: (W - fw * scale) / 2, dy: top, figure: true });
      anchor(block.page, top, block.rect.y0);
      y = top + fh * scale;
      lastBaseline = null;
      first = false;
      continue;
    }

    if (block.pre) {
      const r = layoutPre(block, W, k, ops, anchor, () => (first ? 0 : lastBaseline === null ? y + 0.6 * bodyP : y + 0.3 * lastP));
      y = r.bottom;
      lastBaseline = null;
      first = false;
      continue;
    }

    const P = block.pitch * k * st.lineSpacing;
    const lines = breakParagraph(block, W, k, doc, st);
    if (!lines.length) continue;
    const above = (ln: PlacedLine) => Math.max(...ln.boxes.map((b) => (b.line.baseline - b.line.bandTop) * k));
    const below = (ln: PlacedLine) => Math.max(...ln.boxes.map((b) => (b.line.bandBottom - b.line.baseline) * k));
    let baseline: number;
    if (first) baseline = Math.max(above(lines[0]), 0.7 * P);
    else if (lastBaseline !== null) {
      const extra = Math.max(0, block.gapBefore - block.pitch) * k;
      baseline = Math.max(lastBaseline + Math.max(P, lastP) + Math.min(extra, 4 * P), y + above(lines[0]));
    } else baseline = y + 0.6 * bodyP + above(lines[0]);

    for (let i = 0; i < lines.length; i++) {
      if (i > 0) baseline += P;
      const ln = lines[i];
      for (const op of ln.ops) ops.push({ ...op, dy: baseline + op.dy });
      const b0 = ln.boxes[0];
      anchor(b0.line.page, baseline - P * 0.8, b0.line.baseline);
    }
    lastBaseline = baseline;
    lastP = P;
    y = baseline + below(lines[lines.length - 1]);
    first = false;
  }
  const height = lastBaseline !== null ? Math.max(y, lastBaseline + 0.3 * lastP) : y;
  return { height: Math.ceil(height), ops, anchors };
}

// ---------------------------------------------------------------------------

interface PlacedLine {
  boxes: Box[];
  /** ops with dy relative to the line's baseline */
  ops: DrawOp[];
}

function breakParagraph(block: ParaBlock, W: number, k: number, doc: DocMetrics, st: LayoutSettings): PlacedLine[] {
  // short paragraphs (1-3 source lines) can't show their alignment; follow the book's
  const justify =
    st.justify &&
    (block.align === 'justify' || (block.align === 'left' && !block.heading && block.lines.length <= 3 && doc.justified));
  const sample = justify ? doc.hyphen : null; // hyphenate justified text when the book allows it
  const boxes: Box[] = [];
  const seps: SepKind[] = [];
  for (const line of block.lines) {
    for (const word of line.words) {
      if (boxes.length) {
        const prev = boxes[boxes.length - 1];
        let kind: SepKind = 'glue';
        if (prev.line !== line) {
          // joining the last word of one source line to the first of the next
          if (prev.word.hyphen) kind = prev.word.hyphen.soft || startsLower(word.text) ? 'soft' : 'hard';
          else if (DASH_END.test(prev.word.text) && prev.word.text.length > 1) kind = 'hard';
        } else if (prev.word.joinNext || word.x0 - (prev.word.hyphen?.x1 ?? prev.word.x1) < 0.08 * word.size) kind = 'join';
        seps.push(kind);
      }
      const scale = k * (word.own?.scale ?? 1);
      // pieces between hyphenation cuts (or just the whole word)
      const cuts: number[] = [];
      if (sample && word.splits && !word.own)
        for (const i of hyphenPoints(word.text)) if (Number.isFinite(word.splits.ink[i - 1])) cuts.push(i - 1);
      const sampleW = sample ? (sample.x1 - sample.x0) * k * (line.size / sample.size) : 0;
      let x0 = word.x0, c0 = word.cropX0;
      cuts.forEach((c) => {
        const x1 = word.splits!.adv[c], c1 = word.splits!.ink[c];
        boxes.push({ word, line, x0, x1, cropX0: c0, cropX1: c1, w: (x1 - x0) * scale, hy: sampleW, hySrc: 'sample' });
        seps.push('soft');
        (x0 = x1), (c0 = c1);
      });
      const hy = word.hyphen ? (word.hyphen.x1 - word.hyphen.x0) * scale : 0;
      boxes.push({ word, line, x0, x1: word.x1, cropX0: c0, cropX1: word.cropX1, w: (word.x1 - x0) * scale, hy, hySrc: word.hyphen ? 'own' : null });
    }
  }
  const n = boxes.length;
  if (!n) return [];
  // the word's own hyphen is always drawn unless it is a soft one joining two halves of a word
  for (let i = 0; i < n; i++) if (boxes[i].hySrc === 'own' && (i === n - 1 || seps[i] !== 'soft')) boxes[i].w += boxes[i].hy;
  const sp = Math.max(0.15, doc.spaceEm || 0.27) * block.size * k;
  const startX = (lineIdx: number) => Math.max(0, (block.insetL + (lineIdx === 0 ? block.indent : 0)) * k);
  const avail = (lineIdx: number) => Math.max(W * 0.4, W - startX(lineIdx) - block.insetR * k);
  const softBreakExtra = (b: number) => (b < n - 1 && seps[b] === 'soft' ? boxes[b].hy : 0);
  const canBreakAfter = (i: number) => i === n - 1 || seps[i] !== 'join';

  // dynamic programming over break points (minimum total badness)
  const best = new Float64Array(n + 1).fill(Infinity);
  const from = new Int32Array(n + 1).fill(-1);
  const endsHy = new Uint8Array(n + 1); // the best line ending here ends with a hyphen
  best[0] = 0;
  for (let b = 0; b < n; b++) {
    if (!canBreakAfter(b)) continue;
    const hyBreak = b < n - 1 && seps[b] === 'soft';
    let width = 0, glue = 0;
    for (let a = b; a >= 0; a--) {
      width += boxes[a].w;
      if (a < b && seps[a] === 'glue') (width += sp), glue++;
      if (a > 0 && !canBreakAfter(a - 1)) continue;
      if (!isFinite(best[a])) continue;
      const lineIdx = a === 0 ? 0 : 1;
      const av = avail(lineIdx);
      const natural = width + softBreakExtra(b);
      const slack = av - natural;
      let cost: number;
      if (slack < 0) {
        const shrinkable = glue * sp * 0.2;
        if (-slack <= shrinkable) cost = 100 * (-slack / shrinkable) ** 2;
        else if (a === b) cost = 5000; // one word wider than the screen: it will be scaled down
        else break; // wider lines only get worse
      } else if (b === n - 1) cost = 0;
      else if (justify) {
        // stretch per space relative to a normal space; a lone word can't be justified at all
        const ratio = glue ? Math.min(slack / (glue * sp), 8) : 8;
        cost = 100 * ratio ** 2;
      } else {
        cost = 100 * ((slack / av) * 3) ** 2; // ragged right: minimise raggedness
      }
      if (hyBreak) cost += boxes[b].hySrc === 'sample' ? 60 : 40;
      if (hyBreak && endsHy[a]) cost += 150; // avoid hyphens on consecutive lines
      cost += 1;
      if (best[a] + cost < best[b + 1]) {
        best[b + 1] = best[a] + cost;
        from[b + 1] = a;
        endsHy[b + 1] = hyBreak ? 1 : 0;
      }
      if (width > av * 1.5) break;
    }
  }
  // recover breaks (fallback: one box per line if the DP failed somehow)
  const ranges: [number, number][] = [];
  if (isFinite(best[n])) {
    for (let e = n; e > 0; ) {
      const a = from[e];
      ranges.push([a, e - 1]);
      e = a;
    }
    ranges.reverse();
  } else for (let i = 0; i < n; i++) ranges.push([i, i]);

  return ranges.map(([a, b], lineIdx) => {
    const av = avail(lineIdx === 0 ? 0 : 1);
    let natural = 0, glue = 0;
    for (let i = a; i <= b; i++) {
      natural += boxes[i].w;
      if (i < b && seps[i] === 'glue') (natural += sp), glue++;
    }
    const lastLine = b === n - 1;
    natural += softBreakExtra(b);
    const slack = av - natural;
    let extra = 0;
    let x = startX(lineIdx === 0 ? 0 : 1);
    let squeeze = 1; // a single over-wide word gets scaled down
    if (slack < 0 && glue) extra = slack / glue;
    else if (slack < 0) squeeze = av / natural;
    else if (justify && !lastLine && glue) {
      extra = slack / glue;
      if (extra > sp * 4) extra = 0; // far too loose: leave ragged
    } else if (block.align === 'center') x += slack / 2;
    else if (block.align === 'right') x += slack;

    const ops: DrawOp[] = [];
    for (let i = a; i <= b; i++) {
      const box = boxes[i];
      const { word, line } = box;
      const s = k * squeeze * (word.own?.scale ?? 1);
      const top = word.own ? word.own.top : line.bandTop;
      const ownHy = box.hySrc === 'own' && (i === b || seps[i] !== 'soft');
      ops.push({
        page: line.page,
        src: { x0: box.cropX0, x1: ownHy ? word.hyphen!.cropX1 : box.cropX1, y0: top, y1: word.own ? word.own.bottom : line.bandBottom },
        scale: s,
        dx: x + (box.cropX0 - box.x0) * s,
        dy: -((word.own ? word.baseline : line.baseline) - top) * s,
      });
      x += box.w * squeeze;
      if (i === b && box.hySrc === 'sample' && sample) {
        // the line breaks inside this word: add the book's own hyphen glyph
        const hs = k * squeeze * (line.size / sample.size);
        ops.push({
          page: sample.page,
          src: { x0: sample.cropX0, x1: sample.cropX1, y0: sample.top, y1: sample.bottom },
          scale: hs,
          dx: x + (sample.cropX0 - sample.x0) * hs,
          dy: -(sample.baseline - sample.top) * hs,
        });
      }
      if (i < b && seps[i] === 'glue') x += sp + extra;
    }
    return { boxes: boxes.slice(a, b + 1), ops };
  });
}

function layoutPre(
  block: ParaBlock,
  W: number,
  k: number,
  ops: DrawOp[],
  anchor: (page: number, y: number, srcY: number) => void,
  topFor: () => number,
): { bottom: number } {
  const wordX1 = (w: Word) => w.hyphen?.cropX1 ?? w.cropX1;
  const lineX1 = (l: Line) => Math.max(...l.words.map(wordX1));
  const x0 = Math.min(...block.lines.map((l) => Math.min(...l.words.map((w) => w.cropX0))));
  const widthPt = Math.max(...block.lines.map(lineX1)) - x0;
  // shrink code to fit the screen, but not below 60% of the text size; wrap what still doesn't fit
  const scale = Math.max(Math.min(k, (W * 0.98) / widthPt), 0.6 * k);
  const offset = Math.max(0, Math.min(block.insetL * k, W - widthPt * scale));
  const wrapIndent = 1.2 * block.size * scale;
  const pitch = block.pitch * scale;
  let baseline = topFor() + (block.lines[0].baseline - block.lines[0].bandTop) * scale;
  let bottom = baseline;
  block.lines.forEach((line: Line, i) => {
    if (i > 0) baseline += Math.max(pitch, (line.baseline - block.lines[i - 1].baseline) * scale);
    const dy = () => baseline - (line.baseline - line.bandTop) * scale;
    anchor(line.page, baseline - block.size * scale, line.baseline);
    if (offset + (lineX1(line) - x0) * scale <= W + 0.5) {
      ops.push({ page: line.page, src: { x0, x1: lineX1(line), y0: line.bandTop, y1: line.bandBottom }, scale, dx: offset, dy: dy() });
    } else {
      // soft-wrap a long code line at token boundaries, continuation lines indented
      let origin = x0, indent = 0;
      line.words.forEach((w, j) => {
        if (j > 0 && offset + indent + (wordX1(w) - origin) * scale > W) {
          baseline += pitch;
          origin = w.cropX0;
          indent = wrapIndent;
        }
        ops.push({ page: line.page, src: { x0: w.cropX0, x1: wordX1(w), y0: line.bandTop, y1: line.bandBottom }, scale, dx: offset + indent + (w.cropX0 - origin) * scale, dy: dy() });
      });
    }
    bottom = baseline + (line.bandBottom - line.baseline) * scale;
  });
  return { bottom };
}
