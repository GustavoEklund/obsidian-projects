// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { append, autosize, clear, debounce, h } from '../src/ui/dom';
import { icon, priorityIcon, typeIcon, type IconName } from '../src/ui/icons';
import { CARD_TYPES, PRIORITIES } from '@oprojects/core';

describe('h()', () => {
  it('builds an element with class, text, attributes, style and props', () => {
    const el = h('button', {
      class: 'a b',
      text: 'Go',
      attrs: { type: 'button', 'data-x': 3 },
      style: { '--op-hue': 120, color: 'red' },
      props: { disabled: true },
    });
    expect(el.tagName).toBe('BUTTON');
    expect(el.className).toBe('a b');
    expect(el.textContent).toBe('Go');
    expect(el.getAttribute('type')).toBe('button');
    expect(el.getAttribute('data-x')).toBe('3');
    expect(el.style.getPropertyValue('--op-hue')).toBe('120');
    expect(el.style.color).toBe('red');
    expect(el.disabled).toBe(true);
  });

  it('skips undefined and false attributes, and writes true as an empty attribute', () => {
    const el = h('div', { attrs: { hidden: true, 'aria-pressed': false, title: undefined, role: 'list' } });
    expect(el.hasAttribute('hidden')).toBe(true);
    expect(el.getAttribute('hidden')).toBe('');
    expect(el.hasAttribute('aria-pressed')).toBe(false);
    expect(el.hasAttribute('title')).toBe(false);
    expect(el.getAttribute('role')).toBe('list');
  });

  it('keeps an explicit zero or empty-string attribute', () => {
    const el = h('input', { attrs: { tabindex: 0, value: '' } });
    expect(el.getAttribute('tabindex')).toBe('0');
    expect(el.getAttribute('value')).toBe('');
  });

  it('attaches event handlers', () => {
    const onClick = vi.fn();
    const el = h('button', { on: { click: onClick } });
    el.click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('appends nodes, strings and numbers, and skips null, undefined and false', () => {
    const child = h('i');
    const el = h('p', {}, 'a', 1, null, undefined, false, child, 0);
    expect([...el.childNodes].map((n) => n.nodeName)).toEqual(['#text', '#text', 'I', '#text']);
    expect(el.textContent).toBe('a10');
  });

  it('does not interpret text as HTML', () => {
    const el = h('div', { text: '<img src=x onerror=alert(1)>' }, '<b>bold</b>');
    expect(el.querySelector('img, b')).toBeNull();
    expect(el.textContent).toBe('<img src=x onerror=alert(1)><b>bold</b>');
  });

  it('text is replaced by children appended after it', () => {
    expect(h('p', { text: 'x' }, 'y').textContent).toBe('xy');
  });

  it('append() works on any node', () => {
    const frag = document.createDocumentFragment();
    append(frag, ['a', h('b'), null]);
    expect(frag.childNodes).toHaveLength(2);
  });

  it('clear() removes every child', () => {
    const el = h('div', {}, 'a', h('b'), 'c');
    clear(el);
    expect(el.childNodes).toHaveLength(0);
  });
});

describe('autosize()', () => {
  it('sets the height to the content height, resetting it first so it can shrink', () => {
    const area = h('textarea');
    Object.defineProperty(area, 'scrollHeight', { value: 87, configurable: true });
    area.style.height = '500px';
    autosize(area);
    expect(area.style.height).toBe('87px');
  });
});

describe('debounce()', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('runs once after the quiet period, with the last arguments', () => {
    const fn = vi.fn();
    const d = debounce(fn, 100);
    d(1);
    d(2);
    d(3);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(99);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(3);
  });

  it('every call restarts the wait', () => {
    const fn = vi.fn();
    const d = debounce(fn, 100);
    d();
    vi.advanceTimersByTime(80);
    d();
    vi.advanceTimersByTime(80);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(20);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('flush() runs a pending call now, and only once', () => {
    const fn = vi.fn();
    const d = debounce(fn, 100);
    d('x');
    d.flush();
    expect(fn).toHaveBeenCalledWith('x');
    vi.advanceTimersByTime(500);
    d.flush();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('flush() with nothing pending does nothing', () => {
    const fn = vi.fn();
    debounce(fn, 100).flush();
    expect(fn).not.toHaveBeenCalled();
  });

  it('cancel() drops a pending call, and a later call still works', () => {
    const fn = vi.fn();
    const d = debounce(fn, 100);
    d('lost');
    d.cancel();
    vi.advanceTimersByTime(500);
    expect(fn).not.toHaveBeenCalled();
    d('kept');
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledWith('kept');
    d.flush();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('a call made from inside the callback schedules a new run', () => {
    const calls: number[] = [];
    const d = debounce((n: number) => {
      calls.push(n);
      if (n < 3) d(n + 1);
    }, 10);
    d(1);
    vi.advanceTimersByTime(100);
    expect(calls).toEqual([1, 2, 3]);
  });
});

describe('icons', () => {
  const names: IconName[] = [
    'task',
    'bug',
    'story',
    'epic',
    'p-highest',
    'p-high',
    'p-medium',
    'p-low',
    'p-lowest',
    'calendar',
    'checklist',
    'plus',
    'search',
    'x',
    'trash',
    'external',
    'chevron',
    'check',
    'layers',
    'archive',
    'user',
    'message',
    'edit',
    'alert',
  ];

  it.each(names)('draws "%s" as an accessible-neutral svg with at least one shape', (name) => {
    const svg = icon(name);
    expect(svg.namespaceURI).toBe('http://www.w3.org/2000/svg');
    expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.classList.contains('op-icon')).toBe(true);
    expect(svg.querySelectorAll('path, circle').length).toBeGreaterThan(0);
  });

  it('uses the requested size, 14 by default', () => {
    expect(icon('x').getAttribute('width')).toBe('14');
    const big = icon('x', 30);
    expect([big.getAttribute('width'), big.getAttribute('height')]).toEqual(['30', '30']);
  });

  it('strokes line icons with currentColor so they follow the theme', () => {
    expect(icon('plus').getAttribute('stroke')).toBe('currentColor');
    expect(icon('plus').getAttribute('fill')).toBe('none');
  });

  it('fills the solid glyphs of the type badges instead of stroking them', () => {
    for (const name of ['bug', 'story', 'epic'] as const) {
      const shape = icon(name).firstElementChild!;
      expect(shape.getAttribute('fill')).toBe('currentColor');
      expect(shape.getAttribute('stroke')).toBe('none');
    }
    expect(icon('task').firstElementChild!.getAttribute('fill')).toBeNull();
  });

  it('draws circles with their center and radius', () => {
    const circle = icon('bug').querySelector('circle')!;
    expect([circle.getAttribute('cx'), circle.getAttribute('cy'), circle.getAttribute('r')]).toEqual([
      '12',
      '12',
      '4.5',
    ]);
  });

  it('has an icon for every card type and priority', () => {
    for (const type of CARD_TYPES) expect(icon(typeIcon(type)).childNodes.length).toBeGreaterThan(0);
    for (const priority of PRIORITIES) expect(icon(priorityIcon(priority)).childNodes.length).toBeGreaterThan(0);
    expect(typeIcon('bug')).toBe('bug');
    expect(priorityIcon('highest')).toBe('p-highest');
  });

  it('returns a fresh element each time', () => {
    expect(icon('x')).not.toBe(icon('x'));
  });
});
