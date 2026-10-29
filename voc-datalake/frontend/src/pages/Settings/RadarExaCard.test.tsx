/**
 * Administration -> Sources -> Radar, the Exa card: it says whether a key is stored (GET /radar
 * `settings.exa_configured`), saves a key with one PUT and clears the box (the key never stays
 * on screen), refuses a malformed key before any request, shows the server's reason, and removes
 * the key only after a confirm (DELETE).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useQuery } from '@tanstack/react-query'
import { renderWithQueryClient } from '@test/query-client'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
import { fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { ApiError } from '../../lib/errors'
import { radarApi, radarKeys } from '../../api/radarApi'
import RadarExaCard from './RadarExaCard'

const KEY = 'exa_example_key_1234'

/** The card as RadarSection mounts it: its status from the shared GET /radar entry. */
function Harness() {
  const overview = useQuery({ queryKey: radarKeys.overview(), queryFn: () => radarApi.getOverview() })
  return overview.data === undefined ? null : <RadarExaCard configured={overview.data.settings.exa_configured} />
}

function route(configured: boolean, put: (body: unknown) => unknown = () => ({ success: true, exa_configured: true })): void {
  routeFetchApi({
    'GET /radar': () => ({ brands: [], last_scan: null, settings: { cadence: 'weekly', max_brands: 10, query_cap: 30, exa_configured: configured } }),
    'PUT /radar/settings/exa-key': put,
    'DELETE /radar/settings/exa-key': () => ({ success: true, exa_configured: false }),
  })
}

const callsTo = (method: string) =>
  fetchApi.mock.calls.filter(([path, options]) => path === '/radar/settings/exa-key' && options?.method === method)

const renderCard = () => renderWithQueryClient(<Harness />)

beforeEach(() => resetFetchApi())

describe('RadarExaCard', () => {
  it('says no key is stored and offers no Remove', async () => {
    route(false)
    renderCard()
    expect(await screen.findByText('Not configured')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Remove key' })).toBeNull()
  })

  it('takes the key in a password box the browser does not fill', async () => {
    route(false)
    renderCard()
    const input = await screen.findByLabelText('Exa API key')
    expect(input).toHaveAttribute('type', 'password')
    expect(input).toHaveAttribute('autocomplete', 'off')
  })

  it('saves the key with one PUT, clears the box and shows it as configured', async () => {
    route(false)
    const user = userEvent.setup()
    const { container } = renderCard()
    await user.type(await screen.findByLabelText('Exa API key'), KEY)
    await user.click(screen.getByRole('button', { name: 'Save key' }))
    expect(await screen.findByText('Configured')).toBeInTheDocument()
    expect(JSON.parse(String(callsTo('PUT')[0]?.[1]?.body))).toStrictEqual({ api_key: KEY })
    expect(screen.getByLabelText('Exa API key')).toHaveValue('')
    // Nowhere on screen: not as text, not in an attribute.
    expect(container.innerHTML).not.toContain(KEY)
  })

  it('refuses a malformed key before any request', async () => {
    route(false)
    const user = userEvent.setup()
    renderCard()
    await user.type(await screen.findByLabelText('Exa API key'), 'short')
    await user.click(screen.getByRole('button', { name: 'Save key' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Use 8-200 letters, digits, - or _.')
    expect(callsTo('PUT')).toHaveLength(0)
  })

  it('shows the server\'s reason when the save is refused', async () => {
    route(false, () => { throw new ApiError(400, 'api_key must be 8-200 letters, digits, - or _') })
    const user = userEvent.setup()
    renderCard()
    await user.type(await screen.findByLabelText('Exa API key'), KEY)
    await user.click(screen.getByRole('button', { name: 'Save key' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The Exa key could not be saved. api_key must be 8-200')
  })

  it('says a key is stored, inviting a replacement', async () => {
    route(true)
    renderCard()
    expect(await screen.findByText('Configured')).toBeInTheDocument()
    expect(screen.getByLabelText('Exa API key')).toHaveAttribute('placeholder', 'A key is stored. Paste a new one to replace it')
  })

  it('removes a stored key only once confirmed', async () => {
    route(true)
    const user = userEvent.setup()
    renderCard()
    await screen.findByText('Configured')
    await user.click(screen.getByRole('button', { name: 'Remove key' }))
    const dialog = screen.getByRole('dialog', { name: 'Remove the Exa key?' })
    expect(callsTo('DELETE')).toHaveLength(0)
    await user.click(within(dialog).getByRole('button', { name: 'Remove key' }))
    expect(await screen.findByText('Not configured')).toBeInTheDocument()
    expect(callsTo('DELETE')).toHaveLength(1)
    expect(screen.getByText('Exa key removed.')).toBeInTheDocument()
  })
})
