/**
 * How a review page (web_reviews) is read, on the form and the card. The review page form shows "Read with":
 * Automatic (recommended, the default, also for a page saved without a method), Browser only or Bedrock web index
 * only. "Amazon Bedrock web search index" in Add a data source opens the same form with Bedrock web index only
 * preset and its own fields (name, URL, reviews per run); choosing another method shows the browser's fields again.
 * The form asks for no model (7.42.00): the web search surface's, chosen in Administration → AI models, reads every
 * Bedrock page. The saved card says how its page is read.
 *
 * Offered only once the deployed web_reviews manifest declares the `method` field: until then the API keeps no
 * such key on a target (lambda/shared/web_review_targets.py), so a choice would be dropped.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { at } from '@test/defined'
import { createQueryWrapper } from '../Categories/categories-fixtures'
import { AppConfigCard } from './AppConfigComponents'
import AppEditorForm from './AppEditorForm'
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
  key: 'method', label: 'Read with', type: 'select' as const, required: false, secret: false,
  options: [{ value: 'auto', label: 'Automatic (recommended)' }, { value: 'browser', label: 'Browser only' },
    { value: 'bedrock_web_search', label: 'Bedrock web index only' }],
}
const webReviews = (withMethod: boolean): PluginManifest => ({
  id: 'web_reviews', name: 'Web Reviews', icon: 'Web', category: 'reviews', enabled: true,
  hasIngestor: true, hasWebhook: false, hasS3Trigger: false,
  config: withMethod ? [...BROWSER_FIELDS, METHOD_FIELD] : BROWSER_FIELDS,
})

beforeEach(() => {
  vi.clearAllMocks()
  manifests.length = 0
  mockSaveAppConfig.mockResolvedValue({ success: true, app: {} })
})

/** The review page form as the Bedrock tile opens it; its dialog's onClose. */
function renderForm() {
  const onClose = vi.fn()
  render(<PluginConfigModal plugin={webReviews(true)} isAdmin onClose={onClose} addPreset={{ method: 'bedrock_web_search' }} />,
    { wrapper: createQueryWrapper() })
  return onClose
}

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
    expect(screen.getByText(/for sites that block automated browsers\. Read from Amazon's cache/)).toBeInTheDocument()
  })
})

describe('the form it opens', () => {
  it('is the add form at once: name, URL and max reviews, with the attribution note, read with the Bedrock web index only', () => {
    renderForm()

    expect(screen.getByRole('heading', { name: 'Add a page from the Bedrock web search index' })).toBeInTheDocument()
    expect(screen.getAllByRole('textbox')).toHaveLength(3)
    expect(screen.getByRole('combobox', { name: 'Read with' })).toHaveValue('bedrock_web_search')
    expect(screen.getByText(/Each review keeps its source URL and site/)).toBeInTheDocument()
  })

  it('never asks for a model: the one that reads the page is chosen in Administration → AI models', () => {
    renderForm()
    expect(screen.getAllByRole('combobox').map((box) => box.getAttribute('aria-describedby') !== null)).toStrictEqual([true])
    expect(screen.getByText(/The model that reads it is chosen in Administration → AI models/)).toBeInTheDocument()
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

describe('Read with, on the review page form', () => {
  async function openBrowserForm(plugin: PluginManifest) {
    render(<PluginConfigModal plugin={plugin} isAdmin onClose={vi.fn()} focusAppId="p1" />, { wrapper: createQueryWrapper() })
    // No such page is listed, so the dialog falls back to the list; adding one opens the review page form.
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Add your first review page' }))
  }

  it('offers the three methods, Automatic first and chosen, with what it does', async () => {
    await openBrowserForm(webReviews(true))
    const select = screen.getByRole('combobox', { name: 'Read with' })

    expect(within(select).getAllByRole('option').map((option) => option.textContent))
      .toStrictEqual(['Automatic (recommended)', 'Browser only', 'Bedrock web index only'])
    expect(select).toHaveValue('auto')
    expect(screen.getByText(/Tries the signed browser first/)).toBeInTheDocument()
  })

  it('shows the browser fields for Automatic: name, URL, pages and reviews per run', async () => {
    await openBrowserForm(webReviews(true))
    expect(screen.getAllByRole('textbox')).toHaveLength(4)
  })

  it('the control: no Read with while the deployed plugin offers no method', async () => {
    await openBrowserForm(webReviews(false))
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })

  it('shows the browser fields again when a Bedrock page switches to Automatic, and saves that method', async () => {
    const onClose = renderForm()
    const user = userEvent.setup()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Read with' }), 'auto')
    expect(screen.getAllByRole('textbox')).toHaveLength(4)
    await user.type(at(screen.getAllByRole('textbox'), 0), 'Reviews - Example')
    await user.type(at(screen.getAllByRole('textbox'), 1), 'https://www.reviews.example/example')
    await user.click(screen.getByRole('button', { name: 'Add page' }))

    await waitFor(() => { expect(onClose).toHaveBeenCalledTimes(1) })
    expect(mockSaveAppConfig).toHaveBeenCalledWith('web_reviews', {
      method: 'auto', app_name: 'Reviews - Example', url: 'https://www.reviews.example/example',
    })
  })

  it('keeps an existing page on the method it was saved with, and one saved without a method on Automatic', () => {
    render(<AppEditorForm plugin={webReviews(true)} initialValues={{ id: 'p1', app_name: 'A', url: 'https://a.example', method: 'browser' }}
      isAdmin onSave={vi.fn()} onCancel={vi.fn()} isPending={false} />)
    render(<AppEditorForm plugin={webReviews(true)} initialValues={{ id: 'p2', app_name: 'B', url: 'https://b.example' }}
      isAdmin onSave={vi.fn()} onCancel={vi.fn()} isPending={false} />)
    const [stored, unnamed] = screen.getAllByRole('combobox', { name: 'Read with' })
    expect(stored).toHaveValue('browser')
    expect(unnamed).toHaveValue('auto')
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

  it('says a page on the browser alone is read by the browser', () => {
    expect(renderCard({ ...page, method: 'browser' }, webReviews(true)).getByText('Browser')).toBeInTheDocument()
  })

  it('says a page that names no method, or Automatic, is read automatically, once there is a choice', () => {
    expect(renderCard(page, webReviews(true)).getByText('Automatic')).toBeInTheDocument()
  })

  it('the control: no badge while the plugin offers no method and the page names none', () => {
    const header = renderCard(page, webReviews(false))

    expect(header.queryByText('Automatic')).not.toBeInTheDocument()
    expect(header.queryByText('Bedrock web index')).not.toBeInTheDocument()
  })
})
