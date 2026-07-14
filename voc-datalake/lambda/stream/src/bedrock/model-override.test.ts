/**
 * Tests for the streaming-chat model override lookup (issue #96).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { clearModelOverrideCache, getModelOverride } from './model-override.js';

const SONNET = 'global.anthropic.claude-sonnet-4-5-20250929-v1:0';
const HAIKU = 'global.anthropic.claude-haiku-4-5-20251001-v1:0';

function clientReturning(item: Record<string, unknown> | undefined) {
  return {
    send: vi.fn().mockResolvedValue({ Item: item }),
  } as unknown as DynamoDBDocumentClient;
}

describe('getModelOverride', () => {
  beforeEach(() => {
    clearModelOverrideCache();
    vi.restoreAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('returns undefined without a table name', async () => {
    const client = clientReturning({ model_id: HAIKU });
    expect(await getModelOverride(client, '')).toBeUndefined();
    expect((client.send as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('returns the configured allowlisted model', async () => {
    const client = clientReturning({ model_id: HAIKU });
    expect(await getModelOverride(client, 'agg')).toBe(HAIKU);
  });

  it('returns undefined when nothing is configured', async () => {
    const client = clientReturning(undefined);
    expect(await getModelOverride(client, 'agg')).toBeUndefined();
  });

  it('rejects models outside the allowlist', async () => {
    const client = clientReturning({ model_id: 'anthropic.evil-model-v9' });
    expect(await getModelOverride(client, 'agg')).toBeUndefined();
  });

  it('never throws when the lookup fails', async () => {
    const client = {
      send: vi.fn().mockRejectedValue(new Error('AccessDenied')),
    } as unknown as DynamoDBDocumentClient;
    expect(await getModelOverride(client, 'agg')).toBeUndefined();
  });

  it('caches the lookup within the TTL', async () => {
    const client = clientReturning({ model_id: SONNET });
    await getModelOverride(client, 'agg');
    await getModelOverride(client, 'agg');
    expect((client.send as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });
});
