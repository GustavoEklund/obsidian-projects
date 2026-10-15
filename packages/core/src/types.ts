export const PRIORITIES = ['highest', 'high', 'medium', 'low', 'lowest'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const CARD_TYPES = ['task', 'story', 'bug', 'epic'] as const;
export type CardType = (typeof CARD_TYPES)[number];

export interface Checklist {
  done: number;
  total: number;
}

export interface Comment {
  /** Stable within the card; used to edit/delete. */
  id: string;
  author: string;
  /** ISO timestamp. Empty when a hand-written comment has none. */
  at: string;
  /** Markdown. */
  text: string;
}

/**
 * A card as read from a note. `body` is the description (the text after the frontmatter, minus
 * the comments section); `comments` come from that section; the rest lives in the frontmatter.
 */
export interface Card {
  key: string;
  /** Vault-relative path, forward slashes. */
  path: string;
  title: string;
  /** Column id (see `BoardConfig.columns`). */
  status: string;
  type: CardType;
  priority: Priority;
  assignee?: string;
  labels: string[];
  /** `YYYY-MM-DD` */
  due?: string;
  estimate?: number;
  /** Key of the parent card (usually an epic). */
  parent?: string;
  /** Fractional-index string; ascending order = top to bottom inside a column. */
  rank: string;
  /** ISO timestamps. */
  created: string;
  updated: string;
  /** Set while the card sits in a `done` column. */
  resolved?: string;
  /** The description only: the note's text without its comments section. */
  body: string;
  checklist: Checklist;
  /** Oldest first. */
  comments: Comment[];
}

/** Fields a caller may change. `null` clears an optional field. */
export interface CardPatch {
  title?: string;
  status?: string;
  type?: CardType;
  priority?: Priority;
  assignee?: string | null;
  labels?: string[];
  due?: string | null;
  estimate?: number | null;
  parent?: string | null;
  rank?: string;
  /** Replaces the description; the comments section is preserved. */
  body?: string;
}

export interface NewCardInput {
  title: string;
  status?: string;
  type?: CardType;
  priority?: Priority;
  assignee?: string;
  labels?: string[];
  due?: string;
  estimate?: number;
  parent?: string;
  body?: string;
  /** Explicit rank; defaults to the bottom of the target column. */
  rank?: string;
}

/** Where to drop a card inside a column. Neither = bottom of the column. */
export interface Placement {
  before?: string;
  after?: string;
}
