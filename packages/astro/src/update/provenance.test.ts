import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Exec } from './exec.js';
import { RELEASE_WORKFLOW, releaseRejection, type VersionMetadata } from './provenance.js';
import { registrySource } from './source.js';

const TARBALL = Buffer.from('the published tarball');
const integrity = `sha512-${createHash('sha512').update(TARBALL).digest('base64')}`;
const sha512 = createHash('sha512').update(TARBALL).digest('hex');

/** Registry metadata and attestations shaped like npm's (see sigstore-js's). */
function release(overrides: { status?: string; workflow?: Partial<typeof RELEASE_WORKFLOW>; digest?: string; provenance?: boolean } = {}) {
  const meta: VersionMetadata = {
    name: '@yatris/astro',
    version: '1.2.0',
    yatrisPlatform: { status: overrides.status ?? 'released' },
    dist: {
      integrity,
      ...(overrides.provenance === false ? {} : { attestations: { url: 'https://registry.npmjs.org/-/npm/v1/attestations/@yatris%2fastro@1.2.0', provenance: { predicateType: 'https://slsa.dev/provenance/v1' } } }),
    },
  };
  const statement = {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [{ name: 'pkg:npm/@yatris/astro@1.2.0', digest: { sha512: overrides.digest ?? sha512 } }],
    predicateType: 'https://slsa.dev/provenance/v1',
    predicate: { buildDefinition: { externalParameters: { workflow: { ...RELEASE_WORKFLOW, ...overrides.workflow } } } },
  };
  const attestations = {
    attestations: [
      { predicateType: 'https://github.com/npm/attestation/tree/main/specs/publish/v0.1', bundle: {} },
      { predicateType: 'https://slsa.dev/provenance/v1', bundle: { dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement)).toString('base64') } } },
    ],
  };
  return { meta, attestations };
}

describe('an approved platform release', () => {
  it('is one the Yatris release workflow published from main, for this exact tarball', () => {
    const { meta, attestations } = release();
    expect(releaseRejection(meta, attestations)).toBeNull();
  });

  it('is not a released marker someone published by hand', () => {
    const { meta, attestations } = release({ provenance: false });
    expect(releaseRejection(meta, attestations)).toContain('no npm provenance');
  });

  it('is not a build from another repository, workflow or branch', () => {
    for (const workflow of [{ repository: 'https://github.com/someone/fork' }, { path: '.github/workflows/ci.yml' }, { ref: 'refs/heads/feature' }]) {
      const { meta, attestations } = release({ workflow });
      expect(releaseRejection(meta, attestations)).toContain('not the Yatris release workflow');
    }
  });

  it('is not an attestation for a different tarball', () => {
    const { meta, attestations } = release({ digest: 'ab'.repeat(64) });
    expect(releaseRejection(meta, attestations)).toContain('does not describe the tarball');
  });

  it('still needs the released marker the workflow sets', () => {
    const { meta, attestations } = release({ status: 'unreleased' });
    expect(releaseRejection(meta, attestations)).toBe('it is not marked released');
  });
});

describe('the registry source', () => {
  const registry = (audit: string, overrides: Parameters<typeof release>[0] = {}) => {
    const { meta, attestations } = release(overrides);
    const commands: string[] = [];
    const exec: Exec = async (command) => {
      commands.push(command.join(' '));
      if (command[1] === 'view') return { code: 0, output: JSON.stringify(meta) };
      if (command[1] === 'audit') return { code: audit.includes('invalid') ? 1 : 0, output: audit };
      return { code: 0, output: '' };
    };
    return { source: registrySource(exec, '/site', async () => attestations), commands };
  };

  it('verifies the signatures with npm before accepting a release', async () => {
    const ok = registry('audited 1 package in 1s\n\n1 package has a verified registry signature\n\n1 package has a verified attestation\n');
    expect(await ok.source.rejection('1.2.0')).toBeNull();
    expect(ok.commands).toEqual([
      'npm view @yatris/astro@1.2.0 name version yatrisPlatform dist --json',
      'npm install --ignore-scripts --legacy-peer-deps --no-audit --no-fund',
      'npm audit signatures',
    ]);

    const tampered = registry('1 package has an invalid attestation');
    expect(await tampered.source.rejection('1.2.0')).toContain('could not verify');
  });

  it('stops before downloading anything when the version is plainly not a release', async () => {
    const unsigned = registry('', { provenance: false });
    expect(await unsigned.source.rejection('1.2.0')).toContain('no npm provenance');
    expect(unsigned.commands).toHaveLength(1);
  });
});
