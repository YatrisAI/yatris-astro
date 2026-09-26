import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Exec } from './exec.js';

/**
 * What makes a published `@yatris/astro` version an approved Yatris platform
 * release. A value in `package.json` alone is not enough, because anyone who
 * can publish could set it. The version must carry npm provenance (a
 * Sigstore-signed SLSA attestation the registry stores) showing it was built
 * and published by this exact workflow:
 *
 * - `.github/workflows/release.yml` in YatrisAI/yatris-astro, run on `main`;
 * - which runs only after a reviewer approves the `npm-release` environment;
 * - which runs the compatibility matrix (unit tests, the pack smoke test and
 *   the end-to-end create-and-update run) and only then sets the released
 *   marker and publishes.
 *
 * The attestation's subject must be the very tarball the registry serves
 * (its sha512), and `npm audit signatures` must verify the signatures.
 */
export const RELEASE_WORKFLOW = Object.freeze({
  repository: 'https://github.com/YatrisAI/yatris-astro',
  path: '.github/workflows/release.yml',
  ref: 'refs/heads/main',
} as const);

const SLSA_V1 = 'https://slsa.dev/provenance/v1';

export interface VersionMetadata {
  name?: string;
  version?: string;
  yatrisPlatform?: { status?: unknown };
  dist?: { integrity?: unknown; attestations?: { url?: unknown; provenance?: { predicateType?: unknown } } };
}

/** Null when the metadata and attestation show an approved release; otherwise why not. */
export function releaseRejection(meta: VersionMetadata, attestations: unknown): string | null {
  if (meta.yatrisPlatform?.status !== 'released') return 'it is not marked released';
  if (meta.dist?.attestations?.provenance?.predicateType !== SLSA_V1) return 'it has no npm provenance, so no approved release workflow published it';

  const bundle = ((attestations as { attestations?: { predicateType?: string; bundle?: { dsseEnvelope?: { payload?: string } } }[] })?.attestations ?? []).find(
    (a) => a.predicateType === SLSA_V1,
  );
  const payload = bundle?.bundle?.dsseEnvelope?.payload;
  if (!payload) return 'its provenance attestation could not be read';

  let statement: {
    subject?: { name?: string; digest?: { sha512?: string } }[];
    predicate?: { buildDefinition?: { externalParameters?: { workflow?: { repository?: string; path?: string; ref?: string } } } };
  };
  try {
    statement = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
  } catch {
    return 'its provenance attestation is malformed';
  }

  const workflow = statement.predicate?.buildDefinition?.externalParameters?.workflow;
  if (workflow?.repository !== RELEASE_WORKFLOW.repository || workflow?.path !== RELEASE_WORKFLOW.path || workflow?.ref !== RELEASE_WORKFLOW.ref) {
    return `it was published by ${workflow?.repository ?? '?'} ${workflow?.path ?? '?'} (${workflow?.ref ?? '?'}), not the Yatris release workflow`;
  }

  const integrity = typeof meta.dist?.integrity === 'string' ? meta.dist.integrity : '';
  const tarballDigest = integrity.startsWith('sha512-') ? Buffer.from(integrity.slice(7), 'base64').toString('hex') : null;
  const subject = statement.subject?.find((s) => s.name === `pkg:npm/${meta.name}@${meta.version}`) ?? statement.subject?.[0];
  if (tarballDigest === null || subject?.digest?.sha512 !== tarballDigest) return 'its provenance does not describe the tarball the registry serves';

  return null;
}

/**
 * Has npm verify the registry signature and the provenance attestation's
 * Sigstore signatures, in a throwaway project holding only this version (no
 * install scripts, no peer dependencies). Null when verified.
 */
export async function signatureRejection(spec: string, exec: Exec): Promise<string | null> {
  const dir = mkdtempSync(join(tmpdir(), 'yatris-verify-'));
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'yatris-verify', private: true, dependencies: { [spec.slice(0, spec.lastIndexOf('@'))]: spec.slice(spec.lastIndexOf('@') + 1) } }));
    const install = await exec(['npm', 'install', '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund'], { cwd: dir });
    if (install.code !== 0) return `it could not be fetched for verification:\n${install.output.trim()}`;

    const audit = await exec(['npm', 'audit', 'signatures'], { cwd: dir });
    if (audit.code !== 0 || /invalid|missing/i.test(audit.output)) return `npm could not verify its signatures:\n${audit.output.trim()}`;
    if (!/\b1 package has a verified attestation\b/.test(audit.output)) return 'npm found no verified provenance attestation for it';
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
