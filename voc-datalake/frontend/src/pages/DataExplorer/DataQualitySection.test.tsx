import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { renderWithQueryClient } from '../../test/query-client'
import { configStoreModule } from '../Categories/categories-fixtures'
import enCommon from '../../../public/locales/en/common.json'
import type { DataQuality } from '../../api/dataQualitySchema'

const api = vi.hoisted(() => ({ getDataQuality: vi.fn() }))
vi.mock('../../api/dataQualityApi', () => ({
  dataQualityKey: (range: unknown) => ['data-quality', range],
  getDataQuality: api.getDataQuality,
}))
vi.mock('../../store/configStore', () => configStoreModule())
vi.mock('./useAppSourceLabel', () => ({ useAppSourceLabel: () => (source: string) => `Label ${source}` }))
vi.mock('recharts', () => {
  const passThrough = ({ children }: { children?: ReactNode }) => <div>{children}</div>
  const nothing = () => null
  return {
    ResponsiveContainer: passThrough, BarChart: passThrough, Bar: nothing, CartesianGrid: nothing,
    Legend: nothing, Tooltip: nothing, XAxis: nothing, YAxis: nothing,
  }
})

import DataQualitySection from './DataQualitySection'

const counts = (high: number, medium: number, low: number, unrated: number) =>
  ({ high, medium, low, unrated, total: high + medium + low + unrated })

function quality(sources: DataQuality['sources'], isPartial = false): DataQuality {
  const overall = sources.reduce((acc, s) => counts(acc.high + s.high, acc.medium + s.medium, acc.low + s.low,
    acc.unrated + s.unrated), counts(0, 0, 0, 0))
  return { isPartial, sources, overall }
}

describe('DataQualitySection', () => {
  beforeEach(() => {
    api.getDataQuality.mockReset()
  })

  const twoSources = () => quality([
    { source: 'web', ...counts(3, 0, 1, 4) },
    { source: 'app', ...counts(0, 2, 0, 0) },
  ])

  it('lists every source with its bands and their shares, and an all-sources row', async () => {
    api.getDataQuality.mockResolvedValue(twoSources())
    renderWithQueryClient(<DataQualitySection />)

    const table = await screen.findByRole('table', { name: 'Feedback usefulness per source' })
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toStrictEqual(
      ['Source', 'High', 'Medium', 'Low', 'Not rated', 'Total'])
    expect(within(table).getByRole('row', { name: /Label web/ })).toHaveTextContent('3(38%)0(0%)1(13%)4(50%)8')
    expect(within(table).getByRole('row', { name: /All sources/ })).toHaveTextContent('10')
  })

  it('states the not-rated share and how to backfill it', async () => {
    api.getDataQuality.mockResolvedValue(twoSources())
    renderWithQueryClient(<DataQualitySection />)

    expect(await screen.findByText(/40% of the feedback in this range is not rated yet/)).toBeInTheDocument()
    expect(screen.getByText(/a category reprocess/)).toBeInTheDocument()
  })

  it('drops the backfill hint once everything is rated, and shows no all-sources row for one source', async () => {
    api.getDataQuality.mockResolvedValue(quality([{ source: 'web', ...counts(1, 1, 1, 0) }]))
    renderWithQueryClient(<DataQualitySection />)

    expect(await screen.findByText(/0% of the feedback in this range is not rated yet/)).toBeInTheDocument()
    expect(screen.queryByText(/a category reprocess/)).not.toBeInTheDocument()
    expect(screen.queryByRole('row', { name: /All sources/ })).not.toBeInTheDocument()
  })

  it('says when the range has no feedback', async () => {
    api.getDataQuality.mockResolvedValue(quality([]))
    renderWithQueryClient(<DataQualitySection />)
    expect(await screen.findByText('No feedback in this time range.')).toBeInTheDocument()
  })

  it('names a partial read and the chart cut-off', async () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ source: `s${i}`, ...counts(1, 0, 0, 0) }))
    api.getDataQuality.mockResolvedValue(quality(many, true))
    renderWithQueryClient(<DataQualitySection />)
    expect(await screen.findByText(/counts may be lower than the real numbers/)).toBeInTheDocument()
    expect(screen.getByText(/The chart shows the 8 busiest sources/)).toBeInTheDocument()
  })

  it('shows a retryable failure instead of an empty state', async () => {
    api.getDataQuality.mockRejectedValue(new Error('500'))
    renderWithQueryClient(<DataQualitySection />)
    expect(await screen.findByRole('alert')).toHaveTextContent(enCommon.loadFailed.message)
    expect(screen.queryByText('No feedback in this time range.')).not.toBeInTheDocument()
  })
})
