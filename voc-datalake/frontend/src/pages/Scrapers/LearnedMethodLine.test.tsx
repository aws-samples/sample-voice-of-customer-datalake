/**
 * What this workspace learned for an Automatic review page's site, on its card ("Known best: Bedrock web index
 * (learned …)"), from one read of `GET /integrations/web_reviews/methods` for every card; and "Re-check methods":
 * an admin clears the site's record (`DELETE …/methods/{domain}`), after which the card says the next run tries
 * every method again. A non-admin sees the record but cannot clear it; a page on one method shows neither. A run of
 * the page that finishes reads the records again, so what it learned shows without a reload.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { configStoreModule, createQueryWrapper } from '../Categories/categories-fixtures'
import AppConfigList from './AppConfigList'
import { ADMIN_ONLY_TITLE } from '../../constants/admin'
import type { WebReviewMethodRecord } from '../../api/webReviewMethodsApi'
import type { PluginManifest } from '../../plugins/types'

const mockList = vi.fn<() => Promise<WebReviewMethodRecord[]>>()
const mockClear = vi.fn<(domain: string) => Promise<unknown>>()
/** Each page's run row (`GET /sources/status?run_status=web_reviews&app_id=…`): never run unless a test sets one. */
const runRows = new Map<string, Record<string, unknown>>()

vi.mock('../../api/client', () => ({
  api: {
    getAppConfigs: () => Promise.resolve({ apps: pages }),
    getSourceRunStatus: (_source: string, run?: { appId?: string }) =>
      Promise.resolve(runRows.get(run?.appId ?? '') ?? { status: 'never_run' }),
  },
}))
vi.mock('../../api/webReviewMethodsApi', () => ({
  webReviewMethodsKey: () => ['web-review-methods'],
  webReviewMethodsApi: { list: () => mockList(), clear: (domain: string) => mockClear(domain) },
}))
vi.mock('../../store/configStore', () => configStoreModule())
const noBrand = (): string | undefined => void 0
vi.mock('./useRadarBrands', () => ({ useRadarBrandLabeler: () => noBrand }))

const plugin: PluginManifest = {
  id: 'web_reviews', name: 'Web Reviews', icon: 'Web', enabled: true, hasIngestor: true, hasWebhook: false, hasS3Trigger: false,
  config: [{ key: 'method', label: 'Read with', type: 'select', required: false, secret: false,
    options: [{ value: 'auto', label: 'Automatic' }, { value: 'browser', label: 'Browser only' }] }],
}
const pages = [
  { id: 'p1', app_name: 'Reviews - Acme', url: 'https://www.Reviews.example/acme' },
  { id: 'p2', app_name: 'Forum - Acme', url: 'https://forum.example/acme', method: 'browser' },
]
const LEARNED: WebReviewMethodRecord = {
  domain: 'reviews.example', best_method: 'bedrock_web_search', learned_at: '2026-11-15T09:00:00Z',
  browser_recheck_due_at: '2026-11-29T09:00:00Z', methods: {},
}

function renderList(isAdmin = true) {
  render(<AppConfigList plugins={[plugin]} isAdmin={isAdmin} onEditPlugin={vi.fn()} onDeleteApp={vi.fn()} onRunApp={vi.fn()} />,
    { wrapper: createQueryWrapper() })
}

async function card(name: string): Promise<HTMLElement> {
  const element = (await screen.findByRole('heading', { name })).closest('.card')
  if (!(element instanceof HTMLElement)) throw new Error(`no card for ${name}`)
  return element
}

beforeEach(() => {
  vi.clearAllMocks()
  runRows.clear()
  mockList.mockResolvedValue([LEARNED, { ...LEARNED, domain: 'forum.example' }])
  mockClear.mockResolvedValue({ success: true, domain: 'reviews.example', cleared: true })
})

describe('the known best method', () => {
  it("shows on an Automatic page's card, from its site's record (the host lower-cased, without www.)", async () => {
    renderList()
    expect(await within(await card('Reviews - Acme')).findByText('Known best: Bedrock web index (learned Nov 15, 2026)'))
      .toBeInTheDocument()
    expect(mockList).toHaveBeenCalledTimes(1)
  })

  it('says when the browser is tried again on a site another method reads', async () => {
    renderList()
    expect(await within(await card('Reviews - Acme')).findByText('The browser is tried again after Nov 29, 2026')).toBeInTheDocument()
  })

  it('the control: not on a page read with one method, though its site has a record', async () => {
    renderList()
    await within(await card('Reviews - Acme')).findByText(/Known best/)
    expect(within(await card('Forum - Acme')).queryByText(/Known best/)).not.toBeInTheDocument()
  })

  it('says when no method has read the site yet', async () => {
    mockList.mockResolvedValue([{ ...LEARNED, best_method: 'none', learned_at: null, browser_recheck_due_at: null }])
    renderList()
    expect(await within(await card('Reviews - Acme')).findByText('No method has read this site yet')).toBeInTheDocument()
  })
})

describe('after a run', () => {
  it('reads what was learned again once a run of the page finishes, so the line shows without a reload', async () => {
    const page = 'https://www.Reviews.example/acme'
    runRows.set(page, { status: 'running', started_at: new Date().toISOString(), items_found: 0, errors: [] })
    mockList.mockResolvedValue([])
    renderList()
    const acme = await card('Reviews - Acme')
    expect((await within(acme).findAllByText('Running...')).length).toBeGreaterThan(0)
    expect(within(acme).queryByText(/Known best/)).not.toBeInTheDocument()

    mockList.mockResolvedValue([LEARNED])
    runRows.set(page, { status: 'completed', started_at: '2026-11-15T09:00:00Z', completed_at: '2026-11-15T09:02:00Z', items_found: 4, errors: [] })

    expect(await within(acme).findByText('Known best: Bedrock web index (learned Nov 15, 2026)', {}, { timeout: 5000 }))
      .toBeInTheDocument()
    expect(mockList).toHaveBeenCalledTimes(2)
  })

  it('the control: a run that was never seen running reads nothing again', async () => {
    runRows.set('https://www.Reviews.example/acme', { status: 'completed', started_at: '2026-11-15T09:00:00Z', items_found: 4, errors: [] })
    renderList()
    expect(await within(await card('Reviews - Acme')).findByText(/Known best/)).toBeInTheDocument()
    expect(mockList).toHaveBeenCalledTimes(1)
  })
})

describe('Re-check methods', () => {
  it("clears the site's record, then says the next run tries every method again", async () => {
    renderList()
    const acme = await card('Reviews - Acme')
    mockList.mockResolvedValue([])
    await userEvent.setup().click(await within(acme).findByRole('button', { name: 'Re-check methods' }))

    await waitFor(() => { expect(mockClear).toHaveBeenCalledWith('reviews.example') })
    expect(await within(acme).findByText('The next run tries every method again.')).toBeInTheDocument()
    expect(mockList).toHaveBeenCalledTimes(2)
  })

  it('says so when the clear fails, and keeps the record', async () => {
    mockClear.mockRejectedValue(new Error('HTTP 500'))
    renderList()
    const acme = await card('Reviews - Acme')
    await userEvent.setup().click(await within(acme).findByRole('button', { name: 'Re-check methods' }))

    expect(await within(acme).findByRole('alert')).toHaveTextContent('Could not clear what was learned')
    expect(within(acme).getByText(/Known best/)).toBeInTheDocument()
  })

  it('is off for a non-admin (focusable, saying why), who still sees what was learned', async () => {
    renderList(false)
    const button = await within(await card('Reviews - Acme')).findByRole('button', { name: 'Re-check methods' })
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button).toHaveAccessibleDescription(ADMIN_ONLY_TITLE)
  })
})
