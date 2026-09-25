// End-to-end: packs both packages, runs the packed `create-yatris` to generate
// a site, lets it install dependencies (from the npm registry) and build, then
// checks the result. Run after `npm run build`. Needs network for the site's
// own dependencies (Astro, Tailwind, Alpine).
import { spawn, spawnSync } from 'node:child_process';
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
expect(
  JSON.parse(read('.mcp.json')).mcpServers.yatris.url === JSON.parse(read('.yatris/mcp.json')).server.url &&
    read('.codex/config.toml').includes(`url = "${JSON.parse(read('.yatris/mcp.json')).server.url}"`),
  'Claude Code and Codex MCP configs are generated from the Yatris descriptor',
);
expect(!/bearer|authorization|token/i.test(read('.mcp.json') + read('.codex/config.toml').replace(/^#.*$/gm, '')), 'the MCP configs hold no credential');

const html = read('dist/index.html');
expect(html.includes('<html lang="ja">') && html.includes('<title>ホーム</title>'), 'home page has a language and a title');
expect(distFiles('.css').some((css) => css.includes('.sr-only')), 'Tailwind utilities used by the layout are in the built CSS');

// A representative Alpine component, using Tailwind, added the way a designer would.
writeFileSync(
  join(site, 'src/pages/alpine-check.astro'),
  `---
import BaseLayout from '../layouts/BaseLayout.astro';
---
<BaseLayout page={{ title: 'Alpine check' }}>
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

// yatris doctor: a fresh site passes, and each acceptance failure is caught.
const doctor = (args = '--no-build') => {
  const result = spawnSync(`npx yatris doctor --stage=scaffold --json ${args}`, { cwd: site, shell: true, encoding: 'utf8', env });
  const report = JSON.parse(result.stdout);
  return { status: result.status, report, errors: report.findings.filter((f) => f.severity === 'error').map((f) => f.code) };
};
const write = (path, text) => writeFileSync(join(site, path), text);
rmSync(join(site, 'src/pages/alpine-check.astro'));

let result = doctor('');
expect(result.status === 0 && result.report.ok, 'yatris doctor passes on a freshly scaffolded site (it builds first)');

const navigation = read('src/navigation.ts');
write('src/navigation.ts', navigation.replace("{ label: 'ホーム', href: '/' },", "{ label: 'ホーム', href: '/' },\n  { label: '無いページ', href: '/missing/' },"));
result = doctor('');
expect(result.status === 1 && result.errors.includes('build-failed'), 'an invalid navigation destination fails the build and doctor');
expect(result.report.findings.some((f) => f.message.includes('無いページ → /missing/')), 'the failure names the bad destination');
write('src/navigation.ts', navigation);

write('src/pages/untitled.astro', '<html lang="ja"><head><meta charset="utf-8"></head><body></body></html>');
sh('npm run build', site);
expect(doctor().errors.includes('missing-title'), 'a page with no title fails the audit');
rmSync(join(site, 'src/pages/untitled.astro'));

write('src/pages/leak.astro', `---\nimport BaseLayout from '../layouts/BaseLayout.astro';\n---\n<BaseLayout page={{ title: 'leak' }}><p>alk_${'Zz9'.repeat(14)}</p></BaseLayout>`);
sh('npm run build', site);
expect(doctor().errors.includes('credential-leak'), 'a leaked Yatris key in the built output fails the audit');
rmSync(join(site, 'src/pages/leak.astro'));

const config = read('astro.config.mjs');
const layout = read('src/layouts/BaseLayout.astro');
write('astro.config.mjs', config.replace('yatris()', "yatris({ gtmContainerId: 'GTM-TEST123' })"));
sh('npm run build', site);
const gtmHome = read('dist/index.html');
const gtmCount = (pattern) => (gtmHome.match(pattern) ?? []).length;
expect(
  gtmCount(/googletagmanager\.com\/gtm\.js/g) === 1 && gtmCount(/googletagmanager\.com\/ns\.html/g) === 1,
  'a configured GTM container renders exactly one head and one body installation',
);
expect(/<body>\s*<noscript><iframe src="https:\/\/www\.googletagmanager\.com\/ns\.html/.test(gtmHome), 'the GTM fallback follows <body> immediately');
expect(doctor().report.ok, 'doctor accepts the single integration-rendered GTM installation');
write(
  'src/layouts/BaseLayout.astro',
  layout
    .replace('<YatrisBodyStart />', '<YatrisBodyStart />\n    <YatrisBodyStart />')
    .replace('<YatrisHead page={page} />', '<YatrisHead page={page} />\n    <YatrisHead page={page} />'),
);
sh('npm run build', site);
expect(doctor().errors.includes('duplicate-gtm'), 'a duplicate GTM installation fails the audit');
write('src/layouts/BaseLayout.astro', layout);
write('astro.config.mjs', config);
sh('npm run build', site);
expect(doctor().report.ok, 'the restored site passes again');

// Delivery API loader, against a local stand-in for the Delivery API. The
// settings come from the site's ignored .env file, as they would locally.
const port = 4600 + Math.floor(Math.random() * 300);
const key = `alk_${'e2eKey'.repeat(7)}`;
const fixture = join(work, 'delivery.json');
const setItems = (value) => writeFileSync(fixture, JSON.stringify(value));
const work_ = (n, payload = { title: `実績 ${n}`, client: `顧客 ${n}` }) => ({
  canonical_id: `w-${n}`,
  type: 'works',
  version: 1,
  published_at: '2026-09-01T10:00:00+09:00',
  updated_at: `2026-09-01T10:${String(n % 60).padStart(2, '0')}:00+09:00`,
  payload,
});
setItems({ items: Array.from({ length: 150 }, (_, i) => work_(i + 1)) });
const server = spawn(process.execPath, [join(root, 'scripts/fake-delivery.mjs'), String(port), fixture, key], { stdio: 'ignore' });
process.on('exit', () => server.kill());
await new Promise((resolve) => setTimeout(resolve, 500));

write('.env', `YATRIS_DELIVERY_ENDPOINT=http://127.0.0.1:${port}/api/v1/delivery/7\nYATRIS_DELIVERY_API_KEY=${key}\n`);
mkdirSync(join(site, 'src/pages/works'), { recursive: true });
const workSchema = `const schema = z.object({ title: z.string(), client: z.string() });`;
write(
  'src/pages/works/index.astro',
  `---
import { z } from 'astro/zod';
import { getYatrisList } from '@yatris/astro/delivery';
import BaseLayout from '../../layouts/BaseLayout.astro';
${workSchema}
const works = await getYatrisList('works', { schema });
---
<BaseLayout page={{ title: '実績紹介' }}>
  <ul>{works.map((w) => <li><a href={\`/works/\${w.canonicalId}/\`}>{w.data.title}</a></li>)}</ul>
</BaseLayout>
`,
);
write(
  'src/pages/works/[id].astro',
  `---
import { z } from 'astro/zod';
import { getYatrisList } from '@yatris/astro/delivery';
import BaseLayout from '../../layouts/BaseLayout.astro';
export async function getStaticPaths() {
  // getStaticPaths cannot see other frontmatter variables, so the schema lives here.
  ${workSchema}
  const works = await getYatrisList('works', { schema });
  return works.map((work) => ({ params: { id: work.canonicalId }, props: { work } }));
}
const { work } = Astro.props;
---
<BaseLayout page={{ title: work.data.title }}><h1>{work.data.title}</h1><p>{work.data.client}</p></BaseLayout>
`,
);
write(
  'src/pages/news.astro',
  `---
import { getYatrisList } from '@yatris/astro/delivery';
import BaseLayout from '../layouts/BaseLayout.astro';
const news = await getYatrisList('news', { allowEmpty: true });
---
<BaseLayout page={{ title: 'お知らせ' }}>
  {news.length === 0 ? <p>お知らせはまだありません。</p> : <ul>{news.map((n) => <li>{n.canonicalId}</li>)}</ul>}
</BaseLayout>
`,
);

sh('npm run build', site);
expect(read('dist/works/index.html').split('href="/works/w-').length - 1 === 150, 'the list page renders all 150 published items across two API pages');
expect(existsSync(join(site, 'dist/works/w-150/index.html')) && read('dist/works/w-150/index.html').includes('顧客 150'), 'getStaticPaths builds a detail page per item');
expect(read('dist/news/index.html').includes('お知らせはまだありません。'), 'an empty list that is allowed to be empty renders its empty state');
expect(doctor().report.ok, 'doctor passes the content site and finds no key in the build output');
expect(!distFiles('.html').concat(distFiles('.js')).some((f) => f.includes(key)), 'the Delivery key never reaches the built output');

const failedBuild = (label) => {
  const r = spawnSync('npm run build', { cwd: site, shell: true, encoding: 'utf8', env });
  return { failed: r.status !== 0, output: `${r.stdout}\n${r.stderr}`, label };
};
setItems({ malformed: true });
let build = failedBuild();
expect(build.failed && build.output.includes('malformed Delivery response'), 'a malformed Delivery envelope fails the build');
setItems({ items: [work_(1), work_(2, { title: '実績 2' })] });
build = failedBuild();
expect(
  build.failed && build.output.includes('Content Type "works", item w-2: content does not match the declared schema'),
  'an item that does not match the declared schema fails the build, naming the item',
);
expect(!build.output.includes(key), 'build failures never print the Delivery key');

server.kill();
for (const path of ['src/pages/works', 'src/pages/news.astro', '.env']) rmSync(join(site, path), { recursive: true });

// The configuration matches what Astro's own installers produce.
const configBefore = sha('astro.config.mjs');
const added = sh('npx astro add tailwind alpinejs --yes', site, { both: true });
expect(added.includes('Configuration up-to-date'), '`astro add tailwind alpinejs` finds nothing to configure');
expect(sha('astro.config.mjs') === configBefore, '`astro add` leaves astro.config.mjs unchanged');

if (!process.env.E2E_KEEP) rmSync(work, { recursive: true, force: true });
console.log('e2e: all checks passed');
