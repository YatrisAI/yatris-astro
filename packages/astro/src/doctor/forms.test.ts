import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeYatris } from '../../test/fake-yatris.js';
import { RemoteError, resolveRemote } from '../yatris-remote.js';
import { formatReport } from './doctor.js';
import { checkForms, findMounts, findRoute } from './forms.js';

// Pretend this renderer lacks `field:range`, to check the capability rule
vi.mock('../forms-client/capabilities.js', async (original) => {
  const actual = await original<typeof import('../forms-client/capabilities.js')>();
  return { ...actual, missingCapabilities: (required: readonly string[]) => required.filter((c) => c === 'field:range') };
});

/** Contact-form checks of `yatris doctor` (YatrisCMS#392, spec §13). */

const examples = new URL('../../../../contracts/forms/v1/examples/', import.meta.url);
let root: string;
let fake: FakeYatris;

function site(): string {
  const dir = mkdtempSync(join(tmpdir(), 'yatris-doctor-forms-'));
  mkdirSync(join(dir, 'src/forms'), { recursive: true });
  mkdirSync(join(dir, 'src/pages/contact'), { recursive: true });
  mkdirSync(join(dir, '.yatris'));
  cpSync(new URL('contact.json', examples), join(dir, 'src/forms/contact.json'));
  writeFileSync(join(dir, 'src/pages/contact/index.astro'), `---\nimport YatrisForm from '@yatris/astro/YatrisForm.astro';\n---\n<YatrisForm form="contact" classes={{ submit: 'btn' }} />\n`);
  writeFileSync(join(dir, '.yatris/project.json'), JSON.stringify({ contractVersion: 1, websiteId: 42 }));
  writeFileSync(join(dir, '.yatris/mcp.json'), JSON.stringify({ contractVersion: 1, server: { name: 'yatris', transport: 'streamable-http', url: 'https://app.yatris.jp/mcp/yatris' } }));
  return dir;
}

const remote = () => resolveRemote(root, { environment: { YATRIS_MCP_TOKEN: 'test-token' }, transport: () => fake, retryDelayMs: 0 });
const codes = (findings: Array<{ severity: string; code: string }>) => findings.map((f) => `${f.severity}:${f.code}`);

beforeEach(() => {
  root = site();
  fake = new FakeYatris();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('doctor contact-form checks', () => {
  it('says nothing for a site without forms', async () => {
    rmSync(join(root, 'src'), { recursive: true });
    expect(await checkForms(root)).toEqual([]);
  });

  it('offline, remote readiness is unverified, never passed', async () => {
    writeFileSync(join(root, 'src/pages/contact/thanks.astro'), '<p>ok</p>');
    const findings = await checkForms(root);
    expect(codes(findings)).toEqual(['unverified:forms-remote-unverified']);
    expect(findings[0].message).toContain('offline');

    const report = formatReport({ stage: 'scaffold', ok: true, findings });
    expect(report).toContain('? forms-remote-unverified');
    expect(report).toContain('✔ passed local checks; 1 remote check(s) unverified');
    expect(report).not.toMatch(/✔ passed$/m);
  });

  it('unpaired or without a credential, remote readiness is unverified', async () => {
    writeFileSync(join(root, 'src/pages/contact/thanks.astro'), '');
    const noToken = await checkForms(root, { remote: () => resolveRemote(root, { environment: {} }) });
    expect(codes(noToken)).toEqual(['unverified:forms-remote-unverified']);
    expect(noToken[0].message).toContain('YATRIS_MCP_TOKEN');
    writeFileSync(join(root, '.yatris/project.json'), JSON.stringify({ contractVersion: 1, websiteId: null }));
    expect(codes(await checkForms(root, { remote: () => resolveRemote(root, { environment: { YATRIS_MCP_TOKEN: 'x' } }) }))).toEqual(['unverified:forms-remote-unverified']);
  });

  it('a mount without a declaration, a missing thanks page and an unsupported capability are errors', async () => {
    writeFileSync(join(root, 'src/pages/estimate.astro'), `<YatrisForm form='estimate' />\n<YatrisForm form={key} />`);
    cpSync(new URL('full-coverage.json', examples), join(root, 'src/forms/full-coverage.json'));
    const findings = await checkForms(root);
    expect(codes(findings)).toEqual(
      expect.arrayContaining(['warning:forms-mount-dynamic', 'error:forms-mount-missing', 'error:forms-thanks-missing', 'error:forms-capability-unsupported', 'unverified:forms-remote-unverified']),
    );
    expect(findings.find((f) => f.code === 'forms-mount-missing')!.message).toContain('src/forms/estimate.json');
    expect(findings.find((f) => f.code === 'forms-capability-unsupported')!.file).toBe('src/forms/full-coverage.json');
  });

  it('an invalid declaration and a lock for another Website are errors', async () => {
    writeFileSync(join(root, 'src/forms/bad.json'), '{');
    writeFileSync(join(root, '.yatris/forms.lock.json'), JSON.stringify({ contractVersion: 1, websiteId: 7, forms: {} }));
    expect(codes(await checkForms(root))).toEqual(expect.arrayContaining(['error:forms-invalid', 'error:forms-lock-website-mismatch']));
  });

  it('online, reports Yatris readiness: missing forms and blocking items as warnings', async () => {
    writeFileSync(join(root, 'src/pages/contact/thanks.astro'), '');
    const missing = await checkForms(root, { remote });
    expect(codes(missing)).toEqual(['warning:forms-remote-missing']);
    expect(fake.calls[0]).toMatchObject({ name: 'get_contact_form_readiness', args: { website: 42, key: 'contact' } });

    fake.seed('contact', JSON.parse(JSON.stringify({ key: 'contact', name: 'x' })), false);
    const notReady = await checkForms(root, { remote });
    expect(codes(notReady)).toEqual(['warning:forms-remote-not-ready']);
    expect(notReady[0].message).toContain('not published');
    expect(notReady[0].message).toContain('公開済み');
  });

  it('online but unreachable, or without the tool, is unverified', async () => {
    writeFileSync(join(root, 'src/pages/contact/thanks.astro'), '');
    fake.failNext('get_contact_form_readiness', new RemoteError('backend_unavailable', 'HTTP 503'), 3);
    const down = await checkForms(root, { remote });
    expect(codes(down)).toEqual(['unverified:forms-remote-unverified']);
    expect(down[0].message).toContain('backend_unavailable');
    fake.knownTools.delete('get_contact_form_readiness');
    expect(codes(await checkForms(root, { remote }))).toEqual(['unverified:forms-remote-unverified']);
  });
});

describe('helpers', () => {
  it('finds literal and computed mounts, ignoring HTML comments', () => {
    writeFileSync(join(root, 'src/pages/a.astro'), '<!-- <YatrisForm form="ghost" /> -->\n<YatrisForm\n  form={"quote"}\n/>');
    expect(findMounts(root).map((m) => m.form).sort()).toEqual(['contact', 'quote']);
  });

  it('resolves thanks routes to pages, or to a dynamic route it cannot verify', () => {
    writeFileSync(join(root, 'src/pages/contact/thanks.astro'), '');
    expect(findRoute(root, '/contact/thanks/')).toBe('src/pages/contact/thanks.astro');
    expect(findRoute(root, '/contact/')).toBe('src/pages/contact/index.astro');
    expect(findRoute(root, '/missing/')).toBeNull();
    writeFileSync(join(root, 'src/pages/[...slug].astro'), '');
    expect(findRoute(root, '/missing/')).toBe('dynamic');
  });
});
