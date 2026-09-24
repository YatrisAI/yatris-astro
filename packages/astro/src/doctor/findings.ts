export type Severity = 'error' | 'warning';

/** The lifecycle stages `yatris doctor` knows. Only `scaffold` is implemented so far. */
export const STAGES = ['scaffold'] as const;
export type Stage = (typeof STAGES)[number];

export interface Finding {
  severity: Severity;
  code: string;
  message: string;
  file?: string;
}

const CREDENTIALS: [string, RegExp][] = [
  ['Yatris API key', /alk_[A-Za-z0-9]{32,}/g],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})/g],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
];

/** Recognizable credentials in `text`, redacted for safe reporting. */
export function findCredentials(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  for (const [kind, pattern] of CREDENTIALS) {
    for (const match of text.matchAll(pattern)) {
      findings.push({
        severity: 'error',
        code: 'credential-leak',
        message: `${kind} found (${match[0].slice(0, 6)}…)`,
        file,
      });
    }
  }
  return findings;
}
