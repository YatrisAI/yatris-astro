// End-to-end: packs both packages, runs the packed `create-yatris` to generate
// a site, lets it install dependencies (from the npm registry) and build, then
// checks the result. Run after `npm run build`. Needs network for the site's
// own dependencies (Astro, Tailwind, Alpine).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const work = resolve(root, '.e2e');
const packDir = join(work, 'pack');
const runnerDir = join(work, 'runner');
const site = join(work, 'site');
const env = { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' };

/** Runs a command and returns its stdout (or stdout + stderr with `both`). */
function sh(command, cwd, { both = false } = {}) {
  const result = spawnSync(command, { cwd, shell: true, encoding: 'utf8', env });
  if (result.status !== 0) {
    throw new Error(`\`${command}\` failed (exit ${result.status})\n${result.stdout}\n${result.stderr}`);
  }
  return both ? `${result.stdout}\n${result.stderr}` : result.stdout;
}

function expect(condition, message) {
  if (!condition) throw new Error(`e2e: ${message}`);
  console.log(`ok - ${message}`);
}

const read = (path) => readFileSync(join(site, path), 'utf8');
const sha = (path) => createHash('sha256').update(readFileSync(join(site, path))).digest('hex');
const distFiles = (ext) =>
  readdirSync(join(site, 'dist'), { recursive: true })
    .map(String)
    .filter((f) => f.endsWith(ext))
    .map((f) => readFileSync(join(site, 'dist', f), 'utf8'));

rmSync(work, { recursive: true, force: true });
mkdirSync(packDir, { recursive: true });
mkdirSync(runnerDir, { recursive: true });

const packed = JSON.parse(
  sh(`npm pack --json --workspace packages/astro --workspace packages/create-yatris --pack-destination "${packDir}"`, root),
);
const tarball = (name) => join(packDir, packed.find((p) => p.name === name).filename).replaceAll('\\', '/');

writeFileSync(join(runnerDir, 'package.json'), JSON.stringify({ name: 'runner', private: true }));
sh(`npm install --offline --no-audit --no-fund "${tarball('create-yatris')}" "${tarball('@yatris/astro')}"`, runnerDir);

// Generate, install and build exactly as a user would, with @yatris/astro
// pointed at the packed tarball because it is not published yet.
// Not --offline: npm passes that on to the nested `npm install`.
sh(`npm exec -- create-yatris "${site}" --yes --yatris-astro "file:${tarball('@yatris/astro')}"`, runnerDir);
expect(existsSync(join(site, 'dist/index.html')), 'create-yatris installed dependencies and built the new site');
expect(existsSync(join(site, 'package-lock.json')), 'the new site has a lockfile');
expect(existsSync(join(site, '.git')), 'the new site is a Git repository (Tailwind then ignores .astro/)');

const html = read('dist/index.html');
expect(html.includes('<html lang="ja">') && html.includes('<title>ホーム</title>'), 'home page has a language and a title');
expect(distFiles('.css').some((css) => css.includes('.sr-only')), 'Tailwind utilities used by the layout are in the built CSS');

// A representative Alpine component, using Tailwind, added the way a designer would.
writeFileSync(
  join(site, 'src/pages/alpine-check.astro'),
  `---
import BaseLayout from '../layouts/BaseLayout.astro';
---
<BaseLayout title="Alpine check">
  <div x-data="{ open: false }" class="p-4">
    <button type="button" x-on:click="open = !open" x-bind:aria-expanded="open" aria-controls="panel">Toggle</button>
    <p id="panel" x-show="open" x-cloak class="text-emerald-700">Panel</p>
  </div>
</BaseLayout>
`,
);
sh('npm run build', site);
const alpineHtml = read('dist/alpine-check/index.html');
expect(alpineHtml.includes('x-data="{ open: false }"'), 'Alpine markup survives the production build');
expect(/<script[^>]+type="module"[^>]*src="\/_astro\//.test(alpineHtml), 'the page loads the bundled Alpine module script');
expect(distFiles('.js').some((js) => js.includes('Alpine') && js.includes('cloak')), 'Alpine is bundled locally (no CDN)');
expect(!/https?:\/\/(cdn|unpkg|jsdelivr)/.test(alpineHtml + html), 'no CDN script references');
expect(distFiles('.css').some((css) => css.includes('.text-emerald-700')), 'a new Tailwind utility works with no extra setup');

const secretish = /alk_[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{10,}/;
expect(![...distFiles('.html'), ...distFiles('.js')].some((f) => secretish.test(f)), 'built output contains no credentials');

// The configuration matches what Astro's own installers produce.
const configBefore = sha('astro.config.mjs');
const added = sh('npx astro add tailwind alpinejs --yes', site, { both: true });
expect(added.includes('Configuration up-to-date'), '`astro add tailwind alpinejs` finds nothing to configure');
expect(sha('astro.config.mjs') === configBefore, '`astro add` leaves astro.config.mjs unchanged');

if (!process.env.E2E_KEEP) rmSync(work, { recursive: true, force: true });
console.log('e2e: all checks passed');
