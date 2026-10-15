import { parseArgs, type ParseArgsConfig } from 'node:util';
import * as path from 'node:path';
import {
  CardService,
  ConfigError,
  DEFAULT_CONFIG,
  NotFoundError,
  ValidationError,
  groupByColumn,
  isValidDate,
  isValidPrefix,
  localDate,
  normalizeConfig,
  normalizeFolder,
  type BoardConfig,
  type Card,
  type CardQuery,
  type CardPatch,
  type CardType,
  type NewCardInput,
  type Priority,
} from '@oprojects/core';
import { FsStorage, VaultNotFoundError, findVaultRoot, hasBoardConfig, loadBoardConfig, saveBoardConfig } from '@oprojects/core/node';
import { makePainter, renderBoard, renderCard, renderTable, type Painter } from './format';
import pkg from '../package.json';

export interface IO {
  cwd: string;
  env: Record<string, string | undefined>;
  out: (text: string) => void;
  err: (text: string) => void;
  readStdin: () => Promise<string>;
  isTTY: boolean;
  columns: number;
  now: () => Date;
  openUrl: (url: string) => Promise<void>;
}

export const VERSION: string = pkg.version;

type Options = NonNullable<ParseArgsConfig['options']>;
type Values = Record<string, string | boolean | (string | boolean)[] | undefined>;

interface Ctx {
  io: IO;
  root: string;
  config: BoardConfig;
  svc: CardService;
  paint: Painter;
  json: boolean;
  now: Date;
}

interface Args {
  values: Values;
  positionals: string[];
}

interface Command {
  name: string;
  aliases?: string[];
  summary: string;
  usage: string;
  examples?: string[];
  options: Options;
  /** Commands that must work before the vault has a board config. */
  run(ctx: Ctx, args: Args): Promise<void>;
}

/** Usage mistakes (bad flags, missing arguments): exit code 2. */
class UsageError extends Error {}

const str = (v: Values[string]): string | undefined => (typeof v === 'string' ? v : undefined);
const list = (v: Values[string]): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' ? [v] : []);
const flag = (v: Values[string]): boolean => v === true;
const splitCsv = (xs: string[]): string[] => xs.flatMap((x) => x.split(',')).map((x) => x.trim()).filter(Boolean);
const isClear = (v: string): boolean => v === '' || v.toLowerCase() === 'none';

const GLOBAL_OPTIONS: Options = {
  vault: { type: 'string' },
  json: { type: 'boolean' },
  'no-color': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

const FILTER_OPTIONS: Options = {
  status: { type: 'string', short: 's', multiple: true },
  type: { type: 'string', short: 't', multiple: true },
  priority: { type: 'string', short: 'p', multiple: true },
  assignee: { type: 'string', short: 'a', multiple: true },
  label: { type: 'string', short: 'l', multiple: true },
  parent: { type: 'string' },
  query: { type: 'string', short: 'q' },
  mine: { type: 'boolean' },
  all: { type: 'boolean' },
};

const FIELD_OPTIONS: Options = {
  status: { type: 'string', short: 's' },
  type: { type: 'string', short: 't' },
  priority: { type: 'string', short: 'p' },
  assignee: { type: 'string', short: 'a' },
  label: { type: 'string', short: 'l', multiple: true },
  due: { type: 'string' },
  estimate: { type: 'string' },
  parent: { type: 'string' },
  body: { type: 'string' },
};

/** `today`, `tomorrow`, `+3d`, `+2w` or `YYYY-MM-DD`. */
export function parseDue(input: string, now: Date): string {
  const v = input.trim().toLowerCase();
  const day = new Date(now);
  if (v === 'today') return localDate(day);
  if (v === 'tomorrow') {
    day.setDate(day.getDate() + 1);
    return localDate(day);
  }
  const rel = /^\+(\d+)([dw])$/.exec(v);
  if (rel) {
    day.setDate(day.getDate() + Number(rel[1]) * (rel[2] === 'w' ? 7 : 1));
    return localDate(day);
  }
  if (!isValidDate(v)) throw new ValidationError(`Invalid date "${input}" (use YYYY-MM-DD, today, tomorrow, +3d, +2w)`);
  return v;
}

async function readBody(ctx: Ctx, v: string | undefined): Promise<string | undefined> {
  if (v === undefined) return undefined;
  return v === '-' ? (await ctx.io.readStdin()).replace(/\r\n/g, '\n') : v;
}

function parseEstimate(v: string): number {
  const n = Number(v);
  if (v.trim() === '' || !Number.isFinite(n)) throw new ValidationError(`Invalid estimate "${v}" (expected a number)`);
  return n;
}

function queryFromArgs(ctx: Ctx, { values }: Args): CardQuery {
  const q: CardQuery = {};
  const status = list(values.status);
  if (status.length) q.status = status;
  const type = splitCsv(list(values.type));
  if (type.length) q.type = type as CardType[];
  const priority = splitCsv(list(values.priority));
  if (priority.length) q.priority = priority as Priority[];
  const assignee = splitCsv(list(values.assignee));
  if (flag(values.mine)) {
    if (!ctx.config.me) throw new UsageError('--mine needs "me" in the board settings (Obsidian: Settings → Cards → My name, or `me` in data.json)');
    assignee.push('me');
  }
  if (assignee.length) q.assignee = assignee;
  const labels = splitCsv(list(values.label));
  if (labels.length) q.labels = labels;
  if (str(values.parent)) q.parent = str(values.parent);
  if (str(values.query)) q.text = str(values.query);
  q.includeArchived = flag(values.all);
  return q;
}

const selectCards = (ctx: Ctx, args: Args): Promise<Card[]> => ctx.svc.find(queryFromArgs(ctx, args));

/** Lists stay small: no description or comment texts, just how many comments there are. */
const withoutBody = ({ body: _body, comments, ...rest }: Card) => ({ ...rest, commentCount: comments.length });

function emit(ctx: Ctx, data: unknown): void {
  ctx.io.out(JSON.stringify(data, null, 2) + '\n');
}

function fieldsFromArgs(ctx: Ctx, values: Values): CardPatch {
  const p: CardPatch = {};
  if (str(values.status) !== undefined) p.status = str(values.status);
  if (str(values.type) !== undefined) p.type = str(values.type) as CardType;
  if (str(values.priority) !== undefined) p.priority = str(values.priority) as Priority;
  const assignee = str(values.assignee);
  if (assignee !== undefined) {
    p.assignee = isClear(assignee) ? null : assignee.toLowerCase() === 'me' && ctx.config.me ? ctx.config.me : assignee;
  }
  const due = str(values.due);
  if (due !== undefined) p.due = isClear(due) ? null : parseDue(due, ctx.now);
  const estimate = str(values.estimate);
  if (estimate !== undefined) p.estimate = isClear(estimate) ? null : parseEstimate(estimate);
  const parent = str(values.parent);
  if (parent !== undefined) p.parent = isClear(parent) ? null : parent;
  const labels = splitCsv(list(values.label));
  if (list(values.label).length) p.labels = labels.length === 1 && isClear(labels[0]!) ? [] : labels;
  return p;
}

const COMMANDS: Command[] = [
  {
    name: 'add',
    aliases: ['new', 'create'],
    summary: 'Create a card',
    usage: 'oprojects add <title…> [-t type] [-p priority] [-s status] [-a assignee] [-l label,…] [--due date] [--estimate n] [--parent KEY] [--body text|-]',
    examples: [
      'oprojects add Fix the login redirect -t bug -p high -a ana --due +3d',
      'oprojects add "Write release notes" -s doing -l docs,release',
      'echo "Steps to reproduce…" | oprojects add Crash on save -t bug --body -',
    ],
    options: { ...FIELD_OPTIONS },
    async run(ctx, args) {
      const title = args.positionals.join(' ').trim();
      if (!title) throw new UsageError('Missing title. Usage: oprojects add <title…>');
      const fields = fieldsFromArgs(ctx, args.values);
      const input: NewCardInput = {
        title,
        status: fields.status,
        type: fields.type,
        priority: fields.priority,
        assignee: fields.assignee ?? undefined,
        labels: fields.labels,
        due: fields.due ?? undefined,
        estimate: fields.estimate ?? undefined,
        parent: fields.parent ?? undefined,
        body: await readBody(ctx, str(args.values.body)),
      };
      const card = await ctx.svc.create(input);
      if (ctx.json) return emit(ctx, card);
      ctx.io.out(`${ctx.paint('green', 'Created')} ${ctx.paint('bold', card.key)}  ${card.title}\n${ctx.paint('gray', card.path)}\n`);
    },
  },
  {
    name: 'list',
    aliases: ['ls'],
    summary: 'List cards (hides done cards older than the board setting; --all shows them)',
    usage: 'oprojects list [-s status] [-t type] [-p priority] [-a assignee|none|me] [-l label] [--parent KEY] [-q text] [--mine] [--all]',
    examples: ['oprojects ls --mine', 'oprojects ls -s doing -s review', 'oprojects ls -q "login" -t bug --json'],
    options: { ...FILTER_OPTIONS },
    async run(ctx, args) {
      const cards = await selectCards(ctx, args);
      if (ctx.json) return emit(ctx, cards.map(withoutBody));
      ctx.io.out(renderTable(cards, ctx.config, ctx.paint, ctx.io.columns, ctx.now) + '\n');
    },
  },
  {
    name: 'board',
    aliases: ['b'],
    summary: 'Show the kanban board (epics are hidden unless --epics)',
    usage: 'oprojects board [same filters as list] [--epics]',
    options: { ...FILTER_OPTIONS, epics: { type: 'boolean' } },
    async run(ctx, args) {
      const cards = (await selectCards(ctx, args)).filter((c) => flag(args.values.epics) || c.type !== 'epic');
      if (ctx.json) {
        return emit(
          ctx,
          groupByColumn(cards, ctx.config).map(({ column, cards: cs }) => ({ column: column.id, name: column.name, done: !!column.done, wip: column.wip, cards: cs.map(withoutBody) })),
        );
      }
      ctx.io.out(renderBoard(cards, ctx.config, ctx.paint, ctx.io.columns, ctx.now) + '\n');
    },
  },
  {
    name: 'show',
    aliases: ['get'],
    summary: 'Show one card with its description',
    usage: 'oprojects show <key>',
    options: {},
    async run(ctx, args) {
      const key = args.positionals[0];
      if (!key) throw new UsageError('Missing card key. Usage: oprojects show <key>');
      const card = await ctx.svc.get(key);
      if (ctx.json) return emit(ctx, card);
      ctx.io.out(renderCard(card, ctx.config, ctx.paint, ctx.now) + '\n');
    },
  },
  {
    name: 'comment',
    aliases: ['c'],
    summary: 'Add, edit or remove a comment on a card',
    usage: 'oprojects comment <key> <text…|-> [--author name]   |   oprojects comment <key> --edit <id> <text…|->   |   oprojects comment <key> --rm <id>',
    examples: [
      'oprojects comment 12 "Reproduced on Safari, only there"',
      'git log -1 --format=%B | oprojects comment 12 -',
      'oprojects show 12            # comments are listed with their ids',
      'oprojects comment 12 --edit k3f9a "texto corrigido"',
      'oprojects comment 12 --rm k3f9a',
    ],
    options: { author: { type: 'string' }, edit: { type: 'string' }, rm: { type: 'string' } },
    async run(ctx, args) {
      const [key, ...words] = args.positionals;
      if (!key) throw new UsageError('Missing card key. Usage: oprojects comment <key> <text…>');
      const editId = str(args.values.edit);
      const rmId = str(args.values.rm);
      if (editId && rmId) throw new UsageError('Use either --edit or --rm, not both');

      let card: Card;
      let message: string;
      if (rmId) {
        if (words.length) throw new UsageError('--rm takes no text');
        card = await ctx.svc.removeComment(key, rmId);
        message = `${ctx.paint('yellow', 'Removed')} comment ${ctx.paint('gray', '#' + rmId)} from ${ctx.paint('bold', card.key)}`;
      } else {
        const joined = words.join(' ');
        const text = joined === '-' ? (await ctx.io.readStdin()).replace(/\r\n/g, '\n') : joined;
        if (!text.trim()) throw new UsageError('Missing comment text. Usage: oprojects comment <key> <text…>  (use - to read stdin)');
        if (editId) {
          card = await ctx.svc.editComment(key, editId, text);
          message = `${ctx.paint('green', 'Edited')} comment ${ctx.paint('gray', '#' + editId)} on ${ctx.paint('bold', card.key)}`;
        } else {
          const author = str(args.values.author) || ctx.config.me || ctx.io.env.USER || ctx.io.env.LOGNAME;
          card = await ctx.svc.addComment(key, { text, author });
          message = `${ctx.paint('green', 'Commented')} on ${ctx.paint('bold', card.key)} ${ctx.paint('gray', '#' + card.comments[card.comments.length - 1]!.id)}`;
        }
      }
      if (ctx.json) return emit(ctx, card);
      ctx.io.out(message + '\n');
    },
  },
  {
    name: 'move',
    aliases: ['mv'],
    summary: 'Move a card to another column (optionally next to a card)',
    usage: 'oprojects move <key> <status> [--before KEY | --after KEY]',
    examples: ['oprojects mv 12 doing', 'oprojects mv OP-12 review --before OP-3'],
    options: { before: { type: 'string' }, after: { type: 'string' } },
    async run(ctx, args) {
      const [key, status] = args.positionals;
      if (!key || !status) throw new UsageError('Usage: oprojects move <key> <status> [--before KEY | --after KEY]');
      const before = str(args.values.before);
      const after = str(args.values.after);
      if (before && after) throw new UsageError('Use either --before or --after, not both');
      const card = await ctx.svc.move(key, status, {
        before: before ? ctx.svc.resolveKey(before) : undefined,
        after: after ? ctx.svc.resolveKey(after) : undefined,
      });
      if (ctx.json) return emit(ctx, card);
      const col = ctx.config.columns.find((c) => c.id === card.status)!;
      ctx.io.out(`${ctx.paint('bold', card.key)} → ${ctx.paint('cyan', col.name)}\n`);
    },
  },
  {
    name: 'edit',
    aliases: ['set'],
    summary: 'Change fields of a card (use "none" to clear a field)',
    usage: 'oprojects edit <key> [--title t] [-s status] [-t type] [-p priority] [-a assignee|none] [-l label,…] [--add-label l] [--rm-label l] [--due date|none] [--estimate n|none] [--parent KEY|none] [--body text|-]',
    examples: ['oprojects edit 12 -p highest --due tomorrow', 'oprojects edit 12 -a none --add-label blocked'],
    options: { ...FIELD_OPTIONS, title: { type: 'string' }, 'add-label': { type: 'string', multiple: true }, 'rm-label': { type: 'string', multiple: true } },
    async run(ctx, args) {
      const key = args.positionals[0];
      if (!key) throw new UsageError('Missing card key. Usage: oprojects edit <key> [options]');
      const patch = fieldsFromArgs(ctx, args.values);
      if (str(args.values.title) !== undefined) patch.title = str(args.values.title);
      const body = await readBody(ctx, str(args.values.body));
      if (body !== undefined) patch.body = body.endsWith('\n') || body === '' ? body : body + '\n';
      const add = splitCsv(list(args.values['add-label']));
      const rm = splitCsv(list(args.values['rm-label']));
      if (add.length || rm.length) {
        const current = patch.labels ?? (await ctx.svc.get(key)).labels;
        const removed = new Set(rm.map((l) => l.toLowerCase()));
        patch.labels = [...current, ...add].filter((l) => !removed.has(l.toLowerCase()));
      }
      if (!Object.keys(patch).length) throw new UsageError('Nothing to change. Pass at least one option, e.g. --priority high');
      const card = await ctx.svc.update(key, patch);
      if (ctx.json) return emit(ctx, card);
      ctx.io.out(`${ctx.paint('green', 'Updated')} ${ctx.paint('bold', card.key)}  ${card.title}\n`);
    },
  },
  {
    name: 'rm',
    aliases: ['delete', 'remove'],
    summary: 'Delete a card (moved to the vault .trash, so it is recoverable)',
    usage: 'oprojects rm <key>',
    options: {},
    async run(ctx, args) {
      const key = args.positionals[0];
      if (!key) throw new UsageError('Missing card key. Usage: oprojects rm <key>');
      const card = await ctx.svc.remove(key);
      if (ctx.json) return emit(ctx, withoutBody(card));
      ctx.io.out(`${ctx.paint('yellow', 'Deleted')} ${ctx.paint('bold', card.key)}  ${card.title} ${ctx.paint('gray', '(in .trash)')}\n`);
    },
  },
  {
    name: 'open',
    summary: 'Open a card in Obsidian',
    usage: 'oprojects open <key> [--print]',
    options: { print: { type: 'boolean' } },
    async run(ctx, args) {
      const key = args.positionals[0];
      if (!key) throw new UsageError('Missing card key. Usage: oprojects open <key>');
      const card = await ctx.svc.get(key);
      const url = `obsidian://open?vault=${encodeURIComponent(path.basename(ctx.root))}&file=${encodeURIComponent(card.path.replace(/\.md$/, ''))}`;
      if (flag(args.values.print)) return void ctx.io.out(url + '\n');
      await ctx.io.openUrl(url);
      ctx.io.out(`Opening ${ctx.paint('bold', card.key)} in Obsidian…\n`);
    },
  },
  {
    name: 'config',
    summary: 'Show the board configuration in use',
    usage: 'oprojects config',
    options: {},
    async run(ctx) {
      if (ctx.json) return emit(ctx, { vault: ctx.root, ...ctx.config });
      const c = ctx.config;
      ctx.io.out(
        [
          `${ctx.paint('gray', 'vault   ')} ${ctx.root}`,
          `${ctx.paint('gray', 'folder  ')} ${c.folder}`,
          `${ctx.paint('gray', 'prefix  ')} ${c.prefix}`,
          `${ctx.paint('gray', 'me      ')} ${c.me || ctx.paint('gray', '(not set)')}`,
          `${ctx.paint('gray', 'columns ')} ${c.columns.map((col) => `${col.id}${col.done ? '✓' : ''}${col.wip ? `(wip ${col.wip})` : ''}`).join(' → ')}`,
        ].join('\n') + '\n',
      );
    },
  },
];

const INIT: Command = {
  name: 'init',
  summary: 'Set up the board in this vault (folder + project key)',
  usage: 'oprojects init [--prefix OP] [--folder Cards] [--me name] [--force]',
  options: { prefix: { type: 'string' }, folder: { type: 'string' }, me: { type: 'string' }, force: { type: 'boolean' } },
  async run(ctx, args) {
    const exists = await hasBoardConfig(ctx.root);
    const prefix = str(args.values.prefix)?.toUpperCase();
    const folder = str(args.values.folder);
    if (prefix !== undefined && !isValidPrefix(prefix)) throw new UsageError(`Invalid prefix "${prefix}" (2–10 chars, A–Z and digits, starting with a letter)`);
    if (exists && (prefix || folder) && !flag(args.values.force)) {
      throw new UsageError('This vault already has a board. Changing prefix/folder would orphan existing cards; pass --force if you really mean it.');
    }
    const config = normalizeConfig({
      ...ctx.config,
      ...(prefix ? { prefix } : {}),
      ...(folder !== undefined ? { folder: normalizeFolder(folder) || DEFAULT_CONFIG.folder } : {}),
      ...(str(args.values.me) !== undefined ? { me: str(args.values.me) } : {}),
    });
    if (exists && !prefix && folder === undefined && str(args.values.me) === undefined) {
      return void ctx.io.out(`Board already set up (${ctx.paint('bold', config.prefix)} in ${config.folder}/). Nothing to do.\n`);
    }
    await saveBoardConfig(ctx.root, config);
    await new FsStorage(ctx.root).create(`${config.folder}/.keep`, '').catch(() => undefined);
    ctx.io.out(
      `${ctx.paint('green', 'Board ready')}: cards are ${ctx.paint('bold', config.prefix + '-<n>')} notes in ${ctx.paint('bold', config.folder + '/')}\n` +
        `Next: ${ctx.paint('cyan', 'oprojects add "My first card"')}  then  ${ctx.paint('cyan', 'oprojects board')}\n`,
    );
  },
};

const ALL_COMMANDS = [...COMMANDS, INIT];

function findCommand(name: string): Command | undefined {
  return ALL_COMMANDS.find((c) => c.name === name || c.aliases?.includes(name));
}

function topHelp(paint: Painter): string {
  const rows = ALL_COMMANDS.map((c) => `  ${paint('bold', c.name.padEnd(8))} ${c.summary}`);
  return [
    `${paint('bold', 'oprojects')} ${VERSION} — Jira-style cards for your Obsidian vault`,
    '',
    paint('bold', 'Usage'),
    '  oprojects <command> [options]',
    '',
    paint('bold', 'Commands'),
    ...rows,
    '',
    paint('bold', 'Global options'),
    '  --vault <path>   Vault to use (default: $OPROJECTS_VAULT, else nearest parent with .obsidian)',
    '  --json           Machine-readable output',
    '  --no-color       Disable colors (also honors NO_COLOR)',
    '  -h, --help       Help for a command',
    '',
    `Run ${paint('cyan', 'oprojects <command> --help')} for details.`,
  ].join('\n');
}

function commandHelp(cmd: Command, paint: Painter): string {
  return [
    `${paint('bold', cmd.name)} — ${cmd.summary}`,
    '',
    paint('bold', 'Usage'),
    `  ${cmd.usage}`,
    ...(cmd.examples?.length ? ['', paint('bold', 'Examples'), ...cmd.examples.map((e) => `  ${e}`)] : []),
    '',
    paint('bold', 'Global options'),
    '  --vault <path>  --json  --no-color  -h/--help',
  ].join('\n');
}

/** Lets `--vault`, `--json` and `--no-color` appear anywhere, including before the command. */
function hoistGlobals(argv: string[]): string[] {
  const globals: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--vault') {
      globals.push(a);
      if (i + 1 < argv.length) globals.push(argv[++i]!);
    } else if (a.startsWith('--vault=') || a === '--json' || a === '--no-color') globals.push(a);
    else rest.push(a);
  }
  return [...rest, ...globals];
}

/** Entry point; returns the process exit code. */
export async function run(rawArgv: string[], io: IO): Promise<number> {
  const argv = hoistGlobals(rawArgv);
  const color = (io.isTTY || !!io.env.FORCE_COLOR) && !io.env.NO_COLOR && !argv.includes('--no-color');
  const paint = makePainter(color);

  const first = argv[0];
  if (!first || first === 'help' || first === '--help' || first === '-h') {
    const target = first === 'help' ? findCommand(argv[1] ?? '') : undefined;
    io.out((target ? commandHelp(target, paint) : topHelp(paint)) + '\n');
    return 0;
  }
  if (first === '--version' || first === '-v') {
    io.out(VERSION + '\n');
    return 0;
  }

  const cmd = findCommand(first);
  if (!cmd) {
    io.err(`${paint('red', 'error:')} unknown command "${first}". Run \`oprojects --help\`.\n`);
    return 2;
  }

  let json = false;
  try {
    const parsed = parseArgs({ args: argv.slice(1), options: { ...GLOBAL_OPTIONS, ...cmd.options }, allowPositionals: true, strict: true });
    const args: Args = { values: parsed.values as Values, positionals: parsed.positionals };
    json = flag(args.values.json);

    if (flag(args.values.help)) {
      io.out(commandHelp(cmd, paint) + '\n');
      return 0;
    }

    const root = await findVaultRoot(io.cwd, str(args.values.vault) ?? io.env.OPROJECTS_VAULT);
    const config = await loadBoardConfig(root);
    const svc = new CardService(new FsStorage(root), config, { now: io.now });
    await cmd.run({ io, root, config, svc, paint: makePainter(color && !json), json, now: io.now() }, args);
    return 0;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof UsageError || (e as NodeJS.ErrnoException)?.code?.startsWith?.('ERR_PARSE_ARGS')) {
      io.err(`${paint('red', 'error:')} ${msg}\n${paint('gray', `See: oprojects ${cmd.name} --help`)}\n`);
      return 2;
    }
    if (e instanceof ValidationError || e instanceof NotFoundError || e instanceof VaultNotFoundError || e instanceof ConfigError) {
      io.err(json ? JSON.stringify({ error: msg }) + '\n' : `${paint('red', 'error:')} ${msg}\n`);
      return 1;
    }
    io.err(`${paint('red', 'error:')} ${msg}\n`);
    return 1;
  }
}
