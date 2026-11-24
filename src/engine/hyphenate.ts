// Hyphenation points for words, using the TeX (Liang) patterns from the `hyphen` package.

import en from 'hyphen/en-us';

const cache = new Map<string, number[]>();
const LETTER = /\p{L}/u;

/**
 * Char indices i (into Array.from(text)) where the word may be broken before char i.
 * Only the alphabetic core is hyphenated; at least 2 letters stay before and 3 after a break.
 */
export function hyphenPoints(text: string): number[] {
  const hit = cache.get(text);
  if (hit) return hit;
  const chars = Array.from(text);
  let s = 0, e = chars.length;
  while (s < e && !LETTER.test(chars[s])) s++;
  while (e > s && !LETTER.test(chars[e - 1])) e--;
  const core = chars.slice(s, e).join('');
  let out: number[] = [];
  if (core.length >= 5 && !/[^\p{L}'’]/u.test(core) && core !== core.toUpperCase()) {
    const marked = Array.from(en.hyphenateSync(core, { hyphenChar: '­' }));
    let p = 0;
    for (const c of marked) {
      if (c === '­') out.push(s + p);
      else p++;
    }
    out = out.filter((i) => i - s >= 2 && e - i >= 3);
  }
  if (cache.size > 20000) cache.clear();
  cache.set(text, out);
  return out;
}

const STOP = new Set(['the', 'and', 'of', 'to', 'a', 'in', 'that', 'is', 'was', 'he', 'it', 'for', 'with', 'as', 'his', 'on', 'be', 'at', 'by', 'i', 'you', 'not', 'this', 'had', 'but', 'are', 'from', 'her', 'she', 'they', 'which']);

/** Is this sample of words English? (The patterns are English; other languages are left alone.) */
export function looksEnglish(words: string[]): boolean {
  if (words.length < 50) return false;
  let hits = 0;
  for (const w of words) if (STOP.has(w.toLowerCase().replace(/[^\p{L}]/gu, ''))) hits++;
  return hits / words.length > 0.12;
}
