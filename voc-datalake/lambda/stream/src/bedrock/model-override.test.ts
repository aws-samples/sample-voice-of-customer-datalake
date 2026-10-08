/**
 * Tests for the per-surface model override lookup (issue #96).
 *
 * The lookup must never throw (a chat turn must survive a broken table),
 * must enforce the allowlist against tampered DB values, and must apply the
 * per-surface > legacy-global precedence mirrored from model_config.py.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  invocationModelId,
  usesAdaptiveThinking,
  ALLOWED_MODEL_IDS,
} from './model-override.js';

const OPUS55 = 'global.anthropic.claude-opus-5-5';
const SONNET55 = 'global.anthropic.claude-sonnet-5-5';
const SONNET5 = 'global.anthropic.claude-sonnet-5';
const SONNET46 = 'global.anthropic.claude-sonnet-4-6';
const OPUS5 = 'global.anthropic.claude-opus-5';
const OPUS48 = 'global.anthropic.claude-opus-4-8';
const HAIKU55 = 'global.anthropic.claude-haiku-5-5';
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

// The settings item is cached per container (module scope). A fresh module per
// test is a fresh container, so no cached item leaks between cases.
let resolveModelOverride: typeof import('./model-override.js').resolveModelOverride;

beforeEach(async () => {
  vi.resetModules();
  ({ resolveModelOverride } = await import('./model-override.js'));
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

  it('accepts Sonnet 5.5 as a chat-surface override', async () => {
    const client = docClientReturning({ surfaces: { chat: SONNET55 } });
    expect(await resolveModelOverride(client, 'agg', 'chat')).toBe(SONNET55);
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

});

describe('capability sets', () => {
  it('allowlist has exactly the eight picker models', () => {
    expect(ALLOWED_MODEL_IDS).toStrictEqual(
      new Set([OPUS55, SONNET55, SONNET5, SONNET46, OPUS5, OPUS48, HAIKU55, HAIKU45]),
    );
  });

  // Opus 4.7 and later reject a manual `thinking.budget_tokens` with a 400, so
  // every Opus generation joins Sonnet 5 in the always-on adaptive-thinking set,
  // and so does Haiku 5.5 (probed: it rejects `thinking.type.enabled`).
  it.each([
    [OPUS55, true],
    [HAIKU55, true],
    [SONNET55, true],
    [SONNET5, true],
    [OPUS5, true],
    [OPUS48, true],
    [SONNET46, false],
    [HAIKU45, false],
  ])('%s uses always-on adaptive thinking: %s (every Opus, Sonnet 5 / 5.5 and Haiku 5.5 do)', (model, adaptive) => {
    expect(usesAdaptiveThinking(model)).toBe(adaptive);
  });
});

describe('invocationModelId (inference scope, docs/eu-deployment.md)', () => {
  it('keeps the canonical id outside the eu scope', () => {
    expect(invocationModelId(SONNET55, '')).toBe(SONNET55);
    expect(invocationModelId(SONNET55, 'global')).toBe(SONNET55);
  });

  it('maps every allowlisted model to its eu. profile', () => {
    expect([...ALLOWED_MODEL_IDS].map((id) => invocationModelId(id, 'eu')))
      .toStrictEqual([...ALLOWED_MODEL_IDS].map((id) => id.replace(/^global\./, 'eu.')));
  });

  it('leaves a non-global id (already scoped, or in-region) alone', () => {
    expect(invocationModelId('eu.anthropic.claude-opus-5', 'eu')).toBe('eu.anthropic.claude-opus-5');
    expect(invocationModelId('amazon.titan-embed-text-v2:0', 'EU')).toBe('amazon.titan-embed-text-v2:0');
  });
});

// The mutation run found the read key, the cache windows and the allowlist
// warning unpinned; these cases pin each exactly.
describe('resolveModelOverride — exact read, cache windows and warnings', () => {
  afterEach(() => vi.restoreAllMocks());

  const clock = (start: number) => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(start);
    return (ms: number) => now.mockReturnValue(start + ms);
  };

  it('reads the SETTINGS#model / config item of the given table', async () => {
    const client = docClientReturning({});
    await resolveModelOverride(client, 'agg');
    expect(client.send.mock.calls.map(([command]) => Reflect.get(command, 'input'))).toStrictEqual([
      { TableName: 'agg', Key: { pk: 'SETTINGS#model', sk: 'config' } },
    ]);
  });

  it('defaults to the chat surface', async () => {
    expect(await resolveModelOverride(docClientReturning({ surfaces: { chat: HAIKU45 } }), 'agg')).toBe(HAIKU45);
  });

  it('falls back to the legacy global when other surfaces are pinned but chat is not', async () => {
    const client = docClientReturning({ model_id: SONNET46, surfaces: { documents: OPUS5 } });
    expect(await resolveModelOverride(client, 'agg', 'chat')).toBe(SONNET46);
  });

  it('re-reads the item once 60 s have passed', async () => {
    const advance = clock(1_000_000);
    const client = docClientReturning({ surfaces: { chat: HAIKU45 } });
    await resolveModelOverride(client, 'agg');
    advance(59_999);
    await resolveModelOverride(client, 'agg');
    expect(client.send).toHaveBeenCalledTimes(1);
    advance(60_000);
    await resolveModelOverride(client, 'agg');
    expect(client.send).toHaveBeenCalledTimes(2);
  });

  it('warns on a failed read and retries it after 10 s', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const advance = clock(1_000_000);
    const client = docClientRejecting();
    await resolveModelOverride(client, 'agg');
    expect(warn.mock.calls).toStrictEqual([['Model override lookup failed; using default:', new Error('AccessDenied')]]);
    advance(9_999);
    await resolveModelOverride(client, 'agg');
    expect(client.send).toHaveBeenCalledTimes(1);
    advance(10_000);
    await resolveModelOverride(client, 'agg');
    expect(client.send).toHaveBeenCalledTimes(2);
  });

  it('names a value off the allowlist, cut to 80 characters', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const tampered = `x${'y'.repeat(99)}`;
    expect(await resolveModelOverride(docClientReturning({ model_id: tampered }), 'agg')).toBeUndefined();
    expect(warn.mock.calls).toStrictEqual([[`Configured model '${tampered.slice(0, 80)}' not in allowlist; ignoring`]]);
  });

  it('stays silent when nothing is configured', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await resolveModelOverride(docClientReturning({ surfaces: {} }), 'agg')).toBeUndefined();
    expect(warn.mock.calls).toStrictEqual([]);
  });
});
