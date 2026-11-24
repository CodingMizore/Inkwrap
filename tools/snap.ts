// Development tool: run the reflow engine in Node and write PNG previews.
//
//   npx tsx tools/snap.ts book.pdf --pages 10-12 [--screen 392] [--font 18] [--dpr 2] [--out snaps] [--debug]
//
// Writes <out>/reflow-<pages>.png (what the phone would show, as one long strip)
// and with --debug <out>/debug-p<N>.png (original page with analysis overlay).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';
import { createRequire } from 'node:module';
import { init } from '@embedpdf/pdfium';
import { PdfDoc } from '../src/engine/pdfium';
import { Book } from '../src/engine/book';
import type { Rect } from '../src/engine/types';

const args = process.argv.slice(2);
const opt = (name: string, def: string) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : def;
};
const file = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1]?.startsWith('--') !== true) ?? args[0];
const [p0, p1] = opt('pages', '1').split('-').map((x) => parseInt(x, 10) - 1);
const pages = { from: p0, to: Number.isNaN(p1) || p1 === undefined ? p0 : p1 };
const screen = +opt('screen', '392');
const margin = +opt('margin', '18');
const fontPx = +opt('font', '18');
const dpr = +opt('dpr', '2');
const outDir = opt('out', 'snaps');
const debug = args.includes('--debug');
const ragged = args.includes('--ragged');
mkdirSync(outDir, { recursive: true });

// ---------------------------------------------------------------------------
// tiny RGBA image helpers

class Img {
  data: Uint8ClampedArray;
  constructor(public w: number, public h: number) {
    this.data = new Uint8ClampedArray(w * h * 4).fill(255);
  }
  /** copy src region, darken-blend (white never overwrites ink) */
  blit(src: { width: number; height: number; data: Uint8ClampedArray }, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw = sw, dh = sh) {
    for (let y = 0; y < dh; y++) {
      const ty = dy + y;
      if (ty < 0 || ty >= this.h) continue;
      const syy = sy + Math.min(sh - 1, Math.floor((y * sh) / dh));
      if (syy < 0 || syy >= src.height) continue;
      for (let x = 0; x < dw; x++) {
        const tx = dx + x;
        if (tx < 0 || tx >= this.w) continue;
        const sxx = sx + Math.min(sw - 1, Math.floor((x * sw) / dw));
        if (sxx < 0 || sxx >= src.width) continue;
        const si = (syy * src.width + sxx) * 4, di = (ty * this.w + tx) * 4;
        for (let c = 0; c < 3; c++) this.data[di + c] = Math.min(this.data[di + c], src.data[si + c]);
      }
    }
  }
  rect(r: Rect, s: number, color: [number, number, number], fill = false) {
    const x0 = Math.round(r.x0 * s), x1 = Math.round(r.x1 * s), y0 = Math.round(r.y0 * s), y1 = Math.round(r.y1 * s);
    const put = (x: number, y: number, a: number) => {
      if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
      const i = (y * this.w + x) * 4;
      for (let c = 0; c < 3; c++) this.data[i + c] = this.data[i + c] * (1 - a) + color[c] * a;
    };
    if (fill) {
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) put(x, y, 0.18);
      return;
    }
    for (let x = x0; x <= x1; x++) put(x, y0, 1), put(x, y1, 1);
    for (let y = y0; y <= y1; y++) put(x0, y, 1), put(x1, y, 1);
  }
  png(): Buffer {
    const { w, h, data } = this;
    const raw = Buffer.alloc((w * 4 + 1) * h);
    for (let y = 0; y < h; y++) {
      raw[y * (w * 4 + 1)] = 0;
      Buffer.from(data.buffer, y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
    }
    const chunk = (type: string, body: Buffer) => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(body.length);
      const tb = Buffer.concat([Buffer.from(type, 'ascii'), body]);
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(crc32(tb) >>> 0);
      return Buffer.concat([len, tb, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr.set([8, 6, 0, 0, 0], 8);
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  }
}

// ---------------------------------------------------------------------------

const require = createRequire(import.meta.url);
const wasm = readFileSync(require.resolve('@embedpdf/pdfium/pdfium.wasm'));
const m = await init({ wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer });
m.PDFiumExt_Init();
const doc = PdfDoc.open(m, new Uint8Array(readFileSync(file)));
const book = new Book(doc);
if (args.includes('--fonts')) for (let p = pages.from; p <= pages.to; p++) console.log(`page ${p + 1} fonts:`, doc.extract(p).fonts);
console.log(`${file}: ${doc.pageCount} pages, body ${book.bodySize().toFixed(2)}pt, space ${book.spaceEm().toFixed(3)}em`);

const settings = { width: screen - 2 * margin, fontPx, lineSpacing: 1, justify: !ragged };
const chunks = [];
for (let p = pages.from; p <= pages.to; p++) chunks.push({ p, layout: book.layoutChunk(p, settings) });

const totalH = chunks.reduce((h, c) => h + c.layout.height, 0) + 40 * chunks.length;
const img = new Img(screen * dpr, Math.ceil(totalH * dpr));
let top = 0;
const t0 = performance.now();
for (const { p, layout } of chunks) {
  // page separator marker (debug aid): thin grey tick at the left
  img.rect({ x0: 0, x1: 4, y0: top, y1: top + 2 }, dpr, [200, 0, 0], false);
  const groups = new Map<string, { page: number; scale: number; rect: Rect }>();
  for (const op of layout.ops) {
    const key = op.page + ':' + op.scale.toFixed(4);
    const g = groups.get(key);
    if (!g) groups.set(key, { page: op.page, scale: op.scale, rect: { ...op.src } });
    else {
      g.rect.x0 = Math.min(g.rect.x0, op.src.x0);
      g.rect.y0 = Math.min(g.rect.y0, op.src.y0);
      g.rect.x1 = Math.max(g.rect.x1, op.src.x1);
      g.rect.y1 = Math.max(g.rect.y1, op.src.y1);
    }
  }
  for (const [key, g] of groups) {
    const s = g.scale * dpr;
    const bmp = doc.render(g.page, s, g.rect);
    for (const op of layout.ops) {
      if (op.page + ':' + op.scale.toFixed(4) !== key) continue;
      const sx = Math.round((op.src.x0 - g.rect.x0) * s), sy = Math.round((op.src.y0 - g.rect.y0) * s);
      const sw = Math.round((op.src.x1 - op.src.x0) * s), sh = Math.round((op.src.y1 - op.src.y0) * s);
      img.blit(bmp, sx, sy, sw, sh, Math.round((margin + op.dx) * dpr), Math.round((top + op.dy) * dpr));
    }
  }
  top += layout.height + 40;
  console.log(`page ${p + 1}: ${book.model(p)!.blocks.length} blocks -> ${layout.height}px tall (${layout.ops.length} ops)`);
}
console.log(`composited in ${(performance.now() - t0).toFixed(0)} ms`);
const name = `${outDir}/reflow-${pages.from + 1}${pages.to > pages.from ? '-' + (pages.to + 1) : ''}.png`;
writeFileSync(name, img.png());
console.log('wrote', name);

if (debug) {
  for (let p = pages.from; p <= pages.to; p++) {
    const model = book.model(p)!;
    const s = 2;
    const bmp = doc.render(p, s, { x0: 0, y0: 0, x1: model.width, y1: model.height });
    const di = new Img(bmp.width, bmp.height);
    di.data.set(bmp.data);
    const colors: [number, number, number][] = [[0, 120, 255], [0, 170, 0], [230, 120, 0], [150, 0, 200]];
    model.blocks.forEach((b, i) => {
      const c = colors[i % colors.length];
      if (b.kind === 'figure') return di.rect(b.rect, s, [255, 0, 255]);
      for (const l of b.lines) {
        di.rect({ x0: l.x0, x1: l.x1, y0: l.bandTop, y1: l.bandBottom }, s, c, true);
        for (const w of l.words) di.rect({ x0: w.cropX0, x1: w.cropX1, y0: l.bandTop, y1: l.bandBottom }, s, c);
      }
      const first = b.lines[0];
      const flag = `${b.align}${b.pre ? ' pre' : ''}${b.heading ? ' H' : ''}${b.continuesPrev ? ' <cont' : ''}${b.continuesNext ? ' cont>' : ''} ind=${b.indent.toFixed(1)} inL=${b.insetL.toFixed(1)}`;
      console.log(`  p${p + 1} #${i} [${flag}] ${b.lines.length}L "${first.words.slice(0, 6).map((w) => w.text).join(' ')}"`);
    });
    for (const l of model.furniture) di.rect({ x0: l.x0, x1: l.x1, y0: l.inkTop - 1, y1: l.inkBottom + 1 }, s, [255, 0, 0], true);
    writeFileSync(`${outDir}/debug-p${p + 1}.png`, di.png());
  }
}
doc.close();
