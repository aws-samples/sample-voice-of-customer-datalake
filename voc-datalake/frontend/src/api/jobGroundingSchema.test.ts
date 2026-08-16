/**
 * @fileoverview Tests for the job-grounding wire normalizer.
 *
 * The component tests in ProjectDetail/JobsSection.test.tsx cover this through
 * the rendered notice. These cover the parser directly, because the interesting
 * cases are boundary values that are tedious to reach through a component and
 * easy to get wrong here: what counts as a number, what counts as `true`, and
 * which combinations of counts are safe to show a user.
 */
import { describe, expect, it } from 'vitest'
import { hasUsableCounts, parseJobGrounding } from './jobGroundingSchema'

describe('parseJobGrounding', () => {
  it('reads well-formed metadata unchanged', () => {
    expect(parseJobGrounding({
      feedback_count: 300,
      feedback_items_used: 145,
      context_truncated: true,
      fetch_limit_reached: true,
      fetch_limit: 145,
    })).toStrictEqual({
      feedback_count: 300,
      feedback_items_used: 145,
      context_truncated: true,
      fetch_limit_reached: true,
      fetch_limit: 145,
    })
  })

  it('coerces counts that arrive as strings', () => {
    // Why this exists: a value persisted as a DynamoDB String round-trips as
    // "145". api/feedbackSchema.ts carries the same coercion for the same reason.
    const parsed = parseJobGrounding({ feedback_items_used: '145', feedback_count: '300' })
    expect(parsed.feedback_items_used).toBe(145)
    expect(parsed.feedback_count).toBe(300)
  })

  it.each([
    ['a non-numeric string', 'many'],
    ['an empty string', ''],
    ['null', null],
    ['a fraction', 1.5],
    ['a negative number', -1],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['an object', { n: 1 }],
    ['an array', []],
  ])('drops %s rather than rendering it as a count', (_label, value) => {
    expect(parseJobGrounding({ feedback_items_used: value }).feedback_items_used)
      .toBeUndefined()
  })

  it.each([
    ['true', true],
    ['false', false],
    ['a blank string', ' '],
    ['a tab', '\t'],
    ['an empty array', []],
  ])('drops %s, which Number() would silently accept', (_label, value) => {
    // Number(true) is 1, Number(' ') is 0, Number([]) is 0. Each would pass an
    // is-it-a-non-negative-integer check and render as a plausible count, so the
    // input type has to be narrowed before any coercion happens.
    expect(parseJobGrounding({ feedback_count: value }).feedback_count)
      .toBeUndefined()
  })

  it('keeps zero, which is a meaningful count', () => {
    // Distinct from "absent": zero items used is exactly the case a user most
    // needs told about, so it must not be filtered out with the junk.
    expect(parseJobGrounding({ feedback_items_used: 0 }).feedback_items_used).toBe(0)
  })

  it.each([
    ['the string "true"', 'true'],
    ['the string "false"', 'false'],
    ['the number 1', 1],
    ['the number 0', 0],
    ['null', null],
  ])('treats %s as no truncation claim', (_label, value) => {
    // A non-empty string is truthy in JavaScript, so a coercing read of "false"
    // would announce a loss that never happened on every completed job.
    expect(parseJobGrounding({ context_truncated: value }).context_truncated)
      .toBeUndefined()
  })

  it('accepts only a literal true as a truncation claim', () => {
    expect(parseJobGrounding({ context_truncated: true }).context_truncated).toBe(true)
    expect(parseJobGrounding({ context_truncated: false }).context_truncated)
      .toBeUndefined()
  })

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'truncated'],
    ['a number', 7],
    ['an array', [1, 2]],
  ])('returns an all-absent result for %s', (_label, value) => {
    const parsed = parseJobGrounding(value)
    expect(Object.values(parsed).every((v) => v === undefined)).toBe(true)
  })

  it('ignores unrelated keys instead of failing on them', () => {
    // The metadata block also carries source_breakdown and generation_time_ms,
    // which this parser has no interest in.
    const parsed = parseJobGrounding({
      feedback_items_used: 10,
      source_breakdown: { app_store: 4 },
      generation_time_ms: 12345,
    })
    expect(parsed.feedback_items_used).toBe(10)
  })
})

describe('hasUsableCounts', () => {
  it('accepts a pair where the used count fits the total', () => {
    expect(hasUsableCounts(parseJobGrounding({
      feedback_items_used: 145, feedback_count: 300,
    }))).toBe(true)
  })

  it('accepts an equal pair', () => {
    expect(hasUsableCounts(parseJobGrounding({
      feedback_items_used: 60, feedback_count: 60,
    }))).toBe(true)
  })

  it('rejects a pair claiming more was used than was read', () => {
    // Incoherent: it would tell the user more records reached the model than
    // were fetched. The count-free wording is the honest fallback.
    expect(hasUsableCounts(parseJobGrounding({
      feedback_items_used: 300, feedback_count: 145,
    }))).toBe(false)
  })

  it.each([
    ['the used count', { feedback_count: 300 }],
    ['the total', { feedback_items_used: 145 }],
    ['both', {}],
  ])('rejects metadata missing %s', (_label, metadata) => {
    expect(hasUsableCounts(parseJobGrounding(metadata))).toBe(false)
  })
})
