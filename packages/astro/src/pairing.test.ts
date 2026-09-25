import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run } from './commands.js';
import { looksLikeCredential } from './mcp.js';
import { apiBaseFrom, exchangeSetupCode, pairProject, parseIdentity, type SiteIdentity } from './pairing.js';

const identity: SiteIdentity = {
  contractVersion: 1,
  website: { id: 42, name: 'client.example.jp', url: 'https://client.example.jp', timezone: 'Asia/Tokyo', status: 'preparing' },
  mcp: { contractVersion: 1, server: { name: 'yatris', transport: 'streamable-http', url: 'https://app.yatris.jp/mcp/yatris' } },
  delivery: { endpoint: 'https://app.yatris.jp/api/v1/delivery/42', credentials: 'deferred' },
  schema: { mode: 'immediate', revision: null },
};

const answering = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'yatris-pairing-'));
  mkdirSync(join(root, '.yatris'));
  writeFileSync(join(root, '.yatris/project.json'), JSON.stringify({ contractVersion: 1, websiteId: null, environment: 'production', templateVersion: '0.0.0' }));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('pairing', () => {
  it('finds Yatris from the MCP server origin', () => {
    expect(apiBaseFrom('https://app.yatris.jp/mcp/yatris')).toBe('https://app.yatris.jp');
  });

  it('exchanges a setup code for identity only', async () => {
    await expect(exchangeSetupCode('ABCD-EFGH', { apiBase: 'https://app.yatris.jp', client: { name: 't', version: '0' }, fetch: answering(identity) })).resolves.toEqual(identity);
  });

  it('surfaces a refused code', async () => {
    const refused = exchangeSetupCode('ABCD-EFGH', { apiBase: 'https://app.yatris.jp', client: { name: 't', version: '0' }, fetch: answering({ message: 'invalid or expired' }, 422) });
    await expect(refused).rejects.toThrow('invalid or expired');
  });

  it('refuses an answer that carries anything credential-like', () => {
    expect(() => parseIdentity({ ...identity, delivery: { endpoint: identity.delivery.endpoint, credentials: 'deferred', key: 'alk_abcdef1234567890' } })).toThrow('credential');
    expect(() => parseIdentity({ ...identity, mcp: { ...identity.mcp, server: { ...identity.mcp.server, url: 'ftp://nope' } } })).toThrow();
  });

  it('writes identity, the MCP adapters and the lock, and no secret', () => {
    const written = pairProject(root, identity);

    expect(written).toEqual(expect.arrayContaining(['.yatris/project.json', '.yatris/mcp.json', '.mcp.json', '.codex/config.toml', '.yatris/schema.lock.json']));
    const project = JSON.parse(readFileSync(join(root, '.yatris/project.json'), 'utf8'));
    expect(project).toMatchObject({ contractVersion: 1, websiteId: 42, templateVersion: '0.0.0', deliveryEndpoint: identity.delivery.endpoint });
    expect(JSON.parse(readFileSync(join(root, '.yatris/schema.lock.json'), 'utf8')).websiteId).toBe(42);
    for (const path of written) {
      expect(looksLikeCredential(readFileSync(join(root, path), 'utf8'))).toBe(false);
    }
  });

  it('will not silently re-pair a project with another Website', () => {
    pairProject(root, identity);
    const other = { ...identity, website: { ...identity.website, id: 7 } };

    expect(() => pairProject(root, other)).toThrow('already paired with Website 42');
    expect(pairProject(root, other, { force: true })).toContain('.yatris/project.json');
  });

  it('pairs an existing repository with yatris connect', async () => {
    const result = await run(['connect', 'ABCD-EFGH'], { cwd: root, fetch: answering(identity), yatrisUrl: 'https://app.yatris.jp' });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Paired with Yatris Website 42');
    expect(existsSync(join(root, '.mcp.json'))).toBe(true);
    expect((await run(['connect'], { cwd: root })).code).toBe(1);
  });

  it('asks for the code when none is given, keeping it out of shell history', async () => {
    const asked: string[] = [];
    const result = await run(['connect'], {
      cwd: root,
      fetch: answering(identity),
      yatrisUrl: 'https://app.yatris.jp',
      prompt: async (question) => {
        asked.push(question);
        return 'ABCD-EFGH';
      },
    });

    expect(asked).toEqual(['Yatris setup code: ']);
    expect(result.code).toBe(0);
  });
});

describe('MCP availability', () => {
  // Spec §18 / YatrisCMS#270: the MCP server is for agent clients only. A
  // deployed site's build and runtime never contact it, so its being down
  // cannot break the site.
  it('is never imported by anything a site builds or ships', () => {
    const shipped = ['index.ts', 'config.ts', 'env.ts', 'delivery.ts', 'head.ts', 'navigation.ts'];
    for (const file of shipped) {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
      expect(source, file).not.toMatch(/from '\.\/(mcp|pairing)(\.js)?'/);
      expect(source, file).not.toContain('/mcp/yatris');
    }
    const components = new URL('../components/', import.meta.url);
    for (const file of readdirSync(components)) {
      expect(readFileSync(new URL(file, components), 'utf8'), file).not.toMatch(/mcp/i);
    }
  });
});
