/**
 * "Radar source" on a Scrapers-page source: ticking it offers the brands of GET /radar/brands,
 * one brand is chosen for you, none leads to Administration → Sources → Radar, unticking sends
 * '' (an ordinary source), and a stored key no longer in the list stays selected.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { createTestQueryClient, renderWithQueryClient } from '@test/query-client'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
import { resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { radarKeys } from '../../api/radarApi'
import { normalizeRadarBrands } from '../../api/radarSchema'
import { ACME_PROFILE_BRAND as ACME, GLOBEX_BRAND as GLOBEX } from '@test/radarBrandFixtures'
import RadarSourcePicker from './RadarSourcePicker'

const route = (brands: unknown[]) => routeFetchApi({ 'GET /radar/brands': () => ({ brands }) })

function Harness({ initial, onPick }: Readonly<{ initial: string; onPick: (key: string) => void }>) {
  const [value, setValue] = useState(initial)
  return <RadarSourcePicker value={value} onChange={(key) => { setValue(key); onPick(key) }} />
}

function renderPicker(initial = '', client = createTestQueryClient()) {
  const onPick = vi.fn<(key: string) => void>()
  renderWithQueryClient(<MemoryRouter><Harness initial={initial} onPick={onPick} /></MemoryRouter>, client)
  return { onPick, user: userEvent.setup() }
}

const box = () => screen.getByRole('checkbox', { name: 'Radar source: reviews of another brand' })

beforeEach(() => {
  resetFetchApi()
  route([GLOBEX, ACME])
})

describe('RadarSourcePicker', () => {
  it('asks for a brand from the brand list once ticked', async () => {
    const { onPick, user } = renderPicker()
    await user.click(box())
    await user.selectOptions(await screen.findByLabelText('Radar brand'), 'acme')
    expect(onPick).toHaveBeenLastCalledWith('acme')
    expect(screen.getByRole('option', { name: 'Globex' })).toBeInTheDocument()
  })

  it('picks the only brand for you', async () => {
    // The brands already read (as the Scrapers page usually has them), so the tick sees them.
    route([GLOBEX])
    const client = createTestQueryClient()
    client.setQueryData(radarKeys.brands(), normalizeRadarBrands({ brands: [GLOBEX] }))
    const { onPick, user } = renderPicker('', client)
    await user.click(box())
    expect(onPick).toHaveBeenLastCalledWith('globex')
  })

  it('sends an ordinary source when unticked', async () => {
    const { onPick, user } = renderPicker('globex')
    expect(await screen.findByLabelText('Radar brand')).toHaveValue('globex')
    await user.click(box())
    expect(onPick).toHaveBeenLastCalledWith('')
    expect(screen.queryByLabelText('Radar brand')).toBeNull()
  })
})

describe('RadarSourcePicker edge cases', () => {
  it('links to the Radar settings when there is no brand yet', async () => {
    route([])
    const { user } = renderPicker()
    await user.click(box())
    expect(await screen.findByText('No Radar brand yet.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Add a brand in Administration → Sources → Radar' }))
      .toHaveAttribute('href', '/admin?tab=sources&section=radar')
  })

  it('keeps a stored brand that is no longer in the list, marked as such', async () => {
    renderPicker('initech')
    expect(await screen.findByLabelText('Radar brand')).toHaveValue('initech')
    expect(screen.getByRole('option', { name: 'initech (not in the brand list)' })).toBeInTheDocument()
  })

  it('says so when the brands cannot be read', async () => {
    routeFetchApi({}, { missStatus: 500 })
    const { user } = renderPicker()
    await user.click(box())
    expect(await screen.findByRole('alert')).toHaveTextContent('The Radar brands could not be loaded.')
  })
})
