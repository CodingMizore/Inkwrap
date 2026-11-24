// The reading view: a continuous scroll of reflowed page chunks, painted by the engine worker.

import type { EngineClient } from './engine-client';
import type { OutlineItem } from './engine/pdfium';
import { THEMES, type OpenResult, type Theme } from './protocol';
import { putBook, saveSettings, type BookRecord, type Position, type Settings } from './store';
import { h, sheet } from './ui';

interface ChunkView {
  page: number;
  el: HTMLDivElement;
  canvas: HTMLCanvasElement | null;
  /** last measured height (CSS px); null = never laid out */
  height: number | null;
  /** settings version the height/anchors belong to */
  layoutVersion: number;
  /** settings version of the painted bitmap (-1 = none) */
  paintVersion: number;
  anchors: { page: number; y: number; srcY: number }[];
  near: boolean;
}

export class Reader {
  readonly root: HTMLElement;
  private scroller: HTMLDivElement;
  private column: HTMLDivElement;
  private indicator: HTMLElement;
  private chunks: ChunkView[] = [];
  private version = 0;
  private inflight = false;
  private width = 0;
  private dpr = Math.min(3, window.devicePixelRatio || 1);
  private ratio = 1; // measured height / estimated height
  private pendingRestore: Position | null = null;
  private nearIo: IntersectionObserver;
  private farIo: IntersectionObserver;
  private saveTimer = 0;
  private destroyed = false;
  private resizeTimer = 0;

  constructor(
    private engine: EngineClient,
    private book: BookRecord,
    private info: OpenResult,
    private settings: Settings,
    private onExit: () => void,
  ) {
    this.scroller = h('div', { class: 'reader-scroll' });
    this.column = h('div', { class: 'reader-column' });
    this.scroller.append(this.column);
    this.indicator = h('div', { class: 'page-indicator' });
    const bar = h('header', { class: 'reader-bar' }, [
      h('button', { class: 'icon', 'aria-label': 'Back', onclick: () => this.onExit() }, ['←']),
      h('div', { class: 'title' }, [book.title]),
      info.outline.length ? h('button', { class: 'icon', 'aria-label': 'Contents', onclick: () => this.showContents() }, ['☰']) : '',
      h('button', { class: 'icon', 'aria-label': 'Original page', onclick: () => this.showOriginal() }, ['⧉']),
      h('button', { class: 'icon aa', 'aria-label': 'Text settings', onclick: () => this.showSettings() }, ['Aa']),
    ]);
    this.root = h('div', { class: 'reader' }, [bar, this.scroller, this.indicator]);

    for (let p = 0; p < info.pageCount; p++) {
      const el = h('div', { class: 'chunk' });
      el.dataset.page = String(p);
      this.chunks.push({ page: p, el, canvas: null, height: null, layoutVersion: -1, paintVersion: -1, anchors: [], near: false });
      this.column.append(el);
    }
    const byEl = (el: Element) => this.chunks[Number((el as HTMLElement).dataset.page)];
    this.nearIo = new IntersectionObserver(
      (entries) => {
        for (const e of entries) byEl(e.target).near = e.isIntersecting;
        this.pump();
      },
      { root: this.scroller, rootMargin: '150% 0px' },
    );
    this.farIo = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (!e.isIntersecting) this.release(byEl(e.target));
      },
      { root: this.scroller, rootMargin: '500% 0px' },
    );
    for (const c of this.chunks) {
      this.nearIo.observe(c.el);
      this.farIo.observe(c.el);
    }

    this.scroller.addEventListener('scroll', () => this.onScroll(), { passive: true });
    this.scroller.addEventListener('click', () => this.root.classList.toggle('bars-hidden'));
    window.addEventListener('resize', this.onResize);
  }

  /** Call once the root is in the document. */
  start() {
    this.applyTheme();
    this.measure();
    this.estimateAll();
    const pos = this.book.position;
    if (pos && pos.chunk < this.chunks.length) {
      this.pendingRestore = pos;
      this.jump(pos.chunk, pos.offset);
    }
    this.updateIndicator();
    this.pump();
  }

  destroy() {
    this.destroyed = true;
    this.savePosition(true);
    this.nearIo.disconnect();
    this.farIo.disconnect();
    window.removeEventListener('resize', this.onResize);
    this.root.remove();
  }

  // -------------------------------------------------------------------------
  // geometry

  private measure() {
    this.width = Math.max(200, Math.floor(this.scroller.clientWidth - 2 * this.settings.margin));
    this.column.style.padding = `0 ${this.settings.margin}px`;
  }

  /** Rough height of an unrendered chunk, from the page's size, scaled by what we've measured so far. */
  private estimate(p: number): number {
    const { width, height } = this.info.pageSizes[p] ?? { width: 420, height: 600 };
    const k = this.settings.fontPx / 10;
    const area = width * 0.7 * height * 0.72 * k * k * this.settings.lineSpacing;
    return Math.max(40, (area / this.width) * this.ratio);
  }

  private estimateAll() {
    for (const c of this.chunks) if (c.height === null) c.el.style.height = `${Math.round(this.estimate(c.page))}px`;
  }

  private jump(chunk: number, offset: number) {
    const c = this.chunks[Math.max(0, Math.min(chunk, this.chunks.length - 1))];
    this.scroller.scrollTop = c.el.offsetTop + offset;
  }

  private chunkAt(y: number): ChunkView {
    let lo = 0, hi = this.chunks.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.chunks[mid].el.offsetTop <= y) lo = mid;
      else hi = mid - 1;
    }
    return this.chunks[lo];
  }

  position(): Position {
    const y = this.scroller.scrollTop + 8;
    const c = this.chunkAt(y);
    const offset = y - c.el.offsetTop;
    let page = c.page, srcY = 0;
    if (c.anchors.length) {
      let a = c.anchors[0];
      for (const x of c.anchors) if (x.y <= offset) a = x;
      page = a.page;
      srcY = a.srcY;
    }
    return { chunk: c.page, offset, page, srcY };
  }

  /** Scroll so that (page, srcY) of the original PDF is at the top. */
  goToSource(page: number, srcY: number) {
    for (const ci of [page, page - 1, page - 2]) {
      const c = this.chunks[ci];
      if (!c || c.layoutVersion !== this.version) continue;
      const a = this.bestAnchor(c, page, srcY);
      if (a) {
        this.scroller.scrollTop = c.el.offsetTop + a.y - 8;
        this.pendingRestore = null;
        return;
      }
    }
    this.pendingRestore = { chunk: page, offset: 0, page, srcY };
    this.jump(page, 0);
  }

  private bestAnchor(c: ChunkView, page: number, srcY: number) {
    let best: ChunkView['anchors'][number] | null = null;
    for (const a of c.anchors) if (a.page === page && (a.srcY <= srcY + 1 || !best)) best = a;
    return best;
  }

  // -------------------------------------------------------------------------
  // painting

  private pump() {
    if (this.inflight || this.destroyed) return;
    const top = this.scroller.scrollTop;
    const center = top + this.scroller.clientHeight / 2;
    let pick: ChunkView | null = null;
    let bestD = Infinity;
    for (const c of this.chunks) {
      if (!c.near || c.paintVersion === this.version) continue;
      const mid = c.el.offsetTop + c.el.offsetHeight / 2;
      // prefer what is on screen, then what is below (reading direction)
      const d = Math.abs(mid - center) * (mid < top ? 1.5 : 1);
      if (d < bestD) (bestD = d), (pick = c);
    }
    if (!pick) return;
    const c = pick;
    const v = this.version;
    this.inflight = true;
    this.engine
      .chunk({
        page: c.page,
        dpr: this.dpr,
        theme: this.settings.theme,
        settings: { width: this.width, fontPx: this.settings.fontPx, lineSpacing: this.settings.lineSpacing, justify: this.settings.justify },
      })
      .then((res) => {
        if (v !== this.version || this.destroyed) {
          res.bitmap?.close();
          return;
        }
        this.apply(c, res.height, res.anchors, res.bitmap);
      })
      .catch((err: Error) => {
        console.error(err);
        c.paintVersion = v; // don't retry in a loop
        c.layoutVersion = v;
        c.el.textContent = `⚠ Page ${c.page + 1} could not be displayed: ${err.message}`;
        c.el.classList.add('chunk-error');
      })
      .finally(() => {
        this.inflight = false;
        this.pump();
      });
  }

  private apply(c: ChunkView, height: number, anchors: ChunkView['anchors'], bitmap: ImageBitmap | null) {
    const first = c.height === null;
    c.height = height;
    c.anchors = anchors;
    c.layoutVersion = c.paintVersion = this.version;
    c.el.style.height = `${height}px`;
    if (bitmap) {
      if (!c.canvas) {
        c.canvas = h('canvas', { class: 'chunk-canvas' });
        c.el.append(c.canvas);
      }
      c.canvas.width = bitmap.width;
      c.canvas.height = bitmap.height;
      c.canvas.style.width = `${this.width}px`;
      c.canvas.style.height = `${height}px`;
      c.canvas.getContext('bitmaprenderer')!.transferFromImageBitmap(bitmap);
    } else if (c.canvas) {
      c.canvas.remove();
      c.canvas = null;
    }
    if (first && height > 0) this.updateRatio();
    const r = this.pendingRestore;
    if (r && r.chunk === c.page) {
      const a = this.bestAnchor(c, r.page, r.srcY);
      this.scroller.scrollTop = c.el.offsetTop + (a ? a.y - 8 : r.offset);
      this.pendingRestore = null;
    }
  }

  private updateRatio() {
    let est = 0, real = 0;
    for (const c of this.chunks)
      if (c.height && c.height > 0) {
        real += c.height;
        est += this.estimate(c.page) / this.ratio;
      }
    if (!est) return;
    const r = real / est;
    if (Math.abs(r - this.ratio) / this.ratio > 0.1) {
      this.ratio = r;
      this.estimateAll();
    }
  }

  private release(c: ChunkView) {
    if (!c.canvas) return;
    c.canvas.width = c.canvas.height = 0;
    c.canvas.remove();
    c.canvas = null;
    c.paintVersion = -1;
  }

  /** Settings or size changed: lay everything out again, keeping the reading position. */
  private relayout() {
    const pos = this.position();
    this.version++;
    this.measure();
    for (const c of this.chunks) {
      // keep old heights as estimates, scaled roughly with the font size change
      if (c.height !== null) c.height = null;
    }
    this.ratio = 1;
    this.estimateAll();
    this.pendingRestore = pos;
    this.jump(pos.chunk, 0);
    this.pump();
  }

  private repaint() {
    this.version++;
    for (const c of this.chunks) c.layoutVersion = this.version; // heights stay valid
    this.pump();
  }

  private onResize = () => {
    clearTimeout(this.resizeTimer);
    this.resizeTimer = window.setTimeout(() => {
      const w = Math.floor(this.scroller.clientWidth - 2 * this.settings.margin);
      if (w !== this.width) this.relayout();
    }, 200);
  };

  private lastTop = 0;
  private onScroll() {
    const top = this.scroller.scrollTop;
    const d = top - this.lastTop;
    if (Math.abs(d) > 12) {
      // hide the bars while reading down, bring them back when scrolling up
      this.root.classList.toggle('bars-hidden', d > 0 && top > 80);
      this.lastTop = top;
    }
    this.updateIndicator();
    this.savePosition(false);
    this.pump();
  }

  private updateIndicator() {
    const pos = this.position();
    this.indicator.textContent = `${pos.page + 1} / ${this.info.pageCount}`;
  }

  private savePosition(now: boolean) {
    clearTimeout(this.saveTimer);
    const save = () => {
      this.book.position = this.position();
      void putBook(this.book);
    };
    if (now) save();
    else this.saveTimer = window.setTimeout(save, 800);
  }

  // -------------------------------------------------------------------------
  // panels

  private applyTheme() {
    const t = THEMES[this.settings.theme];
    const s = document.documentElement.style;
    s.setProperty('--bg', t.bg);
    s.setProperty('--fg', t.fg);
    s.setProperty('--ui', t.ui);
    s.setProperty('--muted', t.muted);
    document.querySelector('meta[name=theme-color]')?.setAttribute('content', t.bg);
  }

  private showSettings() {
    const st = this.settings;
    let timer = 0;
    const commit = (layout: boolean) => {
      saveSettings(st);
      render();
      clearTimeout(timer);
      timer = window.setTimeout(() => (layout ? this.relayout() : (this.applyTheme(), this.repaint())), 150);
    };
    const seg = <T,>(label: string, options: [T, string][], get: () => T, set: (v: T) => void, layout = true) =>
      h('div', { class: 'row' }, [
        h('span', { class: 'label' }, [label]),
        h(
          'div',
          { class: 'seg' },
          options.map(([v, text]) =>
            h('button', { class: get() === v ? 'on' : '', onclick: () => (set(v), commit(layout)) }, [text]),
          ),
        ),
      ]);
    const body = h('div', { class: 'settings' });
    const render = () => {
      body.replaceChildren(
        h('div', { class: 'row' }, [
          h('span', { class: 'label' }, ['Text size']),
          h('div', { class: 'seg' }, [
            h('button', { onclick: () => ((st.fontPx = Math.max(12, st.fontPx - 1)), commit(true)) }, ['A−']),
            h('span', { class: 'value' }, [`${st.fontPx}`]),
            h('button', { onclick: () => ((st.fontPx = Math.min(40, st.fontPx + 1)), commit(true)) }, ['A+']),
          ]),
        ]),
        seg('Line spacing', [[1, '1.0'], [1.1, '1.1'], [1.25, '1.25'], [1.4, '1.4']], () => st.lineSpacing, (v) => (st.lineSpacing = v)),
        seg('Margins', [[10, 'Narrow'], [18, 'Normal'], [30, 'Wide']], () => st.margin, (v) => (st.margin = v)),
        seg('Alignment', [[true, 'Justified'], [false, 'Ragged']], () => st.justify, (v) => (st.justify = v)),
        seg<Theme>('Theme', [['light', 'Light'], ['sepia', 'Sepia'], ['dark', 'Dark']], () => st.theme, (v) => (st.theme = v), false),
      );
    };
    render();
    sheet('Text', body);
  }

  private showContents() {
    const close = sheet('Contents', h('div', { class: 'toc' }, this.tocItems(this.info.outline, 0, () => close())));
  }

  private tocItems(items: OutlineItem[], depth: number, close: () => void): HTMLElement[] {
    return items.flatMap((it) => [
      h(
        'button',
        {
          class: 'toc-item',
          style: `padding-left:${16 + depth * 18}px`,
          disabled: it.page < 0,
          onclick: () => {
            close();
            this.goToSource(it.page, it.y ?? 0);
          },
        },
        [h('span', {}, [it.title || '—']), h('span', { class: 'toc-page' }, [it.page >= 0 ? String(it.page + 1) : ''])],
      ),
      ...this.tocItems(it.children, depth + 1, close),
    ]);
  }

  /** The original page, fit to width, with zoom. Closing returns to the same spot in the reflowed text. */
  private showOriginal() {
    const pos = this.position();
    let zoom = 1;
    const scroller = h('div', { class: 'orig-scroll' });
    const pagesEl = h('div', { class: 'orig-pages' });
    scroller.append(pagesEl);
    const label = h('span', { class: 'orig-label' });
    const views: { el: HTMLDivElement; canvas: HTMLCanvasElement | null; zoom: number }[] = [];
    let busy = false;
    const queue = new Set<number>();
    const vw = () => scroller.clientWidth;
    const pageW = () => Math.round(vw() * zoom);
    const layoutPages = () => {
      this.info.pageSizes.forEach((s, i) => {
        views[i].el.style.width = `${pageW()}px`;
        views[i].el.style.height = `${Math.round((pageW() * s.height) / s.width)}px`;
      });
    };
    const drain = () => {
      if (busy || !queue.size) return;
      const i = queue.values().next().value!;
      queue.delete(i);
      const v = views[i];
      if (v.canvas && v.zoom === zoom) return drain();
      busy = true;
      const z = zoom;
      this.engine
        .pageImage({ page: i, width: Math.round(pageW() * this.dpr), theme: this.settings.theme })
        .then((bmp) => {
          if (z !== zoom) return bmp.close();
          v.canvas ??= v.el.appendChild(h('canvas', {}));
          v.canvas.width = bmp.width;
          v.canvas.height = bmp.height;
          v.canvas.getContext('bitmaprenderer')!.transferFromImageBitmap(bmp);
          v.zoom = z;
        })
        .catch(console.error)
        .finally(() => ((busy = false), drain()));
    };
    const io = new IntersectionObserver(
      (es) => {
        for (const e of es) {
          const i = Number((e.target as HTMLElement).dataset.page);
          if (e.isIntersecting) queue.add(i);
          else {
            queue.delete(i);
            const v = views[i];
            if (v.canvas) (v.canvas.remove(), (v.canvas = null));
          }
        }
        drain();
      },
      { root: scroller, rootMargin: '100% 0px' },
    );
    this.info.pageSizes.forEach((_, i) => {
      const el = h('div', { class: 'orig-page' });
      el.dataset.page = String(i);
      pagesEl.append(el);
      views.push({ el, canvas: null, zoom: 0 });
      io.observe(el);
    });
    const topSource = () => {
      const y = scroller.scrollTop + 8;
      let i = 0;
      while (i + 1 < views.length && views[i + 1].el.offsetTop <= y) i++;
      const s = this.info.pageSizes[i];
      return { page: i, srcY: Math.max(0, ((y - views[i].el.offsetTop) / views[i].el.offsetHeight) * s.height) };
    };
    const scrollToSource = (page: number, srcY: number) => {
      const v = views[page];
      const s = this.info.pageSizes[page];
      scroller.scrollTop = v.el.offsetTop + (srcY / s.height) * v.el.offsetHeight - 40;
    };
    const setZoom = (z: number) => {
      const at = topSource();
      zoom = z;
      label.textContent = `${Math.round(z * 100)}%`;
      layoutPages();
      for (const v of views) if (v.canvas) (v.canvas.remove(), (v.canvas = null));
      scrollToSource(at.page, at.srcY);
      queue.clear();
      io.disconnect();
      for (const v of views) io.observe(v.el);
    };
    const overlay = h('div', { class: 'orig' }, [
      h('header', { class: 'reader-bar' }, [
        h('button', { class: 'icon', 'aria-label': 'Back to reflowed text', onclick: () => close() }, ['←']),
        h('div', { class: 'title' }, ['Original page']),
        h('button', { class: 'icon', onclick: () => setZoom(Math.max(1, zoom / 1.5)) }, ['−']),
        label,
        h('button', { class: 'icon', onclick: () => setZoom(Math.min(3.375, zoom * 1.5)) }, ['+']),
      ]),
      scroller,
    ]);
    const close = () => {
      const at = topSource();
      io.disconnect();
      overlay.remove();
      history.back();
      this.goToSource(at.page, at.srcY);
    };
    this.root.append(overlay);
    history.pushState({ overlay: true }, '');
    const onPop = () => {
      if (overlay.isConnected) {
        const at = topSource();
        io.disconnect();
        overlay.remove();
        this.goToSource(at.page, at.srcY);
      }
      window.removeEventListener('popstate', onPop);
    };
    window.addEventListener('popstate', onPop);
    label.textContent = '100%';
    layoutPages();
    scrollToSource(pos.page, pos.srcY);
  }
}
