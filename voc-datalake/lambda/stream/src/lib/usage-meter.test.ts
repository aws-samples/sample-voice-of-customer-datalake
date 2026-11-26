/**
 * The stream Lambda's `bedrock_usage` line (lambda/shared/usage_meter.py's, field for field): one line per Converse
 * call and per ConverseStream turn, with the workspace the run acts in, so the daily cost rollup
 * (lambda/jobs/cost_rollup/handler.py) counts the assistant's calls too.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import {
  attributeFrom,
  currentAttribution,
  DEPLOYMENT,
  logBedrockUsage,
  resetAttribution,
  UNATTRIBUTED,
  USAGE_FIELDS,
  USAGE_LINE,
  usageLine,
} from './usage-meter.js';
import { WORKSPACE_ID } from './workspace-id.js';

const PYTHON = readFileSync(join(__dirname, '../../../shared/usage_meter.py'), 'utf8');
const pythonString = (name: string) => new RegExp(`^${name}: Final = '([^']+)'`, 'm').exec(PYTHON)?.[1];
const WS = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8';

beforeEach(() => resetAttribution());

describe("LOCKSTEP with lambda/shared/usage_meter.py (the rollup's one query reads both)", () => {
  it('names the line, its fields in order and the two non-workspace attributions as the Python meter does', () => {
    const fields = /^USAGE_FIELDS: Final = \(([^)]*)\)/m.exec(PYTHON)?.[1] ?? '';
    expect([...USAGE_FIELDS]).toStrictEqual([...fields.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]));
    expect([USAGE_LINE, DEPLOYMENT, UNATTRIBUTED]).toStrictEqual(
      [pythonString('USAGE_LINE'), pythonString('DEPLOYMENT'), pythonString('UNATTRIBUTED')]);
  });

  it("holds the workspace id's form to lambda/shared/workspace_ids.py WORKSPACE_ID_TEXT", () => {
    const ids = readFileSync(join(__dirname, '../../../shared/workspace_ids.py'), 'utf8');
    const text = /^WORKSPACE_ID_TEXT: Final = r'([^']+)'/m.exec(ids)?.[1];
    expect(WORKSPACE_ID.source).toBe(`^${text ?? ''}$`);
  });
});

describe('the attribution: the workspace the run acts in', () => {
  it('is unattributed until a run names its scope, and again after a reset', () => {
    expect(currentAttribution()).toBe(UNATTRIBUTED);
    attributeFrom({ 'voc:workspace': WS });
    expect(currentAttribution()).toBe(WS);
    resetAttribution();
    expect(currentAttribution()).toBe(UNATTRIBUTED);
  });

  it.each([
    [{}, DEPLOYMENT], [{ 'voc:workspace': '' }, DEPLOYMENT], [{ 'voc:workspace': '  ' }, DEPLOYMENT],
    [{ 'voc:workspace': WS }, WS], [{ 'voc:workspace': 'not-a-workspace' }, UNATTRIBUTED],
  ])('claims %j count to %s', (claims, expected) => {
    attributeFrom(claims);
    expect(currentAttribution()).toBe(expected);
  });
});

describe('the line', () => {
  it('carries the fields in order, the model id as sent and every token count (0 when absent)', () => {
    attributeFrom({ 'voc:workspace': WS });
    const line = usageLine('eu.anthropic.claude-sonnet-5-5', 'ConverseStream',
      { inputTokens: 1200, outputTokens: 300, cacheReadInputTokens: 50 });
    expect(Object.keys(line)).toStrictEqual(['message', ...USAGE_FIELDS]);
    expect(line).toStrictEqual({
      message: 'bedrock_usage', workspace_id: WS, model_id: 'eu.anthropic.claude-sonnet-5-5',
      operation: 'ConverseStream', service_tier: 'default', input_tokens: 1200, output_tokens: 300,
      cache_read_tokens: 50, cache_write_tokens: 0,
    });
  });

  it('logs one JSON line, never a prompt or an answer', () => {
    const log = vi.fn<(line: string) => void>();
    logBedrockUsage('global.anthropic.claude-haiku-5-5', 'Converse',
      { inputTokens: 10, outputTokens: 2, cacheWriteInputTokens: 4, totalTokens: 16 }, UNATTRIBUTED, log);
    expect(log).toHaveBeenCalledTimes(1);
    const parsed: unknown = JSON.parse(log.mock.calls[0]?.[0] ?? '');
    expect(parsed).toStrictEqual({
      message: 'bedrock_usage', workspace_id: UNATTRIBUTED, model_id: 'global.anthropic.claude-haiku-5-5',
      operation: 'Converse', service_tier: 'default', input_tokens: 10, output_tokens: 2, cache_read_tokens: 0,
      cache_write_tokens: 4,
    });
  });

  it('logs nothing for a call with no usage, and never throws into the call', () => {
    const log = vi.fn<(line: string) => void>();
    logBedrockUsage('global.anthropic.claude-haiku-5-5', 'Converse', undefined, UNATTRIBUTED, log);
    expect(log).not.toHaveBeenCalled();
    const throwing = () => { throw new Error('stdout closed'); };
    expect(() => logBedrockUsage('m', 'Converse', { inputTokens: 1 }, UNATTRIBUTED, throwing)).not.toThrow();
  });

  it('is one raw JSON line on stdout, no runtime prefix, so Logs Insights reads it as a Python line', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      logBedrockUsage('m', 'Converse', { inputTokens: 1 });
      const [chunk] = write.mock.calls[0] ?? [''];
      expect(typeof chunk === 'string' && chunk.endsWith('\n') && chunk.startsWith('{"message":"bedrock_usage"'))
        .toBe(true);
    } finally {
      write.mockRestore();
    }
  });

  it('counts a call to the attribution current when it started, not when it answered', () => {
    const log = vi.fn<(line: string) => void>();
    logBedrockUsage('m', 'Converse', { inputTokens: 1 }, WS, log);
    expect(JSON.parse(log.mock.calls[0]?.[0] ?? '')).toMatchObject({ workspace_id: WS });
  });
});
