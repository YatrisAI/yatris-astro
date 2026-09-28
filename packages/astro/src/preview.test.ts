import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import yatris from './index.js';
import { fetchPreviewOverlay, previewBuild, writePreviewHeaders } from './preview.js';

const LOOKUP = 'https://api.yatris.test/api/v1/preview-builds/7/current';
const KEY = `alk_${'p'.repeat(40)}`;
const DEPLOYMENT = 'https://3f2a1b9c.works-site.pages.dev';
const previewEnv = { YATRIS_PREVIEW_URL: LOOKUP, YATRIS_PREVIEW_KEY: KEY, CF_PAGES_BRANCH: 'yatris-preview', CF_PAGES_URL: DEPLOYMENT };

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'yatris-preview-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('previewBuild', () => {
  it('is a preview build only on the yatris-preview branch with both variables', () => {
    expect(previewBuild(previewEnv)).toEqual({ active: true, lookupUrl: LOOKUP, key: KEY, deploymentUrl: DEPLOYMENT });
    expect(previewBuild({})).toEqual({ active: false, reason: null });
  });

  it('never enters preview mode on the production branch, even when the variables leak', () => {
    const mode = previewBuild({ ...previewEnv, CF_PAGES_BRANCH: 'main' });

    expect(mode.active).toBe(false);
    expect(mode.active === false && mode.reason).toContain('branch "main"');
  });

  it('ignores the variables on other preview branches and outside Cloudflare', () => {
    expect(previewBuild({ ...previewEnv, CF_PAGES_BRANCH: 'yatris/agent-run-12' }).active).toBe(false);
    expect(previewBuild({ YATRIS_PREVIEW_URL: LOOKUP, YATRIS_PREVIEW_KEY: KEY }).active).toBe(false);
  });

  it('refuses a half-configured preview build and a lookup URL over plain http', () => {
    expect(() => previewBuild({ ...previewEnv, YATRIS_PREVIEW_KEY: '' })).toThrow('needs both YATRIS_PREVIEW_URL and YATRIS_PREVIEW_KEY');
    expect(() => previewBuild({ ...previewEnv, YATRIS_PREVIEW_URL: 'http://api.yatris.test/x' })).toThrow('must use https');
  });
});

describe('fetchPreviewOverlay', () => {
  const active = previewBuild(previewEnv) as Extract<ReturnType<typeof previewBuild>, { active: true }>;

  it('asks the lookup for this deployment, then reads the signed overlay', async () => {
    const requests: { url: string; auth: string | null }[] = [];
    const fake: typeof fetch = async (input, init) => {
      const url = String(input);
      requests.push({ url, auth: new Headers(init?.headers).get('Authorization') });
      return url.startsWith(LOOKUP)
        ? Response.json({ data: { preview_build_id: 5, overlay_url: 'https://api.yatris.test/api/v1/preview-builds/5/overlay?signature=abc' } })
        : Response.json({ data: [{ canonical_id: 'w-1' }] });
    };

    await expect(fetchPreviewOverlay(active, fake)).resolves.toEqual([{ canonical_id: 'w-1' }]);
    expect(requests[0]).toEqual({ url: `${LOOKUP}?deployment=${encodeURIComponent(DEPLOYMENT)}`, auth: `Bearer ${KEY}` });
    // The key never travels to the signed URL
    expect(requests[1]).toEqual({ url: 'https://api.yatris.test/api/v1/preview-builds/5/overlay?signature=abc', auth: null });
  });

  it('fails the build when no preview is found or the link expired', async () => {
    await expect(fetchPreviewOverlay(active, async () => new Response('{}', { status: 404 }))).rejects.toThrow('found no preview for this deployment');
    const expired: typeof fetch = async (input) =>
      String(input).startsWith(LOOKUP) ? Response.json({ data: { overlay_url: 'https://api.yatris.test/o?signature=x' } }) : new Response('{}', { status: 403 });
    await expect(fetchPreviewOverlay(active, expired)).rejects.toThrow('HTTP 403');
  });
});

describe('writePreviewHeaders', () => {
  it('writes a noindex rule for every path', () => {
    const dir = tempDir();

    writePreviewHeaders(pathToFileURL(`${dir}/`));

    expect(readFileSync(join(dir, '_headers'), 'utf8')).toBe('/*\n  X-Robots-Tag: noindex, nofollow\n');
  });

  it("keeps the site's own rules and adds the rule once", () => {
    const dir = tempDir();
    writeFileSync(join(dir, '_headers'), '/assets/*\n  Cache-Control: public, max-age=31536000, immutable');

    writePreviewHeaders(pathToFileURL(`${dir}/`));
    writePreviewHeaders(pathToFileURL(`${dir}/`));

    expect(readFileSync(join(dir, '_headers'), 'utf8')).toBe(
      '/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n\n/*\n  X-Robots-Tag: noindex, nofollow\n',
    );
  });
});

describe('the integration in a preview build', () => {
  async function build(env: Record<string, string>) {
    for (const [name, value] of Object.entries({ YATRIS_PREVIEW_URL: '', YATRIS_PREVIEW_KEY: '', CF_PAGES_BRANCH: '', ...env })) {
      vi.stubEnv(name, value);
    }
    const root = tempDir();
    const out = join(root, 'dist');
    let runtime: Record<string, unknown> = {};
    const integration = yatris({ gtmContainerId: 'GTM-ABC1234' });

    await integration.hooks['astro:config:setup']({
      config: { root: pathToFileURL(`${root}/`) },
      command: 'build',
      updateConfig: (config) => {
        const plugin = (config as { vite: { plugins: { load: (id: string) => string | undefined }[] } }).vite.plugins[0];
        runtime = JSON.parse(plugin.load('\0virtual:yatris/config')!.replace(/^export default |;$/g, ''));
      },
    });
    mkdirSync(out);
    const logger = { info: vi.fn(), warn: vi.fn() };
    integration.hooks['astro:build:done']({ pages: [], dir: pathToFileURL(`${out}/`), logger });
    const headers = existsSync(join(out, '_headers')) ? readFileSync(join(out, '_headers'), 'utf8') : null;
    return { runtime, headers, logger };
  }

  it('marks every page noindex, measures nothing and writes the header rule', async () => {
    const { runtime, headers } = await build(previewEnv);

    expect(runtime).toMatchObject({ preview: true, gtmContainerId: null, searchConsoleVerification: null });
    expect(headers).toContain('X-Robots-Tag: noindex, nofollow');
  });

  it('leaves a production build alone even when the preview variables leak into it', async () => {
    const { runtime, headers, logger } = await build({ ...previewEnv, CF_PAGES_BRANCH: 'main' });

    expect(runtime.preview).toBeUndefined();
    expect(runtime.gtmContainerId).toBe('GTM-ABC1234');
    expect(headers).toBeNull();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('building published content only'));
  });
});
