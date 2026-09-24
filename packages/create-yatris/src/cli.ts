#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { run } from './commands.js';

const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);

process.exitCode = await run(process.argv.slice(2), {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  exec: (command, args, cwd) =>
    new Promise((resolve) => {
      // npm is a .cmd shim on Windows, which only a shell can start.
      const child = spawn(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
      child.on('close', (code) => resolve(code ?? 1));
      child.on('error', () => resolve(1));
    }),
  prompt: interactive
    ? async (question) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try {
          return await rl.question(question);
        } finally {
          rl.close();
        }
      }
    : undefined,
});
