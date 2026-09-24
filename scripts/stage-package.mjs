// Copies the shared sources a package ships with into that package directory
// before it is built and packed. The copies are build output (gitignored);
// the repository-root directories stay the single source of truth.
//
//   node scripts/stage-package.mjs <package-dir> [--with-assets]
import { cpSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const [target, flag] = process.argv.slice(2);

if (!target) {
  console.error('usage: stage-package.mjs <package-dir> [--with-assets]');
  process.exit(1);
}

const pkg = resolve(process.cwd(), target);

cpSync(resolve(root, 'platform/manifest.json'), resolve(pkg, 'platform.json'));
cpSync(resolve(root, 'LICENSE'), resolve(pkg, 'LICENSE'));

if (flag === '--with-assets') {
  for (const dir of ['template', 'skills']) {
    rmSync(resolve(pkg, dir), { recursive: true, force: true });
    cpSync(resolve(root, dir), resolve(pkg, dir), { recursive: true });
  }
}
