import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { callWithRetry, describeFailure, httpTransport, RemoteError, RemoteSetupError, resolveRemote } from './yatris-remote.js';

/** The Product MCP client the forms and mail commands use (YatrisCMS#392, #390). */

const TOKEN = '17|s3cr3t-service-token-value';
const connection = { url: 'https://app.yatris.jp/mcp/yatris', token: TOKEN };

type Sent = { url: string; headers: Record<string, string>; body: Record<string, any> };

/** A fake streamable-HTTP MCP server answering `initialize` and then `answer(body)`. */
function server(answer: (body: Record<string, any>) => Response | Promise<Response>) {
  const sent: Sent[] = [];
  const doFetch = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    sent.push({ url, headers: init.headers as Record<string, string>, body });
    if (body.method === 'initialize') {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', capabilities: {} } }), { headers: { 'content-type': 'application/json', 'mcp-session-id': 'session-1' } });
    }
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    return answer(body);
  }) as unknown as typeof fetch;
  return { sent, doFetch };
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

describe('httpTransport', () => {
  it('initializes once, then calls tools with the bearer and session, and returns structured content', async () => {
    const { sent, doFetch } = server((body) => json({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: '{}' }], structuredContent: { forms: [] } } }));
    const transport = httpTransport(connection, doFetch);
    expect(await transport.callTool('list_contact_forms', { website: 42 })).toEqual({ forms: [] });
    expect(await transport.callTool('list_contact_forms', { website: 42 })).toEqual({ forms: [] });
    expect(sent.map((s) => s.body.method)).toEqual(['initialize', 'notifications/initialized', 'tools/call', 'tools/call']);
    const call = sent[2];
    expect(call.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(call.headers['mcp-session-id']).toBe('session-1');
    expect(call.headers['mcp-protocol-version']).toBe('2025-06-18');
    expect(call.body.params).toEqual({ name: 'list_contact_forms', arguments: { website: 42 } });
  });

  it('reads an SSE answer', async () => {
    const { doFetch } = server((body) => new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { structuredContent: { ok: true } } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } }));
    expect(await httpTransport(connection, doFetch).callTool('x', {})).toEqual({ ok: true });
  });

  it('falls back to JSON text content when there is no structured content', async () => {
    const { doFetch } = server((body) => json({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: '{"a":1}' }] } }));
    expect(await httpTransport(connection, doFetch).callTool('x', {})).toEqual({ a: 1 });
  });

  it('turns a typed tool error into RemoteError with its code', async () => {
    const { doFetch } = server((body) => json({ jsonrpc: '2.0', id: body.id, result: { isError: true, content: [{ type: 'text', text: 'conflict: changed' }], structuredContent: { error: { code: 'revision_conflict', message: 'changed in Yatris' } } } }));
    const error = await httpTransport(connection, doFetch).callTool('apply_contact_forms', {}).catch((e) => e);
    expect(error).toBeInstanceOf(RemoteError);
    expect(error).toMatchObject({ kind: 'tool_error', code: 'revision_conflict', message: 'changed in Yatris' });
    expect(describeFailure(error, 'apply_contact_forms').code).toBe(3);
  });

  it('recognises an unknown tool (exit 69)', async () => {
    const { doFetch } = server((body) => json({ jsonrpc: '2.0', id: body.id, error: { code: -32602, message: 'Tool [plan_contact_forms] not found.' } }, 400));
    const error = await httpTransport(connection, doFetch).callTool('plan_contact_forms', {}).catch((e) => e);
    expect(error).toMatchObject({ kind: 'unknown_tool' });
    expect(describeFailure(error, 'plan_contact_forms').code).toBe(69);
  });

  it.each([
    [401, 'unauthorized', 5],
    [403, 'unauthorized', 5],
    [429, 'backend_unavailable', 75],
    [503, 'backend_unavailable', 75],
  ])('HTTP %i is %s (exit %i)', async (status, kind, exit) => {
    const { doFetch } = server(() => new Response('{"message":"nope"}', { status }));
    const error = await httpTransport(connection, doFetch).callTool('x', {}).catch((e) => e);
    expect(error).toMatchObject({ kind });
    expect(describeFailure(error, 'x').code).toBe(exit);
  });

  it('a network failure is backend_unavailable, and no message carries the token', async () => {
    const doFetch = (async () => {
      throw new TypeError(`fetch failed for ${TOKEN}`);
    }) as unknown as typeof fetch;
    const error = await httpTransport(connection, doFetch).callTool('x', {}).catch((e) => e);
    expect(error).toMatchObject({ kind: 'backend_unavailable' });
    expect(describeFailure(error, 'x').message).not.toContain(TOKEN);
    expect(describeFailure(error, 'x').message).not.toContain('s3cr3t');
  });
});

describe('callWithRetry', () => {
  it('retries transport failures only, with the same arguments', async () => {
    const seen: unknown[] = [];
    let n = 0;
    const transport = {
      async callTool(_name: string, args: Record<string, unknown>) {
        seen.push(args);
        if (++n < 3) throw new RemoteError('backend_unavailable', 'HTTP 503');
        return { ok: true };
      },
    };
    const args = { idempotency_key: 'k-1' };
    expect(await callWithRetry(transport, 'x', args, 0)).toEqual({ ok: true });
    expect(seen).toEqual([args, args, args]);

    let calls = 0;
    const failing = { callTool: async () => (calls++, Promise.reject(new RemoteError('tool_error', 'bad', 'validation'))) };
    await expect(callWithRetry(failing, 'x', {}, 0)).rejects.toMatchObject({ code: 'validation' });
    expect(calls).toBe(1);
  });
});

describe('resolveRemote', () => {
  function project(websiteId: unknown) {
    const root = mkdtempSync(join(tmpdir(), 'yatris-remote-'));
    mkdirSync(join(root, '.yatris'));
    writeFileSync(join(root, '.yatris/project.json'), JSON.stringify({ contractVersion: 1, websiteId }));
    writeFileSync(join(root, '.yatris/mcp.json'), JSON.stringify({ contractVersion: 1, server: { name: 'yatris', transport: 'streamable-http', url: 'https://app.yatris.jp/mcp/yatris' } }));
    return root;
  }

  it('needs a paired Website (exit 4) and a credential from the environment (exit 5)', () => {
    expect(() => resolveRemote(project(null), { environment: { YATRIS_MCP_TOKEN: 'x' } })).toThrow(RemoteSetupError);
    try {
      resolveRemote(project(null), { environment: {} });
    } catch (error) {
      expect((error as RemoteSetupError).exitCode).toBe(4);
    }
    try {
      resolveRemote(project(42), { environment: {} });
    } catch (error) {
      expect((error as RemoteSetupError).exitCode).toBe(5);
      expect((error as Error).message).toContain('YATRIS_MCP_TOKEN');
    }
  });

  it('uses the descriptor URL unless YATRIS_MCP_URL overrides it', () => {
    const urls: string[] = [];
    const transport = (c: { url: string }) => (urls.push(c.url), { callTool: async () => ({}) });
    expect(resolveRemote(project(42), { environment: { YATRIS_MCP_TOKEN: 'x' }, transport }).websiteId).toBe(42);
    resolveRemote(project(42), { environment: { YATRIS_MCP_TOKEN: 'x', YATRIS_MCP_URL: 'http://localhost:8000/mcp/yatris' }, transport });
    expect(urls).toEqual(['https://app.yatris.jp/mcp/yatris', 'http://localhost:8000/mcp/yatris']);
  });
});
