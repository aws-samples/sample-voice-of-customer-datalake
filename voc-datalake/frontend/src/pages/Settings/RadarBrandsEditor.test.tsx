/**
 * The Radar brand list editor: add a brand (name + domains), edit a brand's domains, remove one
 * behind a confirm that says its reviews are kept, and save the whole list in one PUT. A legacy
 * profile brand is listed with its origin, cannot be removed here, is not an unsaved change on
 * load, and is written into the list with the next real save.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { createTestQueryClient, renderWithQueryClient } from '@test/query-client'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
import { resetFetchApi } from '@test/fetchApiRoutes'
import { ApiError } from '../../lib/errors'
import { ACME_PROFILE_BRAND as ACME, GLOBEX_BRAND as GLOBEX } from '@test/radarBrandFixtures'
import RadarBrandsEditor from './RadarBrandsEditor'
import { lastPut, plain, renderEditor, route, rowOf } from './radar-brands-editor-fixtures'

beforeEach(() => {
  resetFetchApi()
  route([GLOBEX])
})

describe('RadarBrandsEditor', () => {
  it('lists a brand with its origin, domains and 90-day review count', async () => {
    renderEditor()
    const row = await rowOf('Globex')
    expect(within(row).getByText('Brand list')).toBeInTheDocument()
    expect(within(row).getByText('Domains: globex.example')).toBeInTheDocument()
    expect(within(row).getByText('12 reviews in 90 days')).toBeInTheDocument()
  })

  it('adds a brand with its domains and saves the whole list in one PUT', async () => {
    const user = userEvent.setup()
    renderEditor()
    await rowOf('Globex')
    await user.type(screen.getByLabelText('Brand name'), '  Initech  Labs ')
    await user.type(screen.getByLabelText('Website domains'), 'initech.example, Blog.Initech.example, ')
    await user.click(screen.getByRole('button', { name: 'Add brand' }))
    await user.click(screen.getByRole('button', { name: 'Save brands' }))
    expect(await screen.findByText('Brands saved.')).toBeInTheDocument()
    expect(lastPut()).toStrictEqual({ brands: [
      plain('Globex', ['globex.example']),
      plain('Initech Labs', ['initech.example', 'blog.initech.example']),
    ] })
  })

  it('refuses a brand already in the list, named differently', async () => {
    const user = userEvent.setup()
    renderEditor()
    await rowOf('Globex')
    await user.type(screen.getByLabelText('Brand name'), 'GLOBEX')
    await user.click(screen.getByRole('button', { name: 'Add brand' }))
    expect(screen.getByRole('alert')).toHaveTextContent('GLOBEX is already in the list.')
    expect(screen.getByRole('button', { name: 'Save brands' })).toBeDisabled()
  })

  it('edits a brand\'s domains', async () => {
    const user = userEvent.setup()
    renderEditor()
    await user.click(within(await rowOf('Globex')).getByRole('button', { name: 'Edit Globex' }))
    const input = screen.getByLabelText('Website domains of Globex')
    await user.clear(input)
    await user.type(input, 'globex.example, globex.dev')
    await user.click(screen.getByRole('button', { name: 'Save brands' }))
    await screen.findByText('Brands saved.')
    expect(lastPut()).toStrictEqual({ brands: [plain('Globex', ['globex.example', 'globex.dev'])] })
  })
})

describe('RadarBrandsEditor removing a brand', () => {
  it('asks first, saying its reviews are kept', async () => {
    const user = userEvent.setup()
    renderEditor()
    await user.click(within(await rowOf('Globex')).getByRole('button', { name: 'Remove Globex' }))
    const dialog = screen.getByRole('dialog', { name: 'Remove Globex from Radar?' })
    expect(within(dialog).getByText(/Its stored reviews and releases are kept/)).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }))
    expect(screen.queryByText('Globex')).toBeNull()
  })

  it('saves the list without it once confirmed', async () => {
    const user = userEvent.setup()
    renderEditor()
    await user.click(within(await rowOf('Globex')).getByRole('button', { name: 'Remove Globex' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove' }))
    await user.click(screen.getByRole('button', { name: 'Save brands' }))
    await screen.findByText('Brands saved.')
    expect(lastPut()).toStrictEqual({ brands: [] })
  })

  it('keeps the brand when the confirm is cancelled', async () => {
    const user = userEvent.setup()
    renderEditor()
    await user.click(within(await rowOf('Globex')).getByRole('button', { name: 'Remove Globex' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    expect(screen.getByText('Globex')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save brands' })).toBeDisabled()
  })
})

describe('RadarBrandsEditor with a legacy profile brand', () => {
  beforeEach(() => route([GLOBEX, ACME]))

  it('lists it with its origin and profile, and offers no Remove', async () => {
    renderEditor()
    const row = await rowOf('Acme')
    expect(within(row).getByText('Source profile')).toBeInTheDocument()
    expect(await within(row).findByText(/Named by a source profile \(Rival reviews\)/)).toBeInTheDocument()
    expect(within(row).queryByRole('button', { name: 'Remove Acme' })).toBeNull()
  })

  it('is not an unsaved change on first load (Save stays off)', async () => {
    renderEditor()
    await rowOf('Acme')
    expect(screen.queryByText('Unsaved changes.')).toBeNull()
    expect(screen.getByRole('button', { name: 'Save brands' })).toBeDisabled()
  })

  it('writes it into the list on the next save', async () => {
    const user = userEvent.setup()
    renderEditor()
    await rowOf('Acme')
    await user.type(screen.getByLabelText('Brand name'), 'Initech')
    await user.click(screen.getByRole('button', { name: 'Add brand' }))
    await user.click(screen.getByRole('button', { name: 'Save brands' }))
    await screen.findByText('Brands saved.')
    expect(lastPut()).toStrictEqual({ brands: [
      plain('Globex', ['globex.example']), plain('Acme', ['acme.example']), plain('Initech', []),
    ] })
  })
})

describe('RadarBrandsEditor when the save is refused', () => {
  it('shows the server\'s reason and keeps the draft', async () => {
    route([GLOBEX], () => { throw new ApiError(400, 'brands[1]: not a domain name: nope') })
    const user = userEvent.setup()
    renderEditor()
    await rowOf('Globex')
    await user.type(screen.getByLabelText('Brand name'), 'Initech')
    await user.click(screen.getByRole('button', { name: 'Add brand' }))
    await user.click(screen.getByRole('button', { name: 'Save brands' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The brands could not be saved. brands[1]: not a domain name: nope')
    expect(screen.getByText('Initech')).toBeInTheDocument()
  })
})

describe('RadarBrandsEditor after a save', () => {
  it('marks every Radar read stale (not only the overview), keeping the list it just saved', async () => {
    const client = createTestQueryClient({ gcTime: Infinity, staleTime: Infinity })
    client.setQueryData(['radar', 'detail', 'globex', 30], { brand: 'globex' })
    client.setQueryData(['radar', 'releases', 'globex'], { releases: [] })
    const user = userEvent.setup()
    renderWithQueryClient(<MemoryRouter><RadarBrandsEditor totals={new Map()} /></MemoryRouter>, client)
    await rowOf('Globex')
    await user.type(screen.getByLabelText('Brand name'), 'Initech')
    await user.click(screen.getByRole('button', { name: 'Add brand' }))
    await user.click(screen.getByRole('button', { name: 'Save brands' }))
    await screen.findByText('Brands saved.')
    const stale = (key: readonly unknown[]) => client.getQueryState(key)?.isInvalidated
    expect([stale(['radar', 'detail', 'globex', 30]), stale(['radar', 'releases', 'globex']), stale(['radar', 'brands'])])
      .toStrictEqual([true, true, false])
  })
})
