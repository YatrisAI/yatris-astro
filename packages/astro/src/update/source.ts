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
 */
export interface UpdateSource {
  /** Every published version, newest last. */
  versions(): Promise<string[]>;
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
    async fetch(version, into) {
      return { packageDir: extractTarball(tarball(version), into), installSpec: tarball(version) };
    },
  };
}

/** The newest stable version, or null. */
export function newestStable(versions: string[]): string | null {
  return sortVersions(versions.filter(isStable)).at(-1) ?? null;
}

function sortVersions(versions: string[]): string[] {
  return [...versions].sort(compareVersions);
}
