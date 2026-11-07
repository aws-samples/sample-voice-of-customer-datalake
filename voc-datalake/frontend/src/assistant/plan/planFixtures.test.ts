/**
 * The plan validator (`@stream/assistant/plan/validate`) given the SPA's own write-tool argument schemas
 * (`approvals/registry`) reaches each shared fixture's expected outcome
 * (`lambda/shared/test/fixtures/plans/`, also read by the stream and the Python tests). The fixtures marked
 * `needs_args_schema` are invalid only through an argument schema, so they check the SPA registry's schemas.
 */
import { describe, it, expect } from 'vitest'
import { errorKeys, PLAN_FIXTURES } from '@stream/assistant/plan/plan-fixtures'
import { validatePlan } from '@stream/assistant/plan/validate'
import { getWriteTool } from '../approvals/registry'

const argsSchemaFor = (tool: string) => getWriteTool(tool)?.argsSchema
const FIXTURE_CASES = PLAN_FIXTURES.map((fixture) => [fixture.name, fixture] as const)

describe('plan validation with the SPA tool schemas', () => {
  it('loads the shared fixture set (positive control)', () => {
    expect(PLAN_FIXTURES.filter((fixture) => !fixture.valid).length).toBeGreaterThanOrEqual(10)
    expect(PLAN_FIXTURES.some((fixture) => fixture.needs_args_schema)).toBe(true)
  })

  it.each(FIXTURE_CASES)('%s: gives the expected outcome', (_name, fixture) => {
    const result = validatePlan(fixture.plan, { ...fixture.ctx, argsSchemaFor })
    expect(result.ok).toBe(fixture.valid)
    expect(result.ok ? [] : errorKeys(result.errors)).toStrictEqual(expect.arrayContaining(fixture.errors))
  })
})
