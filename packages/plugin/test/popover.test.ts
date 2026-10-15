// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeActivePopover, openPopover, type PopoverOption, type PopoverOptions } from '../src/ui/popover';
import { click, installDomStubs, key, pointer, rect, text, texts, typeInto } from './helpers/dom';

installDomStubs();

const options: PopoverOption[] = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Bravo', lead: Object.assign(document.createElement('i'), { className: 'lead-b' }) },
  { value: 'c', label: 'Çharlie crème' },
];

let anchor: HTMLButtonElement;
const pop = () => document.querySelector<HTMLElement>('.op-pop');
const items = () => [...document.querySelectorAll<HTMLElement>('.op-pop-item')];
const open = (extra: Partial<PopoverOptions> = {}) => {
  const onChange = vi.fn();
  const handle = openPopover({ anchor, options, selected: [], multi: true, onChange, ...extra });
  return { onChange, handle };
};

beforeEach(() => {
  anchor = document.createElement('button');
  document.body.append(anchor);
  vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue(rect({ top: 100, left: 50, width: 80, height: 30 }));
});

afterEach(() => {
  closeActivePopover();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('openPopover rendering', () => {
  it('lists every option as a labelled, selectable row, in order', () => {
    open();
    expect(texts(document, '.op-pop-label')).toEqual(['Alpha', 'Bravo', 'Çharlie crème']);
    expect(items().map((i) => i.getAttribute('role'))).toEqual(['option', 'option', 'option']);
    expect(document.querySelector('.op-pop-list')!.getAttribute('role')).toBe('listbox');
  });

  it('marks the selected options and shows a check on them', () => {
    open({ selected: ['b'] });
    expect(items().map((i) => i.classList.contains('is-on'))).toEqual([false, true, false]);
    expect(items().map((i) => i.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false']); // real ARIA values, not an empty attribute
    expect(items()[1]!.querySelector('.op-pop-check svg')).not.toBeNull();
    expect(items()[0]!.querySelector('.op-pop-check svg')).toBeNull();
  });

  it('shows the leading visual of an option', () => {
    open();
    expect(items()[1]!.querySelector('.lead-b')).not.toBeNull();
    expect(items()[0]!.querySelector('.lead-b')).toBeNull();
  });

  it('declares multi-selection with real ARIA values', () => {
    open({ multi: true });
    expect(document.querySelector('.op-pop-list')!.getAttribute('aria-multiselectable')).toBe('true');
    closeActivePopover();
    open({ multi: false });
    expect(document.querySelector('.op-pop-list')!.getAttribute('aria-multiselectable')).toBe('false');
  });

  it('keeps aria-selected in step as options are toggled', () => {
    open({ selected: [] });
    click(items()[0]!);
    expect(items().map((i) => i.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false']);
    click(items()[0]!);
    expect(items().map((i) => i.getAttribute('aria-selected'))).toEqual(['false', 'false', 'false']);
  });

  it('attaches to the body and focuses the first row when there is no search box', () => {
    open();
    expect(pop()!.parentElement).toBe(document.body);
    expect(document.activeElement).toBe(items()[0]);
    expect(document.querySelector('.op-pop-search')).toBeNull();
  });

  it('shows a search box and focuses it when a placeholder is given', () => {
    open({ searchPlaceholder: 'Find…' });
    const search = document.querySelector<HTMLInputElement>('.op-pop-search')!;
    expect(search.placeholder).toBe('Find…');
    expect(search.getAttribute('aria-label')).toBe('Find…');
    expect(document.activeElement).toBe(search);
  });

  it('shows a dash for an empty list, or the given empty text', () => {
    open({ options: [] });
    expect(text(document.querySelector('.op-pop-empty'))).toBe('—');
    closeActivePopover();
    open({ options: [], emptyText: 'Nothing to pick' });
    expect(text(document.querySelector('.op-pop-empty'))).toBe('Nothing to pick');
  });

  it('does not crash without options (nothing to focus)', () => {
    expect(() => open({ options: [] })).not.toThrow();
  });
});

describe('selecting', () => {
  it('multi: a click toggles the option, reports the whole selection, and the popover stays open', () => {
    const { onChange } = open({ selected: ['a'] });
    click(items()[1]!);
    expect(onChange).toHaveBeenLastCalledWith(['a', 'b']);
    expect(pop()).not.toBeNull();
    expect(items().map((i) => i.classList.contains('is-on'))).toEqual([true, true, false]);
    click(items()[0]!);
    expect(onChange).toHaveBeenLastCalledWith(['b']);
    expect(items().map((i) => i.classList.contains('is-on'))).toEqual([false, true, false]);
  });

  it('multi: keeps the order the user picked, and never changes the array it was given', () => {
    const selected = ['c'];
    const { onChange } = open({ selected });
    click(items()[0]!);
    click(items()[1]!);
    expect(onChange).toHaveBeenLastCalledWith(['c', 'a', 'b']);
    expect(selected).toEqual(['c']);
  });

  it('single: a click picks that option alone and closes the popover', () => {
    const { onChange } = open({ multi: false, selected: ['a'] });
    click(items()[2]!);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(['c']);
    expect(pop()).toBeNull();
  });

  it('single: picking the current option still reports it (the caller decides what that means)', () => {
    const { onChange } = open({ multi: false, selected: ['a'] });
    click(items()[0]!);
    expect(onChange).toHaveBeenCalledWith(['a']);
  });
});

describe('searching', () => {
  const search = () => document.querySelector<HTMLInputElement>('.op-pop-search')!;

  it('filters the rows as you type, ignoring case and accents', () => {
    open({ searchPlaceholder: 'Find…' });
    typeInto(search(), 'CREME');
    expect(texts(document, '.op-pop-label')).toEqual(['Çharlie crème']);
    typeInto(search(), 'charlie');
    expect(texts(document, '.op-pop-label')).toEqual(['Çharlie crème']);
    typeInto(search(), 'a');
    expect(texts(document, '.op-pop-label')).toEqual(['Alpha', 'Bravo', 'Çharlie crème']);
  });

  it('ignores surrounding spaces and shows the empty text when nothing matches', () => {
    open({ searchPlaceholder: 'Find…', emptyText: 'No match' });
    typeInto(search(), '  alp  ');
    expect(texts(document, '.op-pop-label')).toEqual(['Alpha']);
    typeInto(search(), 'zzz');
    expect(texts(document, '.op-pop-label')).toEqual([]);
    expect(text(document.querySelector('.op-pop-empty'))).toBe('No match');
    typeInto(search(), '');
    expect(items()).toHaveLength(3);
  });

  it('keeps the selection while filtering', () => {
    const { onChange } = open({ searchPlaceholder: 'Find…', selected: ['b'] });
    typeInto(search(), 'bra');
    expect(items()[0]!.classList.contains('is-on')).toBe(true);
    typeInto(search(), 'alp');
    click(items()[0]!);
    expect(onChange).toHaveBeenLastCalledWith(['b', 'a']);
  });
});

describe('closing', () => {
  it('closes on a press outside, but not on a press inside or on the anchor', () => {
    open();
    pointer(pop()!, 'pointerdown');
    pointer(items()[0]!, 'pointerdown');
    pointer(anchor, 'pointerdown');
    expect(pop()).not.toBeNull();
    pointer(document.body, 'pointerdown');
    expect(pop()).toBeNull();
  });

  it('closes on Escape, hands focus back to the anchor and keeps the key to itself', () => {
    open();
    const outer = vi.fn();
    document.addEventListener('keydown', outer); // a bubbling listener, like the board's
    const event = key(items()[0]!, 'Escape');
    expect(pop()).toBeNull();
    expect(document.activeElement).toBe(anchor);
    expect(outer).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    document.removeEventListener('keydown', outer);
  });

  it('other keys do not close it', () => {
    open();
    key(items()[0]!, 'a');
    key(items()[0]!, 'Enter');
    expect(pop()).not.toBeNull();
  });

  it('only one popover is open at a time', () => {
    const first = open();
    const second = open({ options: [{ value: 'z', label: 'Zulu' }] });
    expect(document.querySelectorAll('.op-pop')).toHaveLength(1);
    expect(texts(document, '.op-pop-label')).toEqual(['Zulu']);
    first.onChange.mockClear();
    click(items()[0]!);
    expect(first.onChange).not.toHaveBeenCalled();
    expect(second.onChange).toHaveBeenCalledWith(['z']);
  });

  it('closeActivePopover() closes the open one, and is a no-op when none is open', () => {
    open();
    closeActivePopover();
    expect(pop()).toBeNull();
    expect(() => closeActivePopover()).not.toThrow();
  });

  it('close() is idempotent and detaches every listener', () => {
    const { handle } = open();
    handle.close();
    handle.close();
    expect(pop()).toBeNull();
    const removeSpy = vi.spyOn(document, 'removeEventListener');
    pointer(document.body, 'pointerdown'); // nothing left to react
    key(document, 'Escape');
    expect(removeSpy).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(anchor);
  });

  it("a stale handle cannot close a newer popover's state", () => {
    const first = open();
    open({ options: [{ value: 'z', label: 'Zulu' }] });
    first.handle.close(); // already closed by the second opening
    expect(document.querySelector('.op-pop')).not.toBeNull(); // the second one is untouched
    closeActivePopover();
    expect(pop()).toBeNull();
  });
});

describe('placement', () => {
  const style = () => pop()!.style;

  it('opens just below the anchor, aligned with its left edge', () => {
    open();
    expect(style().left).toBe('50px');
    expect(style().top).toBe('134px'); // anchor bottom (100 + 30) + 4
    expect(style().maxHeight).toBe('360px');
  });

  it('stays inside the window horizontally', () => {
    vi.mocked(anchor.getBoundingClientRect).mockReturnValue(rect({ top: 100, left: 1000, width: 80, height: 30 }));
    open();
    expect(style().left).toBe(`${window.innerWidth - 200 - 8}px`);
    closeActivePopover();
    vi.mocked(anchor.getBoundingClientRect).mockReturnValue(rect({ top: 100, left: -40, width: 80, height: 30 }));
    open();
    expect(style().left).toBe('8px');
  });

  it('flips above the anchor when there is little room below and more above', () => {
    vi.mocked(anchor.getBoundingClientRect).mockReturnValue(
      rect({ top: window.innerHeight - 60, left: 50, width: 80, height: 30 }),
    );
    open();
    expect(parseFloat(style().top)).toBeLessThan(window.innerHeight - 60);
    expect(style().maxHeight).toBe('360px');
  });

  it('never gets shorter than 160px, however little room there is', () => {
    vi.mocked(anchor.getBoundingClientRect).mockReturnValue(rect({ top: 80, left: 50, width: 80, height: 30 }));
    Object.defineProperty(window, 'innerHeight', { value: 150, configurable: true });
    try {
      open();
      expect(style().maxHeight).toBe('160px');
    } finally {
      Object.defineProperty(window, 'innerHeight', { value: 768, configurable: true });
    }
  });

  it('repositions when the window is resized, and stops once closed', () => {
    const { handle } = open();
    vi.mocked(anchor.getBoundingClientRect).mockReturnValue(rect({ top: 300, left: 70, width: 80, height: 30 }));
    window.dispatchEvent(new Event('resize'));
    expect(style().left).toBe('70px');
    expect(style().top).toBe('334px');
    const el = pop()!;
    handle.close();
    vi.mocked(anchor.getBoundingClientRect).mockReturnValue(rect({ top: 10, left: 10, width: 80, height: 30 }));
    window.dispatchEvent(new Event('resize'));
    expect(el.style.left).toBe('70px'); // not moved: the listener is gone
  });
});
