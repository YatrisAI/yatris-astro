import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Exec } from './exec.js';
import { releaseRejection, signatureRejection, type VersionMetadata } from './provenance.js';
import { extractTarball } from './tarball.js';
import { compareVersions, isStable } from './versions.js';

export const PLATFORM_PACKAGE = '@yatris/astro';

/**
 * Where platform releases come from. The npm registry is the channel
 * (decision 11.1): a platform release is the `@yatris/astro` version of the
 * same number, and its bundled `platform.json` is the release manifest.
 * `npm pack` checks the tarball against the registry's integrity record.
 *
 * Being published is not being approved (see provenance.ts): a version is a
 * Yatris platform release only when the approved release workflow published
 * it, which npm provenance proves, and marked it released. The bundled
 * manifest must say released too, and the target CLI checks that again.
 * npm dist-tags such as `latest` are never consulted.
 */
export interface UpdateSource {
  /** Every published version, newest last. */
  versions(): Promise<string[]>;
  /** Null when a published version is an approved Yatris platform release; otherwise why not. */
  rejection(version: string): Promise<string | null>;
  /** Downloads and extracts one version; `installSpec` is what `npm install` is given. */
  fetch(version: string, into: string): Promise<{ packageDir: string; installSpec: string }>;
  /** A local mirror (testing, offline) may carry releases not marked released. */
  allowUnreleased: boolean;
}

export function registrySource(exec: Exec, cwd: string, fetchJson: (url: string) => Promise<unknown> = defaultFetchJson): UpdateSource {
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
    async rejection(version) {
      const spec = `${PLATFORM_PACKAGE}@${version}`;
      const result = await exec(['npm', 'view', spec, 'name', 'version', 'yatrisPlatform', 'dist', '--json'], { cwd });
      if (result.code !== 0 || result.output.trim() === '') return 'its registry metadata could not be read';
      const meta = JSON.parse(result.output) as VersionMetadata;

      // Cheap checks first: the marker and a provenance record at all
      if (meta.yatrisPlatform?.status !== 'released') return 'it is not marked released';
      const url = meta.dist?.attestations?.url;
      if (typeof url !== 'string' || !url.startsWith('https://')) return 'it has no npm provenance, so no approved release workflow published it';

      let attestations: unknown;
      try {
        attestations = await fetchJson(url);
      } catch (error) {
        return `its provenance could not be fetched (${(error as Error).message})`;
      }
      return releaseRejection(meta, attestations) ?? (await signatureRejection(spec, exec));
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
    // A local mirror is a test fixture, named only by YATRIS_UPDATE_SOURCE on
    // the machine running the update; it has no provenance to check
    async rejection() {
      return null;
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
    const rejection = await source.rejection(version);
    if (rejection === null) return { version, skipped };
    skipped.push(`${version} (${rejection})`);
  }
  return { version: null, skipped };
}

async function defaultFetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function sortVersions(versions: string[]): string[] {
  return [...versions].sort(compareVersions);
}
