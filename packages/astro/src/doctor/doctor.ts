import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { PlatformManifest } from '../platform.js';
import { auditHtml } from './audit.js';
import { findCredentials, type Finding, type Stage } from './findings.js';
import { checkForms, type FormsDoctorOptions } from './forms.js';
import { lintSource } from './lint.js';
import { checkStructure } from './structure.js';

export interface DoctorOptions {
  root: string;
  stage: Stage;
  manifest: PlatformManifest;
  /** Build output directory, relative to `root`. */
  dist: string;
  /** Runs the production build; resolves to its exit code and combined output. */
  build?: () => Promise<{ code: number; output: string }>;
  /** Contact-form checks; without `remote`, Yatris readiness is reported as unverified. */
  forms?: FormsDoctorOptions;
}

export interface DoctorReport {
  stage: Stage;
  ok: boolean;
  findings: Finding[];
}

const SOURCE = /\.(astro|ts|tsx|js|jsx|mjs|cjs|html|md|mdx|css)$/;
const BUILT_TEXT = /\.(html|js|mjs|css|json|txt|xml|webmanifest|map)$/;

/** Stage-aware diagnostics: structure, source lint, build and built-output audit. */
export async function doctor(options: DoctorOptions): Promise<DoctorReport> {
  const { root, stage } = options;
  const findings = checkStructure(root, options.manifest);

  for (const file of files(join(root, 'src'), SOURCE)) {
    findings.push(...lintSource(rel(root, file), readFileSync(file, 'utf8')));
  }

  findings.push(...(await checkForms(root, options.forms)));

  if (options.build) {
    const { code, output } = await options.build();
    if (code !== 0) {
      findings.push({ severity: 'error', code: 'build-failed', message: `the production build failed:\n${tail(output)}` });
    }
  }

  const dist = join(root, options.dist);
  if (!existsSync(dist)) {
    findings.push({ severity: 'error', code: 'no-build-output', message: `${options.dist}/ does not exist; run the build first` });
  } else {
    for (const file of files(dist, BUILT_TEXT)) {
      const text = readFileSync(file, 'utf8');
      findings.push(...(file.endsWith('.html') ? auditHtml(rel(root, file), text, stage) : findCredentials(rel(root, file), text)));
    }
  }

  return { stage, ok: !findings.some((f) => f.severity === 'error'), findings };
}

export function formatReport(report: DoctorReport): string {
  const errors = report.findings.filter((f) => f.severity === 'error');
  const warnings = report.findings.filter((f) => f.severity === 'warning');
  const unverified = report.findings.filter((f) => f.severity === 'unverified');
  const line = (f: Finding) => `  ${f.severity === 'error' ? '✖' : f.severity === 'warning' ? '⚠' : '?'} ${f.code}${f.file ? ` ${f.file}` : ''}: ${f.message}`;
  // Unverified remote checks are named in the summary, never counted as passed
  const pending = unverified.length ? `; ${unverified.length} remote check(s) unverified` : '';
  return [
    `yatris doctor --stage=${report.stage}`,
    ...errors.map(line),
    ...warnings.map(line),
    ...unverified.map(line),
    report.ok
      ? `✔ passed${unverified.length ? ' local checks' : ''}${warnings.length ? ` with ${warnings.length} warning(s)` : ''}${pending}`
      : `✖ failed: ${errors.length} error(s), ${warnings.length} warning(s)${pending}`,
  ].join('\n');
}

function files(dir: string, pattern: RegExp): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && pattern.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
}

function rel(root: string, path: string): string {
  return relative(root, path).replaceAll('\\', '/');
}

function tail(output: string, lines = 20): string {
  return output
    .replace(/alk_[A-Za-z0-9]{6,}/g, 'alk_…')
    .trim()
    .split('\n')
    .slice(-lines)
    .join('\n');
}
