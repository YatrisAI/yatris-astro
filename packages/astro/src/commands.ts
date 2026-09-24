import { readFileSync } from 'node:fs';
import { readPlatformManifest } from './platform.js';

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

const HELP = `Usage: yatris <command>

Options:
  --version  Print the package and Yatris platform versions
  --help     Show this help

Commands arrive in later releases (doctor, schema, update).`;

export function run(argv: string[], manifestUrl?: URL): CliResult {
  const [first] = argv;

  if (first === '--version' || first === '-v') {
    const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const platform = readPlatformManifest(manifestUrl);
    return { code: 0, stdout: `@yatris/astro ${version} (Yatris platform ${platform.platformVersion})`, stderr: '' };
  }

  if (first === undefined || first === '--help' || first === '-h') {
    return { code: 0, stdout: HELP, stderr: '' };
  }

  return { code: 1, stdout: '', stderr: `yatris: unknown command "${first}"\n\n${HELP}` };
}
