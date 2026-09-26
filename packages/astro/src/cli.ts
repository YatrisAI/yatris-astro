#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { run } from './commands.js';

const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);

const result = await run(process.argv.slice(2), {
  cwd: process.cwd(),
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
if (result.stdout) console.log(result.stdout);
if (result.stderr) console.error(result.stderr);
process.exitCode = result.code;
