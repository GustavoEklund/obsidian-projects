// Browser harness: mounts the real BoardUI on top of a real CardService working on in-memory notes.
// Only the Obsidian-specific edges (menu, confirm dialog, markdown, note opening) are simulated.
import { CardService, MemoryStorage, newCardContent } from '@oprojects/core';
import { SAMPLE_CONFIG, sampleCards } from '../../../scripts/sample';
import { CardsHost, type Platform } from '../src/host-impl';
import { setLanguage } from '../src/i18n';
import { CardStore } from '../src/store';
import { BoardUI } from '../src/ui/board';
import type { MenuEntry } from '../src/ui/host';

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function toast(message: string): void {
  const node = Object.assign(document.createElement('div'), { className: 'hx-toast', textContent: message });
  document.body.appendChild(node);
  setTimeout(() => node.remove(), 2400);
}

function closeMenus(): void {
  document.querySelectorAll('.hx-menu').forEach((m) => m.remove());
}

const platform: Platform = {
  openNote: (card, opts) => toast(`openNote(${card.key}${opts?.newTab ? ', newTab' : ''}) → ${card.path}`),
  notify: toast,
  copy: (text) => void navigator.clipboard?.writeText(text).catch(() => undefined),
  confirm: (message, label) =>
    new Promise((resolve) => {
      const done = (v: boolean) => {
        bg.remove();
        resolve(v);
      };
      const bg = document.createElement('div');
      bg.className = 'hx-modal-bg';
      const modal = document.createElement('div');
      modal.className = 'hx-modal';
      modal.textContent = message;
      const actions = document.createElement('div');
      actions.className = 'hx-modal-actions';
      for (const [text, value] of [
        ['Cancel', false],
        [label, true],
      ] as const) {
        const b = document.createElement('button');
        b.textContent = text;
        b.onclick = () => done(value);
        actions.appendChild(b);
      }
      modal.appendChild(actions);
      bg.appendChild(modal);
      document.body.appendChild(bg);
    }),
  menu: (at, entries: MenuEntry[]) => {
    closeMenus();
    const x = 'clientX' in at ? at.clientX : at.x;
    const y = 'clientY' in at ? at.clientY : at.y;
    const menu = document.createElement('div');
    menu.className = 'hx-menu';
    for (const e of entries) {
      if (e.separator) {
        menu.appendChild(document.createElement('hr'));
        continue;
      }
      const b = document.createElement('button');
      if (e.danger) b.className = 'danger';
      const check = Object.assign(document.createElement('span'), {
        className: 'hx-check',
        textContent: e.checked ? '✓' : '',
      });
      b.append(check, e.label ?? '');
      b.onclick = () => {
        closeMenus();
        e.onClick?.();
      };
      menu.appendChild(b);
    }
    menu.style.left = `${Math.min(x, window.innerWidth - 240)}px`;
    menu.style.top = `${Math.min(y, window.innerHeight - 40 - entries.length * 26)}px`;
    document.body.appendChild(menu);
    // Close on a press outside the menu; a press on an item must survive until its click fires.
    const away = (e: PointerEvent) => {
      if ((e.target as Element).closest('.hx-menu')) return;
      closeMenus();
      document.removeEventListener('pointerdown', away, true);
    };
    setTimeout(() => document.addEventListener('pointerdown', away, true));
  },
  releaseMarkdown: () => {},
  // Just enough Markdown to judge the preview tab.
  renderMarkdown: (target, md) => {
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const inline = (s: string) =>
      esc(s)
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/`(.+?)`/g, '<code>$1</code>');
    target.innerHTML = md
      .split('\n')
      .map((line) => {
        const task = /^- \[([ x])\] (.*)$/.exec(line);
        if (task) return `<div><input type="checkbox" ${task[1] === 'x' ? 'checked' : ''}> ${inline(task[2]!)}</div>`;
        const head = /^(#{1,3}) (.*)$/.exec(line);
        if (head) return `<h${head[1]!.length + 1}>${inline(head[2]!)}</h${head[1]!.length + 1}>`;
        return line.trim() ? `<p>${inline(line)}</p>` : '';
      })
      .join('');
  },
};

async function boot() {
  const storage = new MemoryStorage();
  const cards = sampleCards();
  for (const card of cards) await storage.create(card.path, newCardContent(card));
  const store = new CardStore();
  store.replaceAll(cards);
  const service = new CardService(storage, SAMPLE_CONFIG, { snapshot: () => store.all() as typeof cards });
  const host = new CardsHost(store, () => service, platform);

  const pane = el<HTMLDivElement>('pane');
  let ui: BoardUI | null = null;
  let state: unknown;
  const mount = () => {
    ui?.destroy();
    setLanguage(el<HTMLSelectElement>('hx-lang').value);
    ui = new BoardUI(pane, host, state, (s) => (state = s));
    Object.assign(window, { __op: { ui, host, store, service, storage } });
  };

  el<HTMLSelectElement>('hx-theme').onchange = (e) => {
    document.body.className = `theme-${(e.target as HTMLSelectElement).value}`;
  };
  el<HTMLSelectElement>('hx-lang').onchange = mount; // remounts the BoardUI with its saved state
  el<HTMLSelectElement>('hx-width').onchange = (e) => {
    pane.style.width = (e.target as HTMLSelectElement).value;
  };

  // Deep-link controls: ?theme=dark&lang=en&width=520px
  const q = new URLSearchParams(location.search);
  if (q.get('theme')) {
    el<HTMLSelectElement>('hx-theme').value = q.get('theme')!;
    document.body.className = `theme-${q.get('theme')}`;
  }
  if (q.get('lang')) el<HTMLSelectElement>('hx-lang').value = q.get('lang')!;
  if (q.get('width')) {
    el<HTMLSelectElement>('hx-width').value = q.get('width')!;
    pane.style.width = q.get('width')!;
  }
  mount();
}

void boot();
