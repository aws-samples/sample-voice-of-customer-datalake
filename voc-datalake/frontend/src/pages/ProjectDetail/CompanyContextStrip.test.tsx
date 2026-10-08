/**
 * The read-only company-context strip on a project's Product tab
 * (todofeatures §6.1).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import { renderWithQueryClient } from '@test/query-client'
import { TestRouter } from '@test/TestRouter'

const fetchApi = vi.fn<(endpoint: string, options?: RequestInit) => Promise<unknown>>()
vi.mock('../../api/client', () => ({ fetchApi: (endpoint: string, options?: RequestInit) => fetchApi(endpoint, options) }))

const { default: CompanyContextStrip } = await import('./CompanyContextStrip')

const objective = (n: number) => ({ id: `o${n}`, title: `Objective ${n}`, description: '', horizon: 'long' })

function answer(company: unknown, design: unknown) {
  fetchApi.mockImplementation((endpoint) => {
    if (endpoint === '/settings/company-context') return Promise.resolve(company)
    if (endpoint === '/settings/design-system') return Promise.resolve(design)
    return Promise.reject(new Error('API Error: 404'))
  })
}

beforeEach(() => { fetchApi.mockReset() })

describe('CompanyContextStrip', () => {
  it('summarises the vision, the first objectives and the paintable colours, linking to Knowledge → Company', async () => {
    answer(
      { vision: '# Vision\n\n**Be the most trusted** brand', objectives: [1, 2, 3, 4, 5].map(objective) },
      { tokens: { colors: [{ name: 'primary', value: '#8e48ff' }, { name: 'bad', value: 'nope!' }], typography: [] }, guidelines: '', references: [], integrations: { figma: false, github: false } },
    )
    renderWithQueryClient(<TestRouter><CompanyContextStrip /></TestRouter>)
    expect(await screen.findByText('Be the most trusted brand')).toBeInTheDocument()
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toStrictEqual(['Objective 1', 'Objective 2', 'Objective 3', '+2 more'])
    expect(await screen.findByTitle('primary #8e48ff')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Knowledge → Company/ })).toHaveAttribute('href', '/company')
  })

  it('stays quiet when nothing is set or the reads fail', async () => {
    fetchApi.mockRejectedValue(new Error('API Error: 500'))
    renderWithQueryClient(<TestRouter><CompanyContextStrip /></TestRouter>)
    expect(await screen.findByText('No company vision yet.')).toBeInTheDocument()
    expect(screen.queryByRole('list')).not.toBeInTheDocument()
  })
})
