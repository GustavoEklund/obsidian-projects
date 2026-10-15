// @vitest-environment jsdom
import { parseCard, type Card, type Comment } from '@oprojects/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dictionaries, setLanguage } from '../src/i18n';
import { click, key, text, texts, typeInto } from './helpers/dom';
import { NOW, createSandbox, makeCard, type Sandbox } from './helpers/sandbox';

const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

const comments = (): Comment[] => [
  { id: 'c1', author: 'Carla', at: ago(3), text: 'I can reproduce it, but only in **Safari**.' },
  {
    id: 'c2',
    author: 'Ana Maria Souza',
    at: ago(1),
    text: 'Found it:\n\n- [x] confirm in the logs\n- [ ] fix in the gateway',
  },
];

const cards = (): Card[] => [
  makeCard('OP-10', { title: 'Has a thread', comments: comments(), rank: 'A' }),
  makeCard('OP-11', { title: 'Quiet card', rank: 'B' }),
  makeCard('OP-12', { title: 'Another quiet card', rank: 'C' }),
];

let sb: Sandbox;
beforeEach(async () => {
  sb = await createSandbox({ cards: cards() });
});
afterEach(() => sb.dispose());

const panel = () => sb.container.querySelector<HTMLElement>('.op-comments')!;
const items = () => [...panel().querySelectorAll<HTMLElement>('.op-comment')];
const input = () => panel().querySelector<HTMLTextAreaElement>('.op-comment-new .op-comment-input')!;
const post = () => panel().querySelector<HTMLButtonElement>('.op-comment-new .op-btn-primary')!;
const editor = () => panel().querySelector<HTMLTextAreaElement>('.op-comment-edit');
const bodies = () => texts(panel(), '.op-comment-body');
const act = (item: HTMLElement, label: string) =>
  item.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const open = async (k: string) => {
  sb.ui.openCard(k);
  await sb.settle();
};
const saved = (k: string) => parseCard(`Cards/${k}.md`, sb.note(k))!;
const submit = async (value: string) => {
  typeInto(input(), value);
  key(input(), 'Enter', { ctrlKey: true });
  await sb.settle(60);
};

describe('the thread', () => {
  it('shows the title with the count, or just the title when there is nothing yet', async () => {
    await open('OP-10');
    expect(text(panel().querySelector('.op-section-title'))).toBe('Comments (2)');
    await open('OP-11');
    expect(text(panel().querySelector('.op-section-title'))).toBe('Comments');
  });

  it('says there are no comments yet', async () => {
    await open('OP-11');
    expect(text(panel().querySelector('.op-comments-empty'))).toBe('No comments yet');
    expect(items()).toHaveLength(0);
  });

  it('lists the comments oldest first, with author, avatar, relative time and rendered text', async () => {
    await open('OP-10');
    expect(items().map((i) => i.dataset.id)).toEqual(['c1', 'c2']);
    expect(texts(panel(), '.op-comment-author')).toEqual(['Carla', 'Ana Maria Souza']);
    expect(texts(panel(), '.op-comment .op-avatar')).toEqual(['CA', 'AS']);
    expect(texts(panel(), '.op-comment-time')).toEqual(['3 days ago', 'yesterday']);
    expect(panel().querySelector('.op-comment-body strong')!.textContent).toBe('Safari');
  });

  it('gives the exact time in the tooltip of the relative one', async () => {
    await open('OP-10');
    const time = panel().querySelector<HTMLElement>('.op-comment-time')!;
    expect(time.title).toBe(new Date(ago(3)).toLocaleString('en'));
  });

  it("renders each comment through the host with the card's path", async () => {
    await open('OP-10');
    const calls = sb.platform.renderMarkdown.mock.calls.filter((c) => c[2] === 'Cards/OP-10.md').map((c) => c[1]);
    expect(calls).toContain(comments()[0]!.text);
    expect(calls).toContain(comments()[1]!.text);
  });

  it('falls back to plain text when a comment cannot be rendered', async () => {
    sb.platform.renderMarkdown.mockRejectedValue(new Error('no renderer'));
    sb.store.apply({
      ...sb.store.get('OP-10')!,
      comments: [{ id: 'c9', author: 'Bo', at: ago(1), text: 'plain **text**' }],
    });
    await open('OP-10');
    expect(bodies()).toEqual(['plain **text**']);
  });

  it('omits the time of a hand-written comment that has none', async () => {
    sb.store.apply({
      ...sb.store.get('OP-10')!,
      comments: [{ id: 'h1', author: 'Bruno', at: '', text: 'written by hand' }],
    });
    await open('OP-10');
    expect(panel().querySelector('.op-comment-time')).toBeNull();
    expect(texts(panel(), '.op-comment-author')).toEqual(['Bruno']);
  });

  it('writes author names and text as text, never as HTML', async () => {
    sb.platform.renderMarkdown.mockImplementation((el, md) => void (el.textContent = md));
    sb.store.apply({
      ...sb.store.get('OP-10')!,
      comments: [{ id: 'x', author: '<img src=x onerror=alert(1)>', at: ago(1), text: '<script>alert(1)</script>' }],
    });
    await open('OP-10');
    expect(panel().querySelector('img, script')).toBeNull();
    expect(text(panel().querySelector('.op-comment-author'))).toBe('<img src=x onerror=alert(1)>');
  });

  it('labels the edit and delete buttons', async () => {
    await open('OP-10');
    expect(act(items()[0]!, 'Edit comment').title).toBe('Edit comment');
    expect(act(items()[0]!, 'Delete comment').classList.contains('op-danger')).toBe(true);
  });

  it('shows the count on the card of the board, and keeps it in step', async () => {
    await open('OP-10');
    expect(text(sb.card('OP-10')!.querySelector('.op-chip-comments'))).toBe('2');
    await submit('third');
    expect(text(sb.card('OP-10')!.querySelector('.op-chip-comments'))).toBe('3');
  });

  it('only rebuilds the thread when the comments themselves change', async () => {
    await open('OP-10');
    const first = items()[0]!;
    sb.platform.renderMarkdown.mockClear();
    sb.store.apply({ ...sb.store.get('OP-10')!, title: 'Renamed', priority: 'highest' });
    await sb.settle();
    expect(items()[0]).toBe(first);
    expect(sb.platform.renderMarkdown).not.toHaveBeenCalled();
    sb.store.apply({
      ...sb.store.get('OP-10')!,
      comments: [...comments(), { id: 'c3', author: 'Bo', at: ago(0), text: 'new one' }],
    });
    await sb.settle();
    expect(items()).toHaveLength(3);
    expect(items()[0]).not.toBe(first);
  });

  it('shows a comment edited elsewhere (the CLI, a sync)', async () => {
    await open('OP-10');
    sb.store.apply({
      ...sb.store.get('OP-10')!,
      comments: [{ ...comments()[0]!, text: 'edited elsewhere' }, comments()[1]!],
    });
    await sb.settle();
    expect(bodies()[0]).toBe('edited elsewhere');
  });

  it('frees the rendered Markdown when the panel closes', async () => {
    await open('OP-10');
    sb.platform.releaseMarkdown.mockClear();
    key(sb.container.querySelector('.op-root')!, 'Escape');
    await sb.settle();
    const released = sb.platform.releaseMarkdown.mock.calls.map((c) => c[0]);
    expect(released.some((el) => (el as HTMLElement).classList.contains('op-comment-list'))).toBe(true);
  });
});

describe('writing a comment', () => {
  beforeEach(() => open('OP-11'));

  it('offers a box with a hint, and a disabled Post button until there is text', () => {
    expect(input().placeholder).toBe('Add a comment…');
    expect(text(panel().querySelector('.op-composer-hint'))).toBe('Ctrl+Enter to post');
    expect(text(post())).toBe('Comment');
    expect(post().disabled).toBe(true);
    typeInto(input(), 'hello');
    expect(post().disabled).toBe(false);
    typeInto(input(), '   \n ');
    expect(post().disabled).toBe(true);
  });

  it('Ctrl+Enter posts it, signed with your name, and writes a callout into the note', async () => {
    await submit('Looks **good**\n\n- [ ] ship');
    expect(saved('OP-11').comments).toMatchObject([{ id: 'n1', author: 'Ana', text: 'Looks **good**\n\n- [ ] ship' }]);
    expect(sb.note('OP-11')).toContain('## Comments');
    expect(sb.note('OP-11')).toContain('> [!comment|n1,');
    expect(items()).toHaveLength(1);
    expect(texts(panel(), '.op-comment-author')).toEqual(['Ana']);
    expect(panel().querySelector('.op-comment-body strong')!.textContent).toBe('good');
  });

  it('Cmd+Enter posts too, but a plain Enter only adds a line', async () => {
    typeInto(input(), 'one');
    const plain = key(input(), 'Enter');
    expect(plain.defaultPrevented).toBe(false);
    await sb.settle();
    expect(items()).toHaveLength(0);
    key(input(), 'Enter', { metaKey: true });
    await sb.settle(60);
    expect(items()).toHaveLength(1);
  });

  it('does not post while an IME composition is in progress', async () => {
    typeInto(input(), 'にほん');
    key(input(), 'Enter', { ctrlKey: true, isComposing: true });
    await sb.settle();
    expect(items()).toHaveLength(0);
  });

  it('the Post button posts', async () => {
    typeInto(input(), 'via button');
    click(post());
    await sb.settle(60);
    expect(items()).toHaveLength(1);
  });

  it('empty or blank text is not posted', async () => {
    key(input(), 'Enter', { ctrlKey: true });
    typeInto(input(), '   ');
    key(input(), 'Enter', { ctrlKey: true });
    click(post());
    await sb.settle();
    expect(items()).toHaveLength(0);
    expect(sb.note('OP-11')).not.toContain('## Comments');
  });

  it('clears the box, keeps the cursor there, and scrolls the new comment into view', async () => {
    await submit('first');
    expect(input().value).toBe('');
    expect(post().disabled).toBe(true);
    expect(document.activeElement).toBe(input());
    const scroll = Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>;
    expect(scroll).toHaveBeenCalledWith({ block: 'nearest' });
    expect(scroll.mock.contexts.at(-1)).toBe(items().at(-1));
  });

  it('adds comments in order', async () => {
    await submit('first');
    await submit('second');
    expect(bodies()).toEqual(['first', 'second']);
    expect(saved('OP-11').comments.map((c) => c.text)).toEqual(['first', 'second']);
  });

  it('a failed post is reported, keeps your text, and can be retried', async () => {
    vi.spyOn(sb.storage, 'modify').mockRejectedValueOnce(new Error('disk full'));
    await submit('precious');
    expect(sb.platform.notify).toHaveBeenCalledWith('Could not save: disk full');
    expect(input().value).toBe('precious');
    expect(post().disabled).toBe(false);
    expect(document.activeElement).toBe(input());
    key(input(), 'Enter', { ctrlKey: true });
    await sb.settle(60);
    expect(items()).toHaveLength(1);
    expect(input().value).toBe('');
  });

  it('autosizes the box as you type', () => {
    Object.defineProperty(input(), 'scrollHeight', { value: 96, configurable: true });
    typeInto(input(), 'a\nb\nc\nd');
    expect(input().style.height).toBe('96px');
  });
});

describe('drafts', () => {
  it('keeps an unsent draft per card', async () => {
    await open('OP-11');
    typeInto(input(), 'half a thought');
    await open('OP-12');
    expect(input().value).toBe('');
    typeInto(input(), 'another draft');
    await open('OP-11');
    expect(input().value).toBe('half a thought');
    expect(post().disabled).toBe(false);
    await open('OP-12');
    expect(input().value).toBe('another draft');
  });

  it('forgets the draft once it is posted', async () => {
    await open('OP-11');
    await submit('sent');
    await open('OP-12');
    await open('OP-11');
    expect(input().value).toBe('');
  });

  it('keeps the draft across updates to the card', async () => {
    await open('OP-11');
    typeInto(input(), 'still here');
    sb.store.apply({ ...sb.store.get('OP-11')!, title: 'Renamed' });
    await sb.settle();
    expect(input().value).toBe('still here');
  });

  it('keeps the draft when a comment from someone else arrives', async () => {
    await open('OP-11');
    typeInto(input(), 'my reply');
    sb.store.apply({ ...sb.store.get('OP-11')!, comments: [{ id: 'z', author: 'Bo', at: ago(0), text: 'hi' }] });
    await sb.settle();
    expect(input().value).toBe('my reply');
    expect(items()).toHaveLength(1);
  });
});

describe('editing a comment', () => {
  beforeEach(() => open('OP-10'));

  it('replaces the text with an editor that has the comment text and the cursor at the end', () => {
    click(act(items()[0]!, 'Edit comment'));
    expect(editor()!.value).toBe(comments()[0]!.text);
    expect(document.activeElement).toBe(editor());
    expect(editor()!.selectionStart).toBe(comments()[0]!.text.length);
    expect(items()[0]!.querySelector('.op-comment-body')).toBeNull();
    expect(texts(items()[0]!, '.op-comment-actions button')).toEqual(['Cancel', 'Save']);
  });

  it('Ctrl+Enter saves it, keeping author and time', async () => {
    click(act(items()[0]!, 'Edit comment'));
    typeInto(editor()!, 'Fixed typo, now **bold**');
    key(editor()!, 'Enter', { ctrlKey: true });
    await sb.settle(60);
    expect(saved('OP-10').comments[0]).toMatchObject({
      id: 'c1',
      author: 'Carla',
      text: 'Fixed typo, now **bold**',
      at: comments()[0]!.at,
    });
    expect(editor()).toBeNull();
    expect(bodies()[0]).toBe('Fixed typo, now bold');
  });

  it('the Save button saves too', async () => {
    click(act(items()[1]!, 'Edit comment'));
    typeInto(editor()!, 'rewritten');
    click(panel().querySelector('.op-comment-actions .op-btn-primary')!);
    await sb.settle(60);
    expect(saved('OP-10').comments[1]!.text).toBe('rewritten');
  });

  it('Escape and Cancel throw the changes away, and Escape does not close the panel', async () => {
    click(act(items()[0]!, 'Edit comment'));
    typeInto(editor()!, 'discard me');
    const outer = vi.fn();
    sb.container.addEventListener('keydown', outer);
    key(editor()!, 'Escape');
    await sb.settle();
    expect(editor()).toBeNull();
    expect(bodies()[0]).toContain('Safari');
    expect(saved('OP-10').comments[0]!.text).toBe(comments()[0]!.text);
    expect(outer).not.toHaveBeenCalled();
    expect(sb.container.querySelector<HTMLElement>('.op-drawer')!.hidden).toBe(false);
    click(act(items()[0]!, 'Edit comment'));
    typeInto(editor()!, 'discard me too');
    click(panel().querySelector('.op-comment-actions .op-btn')!);
    expect(editor()).toBeNull();
    expect(saved('OP-10').comments[0]!.text).toBe(comments()[0]!.text);
  });

  it('saving unchanged or empty text writes nothing', async () => {
    const before = new Map(sb.storage.files);
    click(act(items()[0]!, 'Edit comment'));
    key(editor()!, 'Enter', { ctrlKey: true });
    await sb.settle();
    expect(editor()).toBeNull();
    click(act(items()[0]!, 'Edit comment'));
    typeInto(editor()!, '   ');
    key(editor()!, 'Enter', { ctrlKey: true });
    await sb.settle();
    expect(sb.storage.files).toEqual(before);
    expect(editor()).toBeNull();
  });

  it('only one comment can be edited at a time', () => {
    click(act(items()[0]!, 'Edit comment'));
    click(act(items()[1]!, 'Edit comment'));
    expect(panel().querySelectorAll('.op-comment-edit')).toHaveLength(1);
    expect(bodies()).toHaveLength(1); // the second one is still showing its text
  });

  it('is not disturbed by changes arriving while you edit, and catches up afterwards', async () => {
    click(act(items()[0]!, 'Edit comment'));
    typeInto(editor()!, 'my edit in progress');
    sb.store.apply({
      ...sb.store.get('OP-10')!,
      comments: [...comments(), { id: 'c3', author: 'Bo', at: ago(0), text: 'arrived meanwhile' }],
    });
    await sb.settle();
    expect(editor()!.value).toBe('my edit in progress');
    expect(text(panel().querySelector('.op-section-title'))).toBe('Comments (3)');
    click(panel().querySelector('.op-comment-actions .op-btn')!); // cancel
    await sb.settle();
    expect(items()).toHaveLength(3);
    expect(bodies().at(-1)).toBe('arrived meanwhile');
  });

  it('a failed save is reported, and the thread is rebuilt from what is really saved', async () => {
    vi.spyOn(sb.storage, 'modify').mockRejectedValueOnce(new Error('locked'));
    click(act(items()[0]!, 'Edit comment'));
    typeInto(editor()!, 'will not stick');
    key(editor()!, 'Enter', { ctrlKey: true });
    await sb.settle(60);
    expect(sb.platform.notify).toHaveBeenCalledWith('Could not save: locked');
    expect(editor()).toBeNull();
    expect(bodies()[0]).toContain('Safari');
  });

  it('leaving the card discards the open editor', async () => {
    click(act(items()[0]!, 'Edit comment'));
    await open('OP-11');
    await open('OP-10');
    expect(editor()).toBeNull();
    expect(items()).toHaveLength(2);
  });

  it('autosizes the editor', () => {
    click(act(items()[0]!, 'Edit comment'));
    Object.defineProperty(editor()!, 'scrollHeight', { value: 120, configurable: true });
    typeInto(editor()!, 'long\ntext');
    expect(editor()!.style.height).toBe('120px');
  });
});

describe('deleting a comment', () => {
  beforeEach(() => open('OP-10'));

  it('asks first, then removes just that comment from the thread and the note', async () => {
    click(act(items()[0]!, 'Delete comment'));
    await sb.settle(60);
    expect(sb.platform.confirm).toHaveBeenCalledWith('Delete this comment?', 'Delete');
    expect(items().map((i) => i.dataset.id)).toEqual(['c2']);
    expect(saved('OP-10').comments.map((c) => c.id)).toEqual(['c2']);
    expect(text(panel().querySelector('.op-section-title'))).toBe('Comments (1)');
  });

  it('removing the last one brings back the empty message and drops the section from the note', async () => {
    click(act(items()[0]!, 'Delete comment'));
    await sb.settle(60);
    click(act(items()[0]!, 'Delete comment'));
    await sb.settle(60);
    expect(text(panel().querySelector('.op-comments-empty'))).toBe('No comments yet');
    expect(sb.note('OP-10')).not.toContain('## Comments');
  });

  it('keeps everything when you decline', async () => {
    sb.platform.confirmAnswer = false;
    click(act(items()[0]!, 'Delete comment'));
    await sb.settle(60);
    expect(items()).toHaveLength(2);
    expect(saved('OP-10').comments).toHaveLength(2);
  });

  it('reports a failed delete and keeps the comment', async () => {
    vi.spyOn(sb.storage, 'modify').mockRejectedValueOnce(new Error('read-only'));
    click(act(items()[0]!, 'Delete comment'));
    await sb.settle(60);
    expect(sb.platform.notify).toHaveBeenCalledWith('Could not save: read-only');
    expect(items()).toHaveLength(2);
  });
});

describe('task checkboxes inside a comment', () => {
  beforeEach(() => open('OP-10'));
  const boxes = () => [...items()[1]!.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];

  it('are drawn from the Markdown', () => {
    expect(boxes().map((b) => b.checked)).toEqual([true, false]);
  });

  it('ticking one rewrites just that task in the comment, in the note', async () => {
    const event = click(boxes()[1]!);
    expect(event.defaultPrevented).toBe(true);
    await sb.settle(60);
    expect(saved('OP-10').comments[1]!.text).toBe('Found it:\n\n- [x] confirm in the logs\n- [x] fix in the gateway');
    expect(boxes().map((b) => b.checked)).toEqual([true, true]);
    expect(saved('OP-10').comments[0]!.text).toBe(comments()[0]!.text); // the other comment is untouched
  });

  it('unticking works too', async () => {
    click(boxes()[0]!);
    await sb.settle(60);
    expect(saved('OP-10').comments[1]!.text).toContain('- [ ] confirm in the logs');
  });

  it("ignores a rendered checkbox that is not one of the comment's tasks", async () => {
    sb.platform.renderMarkdown.mockImplementation(
      (el) => void (el.innerHTML = '<input type="checkbox"><input type="checkbox">'),
    );
    sb.store.apply({
      ...sb.store.get('OP-10')!,
      comments: [{ id: 'k', author: 'Bo', at: ago(1), text: 'no tasks in here' }],
    });
    await sb.settle();
    const before = new Map(sb.storage.files);
    click(items()[0]!.querySelector('input[type="checkbox"]')!);
    await sb.settle(60);
    expect(sb.storage.files).toEqual(before);
  });

  it('reports a failed save', async () => {
    vi.spyOn(sb.storage, 'modify').mockRejectedValueOnce(new Error('disk full'));
    click(boxes()[1]!);
    await sb.settle(60);
    expect(sb.platform.notify).toHaveBeenCalledWith('Could not save: disk full');
  });
});

describe('language', () => {
  it('follows the interface language', async () => {
    sb.dispose();
    setLanguage('pt');
    sb = await createSandbox({ cards: cards() });
    await open('OP-10');
    const english = dictionaries.en!;
    expect(text(panel().querySelector('.op-section-title'))).not.toContain(english['comments.title']);
    expect(input().placeholder).not.toBe(english['comment.placeholder']);
    expect(text(post())).not.toBe(english['comment.post']);
  });
});
