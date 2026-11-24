// Library screen: the books you have opened, and a button to add more.

import { deleteBook, listBooks, type BookRecord } from './store';
import { h } from './ui';

export interface LibraryActions {
  open: (id: string) => void;
  add: (file: File) => void;
}

export async function renderLibrary(root: HTMLElement, actions: LibraryActions) {
  const books = await listBooks();
  const input = h('input', { type: 'file', accept: 'application/pdf,.pdf', class: 'hidden' });
  input.addEventListener('change', () => {
    const f = input.files?.[0];
    if (f) actions.add(f);
    input.value = '';
  });
  const progress = (b: BookRecord) => (b.position && b.pageCount ? Math.round(((b.position.page + 1) / b.pageCount) * 100) : 0);
  const list = books.length
    ? h(
        'ul',
        { class: 'books' },
        books.map((b) =>
          h('li', {}, [
            h('button', { class: 'book', onclick: () => actions.open(b.id) }, [
              h('span', { class: 'book-title' }, [b.title]),
              h('span', { class: 'book-meta' }, [`${b.pageCount} pages · ${progress(b)}% read`]),
              h('span', { class: 'bar' }, [h('span', { style: `width:${progress(b)}%` })]),
            ]),
            h(
              'button',
              {
                class: 'icon remove',
                'aria-label': `Remove ${b.title}`,
                onclick: async () => {
                  if (!confirm(`Remove “${b.title}” from the library?`)) return;
                  await deleteBook(b.id);
                  void renderLibrary(root, actions);
                },
              },
              ['✕'],
            ),
          ]),
        ),
      )
    : h('div', { class: 'empty' }, [
        h('p', {}, ['Open a PDF book to start reading.']),
        h('p', { class: 'muted' }, ['Pages are re-wrapped to fit your screen, keeping the book’s own typography. Nothing leaves your phone.']),
      ]);
  root.replaceChildren(
    h('div', { class: 'library' }, [
      h('header', { class: 'lib-head' }, [h('h1', {}, ['Inkwrap']), h('p', { class: 'tagline' }, ['Read PDF books on your phone without zooming'])]),
      list,
      h('button', { class: 'primary add', onclick: () => input.click() }, ['Open PDF']),
      input,
    ]),
  );
}
