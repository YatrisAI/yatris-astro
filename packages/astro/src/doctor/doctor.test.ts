import { cpSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MCP_FILES, mcpDescriptor, mcpFiles } from '../mcp.js';
import { readPlatformManifest } from '../platform.js';
import { lockFor, managedArtifacts, PLATFORM_LOCK_PATH, writePlatformLock } from '../platform-lock.js';
import { emptyLock, LOCK_PATH } from '../schema.js';
import { doctor, formatReport } from './doctor.js';
import { SKILL_LOCATIONS } from './structure.js';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const manifest = readPlatformManifest(new URL('platform/manifest.json', `file:///${root.replaceAll('\\', '/')}`));

const BUILT = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>ホーム</title></head><body><h1>ホーム</h1></body></html>`;

let site: string;

/** A scaffolded site as create-yatris writes it, with dependencies "installed" and built. */
function scaffold(): string {
  const dir = mkdtempSync(join(tmpdir(), 'yatris-doctor-'));
  cpSync(join(root, 'template'), dir, { recursive: true });
  renameSync(join(dir, '_gitignore'), join(dir, '.gitignore'));
  for (const location of SKILL_LOCATIONS) {
    for (const skill of ['tailwindcss-development', 'alpinejs-development']) {
      cpSync(join(root, 'skills', skill), join(dir, location, skill), { recursive: true });
    }
  }
  const deps = { ...manifest.dependencies };
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'site', dependencies: deps }));
  for (const [name, version] of Object.entries(deps)) {
    mkdirSync(join(dir, 'node_modules', name), { recursive: true });
    writeFileSync(join(dir, 'node_modules', name, 'package.json'), JSON.stringify({ name, version }));
  }
  mkdirSync(join(dir, '.yatris'));
  writeFileSync(join(dir, '.yatris/project.json'), JSON.stringify({ contractVersion: 1, websiteId: null }));
  writeFileSync(join(dir, LOCK_PATH), JSON.stringify(emptyLock()));
  mkdirSync(join(dir, '.codex'));
  for (const [path, contents] of Object.entries(mcpFiles(mcpDescriptor(manifest.mcp.url)))) {
    writeFileSync(join(dir, path), contents);
  }
  writePlatformLock(dir, lockFor(manifest, managedArtifacts({ skillsDir: join(root, 'skills'), agentsTemplate: join(root, 'template/AGENTS.md') }, manifest.mcp.url)));
  mkdirSync(join(dir, 'dist'));
  writeFileSync(join(dir, 'dist/index.html'), BUILT);
  return dir;
}

const run = (build?: () => Promise<{ code: number; output: string }>) =>
  doctor({ root: site, stage: 'scaffold', manifest, dist: 'dist', build });
const errorCodes = async () => (await run()).findings.filter((f) => f.severity === 'error').map((f) => f.code);

beforeEach(() => {
  site = scaffold();
});
afterEach(() => {
  rmSync(site, { recursive: true, force: true });
});

describe('yatris doctor --stage=scaffold', () => {
  it('checks the platform lock: present, on the installed release, no unfinished update', async () => {
    const skill = join(site, '.claude/skills/alpinejs-development/SKILL.md');
    writeFileSync(skill, 'edited');
    writeFileSync(join(site, '.agents/skills/alpinejs-development/SKILL.md'), 'edited');
    const warnings = (await run()).findings.filter((f) => f.severity === 'warning').map((f) => f.code);
    expect(warnings).toContain('managed-customised');

    mkdirSync(join(site, '.yatris/update-transaction'));
    expect(await errorCodes()).toContain('update-incomplete');

    writePlatformLock(site, { ...lockFor(manifest, {}), platformVersion: '9.9.9' });
    expect(await errorCodes()).toContain('platform-lock-mismatch');

    rmSync(join(site, PLATFORM_LOCK_PATH));
    expect(await errorCodes()).toContain('platform-lock');
  });

  it('passes a freshly scaffolded site', async () => {
    const report = await run();

    expect(report.findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(report.ok).toBe(true);
    expect(formatReport(report)).toContain('✔ passed');
  });

  it('fails when the build fails, and shows the redacted end of its output', async () => {
    const report = await run(async () => ({ code: 1, output: `Navigation points to pages that were not built\nkey alk_${'x'.repeat(40)}` }));

    expect(report.ok).toBe(false);
    const failure = report.findings.find((f) => f.code === 'build-failed');
    expect(failure?.message).toContain('Navigation points to pages that were not built');
    expect(failure?.message).not.toContain('x'.repeat(40));
  });

  it('fails without build output', async () => {
    rmSync(join(site, 'dist'), { recursive: true });
    expect(await errorCodes()).toContain('no-build-output');
  });

  it('fails a built page without a title', async () => {
    writeFileSync(join(site, 'dist/about.html'), BUILT.replace('<title>ホーム</title>', ''));
    expect(await errorCodes()).toContain('missing-title');
  });

  it('fails a leaked key in built JavaScript', async () => {
    mkdirSync(join(site, 'dist/_astro'));
    writeFileSync(join(site, 'dist/_astro/page.js'), `const k="alk_${'Ab1'.repeat(14)}";`);
    expect(await errorCodes()).toContain('credential-leak');
  });

  it('fails when the skill locations drift apart', async () => {
    writeFileSync(join(site, '.claude/skills/tailwindcss-development/SKILL.md'), 'edited');
    expect(await errorCodes()).toContain('skill-drift');
  });

  it('fails when an installed package is off the platform matrix', async () => {
    writeFileSync(join(site, 'node_modules/astro/package.json'), JSON.stringify({ name: 'astro', version: '7.0.0' }));
    expect(await errorCodes()).toContain('platform-mismatch');
  });

  it('fails without the Yatris integration or with a legacy Tailwind config', async () => {
    writeFileSync(join(site, 'astro.config.mjs'), 'export default { vite: { plugins: [tailwindcss()] }, integrations: [alpinejs()] }');
    writeFileSync(join(site, 'tailwind.config.js'), 'export default {}');

    expect(await errorCodes()).toEqual(expect.arrayContaining(['missing-yatris', 'legacy-tailwind-config']));
  });

  it('fails an MCP adapter that drifted from the descriptor', async () => {
    writeFileSync(join(site, MCP_FILES.codex), '[mcp_servers.yatris]\nurl = "https://elsewhere.example/mcp"\n');
    expect(await errorCodes()).toContain('mcp-adapter-drift');
  });

  it('fails a committed MCP credential', async () => {
    const claude = JSON.parse(mcpFiles(mcpDescriptor(manifest.mcp.url))[MCP_FILES.claude]);
    claude.mcpServers.yatris.headers = { Authorization: 'Bearer 12|abcdef' };
    writeFileSync(join(site, MCP_FILES.claude), JSON.stringify(claude));

    expect(await errorCodes()).toEqual(expect.arrayContaining(['mcp-credential', 'mcp-adapter-drift']));
  });

  it('fails a missing MCP descriptor', async () => {
    rmSync(join(site, MCP_FILES.descriptor));
    expect((await run()).findings).toContainEqual(expect.objectContaining({ code: 'missing-path', file: MCP_FILES.descriptor }));
  });

  it('lints src/ for hand-written Google tags', async () => {
    writeFileSync(join(site, 'src/pages/ga.astro'), "<script>gtag('config','G-1')</script>");
    expect(await errorCodes()).toContain('direct-tag');
  });
});
