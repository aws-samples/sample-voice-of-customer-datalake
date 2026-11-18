/**
 * The app cards' runs (live finding, four review pages run at once): run statuses lived in component state only,
 * so a reload showed "Run now" and no result, and the poll applied the plugin's latest run to every running card.
 * Each card now reads its own last run on mount (`?run_status=<plugin>&app_id=<page>`) and polls its own run.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { configStoreModule, createQueryWrapper } from '../Categories/categories-fixtures'
import { webReviewsPlugin } from './scrapers-fixtures'
import AppConfigList from './AppConfigList'
import { STALE_RUN_MS } from './useAppRun'

type RunRow = Record<string, unknown>
const mockGetAppConfigs = vi.fn<(source: string) => unknown>()
const mockGetSourceRunStatus = vi.fn<(source: string, run?: { appId?: string; executionId?: string }) => unknown>()

vi.mock('../../api/client', () => ({
  api: {
    getAppConfigs: (source: string) => mockGetAppConfigs(source),
    getSourceRunStatus: (source: string, run?: { appId?: string; executionId?: string }) => mockGetSourceRunStatus(source, run),
  },
}))
vi.mock('../../store/configStore', () => configStoreModule())
// No Radar brand on these pages: every label lookup finds none.
vi.mock('./useRadarBrands', () => import('@test/radarBrandFixtures').then((m) => m.noRadarBrandsModule()))

const plugin = webReviewsPlugin()
const G2 = 'https://www.g2.com/products/example-connect/reviews'
const GARTNER = 'https://www.gartner.com/reviews/product/example-connect'
const pages = [
  { id: 'p1', app_name: 'G2 - Example', url: G2 },
  { id: 'p2', app_name: 'Gartner - Example', url: GARTNER },
]

/** The server's run rows by page, as `GET /sources/status?run_status=web_reviews&app_id=…` answers them. */
const server = new Map<string, RunRow>()
const finished = (items: number, errors: string[]): RunRow => ({
  status: 'completed', started_at: '2026-11-15T09:00:00Z', completed_at: '2026-11-15T09:02:00Z', items_found: items, errors,
})

function renderList(onRunApp = vi.fn<(pluginId: string, appId: string) => Promise<unknown>>()) {
  render(<AppConfigList plugins={[plugin]} isAdmin onEditPlugin={vi.fn()} onDeleteApp={vi.fn()} onRunApp={onRunApp} />,
    { wrapper: createQueryWrapper() })
  return onRunApp
}

/** The card of the page named `name`, once listed. */
async function card(name: string): Promise<HTMLElement> {
  const heading = await screen.findByRole('heading', { name })
  const element = heading.closest('.card')
  if (!(element instanceof HTMLElement)) throw new Error(`no card for ${name}`)
  return element
}

async function runNow(name: string) {
  const user = userEvent.setup()
  await user.click(within(await card(name)).getByRole('button', { name: 'Run now' }))
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Fetch reviews' }))
}

beforeEach(() => {
  vi.clearAllMocks()
  server.clear()
  mockGetAppConfigs.mockResolvedValue({ apps: pages })
  mockGetSourceRunStatus.mockImplementation((source, run) =>
    Promise.resolve(server.get(run?.appId ?? '') ?? { source, status: 'never_run' }))
})

describe('after a reload', () => {
  it("each card reads its own page's last run", async () => {
    server.set(G2, finished(0, ['G2 - Example: blocked by Cloudflare']))
    renderList()

    await card('G2 - Example')
    await waitFor(() => { expect(mockGetSourceRunStatus).toHaveBeenCalledWith('web_reviews', { appId: G2, executionId: undefined }) })
    expect(mockGetSourceRunStatus).toHaveBeenCalledWith('web_reviews', { appId: GARTNER, executionId: undefined })
  })

  it('shows a blocked run as completed with its error and what "blocked" means', async () => {
    server.set(G2, finished(0, ['G2 - Example: blocked by Cloudflare']))
    renderList()
    const g2 = await card('G2 - Example')

    expect(await within(g2).findByText('Completed with errors')).toBeInTheDocument()
    expect(within(g2).getByText('G2 - Example: blocked by Cloudflare')).toBeInTheDocument()
    expect(within(g2).getByText(/The site refuses automated browsers/)).toBeInTheDocument()
  })

  it('shows a completed run with its reviews, and nothing on a page that never ran', async () => {
    server.set(G2, finished(12, []))
    renderList()
    const g2 = await card('G2 - Example')

    expect(await within(g2).findByText('Completed')).toBeInTheDocument()
    expect(within(g2).getByText('12')).toBeInTheDocument()
    expect(within(await card('Gartner - Example')).queryByText(/Reviews found/)).not.toBeInTheDocument()
  })

  it('says a run that never closed its row did not finish, and lets it run again', async () => {
    server.set(G2, { status: 'running', started_at: new Date(Date.now() - STALE_RUN_MS - 60_000).toISOString(), items_found: 0, errors: [] })
    renderList()
    const g2 = await card('G2 - Example')

    expect(await within(g2).findByText('Did not finish')).toBeInTheDocument()
    expect(within(g2).getByRole('button', { name: 'Run now' })).toBeEnabled()
  })
})

describe('two pages run at once', () => {
  const RUN_IDS: Record<string, string> = { [G2]: 'run_web_reviews_20261115090000_0000000a', [GARTNER]: 'run_web_reviews_20261115090000_0000000b' }

  /** Starts both pages; the server's rows say running until a test finishes one. */
  async function startBoth() {
    const onRunApp = renderList(vi.fn((_pluginId: string, appId: string) => {
      server.set(appId, { status: 'running', started_at: new Date().toISOString(), items_found: 0, errors: [] })
      return Promise.resolve({ success: true, execution_id: RUN_IDS[appId] })
    }))
    await runNow('G2 - Example')
    await runNow('Gartner - Example')
    return onRunApp
  }

  it('each starts its own page', async () => {
    const onRunApp = await startBoth()

    expect(onRunApp.mock.calls).toStrictEqual([['web_reviews', G2], ['web_reviews', GARTNER]])
  })

  it("each card polls its own run and shows its own result, never the other page's", async () => {
    await startBoth()
    server.set(G2, finished(0, ['G2 - Example: blocked by DataDome']))

    expect(await within(await card('G2 - Example')).findByText('Completed with errors', {}, { timeout: 5000 })).toBeInTheDocument()
    const gartner = await card('Gartner - Example')
    expect(within(gartner).getAllByText('Running...').length).toBeGreaterThan(0)
    expect(within(gartner).queryByText('G2 - Example: blocked by DataDome')).not.toBeInTheDocument()
  })

  it('polls each run by its own id', async () => {
    await startBoth()

    await waitFor(() => {
      expect(mockGetSourceRunStatus).toHaveBeenCalledWith('web_reviews', { appId: GARTNER, executionId: RUN_IDS[GARTNER] })
    }, { timeout: 5000 })
    expect(mockGetSourceRunStatus).toHaveBeenCalledWith('web_reviews', { appId: G2, executionId: RUN_IDS[G2] })
  })

  it('a refused Run now shows why on that card only, and a poll does not erase it', async () => {
    server.set(GARTNER, finished(3, []))
    renderList(vi.fn((_pluginId: string, appId: string) => (appId === G2
      ? Promise.reject(new Error('Admin access required'))
      : Promise.resolve({ success: true }))))
    await runNow('G2 - Example')
    const g2 = await card('G2 - Example')

    expect(await within(g2).findByText('Admin access required')).toBeInTheDocument()
    // The card's entry is read again after the refusal (its mount read, then this one): the message stays.
    await waitFor(() => { expect(mockGetSourceRunStatus.mock.calls.filter(([, run]) => run?.appId === G2).length).toBeGreaterThan(1) })
    expect(within(g2).getByText('Admin access required')).toBeInTheDocument()
    expect(within(await card('Gartner - Example')).getByText('3')).toBeInTheDocument()
  })
})
