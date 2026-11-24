// Minimal DOM helpers.

type Child = Node | string | null | undefined | false;
type Attrs = Record<string, string | number | boolean | ((e: Event) => void) | undefined>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, children: Child[] = []): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (typeof v === 'function') el.addEventListener(k.replace(/^on/, ''), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

/**
 * Bottom sheet. Returns a close function. The Android back button closes it
 * (it pushes a history entry).
 */
export function sheet(title: string, body: HTMLElement): () => void {
  let open = true;
  const close = (fromHistory = false) => {
    if (!open) return;
    open = false;
    root.classList.remove('open');
    window.removeEventListener('popstate', onPop);
    setTimeout(() => root.remove(), 200);
    if (!fromHistory) history.back();
  };
  const onPop = () => close(true);
  const root = h('div', { class: 'sheet-root' }, [
    h('div', { class: 'sheet-backdrop', onclick: () => close() }),
    h('div', { class: 'sheet' }, [
      h('div', { class: 'sheet-head' }, [h('span', {}, [title]), h('button', { class: 'icon', 'aria-label': 'Close', onclick: () => close() }, ['✕'])]),
      h('div', { class: 'sheet-body' }, [body]),
    ]),
  ]);
  document.body.append(root);
  history.pushState({ overlay: true }, '');
  window.addEventListener('popstate', onPop);
  requestAnimationFrame(() => root.classList.add('open'));
  return () => close();
}

export function toast(text: string, ms = 3500) {
  const el = h('div', { class: 'toast' }, [text]);
  document.body.append(el);
  setTimeout(() => el.remove(), ms);
}
