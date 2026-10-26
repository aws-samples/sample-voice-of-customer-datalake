/**
 * "Radar source" on the Scrapers page's own editors (docs/radar.md): the custom scraper editor
 * and the Web Reviews / app connector dialog save the chosen brand as `radar_brand`, keep it on
 * an edit, and clear it to '' when unticked; a connector row names its brand in a badge.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { renderWithQueryClient } from '@test/query-client'
import { RADAR_BRANDS } from '@test/radarBrandFixtures'
import { fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { makeScraper, scrapersApiStubModule } from './scrapers-fixtures'
import PluginConfigModal from './PluginConfigModal'
import ScraperEditor from './ScraperEditor'
import type { PluginManifest } from '../../plugins/types'
import type { ScraperConfig } from '../../api/types'

const mockSaveAppConfig = vi.fn<(source: string, app: Record<string, string>) => Promise<unknown>>()

vi.mock('../../api/client', () => ({
  fetchApi: (endpoint: string, options?: RequestInit) => fetchApi(endpoint, options),
  api: {
    getAppConfigs: () => Promise.resolve({ apps: [{ id: 'w1', app_name: 'Trustpilot - Globex', url: 'https://www.trustpilot.com/review/globex.example', radar_brand: 'globex' }] }),
    saveAppConfig: (source: string, app: Record<string, string>) => mockSaveAppConfig(source, app),
    deleteAppConfig: () => Promise.resolve({ success: true }),
    getSourcesStatus: () => Promise.resolve({ sources: {} }),
    enableSource: () => Promise.resolve({ enabled: true }),
    disableSource: () => Promise.resolve({ enabled: false }),
    runSource: () => Promise.resolve({ success: true, message: '' }),
  },
}))
vi.mock('../../api/scrapersApi', async (importOriginal) => scrapersApiStubModule(importOriginal))


const WEB_REVIEWS: PluginManifest = {
  id: 'web_reviews', name: 'Web Reviews', icon: 'Globe', description: 'Review pages', category: 'reviews',
  config: [
    { key: 'app_name', label: 'Name', type: 'text', required: true, secret: false },
    { key: 'url', label: 'Review page URL', type: 'text', required: true, secret: false },
  ],
  hasIngestor: true, hasWebhook: false, hasS3Trigger: false, version: '1.0.0', enabled: true,
}

const radarBox = () => screen.getByRole('checkbox', { name: 'Radar source: reviews of another brand' })

beforeEach(() => {
  resetFetchApi()
  mockSaveAppConfig.mockReset()
  mockSaveAppConfig.mockResolvedValue({ success: true })
  routeFetchApi({ 'GET /radar/brands': () => ({ brands: RADAR_BRANDS }) })
})

function renderEditor(scraper: ScraperConfig | null) {
  const onSave = vi.fn<(scraper: ScraperConfig) => Promise<unknown>>().mockResolvedValue(undefined)
  renderWithQueryClient(<MemoryRouter><ScraperEditor scraper={scraper} isAdmin onSave={onSave} onClose={vi.fn()} /></MemoryRouter>)
  return { onSave, user: userEvent.setup() }
}

describe('ScraperEditor Radar source', () => {
  it('saves the chosen brand as radar_brand', async () => {
    const { onSave, user } = renderEditor(makeScraper({ base_url: 'https://reviews.example.com/acme' }))
    await user.click(radarBox())
    await user.selectOptions(await screen.findByLabelText('Radar brand'), 'acme')
    await user.click(screen.getByRole('button', { name: /save/i }))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ radar_brand: 'acme' }))
  })

  it('shows a stored brand and clears it when unticked', async () => {
    const { onSave, user } = renderEditor(makeScraper({ base_url: 'https://reviews.example.com/g', radar_brand: 'globex' }))
    expect(await screen.findByLabelText('Radar brand')).toHaveValue('globex')
    await user.click(radarBox())
    await user.click(screen.getByRole('button', { name: /save/i }))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ radar_brand: '' }))
  })

  it('leaves a new ordinary scraper without the field', async () => {
    const { onSave, user } = renderEditor(makeScraper({ base_url: 'https://reviews.example.com/ours' }))
    await user.click(screen.getByRole('button', { name: /save/i }))
    expect(onSave.mock.lastCall?.[0]).not.toHaveProperty('radar_brand')
  })
})

describe('Web Reviews / app connector dialog Radar source', () => {
  it('badges a connector row with its Radar brand label', async () => {
    renderWithQueryClient(<MemoryRouter><PluginConfigModal plugin={WEB_REVIEWS} isAdmin onClose={vi.fn()} /></MemoryRouter>)
    expect(await screen.findByText('Radar: Globex')).toBeInTheDocument()
  })

  it('keeps a stored brand on edit and saves a changed one', async () => {
    const user = userEvent.setup()
    renderWithQueryClient(<MemoryRouter><PluginConfigModal plugin={WEB_REVIEWS} isAdmin onClose={vi.fn()} /></MemoryRouter>)
    await user.click(await screen.findByRole('button', { name: 'Edit' }))
    expect(await screen.findByLabelText('Radar brand')).toHaveValue('globex')
    await user.selectOptions(screen.getByLabelText('Radar brand'), 'acme')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => { expect(mockSaveAppConfig).toHaveBeenCalledWith('web_reviews', expect.objectContaining({ id: 'w1', radar_brand: 'acme' })) })
  })

  it('saves a new page as a Radar source', async () => {
    const user = userEvent.setup()
    renderWithQueryClient(<MemoryRouter><PluginConfigModal plugin={WEB_REVIEWS} isAdmin onClose={vi.fn()} /></MemoryRouter>)
    await screen.findByText('Trustpilot - Globex')
    // "Add page" opens the form (and hides itself); the form's own "Add page" saves it.
    await user.click(screen.getByRole('button', { name: 'Add page' }))
    await user.type(screen.getByLabelText(/^Name/), 'Yelp - Acme')
    await user.type(screen.getByLabelText(/^Review page URL/), 'https://www.yelp.com/biz/acme')
    await user.click(radarBox())
    await user.selectOptions(await screen.findByLabelText('Radar brand'), 'acme')
    await user.click(screen.getByRole('button', { name: 'Add page' }))
    await waitFor(() => { expect(mockSaveAppConfig).toHaveBeenCalledWith('web_reviews', expect.objectContaining({ app_name: 'Yelp - Acme', radar_brand: 'acme' })) })
  })
})
