export interface Column {
  /** Stable id stored in each card's `status`. Never shown to the user. */
  id: string;
  /** Display name. Free to rename without touching any card. */
  name: string;
  /** Cards in a done column are "resolved": no overdue warning, hidden after `hideDoneAfterDays`. */
  done?: boolean;
  /** Work-in-progress limit; 0/undefined = unlimited. */
  wip?: number;
}

export interface BoardConfig {
  /** Vault-relative folder that holds the card notes. */
  folder: string;
  /** Jira-style project key; cards are named `PREFIX-1`, `PREFIX-2`, ... */
  prefix: string;
  columns: Column[];
  /** Hide done cards resolved more than N days ago (0 = never hide). */
  hideDoneAfterDays: number;
  /** Who "I" am, for the "only mine" filter and `oprojects list --mine`. */
  me: string;
  /** Suggestions for the assignee field. */
  members: string[];
}

export const DEFAULT_COLUMNS: Column[] = [
  { id: 'todo', name: 'To Do' },
  { id: 'doing', name: 'In Progress' },
  { id: 'review', name: 'Review' },
  { id: 'done', name: 'Done', done: true },
];

export const DEFAULT_CONFIG: BoardConfig = {
  folder: 'Cards',
  prefix: 'OP',
  columns: DEFAULT_COLUMNS,
  hideDoneAfterDays: 14,
  me: '',
  members: [],
};

const PREFIX_RE = /^[A-Z][A-Z0-9]{1,9}$/;
const COLUMN_ID_RE = /^[a-z0-9][a-z0-9_-]*$/;

export class ConfigError extends Error {}

export function isValidPrefix(prefix: string): boolean {
  return PREFIX_RE.test(prefix);
}

export function slugifyColumnId(name: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'column';
}

/** Folder without leading/trailing slashes or `.`/`..` segments. */
export function normalizeFolder(folder: string): string {
  const parts = folder
    .replace(/\\/g, '/')
    .split('/')
    .filter((p) => p && p !== '.' && p !== '..');
  return parts.join('/');
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v.trim() : undefined;
}

function normalizeColumns(raw: unknown): Column[] {
  if (!Array.isArray(raw)) return DEFAULT_COLUMNS.map((c) => ({ ...c }));
  const seen = new Set<string>();
  const out: Column[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const name = str(r.name) || str(r.id);
    if (!name) continue;
    let id = str(r.id) || slugifyColumnId(name);
    if (!COLUMN_ID_RE.test(id)) id = slugifyColumnId(id);
    if (seen.has(id)) continue; // ids must be unique; first wins
    seen.add(id);
    const col: Column = { id, name };
    if (r.done === true) col.done = true;
    if (typeof r.wip === 'number' && Number.isFinite(r.wip) && r.wip > 0) col.wip = Math.floor(r.wip);
    out.push(col);
  }
  return out.length ? out : DEFAULT_COLUMNS.map((c) => ({ ...c }));
}

/**
 * Tolerant loader for hand-edited / partially missing settings: anything
 * invalid falls back to the default instead of throwing.
 */
export function normalizeConfig(raw: unknown): BoardConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const prefix = (str(r.prefix) ?? '').toUpperCase();
  const hide = typeof r.hideDoneAfterDays === 'number' && r.hideDoneAfterDays >= 0 ? Math.floor(r.hideDoneAfterDays) : DEFAULT_CONFIG.hideDoneAfterDays;
  return {
    folder: normalizeFolder(str(r.folder) ?? '') || DEFAULT_CONFIG.folder,
    prefix: isValidPrefix(prefix) ? prefix : DEFAULT_CONFIG.prefix,
    columns: normalizeColumns(r.columns),
    hideDoneAfterDays: hide,
    me: str(r.me) ?? '',
    members: Array.isArray(r.members) ? [...new Set(r.members.map((m) => str(m)).filter((m): m is string => !!m))] : [],
  };
}

export function columnById(config: BoardConfig, id: string): Column | undefined {
  return config.columns.find((c) => c.id === id);
}

/** The column a card is displayed in; unknown statuses fall back to the first column. */
export function displayColumn(config: BoardConfig, status: string): Column {
  return columnById(config, status) ?? config.columns[0]!;
}

export function isDoneStatus(config: BoardConfig, status: string): boolean {
  return !!columnById(config, status)?.done;
}

/** Accepts a column id or (case-insensitive) display name. */
export function resolveColumn(config: BoardConfig, idOrName: string): Column | undefined {
  const needle = idOrName.trim().toLowerCase();
  return config.columns.find((c) => c.id === needle || c.name.toLowerCase() === needle);
}
