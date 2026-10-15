import { CARD_TYPES, type CardType } from '@oprojects/core';
import { t } from '../i18n';
import { autosize, h } from './dom';

export interface ComposerHooks {
  type: CardType;
  onType(type: CardType): void;
  /** Resolves when the card exists; the composer then clears itself for the next one. */
  submit(title: string, body: string, type: CardType): Promise<void>;
  cancel(): void;
}

export interface Composer {
  el: HTMLElement;
  focus(): void;
}

/**
 * Inline "create card" form at the bottom of a column. Enter creates and keeps
 * the form open for rapid entry; Shift+Enter adds a line (first line = title,
 * the rest becomes the description); Esc closes.
 */
export function createComposer(hooks: ComposerHooks): Composer {
  let busy = false;
  const input = h('textarea', { class: 'op-composer-input', props: { rows: 2, placeholder: t('composer.placeholder') }, attrs: { 'aria-label': t('composer.placeholder') } });
  const type = h('select', { class: 'op-input op-composer-type', attrs: { 'aria-label': t('field.type') } }, ...CARD_TYPES.map((x) => h('option', { text: t(`type.${x}`), props: { value: x } })));
  type.value = hooks.type;
  type.addEventListener('change', () => hooks.onType(type.value as CardType));

  const submit = async () => {
    if (busy) return;
    const [first = '', ...rest] = input.value.split('\n');
    const title = first.trim();
    if (!title) return;
    busy = true;
    try {
      await hooks.submit(title, rest.join('\n').trim(), type.value as CardType);
      input.value = '';
      autosize(input);
    } finally {
      busy = false;
      input.focus();
    }
  };

  input.addEventListener('input', () => autosize(input));
  input.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submit();
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      hooks.cancel();
    }
  });

  const el = h(
    'form',
    { class: 'op-composer', on: { submit: (e) => e.preventDefault() } },
    input,
    h('div', { class: 'op-composer-hint', text: t('composer.hint') }),
    h(
      'div',
      { class: 'op-composer-row' },
      type,
      h('span', { class: 'op-spacer' }),
      h('button', { class: 'op-btn', text: t('composer.cancel'), attrs: { type: 'button' }, on: { click: () => hooks.cancel() } }),
      h('button', { class: 'op-btn-primary', text: t('create'), attrs: { type: 'button' }, on: { click: () => void submit() } }),
    ),
  );
  return { el, focus: () => input.focus() };
}
