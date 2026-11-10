/**
 * RadarBrandsEditor spec fixtures, shared by the editor's specs (the list itself, and its
 * language and news-feed fields): the routed brand list, what the server answers to a save, the
 * last PUT body, the editor rendered and one brand's row. Each spec still declares its own
 * `vi.mock` of the API client (hoisted per file).
 */
import { screen } from '@testing-library/react'
import type userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { renderWithQueryClient } from '@test/query-client'
import { fetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import RadarBrandsEditor from './RadarBrandsEditor'
import { parsedJson } from '@test/jsonText'

/** What the server would answer: every saved brand now on the list. */
function savedFrom(body: unknown): unknown[] {
  const brands = typeof body === 'object' && body !== null && 'brands' in body && Array.isArray(body.brands) ? body.brands : []
  return brands.map((brand: unknown) => {
    const label = typeof brand === 'object' && brand !== null && 'label' in brand ? String(brand.label) : ''
    return { ...(typeof brand === 'object' ? brand : {}), key: label.toLowerCase(), origin: 'list', sources: [] }
  })
}

export function route(brands: unknown[], put: (body: unknown) => unknown = (body) => ({ success: true, brands: savedFrom(body) })): void {
  routeFetchApi({
    'GET /radar/brands': () => ({ brands }),
    'PUT /radar/brands': put,
    'GET /settings/sources': () => ({ sources: [{ id: 'rival_reviews', label: 'Rival reviews' }] }),
  })
}

export const lastPut = (): unknown =>
  parsedJson(fetchApi.mock.calls.filter(([path, options]) => path === '/radar/brands' && options?.method === 'PUT').at(-1)?.[1]?.body)

export const renderEditor = () =>
  renderWithQueryClient(<MemoryRouter><RadarBrandsEditor totals={new Map([['globex', 12]])} /></MemoryRouter>)

export const rowOf = async (label: string): Promise<HTMLElement> => {
  const row = (await screen.findByText(label)).closest('li')
  if (!(row instanceof HTMLElement)) throw new Error(`no row for ${label}`)
  return row
}

/** A saved brand with no language, feed or term set: what every PUT carries for it. */
export const plain = (label: string, domains: string[]) =>
  ({ label, domains, language: null, feed_urls: [], search_terms: [], exclude_terms: [] })

/** Add the brand typed in "Add a brand", then Save brands, and wait for the save to land. */
export async function addAndSave(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('button', { name: 'Add brand' }))
  await user.click(screen.getByRole('button', { name: 'Save brands' }))
  await screen.findByText('Brands saved.')
}
