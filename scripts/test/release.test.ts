import { describe, expect, it } from 'vitest';
import {
  bump,
  compareVersions,
  extractNotes,
  parseVersion,
  problems,
  promoteUnreleased,
  unreleasedNotes,
  type RepoVersions,
} from '../release-lib';

describe('parseVersion', () => {
  it('accepts releases and pre-releases', () => {
    expect(parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, pre: [] });
    expect(parseVersion('0.2.0-beta.1')).toEqual({ major: 0, minor: 2, patch: 0, pre: ['beta', '1'] });
  });

  it('rejects anything that is not SemVer, including a "v" prefix and leading zeros', () => {
    for (const bad of ['v1.2.3', '1.2', '1.2.3.4', '01.2.3', '1.2.3-', '1.2.3-01', 'latest', ''])
      expect(() => parseVersion(bad)).toThrow(/not a valid SemVer/);
  });
});

describe('compareVersions', () => {
  it('orders by major, minor, patch', () => {
    expect(compareVersions('1.0.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareVersions('0.2.0', '0.10.0')).toBeLessThan(0);
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
  });

  it('follows the SemVer 2.0 pre-release precedence example', () => {
    const ordered = [
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
    ];
    for (let i = 0; i < ordered.length - 1; i++)
      expect(compareVersions(ordered[i]!, ordered[i + 1]!), `${ordered[i]} < ${ordered[i + 1]}`).toBeLessThan(0);
  });
});

describe('bump', () => {
  it('bumps major, minor and patch, resetting the lower parts', () => {
    expect(bump('0.1.0', 'patch')).toBe('0.1.1');
    expect(bump('0.1.4', 'minor')).toBe('0.2.0');
    expect(bump('1.4.2', 'major')).toBe('2.0.0');
  });

  it('accepts an explicit version', () => {
    expect(bump('0.1.0', '0.2.0-beta.1')).toBe('0.2.0-beta.1');
    expect(bump('0.1.0', '1.0.0')).toBe('1.0.0');
  });

  it('promotes a pre-release to its release like npm does', () => {
    expect(bump('0.2.0-beta.1', 'minor')).toBe('0.2.0');
    expect(bump('0.1.1-rc.1', 'patch')).toBe('0.1.1');
    expect(bump('1.0.0-rc.1', 'major')).toBe('1.0.0');
    expect(bump('0.2.1-beta.1', 'minor')).toBe('0.3.0'); // not the release of a minor: a real bump
  });

  it('rejects unknown specs', () => {
    expect(() => bump('0.1.0', 'huge')).toThrow(/Unknown bump/);
  });
});

const CHANGELOG = `# Changelog

## [Unreleased]

### Added

- Something new.

## [0.2.0] - 2026-11-01

### Changed

- **BREAKING:** the thing.

### Fixed

- A bug.

## [0.1.0] - 2026-10-15

Initial release.

[Unreleased]: https://github.com/o/r/compare/0.2.0...HEAD
[0.2.0]: https://github.com/o/r/compare/0.1.0...0.2.0
[0.1.0]: https://github.com/o/r/releases/tag/0.1.0
`;

describe('changelog', () => {
  it('extracts one version without its heading, subheadings included, stopping at the next version', () => {
    expect(extractNotes(CHANGELOG, '0.2.0')).toBe('### Changed\n\n- **BREAKING:** the thing.\n\n### Fixed\n\n- A bug.');
    expect(extractNotes(CHANGELOG, '0.1.0')).toBe('Initial release.');
  });

  it('returns null for a missing or empty section (a release must not ship without notes)', () => {
    expect(extractNotes(CHANGELOG, '9.9.9')).toBeNull();
    expect(extractNotes('## [1.0.0] - 2026-01-01\n\n## [0.9.0] - 2025-01-01\nx\n', '1.0.0')).toBeNull();
    expect(extractNotes(CHANGELOG, '0.2')).toBeNull(); // 0.2 is not 0.2.0
  });

  it('does not mistake 0.1.0 for 10.1.0 or 0.1.01', () => {
    expect(extractNotes('## [10.1.0] - 2026-01-01\nnope\n', '0.1.0')).toBeNull();
  });

  it('reads what is waiting under Unreleased', () => {
    expect(unreleasedNotes(CHANGELOG)).toBe('### Added\n\n- Something new.');
    expect(unreleasedNotes('## [Unreleased]\n\n## [0.1.0] - 2026-10-15\nx\n')).toBe('');
  });

  it('promotes Unreleased: dates the section, leaves a fresh Unreleased and moves the compare links', () => {
    const out = promoteUnreleased(CHANGELOG, '0.3.0', '2026-12-01');
    expect(out).toContain('## [Unreleased]\n\n## [0.3.0] - 2026-12-01\n\n### Added\n\n- Something new.');
    expect(unreleasedNotes(out)).toBe('');
    expect(extractNotes(out, '0.3.0')).toBe('### Added\n\n- Something new.');
    expect(out).toContain(
      '[Unreleased]: https://github.com/o/r/compare/0.3.0...HEAD\n[0.3.0]: https://github.com/o/r/compare/0.2.0...0.3.0\n[0.2.0]:',
    );
  });

  it('refuses to release with nothing written, or without an Unreleased section', () => {
    expect(() => promoteUnreleased('## [Unreleased]\n\n## [0.1.0] - 2026-10-15\nx\n', '0.2.0', '2026-01-01')).toThrow(
      /Nothing under/,
    );
    expect(() => promoteUnreleased('# Changelog\n', '0.2.0', '2026-01-01')).toThrow(/no "## \[Unreleased\]"/);
  });
});

describe('problems', () => {
  const consistent = (): RepoVersions => ({
    packages: { 'package.json': '0.2.0', 'packages/core/package.json': '0.2.0' },
    manifest: { version: '0.2.0', minAppVersion: '1.8.0' },
    versions: { '0.1.0': '1.8.0', '0.2.0': '1.8.0' },
    lock: { '': '0.2.0', 'packages/core': '0.2.0' },
    changelog: CHANGELOG,
  });

  it('is empty when everything agrees', () => {
    expect(problems(consistent())).toEqual([]);
    expect(problems(consistent(), { tag: '0.2.0', requireChangelog: true })).toEqual([]);
  });

  it('flags a package, a lock entry or versions.json that disagrees with the manifest', () => {
    const r = consistent();
    r.packages['packages/core/package.json'] = '0.1.0';
    r.lock['packages/core'] = '0.1.0';
    r.versions['0.2.0'] = '1.4.0';
    const found = problems(r).join('\n');
    expect(found).toContain('packages/core/package.json: version is 0.1.0');
    expect(found).toContain('package-lock.json (packages/core)');
    expect(found).toContain('versions.json: "0.2.0" should map to 1.8.0');
  });

  it('flags a tag that is not exactly the version (no "v" prefix) and a missing changelog entry', () => {
    expect(problems(consistent(), { tag: 'v0.2.0' }).join()).toContain('does not match the version 0.2.0');
    const r = consistent();
    r.manifest.version = '0.3.0';
    r.packages = { 'package.json': '0.3.0' };
    r.lock = { '': '0.3.0' };
    r.versions['0.3.0'] = '1.8.0';
    expect(problems(r, { requireChangelog: true }).join()).toContain('no filled-in "## [0.3.0]"');
  });

  it('flags an invalid manifest version', () => {
    const r = consistent();
    r.manifest.version = 'v1';
    expect(problems(r)[0]).toContain('not a valid SemVer');
  });
});
