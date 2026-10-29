import { describe, expect, it } from 'vitest'
import { cleanFeedbackText, cleanReviewText } from './cleanReviewText'
import { languageName } from './languageName'
import cleanupCases from '../../../schemas/review-text-cleanup-cases.json'

describe('cleanReviewText', () => {
  // The cases the Web Reviews ingestor and the assistant pin too: one rule set, three places.
  it.each(cleanupCases.cases)('reads "$input" as plain text', ({ input, output }) => {
    expect(cleanReviewText(input)).toBe(output)
  })

  it('gives two sentences an escaped full stop glued together their space back', () => {
    expect(cleanReviewText('a stressful situation\\.On the next day')).toBe('a stressful situation. On the next day')
  })

  it('drops markdown escapes and bold markers', () => {
    expect(cleanReviewText('**Great** app\\. 5\\* support\\! a\\-b')).toBe('Great app. 5* support! a-b')
  })

  it('keeps a backslash that escapes nothing and plain text as is', () => {
    expect(cleanReviewText('C:\\temp and 3 * 4')).toBe('C:\\temp and 3 * 4')
  })

  it('cleans every customer-text field of an item without changing the item', () => {
    const item = { original_text: 'a\\.', title: '**T**', problem_summary: undefined }
    expect(cleanFeedbackText(item)).toMatchObject({ original_text: 'a.', title: 'T', problem_summary: undefined })
    expect(item.original_text).toBe('a\\.')
  })
})

describe('languageName', () => {
  it('names a code in the reader language and falls back to the code', () => {
    expect([languageName('en', 'en'), languageName('es', 'en'), languageName('not a code!', 'en')])
      .toStrictEqual(['English', 'Spanish', 'not a code!'])
  })
})
