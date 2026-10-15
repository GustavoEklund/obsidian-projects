// A tiny fixture that proves the pipeline end to end (TypeScript generates, Rust reads). Real modules add their own files.
import { DEFAULT_CONFIG, PRIORITIES, CARD_TYPES } from '@oprojects/core';
import type { FixtureFile } from './lib';

export const name = 'smoke';

export function generate(): FixtureFile {
  return {
    description: 'Constants the Rust crate must mirror: priorities, card types and the default board config.',
    cases: [
      { id: 'priorities', input: null, expected: [...PRIORITIES] },
      { id: 'card-types', input: null, expected: [...CARD_TYPES] },
      { id: 'default-config', input: null, expected: DEFAULT_CONFIG },
    ],
  };
}
