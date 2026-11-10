import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  COOLDOWN_SECONDS,
  MODEL_FALLBACK_ORDER,
  cooldownUntil,
  fallbackChain,
  fallbackReason,
  isCoolingDown,
  isModelUnavailable,
  markUnavailable,
  orderForAttempt,
  recordFallback,
} from './model-fallback.js';
import { ALLOWED_MODEL_IDS } from './model-override.js';

const OPUS55 = 'global.anthropic.claude-opus-5-5';
const SONNET55 = 'global.anthropic.claude-sonnet-5-5';
const SONNET5 = 'global.anthropic.claude-sonnet-5';
const SONNET46 = 'global.anthropic.claude-sonnet-4-6';
const OPUS5 = 'global.anthropic.claude-opus-5';
const HAIKU55 = 'global.anthropic.claude-haiku-5-5';
const HAIKU45 = 'global.anthropic.claude-haiku-4-5-20251001-v1:0';

function named(name: string, message = 'x'): Error {
  return Object.assign(new Error(message), { name });
}

/** The Opus models a chain would try, in order. */
function opusIn(chain: readonly string[]): string[] {
  return chain.filter((model) => model.includes('.claude-opus-'));
}

afterEach(() => cooldownUntil.clear());

describe('fallbackChain', () => {
  it('walks Sonnet 5.5 → Sonnet 5 → Sonnet 4.6 → Haiku 5.5 → Haiku 4.5 by default', () => {
    expect(MODEL_FALLBACK_ORDER).toStrictEqual([SONNET55, SONNET5, SONNET46, HAIKU55, HAIKU45]);
    expect(fallbackChain(SONNET55)).toStrictEqual([SONNET55, SONNET5, SONNET46, HAIKU55, HAIKU45]);
  });

  it('puts a configured model first and the chat default second', () => {
    expect(fallbackChain(HAIKU45)).toStrictEqual([HAIKU45, SONNET55, SONNET5, SONNET46, HAIKU55]);
  });

  it('reaches Opus only as the configured model', () => {
    expect(fallbackChain(OPUS55)).toStrictEqual([OPUS55, SONNET55, SONNET5, SONNET46, HAIKU55, HAIKU45]);
    expect(opusIn(fallbackChain(SONNET5))).toStrictEqual([]);
  });

  it('never uses an older Opus as a stand-in (they are Bedrock safety-fallback targets)', () => {
    expect(opusIn(fallbackChain(OPUS55))).toStrictEqual([OPUS55]);
    expect(opusIn(fallbackChain(OPUS5))).toStrictEqual([OPUS5]);
  });

  it('keeps an unknown primary but only allowlisted fallbacks', () => {
    const chain = fallbackChain('anthropic.legacy');
    expect(chain[0]).toBe('anthropic.legacy');
    expect(chain.slice(1).every((model) => ALLOWED_MODEL_IDS.has(model))).toBe(true);
    expect(MODEL_FALLBACK_ORDER.every((model) => ALLOWED_MODEL_IDS.has(model))).toBe(true);
  });
});

describe('isModelUnavailable', () => {
  it.each([
    'ThrottlingException', 'ServiceUnavailableException', 'ModelNotReadyException',
    'ServiceQuotaExceededException', 'ResourceNotFoundException',
  ])('%s falls back', (name) => {
    expect(isModelUnavailable(named(name))).toBe(true);
  });

  it.each([
    ['AccessDeniedException', "You don't have access to the model with the specified model ID."],
    ['AccessDeniedException', 'User: arn:x is not authorized to perform: bedrock:InvokeModelWithResponseStream on resource'],
    ['ValidationException', "Invocation of model ID anthropic.x with on-demand throughput isn't supported."],
    ['ValidationException', 'The provided model identifier is invalid.'],
    ['ValidationException', 'This model version has reached the end of its life.'],
    ['ValidationException', 'The model is not enabled for this account.'],
  ])('%s naming model availability falls back (%s)', (name, message) => {
    expect(isModelUnavailable(named(name, message))).toBe(true);
  });

  it.each([
    ['ValidationException', 'Input is too long for requested model.'],
    ['ValidationException', 'Expected thinking block'],
    ['AccessDeniedException', 'Request blocked by guardrail'],
    ['ModelStreamErrorException', 'stream broke'],
    ['TypeError', 'boom'],
  ])('%s about the input does not fall back (%s)', (name, message) => {
    expect(isModelUnavailable(named(name, message))).toBe(false);
  });

  it('ignores non-errors', () => {
    expect(isModelUnavailable('ThrottlingException')).toBe(false);
  });
});

describe('cooldown', () => {
  it('moves a cooling model last, keeping it as a final attempt', () => {
    markUnavailable(SONNET55, 1_000);
    expect(orderForAttempt(fallbackChain(SONNET55), 2_000)).toStrictEqual([SONNET5, SONNET46, HAIKU55, HAIKU45, SONNET55]);
  });

  it('expires after COOLDOWN_SECONDS', () => {
    markUnavailable(SONNET55, 1_000);
    expect(isCoolingDown(SONNET55, 1_000 + COOLDOWN_SECONDS * 1000 - 1)).toBe(true);
    expect(isCoolingDown(SONNET55, 1_000 + COOLDOWN_SECONDS * 1000)).toBe(false);
    expect(COOLDOWN_SECONDS).toBe(300);
  });
});

// The mutation run found these unpinned: the optional words of the message
// patterns, non-Error values, the reason fallback, and the exact log + EMF line.
describe('isModelUnavailable — exact gates', () => {
  it.each([
    ['AccessDeniedException', 'No access to model x'],
    ['ValidationException', 'Model not ready yet'],
    ['ValidationException', 'This version reached end of life'],
  ])('%s matches without the optional word (%s)', (name, message) => {
    expect(isModelUnavailable(named(name, message))).toBe(true);
  });

  it('needs a gated code before reading the message', () => {
    expect(isModelUnavailable(named('TypeError', 'no access to the model'))).toBe(false);
  });

  it('ignores an Error-shaped object that is not an Error', () => {
    expect(isModelUnavailable({ name: 'ThrottlingException', message: 'x' })).toBe(false);
  });
});

describe('fallbackReason', () => {
  it.each([
    ['a named error', named('ThrottlingException'), 'ThrottlingException'],
    ['an error with an empty name', named(''), 'UnknownError'],
    ['an Error-shaped object', { name: 'ThrottlingException' }, 'UnknownError'],
    ['a string', 'boom', 'UnknownError'],
  ])('reports %s', (_label, err, reason) => {
    expect(fallbackReason(err)).toBe(reason);
  });
});

describe('recordFallback', () => {
  afterEach(() => vi.restoreAllMocks());

  it('logs the hop and emits one ModelFallback EMF line', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(Date, 'now').mockReturnValue(1_234);

    recordFallback(SONNET55, SONNET5, 'ThrottlingException');

    expect(warn.mock.calls).toStrictEqual([[
      `Model ${SONNET55} cannot serve now (ThrottlingException); falling back to ${SONNET5}`,
    ]]);
    expect(log.mock.calls.map(([line]) => JSON.parse(String(line)))).toStrictEqual([{
      _aws: {
        Timestamp: 1_234,
        CloudWatchMetrics: [{
          Namespace: 'VoC',
          Dimensions: [['Surface', 'From', 'To']],
          Metrics: [{ Name: 'ModelFallback', Unit: 'Count' }],
        }],
      },
      Surface: 'chat',
      From: SONNET55,
      To: SONNET5,
      Reason: 'ThrottlingException',
      ModelFallback: 1,
    }]);
  });
});

describe('isCoolingDown — a model never marked', () => {
  it('is not cooling at any clock', () => {
    expect(isCoolingDown(SONNET5, 0)).toBe(false);
    expect(isCoolingDown(SONNET5, -1)).toBe(false);
  });
});
