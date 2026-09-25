/**
 * The Yatris product MCP configuration a managed site commits (spec §6):
 * one agent-neutral descriptor, `.yatris/mcp.json`, and the Claude Code
 * (`.mcp.json`) and Codex (`.codex/config.toml`) adapters derived from it.
 * They hold only the server URL: people sign in from their own client, so
 * no token, header or other credential ever belongs in these files.
 */

export const MCP_SERVER_NAME = 'yatris';

export const MCP_FILES = {
  descriptor: '.yatris/mcp.json',
  claude: '.mcp.json',
  codex: '.codex/config.toml',
} as const;

export interface McpDescriptor {
  contractVersion: 1;
  server: { name: string; transport: 'streamable-http'; url: string };
}

export function mcpDescriptor(url: string): McpDescriptor {
  return { contractVersion: 1, server: { name: MCP_SERVER_NAME, transport: 'streamable-http', url } };
}

/** File path → exact contents for the descriptor and both adapters. */
export function mcpFiles(descriptor: McpDescriptor): Record<string, string> {
  const { name, url } = descriptor.server;
  return {
    [MCP_FILES.descriptor]: `${JSON.stringify(descriptor, null, 2)}\n`,
    [MCP_FILES.claude]: `${JSON.stringify({ mcpServers: { [name]: { type: 'http', url } } }, null, 2)}\n`,
    [MCP_FILES.codex]: `# Generated from .yatris/mcp.json. Sign in with: codex mcp login ${name}\n[mcp_servers.${name}]\nurl = ${JSON.stringify(url)}\n`,
  };
}

const CREDENTIAL_HINT = /bearer|authorization|token|api[_-]?key|secret|password|alk_[A-Za-z0-9]/i;

/** Whether committed MCP configuration text carries anything credential-like. */
export function looksLikeCredential(text: string): boolean {
  return CREDENTIAL_HINT.test(text.replace(/^#.*$/gm, ''));
}
