// @vitest-environment jsdom
import type { CardType } from '@oprojects/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createComposer, type ComposerHooks } from '../src/ui/composer';
import { change, click, installDomStubs, key, texts, typeInto } from './helpers/dom';

installDomStubs();

function make(overrides: Partial<ComposerHooks> = {}) {
  const hooks = {
    type: 'task' as CardType,
    onType: vi.fn(),
    submit: vi.fn(async () => undefined),
    cancel: vi.fn(),
    ...overrides,
  };
  const composer = createComposer(hooks);
  document.body.append(composer.el);
  const input = composer.el.querySelector<HTMLTextAreaElement>('.op-composer-input')!;
  const select = composer.el.querySelector<HTMLSelectElement>('.op-composer-type')!;
  return { hooks, composer, input, select };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('createComposer rendering', () => {
  it('is a form with a title box, type select, hint and two buttons', () => {
    const { composer, input, select } = make();
    expect(composer.el.tagName).toBe('FORM');
    expect(input.placeholder).toBe('What needs to be done?');
    expect(input.getAttribute('aria-label')).toBe('What needs to be done?');
    expect(input.rows).toBe(2);
    expect(texts(composer.el, '.op-composer-hint')).toEqual(['Enter to create · Esc to cancel']);
    expect(texts(composer.el, 'button')).toEqual(['Cancel', 'Create']);
    expect([...composer.el.querySelectorAll('button')].map((b) => b.type)).toEqual(['button', 'button']);
    expect(select.getAttribute('aria-label')).toBe('Type');
  });

  it('offers every card type and starts on the one it was given', () => {
    const { select } = make({ type: 'bug' });
    expect([...select.options].map((o) => o.value)).toEqual(['task', 'story', 'bug', 'epic']);
    expect([...select.options].map((o) => o.textContent)).toEqual(['Task', 'Story', 'Bug', 'Epic']);
    expect(select.value).toBe('bug');
  });

  it('focus() puts the cursor in the title box', () => {
    const { composer, input } = make();
    composer.focus();
    expect(document.activeElement).toBe(input);
  });

  it('never submits the form natively (that would reload the page)', () => {
    const { composer } = make();
    const event = new Event('submit', { bubbles: true, cancelable: true });
    composer.el.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
});

describe('submitting', () => {
  it('Enter submits title, description and type', async () => {
    const { hooks, input, select } = make();
    change(select, 'story');
    typeInto(input, 'Write docs\nfirst paragraph\n\nsecond');
    const event = key(input, 'Enter');
    expect(event.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(hooks.submit).toHaveBeenCalledTimes(1));
    expect(hooks.submit).toHaveBeenCalledWith('Write docs', 'first paragraph\n\nsecond', 'story');
  });

  it('trims the title and the description', async () => {
    const { hooks, input } = make();
    typeInto(input, '   Padded title  \n\n  body  \n\n');
    key(input, 'Enter');
    await vi.waitFor(() => expect(hooks.submit).toHaveBeenCalled());
    expect(hooks.submit).toHaveBeenCalledWith('Padded title', 'body', 'task');
  });

  it('a single line is a title with an empty description', async () => {
    const { hooks, input } = make();
    typeInto(input, 'Just a title');
    key(input, 'Enter');
    await vi.waitFor(() => expect(hooks.submit).toHaveBeenCalled());
    expect(hooks.submit).toHaveBeenCalledWith('Just a title', '', 'task');
  });

  it('Shift+Enter adds a line instead of submitting', () => {
    const { hooks, input } = make();
    typeInto(input, 'Title');
    const event = key(input, 'Enter', { shiftKey: true });
    expect(event.defaultPrevented).toBe(false);
    expect(hooks.submit).not.toHaveBeenCalled();
  });

  it('ignores Enter while an IME composition is in progress', () => {
    const { hooks, input } = make();
    typeInto(input, 'にほんご');
    const event = key(input, 'Enter', { isComposing: true });
    expect(event.defaultPrevented).toBe(false);
    expect(hooks.submit).not.toHaveBeenCalled();
  });

  it('does nothing for an empty title, or a body without one', () => {
    const { hooks, input } = make();
    key(input, 'Enter');
    typeInto(input, '   \nbody only');
    key(input, 'Enter');
    expect(hooks.submit).not.toHaveBeenCalled();
    expect(input.value).toBe('   \nbody only'); // what was typed is left alone
  });

  it('the Create button submits too', async () => {
    const { hooks, input, composer } = make();
    typeInto(input, 'Via the button');
    click(composer.el.querySelector('.op-btn-primary')!);
    await vi.waitFor(() => expect(hooks.submit).toHaveBeenCalledWith('Via the button', '', 'task'));
  });

  it('clears the box and keeps the cursor there once the card exists, ready for the next one', async () => {
    const { input } = make();
    typeInto(input, 'One');
    key(input, 'Enter');
    await vi.waitFor(() => expect(input.value).toBe(''));
    expect(document.activeElement).toBe(input);
  });

  it('shrinks the box back after clearing it', async () => {
    const { input } = make();
    Object.defineProperty(input, 'scrollHeight', { value: 20, configurable: true });
    typeInto(input, 'One\ntwo\nthree');
    input.style.height = '90px';
    key(input, 'Enter');
    await vi.waitFor(() => expect(input.style.height).toBe('20px'));
  });

  it('autosizes the box as you type', () => {
    const { input } = make();
    Object.defineProperty(input, 'scrollHeight', { value: 64, configurable: true });
    typeInto(input, 'a\nb\nc');
    expect(input.style.height).toBe('64px');
  });

  it('ignores a second Enter while the first card is still being created', async () => {
    let finish!: () => void;
    const submit = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const { input } = make({ submit });
    typeInto(input, 'Slow one');
    key(input, 'Enter');
    key(input, 'Enter');
    click(document.querySelector('.op-btn-primary')!);
    expect(submit).toHaveBeenCalledTimes(1);
    finish();
    await vi.waitFor(() => expect(input.value).toBe(''));
    typeInto(input, 'Next');
    key(input, 'Enter');
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it('when creating fails, keeps what was typed, stays usable, and raises no unhandled rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const submit = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(undefined);
      const { input } = make({ submit });
      typeInto(input, 'Precious');
      key(input, 'Enter');
      await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
      await new Promise((resolve) => setTimeout(resolve, 20)); // give a stray rejection time to surface
      expect(input.value).toBe('Precious');
      expect(document.activeElement).toBe(input);
      expect(unhandled).not.toHaveBeenCalled();
      key(input, 'Enter'); // the retry goes through
      await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(input.value).toBe(''));
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});

describe('type selection', () => {
  it('tells the caller when the type changes', () => {
    const { hooks, select } = make();
    change(select, 'epic');
    expect(hooks.onType).toHaveBeenCalledWith('epic');
  });

  it('submits whichever type is selected at that moment', async () => {
    const { hooks, input, select } = make();
    typeInto(input, 'A');
    change(select, 'bug');
    key(input, 'Enter');
    await vi.waitFor(() => expect(hooks.submit).toHaveBeenCalledWith('A', '', 'bug'));
  });
});

describe('cancelling', () => {
  it('Escape cancels and keeps the key from reaching the board', () => {
    const { hooks, input } = make();
    const outer = vi.fn();
    document.body.addEventListener('keydown', outer);
    key(input, 'Escape');
    expect(hooks.cancel).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
    document.body.removeEventListener('keydown', outer);
  });

  it('the Cancel button cancels', () => {
    const { hooks, composer } = make();
    click(composer.el.querySelector('.op-btn')!);
    expect(hooks.cancel).toHaveBeenCalledTimes(1);
  });

  it('other keys neither cancel nor submit', () => {
    const { hooks, input } = make();
    for (const k of ['a', 'Tab', 'ArrowDown']) key(input, k);
    expect(hooks.cancel).not.toHaveBeenCalled();
    expect(hooks.submit).not.toHaveBeenCalled();
  });
});
