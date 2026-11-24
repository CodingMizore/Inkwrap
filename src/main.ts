import './style.css';
import { EngineClient } from './engine-client';
import { renderLibrary } from './library';
import { Reader } from './reader';
import { fileId, getBook, getFile, loadSettings, putBook, putFile, type BookRecord } from './store';
import { h, toast } from './ui';

const app = document.getElementById('app')!;
const engine = new EngineClient();
let reader: Reader | null = null;

function showLibrary() {
  reader?.destroy();
  reader = null;
  void renderLibrary(app, { open: openBook, add: addFile });
}

async function addFile(file: File) {
  try {
    const bytes = await file.arrayBuffer();
    const id = await fileId(bytes);
    if (!(await getBook(id))) {
      await putFile(id, file);
      const title = file.name.replace(/\.pdf$/i, '');
      await putBook({ id, title, fileName: file.name, size: file.size, pageCount: 0, addedAt: Date.now(), openedAt: Date.now() });
    }
    await openBook(id);
  } catch (e) {
    toast(`Could not add the file: ${e instanceof Error ? e.message : e}`);
  }
}

async function openBook(id: string) {
  const loading = h('div', { class: 'loading' }, ['Opening…']);
  app.append(loading);
  try {
    const record = (await getBook(id)) as BookRecord;
    const blob = await getFile(id);
    if (!record || !blob) throw new Error('book not found');
    const info = await engine.open(await blob.arrayBuffer());
    record.pageCount = info.pageCount;
    if (info.title && record.title === record.fileName.replace(/\.pdf$/i, '')) record.title = info.title;
    record.openedAt = Date.now();
    await putBook(record);
    history.pushState({ view: 'reader' }, '');
    reader = new Reader(engine, record, info, loadSettings(), () => history.back());
    app.replaceChildren(reader.root);
    reader.start();
  } catch (e) {
    loading.remove();
    toast(`Could not open the book: ${e instanceof Error ? e.message : e}`);
  }
}

window.addEventListener('popstate', (e) => {
  // overlays inside the reader handle their own entries
  if (reader && !(e.state && (e.state.view === 'reader' || e.state.overlay))) showLibrary();
});

/** Android "Open with": the PDF arrives as a content:// URL that the app's local server can stream. */
async function openFromUrl(url: string) {
  if (!/^(content|file):/.test(url)) return;
  try {
    const { Capacitor } = await import('@capacitor/core');
    const res = await fetch(Capacitor.convertFileSrc(url));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    let name = decodeURIComponent(url.split('/').pop() ?? '').replace(/^.*[:/]/, '');
    if (!/\.pdf$/i.test(name)) name = (name || 'Book') + '.pdf';
    await addFile(new File([blob], name, { type: 'application/pdf' }));
  } catch (e) {
    toast(`Could not open the shared file: ${e instanceof Error ? e.message : e}`);
  }
}

async function setupNative() {
  const { Capacitor } = await import('@capacitor/core');
  if (!Capacitor.isNativePlatform()) return;
  const { App } = await import('@capacitor/app');
  void App.addListener('appUrlOpen', ({ url }) => void openFromUrl(url));
  const launch = await App.getLaunchUrl();
  if (launch?.url) void openFromUrl(launch.url);
}

history.replaceState({ view: 'library' }, '');
showLibrary();
void setupNative();
