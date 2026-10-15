import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'scripts/test/**/*.test.ts'],
    environment: 'node', // UI tests opt into jsdom with a `// @vitest-environment jsdom` docblock
    testTimeout: 30_000, // property and performance tests slow down a lot when CPUs are busy or coverage is on
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts', 'scripts/release.ts', 'scripts/release-lib.ts', 'scripts/quality/**/*.ts'],
      exclude: [
        'packages/cli/src/main.ts', // process bootstrap: exercised on the built bundle by scripts/smoke-test.mjs
        'packages/plugin/src/{main,view,settings,obsidian-platform}.ts', // Obsidian glue: exercised by `npm run test:obsidian`
      ],
      // A ratchet, not a goal: set a little under what the suite achieves, so that a real drop fails CI. Raise them
      // when coverage rises; never lower one to get a change through.
      thresholds: {
        lines: 96,
        statements: 96,
        functions: 96,
        branches: 93,
        'packages/core/src/**': { lines: 98, statements: 98, functions: 98, branches: 95 },
        'packages/cli/src/**': { lines: 98, statements: 98, functions: 98, branches: 95 },
        'packages/plugin/src/**': { lines: 98, statements: 98, functions: 98, branches: 95 },
        'scripts/**': { lines: 80, statements: 80, functions: 75, branches: 75 },
      },
      reporter: ['text', 'json-summary', 'lcov'],
      reportsDirectory: 'coverage',
    },
  },
});
