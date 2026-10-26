import { describe, expect, it } from 'vitest'
import { cleanFeedbackText, cleanReviewText } from './cleanReviewText'
import { languageName } from './languageName'

describe('cleanReviewText', () => {
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
