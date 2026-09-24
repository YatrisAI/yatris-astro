#!/usr/bin/env node
import { run } from './commands.js';

const result = await run(process.argv.slice(2), { cwd: process.cwd() });
if (result.stdout) console.log(result.stdout);
if (result.stderr) console.error(result.stderr);
process.exitCode = result.code;
