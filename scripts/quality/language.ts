// English-only gate: source code, tests, sample data and documentation are written in English. The one exception is the
// interface dictionary (packages/plugin/src/i18n.ts), which may carry other languages as alternatives.
//
//   npm run check:language
//
// The detector is a heuristic tuned for Portuguese: it flags a line that has a Portuguese-only letter or a strong
// Portuguese word, or two weak ones. A line that must keep such text on purpose can carry `language-gate: allow`.
import { finish, isMain, readText, repoFiles } from './lib';

/** Files that are allowed to contain other languages. */
export const ALLOWED_FILES: ReadonlySet<string> = new Set([
  'packages/plugin/src/i18n.ts',
  'package-lock.json',
  'scripts/quality/language.ts', // its word lists
  'scripts/test/language.test.ts', // its samples
]);
export const ALLOW_MARKER = 'language-gate: allow';

// ã and õ are Portuguese's own; ç is shared with French, Catalan and Turkish, so it proves nothing.
const SPECIFIC_LETTERS = /[ãõ]/iu;
const STRONG = [
  'não',
  'você',
  'vocês',
  'também',
  'então',
  'porque',
  'isso',
  'esse',
  'essa',
  'está',
  'estão',
  'são',
  'já',
  'só',
  'até',
  'aqui',
  'agora',
  'ainda',
  'sempre',
  'depois',
];
const WEAK = [
  'para',
  'uma',
  'dos',
  'das',
  'nos',
  'nas',
  'mais',
  'menos',
  'muito',
  'muita',
  'cada',
  'todos',
  'todas',
  'sem',
  'ou',
  'pelo',
  'pela',
  'onde',
  'antes',
  'tem',
  'foi',
  'será',
  'quando',
];

const wordRe = (words: string[]) => new RegExp(`(?<!\\p{L})(?:${words.join('|')})(?!\\p{L})`, 'gu');
const STRONG_RE = wordRe(STRONG);
const WEAK_RE = wordRe(WEAK);

export interface Finding {
  line: number;
  text: string;
  why: string;
}

/** Lines of `text` that look Portuguese. */
export function findPortuguese(text: string): Finding[] {
  const found: Finding[] = [];
  text.split('\n').forEach((raw, i) => {
    if (raw.includes(ALLOW_MARKER)) return;
    const line = raw.toLowerCase();
    const letter = SPECIFIC_LETTERS.exec(line);
    const strong = line.match(STRONG_RE);
    const weak = new Set(line.match(WEAK_RE) ?? []);
    let why = '';
    if (letter) why = `the letter "${letter[0]}"`;
    else if (strong) why = `the word "${strong[0]}"`;
    else if (weak.size >= 2) why = `the words "${[...weak].slice(0, 3).join('", "')}"`;
    if (why) found.push({ line: i + 1, text: raw.trim().slice(0, 100), why });
  });
  return found;
}

/** Findings for the given files (`read` returns null for binary files). */
export function scan(files: string[], read: (file: string) => string | null): string[] {
  const problems: string[] = [];
  for (const file of files) {
    if (ALLOWED_FILES.has(file)) continue;
    const text = read(file);
    if (text === null) continue;
    for (const f of findPortuguese(text))
      problems.push(`${file}:${f.line}: looks like Portuguese (${f.why}): ${f.text}`);
  }
  return problems;
}

if (isMain(import.meta.url)) {
  finish(
    'English-only gate',
    scan(repoFiles(), (f) => readText(f)),
  );
}
