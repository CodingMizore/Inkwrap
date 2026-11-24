// Book: lazily analyses pages, links paragraphs across page breaks and lays out chunks.

import type { PdfDoc } from './pdfium';
import { analyzePage, frameOf, linkPages, measureSpaceEm, preparePage, type Frame, type PreparedPage } from './analyze';
import { looksEnglish } from './hyphenate';
import { chunkBlocks, layoutBlocks, type DocMetrics } from './layout';
import type { ChunkLayout, HyphenSample, LayoutSettings, PageModel } from './types';

export class Book {
  private prepared = new Map<number, PreparedPage>();
  private models = new Map<number, PageModel>();
  private body = 0;
  private space = 0;
  private justified: boolean | null = null;
  private frames: [Frame | null, Frame | null] | null = null;
  private hyphen: HyphenSample | null | undefined = undefined;

  constructor(readonly doc: PdfDoc) {}

  get pageCount() {
    return this.doc.pageCount;
  }

  private prep(p: number): PreparedPage {
    let pp = this.prepared.get(p);
    if (!pp) {
      pp = preparePage(this.doc.extract(p));
      pp.raw = { ...pp.raw, chars: [] }; // geometry lives on in words/lines; free the raw chars
      this.prepared.set(p, pp);
    }
    return pp;
  }

  /** Analysis of page p (cached). */
  model(p: number): PageModel | undefined {
    if (p < 0 || p >= this.pageCount) return undefined;
    let m = this.models.get(p);
    if (m) return m;
    const neighbours = [p - 2, p - 1, p + 1, p + 2].filter((q) => q >= 0 && q < this.pageCount).map((q) => this.prep(q));
    m = analyzePage(this.prep(p), neighbours, this.docFrames()[p % 2]);
    this.models.set(p, m);
    const prev = this.models.get(p - 1);
    const next = this.models.get(p + 1);
    if (prev) linkPages(prev, m);
    if (next) linkPages(m, next);
    return m;
  }

  /** The book's usual text column on even / odd pages (margins are often mirrored). */
  docFrames(): [Frame | null, Frame | null] {
    if (this.frames) return this.frames;
    const per: [Frame[], Frame[]] = [[], []];
    for (const p of this.samplePages(12)) {
      const f = frameOf(this.prep(p).lines);
      if (f?.strongL && f.strongR) per[p % 2].push(f);
    }
    const med = (xs: number[]) => xs.sort((a, b) => a - b)[xs.length >> 1];
    const pick = (fs: Frame[]): Frame | null => (fs.length ? { L: med(fs.map((f) => f.L)), R: med(fs.map((f) => f.R)) } : null);
    const even = pick(per[0]), odd = pick(per[1]);
    this.frames = [even ?? odd, odd ?? even];
    return this.frames;
  }

  /** Pages spread through the book, skipping the very start (title pages, contents). */
  private samplePages(n: number): number[] {
    const N = this.pageCount;
    if (N <= n) return [...Array(N).keys()];
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push(Math.floor(N * (0.15 + (0.7 * i) / (n - 1))));
    return out;
  }

  /** Dominant body text size of the whole book (pt). */
  bodySize(): number {
    if (this.body) return this.body;
    const acc = new Map<number, number>();
    for (const p of this.samplePages(9)) {
      for (const l of this.prep(p).lines) {
        const k = Math.round(l.size * 4) / 4;
        acc.set(k, (acc.get(k) ?? 0) + l.charCount);
      }
    }
    let best = 10, bestN = 0;
    for (const [k, n] of acc) if (n > bestN) (best = k), (bestN = n);
    this.body = best;
    return best;
  }

  /** Natural word space of the book's text, in em. */
  spaceEm(): number {
    if (this.space) return this.space;
    const vals = this.samplePages(9)
      .map((p) => measureSpaceEm(this.model(p)!))
      .filter((v) => v > 0)
      .sort((a, b) => a - b);
    this.space = vals.length ? vals[vals.length >> 1] : 0.27;
    return this.space;
  }

  /** Is the book's body text mostly justified (judged on paragraphs of 4+ lines)? */
  isJustified(): boolean {
    if (this.justified !== null) return this.justified;
    let j = 0, r = 0;
    for (const p of this.samplePages(9))
      for (const b of this.model(p)!.blocks)
        if (b.kind === 'para' && !b.pre && b.lines.length >= 4) b.align === 'justify' ? j++ : r++;
    this.justified = j >= r;
    return this.justified;
  }

  /** A hyphen glyph from the book, if its text is English (the only hyphenation patterns bundled). */
  hyphenSample(): HyphenSample | null {
    if (this.hyphen !== undefined) return this.hyphen;
    const pages = this.samplePages(12);
    const words = pages.flatMap((p) => this.prep(p).lines.flatMap((l) => l.words.map((w) => w.text)));
    this.hyphen = null;
    if (looksEnglish(words))
      for (const p of pages) {
        const h = this.model(p)!.hyphenSample;
        if (h) {
          this.hyphen = h;
          break;
        }
      }
    return this.hyphen;
  }

  metrics(): DocMetrics {
    return { bodySize: this.bodySize(), spaceEm: this.spaceEm(), justified: this.isJustified(), hyphen: this.hyphenSample() };
  }

  /** Layout of the content that starts on page p. */
  layoutChunk(p: number, settings: LayoutSettings): ChunkLayout {
    const model = (q: number) => {
      this.model(q + 1); // make sure q is linked to the following page
      return this.model(q);
    };
    return layoutBlocks(chunkBlocks(model, p), settings, this.metrics());
  }
}
