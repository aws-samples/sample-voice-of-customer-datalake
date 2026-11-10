/**
 * The review-type filter shared by Problem Analysis and Categories: the URL value (per-page
 * default), the pill clicks and the `dims` value the server reads
 * (`lambda/shared/item_filters.py`: `key:a|b`, `~unset`).
 */
import { describe, it, expect } from 'vitest'
import {
  ALL_TYPES, FEEDBACK_TYPES, PROBLEM_TYPES, isAllTypes, isProblemsOnly, pressedTypes,
  readTypeSelection, toggleType, typeCountsFrom, typeSelectionDims, writeTypeSelection,
} from './reviewTypeSelection'

describe('the types URL value', () => {
  it("reads absent, empty and unreadable values as the page's default", () => {
    expect([readTypeSelection(null, PROBLEM_TYPES), readTypeSelection('', ALL_TYPES), readTypeSelection('nonsense,,', PROBLEM_TYPES)])
      .toStrictEqual([PROBLEM_TYPES, ALL_TYPES, PROBLEM_TYPES])
  })

  it('reads `all` as no type filter on every page', () => {
    expect([readTypeSelection('all', PROBLEM_TYPES), readTypeSelection('all', ALL_TYPES)]).toStrictEqual([ALL_TYPES, ALL_TYPES])
  })

  it('reads a comma list in display order, dropping unknown values and repeats', () => {
    expect(readTypeSelection('praise,bug,unknown,bug', PROBLEM_TYPES)).toStrictEqual(['bug', 'praise'])
  })

  it('reads a list of every type as no type filter', () => {
    expect(readTypeSelection(FEEDBACK_TYPES.join(','), PROBLEM_TYPES)).toStrictEqual(ALL_TYPES)
  })

  it("writes the page's default as nothing, no filter as `all` (where the default is a filter) and a choice in display order", () => {
    expect([
      writeTypeSelection(PROBLEM_TYPES, PROBLEM_TYPES),
      writeTypeSelection(ALL_TYPES, PROBLEM_TYPES),
      writeTypeSelection([...FEEDBACK_TYPES].reverse(), PROBLEM_TYPES),
      writeTypeSelection(ALL_TYPES, ALL_TYPES),
      writeTypeSelection(PROBLEM_TYPES, ALL_TYPES),
      writeTypeSelection(['question', 'bug'], ALL_TYPES),
    ]).toStrictEqual([null, 'all', 'all', null, PROBLEM_TYPES.join(','), 'bug,question'])
  })

  it('reads back what it writes', () => {
    const choice = ['service_failure', 'feature_request', 'other'] as const
    expect([
      readTypeSelection(writeTypeSelection(choice, PROBLEM_TYPES), PROBLEM_TYPES),
      readTypeSelection(writeTypeSelection(ALL_TYPES, PROBLEM_TYPES), PROBLEM_TYPES),
      readTypeSelection(writeTypeSelection(PROBLEM_TYPES, ALL_TYPES), ALL_TYPES),
    ]).toStrictEqual([choice, ALL_TYPES, PROBLEM_TYPES])
  })
})

describe('the pills', () => {
  it('selects only the clicked type while Problems only shows', () => {
    expect(toggleType(PROBLEM_TYPES, 'feature_request')).toStrictEqual(['feature_request'])
  })

  it('selects only the clicked type when no type is pressed', () => {
    expect(toggleType(ALL_TYPES, 'praise')).toStrictEqual(['praise'])
  })

  it('adds and removes a type on later clicks, keeping display order', () => {
    const withBug = toggleType(['praise'], 'bug')
    expect([withBug, toggleType(withBug, 'praise')]).toStrictEqual([['bug', 'praise'], ['bug']])
  })

  it('goes back to no type filter when the last pill is turned off, not to Problems only', () => {
    expect(toggleType(['question'], 'question')).toStrictEqual(ALL_TYPES)
  })

  it('treats every type pressed one by one as no filter, with no pill pressed', () => {
    const allButOne = FEEDBACK_TYPES.filter((type) => type !== 'other')
    expect([toggleType(allButOne, 'other'), pressedTypes(FEEDBACK_TYPES)]).toStrictEqual([ALL_TYPES, ALL_TYPES])
  })

  it('tells Problems only and no filter regardless of order', () => {
    expect([
      isProblemsOnly([...PROBLEM_TYPES].reverse()), isProblemsOnly(['bug']),
      isAllTypes(ALL_TYPES), isAllTypes(FEEDBACK_TYPES), isAllTypes(['bug']),
    ]).toStrictEqual([true, false, true, true, false])
  })

  it('reads only the built-in type values (case and the untyped marker are not types)', () => {
    expect(['bug', 'Bug', '~unset'].map((raw) => readTypeSelection(raw, ALL_TYPES))).toStrictEqual([['bug'], ALL_TYPES, ALL_TYPES])
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

  it('sends no filter when no pill is pressed or every type is', () => {
    expect([typeSelectionDims(ALL_TYPES), typeSelectionDims(FEEDBACK_TYPES)]).toStrictEqual([undefined, undefined])
  })
})

describe('the pill counts from a window', () => {
  it('counts each type and the reviews no type covers', () => {
    expect(typeCountsFrom({ bug: 4, praise: 1 }, 12)).toStrictEqual({ bug: 4, praise: 1, untyped: 7 })
  })

  it('counts every review as untyped when nothing is typed', () => {
    expect(typeCountsFrom({}, 17085)).toStrictEqual({ untyped: 17085 })
  })

  it('shows no pill for a value outside the built-in types, and never counts it as untyped', () => {
    expect(typeCountsFrom({ legacy_value: 3, bug: 2 }, 5)).toStrictEqual({ bug: 2, untyped: 0 })
  })

  it('never goes below zero when the counts run ahead of the total', () => {
    expect(typeCountsFrom({ bug: 9 }, 5)).toStrictEqual({ bug: 9, untyped: 0 })
  })
})
