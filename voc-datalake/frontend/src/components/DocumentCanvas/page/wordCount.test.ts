/**
 * How long a document reads (wordCount.ts): the words a reader sees (no Markdown marks, link and image addresses,
 * fences or table rules), in the language's own words, and whole minutes at 200 a minute, at least one for any text.
 */
import { describe, expect, it } from 'vitest'
import { countWords, readingMinutes, WORDS_PER_MINUTE } from './wordCount'

describe('countWords', () => {
  it('counts the words a reader sees, not the Markdown around them', () => {
    const markdown = [
      '# The launch plan', '', '- **Ship** the _beta_', '> A quote here', '',
      'See [the brief](https://example.com/brief?x=1) and ![a chart](/c.png).', '',
      '```ts', 'const x = 1', '```', '', '| A | B |', '| --- | :-: |', '| one | two |', '---',
    ].join('\n')
    // The(1) launch plan · Ship the beta · A quote here · See the brief and a chart · const x 1 · A B · one two
    expect(countWords(markdown, 'en')).toBe(3 + 3 + 3 + 6 + 3 + 2 + 2)
  })

  it('counts nothing on an empty page, or one of Markdown marks only', () => {
    expect([countWords('', 'en'), countWords('#\n\n---\n> \n', 'en')]).toStrictEqual([0, 0])
  })

  it('counts the words of a language written without spaces', () => {
    expect(countWords('顧客の声を聞く', 'ja')).toBeGreaterThan(1)
  })
})

describe('readingMinutes', () => {
  it('is whole minutes at the pace, at least one for any text, none for none', () => {
    expect([0, 1, WORDS_PER_MINUTE, WORDS_PER_MINUTE * 2.6].map(readingMinutes)).toStrictEqual([0, 1, 1, 3])
  })
})
