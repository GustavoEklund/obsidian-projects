import { addCommentToBody, cleanAuthor, editCommentInBody, joinBody, removeCommentFromBody, splitBody } from './body';
import { isCardType, isPriority, isValidDate, KEY_RE, keyNumber, newCardContent, normalizeLabels, parseCard } from './card';
import { displayColumn, isDoneStatus, resolveColumn, type BoardConfig } from './config';
import { patchFrontmatter, splitFrontmatter, type FrontmatterPatch } from './frontmatter';
import { UNASSIGNED, filterCards, isArchivedDone, rankForPlacement, sortCards, type CardFilter } from './query';
import { FileExistsError, NotFoundError, type Storage } from './storage';
import { CARD_TYPES, PRIORITIES, type Card, type CardPatch, type CardType, type Comment, type NewCardInput, type Placement, type Priority } from './types';

export class ValidationError extends Error {}

export interface ServiceOptions {
  /** Injectable clock (tests). */
  now?: () => Date;
  /**
   * Cheap source of the current cards, used only to allocate keys and ranks.
   * The plugin passes its in-memory index so creating/moving a card does not
   * re-read every note. Default: scan the storage.
   */
  snapshot?: () => Card[] | Promise<Card[]>;
  /** Injectable comment id generator (tests). */
  newId?: () => string;
}

const MAX_KEY_ATTEMPTS = 8;

/**
 * What a caller (CLI flags, MCP tool arguments) can ask for. Friendly forms are accepted and
 * resolved by `CardService.find`: column names as well as ids, `me`, `none`, bare card numbers.
 */
export interface CardQuery {
  text?: string;
  status?: string[];
  type?: CardType[];
  priority?: Priority[];
  /** Names; `none` = unassigned; `me` = the board's configured user. */
  assignee?: string[];
  labels?: string[];
  parent?: string;
  /** Include done cards older than the board's archive limit (default: hidden). */
  includeArchived?: boolean;
}

/**
 * Everything you can do to cards, independent of where notes live. The Obsidian
 * plugin, the CLI and the MCP server are all thin shells over this class.
 */
export class CardService {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly snapshot: () => Card[] | Promise<Card[]>;

  constructor(
    private readonly storage: Storage,
    readonly config: BoardConfig,
    options: ServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => Math.random().toString(36).slice(2, 7).padEnd(5, '0'));
    this.snapshot = options.snapshot ?? (() => this.list());
  }

  /** Read every card from storage, in board order. */
  async list(): Promise<Card[]> {
    const paths = await this.storage.listMarkdown(this.config.folder);
    const cards: Card[] = [];
    // Bounded fan-out: plenty fast for thousands of notes without exhausting file handles.
    const WORKERS = 32;
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(WORKERS, paths.length) }, async () => {
        while (next < paths.length) {
          const path = paths[next++]!;
          try {
            const card = parseCard(path, await this.storage.read(path));
            if (card) cards.push(card);
          } catch {
            // Unreadable note (deleted mid-scan, permissions): skip it, don't fail the board.
          }
        }
      }),
    );
    return sortCards(cards, this.config);
  }

  /** Cards matching `query`, in board order. Resolves `me`, `none`, column names and card numbers. */
  async find(query: CardQuery = {}): Promise<Card[]> {
    const filter: CardFilter = {};
    if (query.text?.trim()) filter.text = query.text;
    if (query.status?.length) filter.status = query.status.map((s) => this.checkStatus(s));
    if (query.type?.length) filter.type = query.type;
    if (query.priority?.length) filter.priority = query.priority;
    if (query.labels?.length) filter.labels = query.labels;
    if (query.parent) filter.parent = this.resolveKey(query.parent);
    if (query.assignee?.length) {
      filter.assignee = query.assignee.map((a) => {
        const v = a.trim();
        if (v.toLowerCase() === 'none' || v === UNASSIGNED) return UNASSIGNED;
        if (v.toLowerCase() !== 'me') return v;
        if (!this.config.me) throw new ValidationError('"me" is not configured for this board (set "My name" in the plugin settings, or `me` in data.json)');
        return this.config.me;
      });
    }
    for (const t of filter.type ?? []) if (!isCardType(t)) throw new ValidationError(`Invalid type "${t}" (${CARD_TYPES.join(', ')})`);
    for (const p of filter.priority ?? []) if (!isPriority(p)) throw new ValidationError(`Invalid priority "${p}" (${PRIORITIES.join(', ')})`);

    const now = this.now();
    const cards = (await this.list()).filter((c) => query.includeArchived || !isArchivedDone(c, this.config, now));
    return filterCards(cards, filter, this.config);
  }

  /** Accepts `OP-12`, `op-12` or just `12`. */
  resolveKey(input: string): string {
    const v = input.trim().toUpperCase();
    if (/^\d+$/.test(v)) return `${this.config.prefix}-${Number(v)}`;
    if (!KEY_RE.test(v)) throw new ValidationError(`"${input}" is not a card key (expected ${this.config.prefix}-123 or 123)`);
    return v;
  }

  async get(input: string): Promise<Card> {
    const key = this.resolveKey(input);
    const direct = `${this.config.folder}/${key}.md`;
    try {
      const card = parseCard(direct, await this.storage.read(direct));
      if (card?.key === key) return card;
    } catch {
      // fall through to the scan
    }
    const found = (await this.list()).find((c) => c.key === key);
    if (!found) throw new NotFoundError(`Card ${key}`);
    return found;
  }

  async create(input: NewCardInput): Promise<Card> {
    const title = cleanTitle(input.title);
    const status = input.status === undefined ? this.config.columns[0]!.id : this.checkStatus(input.status);
    const type = input.type ?? 'task';
    const priority = input.priority ?? 'medium';
    if (!isCardType(type)) throw new ValidationError(`Invalid type "${type}" (${CARD_TYPES.join(', ')})`);
    if (!isPriority(priority)) throw new ValidationError(`Invalid priority "${priority}" (${PRIORITIES.join(', ')})`);
    if (input.due !== undefined && !isValidDate(input.due)) throw new ValidationError(`Invalid due date "${input.due}" (expected YYYY-MM-DD)`);
    if (input.estimate !== undefined) checkEstimate(input.estimate);

    const cards = await this.snapshot();
    if (input.parent) {
      const parent = this.resolveKey(input.parent);
      if (!cards.some((c) => c.key === parent)) throw new ValidationError(`Parent card ${parent} does not exist`);
      input = { ...input, parent };
    }

    const nowIso = this.now().toISOString();
    const rank = input.rank ?? rankForPlacement(cards, this.config, '', status);
    let n = Math.max(0, ...cards.map((c) => keyNumber(c.key, this.config.prefix) ?? 0)) + 1;

    for (let attempt = 0; attempt < MAX_KEY_ATTEMPTS; attempt++, n++) {
      const key = `${this.config.prefix}-${n}`;
      const path = `${this.config.folder}/${key}.md`;
      const card: Omit<Card, 'path' | 'checklist'> = {
        key,
        title,
        status,
        type,
        priority,
        assignee: input.assignee?.trim() || undefined,
        labels: normalizeLabels(input.labels ?? []),
        due: input.due,
        estimate: input.estimate,
        parent: input.parent,
        rank,
        created: nowIso,
        updated: nowIso,
        resolved: isDoneStatus(this.config, status) ? nowIso : undefined,
        body: input.body ?? '',
        comments: [],
      };
      try {
        await this.storage.create(path, newCardContent(card));
        return parseCard(path, newCardContent(card))!;
      } catch (e) {
        if (e instanceof FileExistsError) continue; // someone (plugin/CLI) took this number first
        throw e;
      }
    }
    throw new Error(`Could not allocate a free key after ${MAX_KEY_ATTEMPTS} attempts`);
  }

  async update(input: string, patch: CardPatch): Promise<Card> {
    const card = await this.get(input);
    const fm: FrontmatterPatch = {};

    if (patch.title !== undefined) fm.title = cleanTitle(patch.title);
    if (patch.type !== undefined) {
      if (!isCardType(patch.type)) throw new ValidationError(`Invalid type "${patch.type}" (${CARD_TYPES.join(', ')})`);
      fm.type = patch.type;
    }
    if (patch.priority !== undefined) {
      if (!isPriority(patch.priority)) throw new ValidationError(`Invalid priority "${patch.priority}" (${PRIORITIES.join(', ')})`);
      fm.priority = patch.priority;
    }
    if (patch.assignee !== undefined) fm.assignee = patch.assignee?.trim() || null;
    if (patch.labels !== undefined) fm.labels = normalizeLabels(patch.labels).length ? normalizeLabels(patch.labels) : null;
    if (patch.due !== undefined) {
      if (patch.due !== null && !isValidDate(patch.due)) throw new ValidationError(`Invalid due date "${patch.due}" (expected YYYY-MM-DD)`);
      fm.due = patch.due;
    }
    if (patch.estimate !== undefined) {
      if (patch.estimate !== null) checkEstimate(patch.estimate);
      fm.estimate = patch.estimate;
    }
    if (patch.parent !== undefined) {
      if (patch.parent === null) fm.parent = null;
      else {
        const parent = this.resolveKey(patch.parent);
        if (parent === card.key) throw new ValidationError('A card cannot be its own parent');
        if (!(await this.snapshot()).some((c) => c.key === parent)) throw new ValidationError(`Parent card ${parent} does not exist`);
        fm.parent = parent;
      }
    }

    const nowIso = this.now().toISOString();
    if (patch.status !== undefined && patch.status !== card.status) {
      const status = this.checkStatus(patch.status);
      fm.status = status;
      const wasDone = isDoneStatus(this.config, card.status);
      const isDone = isDoneStatus(this.config, status);
      if (isDone && !wasDone) fm.resolved = nowIso;
      else if (!isDone && wasDone) fm.resolved = null;
      // Changing column without saying where: land at the bottom of the new column.
      if (patch.rank === undefined && displayColumn(this.config, status).id !== displayColumn(this.config, card.status).id) {
        fm.rank = rankForPlacement(await this.snapshot(), this.config, card.key, status);
      }
    }
    if (patch.rank !== undefined) fm.rank = patch.rank;
    fm.updated = nowIso;

    const content = await this.storage.modify(card.path, (current) => {
      // `patch.body` is the description only: put the (current, on-disk) comments section back after it.
      const body = patch.body === undefined ? undefined : joinBody(patch.body, splitBody(splitFrontmatter(current).body).section);
      return patchFrontmatter(current, fm, body);
    });
    return parseCard(card.path, content) ?? card;
  }

  /**
   * Add a comment. `author` defaults to the board's configured user; if neither exists the call is
   * rejected, because an unsigned comment is not useful. Bumps the card's `updated`.
   */
  async addComment(input: string, comment: { text: string; author?: string }): Promise<Card> {
    const text = cleanText(comment.text);
    const author = cleanAuthor(comment.author?.trim() || this.config.me);
    if (!author) throw new ValidationError('Who is commenting? Pass an author, or set "My name" in the board settings.');
    const card = await this.get(input);
    const taken = new Set(card.comments.map((c) => c.id));
    let id = this.newId();
    while (taken.has(id)) id = this.newId();
    const added: Comment = { id, author, at: this.now().toISOString(), text };
    return this.mutateBody(card, (body) => addCommentToBody(body, added));
  }

  async editComment(input: string, commentId: string, text: string): Promise<Card> {
    const next = cleanText(text);
    const card = await this.get(input);
    return this.mutateBody(card, (body) => editCommentInBody(body, commentId, next), `Comment ${commentId} on ${card.key}`);
  }

  async removeComment(input: string, commentId: string): Promise<Card> {
    const card = await this.get(input);
    return this.mutateBody(card, (body) => removeCommentFromBody(body, commentId), `Comment ${commentId} on ${card.key}`);
  }

  /** Rewrite the body atomically (against the freshest content), touching nothing else but `updated`. */
  private async mutateBody(card: Card, fn: (body: string) => string | null, notFound?: string): Promise<Card> {
    const updated = this.now().toISOString();
    const content = await this.storage.modify(card.path, (current) => {
      const next = fn(splitFrontmatter(current).body);
      if (next === null) throw new NotFoundError(notFound ?? card.key);
      return patchFrontmatter(current, { updated }, next);
    });
    return parseCard(card.path, content) ?? card;
  }

  /** Move to a column (id or name), optionally next to a specific card. */
  async move(input: string, column: string, placement: Placement = {}): Promise<Card> {
    const card = await this.get(input);
    const status = this.checkStatus(column);
    const rank = rankForPlacement(await this.snapshot(), this.config, card.key, status, placement);
    return this.update(card.key, { status, rank });
  }

  async remove(input: string): Promise<Card> {
    const card = await this.get(input);
    await this.storage.remove(card.path);
    return card;
  }

  /** Accepts a column id or display name; throws with the valid options otherwise. */
  checkStatus(idOrName: string): string {
    const col = resolveColumn(this.config, idOrName);
    if (!col) {
      const valid = this.config.columns.map((c) => c.id).join(', ');
      throw new ValidationError(`Unknown status "${idOrName}" (valid: ${valid})`);
    }
    return col.id;
  }
}

function cleanText(text: string): string {
  const t = text.replace(/\r\n/g, '\n').replace(/\s+$/, '').replace(/^\s*\n/, '');
  if (!t.trim()) throw new ValidationError('A comment cannot be empty');
  return t;
}

function cleanTitle(title: string): string {
  const t = title.replace(/\s+/g, ' ').trim();
  if (!t) throw new ValidationError('Title cannot be empty');
  return t;
}

function checkEstimate(n: number): void {
  if (!Number.isFinite(n) || n < 0) throw new ValidationError(`Invalid estimate "${n}" (expected a number >= 0)`);
}
