import { readFileSync } from 'node:fs';
import { readPlatformManifest } from '@yatris/astro/platform';

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

const HELP = `Usage: npm create yatris@latest <directory>

Options:
  --version  Print the initializer and Yatris platform versions
  --help     Show this help`;

/** The Yatris platform release this initializer creates sites on. */
export const bundledManifestUrl = new URL('../platform.json', import.meta.url);

export function run(argv: string[], manifestUrl: URL = bundledManifestUrl): CliResult {
  const [first] = argv;

  if (first === '--version' || first === '-v') {
    const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const platform = readPlatformManifest(manifestUrl);
    return { code: 0, stdout: `create-yatris ${version} (Yatris platform ${platform.platformVersion})`, stderr: '' };
  }

  if (first === '--help' || first === '-h') {
    return { code: 0, stdout: HELP, stderr: '' };
  }

  return {
    code: 1,
    stdout: '',
    stderr: 'create-yatris: project creation is not available in this pre-release.\n\n' + HELP,
  };
}
