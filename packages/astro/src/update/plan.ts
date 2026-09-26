import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PlatformManifest } from '../platform.js';
import { digest, managedArtifacts, readArtifact, siteMcpUrl, type ManagedSources, type PlatformLock } from '../platform-lock.js';
import { PLATFORM_PACKAGE } from './source.js';
import { isMajorChange, parseVersion } from './versions.js';

export type FileChangeKind = 'add' | 'update' | 'remove' | 'adopt';

export interface FileChange {
  key: string;
  kind: FileChangeKind;
  /** The new text; null for a removal. */
  text: string | null;
}

export type ConflictReason =
  /** The site changed a managed artifact, and the release changes it too. */
  | 'modified'
  /** The site deleted a managed artifact (or removed the AGENTS.md markers). */
  | 'deleted'
  /** The site already has its own file where the release adds a managed one. */
  | 'unmanaged';

export interface Conflict {
  key: string;
  reason: ConflictReason;
  current: string | null;
  /** The release's version; null when the release removes the artifact. */
  proposed: string | null;
}

export interface PackageChange {
  name: string;
  from: string | null;
  to: string;
}

export interface UpdatePlan {
  from: string;
  to: string;
  packages: PackageChange[];
  files: FileChange[];
  /** Customised artifacts the release does not change: left alone. */
  kept: string[];
  conflicts: Conflict[];
  /** Changes that need explicit confirmation (decision 11.3). */
  major: string[];
  /** The lock's managed digests once the plan (without conflicts) is applied. */
  managed: Record<string, string>;
}

/**
 * Compares the site with a target release: which packages move, which
 * managed artifacts are added, refreshed or removed, and which were
 * customised by the site. Reads the project; writes nothing.
 */
export function planUpdate(root: string, lock: PlatformLock, manifest: PlatformManifest, sources: ManagedSources): UpdatePlan {
  const target = managedArtifacts(sources, siteMcpUrl(root, manifest));
  const plan: UpdatePlan = {
    from: lock.platformVersion,
    to: manifest.platformVersion,
    packages: packageChanges(root, manifest),
    files: [],
    kept: [],
    conflicts: [],
    major: [],
    managed: {},
  };

  const keys = [...new Set([...Object.keys(lock.managed), ...Object.keys(target)])].sort();
  for (const key of keys) {
    const current = readArtifact(root, key);
    const currentDigest = current === null ? null : digest(current);
    const recorded = lock.managed[key];
    const proposed = target[key] ?? null;
    const proposedDigest = proposed === null ? null : digest(proposed);
    const conflict = (reason: ConflictReason) => plan.conflicts.push({ key, reason, current, proposed });
    const change = (kind: FileChangeKind) => plan.files.push({ key, kind, text: proposed });

    if (proposed !== null && proposedDigest !== null) {
      if (recorded === undefined) {
        if (current === null) change('add');
        else if (currentDigest === proposedDigest) change('adopt');
        else conflict('unmanaged');
      } else if (current === null) {
        conflict('deleted');
      } else if (currentDigest === recorded) {
        if (currentDigest !== proposedDigest) change('update');
      } else if (currentDigest === proposedDigest) {
        change('adopt');
      } else if (proposedDigest === recorded) {
        // Customised, but this release does not touch it
        plan.kept.push(key);
        plan.managed[key] = recorded;
        continue;
      } else {
        conflict('modified');
      }
      if (plan.conflicts.at(-1)?.key !== key) plan.managed[key] = proposedDigest;
    } else if (recorded !== undefined && current !== null) {
      if (currentDigest === recorded) change('remove');
      else conflict('modified');
    }
  }

  if (isMajorChange(lock.platformVersion, manifest.platformVersion)) {
    plan.major.push(`Yatris platform ${lock.platformVersion} → ${manifest.platformVersion}`);
  }
  const astro = plan.packages.find((p) => p.name === 'astro');
  if (astro?.from && isMajorChange(astro.from, astro.to)) {
    plan.major.push(`Astro ${astro.from} → ${astro.to} (read the Astro upgrade guide: https://docs.astro.build/en/upgrade-astro/)`);
  }

  return plan;
}

/** The plan with conflicts the user accepted turned into ordinary changes. */
export function acceptConflicts(plan: UpdatePlan, accepted: Conflict[]): UpdatePlan {
  const files = [...plan.files];
  const managed = { ...plan.managed };
  for (const conflict of accepted) {
    files.push({ key: conflict.key, kind: conflict.proposed === null ? 'remove' : 'update', text: conflict.proposed });
    if (conflict.proposed === null) delete managed[conflict.key];
    else managed[conflict.key] = digest(conflict.proposed);
  }
  const keys = new Set(accepted.map((c) => c.key));
  return { ...plan, files, managed, conflicts: plan.conflicts.filter((c) => !keys.has(c.key)) };
}

function packageChanges(root: string, manifest: PlatformManifest): PackageChange[] {
  const path = join(root, 'package.json');
  const pkg = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, Record<string, string> | undefined>) : {};
  const declared = { ...pkg.devDependencies, ...pkg.dependencies };
  const wanted = { ...manifest.dependencies, [PLATFORM_PACKAGE]: manifest.packages[PLATFORM_PACKAGE] };

  return Object.entries(wanted)
    .map(([name, to]) => ({ name, from: exactVersion(declared[name]), to }))
    .filter((change) => change.from !== change.to)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function exactVersion(spec: string | undefined): string | null {
  if (spec === undefined) return null;
  const parsed = parseVersion(spec);
  return parsed === null ? spec : `${parsed.major}.${parsed.minor}.${parsed.patch}${parsed.pre ? `-${parsed.pre}` : ''}`;
}

/** A readable plan, as `--dry-run` and the update itself print it. */
export function formatPlan(plan: UpdatePlan): string {
  const lines = [`Yatris platform ${plan.from} → ${plan.to}`];

  lines.push(plan.packages.length ? 'Packages:' : 'Packages: no changes');
  for (const p of plan.packages) lines.push(`  ${p.name} ${p.from ?? '(not installed)'} → ${p.to}`);

  const verb: Record<FileChangeKind, string> = { add: 'add', update: 'refresh', remove: 'remove', adopt: 'already current' };
  const shown = plan.files.filter((f) => f.kind !== 'adopt');
  lines.push(shown.length ? 'Managed files:' : 'Managed files: no changes');
  for (const f of shown) lines.push(`  ${verb[f.kind]} ${f.key}`);
  for (const key of plan.kept) lines.push(`  keep (customised; this release does not change it) ${key}`);

  if (plan.conflicts.length) {
    lines.push('Conflicts (customised managed files this release would change):');
    for (const c of plan.conflicts) lines.push(`  ✖ ${c.key}: ${CONFLICT_TEXT[c.reason]}`);
  }
  if (plan.major.length) {
    lines.push('Major changes (need your confirmation):');
    for (const m of plan.major) lines.push(`  ! ${m}`);
  }
  return lines.join('\n');
}

export const CONFLICT_TEXT: Record<ConflictReason, string> = {
  modified: 'changed in this repository since Yatris last wrote it',
  deleted: 'deleted in this repository (or its markers were removed)',
  unmanaged: 'this repository already has its own file here',
};
