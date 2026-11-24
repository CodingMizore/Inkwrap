// Engine worker: owns PDFium, analyses pages, lays out and paints chunks off the UI thread.

import { init, type WrappedPdfiumModule } from '@embedpdf/pdfium';
import wasmUrl from '@embedpdf/pdfium/pdfium.wasm?url';
import { PdfDoc } from './engine/pdfium';
import { Book } from './engine/book';
import type { Rect } from './engine/types';
import { THEMES, type ChunkRequest, type ChunkResult, type OpenResult, type PageImageRequest, type Request, type Theme } from './protocol';

let mod: WrappedPdfiumModule | null = null;
let doc: PdfDoc | null = null;
let book: Book | null = null;

const ready = (async () => {
  const wasm = await (await fetch(wasmUrl)).arrayBuffer();
  mod = await init({ wasmBinary: wasm });
  mod.PDFiumExt_Init();
})();

const hex = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));

/** Recolour black-on-white text to the theme's ink and paper. */
function applyTheme(ctx: OffscreenCanvasRenderingContext2D, w: number, h: number, theme: Theme) {
  if (theme === 'light') return;
  const { bg, fg } = THEMES[theme];
  if (theme === 'sepia') {
    // paper colour multiplies white to sepia; ink stays dark
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
  } else {
    // out = bg + (1 - L) * (fg - bg): invert, scale to the ink colour, lift to the paper colour
    const [br, bgc, bb] = hex(bg), [fr, fgc, fb] = hex(fg);
    ctx.globalCompositeOperation = 'difference';
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = `rgb(${fr - br},${fgc - bgc},${fb - bb})`;
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
  }
  ctx.globalCompositeOperation = 'source-over';
}

function renderToCanvas(page: number, scale: number, rect: Rect): OffscreenCanvas {
  const r = doc!.render(page, scale, rect);
  const c = new OffscreenCanvas(r.width, r.height);
  c.getContext('2d')!.putImageData(new ImageData(r.data as Uint8ClampedArray<ArrayBuffer>, r.width, r.height), 0, 0);
  return c;
}

function paintChunk(req: ChunkRequest): ChunkResult {
  const layout = book!.layoutChunk(req.page, req.settings);
  if (!layout.ops.length || layout.height <= 0) return { page: req.page, height: 0, anchors: [], bitmap: null };
  const dpr = req.dpr;
  const W = Math.ceil(req.settings.width * dpr);
  const H = Math.ceil(layout.height * dpr);
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  ctx.imageSmoothingQuality = 'high';

  // one render per (page, scale), then copy word images out of it
  const groups = new Map<string, { page: number; scale: number; rect: Rect; figure: boolean }>();
  for (const op of layout.ops) {
    const key = `${op.page}:${op.scale.toFixed(4)}:${op.figure ? 1 : 0}`;
    const g = groups.get(key);
    if (!g) groups.set(key, { page: op.page, scale: op.scale, rect: { ...op.src }, figure: !!op.figure });
    else {
      g.rect.x0 = Math.min(g.rect.x0, op.src.x0);
      g.rect.y0 = Math.min(g.rect.y0, op.src.y0);
      g.rect.x1 = Math.max(g.rect.x1, op.src.x1);
      g.rect.y1 = Math.max(g.rect.y1, op.src.y1);
    }
  }
  const draw = (figures: boolean) => {
    ctx.globalCompositeOperation = figures ? 'source-over' : 'darken';
    for (const [key, g] of groups) {
      if (g.figure !== figures) continue;
      const s = g.scale * dpr;
      const src = renderToCanvas(g.page, s, g.rect);
      for (const op of layout.ops) {
        if (`${op.page}:${op.scale.toFixed(4)}:${op.figure ? 1 : 0}` !== key) continue;
        const sx = Math.round((op.src.x0 - g.rect.x0) * s), sy = Math.round((op.src.y0 - g.rect.y0) * s);
        const sw = Math.round((op.src.x1 - op.src.x0) * s), sh = Math.round((op.src.y1 - op.src.y0) * s);
        if (sw <= 0 || sh <= 0) continue;
        ctx.drawImage(src, sx, sy, sw, sh, Math.round(op.dx * dpr), Math.round(op.dy * dpr), sw, sh);
      }
    }
  };
  draw(false);
  applyTheme(ctx, W, H, req.theme);
  draw(true);
  return { page: req.page, height: layout.height, anchors: layout.anchors, bitmap: canvas.transferToImageBitmap() };
}

function pageImage(req: PageImageRequest): ImageBitmap {
  const { width, height } = doc!.pageSize(req.page);
  const scale = req.width / width;
  const c = renderToCanvas(req.page, scale, { x0: 0, y0: 0, x1: width, y1: height });
  applyTheme(c.getContext('2d')!, c.width, c.height, req.theme);
  return c.transferToImageBitmap();
}

self.onmessage = async (e: MessageEvent<Request & { id: number }>) => {
  const { id } = e.data;
  try {
    await ready;
    let result: unknown = null;
    const transfer: Transferable[] = [];
    switch (e.data.type) {
      case 'open': {
        book = null;
        doc?.close();
        doc = PdfDoc.open(mod!, new Uint8Array(e.data.bytes));
        book = new Book(doc);
        const pageSizes = [];
        for (let i = 0; i < doc.pageCount; i++) pageSizes.push(doc.pageSize(i));
        result = { pageCount: doc.pageCount, title: doc.title(), outline: doc.outline(), pageSizes } satisfies OpenResult;
        break;
      }
      case 'chunk': {
        const r = paintChunk(e.data.req);
        if (r.bitmap) transfer.push(r.bitmap);
        result = r;
        break;
      }
      case 'pageImage': {
        const b = pageImage(e.data.req);
        transfer.push(b);
        result = b;
        break;
      }
      case 'close':
        book = null;
        doc?.close();
        doc = null;
        break;
    }
    (self as unknown as Worker).postMessage({ id, ok: true, result }, transfer);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
