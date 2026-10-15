import { describe, expect, it } from 'vitest';
import { clearFilters, defaultState, sanitizeState } from '../src/ui/state';

describe('UiState', () => {
  it('restores the saved panel width, rounded', () => {
    expect(sanitizeState({ drawerWidth: 512.4 }).drawerWidth).toBe(512);
  });

  it('ignores nonsense widths from old or hand-edited layouts', () => {
    for (const bad of [undefined, null, 'wide', NaN, Infinity, -5, 50, 239, 4001, {}]) expect(sanitizeState({ drawerWidth: bad }).drawerWidth).toBeNull();
  });

  it('states saved before the panel was resizable still load', () => {
    const old = { text: 'login', assignee: ['Ana'], showEpics: true };
    expect(sanitizeState(old)).toMatchObject({ text: 'login', assignee: ['Ana'], showEpics: true, drawerWidth: null });
  });

  it('"clear filters" keeps how the view is arranged', () => {
    const s = { ...defaultState(), text: 'x', mine: true, showEpics: true, drawerWidth: 540 };
    expect(clearFilters(s)).toMatchObject({ text: '', mine: false, showEpics: true, drawerWidth: 540 });
  });
});
