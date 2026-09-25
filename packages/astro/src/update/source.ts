import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Exec } from './exec.js';
import { extractTarball } from './tarball.js';
import { compareVersions, isStable } from './versions.js';

export const PLATFORM_PACKAGE = '@yatris/astro';

/**
 * Where platform releases come from. The npm registry is the channel
 * (decision 11.1): a platform release is the `@yatris/astro` version of the
 * same number, and its bundled `platform.json` is the release manifest.
 * `npm pack` checks the tarball against the registry's integrity record.
 *
 * Being published is not being approved. A version is a Yatris platform
 * release only when its `yatrisPlatform.status` is `released`, which a
 * release commit sets after the compatibility matrix (unit tests, the pack
 * smoke test and the end-to-end create-and-update run) has passed on it; the
 * bundled manifest must say the same, and the target CLI checks that too.
 * npm dist-tags such as `latest` are never consulted.
 */
export interface UpdateSource {
  /** Every published version, newest last. */
  versions(): Promise<string[]>;
  /** Whether a published version is an approved Yatris platform release. */
  approved(version: string): Promise<boolean>;
  /** Downloads and extracts one version; `installSpec` is what `npm install` is given. */
  fetch(version: string, into: string): Promise<{ packageDir: string; installSpec: string }>;
  /** A local mirror (testing, offline) may carry releases not marked released. */
  allowUnreleased: boolean;
}

export function registrySource(exec: Exec, cwd: string): UpdateSource {
  return {
    allowUnreleased: false,
    async versions() {
      const result = await exec(['npm', 'view', PLATFORM_PACKAGE, 'versions', '--json'], { cwd });
      if (result.code !== 0) {
        if (/E404|404 Not Found/.test(result.output)) return [];
        throw new Error(`could not list ${PLATFORM_PACKAGE} versions from npm:\n${result.output.trim()}`);
      }
      const parsed = JSON.parse(result.output) as string | string[];
      return sortVersions(Array.isArray(parsed) ? parsed : [parsed]);
    },
    async approved(version) {
      const result = await exec(['npm', 'view', `${PLATFORM_PACKAGE}@${version}`, 'yatrisPlatform', '--json'], { cwd });
      if (result.code !== 0 || result.output.trim() === '') return false;
      return (JSON.parse(result.output) as { status?: unknown }).status === 'released';
    },
    async fetch(version, into) {
      const spec = `${PLATFORM_PACKAGE}@${version}`;
      const result = await exec(['npm', 'pack', spec, '--pack-destination', into, '--json'], { cwd });
      if (result.code !== 0) throw new Error(`could not download ${spec}:\n${result.output.trim()}`);
      const [{ filename }] = JSON.parse(result.output.slice(result.output.indexOf('['))) as { filename: string }[];
      return { packageDir: extractTarball(join(into, filename), into), installSpec: spec };
    },
  };
}

/**
 * A directory of packed `@yatris/astro` tarballs (`yatris-astro-<version>.tgz`),
 * named by YATRIS_UPDATE_SOURCE: the release-matrix test updates a real site
 * through it without publishing anything.
 */
export function directorySource(dir: string): UpdateSource {
  const root = resolve(dir);
  const tarball = (version: string) => join(root, `yatris-astro-${version}.tgz`);
  return {
    allowUnreleased: true,
    async versions() {
      if (!existsSync(root)) throw new Error(`YATRIS_UPDATE_SOURCE ${root} does not exist`);
      return sortVersions(readdirSync(root).flatMap((name) => /^yatris-astro-(.+)\.tgz$/.exec(name)?.[1] ?? []));
    },
    // A local mirror is a test fixture; the downloaded manifest still decides
    async approved() {
      return true;
    },
    async fetch(version, into) {
      return { packageDir: extractTarball(tarball(version), into), installSpec: tarball(version) };
    },
  };
}

/** The newest stable version, or null. */
export function newestStable(versions: string[]): string | null {
  return sortVersions(versions.filter(isStable)).at(-1) ?? null;
}

/**
 * The newest approved stable release newer than `current`, or null. Newer
 * versions that are published but not approved are skipped and reported.
 */
export async function newestApproved(source: UpdateSource, versions: string[], current: string): Promise<{ version: string | null; skipped: string[] }> {
  const skipped: string[] = [];
  for (const version of sortVersions(versions.filter(isStable)).reverse()) {
    if (compareVersions(version, current) <= 0) break;
    if (await source.approved(version)) return { version, skipped };
    skipped.push(version);
  }
  return { version: null, skipped };
}

function sortVersions(versions: string[]): string[] {
  return [...versions].sort(compareVersions);
}
