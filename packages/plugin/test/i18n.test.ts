import { afterEach, describe, expect, it } from 'vitest';
import { dictionaries, getLocale, setLanguage, t, timeAgo } from '../src/i18n';

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('i18n', () => {
  afterEach(() => setLanguage('en'));

  it('every language defines every key, with the same placeholders as English', () => {
    for (const [lang, dict] of Object.entries(dictionaries)) {
      for (const [key, english] of Object.entries(dictionaries.en!)) {
        const text = (dict as Record<string, string>)[key];
        expect(text, `${lang}:${key}`).toBeTruthy();
        expect(placeholders(text!), `${lang}:${key}`).toEqual(placeholders(english));
      }
    }
  });

  it('picks the dictionary from the Obsidian language code and falls back to English', () => {
    setLanguage('pt-BR');
    expect(getLocale()).toBe('pt');
    expect(t('cancel')).not.toBe(dictionaries.en!.cancel);
    setLanguage('pt_BR');
    expect(getLocale()).toBe('pt');
    setLanguage('de');
    expect(getLocale()).toBe('en');
    expect(t('cancel')).toBe(dictionaries.en!.cancel);
    setLanguage(undefined);
    expect(getLocale()).toBe('en');
  });

  it('fills placeholders and leaves unknown ones visible', () => {
    expect(t('time.created', { when: 'today' })).toBe('Created today');
    expect(t('time.created', {})).toBe('Created {when}');
  });

  it('formats relative times in the active language', () => {
    const now = new Date('2026-10-15T12:00:00Z');
    expect(timeAgo('2026-10-12T12:00:00Z', now)).toBe('3 days ago');
    expect(timeAgo(undefined, now)).toBe('');
    expect(timeAgo('not a date', now)).toBe('');
  });
});
