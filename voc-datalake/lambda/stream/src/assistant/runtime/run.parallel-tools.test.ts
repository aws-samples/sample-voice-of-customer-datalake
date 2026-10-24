/**
 * Server tools of one turn run concurrently (QA perf track), bounded, and are
 * still answered in CALL order.
 *
 * `latch(n)` only resolves once `n` executes are in flight, so a serial loop
 * never reaches the second call and the run times out — the test fails with
 * the concurrent execution reverted.
 */
import { describe, it, expect } from 'vitest';
import type { ContentBlock } from '@aws-sdk/client-bedrock-runtime';
import type { ServerToolName } from '../contract.js';
import type { ServerToolDefinition, ServerToolResult } from '../types.js';
import { nth } from '../../lib/nth-fixtures.js';
import { fakeServerTool, fakeToolset, runBody } from './__fixtures__/fakes.js';
import { finished, harness, lastUserContent, run, silenceConsole, type Harness } from './__fixtures__/harness.js';
import { MAX_PARALLEL_SERVER_TOOLS } from './tool-calls.js';

silenceConsole();

const LATCH_TIMEOUT_MS = 2000;

/** Two calls with the ids the order assertions name. */
const PAIR = [{ id: 'tu_a', name: 'get_metrics' }, { id: 'tu_b', name: 'list_projects' }] as const;

/** Resolves for every waiter once `n` have arrived; rejects after a timeout. */
function latch(n: number): () => Promise<void> {
  const arrived = { count: 0 };
  const waiters: (() => void)[] = [];
  return () => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`only ${String(arrived.count)} of ${String(n)} tool calls were in flight together`));
    }, LATCH_TIMEOUT_MS);
    arrived.count += 1;
    waiters.push(() => {
      clearTimeout(timer);
      resolve();
    });
    if (arrived.count >= n) for (const wake of waiters) wake();
  });
}

function textOf(block: ContentBlock | undefined): string | undefined {
  const first = block?.toolResult?.content?.[0];
  return first && 'text' in first ? first.text : undefined;
}

/** One turn calling `calls` (ids tu_0, tu_1, … unless given), then a plain answer. */
function toolTurnHarness(calls: readonly (ServerToolName | { id: string; name: ServerToolName })[], tools: ServerToolDefinition[]): Harness {
  const toolUses = calls.map((call, i) => (typeof call === 'string' ? { id: `tu_${String(i)}`, name: call } : call));
  return harness([
    { toolUses: toolUses.map((use) => ({ ...use, input: {} })) },
    { text: 'done' },
  ], fakeToolset(tools));
}

describe('runAssistant — server tools in one turn', () => {
  it('executes independent server tools concurrently', async () => {
    const together = latch(3);
    const names: ServerToolName[] = ['get_metrics', 'list_projects', 'list_categories'];
    const tools = names.map((name) => fakeServerTool(name, async (): Promise<ServerToolResult> => {
      await together();
      return { content: `${name} ok` };
    }));
    const h = toolTurnHarness(names, tools);

    const events = await run(runBody(), h);

    expect(finished(events)).toMatchObject({ outcome: { type: 'success' } });
    expect(lastUserContent(nth(h.calls, 1)).map(textOf)).toStrictEqual(['get_metrics ok', 'list_projects ok', 'list_categories ok']);
  });

  it('answers in call order even when a later call finishes first', async () => {
    const slow = fakeServerTool('get_metrics', async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { content: 'slow', sources: [{ feedback_id: 'f-slow', text: 's' }] };
    });
    const fast = fakeServerTool('list_projects', async () => ({ content: 'fast', sources: [{ feedback_id: 'f-fast', text: 'f' }] }));
    const h = toolTurnHarness(PAIR, [slow, fast]);

    const events = await run(runBody(), h);

    const results = lastUserContent(nth(h.calls, 1));
    expect(results.map((b) => b.toolResult?.toolUseId)).toStrictEqual(['tu_a', 'tu_b']);
    expect(events.filter((e) => e.type === 'TOOL_CALL_RESULT').map((e) => e.toolCallId)).toStrictEqual(['tu_a', 'tu_b']);
    expect(events.find((e) => e.name === 'assistant.sources')).toMatchObject({
      value: { feedback: [{ feedback_id: 'f-slow' }, { feedback_id: 'f-fast' }] },
    });
    // Every call's START precedes its own RESULT.
    for (const id of ['tu_a', 'tu_b']) {
      const start = events.findIndex((e) => e.type === 'TOOL_CALL_START' && e.toolCallId === id);
      const result = events.findIndex((e) => e.type === 'TOOL_CALL_RESULT' && e.toolCallId === id);
      expect(start).toBeLessThan(result);
    }
  });

  it('keeps one failing tool from affecting the others', async () => {
    const failing = fakeServerTool('get_metrics', async () => {
      throw new Error('boom');
    });
    const ok = fakeServerTool('list_projects', async () => ({ content: 'fine' }));
    const h = toolTurnHarness(PAIR, [failing, ok]);

    await run(runBody(), h);

    const [first, second] = lastUserContent(nth(h.calls, 1));
    expect(first?.toolResult?.status).toBe('error');
    expect(textOf(second)).toBe('fine');
  });

  it(`runs at most ${String(MAX_PARALLEL_SERVER_TOOLS)} at once`, async () => {
    const live = { now: 0, peak: 0 };
    const names: ServerToolName[] = ['get_metrics', 'list_projects', 'list_categories', 'search_memory', 'get_feedback_item', 'get_project'];
    const tools = names.map((name) => fakeServerTool(name, async () => {
      live.now += 1;
      live.peak = Math.max(live.peak, live.now);
      await new Promise((resolve) => setTimeout(resolve, 5));
      live.now -= 1;
      return { content: name };
    }));
    const h = toolTurnHarness(names, tools);

    await run(runBody(), h);

    expect(live.peak).toBe(MAX_PARALLEL_SERVER_TOOLS);
    expect(lastUserContent(nth(h.calls, 1)).map(textOf)).toStrictEqual(names);
  });
});
