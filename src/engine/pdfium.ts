// Thin, platform-neutral wrapper around the PDFium WebAssembly build.
// Works the same in a browser Web Worker and in Node (used by tools/snap.ts).

import type { WrappedPdfiumModule } from '@embedpdf/pdfium';
import { ObjType, type FontInfo, type RawChar, type RawObject, type RawPage, type Rect } from './types';

const FPDF_REVERSE_BYTE_ORDER = 0x10; // render as RGBA instead of BGRA
const FPDFBitmap_BGRA = 4;

export interface OutlineItem {
  title: string;
  page: number; // -1 if unknown
  y: number | null; // y-down position in page points, if given
  children: OutlineItem[];
}

export interface RenderResult {
  width: number;
  height: number;
  data: Uint8ClampedArray; // RGBA
}

type Mat = [number, number, number, number, number, number];

/** Emscripten heap views (present at runtime, missing from the package's typings). */
interface Heaps {
  HEAPU8: Uint8Array;
  HEAP32: Int32Array;
  HEAPF32: Float32Array;
  HEAPF64: Float64Array;
}
const mul = (m: Mat, n: Mat): Mat => [
  m[0] * n[0] + m[1] * n[2],
  m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2],
  m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4],
  m[4] * n[1] + m[5] * n[3] + n[5],
];

export class PdfDoc {
  readonly pageCount: number;
  private pages = new Map<number, { page: number; text: number; box: Rect }>();
  private scratch: number; // 256 bytes of reusable scratch memory
  private closed = false;

  private constructor(
    private m: WrappedPdfiumModule,
    private handle: number,
    private dataPtr: number,
  ) {
    this.pageCount = m.FPDF_GetPageCount(handle);
    this.scratch = m.pdfium.wasmExports.malloc(256);
  }

  /** Open a PDF from bytes. Throws with a readable message on failure. */
  static open(m: WrappedPdfiumModule, bytes: Uint8Array, password = ''): PdfDoc {
    const P = m.pdfium as WrappedPdfiumModule['pdfium'] & Heaps;
    const ptr = P.wasmExports.malloc(bytes.length);
    P.HEAPU8.set(bytes, ptr);
    const handle = m.FPDF_LoadMemDocument(ptr, bytes.length, password);
    if (!handle) {
      const err = m.FPDF_GetLastError();
      P.wasmExports.free(ptr);
      const reasons: Record<number, string> = {
        2: 'file not found or could not be opened',
        3: 'not a PDF or the file is corrupted',
        4: 'password required or incorrect',
        5: 'unsupported security scheme',
        6: 'page not found or content error',
      };
      throw new Error(`Cannot open PDF: ${reasons[err] ?? `error ${err}`}`);
    }
    return new PdfDoc(m, handle, ptr);
  }

  private get P() {
    return this.m.pdfium as WrappedPdfiumModule['pdfium'] & Heaps;
  }
  private f32(i: number) {
    return this.P.HEAPF32[(this.scratch >> 2) + i];
  }
  private f64(i: number) {
    return this.P.HEAPF64[(this.scratch >> 3) + i];
  }

  private load(index: number) {
    let entry = this.pages.get(index);
    if (entry) {
      // refresh LRU position
      this.pages.delete(index);
      this.pages.set(index, entry);
      return entry;
    }
    const m = this.m;
    const page = m.FPDF_LoadPage(this.handle, index);
    if (!page) throw new Error(`Cannot load page ${index + 1}`);
    let box: Rect;
    // FS_RECTF { left, top, right, bottom }
    if (m.FPDF_GetPageBoundingBox(page, this.scratch)) {
      const l = this.f32(0), t = this.f32(1), r = this.f32(2), b = this.f32(3);
      box = { x0: l, y0: b, x1: r, y1: t };
    } else {
      m.FPDF_GetPageSizeByIndexF(this.handle, index, this.scratch);
      box = { x0: 0, y0: 0, x1: this.f32(0), y1: this.f32(1) };
    }
    const text = m.FPDFText_LoadPage(page);
    entry = { page, text, box };
    this.pages.set(index, entry);
    while (this.pages.size > 8) {
      const [oldIndex, old] = this.pages.entries().next().value!;
      m.FPDFText_ClosePage(old.text);
      m.FPDF_ClosePage(old.page);
      this.pages.delete(oldIndex);
    }
    return entry;
  }

  pageSize(index: number): { width: number; height: number } {
    const { box } = this.load(index);
    return { width: box.x1 - box.x0, height: box.y1 - box.y0 };
  }

  /** Extract every character and the bounds of non-text objects. */
  extract(index: number): RawPage {
    const m = this.m;
    const P = this.P;
    const { page, text, box } = this.load(index);
    const width = box.x1 - box.x0;
    const height = box.y1 - box.y0;
    const X = (x: number) => x - box.x0;
    const Y = (y: number) => box.y1 - y;

    const fonts: FontInfo[] = [];
    const fontIndex = new Map<string, number>();
    const fontBuf = P.wasmExports.malloc(512);
    const flagPtr = this.scratch + 128;

    const n = m.FPDFText_CountChars(text);
    const chars: RawChar[] = new Array(n);
    const s = this.scratch;
    for (let i = 0; i < n; i++) {
      const code = m.FPDFText_GetUnicode(text, i);
      const generated = m.FPDFText_IsGenerated(text, i) === 1;
      const hyphen = m.FPDFText_IsHyphen(text, i) === 1;
      m.FPDFText_GetCharOrigin(text, i, s, s + 8);
      const ox = this.f64(0), oy = this.f64(1);
      m.FPDFText_GetCharBox(text, i, s, s + 8, s + 16, s + 24); // left right bottom top (doubles)
      const tl = this.f64(0), tr = this.f64(1), tb = this.f64(2), tt = this.f64(3);
      m.FPDFText_GetLooseCharBox(text, i, s); // FS_RECTF left top right bottom
      const ll = this.f32(0), lt = this.f32(1), lr = this.f32(2), lb = this.f32(3);
      let size = m.FPDFText_GetFontSize(text, i);
      if (!generated && m.FPDFText_GetMatrix(text, i, s)) {
        const det = Math.abs(this.f32(0) * this.f32(3) - this.f32(1) * this.f32(2));
        size *= Math.sqrt(det);
      }
      if (!(size > 0.5) || !isFinite(size)) size = Math.max(1, (lt - lb) / 1.2);

      let font = 0;
      const len = m.FPDFText_GetFontInfo(text, i, fontBuf, 512, flagPtr);
      const name = len > 0 ? P.UTF8ToString(fontBuf) : '';
      const flags = P.HEAP32[flagPtr >> 2];
      const key = name + '|' + flags;
      const known = fontIndex.get(key);
      if (known !== undefined) font = known;
      else {
        const weight = generated ? 400 : m.FPDFText_GetFontWeight(text, i);
        const lname = name.toLowerCase();
        fonts.push({
          name,
          flags,
          mono: (flags & 1) !== 0 || /mono|courier|typewriter|consol|menlo|monaco|code|inconsolata|(cm|sf|ec|lm|tc|tx|qc)tt\d|pcr[rbo]|cousine/.test(lname),
          italic: (flags & 64) !== 0 || /italic|oblique|cmti|-it$|slant/.test(lname),
          bold: weight >= 600 || (flags & 0x40000) !== 0 || /bold|black|heavy|semibold|cmbx|demi/.test(lname),
        });
        font = fonts.length - 1;
        fontIndex.set(key, font);
      }

      chars[i] = {
        code,
        generated,
        hyphen,
        ox: X(ox),
        oy: Y(oy),
        lx0: X(ll),
        lx1: X(lr),
        ly0: Y(lt),
        ly1: Y(lb),
        tx0: X(tl),
        tx1: X(tr),
        ty0: Y(tt),
        ty1: Y(tb),
        size,
        font,
        angle: generated ? 0 : m.FPDFText_GetCharAngle(text, i),
      };
    }
    P.wasmExports.free(fontBuf);

    // Monospace by geometry: every glyph of the font has the same advance (catches code fonts
    // whose names and flags don't say so). Needs a few different letters to be meaningful.
    const adv: number[][] = fonts.map(() => []);
    const letters: Set<number>[] = fonts.map(() => new Set());
    for (const c of chars) {
      if (c.generated || c.code <= 32 || !(c.lx1 > c.lx0)) continue;
      adv[c.font].push((c.lx1 - c.lx0) / c.size);
      if ((c.code >= 65 && c.code <= 90) || (c.code >= 97 && c.code <= 122)) letters[c.font].add(c.code);
    }
    fonts.forEach((f, i) => {
      const a = adv[i].sort((x, y) => x - y);
      if (f.mono || a.length < 12 || letters[i].size < 6) return;
      const lo = a[Math.floor(a.length * 0.05)], hi = a[Math.floor(a.length * 0.95)], med = a[a.length >> 1];
      if ((hi - lo) / med < 0.03) f.mono = true;
    });

    const objects: RawObject[] = [];
    const visit = (holder: number, count: number, getter: (h: number, i: number) => number, mat: Mat | null, depth: number) => {
      for (let i = 0; i < count; i++) {
        const obj = getter(holder, i);
        if (!obj) continue;
        const type = m.FPDFPageObj_GetType(obj) as ObjType;
        if (type === ObjType.Text) continue;
        if (type === ObjType.Form && depth < 6) {
          // Look inside forms: some producers wrap whole pages (text included) in one form.
          const childCount = m.FPDFFormObj_CountObjects(obj);
          let hasText = false;
          for (let c = 0; c < childCount && !hasText; c++) {
            const child = m.FPDFFormObj_GetObject(obj, c);
            if (child && m.FPDFPageObj_GetType(child) === ObjType.Text) hasText = true;
          }
          if (hasText) {
            let fm: Mat = [1, 0, 0, 1, 0, 0];
            if (m.FPDFPageObj_GetMatrix(obj, s)) fm = [this.f32(0), this.f32(1), this.f32(2), this.f32(3), this.f32(4), this.f32(5)];
            visit(obj, childCount, (h, k) => m.FPDFFormObj_GetObject(h, k), mat ? mul(fm, mat) : fm, depth + 1);
            continue;
          }
        }
        if (!m.FPDFPageObj_GetBounds(obj, s, s + 4, s + 8, s + 12)) continue;
        let l = this.f32(0), b = this.f32(1), r = this.f32(2), t = this.f32(3);
        if (mat) {
          const pts = [
            [l, b], [r, b], [l, t], [r, t],
          ].map(([x, y]) => [mat[0] * x + mat[2] * y + mat[4], mat[1] * x + mat[3] * y + mat[5]]);
          l = Math.min(...pts.map((p) => p[0]));
          r = Math.max(...pts.map((p) => p[0]));
          b = Math.min(...pts.map((p) => p[1]));
          t = Math.max(...pts.map((p) => p[1]));
        }
        const rect = {
          x0: Math.max(0, X(l)),
          y0: Math.max(0, Y(t)),
          x1: Math.min(width, X(r)),
          y1: Math.min(height, Y(b)),
        };
        if (rect.x1 <= rect.x0 && rect.y1 <= rect.y0) continue;
        objects.push({ type, rect });
      }
    };
    visit(page, m.FPDFPage_CountObjects(page), (h, i) => m.FPDFPage_GetObject(h, i), null, 0);

    return { index, width, height, chars, fonts, objects };
  }

  /** Render `rect` (y-down page points) at `scale` pixels per point. */
  render(index: number, scale: number, rect: Rect): RenderResult {
    const m = this.m;
    const P = this.P;
    const { page } = this.load(index);
    const w = Math.max(1, Math.ceil((rect.x1 - rect.x0) * scale));
    const h = Math.max(1, Math.ceil((rect.y1 - rect.y0) * scale));
    const bmp = m.FPDFBitmap_CreateEx(w, h, FPDFBitmap_BGRA, 0, 0);
    if (!bmp) throw new Error(`Out of memory rendering ${w}x${h}`);
    try {
      m.FPDFBitmap_FillRect(bmp, 0, 0, w, h, 0xffffffff);
      const mp = this.scratch; // FS_MATRIX: 6 floats
      const cp = this.scratch + 32; // FS_RECTF: left top right bottom
      const F = P.HEAPF32;
      F.set([scale, 0, 0, scale, -rect.x0 * scale, -rect.y0 * scale], mp >> 2);
      F.set([0, 0, w, h], cp >> 2);
      // no FPDF_ANNOT: link borders and similar on-screen annotations would show up as boxes
      m.FPDF_RenderPageBitmapWithMatrix(bmp, page, mp, cp, FPDF_REVERSE_BYTE_ORDER);
      const buf = m.FPDFBitmap_GetBuffer(bmp);
      const stride = m.FPDFBitmap_GetStride(bmp);
      const out = new Uint8ClampedArray(w * h * 4);
      if (stride === w * 4) out.set(P.HEAPU8.subarray(buf, buf + w * h * 4));
      else for (let y = 0; y < h; y++) out.set(P.HEAPU8.subarray(buf + y * stride, buf + y * stride + w * 4), y * w * 4);
      return { width: w, height: h, data: out };
    } finally {
      m.FPDFBitmap_Destroy(bmp);
    }
  }

  private utf16(fn: (buf: number, len: number) => number): string {
    const len = fn(0, 0);
    if (len <= 2) return '';
    const buf = this.P.wasmExports.malloc(len);
    try {
      fn(buf, len);
      return this.P.UTF16ToString(buf);
    } finally {
      this.P.wasmExports.free(buf);
    }
  }

  pageLabel(index: number): string {
    return this.utf16((b, l) => this.m.FPDF_GetPageLabel(this.handle, index, b, l));
  }

  title(): string {
    return this.utf16((b, l) => this.m.FPDF_GetMetaText(this.handle, 'Title', b, l)).trim();
  }

  outline(): OutlineItem[] {
    const m = this.m;
    const seen = new Set<number>();
    const walk = (parent: number, depth: number): OutlineItem[] => {
      const items: OutlineItem[] = [];
      let bm = m.FPDFBookmark_GetFirstChild(this.handle, parent);
      while (bm && !seen.has(bm) && items.length < 2000) {
        seen.add(bm);
        const title = this.utf16((b, l) => m.FPDFBookmark_GetTitle(bm, b, l));
        let dest = m.FPDFBookmark_GetDest(this.handle, bm);
        if (!dest) {
          const action = m.FPDFBookmark_GetAction(bm);
          if (action) dest = m.FPDFAction_GetDest(this.handle, action);
        }
        let page = -1;
        let y: number | null = null;
        if (dest) {
          page = m.FPDFDest_GetDestPageIndex(this.handle, dest);
          const s = this.scratch;
          if (page >= 0 && m.FPDFDest_GetLocationInPage(dest, s, s + 4, s + 8, s + 12, s + 16, s + 20)) {
            const hasY = this.P.HEAP32[(s + 4) >> 2];
            if (hasY) {
              const { box } = this.load(page);
              y = Math.max(0, box.y1 - this.f32(4));
            }
          }
        }
        items.push({ title: title.trim(), page, y, children: depth < 8 ? walk(bm, depth + 1) : [] });
        bm = m.FPDFBookmark_GetNextSibling(this.handle, bm);
      }
      return items;
    };
    return walk(0, 0);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const { page, text } of this.pages.values()) {
      this.m.FPDFText_ClosePage(text);
      this.m.FPDF_ClosePage(page);
    }
    this.pages.clear();
    this.m.FPDF_CloseDocument(this.handle);
    this.P.wasmExports.free(this.dataPtr);
    this.P.wasmExports.free(this.scratch);
  }
}
