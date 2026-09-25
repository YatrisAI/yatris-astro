import { describe, expect, it } from 'vitest';
import { looksLikeCredential, MCP_FILES, mcpDescriptor, mcpFiles } from './mcp.js';

const URL = 'https://app.yatris.jp/mcp/yatris';

describe('Yatris MCP configuration', () => {
  const files = mcpFiles(mcpDescriptor(URL));

  it('derives both client adapters from one descriptor', () => {
    expect(JSON.parse(files[MCP_FILES.descriptor])).toEqual({
      contractVersion: 1,
      server: { name: 'yatris', transport: 'streamable-http', url: URL },
    });
    expect(JSON.parse(files[MCP_FILES.claude])).toEqual({ mcpServers: { yatris: { type: 'http', url: URL } } });
    expect(files[MCP_FILES.codex]).toContain(`[mcp_servers.yatris]\nurl = "${URL}"\n`);
  });

  it('holds no credential', () => {
    for (const contents of Object.values(files)) {
      expect(looksLikeCredential(contents)).toBe(false);
    }
  });

  it('recognises credential-like configuration', () => {
    expect(looksLikeCredential('{"headers":{"Authorization":"Bearer x"}}')).toBe(true);
    expect(looksLikeCredential('bearer_token_env_var = "YATRIS_TOKEN"')).toBe(true);
    expect(looksLikeCredential('# sign in with a token\nurl = "https://x"')).toBe(false);
  });
});
