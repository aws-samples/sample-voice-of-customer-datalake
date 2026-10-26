/**
 * The shared plan fixtures (`lambda/shared/test/fixtures/plans/*.json`), also
 * read by the SPA mirror's lockstep spec and by `test_plan_schema.py`. Loaded at
 * transform time by vitest (`import.meta.glob`), so no runtime fs access.
 */
import { z } from 'zod';
import { TOOL_PACKS } from '../contract.js';


const fixtureSchema = z.strictObject({
  description: z.string(),
  ctx: z.strictObject({ isAdmin: z.boolean(), packsAllowed: z.array(z.enum(TOOL_PACKS)) }),
  plan: z.unknown(),
  valid: z.boolean(),
  errors: z.array(z.strictObject({ step: z.string().optional(), field: z.string().optional() })),
  /** Only a validator given the tools' argument schemas can catch it (not Python). */
  needs_args_schema: z.boolean(),
});
export type PlanFixture = z.infer<typeof fixtureSchema> & { name: string };

const planFiles = import.meta.glob<unknown>('../../../../shared/test/fixtures/plans/*.json', { eager: true, import: 'default' });

export const PLAN_FIXTURES: readonly PlanFixture[] = Object.entries(planFiles).map(([file, content]) => ({
  ...fixtureSchema.parse(content),
  name: file.replace(/^.*\//, '').replace(/\.json$/, ''),
}));

const fingerprintSchema = z.strictObject({
  description: z.string(),
  cases: z.array(z.strictObject({ tool: z.string(), args: z.record(z.string(), z.unknown()), canonical: z.string(), sha256: z.string() })),
});

const fingerprintFiles = import.meta.glob<unknown>('../../../../shared/test/fixtures/plan-fingerprints.json', { eager: true, import: 'default' });

export const FINGERPRINT_CASES = Object.values(fingerprintFiles).flatMap((content) => fingerprintSchema.parse(content).cases);

/** `{step, field}` pairs of a validation result, for comparing with a fixture's expectation. */
export function errorKeys(errors: readonly { step?: string; field?: string }[]): { step?: string; field?: string }[] {
  return errors.map(({ step, field }) => ({ ...(step === undefined ? {} : { step }), ...(field === undefined ? {} : { field }) }));
}
