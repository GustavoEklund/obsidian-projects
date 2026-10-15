import { describe, expect, it } from 'vitest';
import { ALLOWED_FILES, ALLOW_MARKER, findPortuguese, scan } from '../quality/language';
import { readText, repoFiles } from '../quality/lib';

describe('findPortuguese', () => {
  it('flags the letters that only Portuguese uses', () => {
    expect(findPortuguese('a ação foi concluída')).toHaveLength(1);
    expect(findPortuguese('coração')[0]?.why).toContain('"ã"');
    expect(findPortuguese('pão')[0]?.why).toContain('"ã"');
    expect(findPortuguese('limões')[0]?.why).toContain('"õ"');
  });

  it('flags a single strong word', () => {
    for (const line of [
      'Isso funciona',
      'Você pode editar',
      'não faz nada',
      'Fica também salvo',
      'SÃO PAULO',
      'porque sim',
    ]) {
      expect(findPortuguese(line), line).toHaveLength(1);
    }
  });

  it('needs two weak words on the same line', () => {
    expect(findPortuguese('Adicionar uma coluna para o quadro')).toHaveLength(1);
    expect(findPortuguese('todos os cards sem dono')).toHaveLength(1);
    expect(findPortuguese('const para = 1;')).toEqual([]);
    expect(findPortuguese('the word uma alone')).toEqual([]);
    expect(findPortuguese('uma\npara')).toEqual([]); // on different lines
  });

  it('matches whole words only', () => {
    expect(findPortuguese('parameters and umbrella, nosy sematic, caravan')).toEqual([]);
    expect(findPortuguese('the passage of the muito-long-name')).toEqual([]);
  });

  it('leaves English, code, URLs and other languages alone', () => {
    const fine = [
      'The user can add a comment to the card.',
      'See https://example.com/a/very/long/path?query=param',
      "const { a, b } = require('x');",
      'Résumé parser',
      'Reproduced in the Café app',
      'Straße, Zoë, 日本語, 🚀',
      'Çharlie crème brûlée, façade, Français', // ç is shared with French, Catalan and Turkish
      'A DoS attack',
      'ou est le café', // French: one weak word
      '| Column A | Column B |',
    ];
    for (const line of fine) expect(findPortuguese(line), line).toEqual([]);
  });

  it('skips lines that carry the allow marker', () => {
    expect(findPortuguese(`Isso não funciona // ${ALLOW_MARKER}`)).toEqual([]);
    expect(findPortuguese(`Isso não funciona\nOutra coisa não // ${ALLOW_MARKER}`)).toHaveLength(1);
  });

  it('reports 1-based line numbers and a trimmed excerpt', () => {
    const [finding] = findPortuguese('first line\nsecond line\n    Você precisa disso   \n');
    expect(finding).toMatchObject({ line: 3, text: 'Você precisa disso' });
  });
});

describe('scan', () => {
  const files: Record<string, string | null> = {
    'README.md': 'All good here.',
    'docs/pt.md': 'Isso está escrito em outra língua.',
    'logo.png': null,
    'packages/plugin/src/i18n.ts': "'cancel': 'Cancelar', // não é inglês",
  };

  it('reports file:line for every offending line and nothing else', () => {
    const problems = scan(Object.keys(files), (f) => files[f] ?? null);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(
      /^docs\/pt\.md:1: looks like Portuguese \(the word "isso"\): Isso está escrito em outra língua\.$/,
    );
  });

  it('skips the allowed files and binary files', () => {
    expect(ALLOWED_FILES.has('packages/plugin/src/i18n.ts')).toBe(true);
    expect(scan(['logo.png', 'packages/plugin/src/i18n.ts'], (f) => files[f] ?? null)).toEqual([]);
  });
});

describe('the repository', () => {
  it('has no Portuguese outside the interface dictionary', () => {
    expect(scan(repoFiles(), (f) => readText(f))).toEqual([]);
  });
});
