/**
 * The Radar brand editor's news fields: each brand's search language (Auto names the language
 * the server derived from its domain) and its news feeds (at most 3 https links). Both go into
 * the Save brands PUT, from a brand's row and from "Add a brand" (under More options); a fourth
 * or a non-https feed holds the save back, and the server's 400 reason is shown.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
import { resetFetchApi } from '@test/fetchApiRoutes'
import { ApiError } from '../../lib/errors'
import { addAndSave, lastPut, plain, renderEditor, route, rowOf } from './radar-brands-editor-fixtures'

const POLISH_AIR = {
  key: 'example-air', label: 'Example Air', domains: ['example.pl'], origin: 'list', sources: [],
  language: null, effective_language: 'pl', feed_urls: ['https://example.pl/news/feed.xml'],
}
const FEEDS = ['https://example.pl/a.xml', 'https://example.pl/b.xml', 'https://example.pl/c.xml']

type User = ReturnType<typeof userEvent.setup>

/** The editor with `label`'s row open for editing. */
const openRow = async (user: User, label: string) => {
  renderEditor()
  const row = await rowOf(label)
  await user.click(within(row).getByRole('button', { name: `Edit ${label}` }))
  return row
}

/** Example Air's row open, with `feeds` typed into its feed box. */
const typeFeeds = async (user: User, feeds: string) => {
  const row = await openRow(user, 'Example Air')
  const box = within(row).getByLabelText('News feeds')
  await user.clear(box)
  await user.type(box, feeds)
  return row
}

/** "Add a brand" with a name typed and More options unfolded. */
const openAddForm = async (user: User, name: string) => {
  renderEditor()
  await rowOf('Example Air')
  await user.type(screen.getByLabelText('Brand name'), name)
  await user.click(screen.getByText('More options'))
  return screen.getByRole('group', { name: 'Add a brand' })
}

beforeEach(() => {
  resetFetchApi()
  route([POLISH_AIR])
})

describe('RadarBrandsEditor, a brand\'s language and news feeds', () => {
  it('summarises Auto with the language derived from the domain, and the feeds', async () => {
    renderEditor()
    const row = await rowOf('Example Air')
    expect(within(row).getByText('Language: Auto (from the domain: Polish)')).toBeInTheDocument()
    expect(within(row).getByText('News feeds: https://example.pl/news/feed.xml')).toBeInTheDocument()
  })

  it('offers Auto naming the derived language, then the 16 languages', async () => {
    const user = userEvent.setup()
    const row = await openRow(user, 'Example Air')
    const select = within(row).getByLabelText('Search language')
    const options = [...select.querySelectorAll('option')].map((option) => option.textContent)
    expect(options[0]).toBe('Auto (from the domain: Polish)')
    expect(options).toHaveLength(17)
    expect(options).toContain('Czech')
    expect(select).toHaveValue('')
  })

  it('saves a chosen language and edited feeds in the PUT', async () => {
    const user = userEvent.setup()
    const row = await openRow(user, 'Example Air')
    await user.selectOptions(within(row).getByLabelText('Search language'), 'cs')
    const feeds = within(row).getByLabelText('News feeds')
    await user.clear(feeds)
    await user.type(feeds, `${FEEDS[0]}, ${FEEDS[1]}{Enter}${FEEDS[0]}`)
    await user.click(screen.getByRole('button', { name: 'Save brands' }))
    await screen.findByText('Brands saved.')
    expect(lastPut()).toStrictEqual({ brands: [{ ...plain('Example Air', ['example.pl']), language: 'cs', feed_urls: FEEDS.slice(0, 2) }] })
  })

  it('holds the save back on a fourth feed', async () => {
    const row = await typeFeeds(userEvent.setup(), [...FEEDS, 'https://example.pl/d.xml'].join(', '))
    expect(within(row).getByRole('alert')).toHaveTextContent('At most 3 news feeds.')
    expect(screen.getByRole('button', { name: 'Save brands' })).toBeDisabled()
    expect(screen.getByText('Fix the news feeds before saving.')).toBeInTheDocument()
  })

  it('holds the save back on a feed that is not https', async () => {
    const row = await typeFeeds(userEvent.setup(), 'http://example.com/feed')
    expect(within(row).getByRole('alert')).toHaveTextContent('Each news feed must be an https:// link.')
    expect(screen.getByRole('button', { name: 'Save brands' })).toBeDisabled()
  })

  it('shows the server\'s 400 reason', async () => {
    route([POLISH_AIR], () => { throw new ApiError(400, 'brands[0]: a news feed must be an https link: https://bad') })
    const user = userEvent.setup()
    const row = await openRow(user, 'Example Air')
    await user.selectOptions(within(row).getByLabelText('Search language'), 'de')
    await user.click(screen.getByRole('button', { name: 'Save brands' }))
    expect(await screen.findByText(/The brands could not be saved\. brands\[0\]: a news feed must be an https link/)).toBeInTheDocument()
  })
})

describe('RadarBrandsEditor, adding a brand with More options', () => {
  it('adds a brand with its language and feeds', async () => {
    const user = userEvent.setup()
    const form = await openAddForm(user, 'Acme')
    expect(within(form).getByLabelText('Search language')).toHaveDisplayValue('Auto (from the domain)')
    await user.selectOptions(within(form).getByLabelText('Search language'), 'fr')
    await user.type(within(form).getByLabelText('News feeds'), FEEDS[2] ?? '')
    await addAndSave(user)
    expect(lastPut()).toStrictEqual({ brands: [
      { ...plain('Example Air', ['example.pl']), feed_urls: ['https://example.pl/news/feed.xml'] },
      { ...plain('Acme', []), language: 'fr', feed_urls: [FEEDS[2]] },
    ] })
  })

  it('cannot add a brand with more than 3 feeds', async () => {
    const user = userEvent.setup()
    const form = await openAddForm(user, 'Acme')
    await user.type(within(form).getByLabelText('News feeds'), [...FEEDS, 'https://example.pl/d.xml'].join('{Enter}'))
    expect(within(form).getByRole('alert')).toHaveTextContent('At most 3 news feeds.')
    expect(screen.getByRole('button', { name: 'Add brand' })).toBeDisabled()
  })
})
