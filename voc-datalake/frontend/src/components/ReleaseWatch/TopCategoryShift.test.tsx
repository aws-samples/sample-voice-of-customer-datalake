/**
 * Release watch top categories: configured labels (never ids), grouped counts,
 * "New" / "Up from N" in words, and nothing extra when a side has no ranking.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { primeCategoryClient } from '@test/categoryClientMock'

const client = await vi.hoisted(async () =>
  (await import('@test/categoryClientMock')).createCategoryClientMock())
vi.mock('../../api/client', () => client.module)

import TopCategoryShift from './TopCategoryShift'
import { normalizeReleaseWatch, type ReleaseSide } from '../../api/releaseWatchSchema'

const CONFIG = {
  categories: [
    { id: 'cat_app', name: 'mobile_app', description: 'Mobile App', subcategories: [] },
    { id: 'cat_pricing', name: 'pricing', description: 'Prices & plans', subcategories: [] },
    { id: 'cat_support', name: 'customer_support', description: 'Help desk', subcategories: [] },
  ],
}

function sides(before: unknown[], after: unknown[]): { before: ReleaseSide; after: ReleaseSide } {
  const side = (top: unknown[]) => ({ days: 14, count: 40, scored: 40, avg_sentiment: 0, negative: 4, top_categories: top })
  const [release] = normalizeReleaseWatch({ releases: [{
    key: 'github:2.4.0', label: '2.4.0', kind: 'github_release', date: '2026-10-10', before: side(before), after: side(after),
  }] }).releases
  if (release === undefined) throw new Error('fixture did not normalize')
  return { before: release.before, after: release.after }
}

function renderShift(props: { before: ReleaseSide; after: ReleaseSide }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter><TopCategoryShift {...props} /></MemoryRouter>
    </QueryClientProvider>,
  )
}

const SHIFTED = sides(
  [{ name: 'mobile_app', count: 1200 }, { name: 'customer_support', count: 9 }, { name: 'pricing', count: 1 }],
  [{ name: 'mobile_app', count: 3400 }, { name: 'shipping_delays', count: 12 }, { name: 'customer_support', count: 4 }],
)

beforeEach(() => {
  primeCategoryClient(client, CONFIG)
  client.fetchApi.mockResolvedValue([])
})

describe('TopCategoryShift', () => {
  it('names each category by its configured label and links it to Categories filtered by it', async () => {
    renderShift(SHIFTED)
    const before = screen.getByRole('list', { name: 'Top categories before' })
    expect(await within(before).findByRole('link', { name: 'Mobile App' })).toHaveAttribute('href', '/categories?category=mobile_app')
    expect(within(before).getByRole('link', { name: 'Help desk' })).toBeInTheDocument()
    expect(screen.queryByText('mobile_app')).not.toBeInTheDocument()
    expect(screen.queryByText('customer_support')).not.toBeInTheDocument()
  })

  it('groups the counts in the app language', async () => {
    renderShift(SHIFTED)
    expect(await screen.findByText('1,200 reviews')).toBeInTheDocument()
    expect(screen.getByText('3,400 reviews')).toBeInTheDocument()
    expect(screen.getByText('1 review')).toBeInTheDocument()
  })

  it('marks a category new to the top list and one that grew in words, never one that shrank', async () => {
    renderShift(SHIFTED)
    const after = screen.getByRole('list', { name: 'Top categories after' })
    const rows = await within(after).findAllByRole('listitem')
    expect(rows.map((row) => row.textContent)).toStrictEqual([
      expect.stringContaining('Up from 1,200'),
      expect.stringContaining('New in the top list'),
      expect.not.stringMatching(/Up from|New in/),
    ])
    const before = screen.getByRole('list', { name: 'Top categories before' })
    expect(within(before).queryByText(/Up from|New in/)).not.toBeInTheDocument()
  })

  it('renders nothing when neither side has a ranking', () => {
    const { container } = renderShift(sides([], []))
    expect(container).toBeEmptyDOMElement()
  })

  it('lists only the side that has a ranking', () => {
    renderShift(sides([], [{ name: 'pricing', count: 3 }]))
    expect(screen.queryByRole('list', { name: 'Top categories before' })).not.toBeInTheDocument()
    expect(screen.getByRole('list', { name: 'Top categories after' })).toBeInTheDocument()
  })
})
