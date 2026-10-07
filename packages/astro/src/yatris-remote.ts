import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MCP_FILES } from './mcp.js';
import { PROJECT_PATH } from './pairing.js';

/**
 * The CLI as a Yatris product MCP client (YatrisCMS#392, #390). `yatris forms
 * plan|apply|pull`, `yatris mail sync` and the doctor's readiness check call
 * Product MCP tools directly, for the exact Website this repository is paired
 * with (`.yatris/project.json`), at the server the committed descriptor names
 * (`.yatris/mcp.json`).
 *
 * Authentication is a bearer credential taken from the environment only:
 * `YATRIS_MCP_TOKEN`, either a Yatris MCP service token (`id|secret`, with the
 * exact `mcp` ability) or an OAuth access token from a Yatris MCP sign-in. It
 * is never read from, or written to, any file, and never printed.
 *
 * Failures are typed so every command can exit with a code that tells "fix
 * your input" apart from "Yatris is down" and "Yatris cannot do this yet".
 */

export const TOKEN_ENV = 'YATRIS_MCP_TOKEN';
export const MCP_URL_ENV = 'YATRIS_MCP_URL';

/** Process exit codes shared by every remote command (contract README §9). */
export const EXIT = {
  ok: 0,
  /** Invalid input: a declaration, an argument, a plan file, or Yatris said `validation`. */
  invalid: 1,
  /** Reconciliation required: drift, conflict, adoption, or a pull that would discard local edits. */
  reconcile: 2,
  /** Stale: the plan expired, local files or Yatris changed since the plan, or a revision race. */
  stale: 3,
  /** The repository is not paired with a Yatris Website (`yatris connect`). */
  unpaired: 4,
  /** No credential (`YATRIS_MCP_TOKEN`), or Yatris refused it. */
  credentials: 5,
  /** sysexits EX_UNAVAILABLE: Yatris does not offer this capability (yet). */
  unavailable: 69,
  /** sysexits EX_TEMPFAIL: backend_unavailable, a network failure, a 5xx or rate limit. */
  backendUnavailable: 75,
} as const;

export type RemoteErrorKind =
  /** The tool ran and returned a typed error (`code`: validation, conflict, not_found …). */
  | 'tool_error'
  /** The server does not know the tool. */
  | 'unknown_tool'
  /** Missing, expired or insufficient credential (HTTP 401/403). */
  | 'unauthorized'
  /** Network failure, timeout, HTTP 5xx or 429. */
  | 'backend_unavailable'
  /** An answer this client cannot read. */
  | 'protocol';

export class RemoteError extends Error {
  constructor(
    readonly kind: RemoteErrorKind,
    message: string,
    readonly code?: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'RemoteError';
  }
}

/** Not paired, or no credential: nothing was sent. */
export class RemoteSetupError extends Error {
  constructor(
    readonly exitCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'RemoteSetupError';
  }
}

/** One Product MCP tool call. Resolves to the tool's structured result. */
export interface McpTransport {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface RemoteConnection {
  url: string;
  token: string;
}

export interface RemoteOptions {
  /** Where the credential and overrides are read from; defaults to process.env. */
  environment?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  /** Replaces the HTTP transport (tests). */
  transport?: (connection: RemoteConnection) => McpTransport;
  /** Delay between transport retries, in ms (tests pass 0). */
  retryDelayMs?: number;
}

export interface Remote {
  websiteId: number;
  url: string;
  call(name: string, args: Record<string, unknown>): Promise<unknown>;
}

/**
 * The paired Website and an authenticated transport, or a RemoteSetupError
 * naming what is missing. Reads nothing secret from disk.
 */
export function resolveRemote(root: string, options: RemoteOptions = {}): Remote {
  const environment = options.environment ?? process.env;
  const websiteId = pairedWebsiteId(root);
  if (websiteId === null) {
    throw new RemoteSetupError(EXIT.unpaired, `this repository is not paired with a Yatris Website (${PROJECT_PATH} has no websiteId). Pair it first with \`npx yatris connect\`; nothing was sent.`);
  }
  const url = environment[MCP_URL_ENV]?.trim() || descriptorUrl(root);
  if (!url) {
    throw new RemoteSetupError(EXIT.unpaired, `${MCP_FILES.descriptor} names no Yatris MCP server. Run \`npx yatris connect\` again; nothing was sent.`);
  }
  const token = environment[TOKEN_ENV]?.trim();
  if (!token) {
    throw new RemoteSetupError(
      EXIT.credentials,
      `no Yatris credential: set ${TOKEN_ENV} in this shell's environment (a Yatris MCP service token or sign-in access token for a staff account allowed on Website ${websiteId}). Never write it to a file or a command line; nothing was sent.`,
    );
  }
  const transport = options.transport?.({ url, token }) ?? httpTransport({ url, token }, options.fetch);
  const delay = options.retryDelayMs ?? 500;
  return {
    websiteId,
    url,
    call: (name, args) => callWithRetry(transport, name, args, delay),
  };
}

/**
 * Calls a tool, retrying only transport failures (backend_unavailable) with
 * the *same* arguments, so an idempotency key inside them is reused and a
 * retried mutation replays instead of running twice.
 */
export async function callWithRetry(transport: McpTransport, name: string, args: Record<string, unknown>, delayMs = 500, attempts = 3): Promise<unknown> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await transport.callTool(name, args);
    } catch (error) {
      if (!(error instanceof RemoteError) || error.kind !== 'backend_unavailable' || attempt >= attempts) throw error;
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }
  }
}

/** The exit code and one-line explanation for a failed remote call. */
export function describeFailure(error: unknown, tool: string): { code: number; message: string } {
  if (error instanceof RemoteSetupError) return { code: error.exitCode, message: error.message };
  if (!(error instanceof RemoteError)) return { code: EXIT.invalid, message: (error as Error).message };
  switch (error.kind) {
    case 'unknown_tool':
      return { code: EXIT.unavailable, message: `Yatris does not offer \`${tool}\` yet (unknown tool). Nothing was changed; this needs a newer Yatris, not a retry.` };
    case 'unauthorized':
      return { code: EXIT.credentials, message: `Yatris refused the credential in ${TOKEN_ENV} (${error.message}). Use a current staff credential allowed on this Website.` };
    case 'backend_unavailable':
      return { code: EXIT.backendUnavailable, message: `backend_unavailable: Yatris could not be reached (${error.message}). Nothing is known about remote state; try again later.` };
    case 'protocol':
      return { code: EXIT.backendUnavailable, message: `backend_unavailable: Yatris answered \`${tool}\` in a way this @yatris/astro cannot read (${error.message}).` };
    default:
      return { code: toolErrorExit(error.code), message: `${error.code ?? 'error'}: ${error.message}` };
  }
}

/** Exit code for a typed tool error code. */
export function toolErrorExit(code: string | undefined): number {
  switch (code) {
    case 'conflict':
    case 'plan_expired':
    case 'plan_mismatch':
    case 'revision_conflict':
      return EXIT.stale;
    case 'unauthorized':
    case 'forbidden':
      return EXIT.credentials;
    case 'unavailable':
      return EXIT.unavailable;
    case 'in_progress':
      return EXIT.backendUnavailable;
    default:
      return EXIT.invalid;
  }
}

function pairedWebsiteId(root: string): number | null {
  const path = join(root, PROJECT_PATH);
  if (!existsSync(path)) return null;
  try {
    const id = (JSON.parse(readFileSync(path, 'utf8')) as { websiteId?: unknown }).websiteId;
    return typeof id === 'number' && Number.isInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

function descriptorUrl(root: string): string | null {
  const path = join(root, MCP_FILES.descriptor);
  if (!existsSync(path)) return null;
  try {
    const url = (JSON.parse(readFileSync(path, 'utf8')) as { server?: { url?: unknown } }).server?.url;
    return typeof url === 'string' && url !== '' ? url : null;
  } catch {
    return null;
  }
}

const PROTOCOL_VERSION = '2025-06-18';

/**
 * Streamable-HTTP MCP client: `initialize` once, then `tools/call`. Accepts
 * JSON or SSE answers. Error messages carry the HTTP status or JSON-RPC
 * message only, never request arguments or response bodies.
 */
export function httpTransport(connection: RemoteConnection, doFetch: typeof fetch = fetch): McpTransport {
  let session: string | undefined;
  let protocol: string | undefined;
  let initialized: Promise<void> | undefined;
  let nextId = 1;

  async function post(message: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${connection.token}`,
    };
    if (session) headers['mcp-session-id'] = session;
    if (protocol) headers['mcp-protocol-version'] = protocol;

    let response: Response;
    try {
      response = await doFetch(connection.url, { method: 'POST', headers, body: JSON.stringify(message), signal: AbortSignal.timeout(60_000) });
    } catch (error) {
      throw new RemoteError('backend_unavailable', `network error: ${(error as Error).name === 'TimeoutError' ? 'timed out' : 'request failed'}`);
    }
    const id = response.headers.get('mcp-session-id');
    if (id) session = id;
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      throw new RemoteError('unauthorized', `HTTP ${response.status}`);
    }
    if (response.status === 429 || response.status >= 500) {
      await response.body?.cancel();
      throw new RemoteError('backend_unavailable', `HTTP ${response.status}`);
    }
    if (response.status === 202 || message.id === undefined) {
      await response.body?.cancel();
      return { status: response.status, body: null };
    }
    const text = await response.text();
    const body = (response.headers.get('content-type') ?? '').includes('text/event-stream') ? lastSseMessage(text, message.id) : parseJson(text);
    if (body === undefined) throw new RemoteError(response.ok ? 'protocol' : 'backend_unavailable', `HTTP ${response.status}, unreadable answer`);
    return { status: response.status, body };
  }

  async function request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = nextId++;
    const { body } = await post({ jsonrpc: '2.0', id, method, params });
    const reply = body as { result?: unknown; error?: { code?: number; message?: string } } | null;
    if (reply?.error) {
      const message = typeof reply.error.message === 'string' ? reply.error.message.slice(0, 300) : 'JSON-RPC error';
      if (reply.error.code === -32601 || (reply.error.code === -32602 && /tool .*not found/i.test(message))) throw new RemoteError('unknown_tool', message);
      if (reply.error.code === -32603) throw new RemoteError('backend_unavailable', message);
      throw new RemoteError('protocol', message);
    }
    if (!reply || !('result' in reply)) throw new RemoteError('protocol', 'no result');
    return reply.result;
  }

  async function initialize(): Promise<void> {
    const result = (await request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: '@yatris/astro', version: packageVersion() } })) as { protocolVersion?: unknown } | null;
    protocol = typeof result?.protocolVersion === 'string' ? result.protocolVersion : PROTOCOL_VERSION;
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  return {
    async callTool(name, args) {
      initialized ??= initialize().catch((error) => {
        initialized = undefined;
        throw error;
      });
      await initialized;
      const result = (await request('tools/call', { name, arguments: args })) as {
        isError?: boolean;
        structuredContent?: { error?: { code?: unknown; message?: unknown; details?: unknown } } & Record<string, unknown>;
        content?: Array<{ type?: string; text?: string }>;
      } | null;
      if (!result || typeof result !== 'object') throw new RemoteError('protocol', 'empty tool result');
      if (result.isError) {
        const error = result.structuredContent?.error;
        const code = typeof error?.code === 'string' ? error.code : undefined;
        const message = typeof error?.message === 'string' ? error.message : (result.content?.find((c) => c.type === 'text')?.text ?? 'the tool failed');
        throw new RemoteError('tool_error', message.slice(0, 1000), code, error?.details);
      }
      if (result.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent;
      const text = result.content?.find((c) => c.type === 'text')?.text;
      const parsed = text === undefined ? undefined : parseJson(text);
      if (parsed === undefined) throw new RemoteError('protocol', 'the tool returned no structured content');
      return parsed;
    },
  };
}

function packageVersion(): string {
  try {
    return (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
  } catch {
    return '0.0.0';
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The JSON-RPC answer to `id` from an SSE stream (the last one, if several). */
function lastSseMessage(text: string, id: unknown): unknown {
  let found: unknown;
  for (const event of text.replace(/\r\n/g, '\n').split('\n\n')) {
    const data = event
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data) continue;
    const message = parseJson(data) as { id?: unknown } | undefined;
    if (message && message.id === id) found = message;
  }
  return found;
}
