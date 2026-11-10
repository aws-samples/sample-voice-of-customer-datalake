/**
 * Wave 4 copy findings: the Sources tab opened under the heading "Data Sources &
 * Integrations" while its section switch said "Source settings", and the Radar
 * notes sent people to a "Scrapers page" the navigation no longer has (it is
 * "Data sources" since 5.x).
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import i18n from 'i18next'
import { DataSourcesSection } from './SettingsSections'
import { resolveAdminLocation } from './adminTabs'

vi.mock('../../plugins', () => ({ getEnabledPlugins: () => [] }))

const say = (key: string, ns: string) => i18n.t(key, { ns })

describe('Administration → Sources copy', () => {
  it('heads the section with its own name, "Source settings"', () => {
    render(<DataSourcesSection apiEndpoint="" isAdmin />)
    expect(screen.getByRole('heading', { level: 2, name: say('sections.plugins', 'settings') })).toHaveTextContent('Source settings')
  })

  it('opens ?tab=sources on that section', () => {
    expect(resolveAdminLocation('sources', null, true)).toStrictEqual({ tab: 'sources', section: 'plugins' })
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

  // verify5/V6: de "Datenquellen-Zeitpläne aktivieren/deaktivieren" overflowed at 390 px / 200 %.
  it('lets the section description break long words', () => {
    render(<DataSourcesSection apiEndpoint="" isAdmin />)
    expect(screen.getByTestId('data-sources-description')).toHaveClass('hyphens-auto', '[overflow-wrap:break-word]')
  })
})
