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
  if (pkg.name === '@yatris/astro') {
    for (const component of ['components/YatrisHead.astro', 'components/YatrisBodyStart.astro', 'components/YatrisForm.astro', 'components/YatrisForm.css', 'dist/forms-client/index.js', 'dist/forms-client/preview.js']) {
      expect(files.includes(component), `@yatris/astro tarball contains ${component}`);
    }
    // `yatris update` seeds a missing .env.example from the release's own template
    expect(files.includes('template/.env.example'), '@yatris/astro tarball contains the template .env.example');
  }
  // Both packages carry the skill pack: create-yatris scaffolds it, `yatris update` delivers it
  for (const file of ['skills/yatris-contact-form/SKILL.md', 'skills/yatris-contact-form/references/brief.schema.json', 'template/AGENTS.md']) {
    expect(files.includes(file), `${pkg.name} tarball contains ${file}`);
  }
  if (pkg.name === 'create-yatris') {
    expect(files.includes('template/README.md'), 'create-yatris tarball contains the template');
    expect(files.includes('template/.env.example'), 'create-yatris tarball contains the template .env.example');
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

const capabilities = sh(`node --input-type=module -e "import { SUPPORTED_CAPABILITIES } from '@yatris/astro/forms/client'; import { formMountConfig } from '@yatris/astro/forms/mount'; console.log(SUPPORTED_CAPABILITIES.includes('confirm_step') && formMountConfig({ mode: 'live', origin: 'https://app.yatris.jp', websiteId: 1, timeZone: 'Asia/Tokyo' }, { form: 'contact' }).publicKey)"`, appDir);
expect(capabilities === '1.contact', 'the forms renderer and mount helper import from the installed package');
expect(sh('npm exec --offline -- yatris forms validate', appDir).includes('no declarations'), 'yatris forms validate runs');
const reservation = sh(`node --input-type=module -e "import { validateSetup } from '@yatris/astro/reservations'; import { readFileSync } from 'node:fs'; const setup = JSON.parse(readFileSync(new URL(import.meta.resolve('@yatris/astro/contracts/reservations/v1/examples/salon.json')), 'utf8')); console.log(validateSetup(setup).valid)"`, appDir);
expect(reservation === 'true', 'the reservation contract and its examples import from the installed package');

// A site scaffolded by the installed create-yatris (files only) carries the
// contact-form skill in both agent locations and the root guidance, and the
// skill's first example declaration passes the installed validator.
sh('npm exec --offline -- create-yatris scaffolded --yes --no-install --no-git', appDir);
const scaffolded = resolve(appDir, 'scaffolded');
const skillMd = ['.agents/skills', '.claude/skills'].map((location) => readFileSync(resolve(scaffolded, location, 'yatris-contact-form/SKILL.md'), 'utf8'));
expect(skillMd[0] === skillMd[1] && skillMd[0].includes('name: yatris-contact-form'), 'the scaffold has the yatris-contact-form skill for Codex and Claude Code');
const agents = readFileSync(resolve(scaffolded, 'AGENTS.md'), 'utf8');
expect(agents.includes('Contact and inquiry forms always use Yatris') && agents.includes('`yatris-contact-form`'), 'the scaffold AGENTS.md sends contact forms to Yatris and the skill');
const examples = readFileSync(resolve(scaffolded, '.claude/skills/yatris-contact-form/references/examples.md'), 'utf8').replace(/\r\n/g, '\n');
mkdirSync(resolve(scaffolded, 'src/forms'), { recursive: true });
writeFileSync(resolve(scaffolded, 'src/forms/contact.json'), /```json\n([\s\S]*?)```/.exec(examples)[1]);
expect(sh('npm exec --offline -- yatris forms validate --dir=scaffolded/src/forms', appDir).includes('valid (contact)'), 'the skill example declaration validates in the scaffolded site');

rmSync(work, { recursive: true, force: true });
console.log('smoke: all checks passed');
