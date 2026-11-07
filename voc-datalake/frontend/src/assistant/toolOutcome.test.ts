/**
 * The SPA's tool-outcome message names exactly the statuses the stream Lambda documents
 * (`TOOL_OUTCOME_STATUSES` in its contract), in the same order.
 */
import { describe, it, expect } from 'vitest'
import { TOOL_OUTCOME_STATUSES } from '@stream/assistant/contract'
import { toolOutcomeSchema } from './toolOutcome'

describe('toolOutcomeSchema', () => {
  it('has one variant per stream tool-outcome status', () => {
    expect(toolOutcomeSchema.options.map((option) => option.shape.status.value)).toStrictEqual([...TOOL_OUTCOME_STATUSES])
  })

  it('refuses a status the stream does not know', () => {
    expect(toolOutcomeSchema.safeParse({ status: 'skipped' }).success).toBe(false)
  })
})
