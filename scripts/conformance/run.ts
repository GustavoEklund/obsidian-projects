// npm run conformance         regenerate packages/mcp/tests/fixtures from the TypeScript core
// npm run conformance:check   fail when the committed fixtures are stale (a CI gate)
import { finish, isMain } from '../quality/lib';
import { loadGenerators, staleFixtures, writeAll } from './lib';

if (isMain(import.meta.url)) {
  const check = process.argv.includes('--check');
  loadGenerators()
    .then(async (generators) => {
      if (check) return finish('Conformance corpus', await staleFixtures(generators));
      const names = await writeAll(generators);
      console.log(
        `Wrote ${names.length} fixture file${names.length === 1 ? '' : 's'}: ${names.join(', ') || '(none yet)'}`,
      );
    })
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    });
}
