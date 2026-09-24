// Packs both packages exactly as npm would publish them, installs the
// tarballs into a throwaway project without touching the registry, and runs
// the installed entry points. Run after `npm run build`.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const work = resolve(root, '.smoke');
const packDir = resolve(work, 'pack');
const appDir = resolve(work, 'app');
const platform = JSON.parse(readFileSync(resolve(root, 'platform/manifest.json'), 'utf8'));

function sh(command, cwd) {
  const result = spawnSync(command, { cwd, shell: true, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`\`${command}\` failed (exit ${result.status})\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout.trim();
}

function expect(condition, message) {
  if (!condition) throw new Error(`smoke: ${message}`);
  console.log(`ok - ${message}`);
}

rmSync(work, { recursive: true, force: true });
mkdirSync(packDir, { recursive: true });
mkdirSync(appDir, { recursive: true });

const packed = JSON.parse(
  sh(`npm pack --json --workspace packages/astro --workspace packages/create-yatris --pack-destination "${packDir}"`, root),
);

for (const pkg of packed) {
  const files = pkg.files.map((f) => f.path);
  for (const required of ['package.json', 'LICENSE', 'platform.json', 'dist/index.js', 'dist/cli.js'].filter(
    (f) => !(pkg.name === 'create-yatris' && f === 'dist/index.js'),
  )) {
    expect(files.includes(required), `${pkg.name} tarball contains ${required}`);
  }
  expect(!files.some((f) => f.endsWith('.test.js') || f.startsWith('src/')), `${pkg.name} tarball ships no sources or tests`);
  if (pkg.name === 'create-yatris') {
    expect(files.includes('template/README.md'), 'create-yatris tarball contains the template');
    expect(files.includes('skills/README.md'), 'create-yatris tarball contains the skill pack');
  }
}

writeFileSync(resolve(appDir, 'package.json'), JSON.stringify({ name: 'smoke', private: true, type: 'module' }));
const tarballs = packed.map((p) => `"${resolve(packDir, p.filename)}"`).join(' ');
sh(`npm install --offline --no-audit --no-fund ${tarballs}`, appDir);
expect(true, 'tarballs install offline into a fresh project');

const expected = `(Yatris platform ${platform.platformVersion})`;
expect(sh('npm exec --offline -- create-yatris --version', appDir).endsWith(expected), 'create-yatris bin runs');
expect(sh('npm exec --offline -- yatris --version', appDir).endsWith(expected), 'yatris bin runs');

const name = sh(`node --input-type=module -e "import y from '@yatris/astro'; console.log(y().name)"`, appDir);
expect(name === '@yatris/astro', 'integration imports from the installed package');

rmSync(work, { recursive: true, force: true });
console.log('smoke: all checks passed');
