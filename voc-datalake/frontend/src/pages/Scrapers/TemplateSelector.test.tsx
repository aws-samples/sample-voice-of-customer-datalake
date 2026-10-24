/**
 * Web scraper templates are admin-only (owner decision 2026-10-08: `POST /scrapers`
 * is admin-gated), and so is importing data (owner decision 2026-10-08, #242
 * follow-up: `/scrapers/manual/*` and `/s3-import/*`): the paste / JSON / CSV tiles
 * and the S3 import plugin tile are disabled for a non-admin. App sources stay open.
 *
 * "Add Data Source" lists only plugins that are deployed. A plugin switched off
 * in `pluginStatus` (GitHub Issues on production 2.13.00) has no ingestor, yet
 * its tile was offered and opened a config dialog that 400'd (QA s1).
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import i18n from 'i18next'
import { ADMIN_ONLY_TITLE } from '../../constants/admin'
import { at } from '@test/defined'
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
  { ...base, id: 's3_import', name: 'S3 Bulk Import', enabled: true, category: 'import', hasS3Trigger: true },
]

vi.mock('../../plugins', () => ({
  getPluginManifests: () => manifests,
  getSyntheticPlugins: () => [],
}))
vi.mock('../../api/scrapersApi', () => ({ scrapersApi: { getScraperTemplates: () => Promise.resolve({ templates: [] }) } }))
vi.mock('../../store/configStore', () => ({ useConfigStore: () => ({ config: { apiEndpoint: '' } }) }))

function renderSelector(isAdmin = true) {
  const onSelect = vi.fn()
  const onSelectPlugin = vi.fn()
  const onManualImport = vi.fn()
  const onJsonUpload = vi.fn()
  const onCsvUpload = vi.fn()
  render(
    <TemplateSelector isAdmin={isAdmin} onSelect={onSelect} onSelectPlugin={onSelectPlugin} onSelectGenerator={vi.fn()} onManualImport={onManualImport} onJsonUpload={onJsonUpload} onCsvUpload={onCsvUpload} onClose={vi.fn()} />,
    { wrapper: createQueryWrapper() },
  )
  return { onSelect, onSelectPlugin, onManualImport, onJsonUpload, onCsvUpload }
}

const tr = (key: string) => i18n.t(key, { ns: 'scrapers' })

/** How often each import callback fired. */
function callCounts(calls: ReturnType<typeof renderSelector>) {
  return {
    manual: calls.onManualImport.mock.calls.length,
    json: calls.onJsonUpload.mock.calls.length,
    csv: calls.onCsvUpload.mock.calls.length,
    plugin: calls.onSelectPlugin.mock.calls.length,
  }
}

/** The two built-in scraper template tiles: the plain custom scraper and the CSS one (under Advanced). */
const scraperTemplateTiles = () => [
  screen.getByRole('button', { name: /Custom scraper/ }),
  screen.getByRole('button', { name: /Scraper with CSS selectors/ }),
]
/** Paste, JSON upload, CSV upload, and the S3 import plugin. */
const importTiles = () => [
  screen.getByRole('button', { name: /Paste reviews/ }),
  screen.getByRole('button', { name: /^JSON file/ }),
  screen.getByRole('button', { name: /Spreadsheet \(CSV\)/ }),
  screen.getByRole('button', { name: /Many files at once \(S3\)/ }),
]
const ADMIN_NOTE = tr('templateSelector.scrapersAdminOnly')
const IMPORTS_NOTE = tr('templateSelector.importsAdminOnly')

describe('TemplateSelector scraper templates are admin-only', () => {
  it('disables every scraper template for a non-admin, explains why, and selects nothing', async () => {
    const user = userEvent.setup()
    const { onSelect } = renderSelector(false)

    for (const tile of scraperTemplateTiles()) {
      expect(tile).toBeDisabled()
      expect(tile).toHaveAttribute('title', ADMIN_ONLY_TITLE)
      await user.click(tile)
    }
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('tells a non-admin why the scraper templates are disabled', () => {
    renderSelector(false)

    expect(ADMIN_NOTE).not.toContain('templateSelector.')
    expect(screen.getAllByText(ADMIN_NOTE).length).toBeGreaterThan(0)
  })

  it('leaves the app-source plugin tiles usable for a non-admin', async () => {
    const user = userEvent.setup()
    const { onSelectPlugin } = renderSelector(false)

    await user.click(screen.getByRole('button', { name: /iPhone app \(App Store\)/ }))
    expect(onSelectPlugin).toHaveBeenCalledTimes(1)
  })

  it('the control: an admin selects a scraper template, with no note', async () => {
    const user = userEvent.setup()
    const { onSelect } = renderSelector(true)

    for (const tile of scraperTemplateTiles()) expect(tile).toBeEnabled()
    await user.click(at(scraperTemplateTiles(), 0))
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(screen.queryByText(ADMIN_NOTE)).not.toBeInTheDocument()
  })
})

describe('TemplateSelector imports are admin-only', () => {
  it('disables paste, JSON, CSV and S3 import for a non-admin and opens none of them', async () => {
    const user = userEvent.setup()
    const calls = renderSelector(false)

    for (const tile of importTiles()) {
      expect(tile).toBeDisabled()
      expect(tile).toHaveAttribute('title', ADMIN_ONLY_TITLE)
      await user.click(tile)
    }
    expect(callCounts(calls)).toStrictEqual({ manual: 0, json: 0, csv: 0, plugin: 0 })
  })

  it('tells a non-admin why the import tiles are disabled', () => {
    renderSelector(false)

    expect(IMPORTS_NOTE).not.toContain('templateSelector.')
    expect(screen.getAllByText(IMPORTS_NOTE).length).toBeGreaterThan(0)
  })

  it('the control: an admin opens each import, with no note', async () => {
    const user = userEvent.setup()
    const calls = renderSelector(true)

    for (const tile of importTiles()) {
      expect(tile).toBeEnabled()
      await user.click(tile)
    }
    expect(callCounts(calls)).toStrictEqual({ manual: 1, json: 1, csv: 1, plugin: 1 })
    expect(calls.onSelectPlugin).toHaveBeenCalledWith(expect.objectContaining({ id: 's3_import' }))
    expect(screen.queryByText(IMPORTS_NOTE)).not.toBeInTheDocument()
  })
})

describe('TemplateSelector plugin tiles', () => {
  it('offers an enabled plugin', () => {
    renderSelector()
    expect(screen.getByRole('button', { name: /iPhone app \(App Store\)/ })).toBeInTheDocument()
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

// Live finding: eleven flat tiles named after how the platform reads them. The menu now
// asks what the person has, and keeps the technical options under a collapsed Advanced.
describe('TemplateSelector groups sources by what you have', () => {
  it('orders the groups website, app, file, paste, then a collapsed Advanced', () => {
    renderSelector()

    const headings = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)
    expect(headings.slice(0, 4)).toStrictEqual(['A website link', 'An app', 'A file', 'Paste text'])
    const advanced = screen.getByText('Advanced').closest('details')
    expect(advanced).not.toHaveAttribute('open')
    expect(advanced).toContainElement(screen.getByRole('button', { name: /Scraper with CSS selectors/ }))
  })

  it('puts the custom scraper under "A website link" and the files under "A file"', () => {
    renderSelector()

    const section = (title: string) => screen.getByRole('heading', { name: title }).closest('section')
    expect(section('A website link')).toContainElement(screen.getByRole('button', { name: /Custom scraper/ }))
    expect(section('A file')).toContainElement(screen.getByRole('button', { name: /Many files at once/ }))
  })
})
