/**
 * The words for one configured item, per kind. Live finding (wave 4): removing a web
 * review page from its Data sources card asked "Delete App … app configuration" —
 * the page's delete dialog used the app copy for every kind.
 */
import { describe, it, expect } from 'vitest'
import i18n from 'i18next'
import { appCopy } from './appCopy'

const say = (key: string) => i18n.t(key, { ns: 'scrapers' })

describe('appCopy', () => {
  it('names a web review page a page in its delete dialog', () => {
    const copy = appCopy('web_reviews')
    expect(say(copy.deleteTitle)).toBe('Remove review page')
    expect(say(copy.deleteMessage)).not.toMatch(/\bapp\b/i)
  })

  it('keeps the app words for the app-review connectors', () => {
    expect(say(appCopy('app_reviews_ios').deleteTitle)).toBe('Delete App')
  })
})
