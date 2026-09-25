import { readFileSync } from 'node:fs';

/**
 * A Yatris platform release: the set of package, template, skill-pack and
 * framework versions that Yatris has tested together. Managed sites move
 * between platform releases, never between independently chosen `latest`
 * versions.
 */
export interface PlatformManifest {
  manifestVersion: 1;
  platformVersion: string;
  channel: 'stable';
  status: 'unreleased' | 'released';
  node: string;
  packages: Record<string, string>;
  template: string;
  skills: string;
  dependencies: Record<string, string>;
  migrations: string[];
  /** The Yatris product MCP every generated site's agents connect to. */
  mcp: { url: string };
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** The manifest shipped inside this package (copied in at build time). */
export const bundledManifestUrl = new URL('../platform.json', import.meta.url);

export function readPlatformManifest(url: URL = bundledManifestUrl): PlatformManifest {
  return parsePlatformManifest(JSON.parse(readFileSync(url, 'utf8')));
}

export function parsePlatformManifest(value: unknown): PlatformManifest {
  const m = record(value, 'manifest');

  if (m.manifestVersion !== 1) {
    throw new Error(`Unsupported platform manifestVersion: ${String(m.manifestVersion)}`);
  }
  if (m.channel !== 'stable') {
    throw new Error(`Unsupported platform channel: ${String(m.channel)}`);
  }
  if (m.status !== 'unreleased' && m.status !== 'released') {
    throw new Error(`Invalid platform status: ${String(m.status)}`);
  }

  const packages = versionMap(m.packages, 'packages');
  for (const name of ['@yatris/astro', 'create-yatris']) {
    if (!(name in packages)) {
      throw new Error(`Platform manifest is missing package ${name}`);
    }
  }

  if (!Array.isArray(m.migrations) || m.migrations.some((id) => typeof id !== 'string')) {
    throw new Error('Platform manifest migrations must be a list of migration ids');
  }

  return {
    manifestVersion: 1,
    platformVersion: semver(m.platformVersion, 'platformVersion'),
    channel: 'stable',
    status: m.status,
    node: string(m.node, 'node'),
    packages,
    template: semver(m.template, 'template'),
    skills: semver(m.skills, 'skills'),
    dependencies: versionMap(m.dependencies, 'dependencies'),
    migrations: m.migrations as string[],
    mcp: { url: mcpUrl(record(m.mcp, 'mcp').url) },
  };
}

function mcpUrl(value: unknown): string {
  const url = string(value, 'mcp.url');
  if (!/^https:\/\/[^/]+\/.+/.test(url)) {
    throw new Error(`Platform mcp.url must be an https URL, got ${url}`);
  }
  return url;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Platform ${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`Platform ${field} must be a non-empty string`);
  }
  return value;
}

function semver(value: unknown, field: string): string {
  const version = string(value, field);
  if (!SEMVER.test(version)) {
    throw new Error(`Platform ${field} must be an exact version, got ${version}`);
  }
  return version;
}

function versionMap(value: unknown, field: string): Record<string, string> {
  const entries = Object.entries(record(value, field));
  return Object.fromEntries(entries.map(([name, version]) => [name, semver(version, `${field}.${name}`)]));
}
