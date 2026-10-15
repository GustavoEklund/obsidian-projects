// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { dictionaries, getLocale, setLanguage, t, timeAgo, type Key } from '../src/i18n';
import { formatDue } from '../src/ui/card-view';
import { click, text, texts } from './helpers/dom';
import { createSandbox, makeCard, type Sandbox } from './helpers/sandbox';

let sb: Sandbox | undefined;
afterEach(() => {
  sb?.dispose();
  sb = undefined;
  setLanguage('en');
});

const en = () => dictionaries.en!;
const pt = () => dictionaries.pt!;

describe('choosing the language', () => {
  it.each([
    ['pt', 'pt'],
    ['pt-BR', 'pt'],
    ['pt_BR', 'pt'],
    ['PT-br', 'pt'],
    ['en', 'en'],
    ['en-GB', 'en'],
    ['xx', 'en'],
    ['', 'en'],
    [null, 'en'],
    [undefined, 'en'],
  ])('%j gives the "%s" interface', (lang, expected) => {
    setLanguage(lang);
    expect(getLocale()).toBe(expected);
  });

  it('can switch back and forth', () => {
    setLanguage('pt');
    expect(t('cancel')).toBe(pt().cancel);
    setLanguage('en');
    expect(t('cancel')).toBe(en().cancel);
  });

  it('falls back to English for a string a language has not translated yet', () => {
    const saved = pt()['comment.hint'];
    delete (pt() as Partial<Record<Key, string>>)['comment.hint'];
    try {
      setLanguage('pt');
      expect(t('comment.hint')).toBe(en()['comment.hint']);
      expect(t('cancel')).toBe(pt().cancel); // everything else is still translated
    } finally {
      pt()['comment.hint'] = saved;
    }
  });

  it('substitutes placeholders in every language', () => {
    for (const lang of ['en', 'pt']) {
      setLanguage(lang);
      const message = t('wip.exceeded', { count: 7, wip: 4 });
      expect(message).toContain('7');
      expect(message).toContain('4');
      expect(message).not.toContain('{');
    }
  });

  it('leaves a placeholder visible rather than printing "undefined"', () => {
    expect(t('delete.confirm', {})).toContain('{key}');
    expect(t('delete.confirm')).toContain('{key}');
  });
});

describe('dates in the active language', () => {
  const now = new Date(2026, 9, 15, 12);

  it('relative times follow the language', () => {
    const ago = new Date(now.getTime() - 3 * 86_400_000).toISOString();
    const english = timeAgo(ago, now);
    setLanguage('pt');
    const portuguese = timeAgo(ago, now);
    expect(english).toBe('3 days ago');
    expect(portuguese).not.toBe(english);
    expect(portuguese).toContain('3');
  });

  it('due dates follow the language', () => {
    const english = formatDue('2026-10-20', now);
    setLanguage('pt');
    expect(formatDue('2026-10-20', now)).not.toBe(english);
  });

  it('reports nothing for a missing or invalid timestamp', () => {
    expect(timeAgo(undefined, now)).toBe('');
    expect(timeAgo('', now)).toBe('');
    expect(timeAgo('garbage', now)).toBe('');
  });

  it.each([
    [30, 'now'], // anything under a minute is just "now"
    [60, '1 minute ago'],
    [5 * 60, '5 minutes ago'],
    [3 * 3600, '3 hours ago'],
    [2 * 86_400, '2 days ago'],
    [14 * 86_400, '2 weeks ago'],
    [75 * 86_400, '2 months ago'],
    [800 * 86_400, '2 years ago'],
  ])('%d seconds back reads "%s"', (seconds, expected) => {
    expect(timeAgo(new Date(now.getTime() - seconds * 1000).toISOString(), now)).toBe(expected);
  });

  it('says "now" for the present moment and speaks of the future in the future tense', () => {
    expect(timeAgo(now.toISOString(), now)).toBe('now');
    expect(timeAgo(new Date(now.getTime() + 3 * 86_400_000).toISOString(), now)).toBe('in 3 days');
  });
});

describe('the whole board in another language', () => {
  it("draws the toolbar, columns, cards and panel with that language's strings, and nothing left in English", async () => {
    setLanguage('pt');
    sb = await createSandbox({
      cards: [
        makeCard('OP-1', {
          title: 'Untranslated user data',
          labels: ['keep-me'],
          comments: [{ id: 'c', author: 'Bo', at: '', text: 'user text' }],
        }),
      ],
    });
    const root = sb.container;
    expect(root.querySelector<HTMLInputElement>('.op-search-input')!.placeholder).toBe(pt()['search.placeholder']);
    expect(texts(root, '.op-toggle')).toEqual([pt()['filter.mine'], pt()['view.epics'], pt()['view.archived']]);
    expect(text(root.querySelector('.op-btn-primary'))).toBe(pt().create);
    expect(root.querySelector('.op-root')!.getAttribute('aria-label')).toBe(pt()['board.title']);
    expect(text(sb.column('review').querySelector('.op-col-empty'))).toBe(pt()['empty.column']);
    expect(sb.card('OP-1')!.querySelector('.op-prio')!.getAttribute('title')).toBe(pt()['priority.medium']);

    sb.ui.openCard('OP-1');
    await sb.settle();
    const drawer = root.querySelector<HTMLElement>('.op-drawer')!;
    expect(texts(drawer, '.op-field-label')).toEqual(
      [
        'field.status',
        'field.priority',
        'field.type',
        'field.assignee',
        'field.labels',
        'field.due',
        'field.estimate',
        'field.epic',
      ].map((k) => pt()[k as Key]),
    );
    expect(text(drawer.querySelector('.op-comment-body'))).toBe('user text'); // user content is never translated
    expect(sb.card('OP-1')!.querySelector('.op-card-title')!.textContent).toBe('Untranslated user data');
  });

  it('menus and notices use the language too', async () => {
    setLanguage('pt');
    sb = await createSandbox({ cards: [makeCard('OP-1')] });
    sb.card('OP-1')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    const labels = sb.platform.lastMenu().map((e) => e.label);
    expect(labels).toContain(pt()['action.open']);
    expect(labels).toContain(pt()['action.delete']);
    sb.platform.pick(pt()['action.copyKey']);
    expect(sb.platform.notify).toHaveBeenCalledWith(pt().copied.replace('{text}', 'OP-1'));
  });

  it('popovers list the types and priorities by their translated names', async () => {
    setLanguage('pt');
    sb = await createSandbox({ cards: [makeCard('OP-1')] });
    click(sb.container.querySelectorAll<HTMLElement>('.op-pill')[1]!);
    expect(texts(document, '.op-pop-label')).toEqual(
      (['type.task', 'type.story', 'type.bug', 'type.epic'] as Key[]).map((k) => pt()[k]),
    );
  });

  it('switching the language and mounting again changes every string', async () => {
    sb = await createSandbox({ cards: [makeCard('OP-1')] });
    expect(sb.container.querySelector<HTMLInputElement>('.op-search-input')!.placeholder).toBe(
      en()['search.placeholder'],
    );
    setLanguage('pt');
    sb.mount();
    expect(sb.container.querySelector<HTMLInputElement>('.op-search-input')!.placeholder).toBe(
      pt()['search.placeholder'],
    );
    setLanguage('en');
    sb.mount();
    expect(sb.container.querySelector<HTMLInputElement>('.op-search-input')!.placeholder).toBe(
      en()['search.placeholder'],
    );
  });
});
