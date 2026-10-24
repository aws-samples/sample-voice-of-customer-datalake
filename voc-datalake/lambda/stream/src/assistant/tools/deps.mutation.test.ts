/**
 * Mutation hardening of the process-wide tool dependencies.
 *
 * Every other spec injects fakes, so nothing exercised `getDefaultToolDeps()`:
 * the run found the DynamoDB marshalling option, the feedback-table fallback,
 * each delegate's wiring and the build-once caching all unpinned. The external
 * modules are mocked here — this is the one place their real wiring lives.
 */
import { ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALL_CATEGORIES as SCOPE } from '../../tools/feedback-test-fixtures.js';

const h = vi.hoisted(() => ({
  documentClient: { kind: 'document-client' },
  from: vi.fn(),
  search: vi.fn(),
  web: vi.fn(),
  send: vi.fn(),
  avatar: vi.fn(),
  invoker: vi.fn(),
}));

vi.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: class FakeDynamoDBClient {} }));
vi.mock('@aws-sdk/lib-dynamodb', () => ({ DynamoDBDocumentClient: { from: h.from } }));
vi.mock('../../bedrock/converse-stream.js', () => ({ getBedrockClient: () => ({ send: h.send }) }));
vi.mock('../../context/avatar-url.js', () => ({ resolveAvatarUrl: h.avatar }));
vi.mock('../../tools/search-feedback.js', () => ({ executeSearchFeedback: h.search }));
vi.mock('../../tools/web-search.js', () => ({ executeWebSearch: h.web }));
vi.mock('./internal-api.js', () => ({ getInternalApiInvoker: () => h.invoker }));

/** A fresh copy of the module, so each case starts with nothing cached. */
async function freshDeps() {
  vi.resetModules();
  const { getDefaultToolDeps } = await import('./deps.js');
  return getDefaultToolDeps;
}

beforeEach(() => {
  h.from.mockReset().mockReturnValue(h.documentClient);
  vi.stubEnv('FEEDBACK_TABLE', 'voc-feedback');
  vi.stubEnv('BEDROCK_MODEL_ID', 'global.anthropic.claude-sonnet-5');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('getDefaultToolDeps', () => {
  it('builds the dependencies once and returns the same object afterwards', async () => {
    const getDefaultToolDeps = await freshDeps();
    const deps = getDefaultToolDeps();
    expect(getDefaultToolDeps()).toBe(deps);
    expect(h.from).toHaveBeenCalledTimes(1);
    expect(h.from).toHaveBeenCalledWith(expect.anything(), { marshallOptions: { removeUndefinedValues: true } });
  });

  it('passes the invoker, the avatar resolver and the fallback model through', async () => {
    const deps = (await freshDeps())();
    expect(deps.invoke).toBe(h.invoker);
    expect(deps.resolveAvatar).toBe(h.avatar);
    expect(deps.fallbackModelId).toBe('global.anthropic.claude-sonnet-5');
  });

  it('searches the configured feedback table with the document client', async () => {
    const found = { items: [], formatted: 'No feedback found matching the search criteria.' };
    h.search.mockResolvedValueOnce(found);
    const deps = (await freshDeps())();
    await expect(deps.searchFeedback({ query: 'late' }, { scope: SCOPE, days: 7 })).resolves.toBe(found);
    expect(h.search).toHaveBeenCalledWith(h.documentClient, 'voc-feedback', { query: 'late' }, { scope: SCOPE, days: 7 });
  });

  it('falls back to an empty table name when FEEDBACK_TABLE is unset', async () => {
    vi.stubEnv('FEEDBACK_TABLE', undefined);
    h.search.mockResolvedValueOnce({ items: [], formatted: '' });
    const deps = (await freshDeps())();
    await deps.searchFeedback({}, { scope: SCOPE });
    expect(h.search).toHaveBeenLastCalledWith(h.documentClient, '', {}, { scope: SCOPE });
  });

  it('delegates web search and Bedrock calls', async () => {
    const web = { content: 'No web results found for this query.', webSources: [] };
    const answer = { output: { message: { role: 'assistant', content: [] } } };
    h.web.mockResolvedValueOnce(web);
    h.send.mockResolvedValueOnce(answer);
    const deps = (await freshDeps())();
    const command = new ConverseCommand({ modelId: 'global.anthropic.claude-sonnet-5', messages: [] });
    await expect(deps.webSearch({ query: 'pricing' })).resolves.toBe(web);
    expect(h.web).toHaveBeenCalledWith({ query: 'pricing' });
    await expect(deps.converse(command)).resolves.toBe(answer);
    expect(h.send).toHaveBeenCalledWith(command);
  });
});
