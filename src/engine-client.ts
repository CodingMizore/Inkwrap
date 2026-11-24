// Promise-based client for the engine worker.

import type { ChunkRequest, ChunkResult, OpenResult, PageImageRequest, Request, Response } from './protocol';

export class EngineClient {
  private worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  private seq = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor() {
    this.worker.onmessage = (e: MessageEvent<Response>) => {
      const p = this.pending.get(e.data.id);
      if (!p) return;
      this.pending.delete(e.data.id);
      if (e.data.ok) p.resolve(e.data.result);
      else p.reject(new Error(e.data.error));
    };
    this.worker.onerror = (e) => {
      const err = new Error(e.message || 'Engine crashed');
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    };
  }

  private call<T>(msg: Request, transfer: Transferable[] = []): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ ...msg, id }, transfer);
    });
  }

  /** Note: the buffer is transferred (unusable afterwards). */
  open(bytes: ArrayBuffer): Promise<OpenResult> {
    return this.call({ type: 'open', bytes }, [bytes]);
  }
  chunk(req: ChunkRequest): Promise<ChunkResult> {
    return this.call({ type: 'chunk', req });
  }
  pageImage(req: PageImageRequest): Promise<ImageBitmap> {
    return this.call({ type: 'pageImage', req });
  }
  close(): Promise<void> {
    return this.call({ type: 'close' });
  }
}
