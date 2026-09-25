import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { mcpDescriptor, mcpFiles } from '@yatris/astro/mcp';
import type { PlatformManifest } from '@yatris/astro/platform';

/** Where generated skills are discovered: Codex first, then Claude. */
export const SKILL_LOCATIONS = ['.agents/skills', '.claude/skills'] as const;

export interface Sources {
  templateDir: string;
  skillsDir: string;
  manifest: PlatformManifest;
}

export interface CreateOptions {
  targetDir: string;
  /** Overrides the `@yatris/astro` dependency spec, e.g. a local tarball in tests. */
  yatrisAstroSpec?: string;
}

/**
 * Writes a new, unpaired managed-site project. It contains no design, no CMS
 * requirement and no credentials; dependencies are pinned to the platform
 * release in `sources.manifest`.
 */
export function createProject(options: CreateOptions, sources: Sources): string {
  const target = resolve(options.targetDir);

  if (existsSync(target) && readdirSync(target).length > 0) {
    throw new Error(`${target} already exists and is not empty`);
  }

  mkdirSync(target, { recursive: true });
  cpSync(sources.templateDir, target, { recursive: true });
  // npm never publishes a file named .gitignore, so the template ships it renamed.
  renameSync(join(target, '_gitignore'), join(target, '.gitignore'));

  for (const skill of readdirSync(sources.skillsDir, { withFileTypes: true })) {
    if (!skill.isDirectory()) continue;
    for (const location of SKILL_LOCATIONS) {
      cpSync(join(sources.skillsDir, skill.name), join(target, location, skill.name), { recursive: true });
    }
  }

  const packageJsonPath = join(target, 'package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  packageJson.name = packageName(basename(target));
  packageJson.dependencies = sortKeys({
    ...sources.manifest.dependencies,
    '@yatris/astro': options.yatrisAstroSpec ?? sources.manifest.packages['@yatris/astro'],
  });
  writeJson(packageJsonPath, packageJson);

  mkdirSync(join(target, '.yatris'), { recursive: true });
  writeJson(join(target, '.yatris/project.json'), {
    contractVersion: 1,
    websiteId: null,
    environment: 'production',
    templateVersion: sources.manifest.template,
  });

  // The Yatris MCP: one descriptor and the Claude Code / Codex adapters
  // derived from it, holding only the URL (people sign in from their client)
  for (const [path, contents] of Object.entries(mcpFiles(mcpDescriptor(sources.manifest.mcp.url)))) {
    mkdirSync(dirname(join(target, path)), { recursive: true });
    writeFileSync(join(target, path), contents);
  }

  return target;
}

/** A valid npm package name derived from the directory name. */
export function packageName(directory: string): string {
  const name = directory
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+|[-]+$/g, '');
  return name === '' ? 'yatris-site' : name;
}

function sortKeys(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
