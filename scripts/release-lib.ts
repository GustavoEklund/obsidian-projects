// Pure helpers behind `scripts/release.ts`: SemVer arithmetic, consistency checks between every file that
// carries a version, and the CHANGELOG ("Keep a Changelog" format) edits a release needs.

export const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/;

export interface Version {
  major: number;
  minor: number;
  patch: number;
  pre: string[];
}

export function parseVersion(text: string): Version {
  const m = SEMVER_RE.exec(text);
  if (!m) throw new Error(`"${text}" is not a valid SemVer version (expected x.y.z or x.y.z-prerelease)`);
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split('.') : [] };
}

export const formatVersion = (v: Version): string =>
  `${v.major}.${v.minor}.${v.patch}${v.pre.length ? `-${v.pre.join('.')}` : ''}`;

/** SemVer 2.0 precedence (section 11): negative if a < b, 0 if equal, positive if a > b. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (const k of ['major', 'minor', 'patch'] as const) if (x[k] !== y[k]) return x[k] - y[k];
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length; // a release outranks its pre-releases
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1; // numeric identifiers rank below alphanumeric ones
    return p < q ? -1 : 1;
  }
  return 0;
}

/**
 * The next version for `spec`: `major`, `minor`, `patch`, or an explicit version. Like `npm version`,
 * bumping a pre-release to its own release (0.2.0-beta.1 → `minor`) just drops the suffix.
 */
export function bump(current: string, spec: string): string {
  if (SEMVER_RE.test(spec)) return spec;
  const v = parseVersion(current);
  const promotes = v.pre.length > 0;
  if (spec === 'major')
    return formatVersion({
      major: promotes && v.minor === 0 && v.patch === 0 ? v.major : v.major + 1,
      minor: 0,
      patch: 0,
      pre: [],
    });
  if (spec === 'minor')
    return formatVersion({
      major: v.major,
      minor: promotes && v.patch === 0 ? v.minor : v.minor + 1,
      patch: 0,
      pre: [],
    });
  if (spec === 'patch')
    return formatVersion({ major: v.major, minor: v.minor, patch: promotes ? v.patch : v.patch + 1, pre: [] });
  throw new Error(
    `Unknown bump "${spec}". Use major, minor, patch, or an explicit version such as 1.2.3 or 1.3.0-beta.1`,
  );
}

// --- consistency ---------------------------------------------------------------------------------------

export interface RepoVersions {
  /** `version` of the root package.json and of each workspace package.json, keyed by file path. */
  packages: Record<string, string | undefined>;
  /** `version` and `minAppVersion` of the plugin manifest. */
  manifest: { version?: string; minAppVersion?: string };
  /** versions.json: plugin version → minimum Obsidian version. */
  versions: Record<string, string>;
  /** `version` of the root and each workspace entry in package-lock.json, keyed by lock path. */
  lock: Record<string, string | undefined>;
  /** The Rust crate's version in Cargo.toml and in Cargo.lock, keyed by a label such as `packages/mcp/Cargo.toml`. */
  cargo?: Record<string, string | undefined>;
  changelog: string;
}

/** Everything wrong with the repo's version metadata. Empty means consistent. */
export function problems(r: RepoVersions, opts: { tag?: string; requireChangelog?: boolean } = {}): string[] {
  const out: string[] = [];
  const version = r.manifest.version;
  if (!version || !SEMVER_RE.test(version)) return [`manifest.json: "${version ?? ''}" is not a valid SemVer version`];

  for (const [file, v] of Object.entries(r.packages))
    if (v !== version) out.push(`${file}: version is ${v ?? 'missing'}, manifest.json says ${version}`);
  for (const [path, v] of Object.entries(r.lock))
    if (v !== version)
      out.push(`package-lock.json (${path || 'root'}): version is ${v ?? 'missing'}, manifest.json says ${version}`);
  for (const [label, v] of Object.entries(r.cargo ?? {}))
    if (v !== version) out.push(`${label}: version is ${v ?? 'missing'}, manifest.json says ${version}`);

  if (!r.manifest.minAppVersion) out.push('manifest.json: minAppVersion is missing');
  else if (r.versions[version] !== r.manifest.minAppVersion)
    out.push(
      `versions.json: "${version}" should map to ${r.manifest.minAppVersion} (manifest minAppVersion), found ${r.versions[version] ?? 'nothing'}`,
    );
  for (const v of Object.keys(r.versions))
    if (!SEMVER_RE.test(v)) out.push(`versions.json: "${v}" is not a valid SemVer version`);

  if (opts.tag !== undefined && opts.tag !== version)
    out.push(
      `the tag "${opts.tag}" does not match the version ${version}: Obsidian requires the release tag to equal manifest.json's version (no "v" prefix)`,
    );
  if (opts.requireChangelog && extractNotes(r.changelog, version) === null)
    out.push(`CHANGELOG.md has no filled-in "## [${version}]" section`);
  return out;
}

// --- Cargo files ---------------------------------------------------------------------------------------------------

const CARGO_PACKAGE_VERSION_RE = /(^\[package\]\r?\n(?:[^[\r\n][^\r\n]*\r?\n|\r?\n)*?version\s*=\s*")([^"]*)(")/m;

/** The `version` of the `[package]` table in a Cargo.toml, or undefined. */
export function cargoTomlVersion(toml: string): string | undefined {
  return CARGO_PACKAGE_VERSION_RE.exec(toml)?.[2];
}

/** Cargo.toml with the `[package]` version replaced (nothing else touched). */
export function setCargoTomlVersion(toml: string, version: string): string {
  if (!CARGO_PACKAGE_VERSION_RE.test(toml)) throw new Error('Cargo.toml has no [package] version to update');
  return toml.replace(CARGO_PACKAGE_VERSION_RE, `$1${version}$3`);
}

const lockEntryRe = (crate: string) =>
  new RegExp(
    `(\\[\\[package\\]\\]\\r?\\nname = "${crate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\r?\\nversion = ")([^"]*)(")`,
  );

/** The version of `crate` in a Cargo.lock, or undefined when it is not listed. */
export function cargoLockVersion(lock: string, crate: string): string | undefined {
  return lockEntryRe(crate).exec(lock)?.[2];
}

/** Cargo.lock with the entry of `crate` set to `version`. `cargo build --locked` would refuse a stale lock. */
export function setCargoLockVersion(lock: string, crate: string, version: string): string {
  if (!lockEntryRe(crate).test(lock)) throw new Error(`Cargo.lock has no entry for ${crate} to update`);
  return lock.replace(lockEntryRe(crate), `$1${version}$3`);
}

// --- changelog -------------------------------------------------------------------------------------------

const UNRELEASED_RE = /^## \[Unreleased\][ \t]*$/m;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The body of `## [version] - date` (without the heading), trimmed; null when missing or empty. */
export function extractNotes(changelog: string, version: string): string | null {
  const heading = new RegExp(`^## \\[${escapeRe(version)}\\](?:[ \\t]+-[ \\t]+\\S+)?[ \\t]*$`, 'm').exec(changelog);
  if (!heading) return null;
  const rest = changelog.slice(heading.index + heading[0].length);
  const next = /^(?:## |\[[^\]]+\]: )/m.exec(rest);
  const body = (next ? rest.slice(0, next.index) : rest).trim();
  return body || null;
}

/** What is waiting under `## [Unreleased]`, trimmed (empty string when nothing is). */
export function unreleasedNotes(changelog: string): string {
  const m = UNRELEASED_RE.exec(changelog);
  if (!m) return '';
  const rest = changelog.slice(m.index + m[0].length);
  const next = /^(?:## |\[[^\]]+\]: )/m.exec(rest);
  return (next ? rest.slice(0, next.index) : rest).trim();
}

/**
 * Turns `## [Unreleased]` into `## [version] - date`, leaves a fresh empty `## [Unreleased]` above it, and
 * moves the compare links at the bottom along ([Unreleased] now compares from the new version).
 */
export function promoteUnreleased(changelog: string, version: string, date: string): string {
  if (!UNRELEASED_RE.test(changelog)) throw new Error('CHANGELOG.md has no "## [Unreleased]" section');
  if (!unreleasedNotes(changelog))
    throw new Error('Nothing under "## [Unreleased]" in CHANGELOG.md: describe the changes before releasing');
  let out = changelog.replace(UNRELEASED_RE, `## [Unreleased]\n\n## [${version}] - ${date}`);

  const link = /^\[Unreleased\]: (\S+?)\/compare\/(\S+?)\.\.\.HEAD[ \t]*$/m.exec(out);
  if (link) {
    const [line, repo, previous] = link as unknown as [string, string, string];
    out = out.replace(
      line,
      `[Unreleased]: ${repo}/compare/${version}...HEAD\n[${version}]: ${repo}/compare/${previous}...${version}`,
    );
  }
  return out;
}
