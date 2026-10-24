/**
 * Model capacity fallback in the streaming assistant: a model that is granted
 * but cannot serve now hands the turn to the next model of the chain — only
 * before anything of that turn reached the client.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConverseStreamOutput } from '@aws-sdk/client-bedrock-runtime';
import { cooldownUntil, fallbackChain, isCoolingDown } from '../../bedrock/model-fallback.js';
import { bedrockEvents, failingStream, runBody, streamOf, type ScriptedTurn } from './__fixtures__/fakes.js';
import { finished, harness, run, silenceConsole, types, type Harness } from './__fixtures__/harness.js';

silenceConsole();
beforeEach(() => vi.mocked(console.log).mockClear());
afterEach(() => cooldownUntil.clear());

const SONNET55 = 'global.anthropic.claude-sonnet-5-5';
const SONNET5 = 'global.anthropic.claude-sonnet-5';
const OPUS5 = 'global.anthropic.claude-opus-5';

function named(name: string, message = 'x'): Error {
  return Object.assign(new Error(message), { name });
}

/** A stream that yields `prefix` and then fails mid-response. */
async function* failingAfter(prefix: ConverseStreamOutput[], failure: Error): AsyncGenerator<ConverseStreamOutput> {
  yield* streamOf(prefix);
  throw failure;
}

/** Route each Bedrock call by model: a failing model raises, others answer from `turns`. */
function byModel(h: Harness, failing: Record<string, () => AsyncIterable<ConverseStreamOutput>>, turns: ScriptedTurn[] = []): string[] {
  const tried: string[] = [];
  const script = [...turns];
  h.deps.converse = (params) => {
    const model = params.modelId ?? '';
    tried.push(model);
    const fail = failing[model];
    if (fail) return fail();
    return streamOf(bedrockEvents(script.shift() ?? { text: `answer from ${model}` }));
  };
  return tried;
}

function textOf(events: Awaited<ReturnType<typeof run>>): string {
  return events
    .filter((e) => e.type === 'TEXT_MESSAGE_CONTENT')
    .map((e) => String(Reflect.get(e, 'delta')))
    .join('');
}

function fallbackMetrics(): Record<string, unknown>[] {
  return vi.mocked(console.log).mock.calls
    .map(([line]) => (typeof line === 'string' && line.includes('"ModelFallback"') ? JSON.parse(line) : null))
    .filter((entry): entry is Record<string, unknown> => entry !== null);
}

describe('runAssistant — model capacity fallback', () => {
  const throttledFirst = () => {
    const h = harness([]);
    const tried = byModel(h, { [SONNET55]: () => failingStream(named('ThrottlingException', 'Too many requests')) });
    return { h, tried };
  };

  it('falls back from a throttled model before the first token', async () => {
    const { h, tried } = throttledFirst();
    const events = await run(runBody(), h);

    expect(tried).toStrictEqual([SONNET55, SONNET5]);
    expect(textOf(events)).toBe(`answer from ${SONNET5}`);
    expect(types(events).filter((t) => t === 'TEXT_MESSAGE_START')).toHaveLength(1);
  });

  it('reports the model that ran, cools the failed one and counts the fallback', async () => {
    const { h } = throttledFirst();
    const events = await run(runBody(), h);

    expect(finished(events)).toMatchObject({ usage: [{ model: SONNET5 }] });
    expect(isCoolingDown(SONNET55)).toBe(true);
    expect(fallbackMetrics()).toStrictEqual([expect.objectContaining({
      Surface: 'chat', From: SONNET55, To: SONNET5, Reason: 'ThrottlingException', ModelFallback: 1,
    })]);
  });

  it('does not fall back on an input error', async () => {
    const h = harness([]);
    const tried = byModel(h, {
      [SONNET55]: () => failingStream(named('ValidationException', 'Input is too long for requested model.')),
    });
    const events = await run(runBody(), h);

    expect(tried).toStrictEqual([SONNET55]);
    expect(events.at(-1)).toMatchObject({ type: 'RUN_ERROR', code: 'service_error' });
    expect(isCoolingDown(SONNET55)).toBe(false);
    expect(fallbackMetrics()).toStrictEqual([]);
  });

  it('does not fall back once a token reached the client', async () => {
    const h = harness([]);
    const partial = bedrockEvents({ text: 'Customers are' }).slice(0, 2);
    const tried = byModel(h, { [SONNET55]: () => failingAfter(partial, named('ThrottlingException')) });
    const events = await run(runBody(), h);

    expect(tried).toStrictEqual([SONNET55]);
    expect(textOf(events)).toBe('Customers are');
    expect(events.at(-1)).toMatchObject({ type: 'RUN_ERROR', code: 'throttled' });
  });

  it('skips a cooling model on the next run without paying its failed attempt', async () => {
    const first = harness([]);
    byModel(first, { [SONNET55]: () => failingStream(named('ServiceUnavailableException')) });
    await run(runBody(), first);

    const second = harness([]);
    const tried = byModel(second, {});
    const events = await run(runBody(), second);
    expect(tried).toStrictEqual([SONNET5]);
    expect(finished(events)).toMatchObject({ usage: [{ model: SONNET5 }] });
    expect(fallbackMetrics().at(-1)).toMatchObject({ From: SONNET55, To: SONNET5, Reason: 'cooldown' });
  });

  it('raises the original error when every model fails', async () => {
    const h = harness([]);
    const chain = fallbackChain(SONNET55);
    const failing = Object.fromEntries(chain.map((model, i) => [
      model,
      () => failingStream(named(i === 0 ? 'ThrottlingException' : 'ServiceQuotaExceededException')),
    ]));
    const tried = byModel(h, failing);
    const events = await run(runBody(), h);

    expect(tried).toStrictEqual(chain);
    // 'throttled' is the FIRST model's error; a later one would map to service_error.
    expect(events.at(-1)).toMatchObject({ type: 'RUN_ERROR', code: 'throttled' });
  });

  it('stays on the fallback model for later tool rounds', async () => {
    const h = harness([]);
    const tried = byModel(h, { [SONNET55]: () => failingStream(named('ModelNotReadyException')) }, [
      { text: 'Let me look.', toolUses: [{ id: 'tu_1', name: 'search_feedback', input: { query: 'delivery' } }] },
      { text: 'Delivery is the top complaint.' },
    ]);
    const events = await run(runBody(), h);

    expect(tried).toStrictEqual([SONNET55, SONNET5, SONNET5]);
    expect(finished(events)).toMatchObject({ usage: [{ model: SONNET5 }] });
  });

  it('falls back from a configured Opus to the Sonnet chain', async () => {
    const h = harness([]);
    h.deps.resolveModel = async () => OPUS5;
    const tried = byModel(h, {
      [OPUS5]: () => failingStream(named('AccessDeniedException', "You don't have access to the model with the specified model ID.")),
    });
    const events = await run(runBody(), h);

    expect(tried).toStrictEqual([OPUS5, SONNET55]);
    expect(finished(events)).toMatchObject({ usage: [{ model: SONNET55 }] });
  });

  it('keeps the text-tail retry for a structural ValidationException on the same model', async () => {
    const h = harness([]);
    const attempts = { count: 0 };
    const tried: string[] = [];
    h.deps.converse = (params) => {
      tried.push(params.modelId ?? '');
      attempts.count += 1;
      return attempts.count === 1
        ? failingStream(named('ValidationException', 'Expected thinking block'))
        : streamOf(bedrockEvents({ text: 'ok' }));
    };
    const body = runBody({
      messages: [
        { id: 'u1', role: 'user', content: 'Search' },
        { id: 'a1', role: 'assistant', content: '', toolCalls: [{ id: 'tc1', type: 'function', function: { name: 'search_feedback', arguments: '{}' } }] },
        { id: 't1', role: 'tool', toolCallId: 'tc1', content: 'done' },
      ],
    });
    await run(body, h);
    expect(tried).toStrictEqual([SONNET55, SONNET55]);
  });
});
