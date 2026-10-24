import { describe, expect, it } from 'vitest';
import { buildCatalogue } from '../tools/catalogue.js';
import { fakeDeps } from '../tools/test-fixtures.js';
import { catalogueArgsSchemaFor } from './catalogue-args.js';
import { errorKeys, PLAN_FIXTURES } from './plan-fixtures.js';
import { validatePlan, type PlanValidationContext } from './validate.js';

const argsSchemaFor = catalogueArgsSchemaFor(buildCatalogue(fakeDeps()));
const withSchemas = (ctx: Omit<PlanValidationContext, 'argsSchemaFor'>): PlanValidationContext => ({ ...ctx, argsSchemaFor });
const VALID = PLAN_FIXTURES.filter((fixture) => fixture.valid);
const INVALID = PLAN_FIXTURES.filter((fixture) => !fixture.valid);
const STRUCTURAL = INVALID.filter((fixture) => !fixture.needs_args_schema);
const LITERAL = INVALID.filter((fixture) => fixture.needs_args_schema);

describe('validatePlan over the shared fixtures', () => {
  it('loads the shared fixture set (positive control)', () => {
    expect(VALID.length).toBeGreaterThanOrEqual(2);
    expect(INVALID.length).toBeGreaterThanOrEqual(10);
  });

  it.each(VALID.map((fixture) => [fixture.name, fixture] as const))('accepts %s', (_name, fixture) => {
    expect(validatePlan(fixture.plan, withSchemas(fixture.ctx))).toMatchObject({ ok: true });
  });

  it.each(INVALID.map((fixture) => [fixture.name, fixture] as const))('rejects %s at the expected step and field', (_name, fixture) => {
    const result = validatePlan(fixture.plan, withSchemas(fixture.ctx));
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : errorKeys(result.errors)).toStrictEqual(expect.arrayContaining(fixture.errors));
  });

  it.each(STRUCTURAL.map((fixture) => [fixture.name, fixture] as const))('rejects %s without any tool schema too', (_name, fixture) => {
    expect(validatePlan(fixture.plan, fixture.ctx).ok).toBe(false);
  });

  it.each(LITERAL.map((fixture) => [fixture.name, fixture] as const))('needs the tool schema to reject %s', (_name, fixture) => {
    expect(validatePlan(fixture.plan, fixture.ctx).ok).toBe(true);
  });
});

describe('validatePlan details', () => {
  const example = PLAN_FIXTURES.find((fixture) => fixture.name === 'valid-example');

  it('returns the parsed plan on success', () => {
    const result = example === undefined ? undefined : validatePlan(example.plan, withSchemas(example.ctx));
    expect(result?.ok === true ? result.plan.steps.map((step) => step.id) : []).toHaveLength(11);
  });

  it('reports a non-object as a shape error without a step', () => {
    const result = validatePlan('not a plan', { isAdmin: true, packsAllowed: ['core'] });
    expect(result.ok ? [] : result.errors.map((error) => error.step)).toStrictEqual([undefined]);
  });

  it('refuses a plan whose text is not valid Unicode', () => {
    const plan = { schema: 'voc-plan/1', goal: 'bad \uD800 text', steps: [{ id: 's1', pack: 'core', kind: 'think', title: 'T', think: { brief: 'b' } }] };
    const result = validatePlan(plan, { isAdmin: true, packsAllowed: ['core'] });
    expect(result.ok ? '' : result.errors[0]?.message).toContain('Unicode');
  });

  it('allows a never-pre-approvable tool in a plan (it asks again at run time)', () => {
    const plan = {
      schema: 'voc-plan/1',
      goal: 'Remove the draft',
      steps: [{ id: 's1', pack: 'project', kind: 'write', title: 'Delete', write: { tool: 'delete_document', args: { project_id: 'p1', document_id: 'd1', reason: 'duplicate' } } }],
    };
    expect(validatePlan(plan, withSchemas({ isAdmin: false, packsAllowed: ['project'] })).ok).toBe(true);
  });
});
