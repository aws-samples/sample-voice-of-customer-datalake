/**
 * @fileoverview GitHub Issues insight on the Dashboard: per-release, per-label, new since last release.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '../../test/query-client'
import { normalizeGithubMetrics } from '../../api/githubMetricsSchema'
import type { SourceBreakdown } from '../../api/types'
import GitHubInsights from './GitHubInsights'

const mockGetGithubMetrics = vi.fn<(...args: unknown[]) => unknown>()

vi.mock('../../api/client', () => ({
  api: { getGithubMetrics: (range: unknown, repo?: string) => mockGetGithubMetrics(range, repo) },
}))

const RESPONSE = {
  is_partial: false,
  total: 6,
  repos: ['acme/Kiro', 'acme/Other'],
  versions: [
    { version: '0.4.1', count: 2, weight: 4, avg_sentiment: 0, negative: 1, issues: 2, comments: 0,
      top_complaints: [{ name: 'bug', count: 1 }], top_errors: [] },
    { version: '0.10.0', count: 1, weight: 1, avg_sentiment: -0.5, negative: 1, issues: 1, comments: 0,
      top_complaints: [{ name: 'performance', count: 1 }], top_errors: [{ name: 'panic: boom', count: 1 }] },
  ],
  unversioned: { count: 1, weight: 1, avg_sentiment: null, negative: 0 },
  labels: [{ label: 'regression', count: 1, weight: 1, avg_sentiment: -0.5, negative: 1, open: 1 }],
  latest_version: '0.10.0',
  previous_version: '0.4.1',
  new_in_latest: { errors: [{ name: 'panic: boom', count: 1 }], categories: [], components: [] },
}

function renderInsights(withGithub = true) {
  const sources: SourceBreakdown = {
    period_days: 7,
    sources: withGithub ? { github_issues: 6, webscraper: 3 } : { webscraper: 3 },
  }
  return renderWithQueryClient(<GitHubInsights dateParams={{ days: 7 }} sources={sources} />)
}

describe('GitHubInsights', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetGithubMetrics.mockResolvedValue(normalizeGithubMetrics(RESPONSE))
  })

  it('charts releases in order against every earlier release', async () => {
    renderInsights()

    expect(await screen.findByRole('heading', { name: 'GitHub Issues' })).toBeInTheDocument()
    expect(screen.getByTestId('github-release-chart')).toBeInTheDocument()
    expect(screen.getByText(/Release 0\.10\.0 compared with every earlier release/)).toBeInTheDocument()
  })

  it('lists what is new in the latest release, and counts the period', async () => {
    renderInsights()

    const newErrors = (await screen.findByRole('heading', { name: 'New error signatures' })).parentElement
    expect(newErrors).not.toBeNull()
    expect(within(newErrors ?? document.body).getByText('panic: boom')).toBeInTheDocument()
    expect(screen.getByText('performance')).toBeInTheDocument()
    expect(screen.getByText(/6 issues and comments in this period \(1 without a version\)/)).toBeInTheDocument()
  })

  it('tabulates labels with reach and sentiment', async () => {
    renderInsights()

    const row = (await screen.findByRole('rowheader', { name: 'regression' })).closest('tr')
    expect(row).not.toBeNull()
    expect(within(row ?? document.body).getByText('-0.50')).toBeInTheDocument()
  })

  it('narrows to one repository', async () => {
    const user = userEvent.setup()
    renderInsights()

    await user.selectOptions(await screen.findByRole('combobox', { name: 'Repository' }), 'acme/Other')

    await waitFor(() => expect(mockGetGithubMetrics).toHaveBeenLastCalledWith({ days: 7 }, 'acme/Other'))
  })

  it('renders nothing and fetches nothing when the window has no GitHub feedback', () => {
    const { container } = renderInsights(false)
    expect(container).toBeEmptyDOMElement()
    expect(mockGetGithubMetrics).not.toHaveBeenCalled()
  })

  it('renders nothing for an empty breakdown', async () => {
    mockGetGithubMetrics.mockResolvedValue(normalizeGithubMetrics({ total: 0 }))
    const { container } = renderInsights()
    await waitFor(() => expect(mockGetGithubMetrics).toHaveBeenCalledWith({ days: 7 }, undefined))
    expect(container).toBeEmptyDOMElement()
  })

  it('says when there is a single release to compare', async () => {
    mockGetGithubMetrics.mockResolvedValue(normalizeGithubMetrics({
      ...RESPONSE, versions: [RESPONSE.versions[0]], latest_version: '0.4.1', previous_version: null,
    }))
    renderInsights()
    expect(await screen.findByText(/Only release 0\.4\.1 in this period/)).toBeInTheDocument()
  })
})

describe('normalizeGithubMetrics', () => {
  it('turns an unreadable body into an empty breakdown', () => {
    for (const raw of [null, 'oops', 42, { versions: 'x', labels: [null], new_in_latest: 3 }]) {
      const metrics = normalizeGithubMetrics(raw)
      expect(metrics.versions).toStrictEqual([])
      expect(metrics.labels).toStrictEqual([])
      expect(metrics.newInLatest).toStrictEqual({ errors: [], categories: [], components: [] })
      expect(metrics.partial.isPartial).toBe(false)
    }
  })

  it('fills sparse rows with neutral values and drops nameless ones', () => {
    const metrics = normalizeGithubMetrics({
      versions: [{ version: '1.0.0' }, { count: 3 }, null],
      labels: [{ label: 'bug', count: 'many' }],
      is_partial: true,
      partial_reason: 'time_budget',
      scanned_through: '2026-01-01',
    })
    expect(metrics.versions).toHaveLength(1)
    expect(metrics.versions[0]).toMatchObject({ version: '1.0.0', count: 0, avg_sentiment: null, top_errors: [] })
    expect(metrics.labels[0]).toMatchObject({ label: 'bug', count: 0 })
    expect(metrics.partial).toStrictEqual({ isPartial: true, scannedThrough: '2026-01-01' })
  })
})
