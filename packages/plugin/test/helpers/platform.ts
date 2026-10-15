// The Obsidian-only edges of the board (menu, confirm dialog, Markdown rendering, opening notes) as spies.
import type { MenuEntry } from '../../src/ui/host';
import { vi, type Mock } from 'vitest';
import type { Platform } from '../../src/host-impl';

/** Just enough Markdown to judge the preview: paragraphs, headings, inline code/bold and task checkboxes. */
export function renderMini(target: HTMLElement, markdown: string): void {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const inline = (s: string) =>
    esc(s)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`(.+?)`/g, '<code>$1</code>');
  target.innerHTML = markdown
    .split('\n')
    .map((line) => {
      const task = /^(?:> )?- \[([ x])\] (.*)$/.exec(line);
      if (task) return `<div><input type="checkbox" ${task[1] === 'x' ? 'checked' : ''}> ${inline(task[2]!)}</div>`;
      const head = /^(#{1,3}) (.*)$/.exec(line);
      if (head) return `<h${head[1]!.length + 1}>${inline(head[2]!)}</h${head[1]!.length + 1}>`;
      return line.trim() ? `<p>${inline(line)}</p>` : '';
    })
    .join('');
}

export interface FakePlatform extends Platform {
  openNote: Mock<Platform['openNote']>;
  confirm: Mock<Platform['confirm']>;
  menu: Mock<Platform['menu']>;
  renderMarkdown: Mock<Platform['renderMarkdown']>;
  releaseMarkdown: Mock<Platform['releaseMarkdown']>;
  copy: Mock<Platform['copy']>;
  notify: Mock<Platform['notify']>;
  /** What the next confirmation dialogs answer. */
  confirmAnswer: boolean;
  /** Entries of the most recent context menu. */
  lastMenu(): MenuEntry[];
  /** Click the entry of the most recent menu whose label equals `label` (or matches it). */
  pick(label: string | RegExp): void;
}

export function createPlatform(): FakePlatform {
  const platform: FakePlatform = {
    confirmAnswer: true,
    openNote: vi.fn(),
    confirm: vi.fn(async () => platform.confirmAnswer),
    menu: vi.fn(),
    renderMarkdown: vi.fn((el: HTMLElement, md: string) => renderMini(el, md)),
    releaseMarkdown: vi.fn(),
    copy: vi.fn(),
    notify: vi.fn(),
    lastMenu() {
      const call = platform.menu.mock.calls.at(-1);
      if (!call) throw new Error('No context menu was opened');
      return call[1];
    },
    pick(label) {
      const entry = platform
        .lastMenu()
        .find((e) => (typeof label === 'string' ? e.label === label : !!e.label && label.test(e.label)));
      if (!entry?.onClick)
        throw new Error(
          `No menu entry "${String(label)}" in: ${platform
            .lastMenu()
            .map((e) => e.label ?? '—')
            .join(' | ')}`,
        );
      entry.onClick();
    },
  };
  return platform;
}
