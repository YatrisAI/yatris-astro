import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { mcpDescriptor, mcpFiles, MCP_FILES } from './mcp.js';
import type { PlatformManifest } from './platform.js';

/**
 * `.yatris/platform.lock.json` (spec §5.4, §6): the platform release a site is
 * on and the digest of every artifact the updater owns, as it last wrote it.
 * A managed artifact whose current digest differs from its recorded one has
 * been customised, and the updater stops rather than overwrite it.
 *
 * Only these are managed: the built-in skills in both agent locations, the
 * generated block of AGENTS.md, and the MCP descriptor and its two adapters.
 * Site pages, components, styles, assets, custom skills and the prose outside
 * the AGENTS.md markers are the site's own, even though the scaffold wrote
 * some of them.
 */

export const PLATFORM_LOCK_PATH = '.yatris/platform.lock.json';

/** Where generated skills are discovered: Codex first, then Claude. */
export const SKILL_LOCATIONS = ['.agents/skills', '.claude/skills'] as const;

/** The managed block of AGENTS.md, keyed apart from the site-owned rest of the file. */
export const AGENTS_BLOCK = 'AGENTS.md#yatris:managed';

const BLOCK_START = '<!-- yatris:managed:start';
const BLOCK_END = '<!-- yatris:managed:end -->';

export interface PlatformLock {
  lockVersion: 1;
  platformVersion: string;
  template: string;
  skills: string;
  packages: Record<string, string>;
  dependencies: Record<string, string>;
  /** Artifact key (a repository path, or AGENTS_BLOCK) → `sha256:<hex>` of its LF-normalised text. */
  managed: Record<string, string>;
}

/** The release's canonical sources for managed artifacts. */
export interface ManagedSources {
  /** The skill pack: one directory per built-in skill. */
  skillsDir: string;
  /** The template's AGENTS.md, which carries the managed block. */
  agentsTemplate: string;
}

/** The digest the lock records: line endings never count as a customisation. */
export function digest(text: string): string {
  return `sha256:${createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex')}`;
}

/** The repository file an artifact key lives in. */
export function artifactFile(key: string): string {
  return key === AGENTS_BLOCK ? 'AGENTS.md' : key;
}

/** The managed block of an AGENTS.md, markers included, or null without markers. */
export function managedBlock(text: string): string | null {
  const start = text.indexOf(BLOCK_START);
  const end = text.indexOf(BLOCK_END, start);
  if (start === -1 || end === -1) return null;
  return text.slice(start, end + BLOCK_END.length).replace(/\r\n/g, '\n');
}

/** AGENTS.md with its managed block replaced; everything outside the markers is kept. */
export function replaceManagedBlock(text: string, block: string): string {
  const start = text.indexOf(BLOCK_START);
  const end = text.indexOf(BLOCK_END, start);
  if (start === -1 || end === -1) throw new Error('AGENTS.md has no Yatris-managed block markers');
  return text.slice(0, start) + block + text.slice(end + BLOCK_END.length);
}

/** An artifact's current text in the project, or null when it is absent. */
export function readArtifact(root: string, key: string): string | null {
  const path = join(root, artifactFile(key));
  if (!existsSync(path)) return null;
  const text = readFileSync(path, 'utf8');
  return key === AGENTS_BLOCK ? managedBlock(text) : text.replace(/\r\n/g, '\n');
}

/**
 * Every managed artifact a release generates, key → exact text. The MCP
 * files follow the site's own descriptor URL once it is paired (Yatris
 * issued it), and the release's URL before that.
 */
export function managedArtifacts(sources: ManagedSources, mcpUrl: string): Record<string, string> {
  const artifacts: Record<string, string> = {};

  for (const skill of readdirSync(sources.skillsDir, { withFileTypes: true })) {
    if (!skill.isDirectory()) continue;
    const dir = join(sources.skillsDir, skill.name);
    for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const path = relative(dir, join(entry.parentPath, entry.name)).replaceAll('\\', '/');
      const text = readFileSync(join(entry.parentPath, entry.name), 'utf8').replace(/\r\n/g, '\n');
      for (const location of SKILL_LOCATIONS) artifacts[`${location}/${skill.name}/${path}`] = text;
    }
  }

  const block = managedBlock(readFileSync(sources.agentsTemplate, 'utf8'));
  if (block === null) throw new Error(`${sources.agentsTemplate} has no Yatris-managed block`);
  artifacts[AGENTS_BLOCK] = block;

  Object.assign(artifacts, mcpFiles(mcpDescriptor(mcpUrl)));

  return Object.fromEntries(Object.entries(artifacts).sort(([a], [b]) => a.localeCompare(b)));
}

/** The MCP URL the site's managed files should carry under `manifest`. */
export function siteMcpUrl(root: string, manifest: PlatformManifest): string {
  const project = readJson(join(root, '.yatris/project.json'));
  const descriptor = readJson(join(root, MCP_FILES.descriptor));
  const url = (descriptor?.server as Record<string, unknown> | undefined)?.url;
  // Paired: Yatris issued this URL; keep it. Unpaired: follow the release.
  return typeof project?.websiteId === 'number' && typeof url === 'string' ? url : manifest.mcp.url;
}

export function lockFor(manifest: PlatformManifest, artifacts: Record<string, string>): PlatformLock {
  return {
    lockVersion: 1,
    platformVersion: manifest.platformVersion,
    template: manifest.template,
    skills: manifest.skills,
    packages: manifest.packages,
    dependencies: manifest.dependencies,
    managed: Object.fromEntries(Object.entries(artifacts).map(([key, text]) => [key, digest(text)])),
  };
}

export function readPlatformLock(root: string): PlatformLock | null {
  const path = join(root, PLATFORM_LOCK_PATH);
  if (!existsSync(path)) return null;

  const lock = JSON.parse(readFileSync(path, 'utf8')) as Partial<PlatformLock>;
  if (lock.lockVersion !== 1) throw new Error(`${PLATFORM_LOCK_PATH}: unsupported lockVersion ${String(lock.lockVersion)}`);
  if (typeof lock.platformVersion !== 'string' || typeof lock.managed !== 'object' || lock.managed === null) {
    throw new Error(`${PLATFORM_LOCK_PATH} is incomplete; it is written by Yatris tooling only`);
  }
  return lock as PlatformLock;
}

export function platformLockText(lock: PlatformLock): string {
  return `${JSON.stringify(lock, null, 2)}\n`;
}

export function writePlatformLock(root: string, lock: PlatformLock): void {
  mkdirSync(dirname(join(root, PLATFORM_LOCK_PATH)), { recursive: true });
  writeFileSync(join(root, PLATFORM_LOCK_PATH), platformLockText(lock));
}

/**
 * Records new digests for managed files Yatris tooling rewrote outside an
 * update (pairing rewrites the MCP files), so they are not later mistaken
 * for local customisations. A project without a lock is left alone.
 */
export function recordManaged(root: string, written: Record<string, string>): boolean {
  const lock = readPlatformLock(root);
  if (lock === null) return false;
  let changed = false;
  for (const [key, text] of Object.entries(written)) {
    if (key in lock.managed) {
      lock.managed[key] = digest(text);
      changed = true;
    }
  }
  if (changed) writePlatformLock(root, lock);
  return changed;
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}
