// Messages between the UI thread and the engine worker.

import type { OutlineItem } from './engine/pdfium';
import type { LayoutSettings } from './engine/types';

export type Theme = 'light' | 'sepia' | 'dark';

export const THEMES: Record<Theme, { bg: string; fg: string; ui: string; muted: string }> = {
  light: { bg: '#ffffff', fg: '#1a1a1a', ui: '#f3f3f3', muted: '#777' },
  sepia: { bg: '#f5ecd9', fg: '#3a2e1f', ui: '#ebe0c8', muted: '#8a7a60' },
  dark: { bg: '#141414', fg: '#d4d4d4', ui: '#222', muted: '#888' },
};

export interface OpenResult {
  pageCount: number;
  title: string;
  outline: OutlineItem[];
  pageSizes: { width: number; height: number }[];
}

export interface ChunkRequest {
  page: number;
  settings: LayoutSettings;
  dpr: number;
  theme: Theme;
}

export interface ChunkResult {
  page: number;
  height: number; // CSS px
  anchors: { page: number; y: number; srcY: number }[];
  bitmap: ImageBitmap | null;
}

export interface PageImageRequest {
  page: number;
  width: number; // device px
  theme: Theme;
}

export type Request =
  | { type: 'open'; bytes: ArrayBuffer }
  | { type: 'chunk'; req: ChunkRequest }
  | { type: 'pageImage'; req: PageImageRequest }
  | { type: 'close' };

export type Response = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };
