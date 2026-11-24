// End-to-end smoke test: serve dist/, open a PDF in a phone-sized headless Chromium, take screenshots.
//
//   npm run build && npx tsx tools/e2e.ts book.pdf [--out snaps/e2e]

import { chromium, devices } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

const args = process.argv.slice(2);
const pdf = resolve(args[0]);
const outDir = args.includes('--out') ? args[args.indexOf('--out') + 1] : 'snaps/e2e';
await mkdir(outDir, { recursive: true });

const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm' };
const root = resolve('dist');
const server = createServer(async (req, res) => {
  try {
    let pathname = decodeURIComponent(new URL(req.url!, 'http://x').pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';
    const path = join(root, pathname);
    if (!path.startsWith(root)) throw new Error('outside');
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
}).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const port = (server.address() as { port: number }).port;

const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['Pixel 7'] });
const page = await ctx.newPage();
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

const shot = async (name: string) => {
  await page.screenshot({ path: `${outDir}/${name}.png` });
  console.log('screenshot', name);
};
/** The toolbar hides while scrolling down; a tap on the page brings it back. */
const showBars = async () => {
  if (await page.$('.reader.bars-hidden')) await page.mouse.click(200, 450);
  await page.waitForTimeout(300);
};
const waitPainted = (n = 1) => page.waitForFunction((n) => document.querySelectorAll('.chunk-canvas').length >= n, n, { timeout: 30000 });

await page.goto(`http://127.0.0.1:${port}/`);
await shot('1-library-empty');
const chooser = page.waitForEvent('filechooser');
await page.click('button.add');
await (await chooser).setFiles(pdf);
const t0 = Date.now();
await waitPainted(1);
console.log(`first chunk painted after ${Date.now() - t0} ms`);
await page.waitForTimeout(1500);
await shot('2-reader-start');

// scroll a few screens and check painting keeps up
for (let i = 0; i < 6; i++) await page.mouse.wheel(0, 700), await page.waitForTimeout(250);
await page.waitForTimeout(1500);
await shot('3-reader-scrolled');
const pos1 = await page.textContent('.page-indicator');

// settings: bigger text, dark theme
await showBars();
await page.click('button.aa');
await page.waitForTimeout(300);
await shot('4-settings');
for (let i = 0; i < 3; i++) await page.click('.settings .row:first-child button:last-child');
await page.click('text=Dark');
await page.waitForTimeout(400);
await page.click('.sheet-backdrop');
await page.waitForTimeout(2500);
await shot('5-dark-bigger');
const pos2 = await page.textContent('.page-indicator');
console.log(`position before/after relayout: ${pos1} -> ${pos2}`);

// original page view and back
await showBars();
await page.click('[aria-label="Original page"]');
await page.waitForTimeout(2000);
await shot('6-original');
await page.click('[aria-label="Back to reflowed text"]');
await page.waitForTimeout(1500);
console.log('after original view:', await page.textContent('.page-indicator'));

// back to library and reopen: position should persist
await showBars();
await page.click('[aria-label="Back"]');
await page.waitForTimeout(800);
await shot('7-library');
await page.click('button.book');
await waitPainted(1);
await page.waitForTimeout(1500);
console.log('reopened at:', await page.textContent('.page-indicator'));

console.log(errors.length ? `ERRORS:\n${errors.join('\n')}` : 'no page errors');
await browser.close();
server.close();
