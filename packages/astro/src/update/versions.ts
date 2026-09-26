/** Just enough semver for platform releases, which are always exact versions. */

interface Parsed {
  major: number;
  minor: number;
  patch: number;
  pre: string | null;
}

const VERSION = /(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/;

export function parseVersion(value: string): Parsed | null {
  const match = VERSION.exec(value);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre: match[4] ?? null };
}

/** Stable channel only (decision 11.2): no prerelease versions. */
export function isStable(version: string): boolean {
  const parsed = parseVersion(version);
  return parsed !== null && parsed.pre === null && /^\d+\.\d+\.\d+$/.test(version);
}

export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) throw new Error(`cannot compare versions ${a} and ${b}`);
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (x[key] !== y[key]) return x[key] - y[key];
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/**
 * Whether moving from `from` to `to` is a breaking (major) change: the major
 * version, or the minor while the major is still 0, as npm's caret reads it.
 */
export function isMajorChange(from: string, to: string): boolean {
  const x = parseVersion(from);
  const y = parseVersion(to);
  if (!x || !y) return false;
  if (x.major !== y.major) return true;
  return x.major === 0 && x.minor !== y.minor;
}

/** Whether the running Node satisfies a manifest requirement such as ">=22.12.0". */
export function nodeSatisfies(requirement: string, version = process.versions.node): boolean {
  const match = /^>=\s*(\d+\.\d+\.\d+)$/.exec(requirement.trim());
  if (!match) return true;
  return compareVersions(version, match[1]) >= 0;
}
