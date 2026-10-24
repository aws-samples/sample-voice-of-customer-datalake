/**
 * Mutation-hardening suite for `spec.ts`. The catalogue specs only ever
 * exercised the happy path of the id schema and the input parser, so a run
 * found the anchors and quantifier of the id charset, the trim and both length
 * bounds, the five-issue cap and `.`/`; ` joins of `describeIssues`, the
 * `input ?? {}` default and the explicit-over-page-default order of
 * `resolveId` all unobserved. Each case below pins the exact value.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AssistantToolError } from './errors.js';
import { describeIssues, idProperty, idSchema, parseToolInput, resolveId, toolSpec } from './spec.js';

/** The tool error `run` throws, as `{ code, message }`. */
function thrownBy(run: () => unknown): { code: string; message: string } {
  try {
    run();
  } catch (error) {
    if (error instanceof AssistantToolError) return { code: error.code, message: error.message };
    throw error;
  }
  throw new TypeError('expected an AssistantToolError');
}

function issue(path: string[], message: string): z.core.$ZodIssue {
  return { code: 'custom', path, message, input: undefined };
}

describe('toolSpec', () => {
  it('builds a closed object schema with no required argument by default', () => {
    expect(toolSpec('a_tool', 'Does a.', { x: { type: 'string' } })).toStrictEqual({
      toolSpec: {
        name: 'a_tool',
        description: 'Does a.',
        inputSchema: { json: { type: 'object', properties: { x: { type: 'string' } }, required: [], additionalProperties: false } },
      },
    });
  });

  it('copies the required names into a fresh array', () => {
    const required = ['x'] as const;
    const json = Object(toolSpec('a_tool', 'Does a.', {}, required).toolSpec?.inputSchema?.json);
    expect(Reflect.get(json, 'required')).toStrictEqual(['x']);
    expect(Reflect.get(json, 'required')).not.toBe(required);
  });
});

describe('idSchema and idProperty', () => {
  it.each([
    ['Proj_1.a:b-c', 'Proj_1.a:b-c'],
    ['  padded  ', 'padded'],
    ['a', 'a'],
    ['x'.repeat(128), 'x'.repeat(128)],
  ])('accepts %j as %j', (raw, parsed) => {
    expect(idSchema.safeParse(raw)).toStrictEqual({ success: true, data: parsed });
  });

  it.each(['', '   ', '!abc', 'abc!', 'a b', '!', 'x'.repeat(129)])('rejects %j', (raw) => {
    expect(idSchema.safeParse(raw).success).toBe(false);
  });

  it('names the charset rule in the refusal', () => {
    expect(thrownBy(() => parseToolInput(z.object({ id: idSchema }), { id: 'a/b' }))).toStrictEqual({
      code: 'invalid_input',
      message: 'Invalid arguments — id: must be a plain identifier',
    });
  });

  it('describes an id argument as a bounded string', () => {
    expect(idProperty('Form id.')).toStrictEqual({ type: 'string', maxLength: 128, description: 'Form id.' });
  });
});

describe('describeIssues', () => {
  it('prefixes a dotted path, leaves a root issue bare and joins with "; "', () => {
    const error = new z.ZodError([issue(['a', 'b'], 'nested'), issue([], 'root')]);
    expect(describeIssues(error)).toBe('a.b: nested; root');
  });

  it('lists only the first five issues', () => {
    const error = new z.ZodError(['1', '2', '3', '4', '5', '6'].map((n) => issue([`f${n}`], `m${n}`)));
    expect(describeIssues(error)).toBe('f1: m1; f2: m2; f3: m3; f4: m4; f5: m5');
  });
});

describe('parseToolInput', () => {
  it.each([undefined, null])('parses %j as an empty object', (input) => {
    expect(parseToolInput(z.object({}).strict(), input)).toStrictEqual({});
  });

  it('returns the parsed data', () => {
    expect(parseToolInput(z.object({ n: z.number() }), { n: 3 })).toStrictEqual({ n: 3 });
  });
});

describe('resolveId', () => {
  it.each([
    ['explicit', 'page', 'explicit'],
    [undefined, ' page ', 'page'],
  ])('explicit %j over page default %j gives %j', (explicit, pageDefault, expected) => {
    expect(resolveId(explicit, pageDefault, 'project_id')).toBe(expected);
  });

  it('names the argument when neither is given', () => {
    expect(thrownBy(() => resolveId(undefined, undefined, 'project_id'))).toStrictEqual({
      code: 'invalid_input',
      message: 'Missing project_id: none was given and the current page has no default.',
    });
  });

  it('refuses an id outside the charset', () => {
    expect(thrownBy(() => resolveId('a/b', 'ok', 'form_id'))).toStrictEqual({
      code: 'invalid_input',
      message: 'Invalid form_id.',
    });
  });
});
