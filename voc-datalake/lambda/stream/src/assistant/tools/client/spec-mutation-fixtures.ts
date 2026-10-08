/**
 * Helpers for the client-tool mutation specs (imported by *.test.ts only): the
 * JSON-schema fragments a tool advertises to the model, spelled out literally,
 * and one-call wrappers over `validate()`.
 */
import { expect, it } from 'vitest';
import type { DocumentType } from '@smithy/types';
import type { ClientToolDefinition, ClientToolValidation } from '../../types.js';
import type { FakeContext } from '../test-fixtures.js';

/** Every tool description ends with the approval note; the tool's own text is what precedes it. */
const APPROVAL_NOTE_START = ' Requires the user\u2019s approval';

export const textProp = (description: string, maxLength: number) => ({ type: 'string', maxLength, description });
/** 128 = the id bound the model is told (spec.ts keeps its constant private, so the pin is literal). */
export const idProp = (description: string) => ({ type: 'string', maxLength: 128, description });
export const PROJECT_ID_PROP = idProp('Project id (defaults to the project on screen).');
export const idListProp = (description: string, maxItems: number) => ({ type: 'array', items: { type: 'string' }, maxItems, description });

interface ExpectedSpec {
  description: string;
  properties: Record<string, DocumentType>;
  required: string[];
}

/** The tool's Bedrock spec: its own description, then the exact input schema. */
export function expectSpec(tool: ClientToolDefinition, expected: ExpectedSpec): void {
  const spec = tool.spec.toolSpec;
  expect(spec?.description?.split(APPROVAL_NOTE_START)[0]).toBe(expected.description);
  expect(spec?.inputSchema).toStrictEqual({
    json: { type: 'object', properties: expected.properties, required: expected.required, additionalProperties: false },
  });
}

/** The normalised args of an accepted call, or the error of a refused one. */
export function outcome(result: ClientToolValidation): Record<string, unknown> | string {
  return result.ok ? result.args : result.error;
}

interface StringBound {
  base: Record<string, unknown>;
  field: string;
  max: number;
  /** Trimmed and non-empty (`z.string().trim().min(1)`), rather than free text. */
  trimmed: boolean;
}

/**
 * A string field bounded at `max`: a short value and `max` characters are fine,
 * `max + 1` is not. A trimmed field also drops surrounding blanks and refuses a blank value.
 */
export function expectStringBound(tool: ClientToolDefinition, ctx: FakeContext, bound: StringBound): void {
  const { base, field, max, trimmed } = bound;
  const ok = (value: string) => tool.validate({ ...base, [field]: value }, ctx).ok;
  expect(ok('Be brief')).toBe(true);
  expect(ok('x'.repeat(max))).toBe(true);
  expect(ok('x'.repeat(max + 1))).toBe(false);
  if (!trimmed) return;
  expect(outcome(tool.validate({ ...base, [field]: '  ab  ' }, ctx))).toMatchObject({ [field]: 'ab' });
  expect(ok('   ')).toBe(false);
}

/** `[tool, base args, field, max]` of one trimmed, bounded text field. */
export type TrimmedFieldCase = [string, Record<string, unknown>, string, number];

/**
 * One test per case (`expectStringBound` with `trimmed`). The lookup and the
 * context are read when each test runs, so a spec may load them in a hook.
 */
export function itTrimsAndBounds(
  cases: TrimmedFieldCase[],
  tool: (name: string) => ClientToolDefinition,
  ctx: () => FakeContext,
): void {
  it.each(cases)('%s %s', (name, base, field, max) => {
    expectStringBound(tool(name), ctx(), { base, field, max, trimmed: true });
  });
}

/** The approval-card summary of `args` after validation, or the refusal when they are invalid. */
export function summaryOf(tool: ClientToolDefinition, ctx: FakeContext, args: Record<string, unknown>): string {
  const result = tool.validate(args, ctx);
  return result.ok ? tool.summarize(result.args) : result.error;
}
