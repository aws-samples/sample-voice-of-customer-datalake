/**
 * The Radar brand editor's search terms and exclude terms (5.47, docs/radar.md → "Search terms"):
 * one per line, sent in the Save brands PUT from a brand's row and from "Add a brand"; a ninth term,
 * a term over 60 characters or one with a double quote holds the save back.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
import { resetFetchApi } from '@test/fetchApiRoutes'
import { addAndSave, lastPut, plain, renderEditor, route, rowOf } from './radar-brands-editor-fixtures'

const EXAMPLE = {
  key: 'example-air', label: 'Example Air', domains: ['example.cz'], origin: 'list', sources: [],
  language: null, effective_language: 'cs', feed_urls: [], search_terms: ['Example Air a.s.'], exclude_terms: [],
}

type User = ReturnType<typeof userEvent.setup>

const openRow = async (user: User) => {
  renderEditor()
  const row = await rowOf('Example Air')
  await user.click(within(row).getByRole('button', { name: 'Edit Example Air' }))
  return row
}

const typeInto = async (user: User, box: HTMLElement, text: string) => {
  await user.clear(box)
  await user.type(box, text)
}

beforeEach(() => {
  resetFetchApi()
  route([EXAMPLE])
})

describe('RadarBrandsEditor, a brand\'s search and exclude terms', () => {
  it('summarises the stored search terms and says nothing of an empty exclude list', async () => {
    renderEditor()
    const row = await rowOf('Example Air')
    expect(within(row).getByText('Search terms: Example Air a.s.')).toBeInTheDocument()
    expect(within(row).queryByText(/Exclude terms:/)).not.toBeInTheDocument()
  })

  it('saves edited terms one per line, folded and de-duplicated', async () => {
    const user = userEvent.setup()
    const row = await openRow(user)
    await typeInto(user, within(row).getByLabelText('Search terms'), 'Example Air a.s.{Enter}  Sky   Pass {Enter}sky pass')
    await typeInto(user, within(row).getByLabelText('Exclude terms'), 'employee benefits')
    await user.click(screen.getByRole('button', { name: 'Save brands' }))
    await screen.findByText('Brands saved.')
    expect(lastPut()).toStrictEqual({ brands: [{
      ...plain('Example Air', ['example.cz']), search_terms: ['Example Air a.s.', 'Sky Pass'], exclude_terms: ['employee benefits'],
    }] })
  })

  it('holds the save back on a ninth term', async () => {
    const user = userEvent.setup()
    const row = await openRow(user)
    await typeInto(user, within(row).getByLabelText('Exclude terms'), Array.from({ length: 9 }, (_, i) => `t${String(i)}`).join('{Enter}'))
    expect(within(row).getByRole('alert')).toHaveTextContent('At most 8 terms.')
    expect(screen.getByRole('button', { name: 'Save brands' })).toBeDisabled()
    expect(screen.getByText('Fix the search or exclude terms before saving.')).toBeInTheDocument()
  })

  it('holds the save back on a term over 60 characters or with a double quote', async () => {
    const user = userEvent.setup()
    const row = await openRow(user)
    const box = within(row).getByLabelText('Search terms')
    await typeInto(user, box, 'x'.repeat(61))
    expect(within(row).getByRole('alert')).toHaveTextContent('Each term can have at most 60 characters.')
    await typeInto(user, box, 'say "hi"')
    expect(within(row).getByRole('alert')).toHaveTextContent('A term cannot contain double quotes or start with -.')
    expect(screen.getByRole('button', { name: 'Save brands' })).toBeDisabled()
  })

  it('adds a brand with its terms from More options', async () => {
    const user = userEvent.setup()
    renderEditor()
    await rowOf('Example Air')
    await user.type(screen.getByLabelText('Brand name'), 'Acme')
    await user.click(screen.getByText('More options'))
    const form = screen.getByRole('group', { name: 'Add a brand' })
    await user.type(within(form).getByLabelText('Search terms'), 'Acme Ltd.')
    await user.type(within(form).getByLabelText('Exclude terms'), 'acme corporation{Enter}cartoon')
    await addAndSave(user)
    expect(lastPut()).toStrictEqual({ brands: [
      { ...plain('Example Air', ['example.cz']), search_terms: ['Example Air a.s.'] },
      { ...plain('Acme', []), search_terms: ['Acme Ltd.'], exclude_terms: ['acme corporation', 'cartoon'] },
    ] })
  })
})
