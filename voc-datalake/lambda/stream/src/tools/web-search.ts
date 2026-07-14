/**
 * web_search tool implementation — Amazon Bedrock AgentCore Gateway.
 *
 * The gateway exposes the AWS-managed `web-search` connector as a standard
 * MCP tool. We call it directly over the gateway's streamable-HTTP MCP
 * endpoint with a SigV4-signed JSON-RPC `tools/call` — no MCP SDK and no
 * third-party search API; queries are served entirely within AWS.
 *
 * Configured via env (set by CDK only when the gateway is deployed):
 *   WEB_SEARCH_GATEWAY_URL  gateway MCP endpoint
 *   WEB_SEARCH_TOOL_NAME    gateway-prefixed MCP tool name (target___tool)
 *
 * Acceptable use: source titles/URLs must reach the end user — the formatted
 * tool result embeds markdown links and the handler forwards `webSources`
 * so the UI can render citations even if the model omits them.
 */
import { createHash, createHmac } from 'node:crypto';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { HttpRequest } from '@smithy/protocol-http';
import { SignatureV4 } from '@smithy/signature-v4';
import type { SourceData } from '@smithy/types';
import { z } from 'zod';
import { ServiceError } from '../lib/errors.js';

// The web-search connector caps queries at 200 characters.
const MAX_QUERY_LENGTH = 200;
// Connector allows up to 25 results; keep chat answers lean.
const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS_CAP = 10;

const REQUEST_TIMEOUT_MS = 20_000;

// ── Configuration ──

export function isWebSearchConfigured(): boolean {
  return Boolean(process.env.WEB_SEARCH_GATEWAY_URL);
}

function gatewayUrl(): string {
  return process.env.WEB_SEARCH_GATEWAY_URL ?? '';
}

function configuredToolName(): string {
  return process.env.WEB_SEARCH_TOOL_NAME ?? 'web-search-tool___WebSearch';
}

/** The gateway lives in its own region (web-search is us-east-1-only), which
 * may differ from the Lambda's — sign for the gateway's region. */
function regionFromGatewayUrl(url: string): string {
  const host = new URL(url).hostname;
  const match = /\.gateway\.bedrock-agentcore\.([a-z0-9-]+)\.amazonaws\.com$/.exec(host);
  return match?.[1] ?? process.env.AWS_REGION ?? 'us-east-1';
}

// ── SigV4 signing (node:crypto adapter keeps this dependency-free) ──

/** Normalize the SDK's SourceData union into bytes for node:crypto
 * (strings are encoded as UTF-8, matching node's default). */
function toBinary(data: SourceData): Uint8Array {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new Uint8Array(data);
}

class NodeSha256 {
  private readonly parts: Uint8Array[] = [];
  private readonly secret?: Uint8Array;

  constructor(secret?: SourceData) {
    this.secret = secret === undefined ? undefined : toBinary(secret);
  }

  update(chunk: SourceData): void {
    this.parts.push(toBinary(chunk));
  }

  digest(): Promise<Uint8Array> {
    const hasher = this.secret === undefined
      ? createHash('sha256')
      : createHmac('sha256', this.secret);
    for (const part of this.parts) hasher.update(part);
    return Promise.resolve(new Uint8Array(hasher.digest()));
  }

  reset(): void {
    this.parts.length = 0;
  }
}

async function signedFetch(url: string, body: string): Promise<Response> {
  const parsed = new URL(url);
  const signer = new SignatureV4({
    service: 'bedrock-agentcore',
    region: regionFromGatewayUrl(url),
    credentials: defaultProvider(),
    sha256: NodeSha256,
  });

  const request = new HttpRequest({
    method: 'POST',
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    path: parsed.pathname,
    headers: {
      host: parsed.hostname,
      'content-type': 'application/json',
      // Streamable-HTTP MCP servers may answer either plain JSON or SSE.
      accept: 'application/json, text/event-stream',
    },
    body,
  });

  const signed = await signer.sign(request);
  return fetch(url, {
    method: 'POST',
    headers: signed.headers,
    body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

// ── JSON-RPC over streamable HTTP ──

const jsonRpcResponseSchema = z.object({
  result: z.unknown().optional(),
  error: z.object({ message: z.string().optional() }).passthrough().optional(),
}).passthrough();

/** JSON-RPC responses may arrive as plain JSON or as an SSE frame
 * (`data: {...}`) depending on how the gateway answers. */
function extractJsonRpcText(raw: string, contentType: string): string {
  const text = raw.trim();
  if (contentType.includes('text/event-stream') || text.startsWith('event:') || text.startsWith('data:')) {
    for (const line of text.split('\n')) {
      if (line.startsWith('data:')) return line.slice('data:'.length).trim();
    }
  }
  return text;
}

/** JSON.parse with a domain error instead of a SyntaxError. */
function parseJsonOrThrow(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new ServiceError(`${what}: ${text.slice(0, 200)}`);
  }
}

async function rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  const response = await signedFetch(gatewayUrl(), body).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    throw new ServiceError(`Web search gateway request failed: ${message}`);
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new ServiceError(`Web search gateway HTTP ${response.status}: ${raw.slice(0, 200)}`);
  }

  const parsed = parseJsonOrThrow(
    extractJsonRpcText(raw, response.headers.get('content-type') ?? ''),
    'Web search gateway returned non-JSON response',
  );
  const envelope = jsonRpcResponseSchema.safeParse(parsed);
  if (!envelope.success) {
    throw new ServiceError('Web search gateway returned an unexpected JSON-RPC shape');
  }
  if (envelope.data.error) {
    throw new ServiceError(`Web search gateway ${method} error: ${envelope.data.error.message ?? 'unknown'}`);
  }
  return envelope.data.result;
}

// ── Tool name resolution ──

// Resolved lazily and cached: the configured name is used as-is, but if the
// gateway reports it unknown (target renamed, prefix convention change), we
// fall back to tools/list discovery — at most once per call.
const resolvedToolName: { name: string | null } = { name: null };

/** @internal Test hook: clears the per-container tool-name cache. */
export function resetToolNameCacheForTesting(): void {
  resolvedToolName.name = null;
}

const toolsListSchema = z.object({
  tools: z.array(z.object({ name: z.string() }).passthrough()).optional(),
}).passthrough();

/** Reads only the first page: MCP tools/list can paginate via nextCursor,
 * but this gateway exposes a single connector target with one tool. */
async function discoverToolName(): Promise<string> {
  const result = toolsListSchema.safeParse(await rpc('tools/list', {}));
  const tools = result.success ? result.data.tools ?? [] : [];
  const webSearch = tools.find((tool) => tool.name.endsWith('WebSearch'));
  if (!webSearch) throw new ServiceError('No WebSearch tool exposed by the gateway');
  return webSearch.name;
}

function isUnknownToolError(err: unknown): boolean {
  if (!(err instanceof ServiceError)) return false;
  const message = err.message.toLowerCase();
  return message.includes('tool') && (message.includes('not found') || message.includes('unknown'));
}

/** tools/call with the configured (or previously discovered) name; on an
 * unknown-tool error — including a stale cached name after a target rename
 * — discover the real name via tools/list and retry once. */
async function callWebSearchTool(query: string, maxResults: number): Promise<unknown> {
  const toolName = resolvedToolName.name ?? configuredToolName();
  const params = { name: toolName, arguments: { query, maxResults } };
  try {
    const result = await rpc('tools/call', params);
    resolvedToolName.name = toolName;
    return result;
  } catch (err) {
    if (!isUnknownToolError(err)) throw err;
    const discovered = await discoverToolName();
    console.log(`Web search tool name resolved via tools/list: ${discovered}`);
    resolvedToolName.name = discovered;
    return rpc('tools/call', { ...params, name: discovered });
  }
}

// ── Result parsing ──

const toolCallResultSchema = z.object({
  isError: z.boolean().optional(),
  content: z.array(z.object({ type: z.string().optional(), text: z.string().optional() }).passthrough()).optional(),
}).passthrough();

const webResultSchema = z.object({
  title: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
  text: z.string(),
  publishedDate: z.string().nullable().optional(),
}).passthrough();

const searchPayloadSchema = z.object({
  results: z.array(z.unknown()).optional(),
}).passthrough();

export interface WebSource {
  title: string;
  url: string;
  text: string;
  published_date: string;
}

/** Unwrap the MCP envelope down to the serialized results document. */
function extractResultsDocument(toolResult: unknown): string {
  const envelope = toolCallResultSchema.safeParse(toolResult);
  if (!envelope.success) throw new ServiceError('Web search returned an unexpected MCP result shape');
  const { isError, content } = envelope.data;
  const firstText = content?.[0]?.text ?? '';
  if (isError) throw new ServiceError(`Web search tool error: ${firstText.slice(0, 300)}`);
  if (!firstText) throw new ServiceError('Web search returned an empty MCP content block');
  return firstText;
}

/** Normalize raw observations. Knowledge-graph observations (structured
 * facts) have null title/url and are kept — their text is high-confidence
 * grounding. */
function normalizeResults(rawResults: unknown[]): WebSource[] {
  const sources: WebSource[] = [];
  for (const raw of rawResults) {
    const result = webResultSchema.safeParse(raw);
    if (!result.success || result.data.text === '') continue;
    sources.push({
      title: result.data.title ?? '',
      url: result.data.url ?? '',
      text: result.data.text,
      published_date: result.data.publishedDate ?? '',
    });
  }
  return sources;
}

/** content[0].text is a serialized JSON document with a `results` array. */
function extractResults(toolResult: unknown): WebSource[] {
  const document = extractResultsDocument(toolResult);
  const payload = parseJsonOrThrow(document, 'Web search returned non-JSON result text');
  const parsedPayload = searchPayloadSchema.safeParse(payload);
  return normalizeResults(parsedPayload.success ? parsedPayload.data.results ?? [] : []);
}

// ── Formatting ──

function formatSource(source: WebSource, index: number): string {
  const title = source.title === '' ? 'Knowledge graph fact' : source.title;
  const published = source.published_date === '' ? '' : ` (${source.published_date})`;
  const link = source.url === '' ? title : `[${title}](${source.url})`;
  return `${index + 1}. ${link}${published}\n   ${source.text.slice(0, 1200)}`;
}

function formatResults(sources: WebSource[]): string {
  if (sources.length === 0) return 'No web results found for this query.';
  const header = `Found ${sources.length} web results. When you use one in your answer, cite its source URL inline:\n\n`;
  return header + sources.map((source, i) => formatSource(source, i)).join('\n\n');
}

// ── Main export ──

const webSearchInputSchema = z.object({
  query: z.string().optional(),
  max_results: z.number().optional(),
}).passthrough();

export async function executeWebSearch(
  toolInput: unknown,
): Promise<{ content: string; webSources: WebSource[] }> {
  if (!isWebSearchConfigured()) {
    throw new ServiceError('Web search is not configured (WEB_SEARCH_GATEWAY_URL unset)');
  }
  const parsed = webSearchInputSchema.safeParse(toolInput);
  const input = parsed.success ? parsed.data : {};
  const query = (input.query ?? '').trim().slice(0, MAX_QUERY_LENGTH);
  if (query === '') {
    return { content: 'Web search skipped: empty query.', webSources: [] };
  }
  const maxResults = Math.max(1, Math.min(Math.trunc(input.max_results ?? DEFAULT_MAX_RESULTS), MAX_RESULTS_CAP));

  const toolResult = await callWebSearchTool(query, maxResults);
  const webSources = extractResults(toolResult);
  console.log(`web_search: ${webSources.length} results for a ${query.length}-char query`);
  return { content: formatResults(webSources), webSources };
}
