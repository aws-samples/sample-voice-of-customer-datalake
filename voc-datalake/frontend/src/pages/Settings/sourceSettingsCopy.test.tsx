/**
 * Wave 4 copy findings, kept through 7.54.00: the Radar notes sent people to a "Scrapers page" the navigation no
 * longer has (it is "Data sources" since 5.x), and Administration's sources tab is called what its page is called.
 */
import { describe, it, expect } from 'vitest'
import i18n from 'i18next'

const say = (key: string, ns: string) => i18n.t(key, { ns })

describe('Administration → Data sources copy', () => {
  it('names the tab after its page, "Data sources" (no "Sources" / "Source settings" pair any longer)', () => {
    expect([say('tabs.sources', 'settings'), say('home.jobs.sources.title', 'settings')]).toStrictEqual(['Data sources', 'Data sources'])
  })

  it.each([
    ['setup.step2', 'radar'],
    ['empty.step2', 'radar'],
    ['card.openScraper', 'assistantTools'],
    ['card.openScrapers', 'assistantTools'],
    ['brands.hint', 'radar'],
    ['sourcesManager.radarLegacyHint', 'components'],
  ])('%s names the Data sources page, not the old Scrapers page', (key, ns) => {
    const text = say(key, ns)
    expect(text).toContain('Data sources page')
    expect(text).not.toContain('Scrapers page')
  })
})
