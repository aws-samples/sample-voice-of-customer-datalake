/**
 * "Add Data Source" lists only plugins that are deployed. A plugin switched off
 * in `pluginStatus` (GitHub Issues on production 2.13.00) has no ingestor, yet
 * its tile was offered and opened a config dialog that 400'd (QA s1).
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { createQueryWrapper } from '../Categories/categories-fixtures'
import TemplateSelector from './TemplateSelector'
import type { PluginManifest } from '../../plugins/types'

const base: Omit<PluginManifest, 'id' | 'name' | 'enabled'> = {
  icon: 'Box', description: 'A source', category: 'reviews', config: [],
  hasIngestor: true, hasWebhook: false, hasS3Trigger: false, version: '1.0.0',
}

const manifests: PluginManifest[] = [
  { ...base, id: 'app_reviews_ios', name: 'iOS App Reviews', enabled: true },
  { ...base, id: 'github_issues', name: 'GitHub Issues', enabled: false },
  { ...base, id: 'webscraper', name: 'Web Scraper', enabled: true, category: 'import' },
]

vi.mock('../../plugins', () => ({
  getPluginManifests: () => manifests,
  getSyntheticPlugins: () => [],
}))
vi.mock('../../api/scrapersApi', () => ({ scrapersApi: { getScraperTemplates: () => Promise.resolve({ templates: [] }) } }))
vi.mock('../../store/configStore', () => ({ useConfigStore: () => ({ config: { apiEndpoint: '' } }) }))

function renderSelector() {
  const noop = vi.fn()
  render(
    <TemplateSelector onSelect={noop} onSelectPlugin={noop} onSelectGenerator={noop} onManualImport={noop} onJsonUpload={noop} onCsvUpload={noop} onClose={noop} />,
    { wrapper: createQueryWrapper() },
  )
}

describe('TemplateSelector plugin tiles', () => {
  it('offers an enabled plugin', () => {
    renderSelector()
    expect(screen.getByRole('button', { name: /iOS App Reviews/ })).toBeInTheDocument()
  })

  it('does not offer a disabled plugin', () => {
    renderSelector()
    expect(screen.queryByRole('button', { name: /GitHub Issues/ })).not.toBeInTheDocument()
  })

  it('keeps the web scraper out of the plugin tiles (it has its own templates)', () => {
    renderSelector()
    expect(screen.queryByRole('button', { name: /^Web Scraper/ })).not.toBeInTheDocument()
  })
})
