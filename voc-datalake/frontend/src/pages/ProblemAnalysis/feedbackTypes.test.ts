/**
 * The review-type filter of Problem Analysis: the URL value, the chip toggles and the
 * `dims` value the server reads (`lambda/shared/item_filters.py`: `key:a|b`, `~unset`).
 */
import { describe, it, expect } from 'vitest'
import {
  FEEDBACK_TYPES, PROBLEM_TYPES, isAllTypes, isProblemsOnly, readTypeSelection, toggleType, typeSelectionDims,
  writeTypeSelection,
} from './feedbackTypes'

describe('the types URL value', () => {
  it('reads absent, empty and unreadable values as Problems only', () => {
    expect([readTypeSelection(null), readTypeSelection(''), readTypeSelection('nonsense,,')])
      .toStrictEqual([PROBLEM_TYPES, PROBLEM_TYPES, PROBLEM_TYPES])
  })

  it('reads `all` as every type', () => {
    expect(isAllTypes(readTypeSelection('all'))).toBe(true)
  })

  it('reads a comma list in display order, dropping unknown values and repeats', () => {
    expect(readTypeSelection('praise,bug,unknown,bug')).toStrictEqual(['bug', 'praise'])
  })

  it('writes the default as nothing, every type as `all` and a choice in display order', () => {
    expect([
      writeTypeSelection(PROBLEM_TYPES),
      writeTypeSelection([...FEEDBACK_TYPES].reverse()),
      writeTypeSelection(['question', 'bug']),
    ]).toStrictEqual([null, 'all', 'bug,question'])
  })

  it('reads back what it writes', () => {
    const choice = ['service_failure', 'feature_request', 'other'] as const
    expect(readTypeSelection(writeTypeSelection(choice))).toStrictEqual(choice)
  })
})

describe('the chips', () => {
  it('turns a type on and off, keeping display order', () => {
    const withPraise = toggleType(['bug'], 'praise')
    expect([withPraise, toggleType(withPraise, 'bug')]).toStrictEqual([['bug', 'praise'], ['praise']])
  })

  it('falls back to Problems only when the last type is turned off', () => {
    expect(isProblemsOnly(toggleType(['question'], 'question'))).toBe(true)
  })

  it('tells Problems only regardless of order', () => {
    expect([isProblemsOnly([...PROBLEM_TYPES].reverse()), isProblemsOnly(['bug'])]).toStrictEqual([true, false])
  })
})

describe('the dims value sent to the server', () => {
  it('sends Problems only as the six problem types plus untyped reviews', () => {
    expect(typeSelectionDims(PROBLEM_TYPES))
      .toBe('feedback_type:bug|service_failure|performance|usability|pricing_billing|support_experience|~unset')
  })

  it('always keeps untyped reviews in view, even for a single type', () => {
    expect(typeSelectionDims(['praise'])).toBe('feedback_type:praise|~unset')
  })

  it('sends no filter for every type', () => {
    expect(typeSelectionDims(FEEDBACK_TYPES)).toBeUndefined()
  })
})
