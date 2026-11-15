/**
 * "Amazon Bedrock web search index" in Add a data source: a review page (web_reviews) read from Bedrock's index
 * instead of the browser, for sites that block automated browsers. Its tile opens the review page form with
 * `method: "bedrock_web_search"` preset (never a field), and the saved card says how it is read.
 *
 * Offered only once the deployed web_reviews manifest declares the `method` field: until then the API keeps no
 * such key on a target (lambda/shared/web_review_targets.py), so a page added from it would be read by the browser.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { at } from '@test/defined'
import { createQueryWrapper } from '../Categories/categories-fixtures'
import { AppConfigCard } from './AppConfigComponents'
import PluginConfigModal from './PluginConfigModal'
import TemplateSelector from './TemplateSelector'
import { BEDROCK_ENTRY_ID, buildSourceMenu } from './sourceMenu'
import type { PluginManifest } from '../../plugins/types'

const mockSaveAppConfig = vi.fn<(source: string, app: Record<string, string>) => unknown>()
const manifests: PluginManifest[] = []

vi.mock('../../api/client', () => ({
  api: {
    getAppConfigs: () => Promise.resolve({ apps: [] }),
    getSourcesStatus: () => Promise.resolve({ sources: {} }),
    saveAppConfig: (source: string, app: Record<string, string>) => mockSaveAppConfig(source, app),
  },
}))
vi.mock('../../plugins', () => ({ getPluginManifests: () => manifests, getSyntheticPlugins: () => [] }))
vi.mock('../../api/scrapersApi', () => ({ scrapersApi: { getScraperTemplates: () => Promise.resolve({ templates: [] }) } }))
vi.mock('../../store/configStore', () => ({ useConfigStore: () => ({ config: { apiEndpoint: 'https://api.example.com' } }) }))
vi.mock('./useRadarBrands', () => ({ useRadarBrandLabel: (): string | undefined => void 0, useRadarBrands: () => ({ brands: [], isLoading: false }) }))
vi.mock('./RadarSourcePicker', () => ({ default: () => null }))

const text = (key: string, label: string, required = false) => ({ key, label, type: 'text' as const, required, secret: false })
const BROWSER_FIELDS = [
  text('app_name', 'Name', true), text('url', 'Review page URL (https)', true),
  text('max_pages', 'Pages per run'), text('max_reviews', 'Max reviews per run'),
]
const METHOD_FIELD = {
  key: 'method', label: 'Method', type: 'select' as const, required: false, secret: false,
  options: [{ value: 'browser', label: 'Browser' }, { value: 'bedrock_web_search', label: 'Bedrock web search' }],
}
/** The model that reads the indexed page: a Bedrock web search page's own setting. */
const MODEL_FIELD = {
  key: 'model', label: 'Web search model', type: 'select' as const, required: false, secret: false,
  options: [{ value: 'openai.gpt-5.6-luna', label: 'Luna (default)' }],
}
const webReviews = (withMethod: boolean): PluginManifest => ({
  id: 'web_reviews', name: 'Web Reviews', icon: 'Web', category: 'reviews', enabled: true,
  hasIngestor: true, hasWebhook: false, hasS3Trigger: false,
  config: withMethod ? [...BROWSER_FIELDS, METHOD_FIELD, MODEL_FIELD] : BROWSER_FIELDS,
})

beforeEach(() => {
  vi.clearAllMocks()
  manifests.length = 0
  mockSaveAppConfig.mockResolvedValue({ success: true, app: {} })
})

describe('the source menu', () => {
  it('offers the Bedrock tile beside "Review page" once the plugin reads a method, with the method preset', () => {
    const [website] = buildSourceMenu([webReviews(true)], [], [])

    expect(website?.entries.map((entry) => entry.id)).toStrictEqual(['web_reviews', BEDROCK_ENTRY_ID])
    expect(website?.entries[1]?.action).toStrictEqual({ kind: 'plugin', plugin: webReviews(true), preset: { method: 'bedrock_web_search' } })
  })

  it('the control: not before the deployed plugin declares the field', () => {
    const [website] = buildSourceMenu([webReviews(false)], [], [])

    expect(website?.entries.map((entry) => entry.id)).toStrictEqual(['web_reviews'])
  })

  it('choosing the tile opens the review page plugin with the preset', async () => {
    manifests.push(webReviews(true))
    const onSelectPlugin = vi.fn()
    render(<TemplateSelector isAdmin onSelect={vi.fn()} onSelectPlugin={onSelectPlugin} onSelectGenerator={vi.fn()} onManualImport={vi.fn()}
      onJsonUpload={vi.fn()} onCsvUpload={vi.fn()} onClose={vi.fn()} />, { wrapper: createQueryWrapper() })

    await userEvent.setup().click(screen.getByRole('button', { name: /Amazon Bedrock web search index/ }))
    expect(onSelectPlugin).toHaveBeenCalledWith(webReviews(true), { method: 'bedrock_web_search' })
    expect(screen.getByText(/for sites that block automated browsers \(G2, Gartner, Capterra, TrustRadius\)/)).toBeInTheDocument()
  })
})

describe('the form it opens', () => {
  function renderForm() {
    const onClose = vi.fn()
    render(<PluginConfigModal plugin={webReviews(true)} isAdmin onClose={onClose} addPreset={{ method: 'bedrock_web_search' }} />,
      { wrapper: createQueryWrapper() })
    return onClose
  }

  it('is the add form at once: name, URL and max reviews, with the attribution note, never the method', () => {
    renderForm()

    expect(screen.getByRole('heading', { name: 'Add a page from the Bedrock web search index' })).toBeInTheDocument()
    expect(screen.getAllByRole('textbox')).toHaveLength(3)
    expect(screen.queryByText('Method')).not.toBeInTheDocument()
    expect(screen.getByText(/Each review keeps its source URL and site/)).toBeInTheDocument()
  })

  it("offers the Bedrock page's model, which a browser page never shows", () => {
    renderForm()
    expect(screen.getByRole('combobox')).toBeInTheDocument()
    expect(screen.getByText('Web search model')).toBeInTheDocument()
  })

  it('the control: the browser page form shows neither the method nor the model', async () => {
    render(<PluginConfigModal plugin={webReviews(true)} isAdmin onClose={vi.fn()} focusAppId="p1" />, { wrapper: createQueryWrapper() })
    // No such page is listed, so the dialog falls back to the list; adding one opens the browser form.
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Add your first review page' }))
    expect(screen.getAllByRole('textbox')).toHaveLength(4)
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })

  it('saves the page with the preset method and closes', async () => {
    const onClose = renderForm()
    const user = userEvent.setup()
    const fields = screen.getAllByRole('textbox')
    await user.type(at(fields, 0), 'G2 - Example')
    await user.type(at(fields, 1), 'https://www.g2.com/products/example/reviews')
    await user.type(at(fields, 2), '50')
    await user.click(screen.getByRole('button', { name: 'Add page' }))

    await waitFor(() => { expect(onClose).toHaveBeenCalledTimes(1) })
    expect(mockSaveAppConfig).toHaveBeenCalledWith('web_reviews', {
      method: 'bedrock_web_search', app_name: 'G2 - Example', url: 'https://www.g2.com/products/example/reviews', max_reviews: '50',
    })
  })
})

describe('the saved card', () => {
  const page = { id: 'p1', app_name: 'G2 - Example', url: 'https://www.g2.com/products/example/reviews' }
  function renderCard(app: Record<string, string>, plugin: PluginManifest) {
    render(<AppConfigCard app={app} plugin={plugin} isAdmin onEdit={vi.fn()} onDelete={vi.fn()} onRun={vi.fn()} isRunning={false} />)
    return within(screen.getByRole('heading', { name: 'G2 - Example' }).parentElement ?? document.body)
  }

  it('says a Bedrock page is read from the web index', () => {
    expect(renderCard({ ...page, method: 'bedrock_web_search' }, webReviews(true)).getByText('Bedrock web index')).toBeInTheDocument()
  })

  it('says any other page is read by the browser, once there is a choice', () => {
    expect(renderCard(page, webReviews(true)).getByText('Browser')).toBeInTheDocument()
  })

  it('the control: no badge while the plugin offers no method and the page names none', () => {
    const header = renderCard(page, webReviews(false))

    expect(header.queryByText('Browser')).not.toBeInTheDocument()
    expect(header.queryByText('Bedrock web index')).not.toBeInTheDocument()
  })
})
