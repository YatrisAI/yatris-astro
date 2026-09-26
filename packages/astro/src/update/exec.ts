import { spawn } from 'node:child_process';

export interface ExecResult {
  code: number;
  output: string;
}

/** Runs a command and collects its combined output; never rejects. */
export type Exec = (command: string[], options: { cwd: string; env?: Record<string, string> }) => Promise<ExecResult>;

export const exec: Exec = (command, { cwd, env }) =>
  new Promise((resolve) => {
    const [bin, ...args] = command;
    const options = { cwd, env: { ...process.env, ...env } };
    // npm is a .cmd shim on Windows, which only a shell can start
    const child = process.platform === 'win32' ? spawn(command.map(quote).join(' '), { ...options, shell: true }) : spawn(bin, args, options);
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('close', (code) => resolve({ code: code ?? 1, output }));
    child.on('error', (error) => resolve({ code: 1, output: String(error) }));
  });

function quote(arg: string): string {
  return /^[\w@./:=^~+-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`;
}

/** The last lines of a command's output, with anything key-like masked. */
export function tail(output: string, lines = 20): string {
  return output
    .replace(/alk_[A-Za-z0-9]{6,}/g, 'alk_…')
    .trim()
    .split('\n')
    .slice(-lines)
    .join('\n');
}
