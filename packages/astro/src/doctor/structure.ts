import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { PlatformManifest } from '../platform.js';
import { findCredentials, type Finding } from './findings.js';

const REQUIRED_PATHS = [
  'package.json',
  'astro.config.mjs',
  'AGENTS.md',
  'CLAUDE.md',
  '.yatris/project.json',
  'src/pages',
  'src/navigation.ts',
  'src/styles/global.css',
  'src/scripts/alpine.ts',
];

export const BUILT_IN_SKILLS = ['tailwindcss-development', 'alpinejs-development'];
export const SKILL_LOCATIONS = ['.agents/skills', '.claude/skills'];

/** Checks the repository contract of a scaffold-stage managed site. */
export function checkStructure(root: string, manifest: PlatformManifest): Finding[] {
  const findings: Finding[] = [];
  const error = (code: string, message: string, file?: string) => findings.push({ severity: 'error', code, message, file });
  const warn = (code: string, message: string, file?: string) => findings.push({ severity: 'warning', code, message, file });
  const read = (path: string) => readFileSync(join(root, path), 'utf8');

  for (const path of REQUIRED_PATHS) {
    if (!existsSync(join(root, path))) error('missing-path', `required path is missing`, path);
  }

  for (const legacy of ['tailwind.config.js', 'tailwind.config.cjs', 'tailwind.config.mjs', 'tailwind.config.ts']) {
    if (existsSync(join(root, legacy))) error('legacy-tailwind-config', 'Tailwind CSS 4 is configured in CSS (@theme); remove this file', legacy);
  }

  if (existsSync(join(root, 'package.json'))) {
    const pkg = JSON.parse(read('package.json'));
    const declared = { ...pkg.dependencies, ...pkg.devDependencies };
    if ('@astrojs/tailwind' in declared) error('legacy-tailwind-integration', 'remove @astrojs/tailwind; Tailwind 4 uses @tailwindcss/vite', 'package.json');
    for (const [name, version] of Object.entries(manifest.dependencies)) {
      const installedPath = join(root, 'node_modules', name, 'package.json');
      if (!(name in declared)) {
        error('missing-dependency', `${name} ${version} is not a dependency`, 'package.json');
      } else if (!existsSync(installedPath)) {
        error('not-installed', `${name} is not installed; run npm ci`);
      } else {
        const installed = JSON.parse(readFileSync(installedPath, 'utf8')).version;
        if (installed !== version) {
          error('platform-mismatch', `${name} ${installed} is installed, but Yatris platform ${manifest.platformVersion} is tested with ${version}`);
        }
      }
    }
  }

  if (existsSync(join(root, 'astro.config.mjs'))) {
    const config = read('astro.config.mjs');
    if (!/\btailwindcss\s*\(\s*\)/.test(config)) error('missing-tailwind', 'the @tailwindcss/vite plugin is not configured', 'astro.config.mjs');
    if (!/\balpinejs\s*\(/.test(config)) error('missing-alpine', 'the @astrojs/alpinejs integration is not configured', 'astro.config.mjs');
    if (!/\byatris\s*\(/.test(config)) error('missing-yatris', 'the @yatris/astro integration is not configured', 'astro.config.mjs');
  }

  if (existsSync(join(root, 'src/styles/global.css')) && !/@import\s+["']tailwindcss["']/.test(read('src/styles/global.css'))) {
    error('missing-tailwind-import', 'global stylesheet does not @import "tailwindcss"', 'src/styles/global.css');
  }

  const skillTrees = SKILL_LOCATIONS.map((location) => tree(join(root, location)));
  for (const [i, location] of SKILL_LOCATIONS.entries()) {
    for (const skill of BUILT_IN_SKILLS) {
      if (!skillTrees[i].has(`${skill}/SKILL.md`)) error('missing-skill', `built-in skill ${skill} is missing`, location);
    }
  }
  const [codex, claude] = skillTrees;
  const drifted = [...new Set([...codex.keys(), ...claude.keys()])].filter((file) => codex.get(file) !== claude.get(file));
  if (drifted.length > 0) {
    error('skill-drift', `skills differ between ${SKILL_LOCATIONS.join(' and ')}: ${drifted.sort().join(', ')}`);
  }

  if (existsSync(join(root, 'AGENTS.md'))) {
    const agents = read('AGENTS.md');
    if (!agents.includes('<!-- yatris:managed:start') || !agents.includes('<!-- yatris:managed:end -->')) {
      warn('agents-markers', 'the Yatris-managed block markers are missing, so updates cannot refresh it', 'AGENTS.md');
    }
  }

  if (existsSync(join(root, '.yatris/project.json'))) {
    const text = read('.yatris/project.json');
    findings.push(...findCredentials('.yatris/project.json', text));
    try {
      const project = JSON.parse(text);
      if (project.contractVersion !== 1) error('project-contract', `unsupported contractVersion ${project.contractVersion}`, '.yatris/project.json');
    } catch {
      error('project-json', 'is not valid JSON', '.yatris/project.json');
    }
  }

  return findings;
}

/** Relative path → content hash for every file under `dir`. */
function tree(dir: string): Map<string, string> {
  if (!existsSync(dir)) return new Map();
  return new Map(
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const path = join(entry.parentPath, entry.name);
        return [relative(dir, path).replaceAll('\\', '/'), createHash('sha256').update(readFileSync(path)).digest('hex')];
      }),
  );
}
