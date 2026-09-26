import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { apiBaseFrom, exchangeSetupCode, pairProject } from '@yatris/astro/pairing';
import { readPlatformManifest } from '@yatris/astro/platform';
import { createProject } from './create.js';

export interface Environment {
  out(line: string): void;
  err(line: string): void;
  /** Runs a command with inherited output and resolves to its exit code. */
  exec(command: string, args: string[], cwd: string): Promise<number>;
  /** Asks a question on an interactive terminal; undefined when not interactive. */
  prompt?: (question: string) => Promise<string>;
  manifestUrl?: URL;
  templateDir?: string;
  skillsDir?: string;
  /** Network access for --connect; defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Overrides the Yatris origin (YATRIS_URL); defaults to the manifest's MCP origin. */
  yatrisUrl?: string;
}

const HELP = `Usage: npm create yatris@latest <directory> [-- options]

Creates a new Yatris-managed Astro website: Astro, Tailwind CSS 4, Alpine.js 3,
agent instructions and skills. No design, CMS or credentials are required.

Options:
  --pair        Pair the new site with its Yatris Website: asks for the
                single-use setup code from the dashboard, so the code never
                appears in shell history. Optional now; required before
                content design (pair later with \`npx yatris connect\`)
  --connect <code>  Non-interactive pairing, for automation only: the code
                    ends up in shell history
  --no-install  Write the files only; skip npm install and the first build
  --no-git      Do not initialise a Git repository
  --yes         Never prompt (fails if the directory is missing)
  --version     Print the initializer and Yatris platform versions
  --help        Show this help`;

const packaged = (path: string): string => fileURLToPath(new URL(`../${path}`, import.meta.url));

export async function run(argv: string[], env: Environment): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      allowNegative: true,
      options: {
        install: { type: 'boolean', default: true },
        git: { type: 'boolean', default: true },
        yes: { type: 'boolean', short: 'y', default: false },
        version: { type: 'boolean', short: 'v', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        connect: { type: 'string' },
        pair: { type: 'boolean', default: false },
        // Test hook: install @yatris/astro from a local tarball.
        'yatris-astro': { type: 'string' },
      },
    });
  } catch (error) {
    env.err(`create-yatris: ${(error as Error).message}\n\n${HELP}`);
    return 1;
  }
  const { values, positionals } = parsed;
  const manifest = readPlatformManifest(env.manifestUrl ?? new URL('../platform.json', import.meta.url));

  if (values.version) {
    const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    env.out(`create-yatris ${version} (Yatris platform ${manifest.platformVersion})`);
    return 0;
  }
  if (values.help) {
    env.out(HELP);
    return 0;
  }
  let directory = positionals[0];
  if (directory === undefined && !values.yes && env.prompt) {
    directory = (await env.prompt('Project directory: ')).trim();
  }
  if (!directory) {
    env.err(`create-yatris: a project directory is required.\n\n${HELP}`);
    return 1;
  }

  let target: string;
  try {
    target = createProject(
      { targetDir: directory, yatrisAstroSpec: values['yatris-astro'] },
      {
        templateDir: env.templateDir ?? packaged('template'),
        skillsDir: env.skillsDir ?? packaged('skills'),
        manifest,
      },
    );
  } catch (error) {
    env.err(`create-yatris: ${(error as Error).message}`);
    return 1;
  }
  env.out(`Created ${target} on Yatris platform ${manifest.platformVersion}.`);

  // Pairing (YatrisCMS#270): identity and MCP configuration only, never a
  // secret. A code that fails leaves an unpaired but complete project.
  let setupCode = values.connect;
  if (values.pair && setupCode === undefined) {
    if (!env.prompt) {
      env.err('create-yatris: --pair needs an interactive terminal. The project was created unpaired; pair it later with `npx yatris connect`.');
      return 1;
    }
    setupCode = (await env.prompt('Yatris setup code: ')).trim();
  }
  if (setupCode !== undefined) {
    try {
      const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
      const identity = await exchangeSetupCode(setupCode, {
        apiBase: env.yatrisUrl ?? process.env.YATRIS_URL ?? apiBaseFrom(manifest.mcp.url),
        client: { name: 'create-yatris', version },
        fetch: env.fetch,
      });
      pairProject(target, identity);
      env.out(`Paired with Yatris Website ${identity.website.id} (${identity.website.name}).`);
    } catch (error) {
      env.err(`create-yatris: pairing failed: ${(error as Error).message} The project was created unpaired; pair it later with \`npx yatris connect <code>\`.`);
      return 1;
    }
  }

  // Tailwind's source scanning honours .gitignore only inside a Git
  // repository. Without one it watches .astro/, and the dev server reloads
  // in a loop whenever Astro writes there.
  // Managed repositories use main, whatever the local Git default is (#273)
  if (values.git && (await env.exec('git', ['init', '--quiet', '--initial-branch=main'], target)) !== 0) {
    env.err('create-yatris: warning: `git init` failed. Initialise a Git repository before running `npm run dev`.');
  }

  if (values.install) {
    for (const [command, args] of [
      ['npm', ['install', '--no-audit', '--no-fund']],
      ['npm', ['run', 'build']],
    ] as const) {
      const code = await env.exec(command, [...args], target);
      if (code !== 0) {
        env.err(`create-yatris: \`${command} ${args.join(' ')}\` failed with exit code ${code}.`);
        return 1;
      }
    }
  }

  env.out(`\nNext steps:\n  cd ${directory}${values.install ? '' : '\n  npm install'}\n  npm run dev`);
  return 0;
}
