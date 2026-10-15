import { CARD_TYPES, PRIORITIES, UNASSIGNED, type BoardConfig, type CardFilter, type CardType, type Priority } from '@oprojects/core';

/** Everything the toolbar controls. Persisted per view so a reload restores it. */
export interface UiState {
  text: string;
  assignee: string[];
  type: CardType[];
  priority: Priority[];
  labels: string[];
  /** Epic key, or `NO_EPIC`. */
  parent: string | null;
  mine: boolean;
  showEpics: boolean;
  showArchived: boolean;
  /** Width in px the user gave the details panel; null = default. */
  drawerWidth: number | null;
}

export const NO_EPIC = '@none';

export const defaultState = (): UiState => ({
  text: '',
  assignee: [],
  type: [],
  priority: [],
  labels: [],
  parent: null,
  mine: false,
  showEpics: false,
  showArchived: false,
  drawerWidth: null,
});

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** Defensive restore: saved state may come from an older version or be hand-edited. */
export function sanitizeState(raw: unknown): UiState {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = defaultState();
  return {
    text: typeof r.text === 'string' ? r.text : d.text,
    assignee: strings(r.assignee),
    type: strings(r.type).filter((x): x is CardType => (CARD_TYPES as readonly string[]).includes(x)),
    priority: strings(r.priority).filter((x): x is Priority => (PRIORITIES as readonly string[]).includes(x)),
    labels: strings(r.labels),
    parent: typeof r.parent === 'string' ? r.parent : null,
    mine: r.mine === true,
    showEpics: r.showEpics === true,
    showArchived: r.showArchived === true,
    drawerWidth: typeof r.drawerWidth === 'number' && Number.isFinite(r.drawerWidth) && r.drawerWidth >= 240 && r.drawerWidth <= 4000 ? Math.round(r.drawerWidth) : null,
  };
}

/** Number of active filter dimensions (what the "Clear" button resets). */
export function activeFilterCount(s: UiState): number {
  return (s.text.trim() ? 1 : 0) + (s.assignee.length ? 1 : 0) + (s.type.length ? 1 : 0) + (s.priority.length ? 1 : 0) + (s.labels.length ? 1 : 0) + (s.parent ? 1 : 0) + (s.mine ? 1 : 0);
}

export function clearFilters(s: UiState): UiState {
  // "Clear filters" resets the filters only, not how the user arranged the view.
  return { ...defaultState(), showEpics: s.showEpics, showArchived: s.showArchived, drawerWidth: s.drawerWidth };
}

/** `parent` needs special handling ("no epic"), so it is applied separately from `CardFilter`. */
export function toFilter(s: UiState, config: BoardConfig): CardFilter {
  const f: CardFilter = {};
  if (s.text.trim()) f.text = s.text;
  const assignee = [...s.assignee];
  if (s.mine && config.me) assignee.push(config.me);
  if (assignee.length) f.assignee = assignee;
  if (s.type.length) f.type = s.type;
  if (s.priority.length) f.priority = s.priority;
  if (s.labels.length) f.labels = s.labels;
  if (s.parent && s.parent !== NO_EPIC) f.parent = s.parent;
  return f;
}

export { UNASSIGNED };
