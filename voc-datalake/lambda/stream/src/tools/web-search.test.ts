/**
 * Tests for the web_search tool (AgentCore Gateway MCP client).
 *
 * The gateway is an external HTTP boundary: fetch is stubbed and the tests
 * pin the protocol around it — SigV4-signed JSON-RPC requests, SSE-vs-JSON
 * response bodies, MCP result unwrapping, tool-name discovery fallback,
 * input clamping, and the citation-bearing formatting contract.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@aws-sdk/credential-provider-node', () => ({
  // Static credentials so the real SignatureV4 can sign offline.
  defaultProvider: () => () =>
    Promise.resolve({ accessKeyId: 'AKIATEST', secretAccessKey: 'test-secret' }),
}));

import {
  executeWebSearch,
  isWebSearchConfigured,
  resetToolNameCacheForTesting,
} from './web-search.js';

const GATEWAY_URL = 'https://gw-abc123.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp';
const TOOL_NAME = 'web-search-tool___WebSearch';

const SAMPLE_RESULTS = [
  {
    title: 'Python 3.13 Release Highlights',
    url: 'https://example.com/python/releases/3.13',
    text: 'Python 3.13 was released on October 7, 2024...',
    publishedDate: '2024-10-07',
  },
  // Knowledge-graph observation: null title/url, structured facts in text.
  { title: null, url: null, text: 'Founded: 1994. Founder: Jeff Bezos.' },
];

function toolCallBody(results: unknown[]): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    result: {
      isError: false,
      content: [{ type: 'text', text: JSON.stringify({ id: 'abc', results }) }],
    },
  });
}

function jsonResponse(body: string, status = 200, contentType = 'application/json'): Response {
  return new Response(body, { status, headers: { 'content-type': contentType } });
}

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubEnv('WEB_SEARCH_GATEWAY_URL', GATEWAY_URL);
  vi.stubEnv('WEB_SEARCH_TOOL_NAME', TOOL_NAME);
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
  resetToolNameCacheForTesting();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function sentBody(callIndex = 0): { method: string; params: { name?: string; arguments?: Record<string, unknown> } } {
  const init = mockFetch.mock.calls[callIndex][1] as { body: string };
  return JSON.parse(init.body) as { method: string; params: { name?: string; arguments?: Record<string, unknown> } };
}

describe('isWebSearchConfigured', () => {
  it('is true when the gateway URL is set', () => {
    expect(isWebSearchConfigured()).toBe(true);
  });

  it('is false without the gateway URL', () => {
    vi.stubEnv('WEB_SEARCH_GATEWAY_URL', '');
    expect(isWebSearchConfigured()).toBe(false);
  });
});

describe('executeWebSearch', () => {
  it('rejects when unconfigured', async () => {
    vi.stubEnv('WEB_SEARCH_GATEWAY_URL', '');
    await expect(executeWebSearch({ query: 'x' })).rejects.toThrow('not configured');
  });

  it('skips empty queries without a network call', async () => {
    const result = await executeWebSearch({ query: '   ' });
    expect(result.content).toContain('empty query');
    expect(result.webSources).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('sends a SigV4-signed JSON-RPC tools/call and normalizes results', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(toolCallBody(SAMPLE_RESULTS)));

    const result = await executeWebSearch({ query: 'python 3.13 release' });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toBe(GATEWAY_URL);
    // Signed by the real SignatureV4 for the gateway's region/service.
    expect(init.headers.authorization).toContain('AWS4-HMAC-SHA256');
    expect(init.headers.authorization).toContain('us-east-1/bedrock-agentcore');

    const body = sentBody();
    expect(body.method).toBe('tools/call');
    expect(body.params.name).toBe(TOOL_NAME);
    expect(body.params.arguments).toEqual({ query: 'python 3.13 release', maxResults: 5 });

    expect(result.webSources).toEqual([
      {
        title: 'Python 3.13 Release Highlights',
        url: 'https://example.com/python/releases/3.13',
        text: 'Python 3.13 was released on October 7, 2024...',
        published_date: '2024-10-07',
      },
      // Knowledge-graph fact kept, with empty (not null) title/url.
      { title: '', url: '', text: 'Founded: 1994. Founder: Jeff Bezos.', published_date: '' },
    ]);
    // Formatting keeps citations and instructs the model to use them.
    expect(result.content).toContain('cite its source URL');
    expect(result.content).toContain('[Python 3.13 Release Highlights](https://example.com/python/releases/3.13)');
  });

  it('clamps the query to 200 chars and max_results to 10', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(toolCallBody([])));

    await executeWebSearch({ query: 'q'.repeat(500), max_results: 99 });

    const args = sentBody().params.arguments ?? {};
    expect(String(args.query)).toHaveLength(200);
    expect(args.maxResults).toBe(10);
  });

  it('parses SSE-framed gateway responses', async () => {
    const sse = `event: message\ndata: ${toolCallBody(SAMPLE_RESULTS)}\n\n`;
    mockFetch.mockResolvedValueOnce(jsonResponse(sse, 200, 'text/event-stream'));

    const result = await executeWebSearch({ query: 'query' });
    expect(result.webSources).toHaveLength(2);
  });

  it('reports zero results without failing', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(toolCallBody([])));
    const result = await executeWebSearch({ query: 'query' });
    expect(result.webSources).toEqual([]);
    expect(result.content).toContain('No web results');
  });

  it('surfaces JSON-RPC errors', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: 'throttled' } })));
    await expect(executeWebSearch({ query: 'q' })).rejects.toThrow('throttled');
  });

  it('surfaces tool-level errors from the MCP envelope', async () => {
    const body = JSON.stringify({
      jsonrpc: '2.0', id: 1,
      result: { isError: true, content: [{ type: 'text', text: 'quota exceeded' }] },
    });
    mockFetch.mockResolvedValueOnce(jsonResponse(body));
    await expect(executeWebSearch({ query: 'q' })).rejects.toThrow('quota exceeded');
  });

  it('surfaces HTTP failures with status', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse('forbidden', 403, 'text/plain'));
    await expect(executeWebSearch({ query: 'q' })).rejects.toThrow('HTTP 403');
  });

  it('surfaces non-JSON bodies', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse('<html>502</html>', 200, 'text/html'));
    await expect(executeWebSearch({ query: 'q' })).rejects.toThrow('non-JSON');
  });
});

describe('tool name discovery fallback', () => {
  it('resolves the real tool name via tools/list on unknown-tool errors, then caches it', async () => {
    const discovered = 'renamed-target___WebSearch';
    mockFetch
      .mockResolvedValueOnce(jsonResponse(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: "tool 'web-search-tool___WebSearch' not found" } })))
      .mockResolvedValueOnce(jsonResponse(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'other___Thing' }, { name: discovered }] } })))
      .mockResolvedValueOnce(jsonResponse(toolCallBody(SAMPLE_RESULTS)));

    const result = await executeWebSearch({ query: 'query' });

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(sentBody(0).method).toBe('tools/call');
    expect(sentBody(1).method).toBe('tools/list');
    expect(sentBody(2).params.name).toBe(discovered);
    expect(result.webSources).toHaveLength(2);

    // Subsequent calls go straight to the discovered name.
    mockFetch.mockResolvedValueOnce(jsonResponse(toolCallBody([])));
    await executeWebSearch({ query: 'second' });
    expect(sentBody(3).params.name).toBe(discovered);
  });

  it('does not attempt discovery for non-name errors', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: 'access denied' } })));
    await expect(executeWebSearch({ query: 'q' })).rejects.toThrow('access denied');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('fails clearly when the gateway exposes no WebSearch tool', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: 'unknown tool' } })))
      .mockResolvedValueOnce(jsonResponse(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'other___Thing' }] } })));
    await expect(executeWebSearch({ query: 'q' })).rejects.toThrow('No WebSearch tool');
  });
});
