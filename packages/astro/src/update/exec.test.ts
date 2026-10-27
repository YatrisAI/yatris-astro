import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exec, TIMED_OUT } from './exec.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'yatris-exec-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Writes a Node script into the temp directory and returns the command that runs it. */
function script(name: string, source: string): string[] {
  const path = join(dir, name);
  writeFileSync(path, source);
  return [process.execPath, path];
}

describe('exec, as the updater runs install and verification steps', () => {
  it('stops a command that outlives its limit together with what it started, and says so', async () => {
    const marker = join(dir, 'grandchild-survived');
    // A test runner that starts a server which would outlive it
    const grandchild = script('grandchild.cjs', `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x'), 2500);`);
    const command = script(
      'parent.cjs',
      `require('node:child_process').spawn(${JSON.stringify(grandchild[0])}, [${JSON.stringify(grandchild[1])}], { stdio: 'inherit' });
       console.log('started');
       setTimeout(() => {}, 60_000);`,
    );

    const startedAt = Date.now();
    const result = await exec(command, { cwd: dir, timeoutMs: 1000 });

    expect(result.code).toBe(TIMED_OUT);
    expect(result.output).toContain('started');
    expect(result.output).toMatch(/was still running after 1000 ms, so it was stopped with everything it started/);
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    // Past the moment the grandchild would have written its file
    await new Promise((r) => setTimeout(r, 2500));
    expect(existsSync(marker)).toBe(false);
  }, 20_000);

  it('reports progress while a command runs, with its output so far', async () => {
    const command = script('slow.cjs', `console.log('Running 40 tests'); setTimeout(() => console.log('done'), 700);`);
    const beats: { elapsedMs: number; output: string }[] = [];

    const result = await exec(command, { cwd: dir, heartbeatMs: 200, onWait: (elapsedMs, output) => beats.push({ elapsedMs, output }) });

    expect(result).toEqual({ code: 0, output: expect.stringContaining('done') });
    expect(beats.length).toBeGreaterThanOrEqual(2);
    expect(beats[0].output).toContain('Running 40 tests');
    expect(beats.at(-1)!.elapsedMs).toBeGreaterThan(beats[0].elapsedMs);
  }, 20_000);

  it('gives the command a closed stdin, so a prompt ends instead of waiting forever', async () => {
    const command = script('prompt.cjs', `process.stdin.on('data', () => {}); process.stdin.on('end', () => console.log('stdin closed'));`);

    const result = await exec(command, { cwd: dir, timeoutMs: 10_000 });

    expect(result).toEqual({ code: 0, output: expect.stringContaining('stdin closed') });
  }, 20_000);

  it('leaves a command without a limit alone, and returns its exit code', async () => {
    const result = await exec(script('fails.cjs', `console.error('nope'); process.exit(3);`), { cwd: dir });
    expect(result).toEqual({ code: 3, output: expect.stringContaining('nope') });
  });
});
