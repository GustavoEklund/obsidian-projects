// @vitest-environment jsdom
import { parseCard, type Card } from '@oprojects/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { change, click, key, text, typeInto } from './helpers/dom';
import { createSandbox, makeCard, renderMini, type Sandbox } from './helpers/sandbox';

const BODY = '\n- [ ] one\n- [x] two\n\nA paragraph with `code`.\n';
const MARKDOWN = '- [ ] one\n- [x] two\n\nA paragraph with `code`.'; // what the editor shows

const cards = (): Card[] => [
  makeCard('OP-2', { title: 'With a body', body: BODY, checklist: { done: 1, total: 2 } }),
  makeCard('OP-3', { title: 'Bare' }),
];

let sb: Sandbox;
let hasFocus: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  sb = await createSandbox({ cards: cards() });
  hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
});
afterEach(() => sb.dispose());

const drawer = () => sb.container.querySelector<HTMLElement>('.op-drawer')!;
const desc = () => drawer().querySelector<HTMLTextAreaElement>('.op-desc')!;
const preview = () => drawer().querySelector<HTMLElement>('.op-preview')!;
const tab = (name: string) =>
  [...drawer().querySelectorAll<HTMLButtonElement>('.op-tab')].find((t) => text(t) === name)!;
const open = async (k: string) => {
  sb.ui.openCard(k);
  await sb.settle();
};
const saved = (k: string) => parseCard(`Cards/${k}.md`, sb.note(k))!;
const boxes = () => [...preview().querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
const editing = () => !desc().hidden && preview().hidden;
const SAVE_DELAY = 700;

describe('reading mode (the default)', () => {
  it('opens on the rendered preview, with the Preview tab selected and no editor', async () => {
    await open('OP-2');
    expect(preview().hidden).toBe(false);
    expect(desc().hidden).toBe(true);
    expect(tab('Preview').classList.contains('is-on')).toBe(true);
    expect(tab('Write').classList.contains('is-on')).toBe(false);
  });

  it('renders the description as Markdown through the host, with the note path for relative links', async () => {
    await open('OP-2');
    expect(sb.platform.renderMarkdown).toHaveBeenCalledTimes(1);
    const [, markdown, path] = sb.platform.renderMarkdown.mock.calls[0]!;
    expect(markdown).toBe(MARKDOWN);
    expect(path).toBe('Cards/OP-2.md');
    expect(boxes()).toHaveLength(2);
    expect(boxes().map((b) => b.checked)).toEqual([false, true]);
    expect(text(preview().querySelector('code'))).toBe('code');
  });

  it('invites you to write when the card has no description', async () => {
    await open('OP-3');
    expect(text(preview().querySelector('.op-preview-empty'))).toBe('Click to add a description…');
    expect(sb.platform.renderMarkdown).not.toHaveBeenCalled();
  });

  it('makes the preview keyboard-reachable and tells you what a click does', async () => {
    await open('OP-2');
    expect(preview().tabIndex).toBe(0);
    expect(preview().getAttribute('role')).toBe('button');
    expect(preview().title).toBe('Click to edit the description');
  });

  it('every card opens in reading mode, even after editing the previous one', async () => {
    await open('OP-2');
    click(preview());
    expect(editing()).toBe(true);
    await open('OP-3');
    expect(editing()).toBe(false);
    expect(preview().hidden).toBe(false);
  });

  it('shows the editor text without the leading blank line the note has after its frontmatter', async () => {
    await open('OP-2');
    expect(desc().value).toBe(MARKDOWN);
  });
});

describe('switching to the editor', () => {
  beforeEach(async () => {
    await open('OP-2');
  });

  it('clicking the text opens the editor with the cursor at the end', () => {
    click(preview().querySelector('p')!);
    expect(editing()).toBe(true);
    expect(document.activeElement).toBe(desc());
    expect([desc().selectionStart, desc().selectionEnd]).toEqual([MARKDOWN.length, MARKDOWN.length]);
    expect(tab('Write').classList.contains('is-on')).toBe(true);
  });

  it('clicking the empty-state hint opens the editor too', async () => {
    await open('OP-3');
    click(preview().querySelector('.op-preview-empty')!);
    expect(editing()).toBe(true);
    expect(document.activeElement).toBe(desc());
  });

  it('the Write tab opens it, and the Preview tab goes back', () => {
    click(tab('Write'));
    expect(editing()).toBe(true);
    expect(document.activeElement).toBe(desc());
    click(tab('Preview'));
    expect(editing()).toBe(false);
    expect(tab('Preview').classList.contains('is-on')).toBe(true);
  });

  it('Enter on the focused preview opens the editor, but Enter inside its content does not', () => {
    key(preview().querySelector('p')!, 'Enter');
    expect(editing()).toBe(false);
    const event = key(preview(), 'Enter');
    expect(event.defaultPrevented).toBe(true);
    expect(editing()).toBe(true);
  });

  it('other keys on the preview do nothing', () => {
    for (const k of [' ', 'a', 'Escape']) key(preview(), k);
    expect(editing()).toBe(false);
  });

  it('does not open the editor when you click a link inside the text', async () => {
    sb.platform.renderMarkdown.mockImplementation(
      (el) => void (el.innerHTML = '<p>see <a href="#x">this link</a></p>'),
    );
    await open('OP-3');
    sb.store.apply({ ...sb.store.get('OP-3')!, body: '\nsee [link](x)\n' });
    await sb.settle();
    click(preview().querySelector('a')!);
    expect(editing()).toBe(false);
  });

  it('does not open the editor for clicks on buttons, details or callout folds', async () => {
    sb.platform.renderMarkdown.mockImplementation(
      (el) =>
        void (el.innerHTML =
          '<details><summary>More</summary>x</details><button>b</button><div class="callout-fold">v</div>'),
    );
    sb.store.apply({ ...sb.store.get('OP-2')!, body: '\nnew text\n' });
    await sb.settle();
    for (const sel of ['summary', 'button', '.callout-fold']) click(preview().querySelector(sel)!);
    expect(editing()).toBe(false);
  });

  it('does not open the editor while you are selecting text to copy', () => {
    vi.spyOn(document, 'getSelection').mockReturnValue({ toString: () => 'selected words' } as Selection);
    click(preview().querySelector('p')!);
    expect(editing()).toBe(false);
  });
});

describe('task checkboxes in the preview', () => {
  beforeEach(async () => {
    await open('OP-2');
  });

  it('ticking one writes it to the note, without opening the editor', async () => {
    const event = click(boxes()[0]!);
    expect(event.defaultPrevented).toBe(true); // the browser does not flip the box by itself
    expect(editing()).toBe(false);
    await sb.settle();
    expect(saved('OP-2').body).toContain('- [x] one');
    expect(saved('OP-2').checklist).toEqual({ done: 2, total: 2 });
    expect(boxes().map((b) => b.checked)).toEqual([true, true]);
    expect(text(sb.card('OP-2')!.querySelector('.op-chip-check'))).toBe('2/2');
  });

  it('unticking works the same way, and picks the right line among several', async () => {
    click(boxes()[1]!);
    await sb.settle();
    expect(saved('OP-2').body).toContain('- [ ] one');
    expect(saved('OP-2').body).toContain('- [ ] two');
    expect(boxes().map((b) => b.checked)).toEqual([false, false]);
    expect(text(sb.card('OP-2')!.querySelector('.op-chip-check'))).toBe('0/2');
  });

  it('keeps the rest of the description exactly as it was', async () => {
    click(boxes()[0]!);
    await sb.settle();
    expect(saved('OP-2').body).toBe('\n- [x] one\n- [x] two\n\nA paragraph with `code`.\n');
  });

  it("ignores a checkbox that is not one of the description's tasks (e.g. added by a plugin's renderer)", async () => {
    sb.platform.renderMarkdown.mockImplementation(
      (el) => void (el.innerHTML = '<input type="checkbox"><input type="checkbox"><input type="checkbox">'),
    );
    sb.store.apply({ ...sb.store.get('OP-2')!, body: '\n- [ ] only task\n' });
    await sb.settle();
    const before = new Map(sb.storage.files);
    click(boxes()[2]!); // there is no third task in the text
    await sb.settle();
    expect(sb.storage.files).toEqual(before);
  });

  it('saves immediately (no 700 ms wait)', async () => {
    click(boxes()[0]!);
    await vi.advanceTimersByTimeAsync(5);
    expect(saved('OP-2').body).toContain('- [x] one');
  });
});

describe('writing the description', () => {
  beforeEach(async () => {
    await open('OP-2');
    click(tab('Write'));
  });

  it('saves after you stop typing for a moment, not on every keystroke', async () => {
    const before = sb.note('OP-2');
    typeInto(desc(), 'first draft');
    await vi.advanceTimersByTimeAsync(SAVE_DELAY - 1);
    expect(sb.note('OP-2')).toBe(before);
    typeInto(desc(), 'second draft'); // typing again restarts the wait
    await vi.advanceTimersByTimeAsync(SAVE_DELAY - 1);
    expect(sb.note('OP-2')).toBe(before);
    await vi.advanceTimersByTimeAsync(2);
    expect(saved('OP-2').body).toBe('\nsecond draft\n');
  });

  it('writes the description in the same shape new cards use, trimming trailing blanks', async () => {
    typeInto(desc(), 'Line one\n\n- [ ] task\n\n\n');
    await vi.advanceTimersByTimeAsync(SAVE_DELAY + 1);
    expect(saved('OP-2').body).toBe('\nLine one\n\n- [ ] task\n');
    expect(saved('OP-2').checklist).toEqual({ done: 0, total: 1 });
  });

  it('updates the checklist counter on the board card', async () => {
    typeInto(desc(), '- [x] a\n- [x] b\n- [ ] c');
    await vi.advanceTimersByTimeAsync(SAVE_DELAY + 1);
    await sb.settle(); // the board repaints on the next frame
    expect(text(sb.card('OP-2')!.querySelector('.op-chip-check'))).toBe('2/3');
  });

  it('clearing it empties the note body and brings back the placeholder', async () => {
    typeInto(desc(), '');
    click(tab('Preview'));
    await sb.settle();
    expect(saved('OP-2').body.trim()).toBe('');
    expect(text(preview().querySelector('.op-preview-empty'))).toBe('Click to add a description…');
  });

  it('losing focus saves at once and goes back to reading', async () => {
    typeInto(desc(), 'quick note');
    desc().focus();
    desc().blur();
    await vi.advanceTimersByTimeAsync(5);
    expect(saved('OP-2').body).toBe('\nquick note\n');
    expect(editing()).toBe(false);
    expect(text(preview())).toBe('quick note');
  });

  it('losing focus because the whole window went away (alt-tab) saves but stays in the editor', async () => {
    hasFocus.mockReturnValue(false);
    typeInto(desc(), 'mid-sentence');
    desc().focus();
    desc().blur();
    await vi.advanceTimersByTimeAsync(5);
    expect(saved('OP-2').body).toBe('\nmid-sentence\n');
    expect(editing()).toBe(true);
  });

  it('Escape saves, goes back to reading, and does not also close the panel', async () => {
    typeInto(desc(), 'escaped');
    const outer = vi.fn();
    sb.container.addEventListener('keydown', outer);
    key(desc(), 'Escape');
    await vi.advanceTimersByTimeAsync(5);
    expect(saved('OP-2').body).toBe('\nescaped\n');
    expect(editing()).toBe(false);
    expect(outer).not.toHaveBeenCalled();
    expect(drawer().hidden).toBe(false);
  });

  it('other keys in the editor are left alone', () => {
    const event = key(desc(), 'a');
    expect(event.defaultPrevented).toBe(false);
    expect(editing()).toBe(true);
  });

  it('writes nothing when the text is unchanged', async () => {
    const before = new Map(sb.storage.files);
    desc().focus();
    desc().blur();
    typeInto(desc(), MARKDOWN); // typing the same text back
    await vi.advanceTimersByTimeAsync(SAVE_DELAY + 1);
    expect(sb.storage.files).toEqual(before);
  });

  it('treats a trailing-whitespace-only change as no change', async () => {
    const before = new Map(sb.storage.files);
    typeInto(desc(), `${MARKDOWN}\n\n  `);
    await vi.advanceTimersByTimeAsync(SAVE_DELAY + 1);
    expect(sb.storage.files).toEqual(before);
  });

  it('closing the panel with a save pending still saves it', async () => {
    typeInto(desc(), 'unsaved when closed');
    click(drawer().querySelector('button[aria-label="Close"]')!);
    await vi.advanceTimersByTimeAsync(5);
    expect(saved('OP-2').body).toBe('\nunsaved when closed\n');
  });

  it('destroying the board drops a pending save instead of writing after teardown', async () => {
    const before = sb.note('OP-2');
    typeInto(desc(), 'too late');
    sb.ui.destroy();
    await vi.advanceTimersByTimeAsync(SAVE_DELAY * 3);
    expect(sb.note('OP-2')).toBe(before);
  });

  it('a failed save is reported', async () => {
    vi.spyOn(sb.storage, 'modify').mockRejectedValueOnce(new Error('disk full'));
    typeInto(desc(), 'will fail');
    await vi.advanceTimersByTimeAsync(SAVE_DELAY + 1);
    expect(sb.platform.notify).toHaveBeenCalledWith('Could not save: disk full');
  });
});

describe('staying in sync with outside changes', () => {
  beforeEach(async () => {
    await open('OP-2');
  });

  it('does not touch the editor while you are typing in it', async () => {
    click(tab('Write'));
    typeInto(desc(), 'my half sentence');
    sb.store.apply({ ...sb.store.get('OP-2')!, body: '\nchanged elsewhere\n' });
    await sb.settle();
    expect(desc().value).toBe('my half sentence');
  });

  it('refreshes both the editor text and the preview when the note changes while you are reading', async () => {
    sb.store.apply({ ...sb.store.get('OP-2')!, body: '\nbrand new text\n' });
    await sb.settle();
    expect(desc().value).toBe('brand new text');
    expect(text(preview())).toBe('brand new text');
  });

  it('does not render the preview again when something other than the text changes', async () => {
    sb.platform.renderMarkdown.mockClear();
    change(drawer().querySelector<HTMLSelectElement>('.op-fields select')!, 'doing'); // status
    sb.store.apply({ ...sb.store.get('OP-2')!, priority: 'lowest' });
    await sb.settle();
    expect(sb.platform.renderMarkdown).not.toHaveBeenCalled();
  });

  it('renders again for a different card even if the text is identical', async () => {
    sb.store.apply({ ...sb.store.get('OP-3')!, body: BODY, checklist: { done: 1, total: 2 } });
    sb.platform.renderMarkdown.mockClear();
    await open('OP-3');
    expect(sb.platform.renderMarkdown).toHaveBeenCalledTimes(1);
  });
});

describe('asynchronous rendering', () => {
  /** A markdown renderer whose completion the test controls, like Obsidian's real one (async, appends). */
  function gated() {
    const gates: { markdown: string; el: HTMLElement; resolve(): void; reject(e: Error): void }[] = [];
    sb.platform.renderMarkdown.mockImplementation(
      (el, markdown) =>
        new Promise<void>((resolve, reject) => {
          gates.push({ markdown, el, resolve: () => (renderMini(el, markdown), resolve()), reject });
        }),
    );
    return gates;
  }

  it('shows the newest render even when an older one finishes last', async () => {
    const gates = gated();
    await open('OP-2'); // render 1 starts
    sb.store.apply({ ...sb.store.get('OP-2')!, body: '\nsecond version\n' }); // render 2 starts
    await sb.settle();
    expect(gates).toHaveLength(2);
    gates[1]!.resolve();
    await sb.settle();
    gates[0]!.resolve(); // the stale one lands late
    await sb.settle();
    expect(text(preview())).toBe('second version');
    expect(preview().querySelectorAll('.op-preview-content')).toHaveLength(1);
    expect(sb.platform.releaseMarkdown).toHaveBeenCalledWith(gates[0]!.el); // the stale render is freed
  });

  it('never shows two copies when renders overlap (the old duplicate-text bug)', async () => {
    const gates = gated();
    await open('OP-2');
    for (let i = 0; i < 4; i++) {
      sb.store.apply({ ...sb.store.get('OP-2')!, body: `\nversion ${i}\n` });
      await sb.settle();
    }
    for (const gate of gates) gate.resolve();
    await sb.settle();
    expect(text(preview())).toBe('version 3');
    expect(preview().querySelectorAll('.op-preview-content')).toHaveLength(1);
  });

  it('keeps showing the old text until the new render is ready, then swaps it in one go', async () => {
    await open('OP-2');
    const before = text(preview());
    const gates = gated();
    sb.store.apply({ ...sb.store.get('OP-2')!, body: '\nslow update\n' });
    await sb.settle();
    expect(text(preview())).toBe(before);
    gates[0]!.resolve();
    await sb.settle();
    expect(text(preview())).toBe('slow update');
  });

  it('falls back to the plain Markdown text when rendering fails', async () => {
    const gates = gated();
    await open('OP-2');
    gates[0]!.reject(new Error('renderer exploded'));
    await sb.settle();
    expect(preview().textContent).toBe(MARKDOWN);
  });

  it('ignores a failure of a render that is already out of date', async () => {
    const gates = gated();
    await open('OP-2');
    sb.store.apply({ ...sb.store.get('OP-2')!, body: '\nnewer\n' });
    await sb.settle();
    gates[1]!.resolve();
    await sb.settle();
    gates[0]!.reject(new Error('old one failed'));
    await sb.settle();
    expect(text(preview())).toBe('newer');
  });

  it('frees the rendered content when the panel closes or the board goes away', async () => {
    await open('OP-2');
    sb.platform.releaseMarkdown.mockClear();
    key(sb.container.querySelector('.op-root')!, 'Escape');
    await sb.settle();
    expect(sb.platform.releaseMarkdown).toHaveBeenCalledWith(preview());
    sb.platform.releaseMarkdown.mockClear();
    sb.ui.destroy();
    expect(sb.platform.releaseMarkdown).toHaveBeenCalled();
  });

  it('frees the previous render when a new one replaces it', async () => {
    await open('OP-2');
    sb.platform.releaseMarkdown.mockClear();
    sb.store.apply({ ...sb.store.get('OP-2')!, body: '\nreplacement\n' });
    await sb.settle();
    expect(sb.platform.releaseMarkdown).toHaveBeenCalledWith(preview());
  });
});
