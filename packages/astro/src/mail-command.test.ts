import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeYatris } from '../test/fake-yatris.js';
import { run } from './commands.js';
import { parseEnvFile } from './mail-command.js';
import { RemoteError } from './yatris-remote.js';

/**
 * `yatris mail sync --env-file` (YatrisCMS#390): reads SMTP settings in the
 * helper process, sends them once to import_mail_profile, and no secret ever
 * reaches stdout, stderr, the JSON output or any written file.
 */

const PASSWORD = 'pw-Zq9!x7#Secret"value';
const USERNAME = 'smtp-user-4471';
let root: string;
let fake: FakeYatris;

const ENV_FILE = `# customer SMTP (never commit)
YATRIS_SMTP_HOST=smtp.example.jp
YATRIS_SMTP_PORT=587
YATRIS_SMTP_SECURITY=starttls
YATRIS_SMTP_USERNAME=${USERNAME}
YATRIS_SMTP_PASSWORD='${PASSWORD}'
YATRIS_MAIL_FROM_ADDRESS=info@example.jp
YATRIS_MAIL_FROM_NAME="株式会社サンプル"
YATRIS_MAIL_REPLY_TO_ADDRESS=
`;

function site(): string {
  const dir = mkdtempSync(join(tmpdir(), 'yatris-mail-'));
  mkdirSync(join(dir, '.yatris'));
  writeFileSync(join(dir, '.yatris/project.json'), JSON.stringify({ contractVersion: 1, websiteId: 42 }));
  writeFileSync(join(dir, '.yatris/mcp.json'), JSON.stringify({ contractVersion: 1, server: { name: 'yatris', transport: 'streamable-http', url: 'https://app.yatris.jp/mcp/yatris' } }));
  writeFileSync(join(dir, '.env'), ENV_FILE);
  return dir;
}

const mail = (args: string[], environment: Record<string, string | undefined> = { YATRIS_MCP_TOKEN: 'test-token' }) =>
  run(['mail', ...args], { cwd: root, environment, mcpTransport: () => fake, retryDelayMs: 0 });

/** Every file under the site except the .env that holds the secret by design. */
function writtenFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && !(e.name === '.env' && e.parentPath === dir))
    .map((e) => readFileSync(join(e.parentPath, e.name), 'utf8'));
}

function expectNoSecret(...texts: string[]) {
  for (const text of [...texts, ...writtenFiles(root)]) {
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain('Zq9');
  }
}

beforeEach(() => {
  root = site();
  fake = new FakeYatris();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('yatris mail sync', () => {
  it('imports the settings once as a pending profile and prints only the redacted result and the next step', async () => {
    const log = vi.spyOn(console, 'log');
    const error = vi.spyOn(console, 'error');
    const result = await mail(['sync', '--env-file', '.env']);
    expect(result.code, result.stderr).toBe(0);
    expect(fake.calledTools()).toEqual(['import_mail_profile']);
    const args = fake.calls[0].args as Record<string, any>;
    expect(args).toMatchObject({ website: 42, settings: { host: 'smtp.example.jp', port: 587, security: 'starttls', username: USERNAME, password: PASSWORD, from_address: 'info@example.jp', from_name: '株式会社サンプル' } });
    expect(args.settings).not.toHaveProperty('reply_to');
    expect(String(args.idempotency_key)).toMatch(/^mail-sync-[0-9a-f-]{36}$/);
    expect(JSON.stringify(args)).not.toContain('password_set');

    expect(result.stdout).toContain('pending profile (revision 3)');
    expect(result.stdout).toContain('It is not active yet');
    expect(result.stdout).toContain('メールの連携');
    expect(result.stdout).not.toMatch(/password_set/);
    expectNoSecret(result.stdout, result.stderr);
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('--json carries no password', async () => {
    const result = await mail(['sync', '--env-file=.env', '--json']);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toMatchObject({ status: 'pending_test', revision: 3, website: 42 });
    expect(JSON.stringify(parsed)).not.toMatch(/password/i);
    expectNoSecret(result.stdout);
  });

  it('empty SMTP variables send nothing and never remove a profile', async () => {
    writeFileSync(join(root, '.env'), 'YATRIS_SMTP_HOST=\nYATRIS_SMTP_PASSWORD=\nYATRIS_MAIL_FROM_NAME=Sample\n');
    const result = await mail(['sync', '--env-file', '.env']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('nothing was sent');
    expect(result.stdout).toContain('never removes a profile');
    expect(fake.calls).toEqual([]);
  });

  it('a partial configuration fails listing missing names only', async () => {
    writeFileSync(join(root, '.env'), `YATRIS_SMTP_HOST=smtp.example.jp\nYATRIS_SMTP_PASSWORD=${PASSWORD}\n`);
    const result = await mail(['sync', '--env-file', '.env']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('YATRIS_SMTP_PORT, YATRIS_SMTP_SECURITY, YATRIS_SMTP_USERNAME, YATRIS_MAIL_FROM_ADDRESS, YATRIS_MAIL_FROM_NAME');
    expect(result.stderr).not.toContain('smtp.example.jp');
    expectNoSecret(result.stderr);
    expect(fake.calls).toEqual([]);
  });

  it('requires an explicit security mode and validates without echoing values', async () => {
    writeFileSync(join(root, '.env'), ENV_FILE.replace('YATRIS_SMTP_SECURITY=starttls', `YATRIS_SMTP_SECURITY=${PASSWORD}`).replace('YATRIS_SMTP_PORT=587', 'YATRIS_SMTP_PORT=99999'));
    const result = await mail(['sync', '--env-file', '.env']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('YATRIS_SMTP_SECURITY must be starttls or tls');
    expect(result.stderr).toContain('YATRIS_SMTP_PORT is not a port number');
    expectNoSecret(result.stderr);
    expect(fake.calls).toEqual([]);

    writeFileSync(join(root, '.env'), ENV_FILE.replace('YATRIS_SMTP_SECURITY=starttls\n', ''));
    expect(await mail(['sync', '--env-file', '.env'])).toMatchObject({ code: 1, stderr: expect.stringContaining('set YATRIS_SMTP_SECURITY') });
  });

  it('falls back to this shell\'s environment for names the file lacks', async () => {
    writeFileSync(join(root, '.env'), ENV_FILE.replace(/YATRIS_SMTP_PASSWORD=.*\n/, ''));
    const result = await mail(['sync', '--env-file', '.env'], { YATRIS_MCP_TOKEN: 'test-token', YATRIS_SMTP_PASSWORD: PASSWORD });
    expect(result.code, result.stderr).toBe(0);
    expect((fake.calls[0].args.settings as Record<string, unknown>).password).toBe(PASSWORD);
    expectNoSecret(result.stdout, result.stderr);
  });

  it('reuses its idempotency key on a transport retry', async () => {
    fake.failNext('import_mail_profile', new RemoteError('backend_unavailable', 'HTTP 503'), 2);
    expect((await mail(['sync', '--env-file', '.env'])).code).toBe(0);
    const keys = fake.calls.map((c) => c.args.idempotency_key);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
  });

  it('scrubs every supplied value from Yatris error messages', async () => {
    fake.failNext('import_mail_profile', new RemoteError('tool_error', `SMTP login failed for ${USERNAME} with ${PASSWORD} at smtp.example.jp`, 'validation'));
    const result = await mail(['sync', '--env-file', '.env']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('SMTP login failed for [redacted] with [redacted] at [redacted]');
    expect(result.stderr).not.toContain(USERNAME);
    expectNoSecret(result.stderr);
  });

  it('exits 75 when Yatris is unreachable, 69 without the tool, 4 unpaired, 5 without a credential', async () => {
    fake.failNext('import_mail_profile', new RemoteError('backend_unavailable', 'HTTP 503'), 3);
    expect((await mail(['sync', '--env-file', '.env'])).code).toBe(75);
    fake.knownTools.delete('import_mail_profile');
    const unknown = await mail(['sync', '--env-file', '.env']);
    expect(unknown.code).toBe(69);
    expectNoSecret(unknown.stderr);
    expect((await mail(['sync', '--env-file', '.env'], {})).code).toBe(5);
    writeFileSync(join(root, '.yatris/project.json'), JSON.stringify({ contractVersion: 1, websiteId: null }));
    expect((await mail(['sync', '--env-file', '.env'])).code).toBe(4);
  });

  it('never echoes command-line arguments (a pasted secret)', async () => {
    const result = await mail(['sync', PASSWORD]);
    expect(result.code).toBe(1);
    expectNoSecret(result.stderr);
    expect(fake.calls).toEqual([]);
  });

  it('a missing env file sends nothing', async () => {
    expect(await mail(['sync', '--env-file', 'nope.env'])).toMatchObject({ code: 1, stderr: expect.stringContaining('does not exist') });
    expect(fake.calls).toEqual([]);
  });
});

describe('parseEnvFile', () => {
  it('reads dotenv syntax without evaluating it', () => {
    expect(
      parseEnvFile('﻿# c\nexport A=1\nB = "two # not a comment"\nC=three # comment\nD=\'$(rm -rf) ${X}\'\nE="a\\nb\\"c"\nnot a line\nF=\n'),
    ).toEqual({ A: '1', B: 'two # not a comment', C: 'three', D: '$(rm -rf) ${X}', E: 'a\nb"c', F: '' });
  });
});
