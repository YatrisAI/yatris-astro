// Marks the platform release in the release workflow's workspace, just
// before the compatibility matrix runs and the packages are published
// (.github/workflows/release.yml). The repository always says `unreleased`;
// only this workflow, on main, after the `npm-release` environment is
// approved, produces a package that says `released`, and the updater checks
// the npm provenance that proves it (packages/astro/src/update/provenance.ts).
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const EXPECTED_WORKFLOW = 'YatrisAI/yatris-astro/.github/workflows/release.yml@refs/heads/main';

function fail(message) {
  console.error(`mark-released: ${message}`);
  process.exit(1);
}

if (process.env.GITHUB_WORKFLOW_REF !== EXPECTED_WORKFLOW) {
  fail(`runs only in ${EXPECTED_WORKFLOW} (this is ${process.env.GITHUB_WORKFLOW_REF ?? 'not GitHub Actions'})`);
}

const manifestPath = resolve(root, 'platform/manifest.json');
const packagePath = resolve(root, 'packages/astro/package.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));

if (manifest.status !== 'unreleased' || pkg.yatrisPlatform?.status !== 'unreleased') {
  fail('the repository must say unreleased; only this script marks a release');
}
if (manifest.platformVersion !== pkg.version || manifest.packages['@yatris/astro'] !== pkg.version) {
  fail(`platformVersion ${manifest.platformVersion} and @yatris/astro ${pkg.version} must be the same release`);
}

const published = spawnSync(`npm view @yatris/astro@${pkg.version} version`, { encoding: 'utf8', shell: true });
if (published.status === 0 && published.stdout.trim() !== '') fail(`@yatris/astro@${pkg.version} is already published`);

writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, status: 'released' }, null, 2)}\n`);
writeFileSync(packagePath, `${JSON.stringify({ ...pkg, yatrisPlatform: { status: 'released' } }, null, 2)}\n`);
console.log(`mark-released: Yatris platform ${pkg.version} marked released for this run`);
