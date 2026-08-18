/**
 * Tests for the per-surface model override lookup (issue #96).
 *
 * The lookup must never throw (a chat turn must survive a broken table),
 * must enforce the allowlist against tampered DB values, and must apply the
 * per-surface > legacy-global precedence mirrored from model_config.py.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  resolveModelOverride,
  clearModelOverrideCache,
  omitsTemperature,
  usesAdaptiveThinking,
  ALLOWED_MODEL_IDS,
} from './model-override.js';

const SONNET5 = 'global.anthropic.claude-sonnet-5';
const SONNET46 = 'global.anthropic.claude-sonnet-4-6';
const OPUS5 = 'global.anthropic.claude-opus-5';
const OPUS48 = 'global.anthropic.claude-opus-4-8';
const HAIKU45 = 'global.anthropic.claude-haiku-4-5-20251001-v1:0';

interface DocClientLike {
  send: ReturnType<typeof vi.fn>;
}

function isDocClient(client: DocClientLike): client is DocClientLike & DynamoDBDocumentClient {
  return typeof client.send === 'function';
}

/** Build a doc-client test double without `as` type assertions. */
function docClientReturning(item: Record<string, unknown> | undefined): DynamoDBDocumentClient & DocClientLike {
  const double: DocClientLike = { send: vi.fn().mockResolvedValue({ Item: item }) };
  if (!isDocClient(double)) throw new Error('test double is not send-able');
  return double;
}

function docClientRejecting(): DynamoDBDocumentClient & DocClientLike {
  const double: DocClientLike = { send: vi.fn().mockRejectedValue(new Error('AccessDenied')) };
  if (!isDocClient(double)) throw new Error('test double is not send-able');
  return double;
}

beforeEach(() => {
  clearModelOverrideCache();
});

describe('resolveModelOverride', () => {
  it('returns undefined when no table name is configured', async () => {
    const client = docClientReturning({});
    expect(await resolveModelOverride(client, '')).toBeUndefined();
    expect(client.send).not.toHaveBeenCalled();
  });

  it('returns undefined when nothing is configured', async () => {
    const client = docClientReturning(undefined);
    expect(await resolveModelOverride(client, 'agg', 'chat')).toBeUndefined();
  });

  it('returns the per-surface override for the chat surface', async () => {
    const client = docClientReturning({ surfaces: { chat: HAIKU45 } });
    expect(await resolveModelOverride(client, 'agg', 'chat')).toBe(HAIKU45);
  });

  it('ignores overrides pinned to other surfaces', async () => {
    const client = docClientReturning({ surfaces: { documents: OPUS5 } });
    expect(await resolveModelOverride(client, 'agg', 'chat')).toBeUndefined();
  });

  it('falls back to the legacy global override when the surface is unpinned', async () => {
    const client = docClientReturning({ model_id: SONNET46 });
    expect(await resolveModelOverride(client, 'agg', 'chat')).toBe(SONNET46);
  });

  it('prefers the per-surface override over the legacy global', async () => {
    const client = docClientReturning({
      model_id: SONNET46,
      surfaces: { chat: HAIKU45 },
    });
    expect(await resolveModelOverride(client, 'agg', 'chat')).toBe(HAIKU45);
  });

  it('rejects tampered values outside the allowlist', async () => {
    const client = docClientReturning({
      model_id: 'anthropic.evil-model-v9',
      surfaces: { chat: 'anthropic.evil-model-v9' },
    });
    expect(await resolveModelOverride(client, 'agg', 'chat')).toBeUndefined();
  });

  it('never throws when the lookup fails (falls back to default)', async () => {
    const client = docClientRejecting();
    expect(await resolveModelOverride(client, 'agg', 'chat')).toBeUndefined();
  });

  it('caches the settings item across calls within the TTL', async () => {
    const client = docClientReturning({ surfaces: { chat: HAIKU45 } });
    await resolveModelOverride(client, 'agg', 'chat');
    await resolveModelOverride(client, 'agg', 'chat');
    expect(client.send).toHaveBeenCalledTimes(1);
  });

  it('clearModelOverrideCache forces a refetch', async () => {
    const client = docClientReturning({ surfaces: { chat: HAIKU45 } });
    await resolveModelOverride(client, 'agg', 'chat');
    clearModelOverrideCache();
    await resolveModelOverride(client, 'agg', 'chat');
    expect(client.send).toHaveBeenCalledTimes(2);
  });
});

describe('capability sets', () => {
  it('allowlist has exactly the four picker models', () => {
    expect(ALLOWED_MODEL_IDS).toStrictEqual(
      new Set([SONNET5, SONNET46, OPUS5, OPUS48, HAIKU45]),
    );
  });

  it('both Opus generations and Sonnet 5 omit temperature', () => {
    expect(omitsTemperature(SONNET5)).toBe(true);
    expect(omitsTemperature(OPUS5)).toBe(true);
    expect(omitsTemperature(OPUS48)).toBe(true);
    expect(omitsTemperature(SONNET46)).toBe(false);
    expect(omitsTemperature(HAIKU45)).toBe(false);
  });

  // Opus 4.7 and later reject a manual `thinking.budget_tokens` with a 400, so
  // BOTH Opus generations join Sonnet 5 in the always-on adaptive-thinking set.
  it('both Opus generations and Sonnet 5 use always-on adaptive thinking', () => {
    expect(usesAdaptiveThinking(SONNET5)).toBe(true);
    expect(usesAdaptiveThinking(OPUS5)).toBe(true);
    expect(usesAdaptiveThinking(OPUS48)).toBe(true);
    expect(usesAdaptiveThinking(SONNET46)).toBe(false);
    expect(usesAdaptiveThinking(HAIKU45)).toBe(false);
  });
});
