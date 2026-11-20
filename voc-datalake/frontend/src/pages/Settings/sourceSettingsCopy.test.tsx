/**
 * Wave 4 copy findings: the Radar notes sent people to a "Scrapers page" the navigation no longer has (it is "Data
 * sources" since 5.x). Administration's sources tab has main's names again (7.59.00): the tab "Sources", its cards'
 * section "Source settings", so neither reads as the sidebar's "Data sources" page.
 */
import { describe, it, expect } from 'vitest'
import i18n from 'i18next'

const say = (key: string, ns: string) => i18n.t(key, { ns })

describe('Administration → Sources copy', () => {
  it('names the tab and its cards\' section with main\'s names, "Sources" and "Source settings"', () => {
    expect([say('tabs.sources', 'settings'), say('sections.plugins', 'settings')]).toStrictEqual(['Sources', 'Source settings'])
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
